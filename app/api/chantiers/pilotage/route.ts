import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest } from '@/lib/api';
import { getJobsDashboard } from '@/lib/jobs-dashboard';
import { canViewSalesProfit } from '@/lib/sales';

/**
 * GET /api/chantiers/pilotage — tableau de bord des chantiers (cahier §17,
 * §18). `?store=all` donne la vue consolidée de l'administrateur (bornée au
 * périmètre). Filtres : `from`, `to`, `category`, `status`.
 *
 * Coûts et marges : `null` sans `balances.view` (invariant n° 13).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('jobs.view');
    const params = request.nextUrl.searchParams;
    const withCosts = await canViewSalesProfit(user);
    const dashboard = await getJobsDashboard({
      scope: scopeFromRequest(user, request),
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      category: params.get('category') ?? undefined,
      status: params.get('status') ?? undefined,
      withCosts,
    });
    if (!withCosts) {
      Object.assign(dashboard.summary, {
        materialsCost: null,
        laborCost: null,
        subcontractCost: null,
        expensesCost: null,
        totalCost: null,
        margin: null,
        marginPercent: null,
      });
    }
    return ok({ ...dashboard, withCosts });
  } catch (error) {
    return fail(error);
  }
}
