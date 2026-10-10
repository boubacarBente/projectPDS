import { NextRequest } from 'next/server';
import { fail, ok, readJson, requireAction, requireCentralEdit, requireUser, toBool } from '@/lib/api';
import { canManageBranches, createBranch, listAccessibleBranches, listBranches } from '@/lib/branches';

/**
 * GET /api/filiales — filiales de production (README §31).
 *  - par défaut : les filiales **actives** que la session peut ouvrir, avec son niveau ;
 *  - `?all=true` (gestionnaire des filiales) : toutes, suspendues et archivées comprises.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const all = toBool(request.nextUrl.searchParams.get('all'), false);
    if (all && canManageBranches(user)) {
      const branches = await listBranches({ includeArchived: true });
      return ok({ data: branches, total: branches.length, canManage: true });
    }
    if (!user.permissions.includes('brick.view')) return ok({ data: [], total: 0, canManage: false });
    const branches = await listAccessibleBranches(user, { includeInactive: toBool(request.nextUrl.searchParams.get('includeInactive'), false) });
    return ok({ data: branches, total: branches.length, canManage: canManageBranches(user) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/filiales — nouvelle filiale (siège, `brick.branches`). */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('brick.branches');
    await requireCentralEdit();
    const body = await readJson<any>(request);
    const branch = await createBranch(
      {
        name: body.name,
        activity: body.activity,
        description: body.description ?? null,
        storeId: body.storeId ? Number(body.storeId) : null,
        color: body.color ?? null,
        sortOrder: body.sortOrder === undefined || body.sortOrder === '' ? undefined : Number(body.sortOrder),
        unit: body.unit,
        stages: Array.isArray(body.stages) ? body.stages : undefined,
        lossLabel: body.lossLabel,
        batchPrefix: body.batchPrefix,
        orderPrefix: body.orderPrefix,
        accessMode: body.accessMode,
        customerMode: body.customerMode,
      },
      user,
    );
    return ok(branch, 201);
  } catch (error) {
    return fail(error);
  }
}
