import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  toNumber,
  NotFoundError,
  ValidationError,
} from '@/lib/api';
import {
  cancelServiceJob,
  getServiceJob,
  isJobCategory,
  isJobStatus,
  isQuoteStatus,
  updateServiceJob,
} from '@/lib/jobs';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/chantiers/[id] — fiche complète : matériaux, équipe, paiements, coûts. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('jobs.view');
    const { id } = await params;

    const detail = await getServiceJob(parseId(id));
    if (!detail) throw new NotFoundError('Chantier introuvable');

    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/chantiers/[id] — informations, dates, devis, avancement. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const { id } = await params;
    const jobId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.customerId !== undefined) patch.customerId = toNumber(body.customerId, 0);
    if (body.category !== undefined && isJobCategory(body.category)) patch.category = body.category;
    if (body.title !== undefined) patch.title = body.title;
    if (body.siteAddress !== undefined) patch.siteAddress = body.siteAddress;
    if (body.description !== undefined) patch.description = body.description;
    if (body.startDate !== undefined) patch.startDate = body.startDate;
    if (body.endDate !== undefined) patch.endDate = body.endDate;
    if (body.status !== undefined && isJobStatus(body.status)) patch.status = body.status;
    if (body.quoteStatus !== undefined && isQuoteStatus(body.quoteStatus)) {
      patch.quoteStatus = body.quoteStatus;
    }
    if (body.quoteMaterials !== undefined) patch.quoteMaterials = toNumber(body.quoteMaterials, 0);
    if (body.quoteLabor !== undefined) patch.quoteLabor = toNumber(body.quoteLabor, 0);
    if (body.notes !== undefined) patch.notes = body.notes;

    if (Object.keys(patch).length === 0) {
      throw new ValidationError('Aucune modification fournie');
    }

    const job = await updateServiceJob(jobId, patch as any);

    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: { reference: job.reference, ...patch },
    });

    return ok(job);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/chantiers/[id] — **annulation motivée**, jamais une suppression
 * (§7, §6.5 règle 4). Le corps porte `{ reason }`.
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
