import { NextResponse } from 'next/server';
import { createUser, hasAdminUser } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { createSessionResponse } from '@/lib/session';
import { ensureDefaultSettings } from '@/lib/settings';

/** GET /api/auth/setup — l'installation du premier administrateur est-elle requise ? */
export async function GET() {
  try {
    const exists = await hasAdminUser();
    return NextResponse.json({ needsSetup: !exists });
  } catch (error: any) {
    console.error('[auth] Vérification du setup impossible :', error?.message ?? error);
    // En cas de doute on propose le setup : mieux vaut un écran de création
    // qu'une application inaccessible.
    return NextResponse.json({ needsSetup: true, warning: 'Vérification impossible' });
  }
}

/** POST /api/auth/setup — crée le premier administrateur, puis ouvre la session. */
export async function POST(request: Request) {
  try {
    if (await hasAdminUser()) {
      return NextResponse.json({ error: 'Un administrateur existe déjà' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const name = String(body?.name ?? '').trim();
    const username = String(body?.username ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');

    if (!name || !username || !password) {
      return NextResponse.json(
        { error: 'Nom, identifiant et mot de passe sont requis' },
        { status: 400 },
      );
    }

    if (!/^[a-z0-9._-]{3,}$/.test(username)) {
      return NextResponse.json(
        {
          error:
            "L'identifiant doit contenir au moins 3 caractères (lettres minuscules, chiffres, « . », « _ » ou « - »)",
        },
        { status: 400 },
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Le mot de passe doit contenir au moins 6 caractères' },
        { status: 400 },
      );
    }

    const user = await createUser({ name, username, password, role: 'admin' });

    // Les valeurs par défaut des paramètres sont écrites au premier lancement.
    await ensureDefaultSettings();

    const sessionUser = {
      id: user.id,
      name: user.name,
      username: user.username,
      role: 'admin' as const,
    };

    await writeAudit({
      user: sessionUser,
      action: 'create',
      entity: 'user',
      entityId: user.id,
      details: { role: 'admin', raison: 'Premier administrateur' },
    });

    return await createSessionResponse(sessionUser, 201);
  } catch (error: any) {
    console.error('[auth] Erreur de setup :', error?.message ?? error);
    return NextResponse.json({ error: error?.message ?? 'Erreur serveur' }, { status: 500 });
  }
}
