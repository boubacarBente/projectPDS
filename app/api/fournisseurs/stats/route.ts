import { fail, ok, requireAction } from '@/lib/api';
import { getSuppliersSummary } from '@/lib/suppliers';

/** GET /api/fournisseurs/stats — compteurs de l'en-tête de page. */
export async function GET() {
  try {
    await requireAction('suppliers.view');
    return ok(await getSuppliersSummary());
  } catch (error) {
    return fail(error);
  }
}
