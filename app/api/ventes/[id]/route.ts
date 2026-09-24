import { NextRequest } from 'next/server';
import {
  NotFoundError,
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
} from '@/lib/api';
import { requirePermission } from '@/lib/permissions';
import { cancelSalesInvoice, getSalesInvoice, parseSalesInput, updateSalesInvoice } from '@/lib/sales';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/ventes/[id] — facture complète (§7.7).
 *
 * Une facture reste consultable et réimprimable indéfiniment, même annulée :
 * les lignes portent leurs **instantanés** (`product_code`, `product_name`,
 * `unit`) et ne dépendent donc pas de l'état actuel du catalogue.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('sales.view');
    const { id } = await params;

    const detail = await getSalesInvoice(parseId(id));
    if (!detail) throw new NotFoundError('Facture introuvable');

    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/ventes/[id] — modification (§10.6).
 *
 * Les totaux sont recalculés, le stock est ajusté **par différence** (par
 * produit) et seul un complément d'encaissement peut être ajouté — jamais un
 * encaissement supprimé.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('sales.update');
    const { id } = await params;
    const body = await readJson<any>(request);

    const invoice = await updateSalesInvoice(parseId(id), {
      ...parseSalesInput(body),
      userId: user.id,
    });

    return ok({ invoice });
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/ventes/[id] — **annulation**, jamais une suppression physique
 * (§10.6, §26.13).
 *
 * Le motif est obligatoire (`{ "reason": "…" }`, ou `?reason=…`) : sans lui,
 * l'historique serait inexploitable et la contre-passation de caisse
 * injustifiable.
 *
 * Permissions : `sales.view` pour lire l'état de la facture, puis
 *  - `sales.delete` pour un **brouillon** — qui n'a ni mouvement de stock ni
 *    écriture de caisse, donc rien à contre-passer ;
 *  - `sales.cancel` (admin / gérant) pour une vente **validée**, dont le stock
 *    est réintégré et la caisse contre-passée.
 *
 * Dans les deux cas la facture passe en `cancelled` avec motif, auteur et date :
 * aucun `DELETE` SQL n'est exécuté, une ligne effacée ressusciterait au prochain
 * pull de synchronisation (§11.2).
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('sales.view');
    const { id } = await params;
    const invoiceId = parseId(id);

    const detail = await getSalesInvoice(invoiceId);
    if (!detail) throw new NotFoundError('Facture introuvable');

    let reason = request.nextUrl.searchParams.get('reason') ?? '';
    try {
      const body = await readJson<any>(request);
      if (body?.reason !== undefined) reason = String(body.reason ?? '');
    } catch {
      // Corps absent ou illisible : le motif de l'URL reste la référence.
    }

    const isDraft = detail.invoice.status === 'draft';
    requirePermission(user, isDraft ? 'sales.delete' : 'sales.cancel');

    // Un brouillon n'a rien à contre-passer : un motif par défaut suffit.
    if (isDraft && !reason.trim()) reason = 'Suppression du brouillon';

    const invoice = await cancelSalesInvoice(invoiceId, reason, user);

    return ok({ success: true, invoice });
  } catch (error) {
    return fail(error);
  }
}
