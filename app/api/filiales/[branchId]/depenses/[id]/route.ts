import { NextRequest } from 'next/server';
import { assertStoreVisible, fail, NotFoundError, ok, parseId, readJson, requireAction, requireActiveStore, ValidationError } from '@/lib/api';
import { requireBranch } from '@/lib/branches';
import { cancelExpense, decideExpense, getExpense, payExpense } from '@/lib/expenses';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ branchId: string; id: string }> };

/** La dépense doit appartenir à la filiale de la route. */
async function expenseOfBranch(branchId: number, id: number) {
  const expense = await getExpense(id);
  if (!expense || expense.productionBranchId !== branchId) throw new NotFoundError('Dépense introuvable dans cette filiale');
  return expense;
}

/**
 * PUT `{ action }` — circuit d'une dépense de la filiale :
 * `approve` / `reject` (`expenses.approve`, jamais sa propre dépense),
 * `pay` (décaissement d'une dépense approuvée : sortie de caisse du magasin, filiale portée).
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.view');
    const expenseId = parseId(id);
    const expense = await expenseOfBranch(branch.id, expenseId);
    assertStoreVisible(user, expense.storeId);
    const body = await readJson<any>(request);
    let result;
    switch (body.action) {
      case 'approve':
      case 'reject':
        await requireAction('expenses.approve');
        result = await decideExpense(expenseId, body.action, {
          userId: user.id,
          payNow: Boolean(body.payNow),
          activeStoreId: user.storeId,
          reason: body.reason ?? null,
        });
        break;
      case 'pay': {
        await requireAction('expenses.create');
        const storeId = await requireActiveStore(user);
        result = await payExpense(expenseId, { userId: user.id, storeId });
        break;
      }
      default:
        throw new ValidationError('Action inconnue');
    }
    await writeAudit({ user, action: 'update', entity: 'expense', entityId: expenseId, details: { branch: branch.name, action: body.action } });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/** DELETE — annulation motivée (l'argent revient en caisse s'il était sorti). */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.view');
    await requireAction('expenses.delete');
    const expenseId = parseId(id);
    await expenseOfBranch(branch.id, expenseId);
    const body = await readJson<any>(request).catch(() => ({}) as any);
    const reason = String(body?.reason ?? request.nextUrl.searchParams.get('reason') ?? '');
    const storeId = await requireActiveStore(user);
    const result = await cancelExpense(expenseId, { reason, userId: user.id, storeId });
    await writeAudit({ user, action: 'cancel', entity: 'expense', entityId: expenseId, details: { branch: branch.name, reason: result.reason } });
    return ok({ success: true, id: expenseId, reason: result.reason });
  } catch (error) {
    return fail(error);
  }
}
