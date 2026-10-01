import { fail, ok, requireUser } from '@/lib/api';
import { syncNow } from '@/lib/sync-engine';

/**
 * POST /api/sync/now — lance un cycle envoi + réception.
 *
 * Tout utilisateur connecté peut déclencher la synchronisation (c'est sans
 * risque : elle ne fait que transmettre ce qui est déjà enregistré).
 */
export async function POST() {
  try {
    await requireUser();
    const result = await syncNow();
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
