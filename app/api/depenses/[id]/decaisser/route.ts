import { fail, ok, parseId, requireAction, requireActiveStore } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { payExpense } from '@/lib/expenses';

type Params = { params: Promise<{ id: string }> };

/** POST /api/depenses/[id]/decaisser — sortie de caisse d'une dépense approuvée (magasin de la dépense). */
export async function POST(_request: Request, { params }: Params) {
  try {
    const user = await requireAction('expenses.create');
    const { id } = await params;
    const storeId = await requireActiveStore(user);
    const expense = await payExpense(parseId(id), { userId: user.id, storeId });
    await writeAudit({
      user,
      action: 'payment',
      entity: 'expense',
      entityId: expense.id,
      details: { montant: expense.amount, catégorie: expense.category },
    });
    return ok(expense);
  } catch (error) {
    return fail(error);
  }
}
