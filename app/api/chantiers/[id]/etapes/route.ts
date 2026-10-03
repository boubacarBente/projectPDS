import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, requireActiveStore, toNumber, ValidationError } from '@/lib/api';
import { addJobStage, isStageStatus, removeJobStage, updateJobStage, type StageInput } from '@/lib/jobs';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

function readStage(body: any): StageInput {
  const input: StageInput = {};
  if (body.name !== undefined) input.name = body.name;
  if (body.serviceId !== undefined) input.serviceId = body.serviceId ? toNumber(body.serviceId, 0) : null;
  if (body.responsible !== undefined) input.responsible = body.responsible;
  if (body.plannedDate !== undefined) input.plannedDate = body.plannedDate;
  if (body.actualDate !== undefined) input.actualDate = body.actualDate;
  if (body.progress !== undefined) input.progress = toNumber(body.progress, 0);
  if (body.status !== undefined && isStageStatus(body.status)) input.status = body.status;
  if (body.comment !== undefined) input.comment = body.comment;
  return input;
}

/** POST /api/chantiers/[id]/etapes — nouvelle étape (terrassement, fondation…). */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const jobId = parseId(id);
    const stage = await addJobStage(jobId, readStage(await readJson<any>(request)), storeId);
    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: { addedStage: stage.name, progress: stage.progress },
    });
    return ok(stage, 201);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/chantiers/[id]/etapes?stageId= — avancement, dates, commentaire. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const jobId = parseId(id);
    const stageId = toNumber(request.nextUrl.searchParams.get('stageId'), 0);
    if (!stageId) throw new ValidationError('Étape non précisée');
    const stage = await updateJobStage(jobId, stageId, readStage(await readJson<any>(request)), storeId);
    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: { stage: stage.name, progress: stage.progress, stageStatus: stage.status },
    });
    return ok(stage);
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/chantiers/[id]/etapes?stageId= — retire une étape de planification. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const jobId = parseId(id);
    const stageId = toNumber(request.nextUrl.searchParams.get('stageId'), 0);
    if (!stageId) throw new ValidationError('Étape non précisée');
    const stage = await removeJobStage(jobId, stageId, storeId);
    await writeAudit({ user, action: 'update', entity: 'service_job', entityId: jobId, details: { removedStage: stage.name } });
    return ok(stage);
  } catch (error) {
    return fail(error);
  }
}
