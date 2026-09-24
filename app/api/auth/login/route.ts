import { NextRequest, NextResponse } from 'next/server';
import { getUserByUsername, touchLastLogin, upgradePasswordHashIfLegacy, verifyPassword } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { createSessionResponse } from '@/lib/session';
import type { Role } from '@/lib/permissions';

/**
 * POST /api/auth/login
 *
 * ⚠️ Le compte administrateur **codé en dur** du projet Gaz (`boubacar` /
 * `1265`) est supprimé : c'était une faille, un compte connu contournant la
 * base (README §3.4). Il n'existe aucun chemin d'authentification hors base.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    // `name` est accepté en plus de `username` pour rester compatible avec le
    // formulaire hérité du projet Gaz.
    const username = String(body?.username ?? body?.name ?? '').trim();
    const password = String(body?.password ?? '');

    if (!username || !password) {
      return NextResponse.json(
        { error: "Nom d'utilisateur et mot de passe requis" },
        { status: 400 },
      );
    }

    const user = await getUserByUsername(username);

    // Message volontairement identique dans les deux cas : ne pas révéler
    // quels identifiants existent.
    if (!user) {
      return NextResponse.json({ error: 'Identifiant ou mot de passe incorrect' }, { status: 401 });
    }

    if (!user.isActive) {
      return NextResponse.json(
        { error: 'Ce compte est désactivé. Contactez un administrateur.' },
        { status: 403 },
      );
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: 'Identifiant ou mot de passe incorrect' }, { status: 401 });
    }

    // Migration silencieuse des empreintes héritées (SHA-256 → scrypt).
    await upgradePasswordHashIfLegacy(user.id, password, user.passwordHash);
    await touchLastLogin(user.id);

    const sessionUser = {
      id: user.id,
      name: user.name,
      username: user.username,
      role: (user.role ?? 'seller') as Role,
    };

    await writeAudit({ user: sessionUser, action: 'login', entity: 'user', entityId: user.id });

    return await createSessionResponse(sessionUser);
  } catch (error: any) {
    console.error('[auth] Erreur de connexion :', error?.message ?? error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
