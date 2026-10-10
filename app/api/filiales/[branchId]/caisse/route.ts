import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, requireAction, scopeFromRequest } from '@/lib/api';
import { requireBranch } from '@/lib/branches';
import { getBranchCashSummary, listCashMovements } from '@/lib/caisse';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/caisse — caisse de la filiale (README §31.8,
 * option B : caisse générale du magasin, chaque mouvement porte sa filiale).
 * Entrées, sorties, solde cumulé, détail par moyen et par origine, mouvements.
 * Droits : filiale + `cash.view`.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    await requireAction('cash.view');
    const query = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(query);
    const scope = scopeFromRequest(user, request);
    const from = query.get('from') ?? undefined;
    const to = query.get('to') ?? undefined;
    const [movements, summary] = await Promise.all([
      listCashMovements({
        scope,
        branchIds: [branch.id],
        type: (query.get('type') as 'income' | 'expense' | null) ?? undefined,
        paymentMethod: query.get('paymentMethod') ?? undefined,
        from,
        to,
        search: query.get('search') ?? undefined,
        page,
        limit,
      }),
      getBranchCashSummary({ scope, branchId: branch.id, from, to }),
    ]);
    return ok({ ...movements, summary });
  } catch (error) {
    return fail(error);
  }
}
