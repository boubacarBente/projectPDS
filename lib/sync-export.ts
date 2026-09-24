/**
 * Export / import manuel d'un paquet `.json` (README §23.10, « dépannage sans
 * réseau »).
 *
 * **Le service PostgreSQL en ligne n'existe pas.** Ce module ne fait donc
 * aucun appel réseau : il produit un **fichier transportable** (clé USB, envoi
 * différé) et sait en appliquer un. C'est le repli honnête du mode A comme du
 * mode B, et il fonctionne avec `sync_mode = 'off'`.
 *
 * Trois invariants sont respectés à l'identique de la synchronisation en ligne :
 *
 *  1. **Ordre topologique** : les tables sont écrites dans l'ordre de
 *     `SYNC_ORDER` de `lib/sync.ts`, un enfant ne peut donc jamais précéder son
 *     parent (§23.4).
 *  2. **Références par `sync_id`, jamais par `id` local** (§11 règle 3) : une
 *     référence parente introuvable envoie la ligne en **quarantaine** dans
 *     `sync_pending` — jamais perdue, rejouable.
 *  3. **Aucun écrasement silencieux** : un conflit réel (modification locale
 *     plus récente que la version reçue) crée une ligne dans `sync_conflicts`
 *     au lieu d'écraser (§23.7).
 *
 * Ce fichier est **serveur** : il ne doit jamais être importé à l'exécution par
 * un composant client (CONVENTIONS.md §11 bis).
 */

import { db, rawAll, rawGet, rawRun } from '@/db';
import { syncConflicts, syncPending } from '@/db/schema';
import { APPEND_ONLY_TABLES, SYNC_ORDER, getDeviceId, type SyncedTable } from '@/lib/sync';
import { ValidationError } from '@/lib/api';

/* ------------------------------------------------------------------ *
 * Format du paquet
 * ------------------------------------------------------------------ */

/** Version du format de paquet. Un paquet d'une autre version est refusé. */
export const SYNC_PACKAGE_VERSION = 1;

export type SyncRow = {
  table: string;
  sync_id: string;
  updated_at: string | null;
  deleted_at: string | null;
  origin_device_id: string | null;
  /** Colonnes métier, en `snake_case`, **sans** `id` local. */
  fields: Record<string, unknown>;
  /** Références sortantes, résolues par `sync_id` (§23.4). */
  refs?: Record<string, string | null>;
};

export type SyncPackage = {
  version: number;
  kind: 'planete-deco-sync';
  exportedAt: string;
  deviceId: string;
  deviceName: string;
  counts: Record<string, number>;
  totalRows: number;
  rows: SyncRow[];
  /** Table stricte `table → lignes`, pour l'export comme pour l'import. */
  tables: Record<string, SyncRow[]>;
  note: string;
};

export type SyncTableCount = { table: string; rows: number };

export type ImportReport = {
  tablesImported: number;
  rowsInserted: number;
  rowsUpdated: number;
  quarantined: number;
  conflicts: number;
  errors: string[];
  /** Détail par table, pour le journal de l'écran `/synchronisation`. */
  perTable: Record<string, { inserted: number; updated: number; quarantined: number; conflicts: number }>;
};

/* ------------------------------------------------------------------ *
 * Définition des tables : colonnes métier et références sortantes
 * ------------------------------------------------------------------ */

type TableSpec = {
  /** Colonnes à ne jamais transporter (clé locale, identité globale, horodatages). */
  omit: string[];
  /** Référence sortante → table parente. */
  refs: Record<string, string>;
  /**
   * Références dont l'absence n'est **pas** bloquante : elles sont nullable dans
   * le schéma, la ligne peut donc exister sans son parent. Les autres envoient
   * la ligne en quarantaine.
   */
  optionalRefs: string[];
};

/**
 * ⚠️ `id` n'est jamais exporté : il est local à chaque poste et se
 * collisionnerait entre deux machines (§23.3). `sync_id` est conservé.
 */
const SYNC_TABLES: Record<SyncedTable, TableSpec> = {
  categories: { omit: [], refs: {}, optionalRefs: [] },
  products: { omit: [], refs: { category_id: 'categories' }, optionalRefs: ['category_id'] },
  customers: { omit: [], refs: {}, optionalRefs: [] },
  suppliers: { omit: [], refs: {}, optionalRefs: [] },
  workers: { omit: [], refs: {}, optionalRefs: [] },
  users: { omit: ['password_hash'], refs: {}, optionalRefs: [] },
  settings: { omit: [], refs: {}, optionalRefs: [] },
  sales_invoices: {
    omit: [],
    refs: { customer_id: 'customers', user_id: 'users' },
    optionalRefs: ['customer_id', 'user_id'],
  },
  sales_invoice_items: {
    omit: [],
    refs: { invoice_id: 'sales_invoices', product_id: 'products' },
    optionalRefs: ['product_id'],
  },
  purchase_invoices: {
    omit: [],
    refs: { supplier_id: 'suppliers', user_id: 'users' },
    optionalRefs: ['supplier_id', 'user_id'],
  },
  purchase_invoice_items: {
    omit: [],
    refs: { invoice_id: 'purchase_invoices', product_id: 'products' },
    optionalRefs: ['product_id'],
  },
  payments: { omit: [], refs: { user_id: 'users' }, optionalRefs: ['user_id'] },
  cash_sessions: { omit: [], refs: { opened_by: 'users' }, optionalRefs: ['opened_by'] },
  cash_movements: {
    omit: [],
    refs: { session_id: 'cash_sessions', user_id: 'users' },
    optionalRefs: ['session_id', 'user_id'],
  },
  stock_movements: {
    omit: [],
    refs: { product_id: 'products', user_id: 'users' },
    optionalRefs: ['user_id'],
  },
  expenses: { omit: [], refs: { user_id: 'users' }, optionalRefs: ['user_id'] },
  audit_logs: { omit: [], refs: { user_id: 'users' }, optionalRefs: ['user_id'] },
  service_jobs: { omit: [], refs: { customer_id: 'customers' }, optionalRefs: [] },
  service_job_materials: {
    omit: [],
    refs: { job_id: 'service_jobs', product_id: 'products' },
    optionalRefs: ['product_id'],
  },
  service_job_workers: {
    omit: [],
    refs: { job_id: 'service_jobs', worker_id: 'workers' },
    optionalRefs: ['worker_id'],
  },
  brick_types: { omit: [], refs: { product_id: 'products' }, optionalRefs: [] },
  brick_productions: {
    omit: [],
    refs: { brick_type_id: 'brick_types', user_id: 'users' },
    optionalRefs: ['user_id'],
  },
  brick_production_materials: {
    omit: [],
    refs: { production_id: 'brick_productions', product_id: 'products' },
    optionalRefs: ['product_id'],
  },
  brick_production_workers: {
    omit: [],
    refs: { production_id: 'brick_productions', worker_id: 'workers' },
    optionalRefs: ['worker_id'],
  },
  furniture_models: { omit: [], refs: {}, optionalRefs: [] },
  furniture_model_materials: {
    omit: [],
    refs: { model_id: 'furniture_models', product_id: 'products' },
    optionalRefs: ['product_id'],
  },
  furniture_orders: {
    omit: [],
    refs: { customer_id: 'customers', model_id: 'furniture_models', user_id: 'users' },
    optionalRefs: ['customer_id', 'model_id', 'user_id'],
  },
  furniture_order_materials: {
    omit: [],
    refs: { order_id: 'furniture_orders', product_id: 'products' },
    optionalRefs: ['product_id'],
  },
  furniture_order_workers: {
    omit: [],
    refs: { order_id: 'furniture_orders', worker_id: 'workers' },
    optionalRefs: ['worker_id'],
  },
  report_deliveries: { omit: [], refs: { user_id: 'users' }, optionalRefs: ['user_id'] },
};

/** Les tables synchronisables, dans l'ordre topologique. */
export function syncTableNames(): SyncedTable[] {
  return [...SYNC_ORDER];
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

/** Convertit un horodatage SQLite (secondes) en ISO, ou `null`. */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** Sérialise une valeur pour un paquet JSON (les Buffers n'existent pas ici). */
function serialisable(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

async function selectTableRows(table: SyncedTable): Promise<any[]> {
  // Colonnes réellement présentes : l'export ne doit pas casser si une table
  // optionnelle n'a pas encore été créée sur un poste ancien.
  const columns = await rawAll<{ name: string }>(`PRAGMA table_info("${table}")`);
  if (columns.length === 0) return [];

  const names = columns.map((column) => column.name).filter((name) => name !== 'id');
  if (names.length === 0) return [];

  const list = names.map((name) => `"${name}"`).join(', ');
  return rawAll<any>(`SELECT ${list} FROM "${table}"`);
}

function buildRow(table: SyncedTable, spec: TableSpec, raw: any): SyncRow | null {
  const syncId = raw.sync_id ? String(raw.sync_id) : null;
  if (!syncId) return null;

  const fields: Record<string, unknown> = {};
  const refs: Record<string, string | null> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'id' || key === 'sync_id' || key === 'updated_at') continue;
    if (key === 'deleted_at' || key === 'origin_device_id') continue;
    if (spec.omit.includes(key)) continue;

    if (spec.refs[key]) {
      // Une référence circule par `sync_id`, jamais par `id` local (§11 règle 3).
      const localId = value === null || value === undefined ? null : Number(value);
      fields[key] = null;
      refs[spec.refs[key]] = null;
      if (localId && Number.isFinite(localId)) {
        fields[`__ref_${key}`] = localId;
      }
      continue;
    }

    fields[key] = serialisable(value);
  }

  return {
    table,
    sync_id: syncId,
    updated_at: toIso(raw.updated_at),
    deleted_at: toIso(raw.deleted_at),
    origin_device_id: raw.origin_device_id ? String(raw.origin_device_id) : null,
    fields,
    refs,
  };
}

/**
 * Construit le paquet complet — **30 tables métier** dans l'ordre topologique.
 *
 * Les références sortantes sont résolues à la source : `refs` porte des
 * `sync_id`, ce qui rend le paquet auto-suffisant et transportable vers un
 * poste dont les `id` locaux sont totalement différents.
 */
export async function buildSyncPackage(options: { deviceName?: string } = {}): Promise<SyncPackage> {
  const deviceId = await getDeviceId();
  const rows: SyncRow[] = [];
  const tables: Record<string, SyncRow[]> = {};
  const counts: Record<string, number> = {};

  // Table de correspondance `id local → sync_id`, construite table par table :
  // une jointure générique sur 30 tables serait illisible et fragile.
  const syncIdMaps = new Map<string, Map<number, string>>();

  const getMap = async (table: SyncedTable): Promise<Map<number, string>> => {
    const cached = syncIdMaps.get(table);
    if (cached) return cached;

    const map = new Map<number, string>();
    try {
      const pairs = await rawAll<{ id: number; sync_id: string }>(
        `SELECT id, sync_id FROM "${table}"`,
      );
      for (const pair of pairs) {
        if (pair.sync_id) map.set(Number(pair.id), String(pair.sync_id));
      }
    } catch {
      /* table absente sur ce poste : la carte reste vide */
    }

    syncIdMaps.set(table, map);
    return map;
  };

  for (const table of SYNC_ORDER) {
    const spec = SYNC_TABLES[table];

    let rawRows: any[] = [];
    try {
      rawRows = await selectTableRows(table);
    } catch {
      counts[table] = 0;
      tables[table] = [];
      continue;
    }

    const tableRows: SyncRow[] = [];

    for (const raw of rawRows) {
      const row = buildRow(table, spec, raw);
      if (!row) continue;

      // Résolution des références par `sync_id` (§23.4).
      for (const [field, parentTable] of Object.entries(spec.refs)) {
        const localId = row.fields[`__ref_${field}`];
        delete row.fields[`__ref_${field}`];

        if (localId === null || localId === undefined) {
          row.refs![parentTable] = null;
          continue;
        }

        const parentMap = await getMap(parentTable as SyncedTable);
        row.refs![parentTable] = parentMap.get(Number(localId)) ?? null;
      }

      tableRows.push(row);
      rows.push(row);
    }

    tables[table] = tableRows;
    counts[table] = tableRows.length;
  }

  return {
    version: SYNC_PACKAGE_VERSION,
    kind: 'planete-deco-sync',
    exportedAt: new Date().toISOString(),
    deviceId,
    deviceName: options.deviceName ?? 'Poste local',
    counts,
    totalRows: rows.length,
    rows,
    tables,
    note:
      'Paquet de synchronisation Planète Déco. Les identifiants globaux (sync_id) font foi ; les identifiants locaux (id) ne sont pas transportés.',
  };
}

/** Compteurs par table, sans construire le paquet entier (écran de dépannage). */
export async function countSyncTables(): Promise<SyncTableCount[]> {
  const result: SyncTableCount[] = [];

  for (const table of SYNC_ORDER) {
    try {
      const row = await rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`);
      result.push({ table, rows: Number(row?.n ?? 0) });
    } catch {
      result.push({ table, rows: 0 });
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

export class SyncPackageError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'SyncPackageError';
  }
}

/** Validation **structurelle** du paquet : version, marqueur, tables connues. */
export function validateSyncPackage(payload: unknown): SyncPackage {
  if (!payload || typeof payload !== 'object') {
    throw new SyncPackageError('Fichier illisible : un objet JSON est attendu');
  }

  const candidate = payload as Partial<SyncPackage>;

  if (candidate.kind !== 'planete-deco-sync') {
    throw new SyncPackageError(
      'Ce fichier n’est pas un paquet de synchronisation Planète Déco (marqueur absent)',
    );
  }

  if (Number(candidate.version) !== SYNC_PACKAGE_VERSION) {
    throw new SyncPackageError(
      `Version de paquet non prise en charge (reçu ${candidate.version ?? '?'}, attendu ${SYNC_PACKAGE_VERSION}). Mettez à jour l’application du poste.`,
    );
  }

  const known = new Set<string>(SYNC_ORDER as readonly string[]);
  const tables = candidate.tables;

  if (!tables || typeof tables !== 'object') {
    throw new SyncPackageError('Paquet incomplet : la section « tables » est absente');
  }

  const unknown = Object.keys(tables).filter((table) => !known.has(table));
  if (unknown.length > 0) {
    throw new SyncPackageError(
      `Paquet produit par une version plus récente : table(s) inconnue(s) ${unknown.slice(0, 5).join(', ')}`,
    );
  }

  const recognised = Object.keys(tables).filter((table) => known.has(table));
  if (recognised.length === 0) {
    throw new SyncPackageError('Paquet vide : aucune table métier reconnue');
  }

  return candidate as SyncPackage;
}

/** Types de colonnes d'une table locale, pour ne transporter que le connu. */
type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: unknown };

async function tableColumns(table: string): Promise<Map<string, ColumnInfo>> {
  const map = new Map<string, ColumnInfo>();
  try {
    const rows = await rawAll<any>(`PRAGMA table_info("${table}")`);
    for (const row of rows) {
      map.set(String(row.name), {
        name: String(row.name),
        type: String(row.type ?? ''),
        notnull: Number(row.notnull ?? 0),
        dflt_value: row.dflt_value,
      });
    }
  } catch {
    /* table absente */
  }
  return map;
}

/**
 * Type des valeurs acceptées par le pilote SQLite (`InValue` de libsql).
 * Déclaré localement : seules des primitives sont produites par `coerceValue`,
 * ce qui évite d'introduire `Buffer` dans une signature de module.
 */
type SqlValue = string | number | bigint | Uint8Array | ArrayBuffer | null;

/** Convertit une valeur JSON vers le type attendu par SQLite.
 *
 * `PRAGMA table_info` dit `INTEGER` pour un booléen Drizzle (`mode: 'boolean'`)
 * comme pour un horodatage (`mode: 'timestamp'`) : la conversion est donc
 * explicite ici, colonne par colonne, pour ne jamais écrire un booléen `true`
 * dans une colonne qui attend un entier.
 */
function coerceValue(value: unknown, type: string, isBooleanHint: boolean): SqlValue {
  if (value === null || value === undefined) return null;

  if (typeof value === 'boolean') return value ? 1 : 0;

  const upper = type.toUpperCase();

  if (upper.includes('INT')) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : (isBooleanHint ? (value ? 1 : 0) : null);
  }

  if (upper.includes('REAL') || upper.includes('NUM') || upper.includes('DEC') || upper.includes('FLOA')) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Correspondance `sync_id → id local` d'une table. */
async function localIdMap(table: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const rows = await rawAll<{ id: number; sync_id: string }>(
      `SELECT id, sync_id FROM "${table}" WHERE sync_id IS NOT NULL`,
    );
    for (const row of rows) map.set(String(row.sync_id), Number(row.id));
  } catch {
    /* table absente */
  }
  return map;
}

/**
 * Applique un paquet de synchronisation.
 *
 * Déroulé, table par table **dans l'ordre topologique** :
 *  1. une référence parente manquante → **quarantaine** dans `sync_pending` ;
 *  2. la ligne existe déjà localement (`sync_id`) :
 *       - même version ou version reçue plus récente → mise à jour ;
 *       - version **locale** plus récente et table non append-only → **conflit**
 *         enregistré dans `sync_conflicts`, la ligne locale est conservée ;
 *  3. sinon → insertion, avec les références résolues par `sync_id`.
 *
 * Aucune donnée existante n'est écrasée sans arbitrage, et rien n'est jamais
 * supprimé : une ligne reçue avec `deleted_at` pose un tombstone.
 */
export async function applySyncPackage(pkg: SyncPackage): Promise<ImportReport> {
  const report: ImportReport = {
    tablesImported: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    quarantined: 0,
    conflicts: 0,
    errors: [],
    perTable: {},
  };

  const localDeviceId = await getDeviceId();

  /**
   * Cache des correspondances `sync_id → id local`, par table.
   *
   * Il est **mis à jour après chaque insertion** : sans cela, un enfant arrivé
   * juste après son parent dans le même paquet ne retrouverait pas ce dernier et
   * partirait à tort en quarantaine.
   */
  const idMapCache = new Map<string, Map<string, number>>();

  const rememberLocalId = (table: string, syncId: string, id: number): void => {
    const map = idMapCache.get(table) ?? new Map<string, number>();
    map.set(syncId, id);
    idMapCache.set(table, map);
  };

  const cacheLocalIds = async (table: string): Promise<void> => {
    idMapCache.set(table, await localIdMap(table));
  };

  for (const table of SYNC_ORDER) {
    const tableRows = pkg.tables[table];
    if (!Array.isArray(tableRows) || tableRows.length === 0) continue;

    const spec = SYNC_TABLES[table];
    const columns = await tableColumns(table);
    if (columns.size === 0) {
      report.errors.push(`Table « ${table} » absente sur ce poste : ${tableRows.length} ligne(s) ignorée(s).`);
      continue;
    }

    report.tablesImported += 1;
    const stat = { inserted: 0, updated: 0, quarantined: 0, conflicts: 0 };

    // Correspondances déjà connues pour cette table, avant toute résolution.
    await cacheLocalIds(table);

    for (const row of tableRows) {
      try {
        if (!row || typeof row !== 'object' || !row.sync_id) {
          report.errors.push(`Ligne sans « sync_id » dans « ${table} » : ignorée.`);
          continue;
        }

        const fields: Record<string, unknown> = { ...(row.fields ?? {}) };

        /* 1. Résolution des références — par `sync_id`, jamais par `id` local. */
        let missingParent: string | null = null;

        for (const [field, parentTable] of Object.entries(spec.refs)) {
          if (!(field in fields)) continue;

          const wantedSyncId = row.refs?.[parentTable] ?? null;

          if (!wantedSyncId) {
            // Référence nullable absente : la ligne reste valide.
            if (!spec.optionalRefs.includes(field)) missingParent = parentTable;
            fields[field] = null;
            continue;
          }

          const map = idMapCache.get(parentTable) ?? (await localIdMap(parentTable));
          idMapCache.set(parentTable, map);
          const localId = map.get(String(wantedSyncId));
          if (localId === undefined) {
            missingParent = parentTable;
            break;
          }

          fields[field] = localId;
        }

        if (missingParent) {
          // Jamais perdue : la ligne part en quarantaine et sera rejouée (§23.4).
          const alreadyPending = await rawGet<{ n: number }>(
            `SELECT COUNT(*) AS n FROM sync_pending WHERE table_name = ? AND sync_id = ?`,
            [table, row.sync_id],
          );

          if (Number(alreadyPending?.n ?? 0) === 0) {
            await db.insert(syncPending).values({
              tableName: table,
              syncId: row.sync_id,
              payload: JSON.stringify(row),
              missingParent,
              attempts: 0,
              lastAttemptAt: new Date(),
              lastError: `Référence parente absente : ${missingParent}`,
            });
          }

          stat.quarantined += 1;
          report.quarantined += 1;
          continue;
        }

        /* 2. La ligne existe-t-elle déjà (par `sync_id`) ? */
        const existing = await rawGet<{ id: number; updated_at: number | null }>(
          `SELECT id, updated_at FROM "${table}" WHERE sync_id = ? LIMIT 1`,
          [row.sync_id],
        );

        const incomingAt = row.updated_at ? Date.parse(row.updated_at) : Date.now();

        if (existing) {
          const localAt = existing.updated_at ? Number(existing.updated_at) * 1000 : 0;

          const appendOnly = (APPEND_ONLY_TABLES as string[]).includes(table);

          if (!appendOnly && localAt > incomingAt) {
            // Arbitrage humain : on n'écrase **jamais** une écriture locale
            // plus récente (§23.7). La version locale est conservée.
            const localRow = await rawGet<any>(`SELECT * FROM "${table}" WHERE id = ?`, [existing.id]);

            await db.insert(syncConflicts).values({
              tableName: table,
              syncId: row.sync_id,
              localPayload: JSON.stringify(localRow ?? {}),
              remotePayload: JSON.stringify(row),
              resolution: 'pending',
            });

            stat.conflicts += 1;
            report.conflicts += 1;
            continue;
          }

          const assignments: string[] = [];
          const args: SqlValue[] = [];

          for (const [key, value] of Object.entries(fields)) {
            const info = columns.get(key);
            if (!info) continue;
            assignments.push(`"${key}" = ?`);
            args.push(coerceValue(value, info.type, false));
          }

          if (row.deleted_at !== undefined) {
            assignments.push(`"deleted_at" = ?`);
            args.push(row.deleted_at ? Math.floor(Date.parse(row.deleted_at) / 1000) : null);
          }

          if (row.origin_device_id !== undefined && columns.has('origin_device_id')) {
            assignments.push(`"origin_device_id" = ?`);
            args.push(row.origin_device_id ?? localDeviceId);
          }

          if (columns.has('updated_at')) {
            assignments.push(`"updated_at" = ?`);
            args.push(Math.floor(incomingAt / 1000));
          }

          if (assignments.length > 0) {
            await rawRun(
              `UPDATE "${table}" SET ${assignments.join(', ')} WHERE id = ?`,
              [...args, existing.id],
            );
          }

          stat.updated += 1;
          report.rowsUpdated += 1;
          continue;
        }

        /* 3. Insertion — colonnes connues uniquement, `sync_id` imposé. */
        const keys: string[] = ['sync_id'];
        const values: SqlValue[] = [row.sync_id];
        const placeholders: string[] = ['?'];

        for (const [key, value] of Object.entries(fields)) {
          const info = columns.get(key);
          if (!info) continue;
          // Une colonne NOT NULL sans valeur reçue est laissée à son défaut SQL.
          if (value === null && info.notnull === 1 && info.dflt_value !== null) continue;
          keys.push(key);
          values.push(coerceValue(value, info.type, false));
          placeholders.push('?');
        }

        if (columns.has('deleted_at')) {
          keys.push('deleted_at');
          values.push(row.deleted_at ? Math.floor(Date.parse(row.deleted_at) / 1000) : null);
          placeholders.push('?');
        }

        if (columns.has('origin_device_id')) {
          keys.push('origin_device_id');
          values.push(row.origin_device_id ?? localDeviceId);
          placeholders.push('?');
        }

        if (columns.has('updated_at')) {
          keys.push('updated_at');
          values.push(Math.floor(incomingAt / 1000));
          placeholders.push('?');
        }

        const inserted = await rawRun(
          `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(', ')})
           VALUES (${placeholders.join(', ')})`,
          values,
        );

        // Le prochain enfant du même paquet doit retrouver ce parent.
        const newId = Number(inserted.lastInsertRowid ?? 0);
        if (newId > 0) rememberLocalId(table, row.sync_id, newId);

        stat.inserted += 1;
        report.rowsInserted += 1;
      } catch (error) {
        report.errors.push(
          `${table} / ${row?.sync_id ?? '?'} : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    report.perTable[table] = stat;
  }

  return report;
}

/** Conflits en attente d'arbitrage humain. */
export async function listPendingConflicts(): Promise<
  {
    id: number;
    tableName: string;
    syncId: string;
    localPayload: string;
    remotePayload: string;
    resolution: string;
    resolvedAt: Date | null;
    resolvedBy: number | null;
    createdAt: Date | null;
  }[]
> {
  const rows = await db.select().from(syncConflicts).orderBy(syncConflicts.id);

  return rows.map((row) => ({
    id: row.id,
    tableName: row.tableName,
    syncId: row.syncId,
    localPayload: row.localPayload,
    remotePayload: row.remotePayload,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    createdAt: row.createdAt,
  }));
}

/**
 * Résout un conflit : « garder local » ou « garder distant ».
 *
 * « Garder distant » applique la charge distante à la ligne locale, **par
 * `sync_id`** ; « garder local » conserve la ligne et se contente de refermer
 * le conflit. Dans les deux cas, la version perdante reste dans
 * `sync_conflicts` : l'arbitrage est tracé, jamais effacé.
 */
export async function resolveConflict(
  id: number,
  resolution: 'local' | 'remote',
  userId: number | null,
): Promise<{ id: number; resolution: string; applied: boolean }> {
  const conflict = await rawGet<any>('SELECT * FROM sync_conflicts WHERE id = ? LIMIT 1', [id]);
  if (!conflict) throw new ValidationError('Conflit introuvable');

  let applied = false;

  if (resolution === 'remote') {
    const remote = JSON.parse(String(conflict.remote_payload)) as SyncRow;
    const columns = await tableColumns(String(conflict.table_name));

    const existing = await rawGet<{ id: number }>(
      `SELECT id FROM "${conflict.table_name}" WHERE sync_id = ? LIMIT 1`,
      [conflict.sync_id],
    );

    if (existing && columns.size > 0) {
      const assignments: string[] = [];
      const args: SqlValue[] = [];

      for (const [key, value] of Object.entries(remote.fields ?? {})) {
        const info = columns.get(key);
        if (!info) continue;
        assignments.push(`"${key}" = ?`);
        args.push(coerceValue(value, info.type, false));
      }

      if (assignments.length > 0) {
        await rawRun(
          `UPDATE "${conflict.table_name}" SET ${assignments.join(', ')} WHERE id = ?`,
          [...args, existing.id],
        );
        applied = true;
      }
    }
  }

  await rawRun(
    `UPDATE sync_conflicts SET resolution = ?, resolved_at = ?, resolved_by = ? WHERE id = ?`,
    [resolution, Math.floor(Date.now() / 1000), userId, id],
  );

  return { id, resolution, applied };
}

/* ------------------------------------------------------------------ *
 * Réinitialisation des watermarks (« Renvoyer tout »)
 * ------------------------------------------------------------------ */

/**
 * Réinitialise les **watermarks** et remet `attempts` à zéro.
 *
 * **Rien n'est supprimé** : ni les données métier, ni une seule ligne de
 * `sync_outbox`. C'est exactement ce que demande §23.10 — « Renvoyer tout »
 * signifie « considérer que tout reste à envoyer », pas « effacer la file ».
 * Les conflits déjà tranchés sont conservés eux aussi : ils constituent
 * l'historique de l'arbitrage.
 */
export async function resetSyncWatermarks(): Promise<{ tables: string[]; outboxReset: number; conflicts: number }> {
  const tables: string[] = [];

  for (const table of SYNC_ORDER) {
    const key = `last_pulled_at:${table}`;
    const existing = await rawGet<{ id: number }>('SELECT id FROM sync_state WHERE key = ? LIMIT 1', [key]);

    if (existing) {
      await rawRun('UPDATE sync_state SET value = NULL, updated_at = ? WHERE id = ?', [
        Date.now(),
        existing.id,
      ]);
    } else {
      await rawRun(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, NULL, ?)`,
        [key, Date.now()],
      );
    }

    tables.push(table);
  }

  const before = await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox');
  await rawRun(
    'UPDATE sync_outbox SET attempts = 0, last_error = NULL, last_attempt_at = NULL',
  );

  await rawRun(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('last_reset_at', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [new Date().toISOString(), Date.now()],
  );

  const conflicts = await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM sync_conflicts');

  return {
    tables,
    outboxReset: Number(before?.n ?? 0),
    conflicts: Number(conflicts?.n ?? 0),
  };
}

/** Réessaie les lignes en quarantaine dont le parent est désormais présent. */
export async function retryQuarantine(limit = 200): Promise<ImportReport> {
  const pending = await rawAll<any>(
    `SELECT * FROM sync_pending ORDER BY id LIMIT ${Math.max(1, Math.min(1000, limit))}`,
  );

  const report: ImportReport = {
    tablesImported: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    quarantined: 0,
    conflicts: 0,
    errors: [],
    perTable: {},
  };

  if (pending.length === 0) return report;

  // Regroupement par table, dans l'ordre topologique : un parent rejoué plus
  // tôt dans l'ordre peut débloquer un enfant resté en quarantaine.
  const byTable = new Map<string, any[]>();
  for (const row of pending) {
    const list = byTable.get(String(row.table_name)) ?? [];
    list.push(row);
    byTable.set(String(row.table_name), list);
  }

  for (const table of SYNC_ORDER) {
    const rows = byTable.get(table);
    if (!rows || rows.length === 0) continue;

    const synthetic: SyncPackage = {
      version: SYNC_PACKAGE_VERSION,
      kind: 'planete-deco-sync',
      exportedAt: new Date().toISOString(),
      deviceId: '',
      deviceName: '',
      counts: { [table]: rows.length },
      totalRows: rows.length,
      rows: [],
      tables: {
        [table]: rows.map((row) => {
          try {
            return JSON.parse(String(row.payload)) as SyncRow;
          } catch {
            return null as unknown as SyncRow;
          }
        }).filter(Boolean),
      },
      note: 'Rejeu de la quarantaine locale',
    };

    const partial = await applySyncPackage(synthetic);
    report.tablesImported += partial.tablesImported;
    report.rowsInserted += partial.rowsInserted;
    report.rowsUpdated += partial.rowsUpdated;
    report.quarantined += partial.quarantined;
    report.conflicts += partial.conflicts;
    report.errors.push(...partial.errors);
  }

  // Les lignes appliquées ne sont plus en quarantaine. `sync_pending` est une
  // file technique locale : c'est le **seul** endroit du module où une
  // suppression physique est légitime, puisqu'il ne s'agit pas d'une table
  // métier synchronisée (§23.9).
  for (const row of pending) {
    const applied = await rawGet<{ n: number }>(
      `SELECT COUNT(*) AS n FROM "${row.table_name}" WHERE sync_id = ?`,
      [row.sync_id],
    );

    if (Number(applied?.n ?? 0) > 0) {
      await rawRun('DELETE FROM sync_pending WHERE table_name = ? AND sync_id = ?', [
        row.table_name,
        row.sync_id,
      ]);
    } else {
      await rawRun('UPDATE sync_pending SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?', [
        Date.now(),
        row.id,
      ]);
    }
  }

  report.quarantined = Number(
    (await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM sync_pending'))?.n ?? 0,
  );

  return report;
}
