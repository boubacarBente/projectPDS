import { NextRequest } from 'next/server';
import { assertStoreVisible, fail, NotFoundError, ok, parseId } from '@/lib/api';
import { can } from '@/lib/permissions';
import { requireBranch } from '@/lib/branches';
import { getInventory } from '@/lib/inventories';

type Params = { params: Promise<{ branchId: string; id: string }> };

/**
 * GET — fiche d'un inventaire de la filiale. Comptage, validation et
 * annulation passent par `POST /api/inventaires/[id]` (mêmes règles que tout
 * inventaire : justification de chaque écart, ajustements à la validation).
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.view');
    if (!can(user, 'inventory.view', user.permissions)) throw new NotFoundError('Inventaire introuvable');
    const detail = await getInventory(parseId(id));
    if (!detail || detail.inventory.productionBranchId !== branch.id) throw new NotFoundError('Inventaire introuvable dans cette filiale');
    assertStoreVisible(user, detail.inventory.storeId);
    const actions: string[] = [];
    if (detail.inventory.status === 'open' && user.storeId === detail.inventory.storeId && branch.status === 'active') {
      if (can(user, 'inventory.manage', user.permissions)) actions.push('count', 'cancel');
      if (can(user, 'inventory.validate', user.permissions)) actions.push('validate');
    }
    return ok({ ...detail, actions });
  } catch (error) {
    return fail(error);
  }
}
