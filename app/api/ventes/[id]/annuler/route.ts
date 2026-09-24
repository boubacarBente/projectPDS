import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction } from '@/lib/api';
import { cancelSalesInvoice } from '@/lib/sales';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/ventes/[id]/annuler — alias explicite de `DELETE /api/ventes/[id]`
 * (§10.6, §27.2).
 *
 * Réservé aux rôles **admin** et **gérant** : `sales.cancel` est la seule
 * permission qui autorise à inverser des mouvements de stock et à contre-passer
 * une entrée de caisse. Le motif est obligatoire, la facture n'est **jamais**
 * supprimée — elle passe en `cancelled` avec `cancel_reason`, `cancelled_by` et
 * `cancelled_at`.
 *
 * Réponse : `{ success: true, invoice: SalesInvoiceRow }`.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('sales.cancel');
    const { id } = await params;
    const invoiceId = parseId(id);

    let reason = request.nextUrl.searchParams.get('reason') ?? '';
    try {
      const body = await readJson<any>(request);
      if (body?.reason !== undefined) reason = String(body.reason ?? '');
    } catch {
      // Corps absent : `cancelSalesInvoice` refusera un motif vide (400).
    }

    const invoice = await cancelSalesInvoice(invoiceId, reason, user);

    return ok({ success: true, invoice });
  } catch (error) {
    return fail(error);
  }
}
