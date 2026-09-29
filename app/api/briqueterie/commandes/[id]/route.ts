import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  toInt,
  NotFoundError,
  ValidationError,
} from '@/lib/api';
import {
  cancelBrickOrder,
  getBrickOrder,
  invoiceBrickOrder,
  isBrickOrderStatus,
  registerBrickOrderDelivery,
  updateBrickOrder,
  updateBrickOrderStatus,
  type BrickOrderItemInput,
} from '@/lib/brick-orders';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/briqueterie/commandes/[id] — fiche complète : lignes, paiements
 * (acomptes), échéancier et facture liée.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('brick.view');
    const { id } = await params;

    const detail = await getBrickOrder(parseId(id));
    if (!detail) throw new NotFoundError('Commande introuvable');

    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/briqueterie/commandes/[id] — écritures de la commande, pilotées par
 * un champ `action` explicite :
 *
 * | `action`            | Effet                                                          |
 * |---------------------|----------------------------------------------------------------|
 * | *(absent)*          | remplacement des lignes, remise, dates, notes                  |
 * | `set_status`        | changement d'état, transitions contrôlées                      |
 * | `deliver`           | quantités livrées par ligne → statut « partiellement livrée »  |
 * | `invoice`           | **facturation** : vente `brick` + transfert des acomptes       |
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.update');
    const { id } = await params;
    const orderId = parseId(id);
    const body = await readJson<any>(request);
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'set_status') {
      if (!isBrickOrderStatus(body.status)) {
        throw new ValidationError('Statut de commande invalide');
      }
      const order = await updateBrickOrderStatus(orderId, body.status);
      await writeAudit({
        user,
        action: 'update',
        entity: 'brick_order',
        entityId: orderId,
        details: { orderNumber: order.orderNumber, status: order.status },
      });
      return ok(order);
    }

    if (action === 'deliver') {
      const deliveries = Array.isArray(body.deliveries) ? body.deliveries : [];
      const detail = await registerBrickOrderDelivery(
        orderId,
        deliveries.map((line: any) => ({
          itemId: toInt(line?.itemId, 0),
          quantity: Number(line?.quantity ?? 0) || 0,
        })),
      );
      await writeAudit({
        user,
        action: 'update',
        entity: 'brick_order',
        entityId: orderId,
        details: {
          orderNumber: detail.order.orderNumber,
          status: detail.order.status,
          quantityDelivered: detail.order.quantityDelivered,
        },
      });
      return ok(detail);
    }

    if (action === 'invoice') {
      // Permission dédiée : facturer **crée une vente** (sortie de stock,
      // chiffre d'affaires). C'est `sales.create` qui fait foi, pas
      // `brick.update` — la même garde que POST /api/ventes.
      await requireAction('sales.create');

      const result = await invoiceBrickOrder(orderId, user);
      await writeAudit({
        user,
        action: 'validate',
        entity: 'brick_order',
        entityId: orderId,
        details: {
          orderNumber: result.order.orderNumber,
          invoiceId: result.invoiceId,
          invoiceNumber: result.invoiceNumber,
        },
      });
      return ok(result);
    }

    if (action) throw new ValidationError(`Action inconnue : « ${action} »`);

    const rawItems: BrickOrderItemInput[] = (Array.isArray(body.items) ? body.items : []).map(
      (item: any) => ({
        brickTypeId: toInt(item?.brickTypeId, 0),
        quantity: Number(item?.quantity ?? 0) || 0,
        unitPrice: Number(item?.unitPrice ?? 0) || 0,
        discount: Number(item?.discount ?? 0) || 0,
      }),
    );

    const detail = await updateBrickOrder(orderId, {
      customerId: body.customerId ? toInt(body.customerId, 0) : null,
      customerName: body.customerName ?? undefined,
      date: body.date,
      dueDate: body.dueDate ?? null,
      promisedDate: body.promisedDate ?? null,
      discount: Number(body.discount ?? 0) || 0,
      notes: body.notes ?? null,
      items: rawItems,
      userId: user.id,
    });

    await writeAudit({
      user,
      action: 'update',
      entity: 'brick_order',
      entityId: orderId,
      details: {
        orderNumber: detail.order.orderNumber,
        total: detail.order.total,
        items: detail.items.length,
      },
    });

    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/briqueterie/commandes/[id] — **annulation motivée** (§7).
 *
 * Jamais de suppression physique : le motif est obligatoire, l'auteur et la
 * date sont tracés, et la ligne reste consultable.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.delete');
    const { id } = await params;
    const orderId = parseId(id);

    const body = await readJson<any>(request).catch(() => ({}) as any);
    const reason =
      (typeof body?.reason === 'string' && body.reason) ||
      request.nextUrl.searchParams.get('reason') ||
      '';

    if (!reason.trim()) throw new ValidationError('Le motif d’annulation est obligatoire');

    const order = await cancelBrickOrder(orderId, reason, user);

    await writeAudit({
      user,
      action: 'cancel',
      entity: 'brick_order',
      entityId: orderId,
      details: { orderNumber: order.orderNumber, reason },
    });

    return ok(order);
  } catch (error) {
    return fail(error);
  }
}
