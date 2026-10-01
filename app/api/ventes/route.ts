import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireAction, requireActiveStore, scopeFromRequest, toInt } from '@/lib/api';
import {
  canViewSalesProfit,
  createSalesInvoice,
  listSalesInvoices,
  parseSalesInput,
  withoutSalesProfit,
} from '@/lib/sales';

/**
 * GET /api/ventes — liste paginée, filtrable (§27.2).
 *
 * Filtres : `search` (numéro de facture **ou** nom du client), `customerId`,
 * `from`, `to`, `paymentStatus`, `status`, `channel`.
 *
 * **Magasin** : `?store=all|<id>` (défaut : magasin actif). Un seul canal de
 * vente (`general`) depuis le retrait de la briqueterie.
 *
 * Le **bénéfice** (`cost`, `profit`) n'est renvoyé qu'à un utilisateur détenant
 * `balances.view` : c'est une donnée financière sensible, et le serveur reste
 * seul juge (§9) — masquer la colonne côté interface n'est pas protéger.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('sales.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const customerId = params.get('customerId');
    const result = await listSalesInvoices({
      scope: scopeFromRequest(user, request),
      search: params.get('search') ?? undefined,
      customerId: customerId ? toInt(customerId, 0) || undefined : undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      paymentStatus: params.get('paymentStatus') ?? undefined,
      status: params.get('status') ?? undefined,
      page,
      limit,
    });

    if (await canViewSalesProfit(user)) return ok(result);

    return ok({ ...result, data: result.data.map(withoutSalesProfit) });
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/ventes — création d'une vente (§10.5).
 *
 * Toute la chaîne (contrôle de stock, numérotation, instantanés, mouvements de
 * stock, encaissement + reçu, journal d'actions) est dans `lib/sales.ts` ; le
 * handler reste mince (permission → parsing → `lib/` → réponse).
 *
 * `201 { invoice: SalesInvoiceRow }`.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('sales.create');
    const body = await readJson<any>(request);

    const storeId = await requireActiveStore(user);
    const invoice = await createSalesInvoice({ ...parseSalesInput(body), userId: user.id, storeId });

    return ok({ invoice }, 201);
  } catch (error) {
    return fail(error);
  }
}
