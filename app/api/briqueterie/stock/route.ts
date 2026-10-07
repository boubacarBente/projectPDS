import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest } from '@/lib/api';
import { listBrickStock } from '@/lib/brick-analytics';

/**
 * GET /api/briqueterie/stock — stock des briques finies de la portée : celui du
 * **produit lié** dans le magasin du type (`product_stocks`), jamais ailleurs.
 * Un ajustement passe par `POST /api/stocks/adjust` (motif obligatoire).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('brick.view');
    const lines = await listBrickStock(scopeFromRequest(user, request));
    return ok({
      data: lines,
      total: lines.length,
      summary: {
        totalQuantity: Math.round(lines.reduce((sum, line) => sum + line.stock, 0) * 1000) / 1000,
        totalPurchaseValue: lines.reduce((sum, line) => sum + line.stockValue, 0),
        totalSaleValue: lines.reduce((sum, line) => sum + line.saleValue, 0),
        lowCount: lines.filter((line) => line.isLow).length,
        outCount: lines.filter((line) => line.isOut).length,
      },
    });
  } catch (error) {
    return fail(error);
  }
}
