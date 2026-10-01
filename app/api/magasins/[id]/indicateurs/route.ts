import { NextRequest } from 'next/server';
import { ValidationError, assertStoreVisible, businessDate, fail, ok, parseId, requireAction } from '@/lib/api';
import { getStoreIndicators } from '@/lib/stores';
import { resolvePeriod } from '@/lib/dashboard';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/magasins/[id]/indicateurs?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Indicateurs rapides du magasin sur la période (mois en cours par défaut).
 * Permission : `stores.view`.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('stores.view');
    const { id } = await params;
    const storeId = parseId(id);
    assertStoreVisible(user, storeId);

    const month = resolvePeriod('month');
    const query = request.nextUrl.searchParams;
    const from = businessDate(query.get('from'), 'date de début', month.from);
    const to = businessDate(query.get('to'), 'date de fin', month.to);
    if (from > to) throw new ValidationError('La date de début doit précéder la date de fin');

    return ok({ from, to, indicators: await getStoreIndicators(storeId, from, to) });
  } catch (error) {
    return fail(error);
  }
}
