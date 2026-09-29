import { NextRequest } from 'next/server';
import { fail, ok, requireAction } from '@/lib/api';
import { getSalesStats, isSalesChannel } from '@/lib/sales';
import type { PeriodKey } from '@/lib/dashboard';

const PERIODS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];

/**
 * GET /api/ventes/stats?period=day|week|month|year|total&channel=general|brick|all
 *
 * Statistiques **calculées à la lecture** (§15) : aucun total n'est stocké.
 * `revenue` est le montant facturé TTC de la période, `totalHt` le chiffre
 * d'affaires hors taxes des ventes ; le CA global (§15) y ajoute les
 * prestations (`service_jobs`), qui ne sont jamais comptées ici pour éviter un
 * double comptage.
 *
 * **Canal** (§20) : par défaut le commerce général — les cartes de `/ventes`
 * comptent ainsi exactement ce que montre sa liste. La briqueterie demande
 * `channel=brick`.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('sales.view');

    const params = request.nextUrl.searchParams;
    const raw = params.get('period') ?? 'month';
    const period: PeriodKey = (PERIODS as string[]).includes(raw) ? (raw as PeriodKey) : 'month';

    const channelParam = params.get('channel');
    const channel =
      channelParam === 'all' ? 'all' : isSalesChannel(channelParam) ? channelParam : 'general';

    return ok(await getSalesStats(period, { channel }));
  } catch (error) {
    return fail(error);
  }
}
