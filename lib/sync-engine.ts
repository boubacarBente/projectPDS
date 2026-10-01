/**
 * Moteur de synchronisation (option B : base locale par poste + serveur
 * central PostgreSQL). Voir `server/` pour le service central.
 *
 * Principes :
 *
 *  1. **Capture fiable** : les triggers SQLite (`db/triggers.ts`) inscrivent
 *     chaque ligne modifiée dans `sync_changes`. Aucune écriture n'échappe.
 *  2. **Identité globale** : une ligne voyage avec son `sync_id` (UUID), jamais
 *     avec son `id` local. Les clés étrangères sont traduites en `sync_id` à
 *     l'envoi, puis retraduites en `id` local à la réception.
 *  3. **Idempotence** : renvoyer deux fois la même ligne ne crée jamais de
 *     doublon (le serveur et les postes indexent par `sync_id`).
 *  4. **Conflits** : dernière écriture gagnante, arbitrée par `updated_at`
 *     (côté serveur à l'envoi, côté poste à la réception). Chaque conflit est
 *     consigné dans `sync_conflicts` pour être consultable.
 *  5. **Stocks sans conflit** : la quantité en stock n'est jamais « écrasée » par
 *     un autre poste — elle est recalculée depuis les mouvements reçus.
 *  6. **Numérotation sans collision** : chaque poste a un numéro (`device_code`)
 *     inclus dans les numéros de pièces (`FAC-KAL3-…`).
 *  7. **Quarantaine** : une ligne dont le parent n'est pas encore arrivé attend
 *     dans `sync_pending` et est réessayée après chaque réception.
 *  8. **Jamais bloquant** : une panne réseau n'empêche aucune opération ; la
 *     file attend simplement la prochaine synchronisation.
 */

import { dbClient, rawAll, rawGet, rawRun, withTransaction } from '@/db';
import { SYNCED_TABLES, syncedTable, type SyncedTable } from '@/db/sync-registry';
import { getDeviceConfig, setDeviceConfig, type DeviceConfig } from '@/lib/device';
import { LOCAL_ONLY_SETTINGS_KEYS, toDbKey } from '@/lib/settings-schema';
import { recomputeStocks } from '@/lib/stock';

const PUSH_BATCH = 200;
const PULL_BATCH = 500;
const HTTP_TIMEOUT_MS = 30_000;

export class SyncError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Introspection du schéma local
 * ------------------------------------------------------------------ */

type ForeignKey = { column: string; parent: string };
type TableMeta = { columns: string[]; foreignKeys: ForeignKey[] };

const metaCache = new Map<string, TableMeta>();

async function tableMeta(table: string): Promise<TableMeta> {
  const cached = metaCache.get(table);
  if (cached) return cached;
  const columns = (await rawAll<{ name: string }>(`PRAGMA table_info("${table}")`)).map((c) => String(c.name));
  const fks = (await rawAll<{ table: string; from: string }>(`PRAGMA foreign_key_list("${table}")`)).map((f) => ({
    column: String(f.from),
    parent: String(f.table),
  }));
  // `store_id` sans clé déclarée (journal d'audit) : on la traite comme une référence.
  for (const column of columns) {
    if ((column === 'store_id' || column.endsWith('_store_id')) && !fks.some((f) => f.column === column)) {
      fks.push({ column, parent: 'stores' });
    }
  }
  const meta = { columns, foreignKeys: fks };
  metaCache.set(table, meta);
  return meta;
}

/** Normalise un horodatage en millisecondes (les colonnes Drizzle sont en secondes). */
function toMillis(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 100_000_000_000 ? n * 1000 : n;
}

async function syncIdOf(table: string, id: unknown, cache: Map<string, string | null>): Promise<string | null> {
  if (id === null || id === undefined || id === '') return null;
  const key = `${table}:${id}`;
  if (cache.has(key)) return cache.get(key)!;
  const row = await rawGet<{ sync_id: string }>(`SELECT sync_id FROM "${table}" WHERE id = ?`, [Number(id)]);
  const value = row?.sync_id ?? null;
  cache.set(key, value);
  return value;
}

async function localIdOf(table: string, syncId: unknown, cache: Map<string, number | null>): Promise<number | null> {
  if (syncId === null || syncId === undefined || syncId === '') return null;
  const key = `${table}:${syncId}`;
  if (cache.has(key)) return cache.get(key)!;
  const row = await rawGet<{ id: number }>(`SELECT id FROM "${table}" WHERE sync_id = ?`, [String(syncId)]);
  const value = row ? Number(row.id) : null;
  cache.set(key, value);
  return value;
}

/* ------------------------------------------------------------------ *
 * Sérialisation (envoi)
 * ------------------------------------------------------------------ */

export type WireChange = {
  table: string;
  syncId: string;
  deleted: boolean;
  /** Millisecondes. */
  updatedAt: number;
  /** Portée : référentiel commun. */
  isGlobal: boolean;
  /** Portée : magasin propriétaire (identité globale). */
  storeSyncId: string | null;
  /** Portée : second magasin concerné (destinataire d'un transfert). */
  peerStoreSyncId: string | null;
  payload: Record<string, unknown> | null;
};

/** Portée (magasin propriétaire / destinataire) d'une ligne locale. */
async function scopeOf(
  table: SyncedTable,
  row: Record<string, any>,
  cache: Map<string, string | null>,
): Promise<{ isGlobal: boolean; storeSyncId: string | null; peerStoreSyncId: string | null }> {
  const scope = table.scope;
  if (scope.kind === 'global') return { isGlobal: true, storeSyncId: null, peerStoreSyncId: null };
  if (scope.kind === 'store') {
    return { isGlobal: false, storeSyncId: await syncIdOf('stores', row[scope.column], cache), peerStoreSyncId: null };
  }
  if (scope.kind === 'transfer') {
    return {
      isGlobal: false,
      storeSyncId: await syncIdOf('stores', row.source_store_id, cache),
      peerStoreSyncId: await syncIdOf('stores', row.destination_store_id, cache),
    };
  }
  // Ligne enfant : portée du parent.
  const parentTable = syncedTable(scope.parentTable)!;
  const parent = await rawGet<Record<string, any>>(`SELECT * FROM "${scope.parentTable}" WHERE id = ?`, [
    Number(row[scope.parentColumn]),
  ]);
  if (!parent) return { isGlobal: false, storeSyncId: null, peerStoreSyncId: null };
  return scopeOf(parentTable, parent, cache);
}

/** Ligne locale → représentation réseau (clés étrangères en `sync_id`). */
export async function serializeRow(
  table: SyncedTable,
  row: Record<string, any>,
  cache: Map<string, string | null>,
): Promise<Record<string, unknown>> {
  const meta = await tableMeta(table.name);
  const payload: Record<string, unknown> = {};
  for (const column of meta.columns) {
    if (column === 'id') continue;
    payload[column] = row[column];
  }
  for (const fk of meta.foreignKeys) {
    if (fk.column in payload) payload[fk.column] = await syncIdOf(fk.parent, row[fk.column], cache);
  }
  for (const poly of table.polymorphic ?? []) {
    const target = poly.targets[String(row[poly.typeColumn])];
    payload[poly.idColumn] = target ? await syncIdOf(target, row[poly.idColumn], cache) : null;
  }
  return payload;
}

/** Une ligne de `settings` est-elle propre au poste (thème, passerelle…) ? */
function isLocalSetting(key: unknown): boolean {
  const k = String(key ?? '');
  if (k.startsWith('seq_')) return true;
  return LOCAL_ONLY_SETTINGS_KEYS.some((appKey) => toDbKey(appKey) === k);
}

/* ------------------------------------------------------------------ *
 * Transport HTTP
 * ------------------------------------------------------------------ */

async function call<T>(
  config: Pick<DeviceConfig, 'serverUrl' | 'token'>,
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const base = String(config.serverUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new SyncError('Adresse du serveur non configurée');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const token = init.token === undefined ? config.token : init.token;
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 300) };
    }
    if (!response.ok) {
      throw new SyncError(data?.error ?? `Serveur : erreur ${response.status}`, response.status === 401 ? 401 : 502);
    }
    return data as T;
  } catch (error) {
    if (error instanceof SyncError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new SyncError('Le serveur ne répond pas (délai dépassé). Vérifiez la connexion Internet.', 503);
    }
    throw new SyncError(
      `Serveur injoignable : ${error instanceof Error ? error.message : String(error)}. Les opérations restent enregistrées localement.`,
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * État
 * ------------------------------------------------------------------ */

async function getState(key: string): Promise<string | null> {
  const row = await rawGet<{ value: string | null }>(`SELECT value FROM sync_state WHERE key = ?`, [key]);
  return row?.value ?? null;
}

async function setState(key: string, value: string | null): Promise<void> {
  await rawRun(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value],
  );
}

export type SyncStatus = {
  device: DeviceConfig;
  pending: number;
  failed: number;
  quarantined: number;
  conflicts: number;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  pullSeq: number;
  running: boolean;
};

let running: Promise<SyncResult> | null = null;

export async function getSyncStatus(): Promise<SyncStatus> {
  const device = await getDeviceConfig();
  const counts = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM sync_changes) AS pending,
       (SELECT COUNT(*) FROM sync_changes WHERE attempts > 0) AS failed,
       (SELECT COUNT(*) FROM sync_pending) AS quarantined,
       (SELECT COUNT(*) FROM sync_conflicts WHERE resolution = 'pending') AS conflicts`,
  );
  return {
    device: { ...device, token: device.token ? '••••' : null },
    pending: Number(counts?.pending ?? 0),
    failed: Number(counts?.failed ?? 0),
    quarantined: Number(counts?.quarantined ?? 0),
    conflicts: Number(counts?.conflicts ?? 0),
    lastPushAt: await getState('last_push_at'),
    lastPullAt: await getState('last_pull_at'),
    lastError: await getState('last_error'),
    lastSuccessAt: await getState('last_success_at'),
    pullSeq: Number((await getState('pull_seq')) ?? 0),
    running: running !== null,
  };
}

/* ------------------------------------------------------------------ *
 * Inscription du poste auprès du serveur
 * ------------------------------------------------------------------ */

export type EnrollInput = {
  serverUrl: string;
  deviceName: string;
  /** Poste du siège : clé d'inscription maîtresse du serveur (`ENROLL_MASTER_KEY`). */
  masterKey?: string;
  /** Poste de magasin : code d'inscription à usage unique généré par le siège. */
  code?: string;
};

export async function enrollDevice(input: EnrollInput): Promise<DeviceConfig> {
  const serverUrl = String(input.serverUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(serverUrl)) throw new SyncError('Adresse du serveur invalide (https://…)');
  const deviceName = String(input.deviceName ?? '').trim() || 'Poste';
  if (!input.masterKey && !input.code) throw new SyncError("Saisissez le code d'inscription");

  const current = await getDeviceConfig();
  if (current.mode !== 'standalone' && current.token) {
    throw new SyncError('Ce poste est déjà inscrit. Déconnectez-le avant de l’inscrire à nouveau.');
  }

  const users = await rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM users`);
  const hasData = Number(users?.n ?? 0) > 0;
  if (input.code && hasData) {
    throw new SyncError(
      'Un poste de magasin doit être une installation neuve : cette base contient déjà des données. ' +
        'Inscrivez ce poste comme siège, ou réinstallez l’application sur le poste du magasin.',
    );
  }

  const result = await call<{
    deviceId: string;
    token: string;
    deviceCode: string;
    mode: 'hq' | 'store';
    storeSyncId: string | null;
  }>({ serverUrl, token: null }, '/api/devices/enroll', {
    body: { deviceName, masterKey: input.masterKey, code: input.code },
    token: null,
  });

  const config = await setDeviceConfig({
    mode: result.mode,
    deviceId: result.deviceId,
    deviceName,
    deviceCode: String(result.deviceCode),
    serverUrl,
    token: result.token,
    storeSyncId: result.storeSyncId,
    storeId: null,
  });

  await setState('pull_seq', '0');
  await setState('last_error', null);

  // Un siège qui rejoint le serveur avec ses données les envoie toutes.
  if (hasData) await enqueueFullSnapshot();

  return config;
}

/** Déconnecte le poste du serveur (les données locales sont conservées). */
export async function unenrollDevice(): Promise<DeviceConfig> {
  return setDeviceConfig({ mode: 'standalone', token: null, serverUrl: null, storeId: null, storeSyncId: null });
}

/** Met toutes les lignes existantes dans la file d'envoi (premier envoi d'un siège). */
export async function enqueueFullSnapshot(): Promise<number> {
  let total = 0;
  for (const table of SYNCED_TABLES) {
    const result = await rawRun(
      `INSERT OR IGNORE INTO sync_changes (table_name, sync_id, deleted, change_seq, attempts)
       SELECT ?, sync_id, 0, 0, 0 FROM "${table.name}"`,
      [table.name],
    );
    total += Number(result.rowsAffected ?? 0);
  }
  return total;
}

/** Code d'inscription d'un poste de magasin (généré par le siège). */
export async function createEnrollmentCode(storeSyncId: string, storeName: string): Promise<{ code: string; expiresAt: string }> {
  const config = await getDeviceConfig();
  if (config.mode !== 'hq' || !config.token) {
    throw new SyncError('Seul le poste du siège, inscrit au serveur, peut générer un code d’inscription.');
  }
  return call(config, '/api/admin/enroll-codes', { body: { storeSyncId, storeName } });
}

export async function listServerDevices(): Promise<any[]> {
  const config = await getDeviceConfig();
  if (config.mode !== 'hq' || !config.token) return [];
  const result = await call<{ devices: any[] }>(config, '/api/admin/devices');
  return result.devices ?? [];
}

export async function revokeServerDevice(deviceId: string): Promise<void> {
  const config = await getDeviceConfig();
  if (config.mode !== 'hq' || !config.token) throw new SyncError('Réservé au poste du siège');
  await call(config, `/api/admin/devices/${encodeURIComponent(deviceId)}/revoke`, { body: {} });
}

/* ------------------------------------------------------------------ *
 * Envoi
 * ------------------------------------------------------------------ */

type ChangeRow = { table_name: string; sync_id: string; deleted: number; change_seq: number };

async function push(config: DeviceConfig): Promise<{ sent: number; rejected: number }> {
  let sent = 0;
  let rejected = 0;

  for (let round = 0; round < 1000; round += 1) {
    const batch = await rawAll<ChangeRow>(
      `SELECT table_name, sync_id, deleted, change_seq FROM sync_changes
        ORDER BY change_seq ASC LIMIT ? OFFSET ?`,
      [PUSH_BATCH, 0],
    );
    if (batch.length === 0) break;

    const cache = new Map<string, string | null>();
    const changes: (WireChange & { _seq: number })[] = [];
    const dropped: ChangeRow[] = [];

    for (const change of batch) {
      const table = syncedTable(change.table_name);
      if (!table || (table.hqOnly && config.mode === 'store')) {
        dropped.push(change);
        continue;
      }
      const row = change.deleted
        ? null
        : await rawGet<Record<string, any>>(`SELECT * FROM "${table.name}" WHERE sync_id = ?`, [change.sync_id]);

      if (table.name === 'settings' && row && isLocalSetting(row.key)) {
        dropped.push(change);
        continue;
      }

      if (!row) {
        changes.push({
          table: table.name,
          syncId: change.sync_id,
          deleted: true,
          updatedAt: Date.now(),
          isGlobal: table.scope.kind === 'global',
          storeSyncId: null,
          peerStoreSyncId: null,
          payload: null,
          _seq: change.change_seq,
        });
        continue;
      }

      const scope = await scopeOf(table, row, cache);
      changes.push({
        table: table.name,
        syncId: change.sync_id,
        deleted: false,
        updatedAt: toMillis(row.updated_at) || Date.now(),
        ...scope,
        payload: await serializeRow(table, row, cache),
        _seq: change.change_seq,
      });
    }

    for (const change of dropped) {
      await rawRun(`DELETE FROM sync_changes WHERE table_name = ? AND sync_id = ? AND change_seq = ?`, [
        change.table_name,
        change.sync_id,
        change.change_seq,
      ]);
    }
    if (changes.length === 0) continue;

    let response: { accepted: string[]; rejected: { table: string; syncId: string; reason: string; server?: any }[] };
    try {
      response = await call(config, '/api/sync/push', {
        body: { changes: changes.map(({ _seq, ...rest }) => rest) },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const change of changes) {
        await rawRun(
          `UPDATE sync_changes SET attempts = attempts + 1, last_error = ? WHERE table_name = ? AND sync_id = ?`,
          [message, change.table, change.syncId],
        );
      }
      throw error;
    }

    const accepted = new Set(response.accepted ?? []);
    const rejectedMap = new Map((response.rejected ?? []).map((r) => [`${r.table}:${r.syncId}`, r]));
    if (accepted.size === 0 && rejectedMap.size === 0) {
      throw new SyncError('Le serveur n’a acquitté aucune modification : envoi interrompu.', 502);
    }

    for (const change of changes) {
      const key = `${change.table}:${change.syncId}`;
      const refusal = rejectedMap.get(key);
      if (accepted.has(change.syncId) || refusal) {
        // Acquittement conditionnel : une modification survenue pendant l'envoi garde sa place.
        await rawRun(`DELETE FROM sync_changes WHERE table_name = ? AND sync_id = ? AND change_seq = ?`, [
          change.table,
          change.syncId,
          change._seq,
        ]);
      }
      if (accepted.has(change.syncId)) sent += 1;
      if (refusal) {
        rejected += 1;
        await rawRun(
          `INSERT INTO sync_conflicts (table_name, sync_id, local_payload, remote_payload, resolution, created_at)
           VALUES (?, ?, ?, ?, ?, unixepoch())`,
          [
            change.table,
            change.syncId,
            JSON.stringify(change.payload ?? { deleted: true }),
            JSON.stringify(refusal.server ?? { reason: refusal.reason }),
            refusal.reason === 'stale' ? 'remote' : 'pending',
          ],
        );
      }
    }

    if (batch.length < PUSH_BATCH) break;
  }

  await setState('last_push_at', new Date().toISOString());
  return { sent, rejected };
}

/* ------------------------------------------------------------------ *
 * Réception
 * ------------------------------------------------------------------ */

type PulledChange = WireChange & { seq: number };

type ApplyOutcome = 'applied' | 'skipped' | 'pending' | 'conflict';

type ApplyContext = {
  idCache: Map<string, number | null>;
  touchedStock: { storeId: number; productId: number }[];
};

async function applyChange(change: PulledChange, ctx: ApplyContext): Promise<ApplyOutcome> {
  const table = syncedTable(change.table);
  if (!table) return 'skipped';
  const meta = await tableMeta(table.name);

  // Paramètres propres au poste : jamais remplacés par ceux du serveur.
  if (table.name === 'settings' && change.payload && isLocalSetting(change.payload.key)) return 'skipped';

  // Une modification locale plus récente, pas encore envoyée, l'emporte.
  const localPending = await rawGet<{ change_seq: number; deleted: number }>(
    `SELECT change_seq, deleted FROM sync_changes WHERE table_name = ? AND sync_id = ?`,
    [table.name, change.syncId],
  );

  let existing = await rawGet<Record<string, any>>(`SELECT * FROM "${table.name}" WHERE sync_id = ?`, [change.syncId]);

  if (localPending && existing && toMillis(existing.updated_at) > change.updatedAt) {
    return 'skipped';
  }

  if (change.deleted) {
    if (existing) {
      if (table.name === 'stock_movements' && existing.store_id) {
        ctx.touchedStock.push({ storeId: Number(existing.store_id), productId: Number(existing.product_id) });
      }
      await rawRun(`DELETE FROM "${table.name}" WHERE sync_id = ?`, [change.syncId]);
    }
    if (localPending) {
      await rawRun(`DELETE FROM sync_changes WHERE table_name = ? AND sync_id = ?`, [table.name, change.syncId]);
    }
    return 'applied';
  }

  const payload = change.payload ?? {};
  const values: Record<string, unknown> = {};

  for (const [column, value] of Object.entries(payload)) {
    if (column === 'id' || !meta.columns.includes(column)) continue;
    values[column] = value;
  }

  // Traduction des références : `sync_id` → `id` local.
  for (const fk of meta.foreignKeys) {
    if (!(fk.column in values)) continue;
    const ref = values[fk.column];
    if (ref === null || ref === undefined || ref === '') {
      values[fk.column] = null;
      continue;
    }
    const localId = await localIdOf(fk.parent, ref, ctx.idCache);
    if (localId === null) {
      await quarantine(change, `${fk.parent}:${ref}`);
      return 'pending';
    }
    values[fk.column] = localId;
  }
  for (const poly of table.polymorphic ?? []) {
    const target = poly.targets[String(values[poly.typeColumn])];
    const ref = values[poly.idColumn];
    if (!target || ref === null || ref === undefined) continue;
    const localId = await localIdOf(target, ref, ctx.idCache);
    if (localId === null) {
      await quarantine(change, `${target}:${ref}`);
      return 'pending';
    }
    values[poly.idColumn] = localId;
  }

  // Fusion par clé naturelle : une ligne créée hors ligne sur ce poste adopte l'identité reçue.
  if (!existing && table.naturalKey) {
    const conditions = table.naturalKey.map((column) => `"${column}" IS ?`).join(' AND ');
    existing = await rawGet<Record<string, any>>(
      `SELECT * FROM "${table.name}" WHERE ${conditions}`,
      table.naturalKey.map((column) => values[column] as any),
    );
    if (existing) {
      await rawRun(`DELETE FROM sync_changes WHERE table_name = ? AND sync_id = ?`, [table.name, existing.sync_id]);
      ctx.idCache.clear();
    }
  }

  const columns = Object.keys(values);
  try {
    if (existing) {
      const keyColumn = meta.columns.includes('id') ? 'id' : table.naturalKey?.[0] ?? 'sync_id';
      await rawRun(
        `UPDATE "${table.name}" SET ${columns.map((c) => `"${c}" = ?`).join(', ')} WHERE "${keyColumn}" = ?`,
        [...columns.map((c) => values[c] as any), existing[keyColumn]],
      );
    } else {
      await rawRun(
        `INSERT INTO "${table.name}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => values[c] as any),
      );
    }
  } catch (error: any) {
    const message = String(error?.message ?? error);
    if (/UNIQUE constraint failed/i.test(message)) {
      await rawRun(
        `INSERT INTO sync_conflicts (table_name, sync_id, local_payload, remote_payload, resolution, created_at)
         VALUES (?, ?, ?, ?, 'pending', unixepoch())`,
        [table.name, change.syncId, JSON.stringify({ erreur: message }), JSON.stringify(change.payload)],
      );
      return 'conflict';
    }
    throw error;
  }

  if (localPending) {
    await rawRun(`DELETE FROM sync_changes WHERE table_name = ? AND sync_id = ?`, [table.name, change.syncId]);
  }

  if (table.name === 'stock_movements' && values.store_id && values.product_id) {
    ctx.touchedStock.push({ storeId: Number(values.store_id), productId: Number(values.product_id) });
  }
  if (table.name === 'product_stocks' && values.store_id && values.product_id) {
    ctx.touchedStock.push({ storeId: Number(values.store_id), productId: Number(values.product_id) });
  }

  return 'applied';
}

async function quarantine(change: PulledChange, missingParent: string): Promise<void> {
  await rawRun(`DELETE FROM sync_pending WHERE table_name = ? AND sync_id = ?`, [change.table, change.syncId]);
  await rawRun(
    `INSERT INTO sync_pending (table_name, sync_id, payload, missing_parent, attempts, created_at)
     VALUES (?, ?, ?, ?, 0, unixepoch())`,
    [change.table, change.syncId, JSON.stringify(change), missingParent],
  );
}

async function retryQuarantine(ctx: ApplyContext): Promise<number> {
  let resolved = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    const rows = await rawAll<{ id: number; payload: string }>(`SELECT id, payload FROM sync_pending ORDER BY id`);
    if (rows.length === 0) break;
    let progress = 0;
    for (const row of rows) {
      const change = JSON.parse(row.payload) as PulledChange;
      await rawRun(`DELETE FROM sync_pending WHERE id = ?`, [row.id]);
      const outcome = await applyChange(change, ctx);
      if (outcome === 'applied') {
        progress += 1;
        resolved += 1;
      } else if (outcome === 'pending') {
        await rawRun(`UPDATE sync_pending SET attempts = attempts + 1, last_attempt_at = unixepoch() WHERE sync_id = ?`, [
          change.syncId,
        ]);
      }
    }
    if (progress === 0) break;
  }
  return resolved;
}

const TABLE_ORDER = new Map(SYNCED_TABLES.map((t, index) => [t.name, index]));

async function pull(config: DeviceConfig): Promise<{ received: number; applied: number }> {
  let received = 0;
  let applied = 0;

  for (let round = 0; round < 10_000; round += 1) {
    const since = Number((await getState('pull_seq')) ?? 0);
    const response = await call<{ changes: PulledChange[]; maxSeq: number; hasMore: boolean }>(
      config,
      `/api/sync/pull?since=${since}&limit=${PULL_BATCH}`,
    );
    const changes = response.changes ?? [];
    received += changes.length;

    if (changes.length > 0) {
      // Parents avant enfants à l'intérieur du lot.
      const ordered = [...changes].sort(
        (a, b) => (TABLE_ORDER.get(a.table) ?? 99) - (TABLE_ORDER.get(b.table) ?? 99) || a.seq - b.seq,
      );

      const ctx: ApplyContext = { idCache: new Map(), touchedStock: [] };
      await withTransaction(async () => {
        await setState('applying', '1');
        try {
          for (const change of ordered) {
            const outcome = await applyChange(change, ctx);
            if (outcome === 'applied') applied += 1;
          }
          applied += await retryQuarantine(ctx);
          // Stocks : recalculés depuis les mouvements, jamais écrasés.
          await recomputeStocks(ctx.touchedStock);
          await setState('pull_seq', String(response.maxSeq ?? since));
        } finally {
          await setState('applying', '0');
        }
      });
    } else if (response.maxSeq && response.maxSeq > since) {
      await setState('pull_seq', String(response.maxSeq));
    }

    if (!response.hasMore) break;
  }

  await setState('last_pull_at', new Date().toISOString());
  await resolveDeviceStore(config);
  return { received, applied };
}

/** Poste de magasin : retrouve l'identifiant local de son magasin après réception. */
async function resolveDeviceStore(config: DeviceConfig): Promise<void> {
  if (config.mode !== 'store' || !config.storeSyncId || config.storeId) return;
  const row = await rawGet<{ id: number }>(`SELECT id FROM stores WHERE sync_id = ?`, [config.storeSyncId]);
  if (row) await setDeviceConfig({ storeId: Number(row.id) });
}

/* ------------------------------------------------------------------ *
 * Cycle complet
 * ------------------------------------------------------------------ */

export type SyncResult = {
  ok: boolean;
  sent: number;
  rejected: number;
  received: number;
  applied: number;
  error: string | null;
  at: string;
};

/** Envoie puis reçoit. Un seul cycle à la fois sur le poste. */
export async function syncNow(): Promise<SyncResult> {
  if (running) return running;
  running = (async () => {
    const at = new Date().toISOString();
    const config = await getDeviceConfig();
    if (config.mode === 'standalone' || !config.serverUrl || !config.token) {
      return { ok: false, sent: 0, rejected: 0, received: 0, applied: 0, error: 'Poste non relié au serveur', at };
    }
    try {
      const pushed = await push(config);
      const pulled = await pull(config);
      await setState('last_error', null);
      await setState('last_success_at', at);
      return { ok: true, ...pushed, ...pulled, error: null, at };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setState('last_error', message).catch(() => {});
      return { ok: false, sent: 0, rejected: 0, received: 0, applied: 0, error: message, at };
    }
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

/* ------------------------------------------------------------------ *
 * Conflits et quarantaine (écran /synchronisation)
 * ------------------------------------------------------------------ */

export async function listConflicts(options: { status?: 'pending' | 'all'; limit?: number } = {}) {
  const rows = await rawAll<any>(
    `SELECT * FROM sync_conflicts ${options.status === 'all' ? '' : "WHERE resolution = 'pending'"}
      ORDER BY id DESC LIMIT ?`,
    [Math.max(1, Math.min(500, options.limit ?? 100))],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    tableName: String(r.table_name),
    syncId: String(r.sync_id),
    localPayload: safeJson(r.local_payload),
    remotePayload: safeJson(r.remote_payload),
    resolution: String(r.resolution),
    createdAt: r.created_at ? new Date(Number(r.created_at) * 1000).toISOString() : null,
  }));
}

function safeJson(value: unknown) {
  try {
    return JSON.parse(String(value ?? 'null'));
  } catch {
    return value;
  }
}

/**
 * Tranche un conflit : `remote` accepte la version du serveur (déjà appliquée
 * ou à réappliquer au prochain cycle), `local` renvoie la version locale.
 */
export async function resolveConflict(id: number, resolution: 'local' | 'remote', userId: number) {
  const row = await rawGet<any>(`SELECT * FROM sync_conflicts WHERE id = ?`, [id]);
  if (!row) throw new SyncError('Conflit introuvable', 404);
  if (resolution === 'local') {
    // On force le renvoi de la ligne locale avec un horodatage frais.
    const table = syncedTable(String(row.table_name));
    if (table) {
      await rawRun(`UPDATE "${table.name}" SET updated_at = unixepoch() WHERE sync_id = ?`, [row.sync_id]).catch(() => {});
    }
  } else {
    // On redemandera tout au serveur au prochain cycle pour réappliquer sa version.
    await setState('pull_seq', '0');
  }
  await rawRun(`UPDATE sync_conflicts SET resolution = ?, resolved_at = unixepoch(), resolved_by = ? WHERE id = ?`, [
    resolution,
    userId,
    id,
  ]);
}

export async function listQuarantine(limit = 100) {
  const rows = await rawAll<any>(`SELECT * FROM sync_pending ORDER BY id DESC LIMIT ?`, [limit]);
  return rows.map((r) => ({
    id: Number(r.id),
    tableName: String(r.table_name),
    syncId: String(r.sync_id),
    missingParent: r.missing_parent ?? null,
    attempts: Number(r.attempts ?? 0),
    createdAt: r.created_at ? new Date(Number(r.created_at) * 1000).toISOString() : null,
  }));
}

/** Pour les tests : vide le cache d'introspection. */
export function resetSyncCaches() {
  metaCache.clear();
}

export { dbClient };
