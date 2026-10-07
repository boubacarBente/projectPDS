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
  toNumber,
  ValidationError,
} from '@/lib/api';
import {
  addProductionExpense,
  addProductionWorker,
  advanceStage,
  cancelBrickProduction,
  getBrickProduction,
  hideProductionCosts,
  isBrickStage,
  registerBroken,
  removeProductionExpense,
  removeProductionWorker,
  updateBrickProduction,
  updateProductionExpense,
} from '@/lib/brick';
import { canViewSalesProfit } from '@/lib/sales';
import { today } from '@/lib/format';
import { writeAudit } from '@/lib/audit';
import type { SessionUser } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

async function detailFor(user: SessionUser, id: number) {
  const detail = await getBrickProduction(id);
  if (!detail) throw new NotFoundError('Lot de fabrication introuvable');
  assertStoreVisible(user, detail.production.storeId);
  if (await canViewSalesProfit(user)) return detail;
  // Invariant 13 : coût de revient masqué sans `balances.view`.
  return { ...detail, production: hideProductionCosts(detail.production), costs: hideProductionCosts(detail.costs) };
}

/** Ligne du lot renvoyée après une écriture (contrat des écrans de la v1). */
async function rowFor(user: SessionUser, id: number) {
  return (await detailFor(user, id)).production;
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
 * PUT /api/briqueterie/productions/[id] — écritures du lot, toujours dans le
 * **magasin actif** :
 *
 * | `action`          | Effet                                                         |
 * |-------------------|---------------------------------------------------------------|
 * | *(absent)*        | quantités / dates / équipe / notes                            |
 * | `advance_stage`   | étape suivante ; `stored` met en stock une seule fois          |
 * | `register_broken` | pertes motivées (`exit` si déjà en stock)                     |
 * | `add_expense`     | dépense rattachée (circuit normal : approbation, caisse)      |
 * | `update_expense`  | correction d'une dépense du lot                               |
 * | `remove_expense`  | annulation motivée d'une dépense                              |
 * | `add_worker`      | affectation `jours × tarif`                                   |
 * | `remove_worker`   | retrait d'une affectation                                     |
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.update');
    const { id } = await params;
    const productionId = parseId(id);
    const body = await readJson<any>(request);
    const action = typeof body.action === 'string' ? body.action : '';
    const storeId = await requireActiveStore(user);
    const audit = (details: Record<string, unknown>, kind: 'update' | 'stock_adjust' = 'update') =>
      writeAudit({ user, action: kind, entity: 'brick_production', entityId: productionId, details });

    switch (action) {
      case 'add_expense': {
        // Les dépenses suivent leurs propres droits, comme dans /depenses.
        await requireAction('expenses.create');
        const expense = await addProductionExpense(
          productionId,
          {
            category: String(body.category ?? ''),
            amount: toNumber(body.amount, 0),
            description: body.description ?? null,
            paymentMethod: body.paymentMethod ?? undefined,
            beneficiary: body.beneficiary ?? null,
            date: typeof body.date === 'string' && body.date ? body.date : today(),
            userId: user.id,
            canSkipApproval: user.role === 'admin',
          },
          storeId,
        );
        await audit({ addedExpense: expense.category, amount: expense.amount, approval: expense.approvalStatus });
        return ok(await rowFor(user, productionId));
      }
      case 'update_expense': {
        await requireAction('expenses.update');
        const expenseId = toNumber(body.expenseId, 0);
        if (!expenseId) throw new ValidationError('Dépense non précisée');
        await updateProductionExpense(
          productionId,
          expenseId,
          {
            category: body.category === undefined ? undefined : String(body.category),
            amount: body.amount === undefined ? undefined : toNumber(body.amount, 0),
            description: body.description,
            paymentMethod: body.paymentMethod,
            beneficiary: body.beneficiary,
            date: body.date,
          },
          { userId: user.id, storeId, canSkipApproval: user.role === 'admin' },
        );
        await audit({ updatedExpenseId: expenseId });
        return ok(await rowFor(user, productionId));
      }
      case 'remove_expense': {
        await requireAction('expenses.delete');
        const expenseId = toNumber(body.expenseId, 0);
        if (!expenseId) throw new ValidationError('Dépense non précisée');
        await removeProductionExpense(productionId, expenseId, String(body.reason ?? ''), { userId: user.id, storeId });
        await audit({ removedExpenseId: expenseId, reason: body.reason ?? null });
        return ok(await rowFor(user, productionId));
      }
      case 'advance_stage': {
        if (!isBrickStage(body.stage)) throw new ValidationError('Étape de fabrication invalide');
        const production = await advanceStage(productionId, body.stage, storeId, user.id);
        await audit({ batchNumber: production.batchNumber, stage: body.stage, stored: production.stored }, body.stage === 'stored' ? 'stock_adjust' : 'update');
        return ok(await rowFor(user, productionId));
      }
      case 'register_broken': {
        const production = await registerBroken(productionId, toNumber(body.brokenQuantity, 0), String(body.reason ?? ''), storeId, user.id);
        await audit({ batchNumber: production.batchNumber, broken: toNumber(body.brokenQuantity, 0), reason: body.reason ?? null }, 'stock_adjust');
        return ok(await rowFor(user, productionId));
      }
      case 'add_worker': {
        const line = await addProductionWorker(
          productionId,
          {
            workerId: toNumber(body.workerId, 0) || null,
            workerName: body.workerName ?? null,
            role: body.role ?? null,
            days: toNumber(body.days, 0),
            dailyRate: body.dailyRate === undefined || body.dailyRate === null || body.dailyRate === '' ? null : toNumber(body.dailyRate, 0),
          },
          storeId,
        );
        await audit({ worker: line.workerName, days: line.days, amount: line.amount });
        return ok(await rowFor(user, productionId));
      }
      case 'remove_worker': {
        const line = await removeProductionWorker(productionId, toNumber(body.workerId, 0), storeId);
        await audit({ removedWorker: line.workerName });
        return ok(await rowFor(user, productionId));
      }
      case 'add_material':
      case 'remove_material':
        throw new ValidationError('La briqueterie n’a plus de module de matières : saisissez une dépense rattachée au lot.');
      case '': {
        const patch: Record<string, unknown> = {};
        for (const key of ['plannedQuantity', 'producedQuantity', 'brokenQuantity']) {
          if (body[key] !== undefined) patch[key] = toNumber(body[key], 0);
        }
        for (const key of ['startDate', 'endDate', 'team', 'notes']) {
          if (body[key] !== undefined) patch[key] = body[key];
        }
        const production = await updateBrickProduction(productionId, patch, storeId);
        await audit({ batchNumber: production.batchNumber, fields: Object.keys(patch) });
        return ok(await rowFor(user, productionId));
      }
      default:
        throw new ValidationError(`Action inconnue : « ${action} »`);
    }
  } catch (error) {
    return fail(error);
  }
}

/** DELETE — **annulation motivée** du lot : stock du lot repris, jamais de suppression. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.delete');
    const { id } = await params;
    const productionId = parseId(id);
    const body = await readJson<any>(request).catch(() => ({}) as any);
    const reason = (typeof body?.reason === 'string' && body.reason) || request.nextUrl.searchParams.get('reason') || '';
    const storeId = await requireActiveStore(user);
    const production = await cancelBrickProduction(productionId, reason, { id: user.id, storeId });
    await writeAudit({
      user,
      action: 'cancel',
      entity: 'brick_production',
      entityId: productionId,
      details: { batchNumber: production.batchNumber, reason },
    });
    return ok(await rowFor(user, productionId));
  } catch (error) {
    return fail(error);
  }
}
