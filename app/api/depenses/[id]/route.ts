import { NextRequest } from 'next/server';
import {
  businessDate,
  fail,
  ok,
  parseId,
  readJson,
  toNumber,
  requireAction,
  NotFoundError,
} from '@/lib/api';
import { cancelExpense, getExpense, updateExpense } from '@/lib/expenses';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/depenses/[id] — une dépense (utile pour une fiche ou une impression). */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('expenses.view');
    const { id } = await params;

    const expense = await getExpense(parseId(id));
    if (!expense) throw new NotFoundError('Dépense introuvable');

    return ok(expense);
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/depenses/[id] — modification.
 *
 * Si le montant, le moyen de paiement, la date ou la catégorie change, la
 * caisse est **contre-passée puis réécrite** par `updateExpense` : la dépense et
 * la caisse ne peuvent pas diverger.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('expenses.update');
    const { id } = await params;
    const expenseId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.category !== undefined) patch.category = body.category;
    if (body.amount !== undefined) patch.amount = toNumber(body.amount, 0);
    if (body.description !== undefined) patch.description = body.description;
    if (body.paymentMethod !== undefined) patch.paymentMethod = body.paymentMethod;
    if (body.beneficiary !== undefined) patch.beneficiary = body.beneficiary;
    if (body.date !== undefined) patch.date = businessDate(body.date, 'date');
    if (body.referenceType !== undefined) patch.referenceType = body.referenceType;
    if (body.referenceId !== undefined) patch.referenceId = body.referenceId;

    const expense = await updateExpense(expenseId, patch as any, { userId: user.id });

    await writeAudit({
      user,
      action: 'update',
      entity: 'expense',
      entityId: expenseId,
      details: patch,
    });

    return ok(expense);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/depenses/[id] — **annulation**, jamais une suppression physique
 * (§6.5 règle 4, §26.13).
 *
 * Le **motif est obligatoire** (corps JSON `{ "reason": "…" }` ou
 * `?reason=…`) : annuler une sortie de caisse sans dire pourquoi rendrait
 * l'historique inexploitable. La dépense n'est plus comptée, un mouvement de
 * caisse inverse est enregistré, et rien n'est effacé.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('expenses.delete');
    const { id } = await params;
    const expenseId = parseId(id);

    let reason = request.nextUrl.searchParams.get('reason') ?? '';

    // Le corps est facultatif : un DELETE sans corps doit renvoyer « motif
    // obligatoire », pas « JSON invalide ».
    try {
      const body = await readJson<any>(request);
      if (body.reason !== undefined) reason = String(body.reason ?? '');
    } catch {
      // Corps absent ou illisible : on garde le motif de l'URL (souvent vide).
    }

    // Le motif obligatoire est vérifié dans `cancelExpense` (lib/) : un motif
    // vide renvoie un 400 explicite, en français, sans rien écrire.
    const result = await cancelExpense(expenseId, { reason, userId: user.id });

    await writeAudit({
      user,
      action: 'cancel',
      entity: 'expense',
      entityId: expenseId,
      details: { reason: result.reason },
    });

    return ok({ success: true, cancelled: true, id: expenseId, reason: result.reason });
  } catch (error) {
    return fail(error);
  }
}
