/*
 * Génère `server/sync-scopes.mjs` : la portée de chaque table synchronisée,
 * tirée de `db/sync-registry.ts` (source unique).
 *
 * Pourquoi : le serveur central (paquet séparé, image Docker) ne peut pas
 * importer le TypeScript de l'application. Sans cette table, il croyait la
 * portée **déclarée** par le poste : un poste de magasin pouvait écrire des
 * paiements, mouvements de caisse ou de stock au nom d'un autre magasin
 * (revue de sécurité du 4 octobre 2026).
 *
 * Usage : node scripts/sync-scopes.mjs          (écrit le fichier)
 *         node scripts/sync-scopes.mjs --check  (échoue s'il est périmé)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SYNCED_TABLES } = await import(pathToFileURL(path.join(root, 'db', 'sync-registry.ts')).href);

const scopes = SYNCED_TABLES.map((t) => [t.name, t.scope]);
const output =
  `// Fichier généré par \`npm run sync:scopes\` depuis db/sync-registry.ts — ne pas modifier.\n` +
  `// Ordre = ordre d'application : les parents avant les enfants.\n` +
  `export const TABLE_SCOPES = new Map([\n${scopes.map((s) => `  ${JSON.stringify(s)}`).join(',\n')},\n]);\n`;

const target = path.join(root, 'server', 'sync-scopes.mjs');
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  } catch {}
  if (current !== output) {
    console.error('server/sync-scopes.mjs est périmé : lancez « npm run sync:scopes ».');
    process.exit(1);
  }
  console.log('server/sync-scopes.mjs à jour.');
} else {
  writeFileSync(target, output);
  console.log(`server/sync-scopes.mjs : ${scopes.length} tables.`);
}
