import { NextResponse } from 'next/server';
import { createUser, hasAdminUser } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { createSessionResponse } from '@/lib/session';
import { ensureDefaultSettings } from '@/lib/settings';
import { countStores, createStore, listStores, userStoreSyncId } from '@/lib/stores';
import { db } from '@/db';
import { userStores } from '@/db/schema';

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

/**
 * POST /api/auth/setup — crée le premier administrateur, puis ouvre la session.
 * Ce premier compte est le **super administrateur** (README §17.2) : le seul
 * qui commande les autres administrateurs, et que personne ne peut désactiver.
 */
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

    const user = await createUser({ name, username, password, role: 'admin', isSuperAdmin: true });

    // Les valeurs par défaut des paramètres sont écrites au premier lancement.
    await ensureDefaultSettings();

    // Premier magasin (§18) : créé avec l'administrateur si la base n'en a aucun.
    // Une base migrée depuis la v1.3 a déjà son « Magasin principal ».
    if ((await countStores()) === 0) {
      await createStore(
        {
          code: String(body?.storeCode ?? 'PRINC').trim() || 'PRINC',
          name: String(body?.storeName ?? '').trim() || 'Magasin principal',
          kind: body?.storeKind === 'headquarters' ? 'headquarters' : 'store',
        },
        { id: user.id, name: user.name },
      );
    }
    const firstStore = (await listStores())[0] ?? null;
    if (firstStore) {
      await db
        .insert(userStores)
        .values({
          userId: user.id,
          storeId: firstStore.id,
          isManager: true,
          isActive: true,
          syncId: await userStoreSyncId(user.id, firstStore.id),
        })
        .onConflictDoNothing();
    }

    const sessionUser = {
      id: user.id,
      name: user.name,
      username: user.username,
      role: 'admin' as const,
      isSuperAdmin: true,
    };

    await writeAudit({
      user: sessionUser,
      action: 'create',
      entity: 'user',
      entityId: user.id,
      details: { role: 'admin', superAdmin: true, raison: 'Premier administrateur (super administrateur)' },
    });

    return await createSessionResponse(sessionUser, 201, { storeId: firstStore?.id ?? null });
  } catch (error: any) {
    console.error('[auth] Erreur de setup :', error?.message ?? error);
    return NextResponse.json({ error: error?.message ?? 'Erreur serveur' }, { status: 500 });
  }
}
