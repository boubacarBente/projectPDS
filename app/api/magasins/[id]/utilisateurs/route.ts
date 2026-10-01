import { NextRequest } from 'next/server';
import { assertStoreVisible, fail, ok, parseId, requireAction } from '@/lib/api';
import { listStoreUsers } from '@/lib/stores';

type Params = { params: Promise<{ id: string }> };

/** GET /api/magasins/[id]/utilisateurs — équipe affectée au magasin. Permission : `stores.view`. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('stores.view');
    const { id } = await params;
    const storeId = parseId(id);
    assertStoreVisible(user, storeId);
    return ok(await listStoreUsers(storeId));
  } catch (error) {
    return fail(error);
  }
}
