/**
 * Socle de synchronisation PostgreSQL (option, README §23).
 *
 * Cette couche est **inerte** tant que `sync_mode = 'off'` : elle ne fait
 * qu'alimenter la file d'attente locale (`sync_outbox`). Aucune opération
 * métier ne dépend d'elle, et une écriture ne doit **jamais** échouer parce que
 * la synchronisation est indisponible (§26.13).
 */

import { db, rawRun } from '@/db';
import { syncOutbox, syncState, devices } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Les 30 tables métier, dans l'ordre **topologique** imposé par §23.4 :
 * un enfant ne peut pas être écrit avant son parent.
 */
export const SYNC_ORDER = [
  'categories',
  'products',
  'customers',
  'suppliers',
  'workers',
  'users',
  'settings',
  'sales_invoices',
  'sales_invoice_items',
  'purchase_invoices',
  'purchase_invoice_items',
  'payments',
  'cash_sessions',
  'cash_movements',
  'stock_movements',
  'expenses',
  'audit_logs',
  'service_jobs',
  'service_job_materials',
  'service_job_workers',
  'brick_types',
  'brick_productions',
  'brick_production_materials',
  'brick_production_workers',
  'furniture_models',
  'furniture_model_materials',
  'furniture_orders',
  'furniture_order_materials',
  'furniture_order_workers',
  'report_deliveries',
] as const;

export type SyncedTable = (typeof SYNC_ORDER)[number];

/** Tableaux append-only : aucun conflit possible (§23.7). */
export const APPEND_ONLY_TABLES: SyncedTable[] = [
  'stock_movements',
  'payments',
  'audit_logs',
  'report_deliveries',
];

let cachedDeviceId: string | null = null;

/**
 * Identifiant du poste, généré à la première utilisation puis persisté dans
 * `settings.sync_device_id`. Il sert de `origin_device_id` sur chaque ligne.
 */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    const row = await db
      .select()
      .from(syncState)
      .where(eq(syncState.key, 'device_id'))
      .limit(1);

    if (row[0]?.value) {
      cachedDeviceId = row[0].value;
      return cachedDeviceId;
    }

    const generated = `poste-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .insert(syncState)
      .values({ key: 'device_id', value: generated })
      .onConflictDoUpdate({ target: syncState.key, set: { value: generated } });

    await rawRun(
      `INSERT INTO settings (key, value, updated_at, sync_id)
       VALUES ('sync_device_id', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [generated, Date.now(), crypto.randomUUID()],
    );

    cachedDeviceId = generated;
    return generated;
  } catch {
    // La table n'existe pas encore (avant migration) : identifiant éphémère.
    cachedDeviceId = `poste-${crypto.randomUUID().slice(0, 8)}`;
    return cachedDeviceId;
  }
}

/** Réinitialise le cache après un changement d'appareil (import, restauration). */
export function resetDeviceIdCache(): void {
  cachedDeviceId = null;
}

/**
 * Enregistre une écriture dans la file d'envoi.
 *
 * Appelée par **toutes** les fonctions d'écriture de `lib/` (règle 13) : c'est
 * ce qui garantit qu'aucun changement n'est perdu. Une erreur ici est
 * journalisée mais **ne remonte jamais** à l'appelant : l'opération métier est
 * déjà validée.
 */
export async function enqueueSyncWrite(
  table: SyncedTable | string,
  syncId: string | null | undefined,
  operation: 'insert' | 'update' | 'delete',
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(syncOutbox).values({
      tableName: table,
      syncId: syncId ?? crypto.randomUUID(),
      operation,
      payload: JSON.stringify(payload),
    });
  } catch (error) {
    console.error(`[sync] Mise en file impossible (${table}, ${operation}) :`, error);
  }
}

/** État d'envoi de la file, pour l'écran `/synchronisation`. */
export async function getSyncQueueStatus(): Promise<{
  pending: number;
  failed: number;
  oldestAt: Date | null;
}> {
  try {
    const rows = await db.select().from(syncOutbox);
    const failed = rows.filter((r) => r.attempts >= 5).length;
    const oldest = rows.reduce<Date | null>((acc, r) => {
      if (!r.createdAt) return acc;
      if (!acc || r.createdAt < acc) return acc;
      return acc;
    }, null);
    return { pending: rows.length - failed, failed, oldestAt: oldest };
  } catch {
    return { pending: 0, failed: 0, oldestAt: null };
  }
}

/** Enregistre / met à jour le poste courant dans `devices`. */
export async function registerCurrentDevice(name: string): Promise<void> {
  try {
    const deviceId = await getDeviceId();
    await db
      .insert(devices)
      .values({ deviceId, name, isCurrent: true, lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: devices.deviceId,
        set: { name, isCurrent: true, lastSeenAt: new Date() },
      });
  } catch (error) {
    console.error('[sync] Enregistrement du poste impossible :', error);
  }
}

/** Vrai si la synchronisation est active (mode A ou B). */
export async function isSyncEnabled(): Promise<boolean> {
  try {
    const row = await db.select().from(syncState).where(eq(syncState.key, 'mode')).limit(1);
    return row[0]?.value === 'backup' || row[0]?.value === 'multi';
  } catch {
    return false;
  }
}
