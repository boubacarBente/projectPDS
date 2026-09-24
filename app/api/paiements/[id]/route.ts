import { NextRequest } from 'next/server';
import { fail, ok, parseId, requireAction, NotFoundError } from '@/lib/api';
import { getReceiptData } from '@/lib/payments';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/paiements/[id] — données complètes du reçu (§7, §11).
 * Un reçu reste réimprimable indéfiniment : rien n'est purgé.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('payments.view');
    const { id } = await params;

    const data = await getReceiptData(parseId(id));
    if (!data) throw new NotFoundError('Reçu introuvable');

    return ok(data);
  } catch (error) {
    return fail(error);
  }
}
