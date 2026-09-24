import {
  createClient,
  type Client,
  type InArgs,
  type ResultSet,
  type Transaction,
} from '@libsql/client/sqlite3';
import { drizzle } from 'drizzle-orm/libsql/sqlite3';
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

export const db = drizzle(dbClient, { schema });

export async function rawExecute(
  sql: string,
  args: InArgs = [],
  executor: RawExecutor = dbClient,
): Promise<ResultSet> {
  return executor.execute({ sql, args });
}

export async function rawGet<T = Record<string, unknown>>(
  sql: string,
  args: InArgs = [],
  executor: RawExecutor = dbClient,
): Promise<T | undefined> {
  const result = await rawExecute(sql, args, executor);
  return result.rows[0] as T | undefined;
}

export async function rawAll<T = Record<string, unknown>>(
  sql: string,
  args: InArgs = [],
  executor: RawExecutor = dbClient,
): Promise<T[]> {
  const result = await rawExecute(sql, args, executor);
  return result.rows as T[];
}

export async function rawRun(
  sql: string,
  args: InArgs = [],
  executor: RawExecutor = dbClient,
): Promise<ResultSet> {
  return rawExecute(sql, args, executor);
}

export async function withRawTransaction<T>(
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tx = await dbClient.transaction('write');
  try {
    const result = await callback(tx);
    await tx.commit();
    return result;
  } catch (error) {
    if (!tx.closed) {
      await tx.rollback().catch(() => {});
    }
    throw error;
  } finally {
    if (!tx.closed) {
      tx.close();
    }
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
      dbLog('[db] DB existante incomplète ou sans tracking Drizzle — reset complet');
      for (const table of tables) {
        await rawRun(`DROP TABLE IF EXISTS "${table.name.replace(/"/g, '""')}"`);
      }
      dbLog('[db] Tables supprimées, ré-application des migrations...');
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
