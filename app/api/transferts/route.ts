import { NextRequest } from 'next/server';
import { ValidationError, fail, ok, parsePagination, readJson, requireAction, scopeFromRequest, toBool } from '@/lib/api';
import { createTransfer, listTransfers } from '@/lib/transfers';

/**
 * GET /api/transferts — liste paginée des transferts intermagasins.
 *
 * `?store=all|<id>` (défaut : magasin actif), `?direction=incoming|outgoing|all`,
 * `?status=open|draft|pending|…|all` (plusieurs statuts : `approved,preparing`),
 * `?search=` (référence ou motif).
 * Un transfert apparaît s'il part de **ou** arrive dans un magasin de la portée.
 * Permission : `transfers.view`.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('transfers.view');
    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    const direction = params.get('direction');

    return ok(
      await listTransfers({
        scope: scopeFromRequest(user, request),
        status: params.get('status') ?? undefined,
        direction: direction === 'incoming' || direction === 'outgoing' ? direction : 'all',
        search: params.get('search')?.trim() || undefined,
        page,
        limit,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/transferts — nouvelle demande de transfert.
 * Corps : `{ sourceStoreId, destinationStoreId, reason?, requestedDate?, notes?,
 *           items: [{ productId, quantity }], submit? }`.
 * `submit: true` soumet directement (en attente de validation, ou validé si
 * le paramètre « validation des transferts » est désactivé) ; sinon brouillon.
 * Permission : `transfers.create`.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('transfers.create');
    const body = await readJson<any>(request);
    if (!Array.isArray(body.items)) throw new ValidationError('Ajoutez au moins un produit');

    const detail = await createTransfer(
      {
        sourceStoreId: Number(body.sourceStoreId),
        destinationStoreId: Number(body.destinationStoreId ?? user.storeId),
        reason: body.reason ?? null,
        requestedDate: body.requestedDate ?? null,
        notes: body.notes ?? null,
        items: body.items.map((i: any) => ({ productId: Number(i.productId), quantity: Number(i.quantity) })),
        submit: toBool(body.submit, false),
      },
      user,
    );
    return ok(detail, 201);
  } catch (error) {
    return fail(error);
  }
}
