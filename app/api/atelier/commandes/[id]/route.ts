import { NextRequest } from 'next/server';
import {
  NotFoundError,
  ValidationError,
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  required,
  toNumber,
} from '@/lib/api';
import {
  addOrderMaterial,
  addOrderWorker,
  advanceStage,
  cancelFurnitureOrder,
  getFurnitureOrder,
  isFurnitureStage,
  removeOrderMaterial,
  removeOrderWorker,
  updateFurnitureOrder,
} from '@/lib/furniture';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/atelier/commandes/[id] — fiche complète : commande, matériaux,
 * équipe, coûts calculés et modèle d'origine (`null` si sur mesure).
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('furniture.view');
    const { id } = await params;

    const detail = await getFurnitureOrder(parseId(id));
    if (!detail) throw new NotFoundError('Commande introuvable');

    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/atelier/commandes/[id] — une écriture, plusieurs intentions
 * explicites, jamais pilotées par une chaîne opaque :
 *
 *  - `{ action: 'advance', stage }`      → avance d'étape (livraison = entrée en stock)
 *  - `{ action: 'addMaterial', ... }`    → consommation de matière + chutes
 *  - `{ action: 'removeMaterial', materialId }`
 *  - `{ action: 'addWorker', ... }`      → affectation (`days × dailyRate`)
 *  - `{ action: 'removeWorker', workerLineId }`
 *  - `{ ...champs }`                     → coûts, dates, dimensions, finition,
 *                                          prix convenu, acompte
 *
 * L'étape ne se modifie **pas** par un simple `stage` dans le patch : elle
 * passe obligatoirement par `advanceStage()`, seul endroit qui garantit qu'un
 * meuble fini n'est crédité qu'une fois.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const orderId = parseId(id);
    const body = await readJson<any>(request);
    const action = typeof body.action === 'string' ? body.action : 'update';

    if (action === 'advance') {
      const user = await requireAction('furniture.update');
      const stage = body.stage;

      if (!isFurnitureStage(stage)) throw new ValidationError('Étape d’atelier inconnue');

      const detail = await advanceStage(orderId, stage);

      await writeAudit({
        user,
        action: 'update',
        entity: 'furniture_order',
        entityId: orderId,
        details: {
          orderNumber: detail.order.orderNumber,
          stage,
          delivered: stage === 'delivered',
          deliveryDate: detail.order.deliveryDate,
          onTime: detail.order.isDeliveredOnTime,
        },
      });

      return ok(detail);
    }

    if (action === 'addMaterial') {
      const user = await requireAction('furniture.update');

      const detail = await addOrderMaterial(orderId, {
        productId: toNumber(body.productId, 0),
        quantity: toNumber(body.quantity, 0),
        wastageQuantity: toNumber(body.wastageQuantity, 0),
        unitCost: body.unitCost !== undefined ? toNumber(body.unitCost, 0) : undefined,
        motif: body.motif ?? undefined,
      });

      await writeAudit({
        user,
        action: 'stock_adjust',
        entity: 'furniture_order',
        entityId: orderId,
        details: {
          orderNumber: detail.order.orderNumber,
          productId: toNumber(body.productId, 0),
          quantity: toNumber(body.quantity, 0),
          wastageQuantity: toNumber(body.wastageQuantity, 0),
          materialCost: detail.costs.materialCost,
        },
      });

      return ok(detail);
    }

    if (action === 'removeMaterial') {
      const user = await requireAction('furniture.update');
      const materialId = toNumber(body.materialId, 0);
      if (materialId <= 0) throw new ValidationError('Ligne de matériau invalide');

      const detail = await removeOrderMaterial(orderId, materialId);

      await writeAudit({
        user,
        action: 'stock_adjust',
        entity: 'furniture_order',
        entityId: orderId,
        details: { removedMaterialId: materialId, returnedToStock: true },
      });

      return ok(detail);
    }

    if (action === 'addWorker') {
      const user = await requireAction('furniture.update');

      const detail = await addOrderWorker(orderId, {
        workerId: toNumber(body.workerId, 0) || null,
        workerName: body.workerName ?? null,
        role: body.role ?? null,
        days: toNumber(body.days, 0),
        dailyRate: toNumber(body.dailyRate, 0),
      });

      await writeAudit({
        user,
        action: 'update',
        entity: 'furniture_order',
        entityId: orderId,
        details: {
          workerName: body.workerName ?? null,
          days: toNumber(body.days, 0),
          dailyRate: toNumber(body.dailyRate, 0),
          laborCost: detail.costs.laborCost,
        },
      });

      return ok(detail);
    }

    if (action === 'removeWorker') {
      const user = await requireAction('furniture.update');
      const workerLineId = toNumber(body.workerLineId, 0);
      if (workerLineId <= 0) throw new ValidationError('Ligne d’équipe invalide');

      const detail = await removeOrderWorker(orderId, workerLineId);

      await writeAudit({
        user,
        action: 'update',
        entity: 'furniture_order',
        entityId: orderId,
        details: { removedWorkerLineId: workerLineId },
      });

      return ok(detail);
    }

    const user = await requireAction('furniture.update');

    const patch: Record<string, unknown> = {};
    if (body.customerId !== undefined) patch.customerId = toNumber(body.customerId, 0) || null;
    if (body.customerName !== undefined) patch.customerName = body.customerName;
    if (body.modelId !== undefined) patch.modelId = toNumber(body.modelId, 0) || null;
    if (body.modelName !== undefined) patch.modelName = body.modelName;
    if (body.isCustom !== undefined) patch.isCustom = Boolean(body.isCustom);
    if (body.dimensions !== undefined) patch.dimensions = body.dimensions;
    if (body.finish !== undefined) patch.finish = body.finish;
    if (body.quantity !== undefined) patch.quantity = toNumber(body.quantity, 1) || 1;
    if (body.startDate !== undefined) patch.startDate = body.startDate;
    if (body.promisedDate !== undefined) patch.promisedDate = body.promisedDate;
    if (body.deliveryDate !== undefined) patch.deliveryDate = body.deliveryDate;
    if (body.agreedPrice !== undefined) patch.agreedPrice = toNumber(body.agreedPrice, 0);
    if (body.amountPaid !== undefined) patch.amountPaid = toNumber(body.amountPaid, 0);
    if (body.productId !== undefined) patch.productId = toNumber(body.productId, 0) || null;
    if (body.notes !== undefined) patch.notes = body.notes;

    // `stage` n'est volontairement pas repris du patch : voir `action: 'advance'`.
    const detail = await updateFurnitureOrder(orderId, patch as any);

    await writeAudit({
      user,
      action: 'update',
      entity: 'furniture_order',
      entityId: orderId,
      details: { fields: Object.keys(patch), orderNumber: detail.order.orderNumber },
    });

    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/atelier/commandes/[id] — **annulation**, jamais une suppression.
 *
 * Le motif est **obligatoire** (`{ reason }` dans le corps, ou `?reason=` en
 * repli) : une annulation sans raison écrite est une perte d'information. Les
 * matières déjà sorties retournent au stock, la ligne reste en base avec son
 * tombstone et la fiche reste consultable.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('furniture.delete');
    const { id } = await params;
    const orderId = parseId(id);

    const body = await readJson<any>(request).catch(() => ({} as any));
    const reason =
      body?.reason ?? request.nextUrl.searchParams.get('reason') ?? '';

    const detail = await cancelFurnitureOrder(orderId, required(reason, 'Motif d’annulation'), {
      id: user.id,
      name: user.name,
    });

    await writeAudit({
      user,
      action: 'cancel',
      entity: 'furniture_order',
      entityId: orderId,
      details: { orderNumber: detail.order.orderNumber, reason: String(reason) },
    });

    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}
