import { NextRequest } from 'next/server';
import {
  businessDate,
  fail,
  ok,
  parsePagination,
  readJson,
  required,
  toNumber,
  requireAction,
  requireActiveStore,
  scopeFromRequest,
} from '@/lib/api';
import { createExpense, listExpenses, type ExpenseApprovalStatus } from '@/lib/expenses';
import { writeAudit } from '@/lib/audit';
import { hiddenBranchIds } from '@/lib/branches';
import { today } from '@/lib/format';

/**
 * GET|POST /api/depenses (README §27.2).
 *
 * Handler **mince** (§26.5) : permission → parsing → fonction de `lib/` →
 * réponse. Aucune requête Drizzle ici, toute la logique vit dans
 * `lib/expenses.ts` (c'est ce qui alimente la file de synchronisation).
 *
 * **Magasin** : `?store=all|<id>` (défaut : magasin actif).
 */

/** GET /api/depenses — liste paginée, filtrable (recherche, catégorie, moyen, période, portée). */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('expenses.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    const approval = params.get('approvalStatus');

    const result = await listExpenses({
      scope: scopeFromRequest(user, request),
      approvalStatus: (approval as ExpenseApprovalStatus | 'all' | null) ?? undefined,
      search: params.get('search') ?? undefined,
      category: params.get('category') ?? undefined,
      paymentMethod: params.get('paymentMethod') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      excludeBranchIds: await hiddenBranchIds(user),
      page,
      limit,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/depenses — création.
 *
 * La catégorie est validée **dans** `createExpense` contre la liste fermée de
 * `settings.expenseCategories` : une saisie libre est refusée en français.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('expenses.create');
    const body = await readJson<any>(request);

    const storeId = await requireActiveStore(user);
    const expense = await createExpense({
      storeId,
      // Seul l'administrateur général est dispensé : la grosse dépense d'un gérant est
      // approuvée par quelqu'un d'autre (séparation des tâches, lib/expenses.ts).
      canSkipApproval: user.role === 'admin',
      category: required(body.category, 'Catégorie'),
      amount: toNumber(body.amount, 0),
      description: body.description ?? null,
      paymentMethod: body.paymentMethod ?? 'Espèces',
      referenceType: body.referenceType ?? 'expense',
      referenceId: body.referenceId ?? null,
      beneficiary: body.beneficiary ?? null,
      date: businessDate(body.date, 'date', today()),
      userId: user.id,
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'expense',
      entityId: expense.id,
      details: {
        category: expense.category,
        amount: expense.amount,
        paymentMethod: expense.paymentMethod,
        date: expense.date,
        approbation: expense.approvalStatus,
      },
    });

    return ok(expense, 201);
  } catch (error) {
    return fail(error);
  }
}
