import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  requireActiveStore,
  assertStoreVisible,
  toNumber,
  NotFoundError,
  ValidationError,
} from '@/lib/api';
import {
  cancelServiceJob,
  getServiceJob,
  getServiceJobRow,
  isJobStatus,
  isQuoteStatus,
  updateServiceJob,
  updateStatus,
} from '@/lib/jobs';
import { canViewSalesProfit } from '@/lib/sales';
import { writeAudit } from '@/lib/audit';
import { getStoreLetterhead } from '@/lib/stores';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/chantiers/[id] — fiche complète : prestations, étapes, équipe,
 * matériaux, sous-traitance, dépenses, paiements. La rentabilité (`costs`)
 * vaut `null` sans la permission `balances.view` (invariant n° 13).
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.view');
    const { id } = await params;

    const row = await getServiceJobRow(parseId(id));
    if (!row) throw new NotFoundError('Chantier introuvable');
    assertStoreVisible(user, row.storeId);

    const detail = await getServiceJob(row.id, { withCosts: await canViewSalesProfit(user) });
    if (!detail) throw new NotFoundError('Chantier introuvable');

    // En-tête des documents : coordonnées du magasin du chantier.
    return ok({ ...detail, store: await getStoreLetterhead(detail.job.storeId) });
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/chantiers/[id] — informations, dates, responsable, avancement, statut. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const { id } = await params;
    const jobId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.customerId !== undefined) patch.customerId = toNumber(body.customerId, 0);
    if (typeof body.category === 'string') patch.category = body.category;
    for (const key of [
      'title',
      'siteAddress',
      'description',
      'startDate',
      'endDate',
      'actualStartDate',
      'actualEndDate',
      'notes',
      'progress',
      'responsibleUserId',
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.amount !== undefined && body.amount !== null && body.amount !== '') patch.amount = toNumber(body.amount, 0);
    if (body.quoteStatus !== undefined && isQuoteStatus(body.quoteStatus)) patch.quoteStatus = body.quoteStatus;
    if (body.quoteMaterials !== undefined) patch.quoteMaterials = toNumber(body.quoteMaterials, 0);
    if (body.quoteLabor !== undefined) patch.quoteLabor = toNumber(body.quoteLabor, 0);

    const storeId = await requireActiveStore(user);
    const statusChange = body.status !== undefined && isJobStatus(body.status) ? body.status : null;

    if (Object.keys(patch).length === 0 && !statusChange) {
      throw new ValidationError('Aucune modification fournie');
    }

    let job = Object.keys(patch).length > 0 ? await updateServiceJob(jobId, patch as any, storeId) : null;
    if (statusChange) {
      const before = job ?? (await getServiceJobRow(jobId));
      if (before && before.status !== statusChange) job = await updateStatus(jobId, statusChange, storeId);
    }
    job = job ?? (await getServiceJobRow(jobId));

    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: { reference: job?.reference, ...patch, ...(statusChange ? { status: statusChange } : {}) },
    });

    return ok(job);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/chantiers/[id] — **annulation motivée**, jamais une suppression.
 * Le corps porte `{ reason }`.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.delete');
    const { id } = await params;
    const jobId = parseId(id);

    const body = await readJson<any>(request).catch(() => ({}) as any);
    const reason =
      (typeof body?.reason === 'string' && body.reason) ||
      request.nextUrl.searchParams.get('reason') ||
      '';

    await requireActiveStore(user);
    const job = await cancelServiceJob(jobId, reason, user);

    await writeAudit({
      user,
      action: 'cancel',
      entity: 'service_job',
      entityId: jobId,
      details: { reference: job.reference, reason, stockReturned: true },
    });

    return ok(job);
  } catch (error) {
    return fail(error);
  }
}
