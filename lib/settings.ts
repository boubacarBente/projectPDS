/**
 * Accès aux paramètres **côté serveur**.
 *
 * Le stockage est un couple `key` / `value` : ajouter un réglage ne demande
 * **aucune migration** (§6.1, §9). Ce module rétablit le typage et les valeurs
 * par défaut, ce qui permet de reprendre le front du projet Gaz sans
 * modification.
 *
 * Les types, valeurs par défaut et règles de sérialisation vivent dans
 * `lib/settings-schema.ts` — volontairement sans dépendance à la base, pour que
 * le `SettingsProvider` (composant client) puisse les importer sans entraîner
 * `@libsql/client` dans le bundle navigateur.
 */

import { db, rawAll, rawRun } from '@/db';
import { settings as settingsTable } from '@/db/schema';
import {
  DEFAULT_SETTINGS,
  deserializeSetting,
  fromDbKey,
  serializeSetting,
  toDbKey,
  renderDocumentNumber,
  type Settings,
} from '@/lib/settings-schema';

export type { Settings } from '@/lib/settings-schema';
export {
  DEFAULT_SETTINGS,
  LOCAL_ONLY_SETTINGS_KEYS,
  toDbKey,
  fromDbKey,
  renderDocumentNumber,
} from '@/lib/settings-schema';

/** Lit les paramètres typés, complétés par les valeurs par défaut. */
export async function getSettings(): Promise<Settings> {
  let rows: { key: string; value: string }[] = [];

  try {
    rows = await rawAll<{ key: string; value: string }>('SELECT key, value FROM settings');
  } catch {
    // Table absente (avant migration) → valeurs par défaut, jamais d'exception :
    // une page doit pouvoir s'afficher même sur une base neuve.
    return { ...DEFAULT_SETTINGS };
  }

  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    const appKey = fromDbKey(row.key) as keyof Settings;
    // Les clés techniques (`seq_...`) et inconnues sont ignorées ici.
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, appKey)) continue;
    result[appKey] = deserializeSetting(appKey, row.value);
  }

  return result as Settings;
}

/** Écrit une ligne de réglage (insertion ou mise à jour). */
async function writeSettingRow(key: keyof Settings, value: unknown): Promise<void> {
  await rawRun(
    `INSERT INTO settings (key, value, updated_at, sync_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [toDbKey(key), serializeSetting(key, value), Date.now(), crypto.randomUUID()],
  );
}

/**
 * Enregistre une modification partielle.
 * Seules les clés connues de `DEFAULT_SETTINGS` sont écrites : une clé inconnue
 * est ignorée plutôt que de polluer la table.
 */
export async function updateSettings(updates: Partial<Settings>): Promise<Settings> {
  const entries = Object.entries(updates).filter(([key]) =>
    Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key),
  );

  for (const [key, value] of entries) {
    await writeSettingRow(key as keyof Settings, value);
  }

  return getSettings();
}

/** Écrit les valeurs par défaut manquantes (premier lancement). */
export async function ensureDefaultSettings(): Promise<void> {
  let existing: { key: string }[] = [];

  try {
    existing = await rawAll<{ key: string }>('SELECT key FROM settings');
  } catch {
    return;
  }

  const known = new Set(existing.map((r) => r.key));

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const dbKey = toDbKey(key);
    if (known.has(dbKey)) continue;
    await db
      .insert(settingsTable)
      .values({ key: dbKey, value: serializeSetting(key as keyof Settings, value) })
      .onConflictDoNothing();
  }
}

/** Un réglage précis, avec sa valeur par défaut garantie. */
export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  const all = await getSettings();
  return all[key];
}

/**
 * Compteur de numérotation **atomique**, local au poste (`doc_sequences`).
 *
 * Correctif : l'ancien compteur lisait puis réécrivait la valeur — deux
 * requêtes simultanées obtenaient le même numéro. L'incrément se fait
 * désormais en une seule instruction (`UPSERT … RETURNING`).
 */
export async function nextSequence(name: string, year = new Date().getFullYear()): Promise<number> {
  const key = `${name}:${year}`;
  const row = await rawAll<{ value: number }>(
    `INSERT INTO doc_sequences (key, value) VALUES (?, 1)
     ON CONFLICT(key) DO UPDATE SET value = value + 1
     RETURNING value`,
    [key],
  );
  return Number(row[0]?.value ?? 1);
}

export type DocumentKind = 'invoice' | 'purchase' | 'receipt' | 'job' | 'quote' | 'request' | 'transfer' | 'inventory' | 'furniture' | 'brick' | 'brick_order';

/** Table et colonne portant le numéro, pour vérifier qu'il est libre. */
const DOCUMENT_TARGETS: Record<DocumentKind, { table: string; column: string }> = {
  invoice: { table: 'sales_invoices', column: 'invoice_number' },
  purchase: { table: 'purchase_invoices', column: 'reference' },
  receipt: { table: 'payments', column: 'receipt_number' },
  job: { table: 'service_jobs', column: 'reference' },
  quote: { table: 'quotes', column: 'reference' },
  request: { table: 'service_requests', column: 'reference' },
  transfer: { table: 'stock_transfers', column: 'reference' },
  inventory: { table: 'inventories', column: 'reference' },
  furniture: { table: 'furniture_orders', column: 'order_number' },
  brick: { table: 'brick_productions', column: 'batch_number' },
  brick_order: { table: 'brick_orders', column: 'order_number' },
};

/** Étiquette de magasin dans les numéros : code du magasin + numéro de poste. */
export async function storeNumberTag(storeId: number | null | undefined): Promise<string> {
  if (!storeId) return '';
  const store = await rawAll<{ code: string }>(`SELECT code FROM stores WHERE id = ?`, [storeId]);
  const code = store[0]?.code ?? '';
  const device = await rawAll<{ value: string | null }>(
    `SELECT value FROM sync_state WHERE key = 'device_code'`,
  );
  const deviceCode = String(device[0]?.value ?? '').trim();
  return `${code}${deviceCode}`;
}

/**
 * Numéro de document prêt à l'emploi, **propre au magasin et au poste** :
 * `FAC-KAL3-2026-000042`. Unique à l'échelle de l'entreprise, même quand
 * plusieurs postes travaillent hors ligne (§9).
 *
 * Si le numéro existe déjà (base restaurée, poste réinstallé qui a reçu
 * l'historique du serveur), on avance jusqu'au premier numéro libre.
 */
export async function nextDocumentNumber(kind: DocumentKind, storeId?: number | null): Promise<string> {
  const settings = await getSettings();

  const prefix = {
    invoice: settings.invoicePrefix,
    purchase: settings.purchasePrefix,
    receipt: settings.receiptPrefix,
    job: settings.jobPrefix,
    quote: settings.quotePrefix,
    request: settings.requestPrefix,
    transfer: settings.transferPrefix,
    inventory: settings.inventoryPrefix,
    furniture: settings.furniturePrefix,
    brick: settings.brickPrefix,
    brick_order: settings.brickOrderPrefix,
  }[kind];

  const tag = await storeNumberTag(storeId);
  const year = new Date().getFullYear();
  const target = DOCUMENT_TARGETS[kind];

  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const sequence = await nextSequence(`${kind}:${storeId ?? 0}`, year);
    const number = renderDocumentNumber(prefix, sequence, settings.invoiceNumberFormat, year, tag);
    const taken = await rawAll(
      `SELECT 1 FROM ${target.table} WHERE ${target.column} = ? LIMIT 1`,
      [number],
    );
    if (taken.length === 0) return number;
  }
  throw new Error('Numérotation impossible : trop de numéros déjà utilisés');
}
/**
 * Enregistre le logo en base64 dans `settings` (§7 : logo sur les factures).
 * Le README §23.12 précise que les fichiers binaires ne sont pas synchronisés
 * **hors logo** : c'est donc le seul binaire admis dans `settings`.
 */
export async function saveCompanyLogo(dataUrl: string): Promise<void> {
  if (!dataUrl.startsWith('data:image/')) {
    throw new Error('Le logo doit être une image (PNG, JPEG, WebP ou SVG)');
  }
  // Garde-fou : un logo de plus de 2 Mo alourdirait chaque document imprimé.
  if (dataUrl.length > 2_800_000) {
    throw new Error('Le logo est trop volumineux (2 Mo maximum)');
  }
  await updateSettings({ companyLogo: dataUrl });
}
