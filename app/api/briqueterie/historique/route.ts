import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, requireAction, toInt } from '@/lib/api';
import { listAuditLogs } from '@/lib/audit';

/**
 * GET /api/briqueterie/historique?entity=brick_production|brick_order&entityId=12
 *
 * **Historique et traçabilité** de la briqueterie (§20, point 10), sans donner
 * accès au journal complet : `/api/audit` exige `audit.view` (administrateur ou
 * gérant), alors qu'un chef d'équipe qui consulte une fiche doit pouvoir lire
 * *l'histoire de cette fiche* avec `brick.view`.
 *
 * Le filtre `entity` est **restreint aux entités de la briqueterie** : ce n'est
 * pas une porte dérobée vers le journal des ventes ou des utilisateurs.
 *
 * Lecture seule et non journalisée : consulter un historique n'est pas une
 * opération à tracer, sinon l'historique se noierait lui-même (§20.13).
 */
const ALLOWED_ENTITIES = ['brick_production', 'brick_order', 'brick_type'];

export async function GET(request: NextRequest) {
  try {
    await requireAction('brick.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const entity = params.get('entity') ?? 'brick_production';
    if (!ALLOWED_ENTITIES.includes(entity)) {
      return ok({ data: [], total: 0, page: 1, limit, totalPages: 1 });
    }

    const entityId = toInt(params.get('entityId') ?? '', 0);

    const result = await listAuditLogs({
      entity,
      entityId: entityId > 0 ? entityId : undefined,
      page,
      limit: Math.min(limit, 100),
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
