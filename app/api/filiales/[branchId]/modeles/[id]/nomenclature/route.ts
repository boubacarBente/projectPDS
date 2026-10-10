import { NextRequest } from 'next/server';
import { assertStoreVisible, fail, NotFoundError, ok, parseId, readJson, requireActiveStore } from '@/lib/api';
import { getBrickType } from '@/lib/brick';
import { requireBranch } from '@/lib/branches';
import { listModelMaterials, setModelMaterials } from '@/lib/production-materials';
import { canViewSalesProfit } from '@/lib/sales';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ branchId: string; id: string }> };

/**
 * GET /api/filiales/[branchId]/modeles/[id]/nomenclature — matières pour une
 * unité du modèle (README §31.3). Prix d'achat masqués sans `balances.view`.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.view');
    const model = await getBrickType(parseId(id));
    if (!model || model.branchId !== branch.id) throw new NotFoundError('Modèle introuvable dans cette filiale');
    assertStoreVisible(user, model.storeId);
    const materials = await listModelMaterials(model.id);
    if (await canViewSalesProfit(user)) return ok(materials);
    return ok(materials.map((m) => ({ ...m, purchasePrice: null, amount: null })));
  } catch (error) {
    return fail(error);
  }
}

/** PUT `{ materials: [{ productId, quantity, notes }] }` — remplace la nomenclature (magasin actif). */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.types', { write: true });
    const modelId = parseId(id);
    const storeId = await requireActiveStore(user);
    const body = await readJson<any>(request);
    const materials = await setModelMaterials(modelId, Array.isArray(body?.materials) ? body.materials : [], storeId, branch.id);
    await writeAudit({
      user,
      action: 'update',
      entity: 'brick_type',
      entityId: modelId,
      details: { branch: branch.name, nomenclature: materials.map((m) => ({ product: m.productName, quantity: m.quantity })) },
    });
    return ok(materials);
  } catch (error) {
    return fail(error);
  }
}
