/*
 * Applique les migrations Drizzle sur la base locale **sans démarrer Next**.
 *
 * Pourquoi un script : les migrations sont normalement jouées au chargement de
 * `db/index.ts` (donc au démarrage du serveur Next). Après un changement de
 * schéma, il faut pouvoir mettre la base à jour avant de lancer les scripts de
 * vérification HTTP (`npm run verify:*`) — sinon ils interrogent un schéma en
 * retard sur le code et échouent pour une mauvaise raison.
 *
 * Usage : node scripts/db-migrate.cjs
 */
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client/sqlite3');
const { drizzle } = require('drizzle-orm/libsql/sqlite3');
const { migrate } = require('drizzle-orm/libsql/migrator');

async function main() {
  const dbPath = process.env.PDS_DB_PATH
    ? path.resolve(process.env.PDS_DB_PATH)
    : process.env.ELECTRON_APP_PATH
    ? path.join(process.env.ELECTRON_APP_PATH, 'database.db')
    : path.join(process.cwd(), 'db', 'database.db');

  const migrationsFolder = path.join(process.cwd(), 'db', 'migrations');

  if (!fs.existsSync(migrationsFolder)) {
    throw new Error(`Dossier de migrations introuvable : ${migrationsFolder}`);
  }

  const client = createClient({ url: `file:${dbPath.replace(/\\/g, '/')}`, intMode: 'number' });
  const db = drizzle(client);

  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA busy_timeout = 5000');

  console.log(`[migrations] base : ${dbPath}`);
  await migrate(db, { migrationsFolder });

  const applied = await client.execute(
    'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at',
  );
  console.log(`[migrations] ${applied.rows.length} migration(s) appliquée(s).`);
  console.log('[migrations] ok');
  client.close();
}

main().catch((error) => {
  console.error('[migrations] echec :', error?.message ?? error);
  process.exit(1);
});
