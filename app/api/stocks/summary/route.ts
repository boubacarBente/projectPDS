import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest } from '@/lib/api';
import { getStockSummary } from '@/lib/stock';

/**
 * GET /api/stocks/summary — synthèse du stock (§12).
 *
 * Réponse : `{ totalProducts, totalStock, totalStockValue, totalSaleValue,
 * lowStockCount, outOfStockCount }`.
 *
 * Tout est **calculé à la lecture** depuis `products` (§6.5 règle 6) : aucun
 * total n'est stocké, donc aucune dérive possible.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('stock.view');
    return ok(await getStockSummary(scopeFromRequest(user, request)));
  } catch (error) {
    return fail(error);
  }
}
