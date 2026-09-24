import { NextResponse } from 'next/server';
import { fail, ok, requireAction } from '@/lib/api';
import { getCustomersSummary } from '@/lib/customers';

/** GET /api/clients/stats — compteurs de l'en-tête de page. */
export async function GET() {
  try {
    await requireAction('customers.view');
    return ok(await getCustomersSummary());
  } catch (error) {
    return fail(error);
  }
}
