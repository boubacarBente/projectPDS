import { NextRequest } from 'next/server';
import { ValidationError, fail, ok, parseId, readJson, requireAction, requireCentralEdit } from '@/lib/api';
import { listUserAssignments, setUserAssignments } from '@/lib/stores';
import { assertAssignableStores, assertCanManageUser } from '@/lib/user-scope';
import { revokeUserSessions } from '@/lib/session';
import { getUser } from '@/lib/users';
import { getUserOverrides, setUserOverrides } from '@/lib/user-permissions';

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
 * Corps : `{ stores: [{ storeId, isManager?, startsAt?, endsAt? }], canSwitchStore? }`.
 * `canSwitchStore` (facultatif) accorde ou retire le droit de changer de
 * magasin actif (`stores.switch`, README §28.6) : réglé au même endroit que
 * les magasins visibles, les autres surcharges du compte sont conservées.
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

    if (typeof body.canSwitchStore === 'boolean') {
      const target = await getUser(userId);
      if (target && target.role !== 'admin') {
        const others = (await getUserOverrides(userId)).filter((o) => o.action !== 'stores.switch');
        await setUserOverrides(
          userId,
          body.canSwitchStore ? [...others, { action: 'stores.switch', effect: 'allow' }] : others,
          { id: actor.id, name: actor.name },
        );
      }
    }
    if (userId !== actor.id) await revokeUserSessions(userId);

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
