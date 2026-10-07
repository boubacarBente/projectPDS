import { NextRequest } from 'next/server';
import { fail, ok, readJson, required, requireAction, requireActiveStore, scopeFromRequest, toBool, toNumber } from '@/lib/api';
import { createBrickType, isBrickShape, listBrickTypes } from '@/lib/brick';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/briqueterie/types — types de briques de la portée (README §30).
 * `?includeInactive=true` montre aussi les types désactivés ; `?sort=name`.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('brick.view');
    const params = request.nextUrl.searchParams;
    const data = await listBrickTypes({
      scope: scopeFromRequest(user, request),
      includeInactive: toBool(params.get('includeInactive'), false),
      sort: params.get('sort') === 'name' ? 'name' : 'recent',
    });
    return ok({ data, total: data.length });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/briqueterie/types — nouveau type du magasin actif, lié à un produit. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('brick.types');
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const type = await createBrickType({
      storeId,
      userId: user.id,
      productId: toNumber(body.productId, 0),
      name: required(body.name, 'Nom'),
      shape: isBrickShape(body.shape) ? body.shape : undefined,
      dimensions: body.dimensions ?? null,
      description: body.description ?? null,
      isActive: toBool(body.isActive, true),
    });
    await writeAudit({ user, action: 'create', entity: 'brick_type', entityId: type.id, details: { name: type.name, product: type.productName } });
    return ok(type, 201);
  } catch (error) {
    return fail(error);
  }
}
