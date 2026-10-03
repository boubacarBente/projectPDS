import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, requireActiveStore, ValidationError } from '@/lib/api';
import { setQuoteStatus } from '@/lib/quotes';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

const LABELS = { sent: 'envoyé', accepted: 'accepté', refused: 'refusé' } as const;

/** POST /api/devis/[id]/statut `{ status: 'sent' | 'accepted' | 'refused' }`. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const body = await readJson<any>(request);
    const status = body.status;
    if (status !== 'sent' && status !== 'accepted' && status !== 'refused') {
      throw new ValidationError('Statut invalide (envoyé, accepté ou refusé).');
    }
    const quote = await setQuoteStatus(parseId(id), status, storeId);
    await writeAudit({
      user,
      action: status === 'accepted' ? 'validate' : status === 'refused' ? 'reject' : 'update',
      entity: 'quote',
      entityId: quote.id,
      details: { reference: quote.reference, status: LABELS[status as keyof typeof LABELS], total: quote.total },
    });
    return ok(quote);
  } catch (error) {
    return fail(error);
  }
}
