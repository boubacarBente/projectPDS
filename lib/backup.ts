/**
 * Sauvegarde et restauration de la base (§14, §18 ; multi-magasins §18, §22).
 *
 * **Sauvegarde** : `VACUUM INTO` produit une copie cohérente et complète en un
 * seul fichier (la base tourne en WAL : une copie naïve du `.db` peut oublier
 * des transactions encore dans le journal).
 *
 * **Sauvegarde automatique** (correctif : elle n'était jamais déclenchée) :
 * une copie datée par jour, au démarrage puis toutes les heures si la journée
 * n'en a pas encore, conservée `backupRetentionDays` jours, et **recopiée dans
 * un dossier externe** (`backupExternalDir` : clé USB, disque réseau, dossier
 * Google Drive synchronisé) pour survivre à une panne de disque.
 *
 * **Restauration** :
 *  1. copie de sécurité de la base courante ;
 *  2. la sauvegarde est copiée dans un fichier temporaire, puis **mise à
 *     niveau** par les migrations de cette version (une sauvegarde d'une
 *     version plus ancienne n'est plus refusée) ;
 *  3. ses tables sont recopiées dans la base vivante, **dans une transaction,
 *     sur une connexion dédiée** (l'ancienne version attachait la sauvegarde
 *     sur une connexion du pool puis écrivait sur une autre) ;
 *  4. l'identité du poste (mode, jeton, serveur) est conservée, et la
 *     synchronisation est réarmée : tout est renvoyé au serveur, qui arbitre
 *     par horodatage, puis tout est redemandé.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createClient } from '@libsql/client/sqlite3';
import { drizzle } from 'drizzle-orm/libsql/sqlite3';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { dbClient, getDbPath, rawAll, rawRun, withTransaction } from '@/db';
import * as schema from '@/db/schema';
import { SYNCED_TABLE_NAMES } from '@/db/sync-registry';
import { installSyncTriggers } from '@/db/triggers';

/** Tables métier, parents avant enfants (ordre du registre de synchronisation). */
const BUSINESS_TABLES = [...SYNCED_TABLE_NAMES];

/** Tables locales recopiées avec les données (hors identité du poste). */
const LOCAL_RESTORE_TABLES = ['doc_sequences', 'sync_pending', 'sync_conflicts'];

const RESTORE_ORDER = [...BUSINESS_TABLES, ...LOCAL_RESTORE_TABLES];

/** Clés de `sync_state` qui décrivent **ce poste** : jamais écrasées par une restauration. */
const DEVICE_KEYS = [
  'device_mode',
  'device_id',
  'device_name',
  'device_code',
  'device_store_id',
  'device_store_sync_id',
  'server_url',
  'device_token',
  'auto_sync_minutes',
  'triggers_version',
];

export class BackupError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** Répertoire des sauvegardes, à côté de la base. */
export function getBackupsDir(): string {
  const dir = path.join(path.dirname(getDbPath()), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTempDir(): string {
  const dir = path.join(os.tmpdir(), 'planete-deco');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Chemin SQLite sûr : slashes normalisés, apostrophes échappées. */
function sqlitePathLiteral(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/'/g, "''");
}

function migrationsFolder(): string {
  if (process.env.ELECTRON_APP_PATH) {
    return path.join((process as any).resourcesPath, 'app', 'db', 'migrations');
  }
  return path.join(process.cwd(), 'db', 'migrations');
}

/** Crée une sauvegarde complète et cohérente. */
export async function createBackup(options: { into?: string; label?: string } = {}): Promise<{
  path: string;
  size: number;
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target =
    options.into ?? path.join(getBackupsDir(), `${options.label ?? 'database'}-${stamp}.db`);

  if (fs.existsSync(/* turbopackIgnore: true */ target)) {
    fs.rmSync(/* turbopackIgnore: true */ target, { force: true });
  }

  await rawRun(`VACUUM INTO '${sqlitePathLiteral(target)}'`);

  const stat = fs.statSync(/* turbopackIgnore: true */ target);
  return { path: target, size: stat.size };
}

/** Supprime les sauvegardes automatiques plus anciennes que la rétention. */
export async function purgeOldBackups(retentionDays = 30, dir = getBackupsDir()): Promise<number> {
  const limit = Date.now() - Math.max(1, retentionDays) * 86_400_000;
  let removed = 0;

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith('auto-') || !entry.endsWith('.db')) continue;
    const filePath = path.join(dir, entry);
    try {
      if (fs.statSync(filePath).mtimeMs < limit) {
        fs.rmSync(filePath, { force: true });
        removed += 1;
      }
    } catch {
      /* un fichier illisible ne doit pas empêcher le démarrage */
    }
  }

  return removed;
}

export type DailyBackupResult = {
  created: string | null;
  externalCopy: string | null;
  externalError: string | null;
};

/**
 * Sauvegarde automatique du jour, si elle n'existe pas déjà, et copie externe.
 * Ne lève jamais : une sauvegarde ratée ne doit pas empêcher de travailler,
 * mais l'erreur est renvoyée pour être affichée et journalisée.
 */
export async function ensureDailyBackup(options: {
  enabled?: boolean;
  retentionDays?: number;
  externalDir?: string | null;
} = {}): Promise<DailyBackupResult> {
  const result: DailyBackupResult = { created: null, externalCopy: null, externalError: null };
  if (options.enabled === false) return result;

  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(getBackupsDir(), `auto-${stamp}.db`);

  try {
    // Pas de sauvegarde sur une base vide (installation neuve).
    const users = await rawAll<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    if (Number(users[0]?.n ?? 0) === 0) return result;

    if (!fs.existsSync(target)) {
      await createBackup({ into: target });
      result.created = target;
      await purgeOldBackups(options.retentionDays ?? 30);
    }

    const externalDir = (options.externalDir ?? '').trim();
    if (externalDir) {
      try {
        if (!fs.existsSync(externalDir)) fs.mkdirSync(externalDir, { recursive: true });
        const externalTarget = path.join(externalDir, `planete-deco-auto-${stamp}.db`);
        if (!fs.existsSync(externalTarget)) {
          fs.copyFileSync(target, externalTarget);
          result.externalCopy = externalTarget;
        }
        await purgeExternal(externalDir, options.retentionDays ?? 30);
      } catch (error) {
        result.externalError =
          error instanceof Error ? error.message : 'Dossier externe inaccessible (clé USB absente ?)';
      }
    }
  } catch (error) {
    console.error('[backup] Sauvegarde automatique impossible :', error);
  }

  return result;
}

async function purgeExternal(dir: string, retentionDays: number) {
  const limit = Date.now() - Math.max(1, retentionDays) * 86_400_000;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith('planete-deco-auto-') || !entry.endsWith('.db')) continue;
    const filePath = path.join(dir, entry);
    try {
      if (fs.statSync(filePath).mtimeMs < limit) fs.rmSync(filePath, { force: true });
    } catch {
      /* ignoré */
    }
  }
}

/** Date de la dernière sauvegarde (automatique ou manuelle), pour l'alerte « pas de sauvegarde récente ». */
export function getLastBackupInfo(): { path: string; at: Date } | null {
  try {
    const dir = getBackupsDir();
    let latest: { path: string; at: Date } | null = null;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.db')) continue;
      const filePath = path.join(dir, entry);
      const at = fs.statSync(filePath).mtime;
      if (!latest || at > latest.at) latest = { path: filePath, at };
    }
    return latest;
  } catch {
    return null;
  }
}

/** Vérifie qu'un fichier est bien une base SQLite. */
export function inspectSqliteFile(filePath: string): { valid: boolean; reason?: string } {
  if (!fs.existsSync(filePath)) return { valid: false, reason: 'Fichier introuvable' };

  const stat = fs.statSync(filePath);
  if (stat.size < 100) {
    return { valid: false, reason: 'Fichier trop petit pour être une base SQLite' };
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
      return { valid: false, reason: "Ce fichier n'est pas une base SQLite valide" };
    }
  } finally {
    fs.closeSync(fd);
  }

  return { valid: true };
}

export type RestoreReport = {
  tablesRestored: string[];
  totalRows: number;
  safetyBackup: string;
  warnings: string[];
};

/**
 * Met une copie de sauvegarde au niveau du schéma courant (migrations Drizzle
 * appliquées sur le fichier temporaire, jamais sur l'original).
 */
async function upgradeStagedCopy(stagedPath: string): Promise<string[]> {
  const warnings: string[] = [];
  const client = createClient({ url: `file:${stagedPath.replace(/\\/g, '/')}`, intMode: 'number' });
  try {
    const tables = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    );
    const names = new Set(tables.rows.map((r: any) => String(r.name)));
    if (!names.has('users')) {
      throw new BackupError(
        "Cette sauvegarde ne contient pas la table « users » : ce n'est pas une sauvegarde de Planète Déco.",
      );
    }
    if (!names.has('__drizzle_migrations')) {
      throw new BackupError('Cette sauvegarde ne porte pas d’historique de migrations : elle ne peut pas être mise à niveau.');
    }
    const before = await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations');
    await migrate(drizzle(client, { schema }), { migrationsFolder: migrationsFolder() });
    const after = await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations');
    const applied = Number((after.rows[0] as any).n) - Number((before.rows[0] as any).n);
    if (applied > 0) {
      warnings.push(`Sauvegarde d’une version antérieure : ${applied} mise(s) à niveau appliquée(s) avant restauration.`);
    }
  } finally {
    client.close();
  }
  return warnings;
}

/** Restaure une sauvegarde (voir l'en-tête du module). */
export async function restoreBackup(filePath: string): Promise<RestoreReport> {
  const inspection = inspectSqliteFile(filePath);
  if (!inspection.valid) throw new BackupError(inspection.reason ?? 'Fichier invalide');

  const staged = path.join(getTempDir(), `restore-${Date.now()}.db`);
  fs.copyFileSync(filePath, staged);

  const warnings: string[] = [];
  const tablesRestored: string[] = [];
  let totalRows = 0;

  try {
    warnings.push(...(await upgradeStagedCopy(staged)));

    const { path: safetyBackup } = await createBackup({ label: 'avant-restauration' });

    // Connexion dédiée : ATTACH et transaction sur la même connexion.
    const client = createClient({ url: `file:${getDbPath().replace(/\\/g, '/')}`, intMode: 'number', timeout: 15000 } as any);
    try {
      await client.execute(`ATTACH DATABASE '${sqlitePathLiteral(staged)}' AS restore_src`);

      const sourceTables = new Set(
        (
          await client.execute(
            `SELECT name FROM restore_src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
          )
        ).rows.map((r: any) => String(r.name)),
      );

      const columnsOf = async (alias: string, table: string) =>
        (await client.execute(`PRAGMA ${alias}.table_info("${table}")`)).rows.map((r: any) => String(r.name));

      await client.execute('BEGIN IMMEDIATE');
      try {
        // Les triggers de capture se taisent pendant la recopie.
        await client.execute(
          `INSERT INTO sync_state (key, value, updated_at) VALUES ('applying', '1', unixepoch())
           ON CONFLICT(key) DO UPDATE SET value = '1'`,
        );

        for (const table of [...RESTORE_ORDER].reverse()) {
          if (!sourceTables.has(table)) continue;
          await client.execute(`DELETE FROM main."${table}"`);
        }

        for (const table of RESTORE_ORDER) {
          if (!sourceTables.has(table)) {
            warnings.push(`Table « ${table} » absente de la sauvegarde : laissée vide`);
            continue;
          }
          const destination = await columnsOf('main', table);
          if (destination.length === 0) continue;
          const source = new Set(await columnsOf('restore_src', table));
          const common = destination.filter((c) => source.has(c));
          const columnList = common.map((c) => `"${c}"`).join(', ');
          await client.execute(
            `INSERT INTO main."${table}" (${columnList}) SELECT ${columnList} FROM restore_src."${table}"`,
          );
          const count = await client.execute(`SELECT COUNT(*) AS n FROM main."${table}"`);
          totalRows += Number((count.rows[0] as any)?.n ?? 0);
          tablesRestored.push(table);
        }

        // Synchronisation réarmée : tout repart vers le serveur (qui arbitre par
        // horodatage) et tout est redemandé.
        await client.execute(`DELETE FROM sync_changes`);
        for (const table of BUSINESS_TABLES) {
          await client.execute(
            `INSERT OR IGNORE INTO sync_changes (table_name, sync_id, deleted, change_seq, attempts)
             SELECT '${table}', sync_id, 0, 0, 0 FROM main."${table}"`,
          );
        }
        await client.execute(
          `INSERT INTO sync_state (key, value, updated_at) VALUES ('pull_seq', '0', unixepoch())
           ON CONFLICT(key) DO UPDATE SET value = '0'`,
        );
        await client.execute(`UPDATE sync_state SET value = '0' WHERE key = 'applying'`);
        await client.execute('COMMIT');
      } catch (error) {
        await client.execute('ROLLBACK').catch(() => {});
        throw error;
      }
      await client.execute('DETACH DATABASE restore_src').catch(() => {});
    } finally {
      client.close();
    }

    // Toutes les sessions sont fermées : les comptes ont pu changer.
    await rawRun(`UPDATE sessions SET revoked_at = unixepoch() WHERE revoked_at IS NULL`).catch(() => {});
    await installSyncTriggers(dbClient);

    return { tablesRestored, totalRows, safetyBackup, warnings };
  } finally {
    try {
      fs.rmSync(staged, { force: true });
    } catch {
      /* purgé par le système */
    }
  }
}

/**
 * Tables conservées par la réinitialisation : les comptes et leurs droits, les
 * paramètres, et les tables techniques sans lesquelles l'application ne démarre
 * plus (historique des migrations, identité du poste, sessions ouvertes — sinon
 * la personne qui réinitialise est déconnectée au milieu de l'opération).
 * `stores` et `user_stores` sont traitées à part : seul le magasin principal reste.
 */
const RESET_KEEP_TABLES = new Set([
  'users',
  'user_permissions',
  'settings',
  '__drizzle_migrations',
  'sync_state',
  'devices',
  'sessions',
  'sqlite_sequence',
]);

/**
 * Réinitialise la base : **toutes** les tables sont vidées (équivalent d'un
 * TRUNCATE : SQLite n'en a pas, un `DELETE` sans condition + remise à zéro des
 * compteurs `sqlite_sequence` fait la même chose), sauf les comptes, les
 * paramètres et le **magasin principal** (le siège, sinon le plus ancien), auquel
 * chaque compte est rattaché pour pouvoir retravailler aussitôt.
 *
 * La liste vient de `sqlite_master` et non du registre de synchronisation :
 * l'ancienne version oubliait les tables locales (journal, archives v1, caisse
 * locale…), qui gardaient leurs lignes.
 *
 * Refusé sur un poste relié au serveur : les suppressions seraient propagées à
 * tous les magasins.
 */
export async function resetBusinessData(): Promise<{ tables: string[]; mainStore: string | null }> {
  const mode = await rawAll<{ value: string | null }>(`SELECT value FROM sync_state WHERE key = 'device_mode'`);
  if (mode[0]?.value === 'hq' || mode[0]?.value === 'store') {
    throw new BackupError(
      'Ce poste est relié au serveur central : la réinitialisation effacerait les données de tous les magasins. Opération refusée.',
    );
  }

  const cleared: string[] = [];
  let mainStore: string | null = null;

  await withTransaction(async () => {
    // Les contrôles de clés étrangères sont reportés à la validation : on vide
    // dans n'importe quel ordre, seul l'état final doit être cohérent.
    await rawRun(`PRAGMA defer_foreign_keys = ON`);
    // Les triggers de capture se taisent : rien de tout cela n'est à synchroniser.
    await rawRun(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ('applying', '1', unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
    );

    const main = await rawAll<{ id: number; name: string }>(
      `SELECT id, name FROM stores
       ORDER BY CASE kind WHEN 'headquarters' THEN 0 ELSE 1 END, id
       LIMIT 1`,
    );
    const mainId = main[0]?.id ?? null;
    mainStore = main[0]?.name ?? null;

    const tables = (
      await rawAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
    ).map((r) => r.name);
    const toClear = tables.filter((t) => !RESET_KEEP_TABLES.has(t) && t !== 'stores' && t !== 'user_stores');
    const clearedSet = new Set([...toClear, 'stores']);

    // Une table conservée qui pointe vers une table vidée (ex. `users.site_id`,
    // vestige de la v1 vers `sites`) : le lien est remis à vide, sinon la
    // validation échoue sur la clé étrangère.
    for (const kept of RESET_KEEP_TABLES) {
      if (!tables.includes(kept)) continue;
      const fks = await rawAll<{ table: string; from: string }>(`PRAGMA foreign_key_list("${kept}")`);
      const info = await rawAll<{ name: string; notnull: number }>(`PRAGMA table_info("${kept}")`);
      for (const fk of fks) {
        if (!clearedSet.has(fk.table) || fk.table === 'stores') continue;
        if (info.find((c) => c.name === fk.from)?.notnull) continue;
        await rawRun(`UPDATE main."${kept}" SET "${fk.from}" = NULL`);
      }
    }

    for (const table of toClear) {
      await rawRun(`DELETE FROM main."${table}"`);
      cleared.push(table);
    }

    if (mainId === null) {
      await rawRun(`DELETE FROM user_stores`);
    } else {
      await rawRun(`DELETE FROM user_stores WHERE store_id <> ?`, [mainId]);
      await rawRun(`DELETE FROM stores WHERE id <> ?`, [mainId]);
      await rawRun(`UPDATE stores SET manager_user_id = NULL WHERE manager_user_id NOT IN (SELECT id FROM users)`);
      // Un compte qui n'était affecté qu'à un magasin supprimé n'aurait plus
      // aucun magasin : il est rattaché au magasin principal.
      await rawRun(
        `INSERT INTO user_stores (user_id, store_id, is_manager, is_active, created_at, sync_id, updated_at)
         SELECT u.id, ?, 0, 1, unixepoch(), 'us-' || lower(hex(randomblob(16))), unixepoch()
         FROM users u
         WHERE NOT EXISTS (SELECT 1 FROM user_stores us WHERE us.user_id = u.id)`,
        [mainId],
      );
      await rawRun(`UPDATE sessions SET store_id = ? WHERE store_id IS NOT NULL AND store_id <> ?`, [mainId, mainId]);
    }
    cleared.push('stores (hors magasin principal)', 'user_stores (hors magasin principal)');

    // Compteurs AUTOINCREMENT remis à zéro, comme un TRUNCATE.
    await rawRun(
      `DELETE FROM sqlite_sequence
       WHERE name NOT IN ('users', 'user_permissions', 'settings', 'stores', 'user_stores', 'sync_state', 'devices')`,
    ).catch(() => {});

    await rawRun(`UPDATE sync_state SET value = '0' WHERE key = 'applying'`);
  });

  return { tables: cleared, mainStore };
}

/** Taille de la base et des sauvegardes, pour l'écran Paramètres. */
export function getStorageInfo(): {
  databasePath: string;
  databaseSize: number;
  backupsDir: string;
  backupsCount: number;
  backupsSize: number;
  lastBackupAt: string | null;
} {
  const dbPath = getDbPath();
  const databaseSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const backupsDir = getBackupsDir();

  let backupsCount = 0;
  let backupsSize = 0;

  try {
    for (const entry of fs.readdirSync(backupsDir)) {
      const filePath = path.join(backupsDir, entry);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        backupsCount += 1;
        backupsSize += stat.size;
      }
    }
  } catch {
    /* dossier illisible */
  }

  const last = getLastBackupInfo();
  return {
    databasePath: dbPath,
    databaseSize,
    backupsDir,
    backupsCount,
    backupsSize,
    lastBackupAt: last ? last.at.toISOString() : null,
  };
}

/** Ferme proprement la connexion (arrêt de l'application). */
export async function closeDatabase(): Promise<void> {
  try {
    dbClient.close();
  } catch {
    /* déjà fermée */
  }
}

export { DEVICE_KEYS };
