import { NextRequest } from 'next/server';
import {
  assertStoreVisible,
  fail,
  NotFoundError,
  ok,
  parseId,
  readJson,
  requireAction,
  requireActiveStore,
  toBool,
  toNumber,
} from '@/lib/api';
import {
  computeModelRequirements,
  getFurnitureModel,
  setFurnitureModelActive,
  setModelMaterials,
  updateFurnitureModel,
} from '@/lib/furniture';
import { writeAudit } from '@/lib/audit';
import type { SessionUser } from '@/lib/api';

type Params = { params: Promise<{ id: string }> };

/** Fiche + nomenclature ; `quantity > 0` ajoute les besoins pour N unités (stock du magasin du modèle). */
async function modelFor(user: SessionUser, id: number, quantity = 0) {
  const record = await getFurnitureModel(id);
  if (!record) throw new NotFoundError('Modèle introuvable');
  assertStoreVisible(user, record.model.storeId);
  if (quantity > 0) {
    return { ...record, requirements: await computeModelRequirements(id, quantity, record.model.storeId) };
  }
  return record;
}

/** GET /api/atelier/modeles/[id] — `?quantity=3` calcule les besoins pour 3 unités. */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('furniture.view');
    const { id } = await params;
    return ok(await modelFor(user, parseId(id), toNumber(request.nextUrl.searchParams.get('quantity'), 0)));
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/atelier/modeles/[id] — `{ ...champs }` met à jour la fiche ;
 * `{ materials: [...] }` remplace la nomenclature. Magasin actif uniquement.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('furniture.models');
    const { id } = await params;
    const modelId = parseId(id);
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);

    const patch: Record<string, unknown> = {};
    for (const key of ['code', 'name', 'description', 'standardDimensions']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.laborHours !== undefined) patch.laborHours = toNumber(body.laborHours, 0);
    if (body.salePrice !== undefined) patch.salePrice = toNumber(body.salePrice, 0);
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);
    if (Object.keys(patch).length > 0) await updateFurnitureModel(modelId, patch, storeId);

    if (Array.isArray(body.materials)) {
      await setModelMaterials(
        modelId,
        body.materials.map((line: any) => ({
          productId: toNumber(line?.productId, 0),
          quantity: toNumber(line?.quantity, 0),
          unit: line?.unit ?? null,
          notes: line?.notes ?? null,
        })),
        storeId,
      );
    }

    const updated = await modelFor(user, modelId, toNumber(body.quantity, 0));
    await writeAudit({
      user,
      action: 'update',
      entity: 'furniture_model',
      entityId: modelId,
      details: { fields: Object.keys(patch), materialsReplaced: Array.isArray(body.materials), materialLines: updated.materials.length },
    });
    return ok(updated);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/atelier/modeles/[id] — **désactivation**, jamais une suppression
 * (les commandes passées gardent leur modèle). `?reactivate=true` réactive.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('furniture.models');
    const { id } = await params;
    const modelId = parseId(id);
    const storeId = await requireActiveStore(user);
    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';

    const model = await setFurnitureModelActive(modelId, reactivate, storeId);
    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'furniture_model',
      entityId: modelId,
      details: { code: model.code, name: model.name, isActive: model.isActive },
    });
    return ok(model);
  } catch (error) {
    return fail(error);
  }
}
