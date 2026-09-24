import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getUserById } from '@/lib/auth';
import { getEffectivePermissions } from '@/lib/user-permissions';

/**
 * GET /api/auth/me
 *
 * Relit l'utilisateur depuis la base plutôt que de faire confiance au cookie :
 * un compte désactivé pendant la session perd immédiatement ses accès.
 *
 * Renvoie aussi les **permissions effectives** (matrice du rôle **puis**
 * surcharges par utilisateur). Le navigateur s'en sert pour filtrer le menu et
 * masquer les actions ; le serveur applique la même règle de son côté, car
 * masquer n'est pas protéger.
 */
export async function GET() {
  const cookieStore = await cookies();
  const raw = cookieStore.get('session_user')?.value;

  if (!raw) {
    return NextResponse.json({ user: null, permissions: [] }, { status: 401 });
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.id) {
      return NextResponse.json({ user: null, permissions: [] }, { status: 401 });
    }

    const fresh = await getUserById(Number(parsed.id));

    if (!fresh || !fresh.isActive) {
      return NextResponse.json({ user: null, permissions: [] }, { status: 401 });
    }

    const permissions = await getEffectivePermissions({ id: fresh.id, role: fresh.role });

    return NextResponse.json({
      user: {
        id: fresh.id,
        name: fresh.name,
        username: fresh.username,
        role: fresh.role,
      },
      permissions,
    });
  } catch (error) {
    console.error('[auth] /me a échoué :', error);
    return NextResponse.json({ user: null, permissions: [] }, { status: 401 });
  }
}
