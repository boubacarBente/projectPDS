import { NextRequest } from 'next/server';
import { fail, ok, parseId, requireAction, requireActiveStore } from '@/lib/api';
import { duplicateQuote } from '@/lib/quotes';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/devis/[id]/dupliquer — nouvelle version en brouillon (refus,
 * expiration, révision). Les prix repartent du catalogue **du jour** :
 * l'ancien devis, lui, garde ses prix.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.create');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const quote = await duplicateQuote(parseId(id), storeId, user.id);
    await writeAudit({
      user,
      action: 'create',
      entity: 'quote',
      entityId: quote.id,
      details: { reference: quote.reference, duplicatedFrom: parseId(id), total: quote.total },
    });
    return ok(quote, 201);
  } catch (error) {
    return fail(error);
  }
}
