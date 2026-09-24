import { NextRequest } from 'next/server';
import { fail, ok, parseId, parsePagination, requireAction, NotFoundError } from '@/lib/api';
import { getSupplier, listSupplierPayments } from '@/lib/suppliers';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/fournisseurs/[id]/paiements — historique des règlements du
 * fournisseur (les `payments` de type `purchase` rattachés à ses factures).
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireAction('suppliers.view');
    const { id } = await params;
    const supplierId = parseId(id);

    const supplier = await getSupplier(supplierId);
    if (!supplier) throw new NotFoundError('Fournisseur introuvable');

    const { page, limit } = parsePagination(request.nextUrl.searchParams);

    return ok(await listSupplierPayments(supplierId, { page, limit }));
  } catch (error) {
    return fail(error);
  }
}
