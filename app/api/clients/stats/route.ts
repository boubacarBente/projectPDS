import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest } from '@/lib/api';
import { getCustomersSummary } from '@/lib/customers';

/** GET — compteurs de l'en-tête de page, limités aux magasins demandés (?store=all|id). */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('customers.view');
    return ok(await getCustomersSummary(scopeFromRequest(user, request)));
  } catch (error) {
    return fail(error);
  }
}
