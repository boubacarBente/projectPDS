import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, required, requireAction } from '@/lib/api';
import { changePassword, getUser } from '@/lib/users';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * PUT /api/users/[id]/password — réinitialisation par un administrateur.
 *
 * Route **dédiée** : le mot de passe ne se modifie jamais via `PUT /api/users/[id]`,
 * ce qui évite qu'un mot de passe traîne dans un journal d'audit ou dans un
 * payload de synchronisation. Le nouveau mot de passe est haché en scrypt salé
 * par `lib/users.ts` → `hashPassword` (`node:crypto`), jamais stocké en clair.
 *
 * Aucune empreinte n'est renvoyée ni journalisée : l'audit ne note que le fait.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('users.manage');
    const { id } = await params;
    const userId = parseId(id);
    const body = await readJson<any>(request);

    const password = required(body.password, 'Nouveau mot de passe');

    await changePassword(userId, password);

    const target = await getUser(userId);

    await writeAudit({
      user,
      action: 'update',
      entity: 'user',
      entityId: userId,
      // Réinitialisation constatée, sans la moindre donnée d'authentification.
      details: {
        field: 'password',
        message: 'Mot de passe réinitialisé',
        target: target?.username ?? null,
      },
    });

    return ok({ success: true });
  } catch (error) {
    return fail(error);
  }
}
