import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  requireAction,
  requireActiveStore,
  scopeFromRequest,
  toBool,
  toNumber,
} from '@/lib/api';
import { createFurnitureModel, listFurnitureModels, setModelMaterials } from '@/lib/furniture';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/atelier/modeles — modèles de meubles du magasin (README §29).
 * `?includeInactive=1` montre aussi les modèles désactivés ; `?sort=name`.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('furniture.view');
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

/** POST /api/atelier/modeles — nouveau modèle du magasin actif (nomenclature facultative). */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('furniture.models');
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);

    const model = await createFurnitureModel({
      storeId,
      userId: user.id,
      code: body.code ?? null,
      name: body.name,
      description: body.description ?? null,
      standardDimensions: body.standardDimensions ?? null,
      laborHours: toNumber(body.laborHours, 0),
      salePrice: toNumber(body.salePrice, 0),
    });
    if (Array.isArray(body.materials) && body.materials.length > 0) {
      await setModelMaterials(
        model.id,
        body.materials.map((line: any) => ({ productId: toNumber(line?.productId, 0), quantity: toNumber(line?.quantity, 0) })),
        storeId,
      );
    }

    await writeAudit({
      user,
      action: 'create',
      entity: 'furniture_model',
      entityId: model.id,
      details: { code: model.code, name: model.name, salePrice: model.salePrice },
    });
    return ok(model, 201);
  } catch (error) {
    return fail(error);
  }
}
