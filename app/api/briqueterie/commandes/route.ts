import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireAction, requireActiveStore, scopeFromRequest, toBool, toInt } from '@/lib/api';
import { createBrickOrder, isBrickOrderStatus, listBrickOrders, readOrderItems as readItems } from '@/lib/brick-orders';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/briqueterie/commandes — commandes de la portée (README §30). La
 * commande ne touche ni le stock ni la caisse : elle se facture (`action:
 * 'invoice'`), et ses acomptes passent par `/api/briqueterie/commandes/[id]/paiements`.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('brick.view');
    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    const customerId = params.get('customerId');
    return ok(
      await listBrickOrders({
        scope: scopeFromRequest(user, request),
        search: params.get('search') ?? undefined,
        status: params.get('status') ?? undefined,
        customerId: customerId ? toInt(customerId, 0) || undefined : undefined,
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
        includeCancelled: toBool(params.get('includeCancelled'), false),
        page,
        limit,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

/** POST — nouvelle commande dans le magasin actif (brouillon ou confirmée). */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('brick.create');
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const detail = await createBrickOrder({
      storeId,
      customerId: body.customerId ? toInt(body.customerId, 0) : null,
      customerName: body.customerName ?? null,
      date: body.date,
      dueDate: body.dueDate ?? null,
      promisedDate: body.promisedDate ?? null,
      discount: Number(body.discount ?? 0) || 0,
      notes: body.notes ?? null,
      status: isBrickOrderStatus(body.status) && body.status === 'confirmed' ? 'confirmed' : 'draft',
      items: readItems(body),
      userId: user.id,
    });
    await writeAudit({
      user,
      action: 'create',
      entity: 'brick_order',
      entityId: detail.order.id,
      details: { orderNumber: detail.order.orderNumber, customer: detail.order.customerName, total: detail.order.total },
    });
    return ok(detail, 201);
  } catch (error) {
    return fail(error);
  }
}
