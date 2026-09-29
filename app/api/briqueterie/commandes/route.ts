import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireAction, toInt } from '@/lib/api';
import {
  createBrickOrder,
  isBrickOrderStatus,
  listBrickOrders,
  type BrickOrderItemInput,
} from '@/lib/brick-orders';
import { writeAudit } from '@/lib/audit';

/**
 * GET|POST /api/briqueterie/commandes — commandes clients de briques (§20).
 *
 * GET : liste paginée et filtrable (`search`, `status`, `customerId`, `from`,
 * `to`). Les commandes annulées sortent de la liste par défaut (tombstone).
 *
 * POST : création d'une commande `draft` (ou `confirmed` si le corps le
 * demande). La commande **ne touche ni le stock ni la caisse** : elle devient
 * une facture de vente par `POST /api/briqueterie/commandes/[id]/facturer`.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('brick.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    const customerId = params.get('customerId');

    const result = await listBrickOrders({
      search: params.get('search') ?? undefined,
      status: params.get('status') ?? undefined,
      customerId: customerId ? toInt(customerId, 0) || undefined : undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      page,
      limit,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/** Normalise les lignes reçues — la validation métier vit dans `lib/brick-orders.ts`. */
function readItems(body: any): BrickOrderItemInput[] {
  const raw = Array.isArray(body?.items) ? body.items : [];
  return raw.map((item: any) => ({
    brickTypeId: toInt(item?.brickTypeId, 0),
    quantity: Number(item?.quantity ?? 0) || 0,
    unitPrice: Number(item?.unitPrice ?? 0) || 0,
    discount: Number(item?.discount ?? 0) || 0,
  }));
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('brick.create');
    const body = await readJson<any>(request);

    const detail = await createBrickOrder({
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
      details: {
        orderNumber: detail.order.orderNumber,
        customerName: detail.order.customerName,
        total: detail.order.total,
        items: detail.items.length,
        status: detail.order.status,
      },
    });

    return ok(detail, 201);
  } catch (error) {
    return fail(error);
  }
}
