import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  requireUser,
  toBool,
  toNumber,
  NotFoundError,
} from '@/lib/api';
import { deactivateWorker, getWorker, isWorkerRole, reactivateWorker, updateWorker } from '@/lib/workers';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/workers/[id] — fiche d'un ouvrier et ses cumuls calculés. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireUser();
    const { id } = await params;

    const worker = await getWorker(parseId(id));
    if (!worker) throw new NotFoundError('Ouvrier introuvable');

    return ok(worker);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/workers/[id] — modification de la fiche. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('workers.manage');
    const { id } = await params;
    const workerId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.role !== undefined) patch.role = isWorkerRole(body.role) ? body.role : 'worker';
    if (body.specialty !== undefined) patch.specialty = body.specialty;
    if (body.dailyRate !== undefined) patch.dailyRate = toNumber(body.dailyRate, 0);
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);

    const worker = await updateWorker(workerId, patch as any);

    await writeAudit({
      user,
      action: 'update',
      entity: 'worker',
      entityId: workerId,
      details: patch,
    });

    return ok(worker);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/workers/[id] — **désactivation**, jamais de suppression
 * physique (§7). `?reactivate=true` réactive la fiche.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('workers.manage');
    const { id } = await params;
    const workerId = parseId(id);

    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';

    if (reactivate) {
      await reactivateWorker(workerId);
    } else {
      await deactivateWorker(workerId);
    }

    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'worker',
      entityId: workerId,
      details: { reactivated: reactivate },
    });

    return ok({ success: true, deactivated: !reactivate });
  } catch (error) {
    return fail(error);
  }
}
