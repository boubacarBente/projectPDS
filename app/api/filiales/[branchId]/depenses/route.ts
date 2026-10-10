import { NextRequest } from 'next/server';
import { businessDate, fail, ok, parsePagination, readJson, required, requireAction, requireActiveStore, scopeFromRequest, toNumber } from '@/lib/api';
import { requireBranch } from '@/lib/branches';
import { BRANCH_EXPENSE_REFERENCE } from '@/lib/branches-shared';
import { createExpense, getBranchExpensesSummary, listExpenses, type ExpenseApprovalStatus } from '@/lib/expenses';
import { writeAudit } from '@/lib/audit';
import { today } from '@/lib/format';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/depenses — dépenses de la filiale (README §31.7) :
 * de production (rattachées à un lot) et globales. `?kind=production|global`,
 * `approvalStatus`, `from`, `to`, `search`, `store`. Droits : filiale + `expenses.view`.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    await requireAction('expenses.view');
    const query = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(query);
    const scope = scopeFromRequest(user, request);
    const kind = query.get('kind');
    const from = query.get('from') ?? undefined;
    const to = query.get('to') ?? undefined;
    const [list, summary] = await Promise.all([
      listExpenses({
        scope,
        branchIds: [branch.id],
        branchKind: kind === 'production' || kind === 'global' ? kind : undefined,
        approvalStatus: (query.get('approvalStatus') as ExpenseApprovalStatus | 'all' | null) ?? undefined,
        includeCancelled: query.get('includeCancelled') === 'true',
        search: query.get('search') ?? undefined,
        from,
        to,
        page,
        limit,
      }),
      getBranchExpensesSummary({ scope, branchId: branch.id, from, to }),
    ]);
    return ok({ ...list, summary });
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST — dépense **globale** de la filiale (loyer, entretien, salaires…), dans
 * le magasin actif. Circuit normal des dépenses : seuil d'approbation, sortie de
 * caisse portant la filiale. Une dépense de lot se saisit depuis sa production.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.update', { write: true });
    await requireAction('expenses.create');
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const expense = await createExpense({
      storeId,
      canSkipApproval: user.role === 'admin',
      category: required(body.category, 'Catégorie'),
      amount: toNumber(body.amount, 0),
      description: body.description ?? null,
      paymentMethod: body.paymentMethod ?? 'Espèces',
      referenceType: BRANCH_EXPENSE_REFERENCE,
      referenceId: null,
      productionBranchId: branch.id,
      beneficiary: body.beneficiary ?? null,
      date: businessDate(body.date, 'date', today()),
      userId: user.id,
    });
    await writeAudit({
      user,
      action: 'create',
      entity: 'expense',
      entityId: expense.id,
      details: { branch: branch.name, category: expense.category, amount: expense.amount, approval: expense.approvalStatus },
    });
    return ok(expense, 201);
  } catch (error) {
    return fail(error);
  }
}
