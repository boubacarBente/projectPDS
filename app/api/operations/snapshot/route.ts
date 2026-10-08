import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest } from '@/lib/api';
import { getDashboardSnapshot, resolvePeriod, type PeriodKey } from '@/lib/dashboard';
import { canViewSalesProfit } from '@/lib/sales';

const PERIODS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];

/**
 * GET /api/operations/snapshot?period=day|week|month|year|total&store=all|<id>
 *
 * Alimente le tableau de bord (§7.1). Toutes les valeurs sont calculées, aucune
 * n'est stockée (§15).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('dashboard.view');
    // `?store=all` : vue consolidée des magasins accessibles ; sinon magasin actif.
    const scope = scopeFromRequest(user, request);

    const requested = (request.nextUrl.searchParams.get('period') ?? 'month') as PeriodKey;
    const periodKey: PeriodKey = PERIODS.includes(requested) ? requested : 'month';

    // Bornes explicites possibles (`?from=&to=`), sinon période nommée.
    const from = request.nextUrl.searchParams.get('from');
    const to = request.nextUrl.searchParams.get('to');

    const snapshot = await getDashboardSnapshot(periodKey, scope, {
      includeCentralActivity: user.allStores && scope.length > 1,
      // Bénéfice mensuel : seulement pour un compte qui a le droit de voir les bénéfices.
      includeMonthlyProfit: await canViewSalesProfit(user),
    });

    if (from && to) {
      snapshot.period = { ...snapshot.period, from, to, label: 'Période choisie' };
    }

    return ok(snapshot);
  } catch (error) {
    return fail(error);
  }
}
