import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, requireActiveStore, toNumber, ValidationError } from '@/lib/api';
import { addJobSubcontract, cancelJobSubcontract, updateJobSubcontract } from '@/lib/jobs';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/chantiers/[id]/sous-traitance — confie des travaux à un
 * sous-traitant (fiche fournisseur). Le paiement se fait par une dépense
 * rattachée (`referenceType = 'job_subcontract'`), qui passe par la caisse et
 * l'approbation : le « payé » n'est jamais saisi à la main.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const jobId = parseId(id);
    const body = await readJson<any>(request);
    const row = await addJobSubcontract(
      jobId,
      {
        supplierId: toNumber(body.supplierId, 0),
        work: String(body.work ?? ''),
        agreedAmount: toNumber(body.agreedAmount, 0),
        notes: body.notes ?? null,
        userId: user.id,
      },
      storeId,
    );
    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: { subcontractor: row.supplierName, work: row.work, agreedAmount: row.agreedAmount },
    });
    return ok(row, 201);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/chantiers/[id]/sous-traitance?subcontractId= — travaux, montant convenu. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const jobId = parseId(id);
    const subcontractId = toNumber(request.nextUrl.searchParams.get('subcontractId'), 0);
    if (!subcontractId) throw new ValidationError('Sous-traitance non précisée');
    const body = await readJson<any>(request);
    const patch: { work?: string; agreedAmount?: number; notes?: string | null } = {};
    if (body.work !== undefined) patch.work = String(body.work);
    if (body.agreedAmount !== undefined) patch.agreedAmount = toNumber(body.agreedAmount, 0);
    if (body.notes !== undefined) patch.notes = body.notes;
    const row = await updateJobSubcontract(jobId, subcontractId, patch, storeId);
    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: { subcontractor: row.supplierName, ...patch },
    });
    return ok(row);
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/chantiers/[id]/sous-traitance?subcontractId= — **annulation** (jamais de suppression). */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const jobId = parseId(id);
    const subcontractId = toNumber(request.nextUrl.searchParams.get('subcontractId'), 0);
    if (!subcontractId) throw new ValidationError('Sous-traitance non précisée');
    const row = await cancelJobSubcontract(jobId, subcontractId, storeId);
    await writeAudit({
      user,
      action: 'cancel',
      entity: 'service_job',
      entityId: jobId,
      details: { subcontractor: row.supplierName, work: row.work },
    });
    return ok(row);
  } catch (error) {
    return fail(error);
  }
}
