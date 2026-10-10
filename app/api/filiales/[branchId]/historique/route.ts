import { NextRequest } from 'next/server';
import { rawGet } from '@/db';
import { assertStoreVisible, fail, ok, parsePagination, toInt } from '@/lib/api';
import { listAuditLogs } from '@/lib/audit';
import { requireBranch } from '@/lib/branches';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/historique?entity=&entityId= — historique
 * **d'un document** de la filiale sous `brick.view` (sans ouvrir le journal
 * complet, qui exige `audit.view`). Le document doit être de cette filiale et
 * d'un magasin visible.
 */
const DOCUMENTS: Record<string, string> = {
  brick_production: 'brick_productions',
  brick_order: 'brick_orders',
  brick_type: 'brick_types',
};

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    const search = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(search);
    const entity = search.get('entity') ?? 'brick_production';
    const table = DOCUMENTS[entity];
    const entityId = toInt(search.get('entityId') ?? '', 0);
    const empty = { data: [], total: 0, page: 1, limit, totalPages: 1 };
    if (!table || entityId <= 0) return ok(empty);
    const doc = await rawGet<{ store_id: number; branch_id: number | null }>(`SELECT store_id, branch_id FROM ${table} WHERE id = ?`, [entityId]);
    if (!doc || Number(doc.branch_id) !== branch.id) return ok(empty);
    assertStoreVisible(user, doc.store_id);
    return ok(await listAuditLogs({ entity, entityId, page, limit: Math.min(limit, 100) }));
  } catch (error) {
    return fail(error);
  }
}
