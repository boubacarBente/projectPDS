import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, requireAction } from '@/lib/api';
import { listStockMovements, type StockMovementType } from '@/lib/stock';

/** Les trois seuls types de mouvement du journal (§12) — jamais de `loss`. */
const MOVEMENT_TYPES: StockMovementType[] = ['entry', 'exit', 'adjustment'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Ne transmet une borne de période que si elle est une date métier valide. */
function bound(value: string | null): string | undefined {
  const text = value?.trim();
  if (!text || !DATE_PATTERN.test(text)) return undefined;
  return text;
}

/**
 * GET /api/stocks/mouvements — historique paginé du journal de stock (§12).
 *
 * Paramètres : `?productId=&type=&from=&to=&page=&limit=`
 * Réponse : `{ data, total, page, limit, totalPages }` (§27.2).
 *
 * `from` / `to` sont des **dates métier** `YYYY-MM-DD` ; `listStockMovements`
 * les traduit en bornes inclusives sur l'horodatage du mouvement (§6.5 règle 2).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('stock.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const productId = Number(params.get('productId'));
    const rawType = params.get('type')?.trim() ?? '';
    const type = MOVEMENT_TYPES.includes(rawType as StockMovementType)
      ? (rawType as StockMovementType)
      : undefined;

    const result = await listStockMovements({
      productId: Number.isInteger(productId) && productId > 0 ? productId : undefined,
      type,
      from: bound(params.get('from')),
      to: bound(params.get('to')),
      page,
      limit,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
