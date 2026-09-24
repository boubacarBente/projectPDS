import { NextRequest } from 'next/server';
import { fail, ok, requireAction } from '@/lib/api';
import { getPurchaseStats } from '@/lib/purchases';
import type { PeriodKey } from '@/lib/dashboard';

const PERIODS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];

/**
 * GET /api/achats/stats?period=day|week|month|year|total
 *
 * Compteurs **calculés à la lecture** (§15) : aucun total n'est stocké.
 * `totalAmount` est le montant acheté sur la période, `paid` ce qui a été
 * décaissé, `outstanding` la **dette fournisseur** restante (§15), et
 * `bySupplier` la répartition par fournisseur.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('purchases.view');

    const raw = request.nextUrl.searchParams.get('period') ?? 'month';
    const period: PeriodKey = (PERIODS as string[]).includes(raw) ? (raw as PeriodKey) : 'month';

    return ok(await getPurchaseStats(period));
  } catch (error) {
    return fail(error);
  }
}
