import { NextRequest } from 'next/server';
import { fail, ok, readJson, requireAction } from '@/lib/api';
import { ensureDefaultSettings, getSettings, updateSettings } from '@/lib/settings';
import { getStorageInfo } from '@/lib/backup';
import { writeAudit } from '@/lib/audit';
import { LOCAL_ONLY_SETTINGS_KEYS } from '@/lib/settings-schema';

/**
 * GET /api/parametres — les paramètres typés, complétés par les valeurs par
 * défaut. `cache: 'no-store'` côté client (§9.1).
 */
export async function GET() {
  try {
    await requireAction('settings.view');
    const settings = await getSettings();
    return ok({ settings, storage: getStorageInfo() });
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/parametres — modification partielle.
 * Les clés locales (thème, couleurs, mode de synchronisation) sont acceptées
 * mais restent **propres au poste** : elles ne sont jamais synchronisées (§23.9).
 */
export async function PUT(request: NextRequest) {
  try {
    const user = await requireAction('settings.update');
    const body = await readJson<Record<string, unknown>>(request);

    // Un gérant ne peut pas modifier les réglages critiques de synchronisation.
    if (user.role !== 'admin') {
      for (const key of ['syncMode', 'syncApiUrl', 'syncDeviceId']) {
        if (key in body) delete body[key];
      }
    }

    const touched = Object.keys(body);
    const settings = await updateSettings(body as any);

    await writeAudit({
      user,
      action: 'settings',
      entity: 'settings',
      details: {
        keys: touched,
        localOnly: touched.filter((k) => (LOCAL_ONLY_SETTINGS_KEYS as string[]).includes(k)),
      },
    });

    return ok({ settings });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/parametres — écrit les valeurs par défaut manquantes. */
export async function POST() {
  try {
    const user = await requireAction('settings.update');
    await ensureDefaultSettings();
    await writeAudit({ user, action: 'settings', entity: 'settings', details: { ensured: true } });
    return ok({ settings: await getSettings() });
  } catch (error) {
    return fail(error);
  }
}
