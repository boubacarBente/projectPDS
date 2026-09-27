import { NextRequest } from 'next/server';
import { fail, ok, parseId, requireAction } from '@/lib/api';
import { validateSalesInvoice } from '@/lib/sales';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/ventes/[id]/valider — passage `draft` → `active` (§10.6).
 *
 * C'est le **seul** chemin de validation d'un brouillon. Le corps de la requête
 * est ignoré : les lignes, les instantanés et les totaux sont déjà figés en
 * base, la validation ne redemande donc aucune ressaisie au poste (contrairement
 * à `PUT /api/ventes/[id]`, qui exige le document complet).
 *
 * Permission : `sales.update` — valider sort définitivement le stock, c'est le
 * même pouvoir que corriger une vente existante.
 *
 * Effets : contrôle de stock préalable (refus si rupture), un mouvement `exit`
 * par ligne, recalcul du statut de paiement, journal d'actions
 * (`action = validate`). Aucun encaissement n'est créé : il s'enregistre
 * ensuite via `POST /api/paiements`, désormais refusé tant que la vente est un
 * brouillon.
 *
 * Réponse : `{ success: true, invoice: SalesInvoiceRow }`.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('sales.update');
    const { id } = await params;

    const invoice = await validateSalesInvoice(parseId(id), user);

    return ok({ success: true, invoice });
  } catch (error) {
    return fail(error);
  }
}
