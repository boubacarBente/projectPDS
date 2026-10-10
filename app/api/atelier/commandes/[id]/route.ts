import { NextRequest } from 'next/server';
import { assertAtelierAccess } from '@/lib/branches';
import {
  assertStoreVisible,
  fail,
  NotFoundError,
  ok,
  parseId,
  readJson,
  requireAction,
  requireActiveStore,
  toNumber,
  ValidationError,
} from '@/lib/api';
import {
  addOrderMaterial,
  addOrderWorker,
  advanceFurnitureStage,
  cancelFurnitureOrder,
  consumePlannedMaterials,
  getFurnitureOrder,
  hideDetailCosts,
  removeOrderMaterial,
  removeOrderWorker,
  updateFurnitureOrder,
} from '@/lib/furniture';
import { isFurnitureStage } from '@/lib/furniture-shared';
import { canViewSalesProfit } from '@/lib/sales';
import { writeAudit } from '@/lib/audit';
import type { SessionUser } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** Fiche renvoyée après chaque écriture : coûts masqués sans `balances.view`. */
async function detailFor(user: SessionUser, id: number) {
  const detail = await getFurnitureOrder(id);
  if (!detail) throw new NotFoundError('Commande d’atelier introuvable');
  assertStoreVisible(user, detail.order.storeId);
  return (await canViewSalesProfit(user)) ? detail : hideDetailCosts(detail);
}

/** GET /api/atelier/commandes/[id] — fiche : matières, équipe, besoins, coûts, paiements. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.view');
    await assertAtelierAccess(user);
    const { id } = await params;
    return ok(await detailFor(user, parseId(id)));
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/atelier/commandes/[id] — une écriture, une intention explicite :
 *
 *  - `{ action: 'advance', stage, deliveryDate? }` → étape suivante (fin = livraison ou mise en stock)
 *  - `{ action: 'addMaterial', productId, quantity, wastageQuantity?, unitCost? }` → sortie de stock
 *  - `{ action: 'consumePlanned' }` → sortie des matières prévues par la nomenclature (tout ou rien)
 *  - `{ action: 'removeMaterial', materialId }` → retour au stock
 *  - `{ action: 'addWorker', ... }` / `{ action: 'removeWorker', workerLineId }`
 *  - `{ ...champs }` → informations, dates, prix convenu
 *
 * Toujours dans le **magasin actif** (`requireActiveStore`), jamais dans un
 * magasin reçu du navigateur.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const orderId = parseId(id);
    const body = await readJson<any>(request);
    const action = typeof body.action === 'string' ? body.action : 'update';
    const user = await requireAction('brick.update');
    await assertAtelierAccess(user, true);
    const storeId = await requireActiveStore(user);

    if (action === 'advance') {
      if (!isFurnitureStage(body.stage)) throw new ValidationError('Étape d’atelier inconnue');
      const order = await advanceFurnitureStage(orderId, body.stage, storeId, {
        userId: user.id,
        deliveryDate: body.deliveryDate ?? null,
      });
      await writeAudit({
        user,
        action: 'update',
        entity: 'furniture_order',
        entityId: orderId,
        details: { orderNumber: order.orderNumber, stage: order.stageLabel, deliveryDate: order.deliveryDate },
      });
      return ok(await detailFor(user, orderId));
    }

    if (action === 'addMaterial') {
      const line = await addOrderMaterial(
        orderId,
        {
          productId: toNumber(body.productId, 0),
          quantity: toNumber(body.quantity, 0),
          wastageQuantity: toNumber(body.wastageQuantity, 0),
          unitCost: body.unitCost === undefined || body.unitCost === null || body.unitCost === '' ? null : toNumber(body.unitCost, 0),
          userId: user.id,
        },
        storeId,
      );
      await writeAudit({
        user,
        action: 'stock_adjust',
        entity: 'furniture_order',
        entityId: orderId,
        details: { material: line.productName, quantity: line.quantity, wastage: line.wastageQuantity, amount: line.amount },
      });
      return ok(await detailFor(user, orderId));
    }

    if (action === 'consumePlanned') {
      const lines = await consumePlannedMaterials(orderId, storeId, user.id);
      await writeAudit({
        user,
        action: 'stock_adjust',
        entity: 'furniture_order',
        entityId: orderId,
        details: { plannedMaterials: lines.map((l) => `${l.productName} × ${l.quantity}`) },
      });
      return ok(await detailFor(user, orderId));
    }

    if (action === 'removeMaterial') {
      const materialId = toNumber(body.materialId, 0);
      if (materialId <= 0) throw new ValidationError('Ligne de matière invalide');
      const line = await removeOrderMaterial(orderId, materialId, storeId, user.id);
      await writeAudit({
        user,
        action: 'stock_adjust',
        entity: 'furniture_order',
        entityId: orderId,
        details: {
          removedMaterial: line.productName,
          returnedToStock: line.quantity + line.wastageQuantity,
          note: 'Correction de saisie : la matière et ses chutes reviennent au stock.',
        },
      });
      return ok(await detailFor(user, orderId));
    }

    if (action === 'addWorker') {
      const line = await addOrderWorker(
        orderId,
        {
          workerId: toNumber(body.workerId, 0) || null,
          workerName: body.workerName ?? null,
          role: body.role ?? null,
          days: toNumber(body.days, 0),
          dailyRate: body.dailyRate === undefined || body.dailyRate === null || body.dailyRate === '' ? null : toNumber(body.dailyRate, 0),
        },
        storeId,
      );
      await writeAudit({
        user,
        action: 'update',
        entity: 'furniture_order',
        entityId: orderId,
        details: { worker: line.workerName, days: line.days, dailyRate: line.dailyRate, amount: line.amount },
      });
      return ok(await detailFor(user, orderId));
    }

    if (action === 'removeWorker') {
      const lineId = toNumber(body.workerLineId, 0);
      if (lineId <= 0) throw new ValidationError('Ligne d’équipe invalide');
      const line = await removeOrderWorker(orderId, lineId, storeId);
      await writeAudit({
        user,
        action: 'update',
        entity: 'furniture_order',
        entityId: orderId,
        details: { removedWorker: line.workerName, days: line.days },
      });
      return ok(await detailFor(user, orderId));
    }

    if (action !== 'update') throw new ValidationError(`Action inconnue : ${action}`);

    const patch: Record<string, unknown> = {};
    for (const key of ['customerName', 'modelName', 'dimensions', 'finish', 'startDate', 'promisedDate', 'deliveryDate', 'notes']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.customerId !== undefined) patch.customerId = toNumber(body.customerId, 0) || null;
    if (body.modelId !== undefined) patch.modelId = toNumber(body.modelId, 0) || null;
    if (body.isCustom !== undefined) patch.isCustom = Boolean(body.isCustom);
    if (body.quantity !== undefined) patch.quantity = toNumber(body.quantity, 0);
    if (body.agreedPrice !== undefined) patch.agreedPrice = toNumber(body.agreedPrice, 0);
    if (body.productId !== undefined) patch.productId = toNumber(body.productId, 0) || null;

    const order = await updateFurnitureOrder(orderId, patch, storeId);
    await writeAudit({
      user,
      action: 'update',
      entity: 'furniture_order',
      entityId: orderId,
      details: { orderNumber: order.orderNumber, fields: Object.keys(patch), total: order.total },
    });
    return ok(await detailFor(user, orderId));
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/atelier/commandes/[id] — **annulation** (motif obligatoire),
 * jamais une suppression. Les matières sorties reviennent au stock.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.delete');
    await assertAtelierAccess(user, true);
    const { id } = await params;
    const orderId = parseId(id);
    const body = await readJson<any>(request).catch(() => ({}) as any);
    const reason = String(body?.reason ?? request.nextUrl.searchParams.get('reason') ?? '');
    const storeId = await requireActiveStore(user);

    const order = await cancelFurnitureOrder(orderId, reason, { id: user.id, storeId });
    await writeAudit({
      user,
      action: 'cancel',
      entity: 'furniture_order',
      entityId: orderId,
      details: { orderNumber: order.orderNumber, reason: order.cancelReason, amountPaid: order.amountPaid },
    });
    return ok(await detailFor(user, orderId));
  } catch (error) {
    return fail(error);
  }
}
