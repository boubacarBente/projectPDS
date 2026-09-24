import { fail, ok, requireAction } from '@/lib/api';
import { db, rawRun } from '@/db';
import { devices, syncOutbox, syncPending, syncState } from '@/db/schema';
import { getDeviceId, getSyncQueueStatus } from '@/lib/sync';
import { getSettings } from '@/lib/settings';

/**
 * GET /api/sync/status — état de la synchronisation **locale** (§23.10).
 *
 * ⚠️ `components/sync-indicator.tsx` appelle déjà cette route et attend
 * exactement `{ mode, online, pending, failed, lastSyncAt }` : ces clés sont
 * donc **stables**. Les autres (`pendingQuarantine`, `deviceId`, `deviceName`,
 * `outbox`, `devices`) sont additives.
 *
 * Aucun appel réseau n'est effectué : « en ligne » signifie ici « une adresse
 * d'API est configurée **et** la synchronisation n'est pas désactivée ». Il n'y
 * a pas de serveur à interroger, et prétendre le contraire serait un mensonge
 * d'interface.
 */
export async function GET() {
  try {
    await requireAction('sync.manage');

    const settings = await getSettings();
    const deviceId = await getDeviceId();
    const queue = await getSyncQueueStatus();

    /* File d'attente : les dernières lignes, avec leurs essais et leur erreur. */
    let outbox: {
      id: number;
      tableName: string;
      syncId: string;
      operation: string;
      attempts: number;
      lastAttemptAt: Date | null;
      lastError: string | null;
      createdAt: Date | null;
    }[] = [];

    let pendingQuarantine = 0;
    let pendingPreview: {
      id: number;
      tableName: string;
      syncId: string;
      missingParent: string | null;
      attempts: number;
      lastError: string | null;
      createdAt: Date | null;
    }[] = [];

    let devicesList: {
      deviceId: string;
      name: string;
      isCurrent: boolean;
      lastSeenAt: Date | null;
      lastPushAt: Date | null;
      lastPullAt: Date | null;
    }[] = [];

    let lastSyncAt: string | null = null;
    let lastSyncError: string | null = null;
    const tableState: { key: string; value: string | null; updatedAt: Date | null }[] = [];

    try {
      const rows = await db.select().from(syncOutbox).orderBy(syncOutbox.id);
      outbox = rows.slice(-50).reverse().map((row) => ({
        id: row.id,
        tableName: row.tableName,
        syncId: row.syncId,
        operation: row.operation,
        attempts: row.attempts,
        lastAttemptAt: row.lastAttemptAt,
        lastError: row.lastError,
        createdAt: row.createdAt,
      }));
    } catch {
      outbox = [];
    }

    try {
      const quarantine = await db.select().from(syncPending).orderBy(syncPending.id);
      pendingQuarantine = quarantine.length;
      pendingPreview = quarantine.slice(-25).reverse().map((row) => ({
        id: row.id,
        tableName: row.tableName,
        syncId: row.syncId,
        missingParent: row.missingParent,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt,
      }));
    } catch {
      pendingQuarantine = 0;
    }

    try {
      const rows = await db.select().from(devices).orderBy(devices.id);
      devicesList = rows.map((row) => ({
        deviceId: row.deviceId,
        name: row.name,
        isCurrent: row.isCurrent,
        lastSeenAt: row.lastSeenAt,
        lastPushAt: row.lastPushAt,
        lastPullAt: row.lastPullAt,
      }));
    } catch {
      devicesList = [];
    }

    try {
      const state = await db.select().from(syncState).orderBy(syncState.key);
      for (const row of state) {
        tableState.push({ key: row.key, value: row.value, updatedAt: row.updatedAt });
        if (row.key === 'last_sync_at' && row.value) lastSyncAt = row.value;
        if (row.key === 'last_sync_error' && row.value) lastSyncError = row.value;
      }
    } catch {
      /* `sync_state` absente : l'écran s'affiche quand même */
    }

    /* Marque le poste courant comme vu — l'écran est la preuve d'activité. */
    try {
      await rawRun(
        `INSERT INTO devices (device_id, name, is_current, last_seen_at, created_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET is_current = 1, last_seen_at = excluded.last_seen_at`,
        [deviceId, settings.companyBranch || 'Poste local', Date.now(), Date.now()],
      );
    } catch {
      /* sans conséquence : la table n'existe pas encore sur une base neuve */
    }

    const mode = settings.syncMode;
    const online = mode !== 'off' && Boolean(settings.syncApiUrl?.trim());

    return ok({
      /* Contrat stable attendu par `sync-indicator.tsx`. */
      mode,
      online,
      pending: queue.pending,
      failed: queue.failed,
      lastSyncAt,

      /* Informations complémentaires de l'écran `/synchronisation`. */
      lastSyncError,
      pendingQuarantine,
      pendingPreview,
      queued: queue.pending + queue.failed,
      oldestPendingAt: queue.oldestAt,
      deviceId,
      deviceName: settings.companyBranch || 'Poste local',
      apiUrl: settings.syncApiUrl ?? '',
      intervalMinutes: settings.syncIntervalMinutes,
      numberBlockSize: settings.syncNumberBlockSize,
      outbox,
      devices: devicesList,
      state: tableState,
      /** Rappel explicite : aucune synchronisation ne dépend de ce service. */
      message:
        mode === 'off'
          ? 'Synchronisation désactivée : l’application fonctionne normalement, en local uniquement.'
          : online
            ? 'Une adresse d’API est configurée. Aucun service en ligne n’est déployé : la synchronisation réelle échouera et la file restera locale.'
            : 'Synchronisation active mais aucune adresse d’API configurée : rien ne peut être envoyé.',
    });
  } catch (error) {
    return fail(error);
  }
}
