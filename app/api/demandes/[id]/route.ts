import { NextRequest } from 'next/server';
import {
  assertStoreVisible,
  fail,
  NotFoundError,
  ok,
  parseId,
  readJson,
  requireAction,
  requireActiveStore,
  toNumber,
} from '@/lib/api';
import { getServiceRequest, updateServiceRequest } from '@/lib/service-requests';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/demandes/[id] — une demande, son devis et son chantier éventuels. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.view');
    const { id } = await params;
    const request = await getServiceRequest(parseId(id));
    if (!request) throw new NotFoundError('Demande introuvable');
    assertStoreVisible(user, request.storeId);
    return ok(request);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/demandes/[id] — modification (depuis le magasin de la demande). */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const requestId = parseId(id);
    const body = await readJson<any>(request);
    const patch: Record<string, unknown> = {};
    if (body.customerId !== undefined) patch.customerId = toNumber(body.customerId, 0);
    for (const key of ['need', 'date', 'siteAddress', 'desiredDate', 'notes'] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (Array.isArray(body.serviceIds)) patch.serviceIds = body.serviceIds.map((v: unknown) => toNumber(v, 0));
    const updated = await updateServiceRequest(requestId, patch as any, storeId);
    await writeAudit({
      user,
      action: 'update',
      entity: 'service_request',
      entityId: requestId,
      details: { reference: updated.reference, fields: Object.keys(patch) },
    });
    return ok(updated);
  } catch (error) {
    return fail(error);
  }
}
