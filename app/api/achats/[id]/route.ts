import { NextRequest } from 'next/server';
import { NotFoundError, fail, ok, parseId, readJson, requireAction } from '@/lib/api';
import {
  cancelPurchaseInvoice,
  getPurchaseInvoice,
  parsePurchaseInput,
  updatePurchaseInvoice,
} from '@/lib/purchases';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/achats/[id] — bon d'achat complet (§7.5).
 *
 * Une facture d'achat reste consultable et réimprimable indéfiniment, même
 * annulée : les lignes portent leurs **instantanés** (`product_name`,
 * `unit`) et ne dépendent donc pas de l'état du catalogue.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('purchases.view');
    const { id } = await params;

    const detail = await getPurchaseInvoice(parseId(id));
    if (!detail) throw new NotFoundError('Achat introuvable');

    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/achats/[id] — modification (§7.5).
 *
 * Le total est recalculé, le stock est ajusté **par différence** (par produit :
 * une `entry` si la quantité augmente, une `exit` motivée « correction achat »
 * si elle diminue — le stock peut alors manquer, `InsufficientStockError` est
 * traduite en **400** par `fail()`), et seul un complément de règlement peut
 * être ajouté : un décaissement enregistré ne se supprime jamais.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('purchases.update');
    const { id } = await params;
    const body = await readJson<any>(request);

    const invoice = await updatePurchaseInvoice(parseId(id), {
      ...parsePurchaseInput(body),
      userId: user.id,
    });

    return ok({ invoice });
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/achats/[id] — **annulation**, jamais une suppression physique
 * (§14, §26.13).
 *
 * `body { reason }` (ou `?reason=…`) : le motif est **obligatoire**, il est
 * conservé sur la facture et dans le journal d'actions. Aucun `DELETE` SQL n'est
 * exécuté — une ligne effacée ressusciterait au prochain pull de synchronisation
 * (§11.2).
 *
 * Permission : `purchases.delete` (l'action est marquée `dangerous` dans
 * `ACTION_META` — le stock est inversé et la caisse contre-passée).
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('purchases.delete');
    const { id } = await params;
    const invoiceId = parseId(id);

    const detail = await getPurchaseInvoice(invoiceId);
    if (!detail) throw new NotFoundError('Achat introuvable');

    let reason = request.nextUrl.searchParams.get('reason') ?? '';
    try {
      const body = await readJson<any>(request);
      if (body?.reason !== undefined) reason = String(body.reason ?? '');
    } catch {
      // Corps absent ou illisible : le motif de l'URL reste la référence.
      // C'est `cancelPurchaseInvoice` qui refuse un motif vide (400).
    }

    const invoice = await cancelPurchaseInvoice(invoiceId, reason, user);

    return ok({ success: true, invoice });
  } catch (error) {
    return fail(error);
  }
}
