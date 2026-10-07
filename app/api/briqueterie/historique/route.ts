import { NextRequest } from 'next/server';
import { rawGet } from '@/db';
import { assertStoreVisible, fail, ok, parsePagination, requireAction, toInt } from '@/lib/api';
import { listAuditLogs } from '@/lib/audit';

/**
 * GET /api/briqueterie/historique?entity=&entityId= — historique **d'un
 * document** de la briqueterie sous `brick.view` (sans ouvrir le journal
 * complet, qui exige `audit.view`). Le document doit être d'un magasin visible.
 */
const DOCUMENTS: Record<string, string> = {
  brick_production: 'brick_productions',
  brick_order: 'brick_orders',
  brick_type: 'brick_types',
};

export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('brick.view');
    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    const entity = params.get('entity') ?? 'brick_production';
    const table = DOCUMENTS[entity];
    const entityId = toInt(params.get('entityId') ?? '', 0);
    if (!table || entityId <= 0) return ok({ data: [], total: 0, page: 1, limit, totalPages: 1 });
    const doc = await rawGet<{ store_id: number }>(`SELECT store_id FROM ${table} WHERE id = ?`, [entityId]);
    if (!doc) return ok({ data: [], total: 0, page: 1, limit, totalPages: 1 });
    assertStoreVisible(user, doc.store_id);
    return ok(await listAuditLogs({ entity, entityId, page, limit: Math.min(limit, 100) }));
  } catch (error) {
    return fail(error);
  }
}
