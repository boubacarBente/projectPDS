import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest, toInt } from '@/lib/api';
import { listAccessibleBranches } from '@/lib/branches';
import { getSalesStats } from '@/lib/sales';
import type { PeriodKey } from '@/lib/dashboard';

const PERIODS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];

/**
 * GET /api/ventes/stats?period=day|week|month|year|total&store=all|<id>
 *
 * Statistiques **calculées à la lecture** (§15) : aucun total n'est stocké.
 * `revenue` est le montant facturé TTC de la période, `totalHt` le chiffre
 * d'affaires hors taxes des ventes ; le CA global (§15) y ajoute les
 * prestations (`service_jobs`), qui ne sont jamais comptées ici pour éviter un
 * double comptage.

 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('sales.view');

    const params = request.nextUrl.searchParams;
    const raw = params.get('period') ?? 'month';
    const period: PeriodKey = (PERIODS as string[]).includes(raw) ? (raw as PeriodKey) : 'month';

    const channel = params.get('channel');
    return ok(
      await getSalesStats(period, {
        scope: scopeFromRequest(user, request),
        channel: channel === 'brick' || channel === 'all' ? channel : 'general',
        productionBranchId: toInt(params.get('branch'), 0) || undefined,
        productionBranchIds: (await listAccessibleBranches(user, { includeInactive: true })).map((b) => b.id),
      }),
    );
  } catch (error) {
    return fail(error);
  }
}
