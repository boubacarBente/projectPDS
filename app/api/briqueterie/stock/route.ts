import { fail, ok, requireAction } from '@/lib/api';
import { listBrickStock } from '@/lib/brick-analytics';

/**
 * GET /api/briqueterie/stock — stock des produits finis de la briqueterie.
 *
 * Le stock est celui du **produit lié** à chaque type de brique
 * (`brick_types.product_id`) : il est calculé depuis `stock_movements`, jamais
 * stocké ailleurs (§12). Les alertes (`isLow`, `isOut`) comparent `stock` au
 * `stock_min` du produit.
 *
 * Aucune écriture ici : une entrée vient d'un lot mis en stock, une sortie d'une
 * vente ou d'une perte, un ajustement passe par `POST /api/stocks/adjust`
 * (motif obligatoire) — c'est le même moteur que le reste de l'application.
 */
export async function GET() {
  try {
    await requireAction('brick.view');

    const lines = await listBrickStock();

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
