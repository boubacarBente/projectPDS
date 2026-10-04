import { fail, ok, readJson, requireUser, ForbiddenStoreError } from '@/lib/api';
import { setSessionStore } from '@/lib/session';
import { writeAudit } from '@/lib/audit';
import { getStore } from '@/lib/stores';

class SwitchForbiddenError extends Error {
  readonly status = 403;
  constructor() {
    super(
      'Vous n’avez pas le droit de changer de magasin : vous travaillez dans votre magasin principal. Demandez à l’administrateur la permission « Changer de magasin actif ».',
    );
    this.name = 'SwitchForbiddenError';
  }
}

/**
 * POST /api/auth/store — changer de magasin actif (§5, §20).
 *
 * Le magasin demandé n'est **jamais** accepté aveuglément : il doit figurer
 * parmi les magasins accessibles de l'utilisateur sur ce poste, **et**
 * l'utilisateur doit détenir `stores.switch` pour quitter son magasin
 * principal (README §28.6). Re-choisir son magasin actuel reste permis.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await readJson<{ storeId?: unknown }>(request);
    const storeId = Number(body.storeId);

    if (!Number.isInteger(storeId) || !user.storeIds.includes(storeId)) {
      throw new ForbiddenStoreError();
    }
    if (storeId !== user.storeId && !user.permissions.includes('stores.switch')) {
      throw new SwitchForbiddenError();
    }

    await setSessionStore(user.sessionId, storeId);
    const store = await getStore(storeId);

    if (storeId !== user.storeId) {
      await writeAudit({
        user,
        storeId,
        action: 'update',
        entity: 'session_store',
        entityId: storeId,
        details: { de: user.storeId, vers: storeId, magasin: store?.name ?? null },
      });
    }

    return ok({ activeStoreId: storeId, store });
  } catch (error) {
    return fail(error);
  }
}
