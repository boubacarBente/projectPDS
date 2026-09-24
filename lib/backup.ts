/**
 * Sauvegarde et restauration de la base (§14, §18).
 *
 * **Sauvegarde** : `VACUUM INTO` produit une copie **cohérente et complète** en
 * un seul fichier. C'est nettement plus sûr qu'une copie du `.db` : la base
 * tourne en mode WAL, et une copie naïve du seul fichier principal peut laisser
 * de côté des transactions encore présentes dans `database.db-wal`.
 *
 * **Restauration** : la proposition Q6 était « remplacement du fichier +
 * redémarrage ». Ce module retient une méthode **plus sûre** : le fichier de
 * sauvegarde est attaché (`ATTACH DATABASE`) et ses tables sont recopiées dans
 * la base vivante, dans une transaction, **après** validation de compatibilité
 * du schéma. Trois avantages concrets :
 *   1. aucun redémarrage, donc aucune interruption de service ;
 *   2. aucun verrou de fichier Windows (remplacer un fichier SQLite ouvert
 *      échoue sur Windows — c'est le risque réel de Q6) ;
 *   3. un schéma incompatible est **refusé** au lieu d'écraser les données.
 *
 * Une copie de sécurité de la base courante est créée **avant** toute
 * restauration, et n'est jamais supprimée automatiquement.
 *
 * > **Note sur les clés étrangères.** SQLite n'applique pas les clés étrangères
 * > par défaut (`PRAGMA foreign_keys` vaut `OFF`) et ce projet conserve ce
 * > comportement, comme le projet Gaz. Les ordres de recopie et de suppression
 * > ci-dessous restent néanmoins corrects (parents d'abord à l'insertion,
 * > enfants d'abord à la suppression) : le code ne dépend donc pas du réglage.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { dbClient, getDbPath, rawAll, rawRun, withRawTransaction } from '@/db';

/** Tables à recopier, les parents avant les enfants. */
const RESTORE_ORDER = [
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
  /* Tables locales de synchronisation : restaurées aussi, sinon la file
     d'envoi et les watermarks seraient incohérents avec les données. */
  'devices',
  'sync_state',
  'sync_outbox',
  'sync_pending',
  'sync_conflicts',
];

/** Suppression : les enfants d'abord, pour rester correct même si les clés
 *  étrangères venaient à être appliquées. */
const DELETE_ORDER = [...RESTORE_ORDER].reverse();

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

/**
 * Crée une sauvegarde cohérente et renvoie son chemin et sa taille.
 * `VACUUM INTO` refuse un fichier cible existant : le nom est donc toujours
 * horodaté et unique.
 */
export async function createBackup(options: { into?: string } = {}): Promise<{
  path: string;
  size: number;
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = options.into ?? path.join(getBackupsDir(), `database-${stamp}.db`);

  // `/*turbopackIgnore: true*/` : ces appels portent sur un chemin **calculé**
  // (nom horodaté). Sans cette annotation, l'analyse statique de Turbopack
  // conclut que tout le projet peut être lu et l'embarque dans la sortie du
  // serveur — ce qui ferait grossir l'installeur Electron sans raison.
  if (fs.existsSync(/* turbopackIgnore: true */ target)) {
    fs.rmSync(/* turbopackIgnore: true */ target, { force: true });
  }

  await rawRun(`VACUUM INTO '${sqlitePathLiteral(target)}'`);

  const stat = fs.statSync(/* turbopackIgnore: true */ target);
  return { path: target, size: stat.size };
}

/**
 * Purge les **sauvegardes automatiques** au-delà de la durée de conservation
 * (Q7 : 30 jours). Les sauvegardes manuelles ne sont jamais supprimées.
 */
export async function purgeOldBackups(retentionDays = 30): Promise<number> {
  const dir = getBackupsDir();
  const limit = Date.now() - retentionDays * 86_400_000;
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

/** Sauvegarde automatique du jour, si elle n'existe pas déjà (Q7). */
export async function ensureDailyBackup(): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(getBackupsDir(), `auto-${stamp}.db`);
  if (fs.existsSync(target)) return null;

  try {
    const { path: created } = await createBackup({ into: target });
    await purgeOldBackups(30);
    return created;
  } catch (error) {
    console.error('[backup] Sauvegarde automatique impossible :', error);
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

/** Liste des tables d'un fichier SQLite attaché. */
async function tablesOf(alias: string): Promise<Set<string>> {
  const rows = await rawAll<{ name: string }>(
    `SELECT name FROM ${alias}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  );
  return new Set(rows.map((r) => r.name));
}

/** Colonnes d'une table, dans un schéma donné. */
async function columnsOf(alias: string, table: string): Promise<string[]> {
  const rows = await rawAll<{ name: string }>(`PRAGMA ${alias}.table_info("${table}")`);
  return rows.map((r) => r.name);
}

export type RestoreReport = {
  tablesRestored: string[];
  totalRows: number;
  safetyBackup: string;
  warnings: string[];
};

/**
 * Restaure une sauvegarde.
 * Validation → copie de sécurité → contrôle de compatibilité → recopie
 * transactionnelle → nettoyage.
 */
export async function restoreBackup(filePath: string): Promise<RestoreReport> {
  const inspection = inspectSqliteFile(filePath);
  if (!inspection.valid) throw new BackupError(inspection.reason ?? 'Fichier invalide');

  // Le fichier est recopié dans un répertoire de travail maîtrisé : le chemin
  // attaché n'est donc jamais dérivé du nom fourni par le client.
  const staged = path.join(getTempDir(), `restore-${Date.now()}.db`);
  fs.copyFileSync(filePath, staged);

  const alias = 'restore_src';
  const warnings: string[] = [];
  const tablesRestored: string[] = [];
  let totalRows = 0;
  let safetyBackup = '';
  let attached = false;

  try {
    await rawRun(`ATTACH DATABASE '${sqlitePathLiteral(staged)}' AS ${alias}`);
    attached = true;

    const sourceTables = await tablesOf(alias);

    if (!sourceTables.has('users')) {
      throw new BackupError(
        "Cette sauvegarde ne contient pas la table « users » : ce n'est pas une sauvegarde de Planète Déco.",
      );
    }

    // Copie de sécurité AVANT toute écriture.
    const created = await createBackup();
    safetyBackup = created.path;

    // Compatibilité du schéma : une table présente des deux côtés dont les
    // colonnes diffèrent est refusée plutôt que recopiée de travers.
    for (const table of RESTORE_ORDER) {
      if (!sourceTables.has(table)) {
        warnings.push(`Table « ${table} » absente de la sauvegarde : conservée telle quelle`);
        continue;
      }

      const destinationColumns = await columnsOf('main', table);
      if (destinationColumns.length === 0) {
        warnings.push(`Table « ${table} » absente de la base actuelle : ignorée`);
        continue;
      }

      const sourceColumns = await columnsOf(alias, table);
      const missing = destinationColumns.filter((c) => !sourceColumns.includes(c));

      if (missing.length > 0) {
        throw new BackupError(
          `Schéma incompatible pour la table « ${table} » : colonne(s) manquante(s) ${missing.join(', ')}. ` +
            'Restaurez une sauvegarde produite par cette version de l’application.',
        );
      }
    }

    // Recopie transactionnelle : soit tout passe, soit rien.
    await withRawTransaction(async (tx) => {
      for (const table of RESTORE_ORDER) {
        if (!sourceTables.has(table)) continue;

        const destinationColumns = await columnsOf('main', table);
        if (destinationColumns.length === 0) continue;

        const columnList = destinationColumns.map((c) => `"${c}"`).join(', ');

        await rawRun(`DELETE FROM main."${table}"`, [], tx);
        await rawRun(
          `INSERT INTO main."${table}" (${columnList}) SELECT ${columnList} FROM ${alias}."${table}"`,
          [],
          tx,
        );

        const count = await rawRun(`SELECT COUNT(*) AS n FROM main."${table}"`, [], tx);
        totalRows += Number((count.rows[0] as any)?.n ?? 0);
        tablesRestored.push(table);
      }
    });
  } catch (error) {
    if (attached) await rawRun(`DETACH DATABASE ${alias}`).catch(() => {});
    throw error;
  } finally {
    if (attached) await rawRun(`DETACH DATABASE ${alias}`).catch(() => {});
    try {
      fs.rmSync(staged, { force: true });
    } catch {
      /* le fichier temporaire sera purgé par le système */
    }
  }

  return { tablesRestored, totalRows, safetyBackup, warnings };
}

/**
 * Réinitialise les données métier **sans toucher aux paramètres ni aux
 * utilisateurs** : se retrouver sans compte administrateur après une
 * réinitialisation rendrait l'application inaccessible.
 */
export async function resetBusinessData(): Promise<{ tables: string[] }> {
  const cleared: string[] = [];

  await withRawTransaction(async (tx) => {
    for (const table of DELETE_ORDER) {
      if (table === 'settings' || table === 'users') continue;
      try {
        await rawRun(`DELETE FROM main."${table}"`, [], tx);
        cleared.push(table);
      } catch {
        /* table absente : rien à effacer */
      }
    }

    // Le stock repart de zéro proprement (les mouvements ont été effacés).
    await rawRun(`UPDATE main."products" SET stock = 0`, [], tx).catch(() => {});
  });

  return { tables: cleared };
}

/** Taille de la base et des sauvegardes, pour l'écran Paramètres. */
export function getStorageInfo(): {
  databasePath: string;
  databaseSize: number;
  backupsDir: string;
  backupsCount: number;
  backupsSize: number;
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
    /* dossier illisible : on renvoie zéro */
  }

  return { databasePath: dbPath, databaseSize, backupsDir, backupsCount, backupsSize };
}

/** Ferme proprement la connexion (arrêt de l'application, remplacement). */
export async function closeDatabase(): Promise<void> {
  try {
    dbClient.close();
  } catch {
    /* déjà fermée */
  }
}
