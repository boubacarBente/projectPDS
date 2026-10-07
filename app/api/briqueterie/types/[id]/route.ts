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
import { getBrickType, isBrickShape, setBrickTypeActive, updateBrickType } from '@/lib/brick';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.view');
    const { id } = await params;
    const type = await getBrickType(parseId(id));
    if (!type) throw new NotFoundError('Type de brique introuvable');
    assertStoreVisible(user, type.storeId);
    return ok(type);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/briqueterie/types/[id] — modification (magasin actif uniquement). */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.types');
    const { id } = await params;
    const typeId = parseId(id);
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const patch: Record<string, unknown> = {};
    if (body.productId !== undefined) patch.productId = toNumber(body.productId, 0);
    if (body.name !== undefined) patch.name = body.name;
    if (body.shape !== undefined && isBrickShape(body.shape)) patch.shape = body.shape;
    if (body.dimensions !== undefined) patch.dimensions = body.dimensions;
    if (body.description !== undefined) patch.description = body.description;
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);
    const type = await updateBrickType(typeId, patch, storeId);
    await writeAudit({ user, action: 'update', entity: 'brick_type', entityId: typeId, details: { fields: Object.keys(patch), name: type.name } });
    return ok(type);
  } catch (error) {
    return fail(error);
  }
}

/** DELETE — **désactivation** (jamais de suppression) ; `?reactivate=true` réactive. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.types');
    const { id } = await params;
    const typeId = parseId(id);
    const storeId = await requireActiveStore(user);
    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';
    const type = await setBrickTypeActive(typeId, reactivate, storeId);
    await writeAudit({ user, action: reactivate ? 'update' : 'delete', entity: 'brick_type', entityId: typeId, details: { name: type.name, isActive: type.isActive } });
    return ok(type);
  } catch (error) {
    return fail(error);
  }
}
