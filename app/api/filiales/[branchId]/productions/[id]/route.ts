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
  registerBroken,
  removeProductionExpense,
  removeProductionWorker,
  updateBrickProduction,
  updateProductionExpense,
} from '@/lib/brick';
import { requireBranch } from '@/lib/branches';
import { canViewSalesProfit } from '@/lib/sales';
import { today } from '@/lib/format';
import { writeAudit } from '@/lib/audit';
import type { SessionUser } from '@/lib/api';

type Params = { params: Promise<{ branchId: string; id: string }> };

async function detailFor(user: SessionUser, branchId: number, id: number) {
  const detail = await getBrickProduction(id);
  // Une production d'une autre filiale n'existe pas depuis cet espace.
  if (!detail || detail.production.branchId !== branchId) throw new NotFoundError('Production introuvable dans cette filiale');
  assertStoreVisible(user, detail.production.storeId);
  if (await canViewSalesProfit(user)) return detail;
  // Invariant 13 : coût de revient masqué sans `balances.view`.
  return { ...detail, production: hideProductionCosts(detail.production), costs: hideProductionCosts(detail.costs) };
}

/** Ligne de la production renvoyée après une écriture (contrat des écrans). */
async function rowFor(user: SessionUser, branchId: number, id: number) {
  return (await detailFor(user, branchId, id)).production;
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
 * PUT /api/filiales/[branchId]/productions/[id] — écritures de la production,
 * toujours dans le **magasin actif** et **la filiale de la route** :
 *
 * | `action`          | Effet                                                         |
 * |-------------------|---------------------------------------------------------------|
 * | *(absent)*        | quantités / dates / équipe / notes                            |
 * | `advance_stage`   | étape suivante de la filiale ; `stored` met en stock une fois |
 * | `register_broken` | pertes motivées (`exit` si déjà en stock)                     |
 * | `add_expense`     | dépense rattachée (circuit normal : approbation, caisse)      |
 * | `update_expense`  | correction d'une dépense de la production                     |
 * | `remove_expense`  | annulation motivée d'une dépense                              |
 * | `add_worker`      | affectation `jours × tarif`                                   |
 * | `remove_worker`   | retrait d'une affectation                                     |
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.update', { write: true });
    const productionId = parseId(id);
    const body = await readJson<any>(request);
    const action = typeof body.action === 'string' ? body.action : '';
    const storeId = await requireActiveStore(user);
    const audit = (details: Record<string, unknown>, kind: 'update' | 'stock_adjust' = 'update') =>
      writeAudit({ user, action: kind, entity: 'brick_production', entityId: productionId, details: { branch: branch.name, ...details } });
    const row = () => rowFor(user, branch.id, productionId);

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
          branch.id,
        );
        await audit({ addedExpense: expense.category, amount: expense.amount, approval: expense.approvalStatus });
        return ok(await row());
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
          { userId: user.id, storeId, branchId: branch.id, canSkipApproval: user.role === 'admin' },
        );
        await audit({ updatedExpenseId: expenseId });
        return ok(await row());
      }
      case 'remove_expense': {
        await requireAction('expenses.delete');
        const expenseId = toNumber(body.expenseId, 0);
        if (!expenseId) throw new ValidationError('Dépense non précisée');
        await removeProductionExpense(productionId, expenseId, String(body.reason ?? ''), { userId: user.id, storeId, branchId: branch.id });
        await audit({ removedExpenseId: expenseId, reason: body.reason ?? null });
        return ok(await row());
      }
      case 'advance_stage': {
        const production = await advanceStage(productionId, String(body.stage ?? ''), storeId, user.id, branch);
        await audit(
          { batchNumber: production.batchNumber, stage: body.stage, stored: production.stored },
          body.stage === 'stored' ? 'stock_adjust' : 'update',
        );
        return ok(await row());
      }
      case 'register_broken': {
        const production = await registerBroken(productionId, toNumber(body.brokenQuantity, 0), String(body.reason ?? ''), storeId, user.id, branch);
        await audit({ batchNumber: production.batchNumber, broken: toNumber(body.brokenQuantity, 0), reason: body.reason ?? null }, 'stock_adjust');
        return ok(await row());
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
          branch.id,
        );
        await audit({ worker: line.workerName, days: line.days, amount: line.amount });
        return ok(await row());
      }
      case 'remove_worker': {
        const line = await removeProductionWorker(productionId, toNumber(body.workerId, 0), storeId, branch.id);
        await audit({ removedWorker: line.workerName });
        return ok(await row());
      }
      case '': {
        const patch: Record<string, unknown> = {};
        for (const key of ['plannedQuantity', 'producedQuantity', 'brokenQuantity']) {
          if (body[key] !== undefined) patch[key] = toNumber(body[key], 0);
        }
        for (const key of ['startDate', 'endDate', 'team', 'notes']) {
          if (body[key] !== undefined) patch[key] = body[key];
        }
        const production = await updateBrickProduction(productionId, patch, storeId, branch.id);
        await audit({ batchNumber: production.batchNumber, fields: Object.keys(patch) });
        return ok(await row());
      }
      default:
        throw new ValidationError(`Action inconnue : « ${action} »`);
    }
  } catch (error) {
    return fail(error);
  }
}

/** DELETE — **annulation motivée** de la production : stock repris, jamais de suppression. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.delete', { write: true });
    const productionId = parseId(id);
    const body = await readJson<any>(request).catch(() => ({}) as any);
    const reason = (typeof body?.reason === 'string' && body.reason) || request.nextUrl.searchParams.get('reason') || '';
    const storeId = await requireActiveStore(user);
    const production = await cancelBrickProduction(productionId, reason, { id: user.id, storeId }, branch.id);
    await writeAudit({
      user,
      action: 'cancel',
      entity: 'brick_production',
      entityId: productionId,
      details: { branch: branch.name, batchNumber: production.batchNumber, reason },
    });
    return ok(await rowFor(user, branch.id, productionId));
  } catch (error) {
    return fail(error);
  }
}
