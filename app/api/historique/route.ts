import { NextRequest } from 'next/server';
import { rawGet } from '@/db';
import { assertStoreVisible, fail, NotFoundError, ok, requireAction, toNumber, ValidationError } from '@/lib/api';
import { listAuditLogs } from '@/lib/audit';

/**
 * GET /api/historique?entity=&id= — historique des modifications **d'un
 * document** de chantier (cahier « Prestations » §5, §23, §25).
 *
 * Lecture ouverte à `jobs.view` (un vendeur peut voir qui a changé le prix
 * d'une prestation) sans donner accès au journal complet (`audit.view`). Le
 * document doit appartenir à un magasin visible : on ne lit pas l'historique
 * d'une prestation d'un autre magasin.
 */
const DOCUMENTS: Record<string, string> = {
  service_job: 'service_jobs',
  quote: 'quotes',
  service: 'services',
  service_request: 'service_requests',
};

export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('jobs.view');
    const params = request.nextUrl.searchParams;
    const entity = params.get('entity') ?? '';
    const id = toNumber(params.get('id'), 0);
    const table = DOCUMENTS[entity];
    if (!table || !id) throw new ValidationError('Document non précisé');

    const doc = await rawGet<{ store_id: number | null }>(`SELECT store_id FROM ${table} WHERE id = ?`, [id]);
    if (!doc) throw new NotFoundError('Document introuvable');
    assertStoreVisible(user, doc.store_id);

    const result = await listAuditLogs({ entity, entityId: id, limit: 200, page: 1 });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
