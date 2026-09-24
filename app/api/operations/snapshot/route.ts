import { NextRequest } from 'next/server';
import { fail, ok, requireAction } from '@/lib/api';
import { getDashboardSnapshot, resolvePeriod, type PeriodKey } from '@/lib/dashboard';

const PERIODS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];

/**
 * GET /api/operations/snapshot?period=day|week|month|year|total
 *
 * Alimente le tableau de bord (§7.1). Toutes les valeurs sont calculées, aucune
 * n'est stockée (§15).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('dashboard.view');

    const requested = (request.nextUrl.searchParams.get('period') ?? 'month') as PeriodKey;
    const periodKey: PeriodKey = PERIODS.includes(requested) ? requested : 'month';

    // Bornes explicites possibles (`?from=&to=`), sinon période nommée.
    const from = request.nextUrl.searchParams.get('from');
    const to = request.nextUrl.searchParams.get('to');

    const snapshot = await getDashboardSnapshot(periodKey);

    if (from && to) {
      snapshot.period = { ...snapshot.period, from, to, label: 'Période choisie' };
    }

    return ok(snapshot);
  } catch (error) {
    return fail(error);
  }
}
