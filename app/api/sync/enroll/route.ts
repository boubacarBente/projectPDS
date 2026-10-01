import { fail, ok, readJson, requireAction, ValidationError } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { enrollDevice, unenrollDevice, syncNow } from '@/lib/sync-engine';

/**
 * POST /api/sync/enroll — inscrit ce poste au serveur central.
 *  - siège : `{ serverUrl, deviceName, masterKey }`
 *  - magasin : `{ serverUrl, deviceName, code }` (code généré par le siège)
 *
 * DELETE — déconnecte le poste (les données locales sont conservées).
 */
export async function POST(request: Request) {
  try {
    const user = await requireAction('sync.manage');
    const body = await readJson<Record<string, unknown>>(request);
    const config = await enrollDevice({
      serverUrl: String(body.serverUrl ?? ''),
      deviceName: String(body.deviceName ?? ''),
      masterKey: body.masterKey ? String(body.masterKey) : undefined,
      code: body.code ? String(body.code) : undefined,
    });
    await writeAudit({
      user,
      action: 'sync',
      entity: 'device',
      details: { inscription: config.mode, serveur: config.serverUrl, poste: config.deviceName },
    });
    const first = await syncNow();
    return ok({ device: { ...config, token: undefined }, firstSync: first });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE() {
  try {
    const user = await requireAction('sync.manage');
    const config = await unenrollDevice();
    await writeAudit({ user, action: 'sync', entity: 'device', details: { déconnexion: true } });
    if (!config) throw new ValidationError('Déconnexion impossible');
    return ok({ device: { ...config, token: undefined } });
  } catch (error) {
    return fail(error);
  }
}
