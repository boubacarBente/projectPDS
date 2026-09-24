import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireAction, toInt } from '@/lib/api';
import { createSalesInvoice, listSalesInvoices, parseSalesInput } from '@/lib/sales';

/**
 * GET /api/ventes — liste paginée, filtrable (§27.2).
 *
 * Filtres : `search` (numéro de facture **ou** nom du client), `customerId`,
 * `from`, `to`, `paymentStatus`, `status`.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('sales.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const customerId = params.get('customerId');

    const result = await listSalesInvoices({
      search: params.get('search') ?? undefined,
      customerId: customerId ? toInt(customerId, 0) || undefined : undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      paymentStatus: params.get('paymentStatus') ?? undefined,
      status: params.get('status') ?? undefined,
      page,
      limit,
    });

    return ok(result);
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

    const invoice = await createSalesInvoice({ ...parseSalesInput(body), userId: user.id });

    return ok({ invoice }, 201);
  } catch (error) {
    return fail(error);
  }
}
