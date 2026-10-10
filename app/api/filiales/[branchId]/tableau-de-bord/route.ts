import { NextRequest } from 'next/server';
import { fail, ok, scopeFromRequest } from '@/lib/api';
import { getBrickDashboard } from '@/lib/brick-analytics';
import { requireBranch } from '@/lib/branches';
import { canViewSalesProfit } from '@/lib/sales';
import { today } from '@/lib/format';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/tableau-de-bord — tous les indicateurs de la
 * filiale en un aller-retour, sur la portée de magasins. `?date=AAAA-MM-JJ` :
 * bornes relatives à ce jour. Coûts et rentabilité masqués sans
 * `balances.view` (invariant 13).
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    const reference = request.nextUrl.searchParams.get('date');
    const dashboard = await getBrickDashboard(
      scopeFromRequest(user, request),
      [branch.id],
      reference && /^\d{4}-\d{2}-\d{2}$/.test(reference) ? reference : today(),
    );
    if (await canViewSalesProfit(user)) return ok(dashboard);
    return ok({
      ...dashboard,
      production: { ...dashboard.production, monthCost: null, monthUnitCost: null },
      profitability: null,
      // Une production « déficitaire » révèle son coût : masquée elle aussi.
      deficitProductions: [],
      productionByType: dashboard.productionByType.map((row) => ({ ...row, cost: null, unitCost: null })),
      charts: { ...dashboard.charts, production: dashboard.charts.production.map((row) => ({ ...row, cost: null })) },
      stock: { ...dashboard.stock, lines: dashboard.stock.lines.map((line) => ({ ...line, averageUnitCost: null, potentialMargin: null })) },
    });
  } catch (error) {
    return fail(error);
  }
}
