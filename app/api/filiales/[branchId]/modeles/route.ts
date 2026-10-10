import { NextRequest } from 'next/server';
import { fail, ok, readJson, required, requireActiveStore, scopeFromRequest, toBool, toNumber } from '@/lib/api';
import { createBrickType, isBrickShape, listBrickTypes } from '@/lib/brick';
import { requireBranch } from '@/lib/branches';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/modeles — modèles de la filiale dans la portée
 * de magasins (README §31.3). `?includeInactive=true` montre aussi les modèles
 * désactivés ; `?sort=name`.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    const search = request.nextUrl.searchParams;
    const data = await listBrickTypes({
      scope: scopeFromRequest(user, request),
      branchIds: [branch.id],
      includeInactive: toBool(search.get('includeInactive'), false),
      sort: search.get('sort') === 'name' ? 'name' : 'recent',
    });
    return ok({ data, total: data.length });
  } catch (error) {
    return fail(error);
  }
}

/** POST — nouveau modèle de la filiale, dans le magasin actif, lié à un produit (prix et stock). */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.types', { write: true });
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const type = await createBrickType({
      storeId,
      branchId: branch.id,
      userId: user.id,
      productId: toNumber(body.productId, 0),
      name: required(body.name, 'Nom'),
      shape: isBrickShape(body.shape) ? body.shape : undefined,
      dimensions: body.dimensions ?? null,
      description: body.description ?? null,
      category: body.category ?? null,
      productionUnit: body.productionUnit ?? null,
      length: body.length ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
      thickness: body.thickness ?? null,
      alertThreshold: body.alertThreshold ?? null,
      isActive: toBool(body.isActive, true),
    });
    await writeAudit({
      user,
      action: 'create',
      entity: 'brick_type',
      entityId: type.id,
      details: { branch: branch.name, name: type.name, product: type.productName },
    });
    return ok(type, 201);
  } catch (error) {
    return fail(error);
  }
}
