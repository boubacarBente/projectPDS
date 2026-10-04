import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, requireActiveStore, toBool } from '@/lib/api';
import { setProductListed } from '@/lib/stock';
import { getProduct } from '@/lib/products';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/produits/[id]/assortiment — `{ listed: boolean }`.
 *
 * Ajoute un produit du catalogue commun à l'**assortiment du magasin actif**,
 * ou l'en retire (README §28.5). Retirer est refusé tant que le magasin en a
 * en stock ou en attend par transfert (409, message produit). Le magasin vient
 * toujours de la session, jamais du navigateur.
 * Permission : `products.update`.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('products.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const productId = parseId(id);
    const body = await readJson<any>(request);
    const listed = toBool(body.listed, true);

    await setProductListed(storeId, productId, listed);

    await writeAudit({
      user,
      action: 'update',
      entity: 'product',
      entityId: productId,
      details: { assortment: listed ? 'added' : 'removed' },
    });

    return ok(await getProduct(productId, [storeId]));
  } catch (error) {
    return fail(error);
  }
}
