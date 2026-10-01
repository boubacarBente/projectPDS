import { NextRequest, NextResponse } from 'next/server';
import { rawGet, rawRun } from '@/db';
import { getUserByUsername, touchLastLogin, upgradePasswordHashIfLegacy, verifyPassword } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { createSessionResponse } from '@/lib/session';
import { getEffectivePermissions } from '@/lib/user-permissions';
import { getAccessibleStoreIds, listStores } from '@/lib/stores';
import type { Role } from '@/lib/permissions';

/**
 * POST /api/auth/login
 *
 * - aucun compte codé en dur (README §3.4) ;
 * - l'identifiant est **insensible à la casse** (« Admin » = « admin ») ;
 * - **protection contre les essais répétés** (§19.3) : après 5 échecs, le
 *   compte est verrouillé 5 minutes ;
 * - à la connexion, on détermine les magasins accessibles : un seul → il
 *   devient le magasin actif ; plusieurs → l'écran propose de choisir.
 */

const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

async function registerFailure(username: string): Promise<void> {
  const now = Date.now();
  const row = await rawGet<{ failures: number }>(
    `SELECT failures FROM login_attempts WHERE username = ?`,
    [username],
  );
  const failures = Number(row?.failures ?? 0) + 1;
  await rawRun(
    `INSERT INTO login_attempts (username, failures, locked_until, last_failure_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET failures = excluded.failures,
       locked_until = excluded.locked_until, last_failure_at = excluded.last_failure_at`,
    [
      username,
      failures,
      failures >= MAX_FAILURES ? Math.floor((now + LOCK_MS) / 1000) : null,
      Math.floor(now / 1000),
    ],
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const username = String(body?.username ?? body?.name ?? '')
      .trim()
      .toLowerCase();
    const password = String(body?.password ?? '');

    if (!username || !password) {
      return NextResponse.json(
        { error: "Nom d'utilisateur et mot de passe requis" },
        { status: 400 },
      );
    }

    const attempt = await rawGet<{ locked_until: number | null }>(
      `SELECT locked_until FROM login_attempts WHERE username = ?`,
      [username],
    ).catch(() => undefined);
    if (attempt?.locked_until && Number(attempt.locked_until) * 1000 > Date.now()) {
      const minutes = Math.ceil((Number(attempt.locked_until) * 1000 - Date.now()) / 60000);
      return NextResponse.json(
        { error: `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.` },
        { status: 429 },
      );
    }

    const user = await getUserByUsername(username);

    // Message volontairement identique dans les deux cas.
    if (!user) {
      await registerFailure(username);
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
      await registerFailure(username);
      return NextResponse.json({ error: 'Identifiant ou mot de passe incorrect' }, { status: 401 });
    }

    await rawRun(`DELETE FROM login_attempts WHERE username = ?`, [username]).catch(() => {});
    await upgradePasswordHashIfLegacy(user.id, password, user.passwordHash);
    await touchLastLogin(user.id);

    const role = (user.role ?? 'seller') as Role;
    const permissions = await getEffectivePermissions({ id: user.id, role });
    const viewAll = role === 'admin' || permissions.includes('stores.viewAll');
    const { ids } = await getAccessibleStoreIds({ id: user.id, role }, viewAll);

    if (ids.length === 0 && role !== 'admin') {
      return NextResponse.json(
        {
          error:
            'Aucun magasin ne vous est affecté sur ce poste. Demandez à l’administrateur de vous affecter à un magasin.',
        },
        { status: 403 },
      );
    }

    const stores = ids.length > 0 ? await listStores({ ids }) : [];
    const sessionUser = { id: user.id, name: user.name, username: user.username, role };

    await writeAudit({
      user: sessionUser,
      storeId: ids.length === 1 ? ids[0] : null,
      action: 'login',
      entity: 'user',
      entityId: user.id,
    });

    return await createSessionResponse(sessionUser, 200, {
      storeId: ids[0] ?? null,
      extra: {
        stores: stores.map((s) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind, status: s.status })),
        // Plusieurs magasins : l'écran de connexion propose le choix du contexte (§5).
        needsStoreChoice: ids.length > 1,
      },
    });
  } catch (error: any) {
    console.error('[auth] Erreur de connexion :', error?.message ?? error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
