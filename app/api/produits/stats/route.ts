import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest } from '@/lib/api';
import { getProductsSummary } from '@/lib/products';

/** GET /api/produits/stats?store=all|<id> — compteurs du catalogue (en-tête de page). */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('products.view');
    return ok(await getProductsSummary(scopeFromRequest(user, request)));
  } catch (error) {
    return fail(error);
  }
}
