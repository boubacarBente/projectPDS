import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, requireAction, scopeFromRequest } from '@/lib/api';
import { listReceipts, type PaymentType } from '@/lib/payments';

const PAYMENT_TYPES: PaymentType[] = ['sale', 'purchase', 'service_job', 'furniture_order'];

/**
 * GET /api/recus — **registre des reçus** (§7.7).
 *
 * Tous les paiements enregistrés, toutes origines confondues (ventes, achats,
 * prestations), avec le document réglé et son tiers. C'est ce qui manquait pour
 * consulter un reçu sans passer par la fiche du client ou du fournisseur.
 *
 * Filtres : `search` (numéro de reçu, note, **numéro de document** ou nom du
 * tiers), `type`, `paymentMethod`, `from`, `to`. Enveloppe paginée standard
 * (`{ data, total, page, limit, totalPages }`).
 *
 * Permission : `payments.view` — le registre ne fait que lire.
 *
 * Distinct de `GET /api/paiements`, qui reste la liste brute utilisée par les
 * écrans d'un client / d'un fournisseur et par l'échéancier d'un document :
 * celui-ci n'expose ni le document ni le tiers.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('payments.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const requestedType = params.get('type');
    const type =
      requestedType && PAYMENT_TYPES.includes(requestedType as PaymentType)
        ? (requestedType as PaymentType)
        : undefined;

    const result = await listReceipts({
      scope: scopeFromRequest(user, request),
      type,
      paymentMethod: params.get('paymentMethod') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      search: params.get('search') ?? undefined,
      page,
      limit,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
