import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  toNumber,
  NotFoundError,
  ValidationError,
} from '@/lib/api';
import {
  addProductionMaterial,
  addProductionWorker,
  advanceStage,
  cancelBrickProduction,
  getBrickProduction,
  isBrickStage,
  registerBroken,
  removeProductionMaterial,
  removeProductionWorker,
  updateBrickProduction,
} from '@/lib/brick';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/briqueterie/productions/[id] — fiche du lot + matières + équipe + coûts. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('brick.view');
    const { id } = await params;

    const detail = await getBrickProduction(parseId(id));
    if (!detail) throw new NotFoundError('Lot de fabrication introuvable');

    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/briqueterie/productions/[id] — écritures du lot.
 *
 * Le corps porte un champ `action` explicite, chaque action correspondant à une
 * fonction dédiée de `lib/brick.ts` :
 *
 * | `action`           | Effet                                                    |
 * |--------------------|----------------------------------------------------------|
 * | *(absent)*         | mise à jour des quantités / coûts / dates / notes        |
 * | `advance_stage`    | étape suivante (mouvements de stock gérés, voir §20)     |
 * | `register_broken`  | pertes : `broken_quantity` + `exit` motivé               |
 * | `add_material`     | matière première → `exit` (contrôle de stock)            |
 * | `remove_material`  | retrait d'une ligne → `entry` (matière rendue)           |
 * | `add_worker`       | affectation `days × daily_rate`                          |
 * | `remove_worker`    | retrait d'une affectation                                |
 *
 * Ce module n'a pas de sous-routes `materiaux` / `ouvriers` (contrairement aux
 * chantiers) : les écritures de lignes passent donc par cette route unique,
 * sans jamais écrire directement en base.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.update');
    const { id } = await params;
    const productionId = parseId(id);
    const body = await readJson<any>(request);

    const action = typeof body.action === 'string' ? body.action : '';

    switch (action) {
      case 'advance_stage': {
        if (!isBrickStage(body.stage)) throw new ValidationError('Étape de fabrication invalide');
        const production = await advanceStage(productionId, body.stage);
        await writeAudit({
          user,
          action: 'update',
          entity: 'brick_production',
          entityId: productionId,
          details: {
            batchNumber: production.batchNumber,
            stage: production.stage,
            stored: production.stored,
          },
        });
        return ok(production);
      }

      case 'register_broken': {
        const production = await registerBroken(
          productionId,
          toNumber(body.brokenQuantity, 0),
          String(body.reason ?? ''),
        );
        await writeAudit({
          user,
          action: 'update',
          entity: 'brick_production',
          entityId: productionId,
          details: {
            batchNumber: production.batchNumber,
            brokenQuantity: production.brokenQuantity,
            reason: body.reason ?? null,
          },
        });
        return ok(production);
      }

      case 'add_material': {
        const material = await addProductionMaterial(productionId, {
          productId: toNumber(body.productId, 0),
          quantity: toNumber(body.quantity, 0),
          unitCost:
            body.unitCost === undefined || body.unitCost === null ? null : toNumber(body.unitCost, 0),
          userId: user.id,
        });
        await writeAudit({
          user,
          action: 'update',
          entity: 'brick_production',
          entityId: productionId,
          details: {
            addedMaterial: material.productName,
            productCode: material.productCode,
            quantity: material.quantity,
            unitCost: material.unitCost,
            amount: material.amount,
          },
        });
        return ok(material, 201);
      }

      case 'remove_material': {
        const materialId = toNumber(body.materialId, 0);
        if (!materialId) throw new ValidationError('La ligne de matière première est obligatoire');
        const production = await removeProductionMaterial(productionId, materialId);
        await writeAudit({
          user,
          action: 'delete',
          entity: 'brick_production',
          entityId: productionId,
          details: {
            removedMaterialId: materialId,
            batchNumber: production.batchNumber,
            stockReturned: true,
          },
        });
        return ok(production);
      }

      case 'add_worker': {
        const assignment = await addProductionWorker(productionId, {
          workerId: toNumber(body.workerId, 0) || null,
          workerName: body.workerName ?? null,
          role: body.role ?? null,
          days: toNumber(body.days, 0),
          dailyRate:
            body.dailyRate === undefined || body.dailyRate === null
              ? null
              : toNumber(body.dailyRate, 0),
        });
        await writeAudit({
          user,
          action: 'update',
          entity: 'brick_production',
          entityId: productionId,
          details: {
            addedWorker: assignment.workerName,
            role: assignment.role,
            days: assignment.days,
            dailyRate: assignment.dailyRate,
            amount: assignment.amount,
          },
        });
        return ok(assignment, 201);
      }

      case 'remove_worker': {
        const workerId = toNumber(body.workerId, 0);
        if (!workerId) throw new ValidationError('L’affectation à retirer est obligatoire');
        const production = await removeProductionWorker(productionId, workerId);
        await writeAudit({
          user,
          action: 'delete',
          entity: 'brick_production',
          entityId: productionId,
          details: { removedAssignmentId: workerId, batchNumber: production.batchNumber },
        });
        return ok(production);
      }

      default: {
        const patch: Record<string, unknown> = {};
        if (body.plannedQuantity !== undefined) {
          patch.plannedQuantity = toNumber(body.plannedQuantity, 0);
        }
        if (body.producedQuantity !== undefined) {
          patch.producedQuantity = toNumber(body.producedQuantity, 0);
        }
        if (body.brokenQuantity !== undefined) {
          patch.brokenQuantity = toNumber(body.brokenQuantity, 0);
        }
        if (body.startDate !== undefined) patch.startDate = body.startDate;
        if (body.endDate !== undefined) patch.endDate = body.endDate;
        if (body.notes !== undefined) patch.notes = body.notes;

        if (Object.keys(patch).length === 0) {
          throw new ValidationError('Aucune modification fournie');
        }

        const production = await updateBrickProduction(productionId, patch as any);
        await writeAudit({
          user,
          action: 'update',
          entity: 'brick_production',
          entityId: productionId,
          details: { batchNumber: production.batchNumber, ...patch },
        });
        return ok(production);
      }
    }
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/briqueterie/productions/[id] — **annulation motivée** du lot
 * (§7) : tombstone `deleted_at`, motif consigné, stock réversé. Jamais de
 * suppression physique.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.delete');
    const { id } = await params;
    const productionId = parseId(id);

    const body = await readJson<any>(request).catch(() => ({}) as any);
    const reason =
      (typeof body?.reason === 'string' && body.reason) ||
      request.nextUrl.searchParams.get('reason') ||
      '';

    const production = await cancelBrickProduction(productionId, reason, user);

    await writeAudit({
      user,
      action: 'cancel',
      entity: 'brick_production',
      entityId: productionId,
      details: { batchNumber: production.batchNumber, reason, stockReversed: true },
    });

    return ok(production);
  } catch (error) {
    return fail(error);
  }
}
