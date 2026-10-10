import { NextRequest } from 'next/server';
import { assertAtelierAccess } from '@/lib/branches';
import { fail, ok, parsePagination, requireAction, scopeFromRequest, toBool, toNumber, ConflictError } from '@/lib/api';
import { getWorkshopSummary, hideOrderCosts, listFurnitureOrders } from '@/lib/furniture';
import { isFurnitureStage } from '@/lib/furniture-shared';
import { canViewSalesProfit } from '@/lib/sales';

/**
 * GET /api/atelier/commandes — commandes de l'atelier de meubles (README §29).
 *
 * Portée : magasin actif, ou `?store=all|<id>` dans le périmètre de
 * l'utilisateur. Filtres : `search`, `stage`, `purpose`, `late=1`,
 * `customerId`, `from`, `to`, `includeCancelled`, `sort=promised`.
 * `?stats=1` renvoie la synthèse de la période. Coûts et marges : `null` sans
 * `balances.view` (invariant 13).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('brick.view');
    await assertAtelierAccess(user);
    const params = request.nextUrl.searchParams;
    const scope = scopeFromRequest(user, request);
    const withCosts = await canViewSalesProfit(user);

    if (params.get('stats') === '1') {
      const summary = await getWorkshopSummary({
        scope,
        from: params.get('from') || undefined,
        to: params.get('to') || undefined,
        withCosts,
      });
      return ok({ summary });
    }

    const { page, limit } = parsePagination(params);
    const stage = params.get('stage');
    const purpose = params.get('purpose');
    const result = await listFurnitureOrders({
      scope,
      search: params.get('search')?.trim() || undefined,
      stage: isFurnitureStage(stage) ? stage : undefined,
      purpose: purpose === 'stock' || purpose === 'customer' ? purpose : undefined,
      customerId: toNumber(params.get('customerId'), 0) || undefined,
      lateOnly: toBool(params.get('late'), false),
      includeCancelled: toBool(params.get('includeCancelled'), false),
      from: params.get('from') || undefined,
      to: params.get('to') || undefined,
      sort: params.get('sort') === 'promised' ? 'promised' : 'recent',
      page,
      limit,
    });
    return ok(withCosts ? result : { ...result, data: result.data.map(hideOrderCosts) });
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST — **fermé** : l'atelier est repris par la filiale Meuble (README §31.9).
 * Les anciennes commandes s'achèvent (`PUT /api/atelier/commandes/[id]`) ; tout
 * nouveau travail passe par `/api/filiales/[branchId]/*`.
 */
export async function POST() {
  try {
    const user = await requireAction('brick.view');
    await assertAtelierAccess(user);
    throw new ConflictError(
      'L’atelier de meubles est désormais la filiale « Meuble » : créez vos modèles, productions et commandes depuis son espace (menu de gauche).',
    );
  } catch (error) {
    return fail(error);
  }
}
