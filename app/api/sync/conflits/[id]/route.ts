import { NextRequest } from 'next/server';
import { ValidationError, fail, ok, parseId, readJson, requireAction } from '@/lib/api';
import { resolveConflict } from '@/lib/sync-engine';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** POST `{ resolution: 'local' | 'remote' }` — arbitrage d'un conflit, tracé dans l'audit. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('sync.manage');
    const { id } = await params;
    const conflictId = parseId(id);
    const body = await readJson<{ resolution?: unknown }>(request);
    if (body.resolution !== 'local' && body.resolution !== 'remote') {
      throw new ValidationError('Résolution attendue : « local » ou « remote »');
    }
    await resolveConflict(conflictId, body.resolution, user.id);
    await writeAudit({ user, action: 'sync', entity: 'sync', entityId: conflictId, details: { résolution: body.resolution } });
    return ok({ success: true });
  } catch (error) {
    return fail(error);
  }
}
