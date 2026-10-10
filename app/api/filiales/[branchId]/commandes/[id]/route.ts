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
import { requireBranch } from '@/lib/branches';
import { writeAudit } from '@/lib/audit';
import type { SessionUser } from '@/lib/api';

type Params = { params: Promise<{ branchId: string; id: string }> };

async function detailFor(user: SessionUser, branchId: number, id: number) {
  const detail = await getBrickOrder(id);
  if (!detail || detail.order.branchId !== branchId) throw new NotFoundError('Commande introuvable dans cette filiale');
  assertStoreVisible(user, detail.order.storeId);
  return detail;
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.view');
    return ok(await detailFor(user, branch.id, parseId(id)));
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/filiales/[branchId]/commandes/[id] — magasin actif uniquement :
 *  - `{ action: 'set_status', status }` : transition contrôlée ;
 *  - `{ action: 'deliver', deliveries: [{ itemId, quantity }] }` : livraison constatée ;
 *  - `{ action: 'invoice' }` : vente de la filiale + transfert des acomptes
 *    (exige aussi `sales.create`, comme une vente) ;
 *  - sinon : modification (lignes remplacées).
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.update', { write: true });
    const orderId = parseId(id);
    const body = await readJson<any>(request);
    const action = typeof body.action === 'string' ? body.action : '';
    const storeId = await requireActiveStore(user);
    const audit = (kind: 'update' | 'validate', details: Record<string, unknown>) =>
      writeAudit({ user, action: kind, entity: 'brick_order', entityId: orderId, details: { branch: branch.name, ...details } });

    if (action === 'set_status') {
      if (!isBrickOrderStatus(body.status)) throw new ValidationError('Statut de commande invalide');
      const order = await updateBrickOrderStatus(orderId, body.status, storeId, branch.id);
      await audit('update', { orderNumber: order.orderNumber, status: order.status });
      return ok(await detailFor(user, branch.id, orderId));
    }
    if (action === 'deliver') {
      const deliveries = (Array.isArray(body.deliveries) ? body.deliveries : []).map((d: any) => ({
        itemId: toInt(d?.itemId, 0),
        quantity: Number(d?.quantity ?? 0) || 0,
      }));
      const detail = await registerBrickOrderDelivery(orderId, deliveries, storeId, branch.id);
      await audit('update', { orderNumber: detail.order.orderNumber, deliveries, status: detail.order.status });
      return ok(detail);
    }
    if (action === 'invoice') {
      // Facturer **crée une vente** (sortie de stock, chiffre d'affaires).
      await requireAction('sales.create');
      const result = await invoiceBrickOrder(orderId, { id: user.id, storeId }, branch.id);
      await audit('validate', { orderNumber: result.order.orderNumber, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber });
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
      branch,
    );
    await audit('update', { orderNumber: detail.order.orderNumber, total: detail.order.total, items: detail.items.length });
    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/** DELETE — **annulation motivée** (jamais de suppression). */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.delete', { write: true });
    const orderId = parseId(id);
    const body = await readJson<any>(request).catch(() => ({}) as any);
    const reason = (typeof body?.reason === 'string' && body.reason) || request.nextUrl.searchParams.get('reason') || '';
    const storeId = await requireActiveStore(user);
    const order = await cancelBrickOrder(orderId, reason, { id: user.id, storeId }, branch.id);
    await writeAudit({
      user,
      action: 'cancel',
      entity: 'brick_order',
      entityId: orderId,
      details: { branch: branch.name, orderNumber: order.orderNumber, reason },
    });
    return ok(await detailFor(user, branch.id, orderId));
  } catch (error) {
    return fail(error);
  }
}
