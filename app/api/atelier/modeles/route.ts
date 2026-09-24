import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  requireAction,
  required,
  toBool,
  toNumber,
} from '@/lib/api';
import {
  createFurnitureModel,
  listFurnitureModels,
} from '@/lib/furniture';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/atelier/modeles — liste paginée des fiches modèles (README §21).
 *
 * Chaque ligne porte le nombre de matériaux de sa nomenclature et le coût
 * matière estimé d'une unité : une fiche modèle sans nomenclature ne sert à
 * rien, l'écran doit donc le montrer d'emblée.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('furniture.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const result = await listFurnitureModels({
      search: params.get('search')?.trim() || undefined,
      includeInactive: toBool(params.get('includeInactive'), false),
      page,
      limit,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/atelier/modeles — création d'une fiche modèle.
 * `code` est généré (`MOD-0001`) s'il n'est pas fourni.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('furniture.create');
    const body = await readJson<any>(request);

    const model = await createFurnitureModel({
      code: body.code ?? null,
      name: required(body.name, 'Nom du modèle'),
      description: body.description ?? null,
      standardDimensions: body.standardDimensions ?? null,
      laborHours: toNumber(body.laborHours, 0),
      salePrice: toNumber(body.salePrice, 0),
      isActive: toBool(body.isActive, true),
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'furniture_model',
      entityId: model.id,
      details: {
        code: model.code,
        name: model.name,
        laborHours: model.laborHours,
        salePrice: model.salePrice,
      },
    });

    return ok(model, 201);
  } catch (error) {
    return fail(error);
  }
}
