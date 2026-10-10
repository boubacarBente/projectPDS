import { NextRequest } from 'next/server';
import { fail, ok, readJson, requireActiveStore, scopeFromRequest, toBool, toInt, ValidationError } from '@/lib/api';
import { listBranchCustomers, requireBranch, setCustomerShared } from '@/lib/branches';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/clients — clients de la portée avec leur
 * partage et leur activité dans la filiale (README §31.4). `?shared=true` :
 * seulement les clients partagés. Exige aussi `customers.view`.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'customers.view');
    const search = request.nextUrl.searchParams;
    const data = await listBranchCustomers(branch, {
      scope: scopeFromRequest(user, request),
      search: search.get('search')?.trim() || undefined,
      onlyShared: toBool(search.get('shared'), false),
    });
    return ok({ data, total: data.length, customerMode: branch.customerMode });
  } catch (error) {
    return fail(error);
  }
}

/** PUT — `{ customerId, shared }` : partager ou retirer un client du magasin actif (`brick.types`). */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.types', { write: true });
    await requireActiveStore(user);
    const body = await readJson<any>(request);
    const customerId = toInt(body.customerId, 0);
    if (customerId <= 0) throw new ValidationError('Client non précisé');
    await setCustomerShared(branch, customerId, toBool(body.shared, true), user);
    return ok({ customerId, shared: toBool(body.shared, true) });
  } catch (error) {
    return fail(error);
  }
}
