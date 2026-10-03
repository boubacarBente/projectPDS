import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  requireAction,
  requireActiveStore,
  scopeFromRequest,
  toNumber,
} from '@/lib/api';
import { createServiceRequest, getRequestsSummary, listServiceRequests } from '@/lib/service-requests';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/demandes — demandes de prestation des clients (README §19.2).
 * Filtres : `search`, `status` (dont `pending`), `customerId`, `from`, `to`.
 * `?stats=1` = synthèse des cartes.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('jobs.view');
    const params = request.nextUrl.searchParams;
    const scope = scopeFromRequest(user, request);
    if (params.get('stats') === '1') {
      return ok({
        summary: await getRequestsSummary(scope, params.get('from') ?? undefined, params.get('to') ?? undefined),
      });
    }
    const { page, limit } = parsePagination(params);
    return ok(
      await listServiceRequests({
        scope,
        search: params.get('search') ?? undefined,
        status: params.get('status') ?? undefined,
        customerId: toNumber(params.get('customerId'), 0) || undefined,
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
        page,
        limit,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/demandes — nouvelle demande **dans le magasin actif**. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('jobs.create');
    const storeId = await requireActiveStore(user);
    const body = await readJson<any>(request);
    const created = await createServiceRequest({
      storeId,
      userId: user.id,
      customerId: toNumber(body.customerId, 0),
      need: String(body.need ?? ''),
      date: body.date ?? null,
      siteAddress: body.siteAddress ?? null,
      desiredDate: body.desiredDate ?? null,
      serviceIds: Array.isArray(body.serviceIds) ? body.serviceIds.map((v: unknown) => toNumber(v, 0)) : [],
      notes: body.notes ?? null,
    });
    await writeAudit({
      user,
      action: 'create',
      entity: 'service_request',
      entityId: created.id,
      details: { reference: created.reference, customer: created.customerName },
    });
    return ok(created, 201);
  } catch (error) {
    return fail(error);
  }
}
