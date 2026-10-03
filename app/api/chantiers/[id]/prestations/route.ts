import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, requireActiveStore, toNumber, ValidationError } from '@/lib/api';
import { addJobItem, removeJobItem, updateJobItem } from '@/lib/jobs';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/chantiers/[id]/prestations — ajoute une ligne de prestation.
 *
 * La prestation doit appartenir au catalogue **du magasin du chantier** et
 * être active : le serveur le vérifie même si l'identifiant est forgé
 * (critère de recette n° 5). Le prix est figé dans la ligne.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const jobId = parseId(id);
    const body = await readJson<any>(request);

    const job = await addJobItem(
      jobId,
      {
        serviceId: toNumber(body.serviceId, 0),
        quantity: toNumber(body.quantity, 0),
        unitPrice: body.unitPrice === undefined || body.unitPrice === '' || body.unitPrice === null ? null : toNumber(body.unitPrice, 0),
        discountPercent: toNumber(body.discountPercent, 0),
      },
      storeId,
    );
    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: { reference: job.reference, addedService: toNumber(body.serviceId, 0), total: job.total },
    });
    return ok(job, 201);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/chantiers/[id]/prestations?itemId= — quantité, prix négocié, remise. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const jobId = parseId(id);
    const itemId = toNumber(request.nextUrl.searchParams.get('itemId'), 0);
    if (!itemId) throw new ValidationError('Ligne à modifier non précisée');
    const body = await readJson<any>(request);

    const patch: { quantity?: number; unitPrice?: number; discountPercent?: number } = {};
    if (body.quantity !== undefined) patch.quantity = toNumber(body.quantity, 0);
    if (body.unitPrice !== undefined) patch.unitPrice = toNumber(body.unitPrice, 0);
    if (body.discountPercent !== undefined) patch.discountPercent = toNumber(body.discountPercent, 0);

    const job = await updateJobItem(jobId, itemId, patch, storeId);
    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: { reference: job.reference, updatedLine: itemId, ...patch, total: job.total },
    });
    return ok(job);
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/chantiers/[id]/prestations?itemId= — retire une ligne (journalisé). */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const jobId = parseId(id);
    const itemId = toNumber(request.nextUrl.searchParams.get('itemId'), 0);
    if (!itemId) throw new ValidationError('Ligne à retirer non précisée');

    const { job, removed } = await removeJobItem(jobId, itemId, storeId);
    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: {
        reference: job.reference,
        removedService: removed.serviceName,
        quantity: removed.quantity,
        amount: removed.amount,
        total: job.total,
      },
    });
    return ok(job);
  } catch (error) {
    return fail(error);
  }
}
