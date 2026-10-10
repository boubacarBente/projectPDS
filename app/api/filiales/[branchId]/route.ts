import { NextRequest } from 'next/server';
import { fail, ok, readJson, requireAction, requireCentralEdit, ValidationError } from '@/lib/api';
import { requireBranch, setBranchStatus, updateBranch, type BranchStatus } from '@/lib/branches';

type Params = { params: Promise<{ branchId: string }> };

/** GET /api/filiales/[branchId] — la filiale, avec le niveau d'accès de la session (`access`). */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { branch } = await requireBranch((await params).branchId, 'brick.view');
    return ok(branch);
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/filiales/[branchId] — paramètres de la filiale (siège, `brick.branches`).
 * `{ action: 'set_status', status, reason }` : activer, suspendre, archiver.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.branches');
    await requireCentralEdit();
    const id = Number((await params).branchId);
    const body = await readJson<any>(request);
    if (body.action === 'set_status') {
      if (!['active', 'suspended', 'archived'].includes(body.status)) throw new ValidationError('Statut de filiale invalide');
      return ok(await setBranchStatus(id, body.status as BranchStatus, body.reason ?? null, user));
    }
    const patch: Record<string, unknown> = {};
    for (const key of [
      'name',
      'activity',
      'description',
      'color',
      'icon',
      'sortOrder',
      'unit',
      'stages',
      'lossLabel',
      'batchPrefix',
      'orderPrefix',
      'accessMode',
      'customerMode',
    ]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.storeId !== undefined) patch.storeId = body.storeId ? Number(body.storeId) : null;
    return ok(await updateBranch(id, patch, user));
  } catch (error) {
    return fail(error);
  }
}
