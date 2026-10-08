/*
 * Génère `docs/schema.dbml` : le schéma de la base au format DBML, à coller
 * dans https://dbdiagram.io (ou tout outil DBML) pour obtenir le diagramme.
 *
 * Pourquoi un générateur : le schéma vit dans `db/schema.ts` (Drizzle) ; un
 * diagramme recopié à la main serait faux à la première migration. Ici tout est
 * lu dans les tables Drizzle elles-mêmes (colonnes, clés, index, liens).
 *
 * Seuls les liens déclarés en `references()` apparaissent : c'est voulu, ce
 * sont aussi les seuls que la synchronisation traduit (AGENTS.md, invariant 20).
 *
 * Usage : node scripts/schema-dbml.mjs            (sans les 4 colonnes de synchronisation)
 *         node scripts/schema-dbml.mjs --complet  (avec sync_id, updated_at, deleted_at, origin_device_id)
 *         node scripts/schema-dbml.mjs --check    (échoue si docs/schema.dbml est périmé)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { is, SQL } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = await import(pathToFileURL(path.join(root, 'db', 'schema.ts')).href);
const complet = process.argv.includes('--complet');

// Présentes sur chaque table métier (README §6.7) : elles noient le diagramme
// sans rien apprendre sur les liens. Une note de table rappelle leur existence.
const SYNC_COLUMNS = new Set(['sync_id', 'updated_at', 'deleted_at', 'origin_device_id']);

// Regroupement par domaine (TableGroup). Une table qui ne correspond à aucun
// motif tombe dans « Autres » : une nouvelle table n'est jamais perdue.
const GROUPS = [
  ['Ventes', '#2563eb', [/^sales_/, /^customers$/]],
  ['Achats', '#7c3aed', [/^purchase_/, /^suppliers$/]],
  ['Caisse et depenses', '#059669', [/^cash_/, /^payments$/, /^expenses$/]],
  ['Produits et stock', '#d97706', [/^products$/, /^product_stocks$/, /^categories$/, /^stock_/, /^inventor/]],
  ['Chantiers', '#dc2626', [/^service/, /^job_/, /^quote/, /^workers$/]],
  ['Atelier', '#92400e', [/^furniture_/]],
  ['Briqueterie', '#9f1239', [/^brick_/]],
  ['Magasins et comptes', '#0891b2', [/^stores$/, /^users$/, /^user_/, /^sessions$/, /^login_attempts$/, /^audit_logs$/, /^settings$/, /^doc_sequences$/, /^report_deliveries$/]],
  ['Synchronisation', '#475569', [/^devices$/, /^sync_/]],
];

const ident = (name) => (/^[A-Za-z_]\w*$/.test(name) ? name : JSON.stringify(name));
const str = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function sqlText(value) {
  // Un défaut `sql\`...\`` est une suite de fragments : on recolle le texte brut.
  return value.queryChunks
    .map((c) => (typeof c === 'string' ? c : Array.isArray(c?.value) ? c.value.join('') : ''))
    .join('');
}

function defaultSetting(col) {
  if (!col.hasDefault || col.default === undefined) return null; // $defaultFn : calculé en JS, rien à montrer
  const d = col.default;
  if (is(d, SQL)) return `default: \`${sqlText(d)}\``;
  if (typeof d === 'number') return `default: ${d}`;
  if (typeof d === 'boolean') return `default: ${d}`;
  if (d instanceof Date) return null;
  return `default: ${str(d)}`;
}

const tables = Object.values(schema)
  .filter((v) => is(v, SQLiteTable))
  .map((t) => getTableConfig(t))
  .sort((a, b) => a.name.localeCompare(b.name));

const enums = [];
const blocks = [];
const refs = [];

for (const t of tables) {
  const lines = [];
  let hidden = 0;
  // Seulement le jeu complet de `syncCols()` : `sync_changes` a son propre
  // `sync_id`, qui fait partie de sa clé primaire.
  const hideSync = !complet && [...SYNC_COLUMNS].every((n) => t.columns.some((c) => c.name === n));

  for (const col of t.columns) {
    if (hideSync && SYNC_COLUMNS.has(col.name)) {
      hidden++;
      continue;
    }
    let type = col.getSQLType();
    if (col.enumValues?.length && col.columnType === 'SQLiteText') {
      const enumName = `${t.name}_${col.name}`;
      enums.push(`Enum ${ident(enumName)} {\n${col.enumValues.map((v) => `  ${JSON.stringify(v)}`).join('\n')}\n}`);
      type = ident(enumName);
    }
    const settings = [];
    if (col.primary) settings.push('pk');
    if (col.primary && col.autoIncrement) settings.push('increment');
    if (col.notNull && !col.primary) settings.push('not null');
    if (col.isUnique) settings.push('unique');
    const def = defaultSetting(col);
    if (def) settings.push(def);
    lines.push(`  ${ident(col.name)} ${type}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
  }

  const indexLines = [];
  if (t.primaryKeys.length) {
    for (const pk of t.primaryKeys) indexLines.push(`    (${pk.columns.map((c) => ident(c.name)).join(', ')}) [pk]`);
  }
  for (const idx of t.indexes) {
    const cols = idx.config.columns.map((c) => (c?.name ? ident(c.name) : null));
    if (cols.some((c) => c === null)) continue; // index sur expression : non représentable en DBML
    const settings = [`name: ${str(idx.config.name)}`];
    if (idx.config.unique) settings.push('unique');
    indexLines.push(`    (${cols.join(', ')}) [${settings.join(', ')}]`);
  }
  for (const u of t.uniqueConstraints) {
    if (u.columns.length < 2) continue; // déjà porté par `unique` sur la colonne
    indexLines.push(`    (${u.columns.map((c) => ident(c.name)).join(', ')}) [unique]`);
  }
  if (indexLines.length) lines.push('', '  Indexes {', ...indexLines, '  }');
  if (hidden) lines.push('', `  Note: ${str(`+ ${hidden} colonnes de synchronisation (sync_id, updated_at, deleted_at, origin_device_id)`)}`);

  blocks.push(`Table ${ident(t.name)} {\n${lines.join('\n')}\n}`);

  for (const fk of t.foreignKeys) {
    const r = fk.reference();
    const from = r.columns.map((c) => ident(c.name));
    const to = r.foreignColumns.map((c) => ident(c.name));
    const target = getTableConfig(r.foreignTable).name;
    const fmt = (cols) => (cols.length === 1 ? cols[0] : `(${cols.join(', ')})`);
    const actions = [];
    if (fk.onDelete && fk.onDelete !== 'no action') actions.push(`delete: ${fk.onDelete}`);
    if (fk.onUpdate && fk.onUpdate !== 'no action') actions.push(`update: ${fk.onUpdate}`);
    refs.push(`Ref: ${ident(t.name)}.${fmt(from)} > ${ident(target)}.${fmt(to)}${actions.length ? ` [${actions.join(', ')}]` : ''}`);
  }
}

const grouped = new Map(GROUPS.map(([name]) => [name, []]));
grouped.set('Autres', []);
for (const t of tables) {
  const g = GROUPS.find(([, , patterns]) => patterns.some((p) => p.test(t.name)));
  grouped.get(g ? g[0] : 'Autres').push(t.name);
}
const colors = Object.fromEntries(GROUPS.map(([n, c]) => [n, c]));
const groupBlocks = [...grouped]
  .filter(([, names]) => names.length)
  .map(([name, names]) => `TableGroup ${JSON.stringify(name)} [color: ${colors[name] ?? '#64748b'}] {\n${names.map((n) => `  ${ident(n)}`).join('\n')}\n}`);

const output =
  `// Fichier généré par \`npm run db:dbml\` depuis db/schema.ts — ne pas modifier.\n` +
  `// À coller dans https://dbdiagram.io pour obtenir le diagramme.\n` +
  `// ${tables.length} tables, ${refs.length} liens${complet ? '' : ' ; colonnes de synchronisation masquées (--complet pour les voir)'}.\n\n` +
  `Project planete_deco {\n  database_type: 'SQLite'\n  Note: 'Gestion commerciale Planète Déco Sarlu — base locale de chaque poste (Drizzle ORM)'\n}\n\n` +
  [...enums, ...blocks, ...refs.length ? [refs.join('\n')] : [], ...groupBlocks].join('\n\n') +
  '\n';

const target = path.join(root, 'docs', 'schema.dbml');
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  } catch {}
  if (current !== output) {
    console.error('docs/schema.dbml est périmé : lancez « npm run db:dbml ».');
    process.exit(1);
  }
  console.log('docs/schema.dbml à jour.');
} else {
  writeFileSync(target, output);
  console.log(`docs/schema.dbml : ${tables.length} tables, ${refs.length} liens, ${enums.length} énumérations.`);
}
