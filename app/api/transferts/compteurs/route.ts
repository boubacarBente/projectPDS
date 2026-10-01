import { NextRequest } from 'next/server';
import { fail, ok, requireAction, scopeFromRequest } from '@/lib/api';
import { getTransferCounters } from '@/lib/transfers';

/**
 * GET /api/transferts/compteurs — `{ toApprove, toShip, toReceive, disputed }`
 * pour les badges du menu et les alertes du tableau de bord.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('transfers.view');
    return ok(await getTransferCounters(scopeFromRequest(user, request)));
  } catch (error) {
    return fail(error);
  }
}
