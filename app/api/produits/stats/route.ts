import { fail, ok, requireAction } from '@/lib/api';
import { getProductsSummary } from '@/lib/products';

/** GET /api/produits/stats — compteurs du catalogue (en-tête de page). */
export async function GET() {
  try {
    await requireAction('products.view');
    return ok(await getProductsSummary());
  } catch (error) {
    return fail(error);
  }
}
