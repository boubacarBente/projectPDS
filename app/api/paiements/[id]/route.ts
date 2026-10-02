import { NextRequest } from 'next/server';
import { fail, ok, parseId, requireAction, NotFoundError, assertStoreVisible } from '@/lib/api';
import { getReceiptData } from '@/lib/payments';
import { getStoreLetterhead } from '@/lib/stores';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/paiements/[id] — données complètes du reçu (§7, §11).
 * Un reçu reste réimprimable indéfiniment : rien n'est purgé.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('payments.view');
    const { id } = await params;

    const data = await getReceiptData(parseId(id));
    if (!data) throw new NotFoundError('Reçu introuvable');
    assertStoreVisible(user, data.payment.storeId);

    // En-tête du reçu : coordonnées du magasin qui a encaissé.
    return ok({ ...data, store: await getStoreLetterhead(data.payment.storeId) });
  } catch (error) {
    return fail(error);
  }
}
