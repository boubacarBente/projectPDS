import { fail, ok, requireUser } from '@/lib/api';
import { can } from '@/lib/permissions';
import { getSyncStatus, listConflicts, listQuarantine } from '@/lib/sync-engine';

/**
 * GET /api/sync/status — état de la synchronisation de ce poste.
 *
 * Tout utilisateur connecté reçoit l'état **résumé** (indicateur de la
 * sidebar) : mode du poste, nombre de changements en attente, dernière
 * réussite, présence d'une erreur. Le détail (configuration, conflits,
 * quarantaine) est réservé à `sync.manage`.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const status = await getSyncStatus();

    if (!can(user, 'sync.manage', user.permissions)) {
      return ok({
        mode: status.device.mode,
        connected: Boolean(status.device.serverUrl && status.device.token),
        pending: status.pending,
        conflicts: status.conflicts,
        lastSuccessAt: status.lastSuccessAt,
        hasError: Boolean(status.lastError),
      });
    }

    const [conflicts, quarantine] = await Promise.all([
      listConflicts({ status: 'pending', limit: 50 }),
      listQuarantine(50),
    ]);
    return ok({
      ...status,
      mode: status.device.mode,
      connected: Boolean(status.device.serverUrl && status.device.token),
      hasError: Boolean(status.lastError),
      conflictsList: conflicts,
      quarantineList: quarantine,
    });
  } catch (error) {
    return fail(error);
  }
}
