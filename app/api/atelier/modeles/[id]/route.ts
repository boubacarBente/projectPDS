import { NextRequest } from 'next/server';
import {
  NotFoundError,
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  toBool,
  toNumber,
} from '@/lib/api';
import {
  computeModelRequirements,
  deactivateFurnitureModel,
  getFurnitureModel,
  reactivateFurnitureModel,
  setModelMaterials,
  updateFurnitureModel,
  type FurnitureModelMaterialInput,
} from '@/lib/furniture';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/atelier/modeles/[id] — fiche modèle **avec sa nomenclature**.
 *
 * `?quantity=3` ajoute le calcul des besoins pour N unités, stock disponible et
 * manquant compris : c'est ce que consomme la modale de nomenclature.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireAction('furniture.view');
    const { id } = await params;
    const modelId = parseId(id);

    const record = await getFurnitureModel(modelId);
    if (!record) throw new NotFoundError('Modèle introuvable');

    const quantity = toNumber(request.nextUrl.searchParams.get('quantity'), 0);
    if (quantity > 0) {
      return ok({ ...record, requirements: await computeModelRequirements(modelId, quantity) });
    }

    return ok(record);
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/atelier/modeles/[id] — modification de la fiche.
 *
 * Deux usages dans un seul verre :
 *  - `{ ...champs }` met à jour l'en-tête ;
 *  - `{ materials: [...] }` **remplace la nomenclature** (BOM) via
 *    `setModelMaterials()`, qui met à jour, ajoute ou pose un tombstone — jamais
 *    de suppression physique.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('furniture.update');
    const { id } = await params;
    const modelId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.code !== undefined) patch.code = body.code;
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.standardDimensions !== undefined) patch.standardDimensions = body.standardDimensions;
    if (body.laborHours !== undefined) patch.laborHours = toNumber(body.laborHours, 0);
    if (body.salePrice !== undefined) patch.salePrice = toNumber(body.salePrice, 0);
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);

    if (Object.keys(patch).length > 0) {
      await updateFurnitureModel(modelId, patch as any);
    }

    if (Array.isArray(body.materials)) {
      const lines: FurnitureModelMaterialInput[] = body.materials.map((line: any) => ({
        productId: toNumber(line?.productId, 0),
        quantity: toNumber(line?.quantity, 0),
        unit: line?.unit ?? null,
        notes: line?.notes ?? null,
      }));

      await setModelMaterials(modelId, lines);
    }

    const updated = await getFurnitureModel(modelId);
    if (!updated) throw new NotFoundError('Modèle introuvable');

    const quantity = toNumber(body.quantity, 0);

    await writeAudit({
      user,
      action: 'update',
      entity: 'furniture_model',
      entityId: modelId,
      details: {
        fields: Object.keys(patch),
        materialsReplaced: Array.isArray(body.materials),
        materialLines: updated.materials.length,
      },
    });

    return ok(
      quantity > 0
        ? { ...updated, requirements: await computeModelRequirements(modelId, quantity) }
        : updated,
    );
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/atelier/modeles/[id] — **désactivation**, jamais une suppression
 * physique (§7). Une commande ancienne doit rester rattachée à son modèle.
 * `?reactivate=true` réactive la fiche.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('furniture.delete');
    const { id } = await params;
    const modelId = parseId(id);

    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';

    if (reactivate) {
      await reactivateFurnitureModel(modelId);
    } else {
      await deactivateFurnitureModel(modelId);
    }

    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'furniture_model',
      entityId: modelId,
      details: { reactivated: reactivate },
    });

    return ok({ success: true, deactivated: !reactivate });
  } catch (error) {
    return fail(error);
  }
}
