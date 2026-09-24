import { NextRequest } from 'next/server';
import { ValidationError, fail, ok, parseId, readJson, requireAction } from '@/lib/api';
import { resolveConflict } from '@/lib/sync-export';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sync/conflits/[id] — arbitrage humain d'un conflit (§23.7).
 *
 * Corps : `{ resolution: 'local' | 'remote' }`.
 *
 *  - `local`  : la version du poste est conservée (le conflit est refermé) ;
 *  - `remote` : la version reçue est appliquée à la ligne locale, **par
 *    `sync_id`**, puis le conflit est refermé.
 *
 * Dans les deux cas, `resolved_at` et `resolved_by` sont horodatés et la
 * version perdante reste archivée dans `sync_conflicts` : l'arbitrage est
 * tracé, jamais effacé (§23.12 : « pas de résolution automatique »).
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('sync.manage');
    const { id } = await params;
    const conflictId = parseId(id);
    const body = await readJson<{ resolution?: unknown }>(request);

    const resolution = body.resolution;

    if (resolution !== 'local' && resolution !== 'remote') {
      throw new ValidationError('Résolution attendue : « local » ou « remote »');
    }

    const result = await resolveConflict(conflictId, resolution, user.id);

    await writeAudit({
      user,
      action: 'update',
      entity: 'sync',
      entityId: conflictId,
      details: { action: 'resolve_conflict', resolution, applied: result.applied },
    });

    return ok({
      success: true,
      ...result,
      message:
        resolution === 'remote'
          ? result.applied
            ? 'La version distante a été appliquée à la ligne locale.'
            : 'Conflit refermé : la ligne locale n’existait plus, rien n’a été appliqué.'
          : 'La version locale est conservée ; le conflit est refermé.',
    });
  } catch (error) {
    return fail(error);
  }
}
