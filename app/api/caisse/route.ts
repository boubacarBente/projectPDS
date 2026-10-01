import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, toNumber, requireAction, requireActiveStore, scopeFromRequest } from '@/lib/api';
import { addCashMovement, getCashSummary, listCashMovements } from '@/lib/caisse';
import { writeAudit } from '@/lib/audit';

/** GET /api/caisse — mouvements paginés + résumé de la session. */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('cash.view');
    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    const scope = scopeFromRequest(user, request);

    const [movements, summary] = await Promise.all([
      listCashMovements({
        scope,
        type: (params.get('type') as 'income' | 'expense' | null) ?? undefined,
        paymentMethod: params.get('paymentMethod') ?? undefined,
        sessionId: params.get('sessionId') ? Number(params.get('sessionId')) : undefined,
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
        search: params.get('search') ?? undefined,
        page,
        limit,
      }),
      getCashSummary({ scope, from: params.get('from') ?? undefined, to: params.get('to') ?? undefined }),
    ]);

    return ok({ ...movements, summary });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/caisse — mouvement manuel d'entrée ou de sortie (§13). */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('cash.manual');
    const body = await readJson<any>(request);

    const type = body.type === 'expense' ? 'expense' : 'income';

    const storeId = await requireActiveStore(user);
    const result = await addCashMovement({
      storeId,
      type,
      amount: toNumber(body.amount),
      paymentMethod: body.paymentMethod ?? 'Espèces',
      motif: String(body.motif ?? '').trim() || 'Mouvement manuel',
      referenceType: 'manual',
      date: body.date,
      userId: user.id,
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'cash_movement',
      entityId: result.id,
      details: { type, amount: toNumber(body.amount), motif: body.motif },
    });

    return ok(result, 201);
  } catch (error) {
    return fail(error);
  }
}
