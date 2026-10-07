import { NextRequest } from 'next/server';
import {
  assertStoreVisible,
  fail,
  NotFoundError,
  ok,
  parseId,
  readJson,
  requireAction,
  requireActiveStore,
  toInt,
  ValidationError,
} from '@/lib/api';
import {
  cancelBrickOrder,
  getBrickOrder,
  invoiceBrickOrder,
  isBrickOrderStatus,
  readOrderItems,
  registerBrickOrderDelivery,
  updateBrickOrder,
  updateBrickOrderStatus,
} from '@/lib/brick-orders';
import { writeAudit } from '@/lib/audit';
import type { SessionUser } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

async function detailFor(user: SessionUser, id: number) {
  const detail = await getBrickOrder(id);
  if (!detail) throw new NotFoundError('Commande introuvable');
  assertStoreVisible(user, detail.order.storeId);
  return detail;
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.view');
    const { id } = await params;
    return ok(await detailFor(user, parseId(id)));
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/briqueterie/commandes/[id] — magasin actif uniquement :
 *  - `{ action: 'set_status', status }` : transition contrôlée ;
 *  - `{ action: 'deliver', deliveries: [{ itemId, quantity }] }` : livraison constatée ;
 *  - `{ action: 'invoice' }` : facture du canal briqueterie + transfert des acomptes
 *    (exige aussi `sales.create`, comme une vente) ;
 *  - sinon : modification (lignes remplacées).
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.update');
    const { id } = await params;
    const orderId = parseId(id);
    const body = await readJson<any>(request);
    const action = typeof body.action === 'string' ? body.action : '';
    const storeId = await requireActiveStore(user);

    if (action === 'set_status') {
      if (!isBrickOrderStatus(body.status)) throw new ValidationError('Statut de commande invalide');
      const order = await updateBrickOrderStatus(orderId, body.status, storeId);
      await writeAudit({ user, action: 'update', entity: 'brick_order', entityId: orderId, details: { orderNumber: order.orderNumber, status: order.status } });
      return ok(await detailFor(user, orderId));
    }
    if (action === 'deliver') {
      const deliveries = (Array.isArray(body.deliveries) ? body.deliveries : []).map((d: any) => ({
        itemId: toInt(d?.itemId, 0),
        quantity: Number(d?.quantity ?? 0) || 0,
      }));
      const detail = await registerBrickOrderDelivery(orderId, deliveries, storeId);
      await writeAudit({ user, action: 'update', entity: 'brick_order', entityId: orderId, details: { orderNumber: detail.order.orderNumber, deliveries, status: detail.order.status } });
      return ok(detail);
    }
    if (action === 'invoice') {
      // Facturer **crée une vente** (sortie de stock, chiffre d'affaires).
      await requireAction('sales.create');
      const result = await invoiceBrickOrder(orderId, { id: user.id, storeId });
      await writeAudit({
        user,
        action: 'validate',
        entity: 'brick_order',
        entityId: orderId,
        details: { orderNumber: result.order.orderNumber, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber },
      });
      return ok(result);
    }
    if (action) throw new ValidationError(`Action inconnue : « ${action} »`);

    const detail = await updateBrickOrder(
      orderId,
      {
        customerId: body.customerId ? toInt(body.customerId, 0) : null,
        customerName: body.customerName ?? undefined,
        date: body.date,
        dueDate: body.dueDate ?? null,
        promisedDate: body.promisedDate ?? null,
        discount: Number(body.discount ?? 0) || 0,
        notes: body.notes ?? null,
        items: readOrderItems(body),
        userId: user.id,
      },
      storeId,
    );
    await writeAudit({ user, action: 'update', entity: 'brick_order', entityId: orderId, details: { orderNumber: detail.order.orderNumber, total: detail.order.total, items: detail.items.length } });
    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/** DELETE — **annulation motivée** (jamais de suppression). */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.delete');
    const { id } = await params;
    const orderId = parseId(id);
    const body = await readJson<any>(request).catch(() => ({}) as any);
    const reason = (typeof body?.reason === 'string' && body.reason) || request.nextUrl.searchParams.get('reason') || '';
    const storeId = await requireActiveStore(user);
    const order = await cancelBrickOrder(orderId, reason, { id: user.id, storeId });
    await writeAudit({ user, action: 'cancel', entity: 'brick_order', entityId: orderId, details: { orderNumber: order.orderNumber, reason } });
    return ok(await detailFor(user, orderId));
  } catch (error) {
    return fail(error);
  }
}
