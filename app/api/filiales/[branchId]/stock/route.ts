import { NextRequest } from 'next/server';
import { fail, ok, scopeFromRequest } from '@/lib/api';
import { listBrickStock } from '@/lib/brick-analytics';
import { requireBranch } from '@/lib/branches';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/stock — stock des produits fabriqués par la
 * filiale : celui du **produit lié** à chaque modèle dans le magasin du modèle
 * (`product_stocks`), jamais ailleurs. Un ajustement passe par
 * `POST /api/stocks/adjust` (motif obligatoire, `stock.adjust`).
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    const lines = await listBrickStock(scopeFromRequest(user, request), [branch.id]);
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
