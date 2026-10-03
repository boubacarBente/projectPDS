import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, requireActiveStore, ValidationError } from '@/lib/api';
import { isServiceStatus, setServiceStatus } from '@/lib/services';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

const LABELS = { active: 'réactivée', inactive: 'désactivée', archived: 'archivée' } as const;

/**
 * POST /api/prestations/[id]/statut `{ status }` — activer, désactiver,
 * archiver. Il n'existe pas de suppression : l'historique des devis et
 * chantiers qui l'utilisent reste intact.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('services.manage');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const body = await readJson<any>(request);
    if (!isServiceStatus(body.status)) throw new ValidationError('Statut invalide (active, inactive ou archived).');

    const service = await setServiceStatus(parseId(id), body.status, storeId);
    await writeAudit({
      user,
      action: 'update',
      entity: 'service',
      entityId: service.id,
      details: { code: service.code, name: service.name, status: LABELS[body.status as keyof typeof LABELS] },
    });
    return ok(service);
  } catch (error) {
    return fail(error);
  }
}
