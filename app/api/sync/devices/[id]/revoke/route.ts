import { fail, ok, requireAction } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { revokeServerDevice } from '@/lib/sync-engine';

type Params = { params: Promise<{ id: string }> };

/** POST — révoque un poste (vol, perte, remplacement) : son jeton est refusé par le serveur. */
export async function POST(_request: Request, { params }: Params) {
  try {
    const user = await requireAction('sync.manage');
    const { id } = await params;
    await revokeServerDevice(id);
    await writeAudit({ user, action: 'sync', entity: 'device', details: { révocation: id } });
    return ok({ success: true });
  } catch (error) {
    return fail(error);
  }
}
