import { NextRequest } from 'next/server';
import { fail, ok, requireAction } from '@/lib/api';
import { getExpensesSummary, isExpenseScope } from '@/lib/expenses';

/**
 * GET /api/depenses/stats — synthèse par catégorie et par période (README §7.9,
 * §11 « Caisse et dépenses »).
 *
 * Bornes `from` / `to` inclusives sur la **date métier** (§6.5 règle 2).
 * Aucun total n'est stocké : tout est agrégé à la lecture, depuis `expenses`.
 *
 * `?scope=general|production` sépare les frais de fonctionnement des dépenses
 * rattachées à un lot de briqueterie (§20).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('expenses.view');

    const params = request.nextUrl.searchParams;
    const scope = params.get('scope');

    const summary = await getExpensesSummary({
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      scope: isExpenseScope(scope) ? scope : undefined,
    });

    return ok(summary);
  } catch (error) {
    return fail(error);
  }
}
