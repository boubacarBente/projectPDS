import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireAction, toInt } from '@/lib/api';
import { createPurchaseInvoice, listPurchaseInvoices, parsePurchaseInput } from '@/lib/purchases';

/**
 * GET /api/achats — liste paginée, filtrable (§27.2).
 *
 * Filtres : `search` (référence d'achat, référence fournisseur **ou** nom du
 * fournisseur), `supplierId`, `from`, `to`, `paymentStatus`, `status`.
 *
 * ⚠️ `?supplierId=<id>` est consommé par la modale « Payer une dette » de
 * `components/fournisseurs/fournisseurs-modals.tsx` : chaque ligne doit porter
 * `id`, `reference`, `remainingAmount` et `status`. Le contrat est tenu par
 * `listPurchaseInvoices()`.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('purchases.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const supplierId = params.get('supplierId');

    const result = await listPurchaseInvoices({
      search: params.get('search') ?? undefined,
      supplierId: supplierId ? toInt(supplierId, 0) || undefined : undefined,
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
 * POST /api/achats — création d'un achat (§7.5, §14).
 *
 * Toute la chaîne (validation, numérotation `ACH-…`, instantanés, **entrées** de
 * stock via `lib/stock.ts`, décaissement + reçu via `createPayment`, journal
 * d'actions) vit dans `lib/purchases.ts` ; le handler reste mince
 * (permission → parsing → `lib/` → réponse).
 *
 * `201 { invoice: PurchaseInvoiceRow }`.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('purchases.create');
    const body = await readJson<any>(request);

    const invoice = await createPurchaseInvoice({ ...parsePurchaseInput(body), userId: user.id });

    return ok({ invoice }, 201);
  } catch (error) {
    return fail(error);
  }
}
