import { NextRequest } from 'next/server';
import {
  NotFoundError,
  ValidationError,
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  toBool,
} from '@/lib/api';
import { deactivateUser, getUser, reactivateUser, updateUser, type UserPatch } from '@/lib/users';
import { writeAudit } from '@/lib/audit';
import { isRole } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

/** GET /api/users/[id] — fiche d'un compte, **sans** `password_hash`. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('users.manage');
    const { id } = await params;

    const user = await getUser(parseId(id));
    if (!user) throw new NotFoundError('Utilisateur introuvable');

    return ok(user);
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/users/[id] — nom, identifiant, rôle, téléphone, activation.
 *
 * Le mot de passe ne se change **pas** ici : voir
 * `PUT /api/users/[id]/password`. Les deux garde-fous du dernier
 * administrateur actif (rétrogradation, désactivation) vivent dans
 * `lib/users.ts` et lèvent un 409 explicite.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('users.manage');
    const { id } = await params;
    const userId = parseId(id);
    const body = await readJson<any>(request);

    const patch: UserPatch = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.username !== undefined) patch.username = String(body.username);
    if (body.role !== undefined) {
      if (!isRole(body.role)) {
        throw new ValidationError('Rôle invalide : choisissez l’un des six rôles proposés');
      }
      patch.role = body.role;
    }
    if (body.phone !== undefined) patch.phone = body.phone === null ? null : String(body.phone);
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);

    const updated = await updateUser(userId, patch);

    await writeAudit({
      user,
      action: 'update',
      entity: 'user',
      entityId: userId,
      details: {
        name: updated.name,
        username: updated.username,
        role: updated.role,
        isActive: updated.isActive,
      },
    });

    return ok(updated);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/users/[id] — **désactivation**, jamais de suppression physique
 * (README §26.13). `?reactivate=true` réactive le compte.
 *
 * Un compte désactivé conserve son historique : les `audit_logs` et les
 * documents qu'il a créés restent rattachés à son nom.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('users.manage');
    const { id } = await params;
    const userId = parseId(id);

    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';

    if (reactivate) {
      await reactivateUser(userId);
    } else {
      await deactivateUser(userId);
    }

    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'user',
      entityId: userId,
      details: { reactivated: reactivate, deactivated: !reactivate },
    });

    return ok({ success: true, deactivated: !reactivate });
  } catch (error) {
    return fail(error);
  }
}
