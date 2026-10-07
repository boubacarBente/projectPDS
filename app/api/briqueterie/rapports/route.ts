import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest, ValidationError } from '@/lib/api';
import { getBrickReports } from '@/lib/brick-analytics';
import { startOfMonth, today } from '@/lib/format';

/**
 * GET /api/briqueterie/rapports?from=&to= — tout le rapport de la briqueterie
 * (production, dépenses, ventes, créances, paiements, stock, pertes,
 * rentabilité) sur la portée de magasins. Rentabilité incluse : le rapport
 * complet exige `reports.viewAll` **et** `balances.view` (invariant 13).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('brick.view');
    await requireAction('reports.viewAll');
    await requireAction('balances.view');
    const params = request.nextUrl.searchParams;
    const todayDate = today();
    const rawFrom = params.get('from');
    const rawTo = params.get('to');
    const from = rawFrom && /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) ? rawFrom : startOfMonth(todayDate);
    const to = rawTo && /^\d{4}-\d{2}-\d{2}$/.test(rawTo) ? rawTo : todayDate;
    if (from > to) throw new ValidationError('La date de début doit précéder la date de fin');
    return ok(await getBrickReports(from, to, scopeFromRequest(user, request)));
  } catch (error) {
    return fail(error);
  }
}
