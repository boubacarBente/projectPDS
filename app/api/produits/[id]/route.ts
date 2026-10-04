import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  toBool,
  toNumber,
  NotFoundError,
  scopeFromRequest,
  ValidationError,
} from '@/lib/api';
import { canEditCentralData } from '@/lib/device';
import { getSettings } from '@/lib/settings';
import { assertStoreWritable } from '@/lib/stores';
import { CatalogEditError, canEditProductCatalog, deactivateProduct, getProduct, reactivateProduct, updateProduct } from '@/lib/products';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/produits/[id] — fiche produit enrichie (catégorie, valeur de stock). */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('products.view');
    const { id } = await params;

    const productId = parseId(id);
    const product = await getProduct(productId, scopeFromRequest(user, request));
    if (!product) throw new NotFoundError('Produit introuvable');

    const canEditCatalog = await canEditProductCatalog(productId, {
      central: await canEditCentralData(),
      storeId: user.storeId,
    });
    return ok({ ...product, canEditCatalog });
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/produits/[id] — modification.
 * `stock` n'est jamais écrit en dur : si la valeur change, `lib/products.ts`
 * enregistre un **écart signé** via `adjustStock()` (invariant du stock).
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('products.update');
    const { id } = await params;
    const productId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.categoryId !== undefined) {
      const categoryId = toNumber(body.categoryId, 0);
      patch.categoryId = categoryId > 0 ? categoryId : null;
    }
    if (body.unit !== undefined) patch.unit = body.unit;
    if (body.purchasePrice !== undefined) patch.purchasePrice = toNumber(body.purchasePrice, 0);
    if (body.salePrice !== undefined) patch.salePrice = toNumber(body.salePrice, 0);
    if (body.stock !== undefined) patch.stock = toNumber(body.stock, 0);
    if (body.stockMin !== undefined) patch.stockMin = toNumber(body.stockMin, 0);
    if (body.barcode !== undefined) patch.barcode = body.barcode;
    if (body.description !== undefined) patch.description = body.description;
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);

    // Réglages propres au magasin actif : prix local (si autorisé) et seuil local.
    if (body.localSalePrice !== undefined) {
      const settings = await getSettings();
      if (!settings.localPricesAllowed) {
        throw new ValidationError('Les prix locaux sont désactivés dans les paramètres.');
      }
      patch.localSalePrice = body.localSalePrice === null || body.localSalePrice === '' ? null : toNumber(body.localSalePrice, 0);
    }
    if (body.localStockMin !== undefined) {
      patch.localStockMin = body.localStockMin === null || body.localStockMin === '' ? null : toNumber(body.localStockMin, 0);
    }
    if (patch.stock !== undefined || patch.localSalePrice !== undefined || patch.localStockMin !== undefined) {
      if (!user.storeId) throw new ValidationError('Aucun magasin actif.');
      await assertStoreWritable(user.storeId);
    }

    const product = await updateProduct(productId, patch as any, {
      userId: user.id,
      storeId: user.storeId,
      // Fiche commune : siège, ou magasin créateur seul à proposer le produit.
      canEditCatalog: await canEditProductCatalog(productId, {
        central: await canEditCentralData(),
        storeId: user.storeId,
      }),
    });

    await writeAudit({
      user,
      action: 'update',
      entity: 'product',
      entityId: productId,
      details: patch,
    });

    return ok(product);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/produits/[id] — **désactivation**, jamais de suppression physique
 * (§26.13) : un `DELETE` ferait ressusciter la ligne au prochain pull de
 * synchronisation, et une facture ancienne doit rester lisible.
 * `?reactivate=true` remet le produit dans le catalogue.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('products.delete');
    const { id } = await params;
    const productId = parseId(id);
    // Désactiver retire le produit de **tout** le réseau : même règle que la
    // modification de la fiche. Pour ne plus le vendre dans un seul magasin,
    // on le retire de l'assortiment (`/api/produits/[id]/assortiment`).
    const allowed = await canEditProductCatalog(productId, {
      central: await canEditCentralData(),
      storeId: user.storeId,
    });
    if (!allowed) {
      throw new CatalogEditError(
        'Ce produit est aussi proposé par d’autres magasins : retirez-le de votre magasin au lieu de le désactiver, ou demandez au siège.',
      );
    }

    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';

    if (reactivate) {
      await reactivateProduct(productId);
    } else {
      await deactivateProduct(productId);
    }

    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'product',
      entityId: productId,
      details: { reactivated: reactivate },
    });

    return ok({ success: true, deactivated: !reactivate });
  } catch (error) {
    return fail(error);
  }
}
