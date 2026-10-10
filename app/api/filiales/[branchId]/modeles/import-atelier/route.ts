import { NextRequest } from 'next/server';
import { fail, ok, requireActiveStore } from '@/lib/api';
import { requireBranch } from '@/lib/branches';
import { importFurnitureModels, listFurnitureImportCandidates } from '@/lib/production-materials';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ branchId: string }> };

/** GET — modèles de l'ancien atelier du magasin actif, et ceux déjà repris (README §31.9). */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { branchId } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.view');
    if (branch.activity !== 'furniture' || !user.storeId) return ok([]);
    return ok(await listFurnitureImportCandidates(user.storeId, branch.id));
  } catch (error) {
    return fail(error);
  }
}

/** POST — reprend les modèles non encore repris (produit lié + nomenclature), dans le magasin actif. */
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const { branchId } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.types', { write: true });
    const storeId = await requireActiveStore(user);
    const result = await importFurnitureModels(branch, storeId, user.id);
    await writeAudit({ user, action: 'create', entity: 'brick_type', entityId: branch.id, details: { branch: branch.name, importAtelier: result } });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
