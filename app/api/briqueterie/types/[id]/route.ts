import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  toBool,
  toNumber,
  NotFoundError,
} from '@/lib/api';
import {
  deactivateBrickType,
  getBrickType,
  isBrickShape,
  reactivateBrickType,
  updateBrickType,
} from '@/lib/brick';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/briqueterie/types/[id] */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('brick.view');
    const { id } = await params;

    const brickType = await getBrickType(parseId(id));
    if (!brickType) throw new NotFoundError('Type de brique introuvable');

    return ok(brickType);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/briqueterie/types/[id] */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.update');
    const { id } = await params;
    const brickTypeId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.productId !== undefined) patch.productId = toNumber(body.productId, 0);
    if (body.name !== undefined) patch.name = body.name;
    if (body.shape !== undefined && isBrickShape(body.shape)) patch.shape = body.shape;
    if (body.dimensions !== undefined) patch.dimensions = body.dimensions;
    if (body.description !== undefined) patch.description = body.description;
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);

    const brickType = await updateBrickType(brickTypeId, patch as any);

    await writeAudit({
      user,
      action: 'update',
      entity: 'brick_type',
      entityId: brickTypeId,
      details: patch,
    });

    return ok(brickType);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/briqueterie/types/[id] — **désactivation**, jamais de suppression
 * physique : un lot ancien doit rester rattaché à son type de brique (§7).
 * `?reactivate=true` réactive le type.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.delete');
    const { id } = await params;
    const brickTypeId = parseId(id);

    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';

    if (reactivate) {
      await reactivateBrickType(brickTypeId);
    } else {
      await deactivateBrickType(brickTypeId);
    }

    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'brick_type',
      entityId: brickTypeId,
      details: { reactivated: reactivate },
    });

    return ok({ success: true, deactivated: !reactivate });
  } catch (error) {
    return fail(error);
  }
}
