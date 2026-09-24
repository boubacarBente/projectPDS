import { NextRequest } from 'next/server';
import { fail, ok, readJson, requireAction, toBool, toNumber, required } from '@/lib/api';
import { createBrickType, isBrickShape, listBrickTypes } from '@/lib/brick';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/briqueterie/types — types de briques et leur produit lié.
 *
 * Le produit lié (`product_id`) est celui qui porte le **prix de vente et le
 * stock** des briques finies (README §20).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('brick.view');

    const includeInactive =
      toBool(request.nextUrl.searchParams.get('includeInactive'), false) ||
      request.nextUrl.searchParams.get('all') === '1';

    return ok({ data: await listBrickTypes({ includeInactive }) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/briqueterie/types */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('brick.create');
    const body = await readJson<any>(request);

    const brickType = await createBrickType({
      productId: toNumber(body.productId, 0),
      name: required(body.name, 'Nom'),
      shape: isBrickShape(body.shape) ? body.shape : undefined,
      dimensions: body.dimensions ?? null,
      description: body.description ?? null,
      isActive: toBool(body.isActive, true),
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'brick_type',
      entityId: brickType.id,
      details: {
        name: brickType.name,
        shape: brickType.shape,
        dimensions: brickType.dimensions,
        productId: brickType.productId,
      },
    });

    return ok(brickType, 201);
  } catch (error) {
    return fail(error);
  }
}
