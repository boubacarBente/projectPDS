import { fail, ok, readJson, requireAction, ValidationError } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getStore } from '@/lib/stores';
import { createEnrollmentCode } from '@/lib/sync-engine';

/** POST /api/sync/codes `{ storeId }` — code d'inscription d'un poste de magasin (siège uniquement). */
export async function POST(request: Request) {
  try {
    const user = await requireAction('stores.manage');
    const body = await readJson<{ storeId?: unknown }>(request);
    const store = await getStore(Number(body.storeId));
    if (!store) throw new ValidationError('Magasin introuvable');
    const result = await createEnrollmentCode(store.syncId, store.name);
    await writeAudit({ user, storeId: store.id, action: 'create', entity: 'device', details: { code: 'généré', magasin: store.name } });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
