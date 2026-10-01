import { fail, ok, requireAction } from '@/lib/api';
import { listServerDevices } from '@/lib/sync-engine';

/** GET /api/sync/devices — postes inscrits au serveur (siège uniquement). */
export async function GET() {
  try {
    await requireAction('sync.manage');
    return ok({ data: await listServerDevices() });
  } catch (error) {
    return fail(error);
  }
}
