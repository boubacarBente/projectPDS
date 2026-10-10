import { NextRequest } from 'next/server';
import { assertAtelierAccess } from '@/lib/branches';
import { fail, ok, parsePagination, requireAction, scopeFromRequest, toBool, ConflictError } from '@/lib/api';
import { listFurnitureModels } from '@/lib/furniture';

/**
 * GET /api/atelier/modeles — modèles de meubles du magasin (README §29).
 * `?includeInactive=1` montre aussi les modèles désactivés ; `?sort=name`.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('brick.view');
    await assertAtelierAccess(user);
    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    return ok(
      await listFurnitureModels({
        scope: scopeFromRequest(user, request),
        search: params.get('search')?.trim() || undefined,
        includeInactive: toBool(params.get('includeInactive'), false),
        sort: params.get('sort') === 'name' ? 'name' : 'recent',
        page,
        limit,
      }),
    );
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
