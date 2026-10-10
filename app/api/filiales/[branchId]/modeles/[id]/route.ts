import { NextRequest } from 'next/server';
import { assertStoreVisible, fail, NotFoundError, ok, parseId, readJson, requireActiveStore, toBool, toNumber } from '@/lib/api';
import { getBrickType, isBrickShape, setBrickTypeActive, updateBrickType } from '@/lib/brick';
import { requireBranch } from '@/lib/branches';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ branchId: string; id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.view');
    const type = await getBrickType(parseId(id));
    if (!type || type.branchId !== branch.id) throw new NotFoundError('Modèle introuvable dans cette filiale');
    assertStoreVisible(user, type.storeId);
    return ok(type);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/filiales/[branchId]/modeles/[id] — modification (magasin actif uniquement). */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.types', { write: true });
    const typeId = parseId(id);
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const patch: Record<string, unknown> = {};
    if (body.productId !== undefined) patch.productId = toNumber(body.productId, 0);
    if (body.name !== undefined) patch.name = body.name;
    if (body.shape !== undefined && isBrickShape(body.shape)) patch.shape = body.shape;
    for (const key of ['dimensions', 'description', 'category', 'productionUnit', 'length', 'width', 'height', 'thickness', 'alertThreshold']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);
    const type = await updateBrickType(typeId, patch, storeId, branch.id);
    await writeAudit({
      user,
      action: 'update',
      entity: 'brick_type',
      entityId: typeId,
      details: { branch: branch.name, fields: Object.keys(patch), name: type.name },
    });
    return ok(type);
  } catch (error) {
    return fail(error);
  }
}

/** DELETE — **désactivation** (jamais de suppression) ; `?reactivate=true` réactive. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.types', { write: true });
    const typeId = parseId(id);
    const storeId = await requireActiveStore(user);
    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';
    const type = await setBrickTypeActive(typeId, reactivate, storeId, branch.id);
    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'brick_type',
      entityId: typeId,
      details: { branch: branch.name, name: type.name, isActive: type.isActive },
    });
    return ok(type);
  } catch (error) {
    return fail(error);
  }
}
