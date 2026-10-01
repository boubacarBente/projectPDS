/**
 * Planificateur des tâches de fond (voir `instrumentation.ts`).
 */

let started = false;
let lastBackupCheck = 0;
let lastSync = 0;
let lastReportCheck = 0;
let busy = false;

const MINUTE = 60_000;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const { getSettings } = await import('@/lib/settings');
    const settings = await getSettings();

    // Sauvegarde quotidienne : vérifiée toutes les heures (et au démarrage).
    if (now - lastBackupCheck >= 60 * MINUTE) {
      lastBackupCheck = now;
      const { ensureDailyBackup } = await import('@/lib/backup');
      const result = await ensureDailyBackup({
        enabled: settings.autoBackupEnabled,
        retentionDays: settings.backupRetentionDays,
        externalDir: settings.backupExternalDir,
      });
      if (result.created) console.log('[scheduler] Sauvegarde du jour :', result.created);
      if (result.externalError) console.warn('[scheduler] Copie externe impossible :', result.externalError);
    }

    // Synchronisation automatique.
    const { getDeviceConfig } = await import('@/lib/device');
    const device = await getDeviceConfig();
    if (device.mode !== 'standalone' && device.token && device.autoSyncMinutes > 0) {
      if (now - lastSync >= device.autoSyncMinutes * MINUTE) {
        lastSync = now;
        const { syncNow } = await import('@/lib/sync-engine');
        const result = await syncNow();
        if (!result.ok) console.warn('[scheduler] Synchronisation :', result.error);
      }
    }

    // Rapports automatiques : vérifiés toutes les 5 minutes.
    if (now - lastReportCheck >= 5 * MINUTE) {
      lastReportCheck = now;
      const { runScheduledReports } = await import('@/lib/report-sender');
      const result = await runScheduledReports();
      if (result.sent) console.log('[scheduler] Rapport automatique envoyé');
    }
  } catch (error) {
    console.error('[scheduler] Tâche de fond en échec :', error);
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  if (started) return;
  started = true;
  // Premier passage 20 s après le démarrage : la fenêtre s'affiche d'abord.
  setTimeout(() => void tick(), 20_000);
  setInterval(() => void tick(), MINUTE).unref?.();
}
