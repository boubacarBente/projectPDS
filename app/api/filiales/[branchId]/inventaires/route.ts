import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireAction, scopeFromRequest } from '@/lib/api';
import { requireBranch } from '@/lib/branches';
import { getInventory, listInventories, openInventory } from '@/lib/inventories';

type Params = { params: Promise<{ branchId: string }> };

/** GET — inventaires de la filiale (README §31.6). Droits : filiale + `inventory.view`. */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    await requireAction('inventory.view');
    const query = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(query);
    return ok(
      await listInventories({
        scope: scopeFromRequest(user, request),
        branchId: branch.id,
        status: query.get('status') ?? undefined,
        page,
        limit,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST — ouvre l'inventaire de la filiale dans le magasin actif : ses modèles
 * actifs et les matières de leur nomenclature. Un seul inventaire ouvert par
 * magasin (filiales comprises). Droits : filiale (saisie) + `inventory.manage`.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.update', { write: true });
    await requireAction('inventory.manage');
    const body = await readJson<any>(request).catch(() => ({}) as any);
    const id = await openInventory({ branchId: branch.id, notes: body?.notes ?? null }, user);
    return ok(await getInventory(id), 201);
  } catch (error) {
    return fail(error);
  }
}
