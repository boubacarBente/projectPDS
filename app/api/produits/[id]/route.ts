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
} from '@/lib/api';
import { deactivateProduct, getProduct, reactivateProduct, updateProduct } from '@/lib/products';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/produits/[id] — fiche produit enrichie (catégorie, valeur de stock). */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('products.view');
    const { id } = await params;

    const product = await getProduct(parseId(id));
    if (!product) throw new NotFoundError('Produit introuvable');

    return ok(product);
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
    if (body.description !== undefined) patch.description = body.description;
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);

    const product = await updateProduct(productId, patch as any, { userId: user.id });

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
