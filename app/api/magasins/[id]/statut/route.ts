import { NextRequest } from 'next/server';
import { ValidationError, fail, ok, parseId, readJson, requireAction, requireCentralEdit } from '@/lib/api';
import { setStoreStatus, type StoreStatus } from '@/lib/stores';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/magasins/[id]/statut — `{ status: 'active'|'suspended'|'archived', reason? }`.
 *
 *  - `suspended` : le magasin reste consultable mais plus aucune opération n'y
 *    est acceptée (vente, achat, caisse, transfert…).
 *  - `archived`  : refusé tant qu'une caisse est ouverte ou qu'un transfert est
 *    en cours avec ce magasin.
 * Permission : `stores.manage`.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('stores.manage');
    await requireCentralEdit();
    const { id } = await params;
    const body = await readJson<any>(request);

    const status = String(body.status ?? '') as StoreStatus;
    if (!['active', 'suspended', 'archived'].includes(status)) {
      throw new ValidationError('Statut invalide : actif, suspendu ou archivé');
    }

    const store = await setStoreStatus(parseId(id), status, { id: user.id, name: user.name }, body.reason ?? null);
    return ok(store);
  } catch (error) {
    return fail(error);
  }
}
