import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, requireAction } from '@/lib/api';
import { listReportDeliveries } from '@/lib/report-sender';

/**
 * GET /api/rapports/envois (README §16.2, §27.2).
 *
 * Historique **paginé** des rapports envoyés (table `report_deliveries`), avec
 * le nom de l'utilisateur déclencheur.
 * Filtres : `period`, `channel`, `status`, `from`, `to`, `page`, `limit`.
 * Permission **`reports.view`**.
 *
 * ── Pas de POST ici ───────────────────────────────────────────────────────
 * Le §27.2 ne prévoit que `GET` pour cette route, et un envoi de test est déjà
 * couvert par `POST /api/rapports/envoyer` avec `{ test: true }` (que la page
 * Paramètres utilise). Dupliquer le chemin d'envoi créerait deux gabarits à
 * maintenir — donc deux vérités possibles sur ce qui a été envoyé. On s'abstient.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('reports.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const result = await listReportDeliveries({
      period: params.get('period') ?? undefined,
      channel: params.get('channel') ?? undefined,
      status: params.get('status') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      page,
      limit,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
