import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, ValidationError } from '@/lib/api';
import {
  clearUserOverrides,
  getPermissionMatrix,
  setUserOverrides,
} from '@/lib/user-permissions';
import { ALL_ACTIONS, isAction, type Action } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/users/[id]/permissions
 *
 * Matrice complète pour l'écran de réglage : pour chaque action, ce que le
 * **rôle** accorde, ce que la **surcharge** décide, et le **résultat** effectif.
 * L'interface a ainsi tout ce qu'il faut pour afficher trois états par action.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('users.manage');
    const { id } = await params;

    return ok(await getPermissionMatrix(parseId(id)));
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/users/[id]/permissions
 *
 * Corps : `{ overrides: [{ action, effect: 'allow' | 'deny' }] }`.
 * La liste est **complète** : une action absente revient à l'héritage du rôle.
 * `effect: null` sur une entrée est accepté et équivaut à l'absence.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const actor = await requireAction('users.manage');
    const { id } = await params;
    const userId = parseId(id);
    const body = await readJson<any>(request);

    const raw = Array.isArray(body?.overrides) ? body.overrides : null;
    if (!raw) {
      throw new ValidationError('Le champ « overrides » doit être un tableau');
    }

    const entries: { action: Action; effect: 'allow' | 'deny' }[] = [];

    for (const item of raw) {
      const action = item?.action;
      const effect = item?.effect;

      if (!isAction(action)) {
        throw new ValidationError(`Action inconnue : ${String(action)}`);
      }
      // `null` = retour à l'héritage : on l'ignore simplement.
      if (effect === null || effect === undefined) continue;
      if (effect !== 'allow' && effect !== 'deny') {
        throw new ValidationError(
          `Effet invalide pour « ${action} » : attendu « allow », « deny » ou null`,
        );
      }

      entries.push({ action, effect });
    }

    const effective = await setUserOverrides(userId, entries, { id: actor.id, name: actor.name });

    return ok({ success: true, effective });
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/users/[id]/permissions
 * Réinitialise toutes les surcharges : l'utilisateur revient à la matrice de
 * son rôle. Aucune donnée métier n'est touchée.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const actor = await requireAction('users.manage');
    const { id } = await params;

    const effective = await clearUserOverrides(parseId(id), { id: actor.id, name: actor.name });

    return ok({ success: true, effective });
  } catch (error) {
    return fail(error);
  }
}

/** GET /api/users/[id]/permissions?catalog=true — la liste des actions connues. */
export async function OPTIONS() {
  return ok({ actions: ALL_ACTIONS });
}
