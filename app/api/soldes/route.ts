import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, requireAction } from '@/lib/api';
import {
  getBalancesSummary,
  getClientBalances,
  getMargins,
  getSupplierBalances,
  getTopCustomers,
  getTopSuppliers,
} from '@/lib/balances';
import { resolvePeriod, type PeriodKey } from '@/lib/dashboard';

/** Bornes de période acceptées, dans l'ordre du sélecteur de `/soldes`. */
const PERIODS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];

/**
 * GET /api/soldes?from=&to=&period=&search=&debtors=&creditors=&page=&limit=
 *
 * Soldes clients, dettes fournisseurs, résultat de la période et produits les
 * plus rentables. **Aucune valeur n'est stockée** : tout est calculé à la
 * lecture par `lib/balances.ts` (README §10, §15).
 *
 * Les bornes sont inclusives et portent sur la date **métier** `YYYY-MM-DD`,
 * jamais sur un horodatage (CONVENTIONS §6 règle 2).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('balances.view');

    const params = request.nextUrl.searchParams;

    /* ------------------------- Bornes de la période ------------------------- */

    const explicitFrom = params.get('from');
    const explicitTo = params.get('to');
    const periodKeyParam = params.get('period') as PeriodKey | null;
    const periodKey: PeriodKey =
      periodKeyParam && PERIODS.includes(periodKeyParam) ? periodKeyParam : 'month';

    const named = resolvePeriod(periodKey);
    const from = explicitFrom || named.from;
    const to = explicitTo || named.to;

    /* ------------------------------ Filtres --------------------------------- */

    const { page, limit } = parsePagination(params);
    const search = params.get('search')?.trim() || undefined;
    // Un filtre absent n'exclut rien : le tableau montre alors tout le monde.
    const debtorsOnly = params.get('debtors') === 'true';
    const creditorsOnly = params.get('creditors') === 'true';

    /* -------------------------------- Lecture ------------------------------- */

    const [summary, clients, suppliers, topCustomers, topSuppliers, margins] = await Promise.all([
      getBalancesSummary({ from, to }),
      getClientBalances({ search, debtorsOnly, page, limit }),
      getSupplierBalances({ search, creditorsOnly, page, limit }),
      getTopCustomers(from, to, 10),
      getTopSuppliers(from, to, 10),
      getMargins(from, to, 20),
    ]);

    return ok({
      period: { key: periodKey, from, to, label: explicitFrom || explicitTo ? 'Période choisie' : named.label },
      summary,
      clients,
      suppliers,
      topCustomers,
      topSuppliers,
      margins,
    });
  } catch (error) {
    return fail(error);
  }
}
