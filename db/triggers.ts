/**
 * Triggers de capture des changements (synchronisation, option B).
 *
 * Pour chaque table synchronisée, trois triggers alimentent `sync_changes` :
 * insertion, modification, suppression. Ils sont créés au démarrage
 * (`CREATE TRIGGER IF NOT EXISTS`), après les migrations.
 *
 * Pourquoi des triggers plutôt qu'un appel dans le code ? Parce qu'une
 * écriture oubliée — un `UPDATE` en SQL brut, un script de reprise — ne doit
 * jamais échapper à l'envoi vers le serveur. Le trigger ne peut pas être
 * oublié.
 *
 * Pendant l'application des données reçues du serveur, `sync_state.applying`
 * vaut `'1'` : les triggers se taisent, sinon chaque ligne reçue serait
 * renvoyée au serveur en écho.
 *
 * Un quatrième trigger tient `updated_at` à jour pour les `UPDATE` en SQL brut
 * qui l'oublient : c'est l'horodatage utilisé pour arbitrer les conflits
 * (dernière écriture gagnante).
 */

import { SYNCED_TABLES } from './sync-registry';

type Executor = { execute: (stmt: string | { sql: string; args?: any[] }) => Promise<unknown> };

const NOT_APPLYING = `(SELECT value FROM sync_state WHERE key = 'applying') IS NOT '1'`;

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function upsertChange(table: string, ref: 'NEW' | 'OLD', deleted: 0 | 1): string {
  return `INSERT INTO sync_changes (table_name, sync_id, deleted, change_seq, attempts)
      VALUES ('${table}', ${ref}.sync_id, ${deleted}, (SELECT COALESCE(MAX(change_seq), 0) + 1 FROM sync_changes), 0)
      ON CONFLICT(table_name, sync_id) DO UPDATE SET
        deleted = excluded.deleted,
        change_seq = excluded.change_seq,
        attempts = 0,
        last_error = NULL;`;
}

/** Version des triggers : à incrémenter si leur corps change. */
export const TRIGGERS_VERSION = '1';

export function triggerStatements(): string[] {
  const statements: string[] = [];

  for (const table of SYNCED_TABLES) {
    const t = table.name;
    const q = quote(t);

    statements.push(`DROP TRIGGER IF EXISTS sync_ai_${t}`);
    statements.push(`DROP TRIGGER IF EXISTS sync_au_${t}`);
    statements.push(`DROP TRIGGER IF EXISTS sync_ad_${t}`);
    statements.push(`DROP TRIGGER IF EXISTS sync_ts_${t}`);

    statements.push(`CREATE TRIGGER sync_ai_${t} AFTER INSERT ON ${q}
      WHEN ${NOT_APPLYING}
      BEGIN
        ${upsertChange(t, 'NEW', 0)}
      END`);

    statements.push(`CREATE TRIGGER sync_au_${t} AFTER UPDATE ON ${q}
      WHEN ${NOT_APPLYING}
      BEGIN
        ${upsertChange(t, 'NEW', 0)}
      END`);

    statements.push(`CREATE TRIGGER sync_ad_${t} AFTER DELETE ON ${q}
      WHEN ${NOT_APPLYING}
      BEGIN
        ${upsertChange(t, 'OLD', 1)}
      END`);

    // `settings.updated_at` est historiquement en millisecondes : on ne la
    // touche pas (le moteur normalise les unités).
    if (t !== 'settings') {
      statements.push(`CREATE TRIGGER sync_ts_${t} AFTER UPDATE ON ${q}
        WHEN NEW.updated_at = OLD.updated_at AND ${NOT_APPLYING}
        BEGIN
          UPDATE ${q} SET updated_at = unixepoch() WHERE rowid = NEW.rowid;
        END`);
    }
  }

  return statements;
}

/** Installe (ou réinstalle) les triggers si leur version a changé. */
export async function installSyncTriggers(executor: Executor): Promise<void> {
  const row = (await executor.execute({
    sql: `SELECT value FROM sync_state WHERE key = 'triggers_version'`,
  })) as { rows: { value: string }[] };

  const current = row.rows?.[0]?.value;
  if (current === TRIGGERS_VERSION) {
    // Vérification de présence : une restauration peut avoir effacé les triggers.
    const count = (await executor.execute({
      sql: `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_a%'`,
    })) as { rows: { n: number }[] };
    if (Number(count.rows?.[0]?.n ?? 0) >= SYNCED_TABLES.length * 3) return;
  }

  for (const statement of triggerStatements()) {
    await executor.execute(statement);
  }

  await executor.execute({
    sql: `INSERT INTO sync_state (key, value, updated_at) VALUES ('triggers_version', ?, unixepoch())
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [TRIGGERS_VERSION],
  });
}
