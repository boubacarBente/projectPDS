import { NextRequest } from 'next/server';
import { ValidationError, fail, ok, parseId, readJson, requireAction, requireCentralEdit } from '@/lib/api';
import { listUserAssignments, setUserAssignments } from '@/lib/stores';
import { assertAssignableStores, assertCanManageUser } from '@/lib/user-scope';
import { revokeUserSessions } from '@/lib/session';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/users/[id]/magasins — affectations du compte aux magasins.
 * Réponse : `UserStoreAssignment[]` (magasin, gérant oui/non, période).
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const actor = await requireAction('users.manage');
    const { id } = await params;
    const userId = parseId(id);
    await assertCanManageUser(actor, userId);
    return ok(await listUserAssignments(userId));
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/users/[id]/magasins — remplace les affectations.
 * Corps : `{ stores: [{ storeId, isManager?, startsAt?, endsAt? }] }`.
 *
 * Un gérant ne peut affecter qu'à ses propres magasins, et les affectations
 * qu'il ne voit pas (autres magasins) sont conservées telles quelles.
 * Les sessions ouvertes du compte sont fermées : son périmètre a changé.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const actor = await requireAction('users.manage');
    await requireCentralEdit();
    const { id } = await params;
    const userId = parseId(id);
    await assertCanManageUser(actor, userId);

    const body = await readJson<any>(request);
    if (!Array.isArray(body.stores)) {
      throw new ValidationError('Le champ « stores » doit être une liste de magasins');
    }

    const wanted = body.stores.map((s: any) => ({
      storeId: Number(s.storeId),
      isManager: Boolean(s.isManager),
      startsAt: s.startsAt || null,
      endsAt: s.endsAt || null,
    }));
    assertAssignableStores(actor, wanted.map((s: { storeId: number }) => s.storeId));

    // Gérant : on conserve les affectations hors de son périmètre.
    if (!actor.allStores) {
      const current = await listUserAssignments(userId);
      for (const a of current) {
        if (a.isActive && !actor.storeIds.includes(a.storeId)) {
          wanted.push({ storeId: a.storeId, isManager: a.isManager, startsAt: a.startsAt, endsAt: a.endsAt });
        }
      }
    }

    const result = await setUserAssignments(userId, wanted, { id: actor.id, name: actor.name });
    if (userId !== actor.id) await revokeUserSessions(userId);

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
