import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, requireActiveStore, ValidationError } from '@/lib/api';
import { isRequestStatus, setServiceRequestStatus } from '@/lib/service-requests';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/demandes/[id]/statut `{ status, note? }` — étude, visite, devis à
 * préparer, refus. « Devis envoyé », « acceptée » et « convertie » découlent du
 * devis et ne se posent pas ici.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const body = await readJson<any>(request);
    if (!isRequestStatus(body.status)) throw new ValidationError('Statut invalide');
    const updated = await setServiceRequestStatus(parseId(id), body.status, storeId, body.note ?? null);
    await writeAudit({
      user,
      action: body.status === 'refused' ? 'reject' : 'update',
      entity: 'service_request',
      entityId: updated.id,
      details: { reference: updated.reference, status: body.status, note: body.note ?? undefined },
    });
    return ok(updated);
  } catch (error) {
    return fail(error);
  }
}
