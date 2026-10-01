import { NotFoundError, assertStoreVisible, fail, ok, parseId, readJson, requireAction, ValidationError } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { decideExpense, getExpense } from '@/lib/expenses';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/depenses/[id]/approbation `{ decision: 'approve' | 'reject', reason?, payNow? }`
 *
 * Circuit d'approbation (§12) : une dépense en attente est approuvée (elle
 * devient « à décaisser ») ou rejetée (motif obligatoire). `payNow` décaisse
 * immédiatement si l'approbateur travaille dans le magasin de la dépense.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await requireAction('expenses.approve');
    const { id } = await params;
    const expenseId = parseId(id);
    const body = await readJson<{ decision?: unknown; reason?: unknown; payNow?: unknown }>(request);

    const existing = await getExpense(expenseId);
    if (!existing) throw new NotFoundError('Dépense introuvable');
    assertStoreVisible(user, existing.storeId);

    if (body.decision !== 'approve' && body.decision !== 'reject') {
      throw new ValidationError('Décision attendue : « approve » ou « reject »');
    }
    if (body.decision === 'reject' && !String(body.reason ?? '').trim()) {
      throw new ValidationError('Le motif du rejet est obligatoire');
    }

    const expense = await decideExpense(expenseId, body.decision, {
      userId: user.id,
      payNow: Boolean(body.payNow),
      activeStoreId: user.storeId,
      reason: body.reason ? String(body.reason) : null,
    });

    await writeAudit({
      user,
      storeId: existing.storeId,
      action: body.decision === 'approve' ? 'approve' : 'reject',
      entity: 'expense',
      entityId: expenseId,
      details: { montant: existing.amount, catégorie: existing.category, motif: body.reason ?? null },
    });

    return ok(expense);
  } catch (error) {
    return fail(error);
  }
}
