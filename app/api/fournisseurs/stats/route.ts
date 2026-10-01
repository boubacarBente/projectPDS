import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest } from '@/lib/api';
import { getSuppliersSummary } from '@/lib/suppliers';

/** GET — compteurs de l'en-tête de page, limités aux magasins demandés (?store=all|id). */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('suppliers.view');
    return ok(await getSuppliersSummary(scopeFromRequest(user, request)));
  } catch (error) {
    return fail(error);
  }
}
