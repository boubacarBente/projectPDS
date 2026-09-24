import { NextRequest } from 'next/server';
import { fail, ok, requireAction } from '@/lib/api';
import { getSalesStats } from '@/lib/sales';
import type { PeriodKey } from '@/lib/dashboard';

const PERIODS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];

/**
 * GET /api/ventes/stats?period=day|week|month|year|total
 *
 * Statistiques **calculées à la lecture** (§15) : aucun total n'est stocké.
 * `revenue` est le montant facturé TTC de la période, `totalHt` le chiffre
 * d'affaires hors taxes des ventes ; le CA global (§15) y ajoute les
 * prestations (`service_jobs`), qui ne sont jamais comptées ici pour éviter un
 * double comptage.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('sales.view');

    const raw = request.nextUrl.searchParams.get('period') ?? 'month';
    const period: PeriodKey = (PERIODS as string[]).includes(raw) ? (raw as PeriodKey) : 'month';

    return ok(await getSalesStats(period));
  } catch (error) {
    return fail(error);
  }
}
