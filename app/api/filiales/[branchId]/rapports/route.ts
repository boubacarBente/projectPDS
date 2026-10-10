import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest, ValidationError } from '@/lib/api';
import { getBrickReports } from '@/lib/brick-analytics';
import { requireBranch } from '@/lib/branches';
import { startOfMonth, today } from '@/lib/format';
import { getBranchCashSummary } from '@/lib/caisse';
import { listInventories } from '@/lib/inventories';

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
    const scope = scopeFromRequest(user, request);
    const [report, cash, inventories] = await Promise.all([
      getBrickReports(from, to, scope, [branch.id]),
      getBranchCashSummary({ scope, branchId: branch.id, from, to }),
      listInventories({ scope, branchId: branch.id, status: 'all', limit: 200 }),
    ]);
    // Caisse et inventaires de la filiale (README §31.6, §31.8) ; inventaires ouverts sur la période.
    const inPeriod = inventories.data.filter((row) => {
      const day = row.createdAt ? row.createdAt.toISOString().slice(0, 10) : '';
      return day >= from && day <= to;
    });
    return ok({ ...report, cash, inventories: inPeriod });
  } catch (error) {
    return fail(error);
  }
}
