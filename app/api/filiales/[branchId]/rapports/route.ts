import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest, ValidationError } from '@/lib/api';
import { getBrickReports } from '@/lib/brick-analytics';
import { requireBranch } from '@/lib/branches';
import { startOfMonth, today } from '@/lib/format';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/rapports?from=&to= — tout le rapport de la
 * filiale (production, dépenses, ventes, créances, paiements, stock, pertes,
 * rentabilité) sur la portée de magasins. Rentabilité incluse : le rapport
 * complet exige `reports.viewAll` **et** `balances.view` (invariant 13).
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    await requireAction('reports.viewAll');
    await requireAction('balances.view');
    const search = request.nextUrl.searchParams;
    const todayDate = today();
    const rawFrom = search.get('from');
    const rawTo = search.get('to');
    const from = rawFrom && /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) ? rawFrom : startOfMonth(todayDate);
    const to = rawTo && /^\d{4}-\d{2}-\d{2}$/.test(rawTo) ? rawTo : todayDate;
    if (from > to) throw new ValidationError('La date de début doit précéder la date de fin');
    return ok(await getBrickReports(from, to, scopeFromRequest(user, request), [branch.id]));
  } catch (error) {
    return fail(error);
  }
}
