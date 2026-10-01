/**
 * Configuration du **poste** (option B : une base locale par poste).
 *
 *  - `standalone` : installation autonome, sans serveur. Tous les magasins
 *    créés sur ce poste y sont gérés (fonctionnement historique, ou siège qui
 *    n'a pas encore de serveur).
 *  - `hq`         : poste du **siège**, inscrit au serveur central avec accès à
 *    tous les magasins. Il reçoit les opérations de tous les magasins : c'est
 *    lui qui offre la vue consolidée. Il gère le catalogue, les comptes et les
 *    paramètres globaux.
 *  - `store`      : poste d'un **magasin**, inscrit au serveur pour un seul
 *    magasin. Il ne reçoit que les référentiels communs, les opérations de son
 *    magasin et les transferts qui le concernent.
 *
 * Valeurs stockées dans `sync_state` (table locale, jamais synchronisée).
 */

import { rawAll, rawRun } from '@/db';

export type DeviceMode = 'standalone' | 'hq' | 'store';

export type DeviceConfig = {
  mode: DeviceMode;
  /** Identifiant global du poste (UUID). */
  deviceId: string | null;
  /** Nom lisible du poste. */
  deviceName: string | null;
  /** Numéro de poste dans son magasin (entre dans la numérotation : FAC-KAL1-…). */
  deviceCode: string;
  /** Magasin du poste (mode `store`), en identifiant local. */
  storeId: number | null;
  /** Magasin du poste, en identifiant global. */
  storeSyncId: string | null;
  serverUrl: string | null;
  /** Jeton d'authentification du poste auprès du serveur. */
  token: string | null;
  /** Synchronisation automatique toutes les N minutes (0 = manuelle). */
  autoSyncMinutes: number;
};

const KEYS = {
  mode: 'device_mode',
  deviceId: 'device_id',
  deviceName: 'device_name',
  deviceCode: 'device_code',
  storeId: 'device_store_id',
  storeSyncId: 'device_store_sync_id',
  serverUrl: 'server_url',
  token: 'device_token',
  autoSyncMinutes: 'auto_sync_minutes',
} as const;

let cache: { value: DeviceConfig; at: number } | null = null;
const CACHE_MS = 5_000;

export function invalidateDeviceConfig(): void {
  cache = null;
}

export async function getDeviceConfig(): Promise<DeviceConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  let rows: { key: string; value: string | null }[] = [];
  try {
    rows = await rawAll<{ key: string; value: string | null }>(
      `SELECT key, value FROM sync_state WHERE key IN (${Object.values(KEYS)
        .map(() => '?')
        .join(',')})`,
      Object.values(KEYS),
    );
  } catch {
    rows = [];
  }
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const get = (key: string) => {
    const value = map.get(key);
    return value === undefined || value === null || value === '' ? null : String(value);
  };

  const rawMode = get(KEYS.mode);
  const mode: DeviceMode = rawMode === 'hq' || rawMode === 'store' ? rawMode : 'standalone';
  const storeIdRaw = get(KEYS.storeId);

  const value: DeviceConfig = {
    mode,
    deviceId: get(KEYS.deviceId),
    deviceName: get(KEYS.deviceName),
    deviceCode: get(KEYS.deviceCode) ?? '1',
    storeId: storeIdRaw ? Number(storeIdRaw) : null,
    storeSyncId: get(KEYS.storeSyncId),
    serverUrl: get(KEYS.serverUrl),
    token: get(KEYS.token),
    autoSyncMinutes: Number(get(KEYS.autoSyncMinutes) ?? 5) || 0,
  };

  cache = { value, at: Date.now() };
  return value;
}

export async function setDeviceConfig(updates: Partial<DeviceConfig>): Promise<DeviceConfig> {
  for (const [field, key] of Object.entries(KEYS) as [keyof DeviceConfig, string][]) {
    if (!(field in updates)) continue;
    const value = updates[field];
    await rawRun(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value === null || value === undefined ? null : String(value)],
    );
  }
  invalidateDeviceConfig();
  return getDeviceConfig();
}

/** Le poste peut-il modifier les référentiels centraux (catalogue, comptes, paramètres) ? */
export async function canEditCentralData(): Promise<boolean> {
  const config = await getDeviceConfig();
  return config.mode !== 'store';
}
