import {
  createClient,
  type Client,
  type InArgs,
  type ResultSet,
  type Transaction,
} from '@libsql/client/sqlite3';
import { drizzle } from 'drizzle-orm/libsql/sqlite3';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { AsyncLocalStorage } from 'node:async_hooks';
import { installSyncTriggers } from './triggers';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Connexion SQLite locale (source de vérité), migrations automatiques au
 * démarrage, journalisation WAL et verrou de migration inter-processus.
 *
 * Repris du projet Gaz (§3.1) : la seule adaptation est le nom du fichier de
 * log et l'exposition de `initializeDatabase` pour les scripts.
 */

type RawExecutor = Pick<Client | Transaction, 'execute'>;

let _logFilePath: string | null = null;
const MIGRATION_LOCK_TIMEOUT_MS = 60_000;
const MIGRATION_LOCK_STALE_MS = 120_000;

function getLogFilePath() {
  if (!_logFilePath) {
    const baseDir = process.env.ELECTRON_APP_PATH || process.cwd();
    _logFilePath = path.join(baseDir, 'db-error.log');
  }
  return _logFilePath;
}

function dbLog(...args: any[]) {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2)))
    .join(' ');
  console.log(...args);
  try {
    fs.appendFileSync(getLogFilePath(), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Si le fichier de log est indisponible, la console reste suffisante.
  }
}

function dbError(...args: any[]) {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2)))
    .join(' ');
  console.error(...args);
  try {
    fs.appendFileSync(getLogFilePath(), `[${new Date().toISOString()}] ERROR ${line}\n`);
  } catch {
    // Silencieux.
  }
}

export function getDbPath(): string {
  // Base de recette isolée (scripts verify:*, seconde instance de développement) :
  // on teste le multi-magasins sans écrire dans la base de travail.
  if (process.env.PDS_DB_PATH) return path.resolve(process.env.PDS_DB_PATH);
  if (process.env.ELECTRON_APP_PATH) {
    return path.join(process.env.ELECTRON_APP_PATH, 'database.db');
  }
  return path.join(process.cwd(), 'db', 'database.db');
}

function getMigrationsPath(): string {
  if (process.env.ELECTRON_APP_PATH) {
    const appPath = path.join((process as any).resourcesPath, 'app');
    return path.join(appPath, 'db', 'migrations');
  }
  return path.join(process.cwd(), 'db', 'migrations');
}

function toLibsqlFileUrl(filePath: string) {
  return `file:${filePath.replace(/\\/g, '/')}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const dbPath = getDbPath();
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

async function acquireMigrationLock() {
  const lockPath = `${dbPath}.migrate.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);

      return () => {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {}
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > MIGRATION_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}

      if (Date.now() - startedAt > MIGRATION_LOCK_TIMEOUT_MS) {
        throw new Error(`Timeout waiting for DB migration lock: ${lockPath}`);
      }

      await sleep(100);
    }
  }
}

dbLog('[db] ══ Démarrage DB Planète Déco ══');
dbLog('[db] Driver: libsql');
dbLog('[db] Platform:', os.platform(), 'arch:', os.arch());
dbLog('[db] Node:', process.version);
dbLog('[db] ELECTRON_APP_PATH:', process.env.ELECTRON_APP_PATH || '(non défini)');
dbLog('[db] Chemin:', dbPath);

export const dbClient = createClient({
  url: toLibsqlFileUrl(dbPath),
  intMode: 'number',
  timeout: 5000,
});

type AppDatabase = LibSQLDatabase<typeof schema>;

/**
 * **Transactions implicites** (correctif : ventes et achats n'étaient pas
 * atomiques).
 *
 * `withTransaction(fn)` ouvre une transaction `BEGIN IMMEDIATE` sur une
 * connexion dédiée et la place dans un `AsyncLocalStorage`. Pendant `fn`,
 * **tout** accès à la base — `db.select()`, `db.insert()`, `rawRun()`… — passe
 * automatiquement par cette transaction, sans qu'il faille faire circuler un
 * objet `tx` dans les 300 requêtes de `lib/`. Si `fn` lève une erreur, tout est
 * annulé : une vente ne peut plus rester à moitié enregistrée.
 *
 * Les appels imbriqués réutilisent la transaction en cours.
 *
 * `BEGIN IMMEDIATE` prend le verrou d'écriture dès le début : deux ventes
 * simultanées (double-clic, deux onglets) sont sérialisées, ce qui supprime
 * les doublons de numéro et les pertes de stock par lecture-écriture concurrente.
 */
type TxContext = { tx: Transaction; db: AppDatabase };
const txStorage = new AsyncLocalStorage<TxContext>();

const baseDb: AppDatabase = drizzle(dbClient, { schema });

export const db: AppDatabase = new Proxy(baseDb, {
  get(target, prop) {
    const context = txStorage.getStore();
    const source = (context ? context.db : target) as any;
    const value = source[prop];
    return typeof value === 'function' ? value.bind(source) : value;
  },
});

export function inTransaction(): boolean {
  return txStorage.getStore() !== undefined;
}

export async function withTransaction<T>(callback: () => Promise<T>): Promise<T> {
  if (txStorage.getStore()) return callback();

  const tx = await dbClient.transaction('write');
  const txDb = drizzle(tx as unknown as Client, { schema });

  try {
    const result = await txStorage.run({ tx, db: txDb }, callback);
    await tx.commit();
    return result;
  } catch (error) {
    if (!tx.closed) {
      await tx.rollback().catch(() => {});
    }
    throw error;
  } finally {
    if (!tx.closed) tx.close();
  }
}

function currentExecutor(): RawExecutor {
  return txStorage.getStore()?.tx ?? dbClient;
}

export async function rawExecute(
  sql: string,
  args: InArgs = [],
  executor?: RawExecutor,
): Promise<ResultSet> {
  return (executor ?? currentExecutor()).execute({ sql, args });
}

export async function rawGet<T = Record<string, unknown>>(
  sql: string,
  args: InArgs = [],
  executor?: RawExecutor,
): Promise<T | undefined> {
  const result = await rawExecute(sql, args, executor);
  return result.rows[0] as T | undefined;
}

export async function rawAll<T = Record<string, unknown>>(
  sql: string,
  args: InArgs = [],
  executor?: RawExecutor,
): Promise<T[]> {
  const result = await rawExecute(sql, args, executor);
  return result.rows as T[];
}

export async function rawRun(
  sql: string,
  args: InArgs = [],
  executor?: RawExecutor,
): Promise<ResultSet> {
  return rawExecute(sql, args, executor);
}

/** Compatibilité : transaction explicite, l'objet `tx` est aussi l'exécuteur implicite. */
export async function withRawTransaction<T>(
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTransaction(async () => callback(txStorage.getStore()!.tx));
}

function backupsDir(): string {
  const dir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Copie de sécurité cohérente (VACUUM INTO) — utilisée avant toute opération risquée. */
async function safetyCopy(label: string): Promise<string> {
  const target = path.join(backupsDir(), `${label}-${stamp()}.db`);
  await rawRun(`VACUUM INTO '${target.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  return target;
}

function journalEntries(migrationsFolder: string): number {
  try {
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    );
    return Array.isArray(journal?.entries) ? journal.entries.length : 0;
  } catch {
    return 0;
  }
}

export async function initializeDatabase() {
  dbLog('[db] ── initializeDatabase START ──');

  const migrationsFolder = getMigrationsPath();
  dbLog('[db] Dossier migrations:', migrationsFolder);

  if (!fs.existsSync(migrationsFolder)) {
    throw new Error(`Migrations folder missing: ${migrationsFolder}`);
  }

  await rawRun('PRAGMA journal_mode = WAL');
  await rawRun('PRAGMA busy_timeout = 5000');

  const releaseMigrationLock = await acquireMigrationLock();

  try {
    const tables = await rawAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    );

    dbLog(`[db] Tables existantes (${tables.length}):`, tables.map((t) => t.name).sort());

    const hasDrizzleTable = tables.some((t) => t.name === '__drizzle_migrations');
    const hasUsersTable = tables.some((t) => t.name === 'users');

    if (tables.length > 0 && (!hasDrizzleTable || !hasUsersTable)) {
      /*
       * Base existante sans suivi Drizzle. Avant : toutes les tables étaient
       * supprimées sans sauvegarde. Désormais : si la base contient des
       * utilisateurs, on **refuse** de démarrer plutôt que de détruire des
       * données ; sinon (base vide ou d'essai), copie de sécurité puis reset.
       */
      let userCount = 0;
      if (hasUsersTable) {
        const row = await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM users');
        userCount = Number(row?.n ?? 0);
      }
      if (userCount > 0) {
        throw new Error(
          'La base de données existe mais son historique de migrations est absent. ' +
            "Aucune donnée n'a été supprimée. Restaurez une sauvegarde depuis le dossier " +
            `« backups » ou contactez le support (fichier : ${dbPath}).`,
        );
      }
      const copy = await safetyCopy('avant-reinitialisation');
      dbLog('[db] Base incomplète sans utilisateur — copie de sécurité :', copy);
      for (const table of tables) {
        await rawRun(`DROP TABLE IF EXISTS "${table.name.replace(/"/g, '""')}"`);
      }
    } else if (hasDrizzleTable && hasUsersTable) {
      // Sauvegarde automatique avant d'appliquer des migrations en attente (§18).
      const applied = await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM __drizzle_migrations');
      const pending = journalEntries(migrationsFolder) - Number(applied?.n ?? 0);
      const users = await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM users');
      if (pending > 0 && Number(users?.n ?? 0) > 0) {
        const copy = await safetyCopy('avant-migration');
        dbLog(`[db] ${pending} migration(s) en attente — copie de sécurité :`, copy);
      }
    }

    await migrate(db, { migrationsFolder });
    dbLog('[db] ✅ migrate() OK');

    const tablesAfter = await rawAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    );
    dbLog(
      `[db] ✅ ${tablesAfter.length} tables présentes après init:`,
      tablesAfter.map((t) => t.name).sort(),
    );

    if (!tablesAfter.some((t) => t.name === 'users')) {
      throw new Error('Table users absente après migrations');
    }

    await installSyncTriggers(dbClient);
    dbLog('[db] ✅ triggers de synchronisation en place');
  } finally {
    releaseMigrationLock();
  }

  dbLog('[db] ── initializeDatabase END ──');
}

try {
  await initializeDatabase();
} catch (error: any) {
  dbError('[db] ══ INITIALISATION DB A ÉCHOUÉ ══');
  dbError('[db]', error?.message ?? error);
  dbError('[db] Stack:', error?.stack);
  throw new Error(
    `Initialisation DB échouée : ${error?.message ?? error}\n` +
      `Voir : ${_logFilePath ?? 'db-error.log'}`,
  );
}

export { schema };
