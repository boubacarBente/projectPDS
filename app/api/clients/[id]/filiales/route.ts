import { NextRequest } from 'next/server';
import { fail, ok, parseId, requireAction } from '@/lib/api';
import { assertCustomerVisible } from '@/lib/customers';
import { customerBranchActivity } from '@/lib/branches';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/clients/[id]/filiales — activité du client **filiale par filiale**
 * (README §31.4) : commandes, ventes, encaissé, reste dû. Seules les filiales
 * accessibles à la session apparaissent ; un compte sans droit sur les
 * filiales reçoit une liste vide.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('customers.view');
    const customerId = parseId((await params).id);
    await assertCustomerVisible(user, customerId);
    if (!user.permissions.includes('brick.view')) return ok({ data: [] });
    return ok({ data: await customerBranchActivity(user, customerId) });
  } catch (error) {
    return fail(error);
  }
}
