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
import { eq } from 'drizzle-orm';
import {
  DEFAULT_SETTINGS,
  deserializeSetting,
  fromDbKey,
  serializeSetting,
  toDbKey,
  type Settings,
} from '@/lib/settings-schema';

export type { Settings } from '@/lib/settings-schema';
export {
  DEFAULT_SETTINGS,
  LOCAL_ONLY_SETTINGS_KEYS,
  toDbKey,
  fromDbKey,
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

/** Applique le gabarit de numérotation (Q1 : `{PREFIX}-{YYYY}-{NNNNNN}`). */
export function renderDocumentNumber(
  prefix: string,
  sequence: number,
  template: string,
  year = new Date().getFullYear(),
): string {
  return template
    .replace('{PREFIX}', prefix)
    .replace('{YYYY}', String(year))
    .replace('{YY}', String(year).slice(-2))
    .replace('{NNNNNN}', String(sequence).padStart(6, '0'))
    .replace('{NNNN}', String(sequence).padStart(4, '0'));
}

/**
 * Compteur atomique de numérotation, stocké dans `settings` sous la clé
 * technique `seq_<nom>_<année>` — donc **sans trou** et **sans table dédiée**.
 */
export async function nextSequence(name: string, year = new Date().getFullYear()): Promise<number> {
  const key = `seq_${name}_${year}`;
  const row = await db.select().from(settingsTable).where(eq(settingsTable.key, key)).limit(1);
  const current = row[0] ? Number(row[0].value) : 0;
  const next = Number.isFinite(current) ? current + 1 : 1;

  await rawRun(
    `INSERT INTO settings (key, value, updated_at, sync_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(next), Date.now(), crypto.randomUUID()],
  );

  return next;
}

/** Numéro de document prêt à l'emploi, selon le type de pièce. */
export async function nextDocumentNumber(
  kind: 'invoice' | 'purchase' | 'receipt' | 'job' | 'brick' | 'furniture',
): Promise<string> {
  const settings = await getSettings();

  const prefix = {
    invoice: settings.invoicePrefix,
    purchase: settings.purchasePrefix,
    receipt: settings.receiptPrefix,
    job: settings.jobPrefix,
    brick: settings.brickPrefix,
    furniture: settings.furniturePrefix,
  }[kind];

  const sequence = await nextSequence(kind);
  return renderDocumentNumber(prefix, sequence, settings.invoiceNumberFormat);
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
