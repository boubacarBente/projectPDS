import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, toNumber, ValidationError } from '@/lib/api';
import { addJobWorker, listJobWorkers, removeJobWorker } from '@/lib/jobs';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/chantiers/[id]/ouvriers — équipe affectée au chantier. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('jobs.view');
    const { id } = await params;

    return ok({ data: await listJobWorkers(parseId(id)) });
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/chantiers/[id]/ouvriers — affectation d'un ouvrier.
 *
 * `workerId` est optionnel : `workerName` reste saisissable pour un journalier
 * ponctuel non enregistré (§17). `amount = days × dailyRate`.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const { id } = await params;
    const jobId = parseId(id);
    const body = await readJson<any>(request);

    const assignment = await addJobWorker(jobId, {
      workerId: toNumber(body.workerId, 0) || null,
      workerName: body.workerName ?? null,
      role: body.role ?? null,
      days: toNumber(body.days, 0),
      dailyRate: body.dailyRate === undefined || body.dailyRate === null ? null : toNumber(body.dailyRate, 0),
    });

    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: {
        addedWorker: assignment.workerName,
        role: assignment.role,
        days: assignment.days,
        dailyRate: assignment.dailyRate,
        amount: assignment.amount,
      },
    });

    return ok(assignment, 201);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/chantiers/[id]/ouvriers?workerId=7 — retrait d'une affectation.
 *
 * `workerId` est l'identifiant de la **ligne** `service_job_workers` : un
 * journalier ponctuel n'a pas de `worker_id`, et un même ouvrier peut
 * intervenir deux fois sur le même chantier.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const { id } = await params;
    const jobId = parseId(id);

    const body = await readJson<any>(request).catch(() => ({}) as any);
    const workerId =
      toNumber(body?.workerId, 0) || toNumber(request.nextUrl.searchParams.get('workerId'), 0);

    if (!workerId) throw new ValidationError('L’affectation à retirer est obligatoire');

    const job = await removeJobWorker(jobId, workerId);

    await writeAudit({
      user,
      action: 'delete',
      entity: 'service_job',
      entityId: jobId,
      details: { removedAssignmentId: workerId, reference: job.reference },
    });

    return ok(job);
  } catch (error) {
    return fail(error);
  }
}
