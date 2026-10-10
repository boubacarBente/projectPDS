import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest, ValidationError } from '@/lib/api';
import { getBranchesOverview } from '@/lib/brick-analytics';
import { listAccessibleBranches } from '@/lib/branches';
import { canViewSalesProfit } from '@/lib/sales';
import { startOfMonth, today } from '@/lib/format';
import { can } from '@/lib/permissions';

/**
 * GET /api/filiales/synthese?from=&to=&branches=1,2 — vue consolidée de la
 * direction (README §31.5) : une ligne par filiale autorisée et les totaux.
 * Coût de production et marge `null` sans `balances.view` (invariant 13).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('brick.view');
    const search = request.nextUrl.searchParams;
    const todayDate = today();
    const rawFrom = search.get('from');
    const rawTo = search.get('to');
    const from = rawFrom && /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) ? rawFrom : startOfMonth(todayDate);
    const to = rawTo && /^\d{4}-\d{2}-\d{2}$/.test(rawTo) ? rawTo : todayDate;
    if (from > to) throw new ValidationError('La date de début doit précéder la date de fin');

    const accessible = await listAccessibleBranches(user, { includeInactive: true });
    const wanted = (search.get('branches') ?? '')
      .split(',')
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0);
    // Une filiale demandée mais non autorisée est ignorée, jamais lue.
    const branches = wanted.length ? accessible.filter((b) => wanted.includes(b.id)) : accessible.filter((b) => b.status !== 'archived');
    const rows = await getBranchesOverview(scopeFromRequest(user, request), branches.map((b) => b.id), from, to);
    const withCosts = await canViewSalesProfit(user);
    // Caisse et dépenses suivent leurs propres droits ; coûts et bénéfice, `balances.view`.
    const withCash = can(user, 'cash.view', user.permissions);
    const withExpenses = can(user, 'expenses.view', user.permissions);
    const data = rows.map((row) => {
      const branch = branches.find((b) => b.id === row.branchId)!;
      const base = { ...row, name: branch.name, color: branch.color, status: branch.status, unit: branch.unit, icon: branch.icon };
      return {
        ...base,
        productionCost: withCosts ? base.productionCost : null,
        margin: withCosts ? base.margin : null,
        profit: withCosts ? base.profit : null,
        stockPurchaseValue: withCosts ? base.stockPurchaseValue : null,
        globalExpenses: withExpenses ? base.globalExpenses : null,
        cashBalance: withCash ? base.cashBalance : null,
      };
    });
    const sum = (
      key: 'revenue' | 'collected' | 'outstanding' | 'productionCost' | 'margin' | 'stockSaleValue' | 'openOrders' | 'globalExpenses' | 'profit' | 'cashBalance' | 'stockPurchaseValue',
    ) =>
      Math.round(rows.reduce((total, row) => total + Number(row[key] ?? 0), 0) * 100) / 100;
    return ok({
      from,
      to,
      data,
      totals: {
        revenue: sum('revenue'),
        collected: sum('collected'),
        outstanding: sum('outstanding'),
        productionCost: withCosts ? sum('productionCost') : null,
        margin: withCosts ? sum('margin') : null,
        globalExpenses: withExpenses ? sum('globalExpenses') : null,
        profit: withCosts ? sum('profit') : null,
        cashBalance: withCash ? sum('cashBalance') : null,
        stockPurchaseValue: withCosts ? sum('stockPurchaseValue') : null,
        stockSaleValue: sum('stockSaleValue'),
        openOrders: sum('openOrders'),
      },
      branches: accessible.map((b) => ({ id: b.id, name: b.name, status: b.status, color: b.color })),
    });
  } catch (error) {
    return fail(error);
  }
}
