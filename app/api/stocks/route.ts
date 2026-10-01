import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, requireAction, scopeFromRequest, toBool } from '@/lib/api';
import { listStockProducts } from '@/lib/stock';
import { parseListSort } from '@/lib/list-sort';

/**
 * GET /api/stocks — liste paginée des produits avec leur état de stock (§12).
 *
 * Le Route Handler reste **mince** (§3) : permission → parsing → `lib/stock.ts`
 * → réponse. Aucune requête Drizzle ici, et surtout **aucune écriture** dans
 * `products.stock` : l'invariant « stock = somme algébrique des mouvements »
 * n'est mis à jour que par `lib/stock.ts` (§6.5 règle 3).
 *
 * Paramètres : `?store=all|<id>&detail=&search=&lowStockOnly=&outOfStockOnly=&categoryId=&page=&limit=&sort=`
 * (`sort=recent` par défaut : dernier produit enregistré en premier).
 * Réponse : `{ data, total, page, limit, totalPages }` (§27.2).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('stock.view');
    const scope = scopeFromRequest(user, request);

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    const categoryId = Number(params.get('categoryId'));
    const search = params.get('search')?.trim();

    const result = await listStockProducts({
      scope,
      // En vue consolidée, chaque ligne détaille le stock de chaque magasin.
      withStoreDetail: scope.length > 1 || toBool(params.get('detail'), false),
      search: search || undefined,
      lowStockOnly: toBool(params.get('lowStockOnly'), false),
      outOfStockOnly: toBool(params.get('outOfStockOnly'), false),
      categoryId: Number.isInteger(categoryId) && categoryId > 0 ? categoryId : undefined,
      page,
      limit,
      sort: parseListSort(params.get('sort'), ['recent', 'name']),
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
