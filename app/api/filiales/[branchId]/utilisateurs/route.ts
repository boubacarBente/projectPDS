import { NextRequest } from 'next/server';
import { fail, NotFoundError, ok, readJson, requireAction, requireCentralEdit } from '@/lib/api';
import { getBranch, listBranchUsers, setBranchUsers } from '@/lib/branches';

type Params = { params: Promise<{ branchId: string }> };

/** GET /api/filiales/[branchId]/utilisateurs — comptes autorisés d'une filiale `restricted`. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('brick.branches');
    const branch = await getBranch(Number((await params).branchId));
    if (!branch) throw new NotFoundError('Filiale introuvable');
    return ok({ data: await listBranchUsers(branch.id), accessMode: branch.accessMode });
  } catch (error) {
    return fail(error);
  }
}

/** PUT — remplace la liste : `{ users: [{ userId, level: 'view' | 'edit' | 'manage' }] }`. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.branches');
    await requireCentralEdit();
    const body = await readJson<any>(request);
    const entries = Array.isArray(body.users) ? body.users : [];
    return ok({ data: await setBranchUsers(Number((await params).branchId), entries, user) });
  } catch (error) {
    return fail(error);
  }
}
