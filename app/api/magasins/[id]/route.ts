import { NextRequest } from 'next/server';
import {
  NotFoundError,
  assertStoreVisible,
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  requireCentralEdit,
} from '@/lib/api';
import { getStore, getStoreIndicators, listStoreUsers, updateStore, type StoreInput } from '@/lib/stores';
import { resolvePeriod } from '@/lib/dashboard';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/magasins/[id] — fiche magasin : informations, équipe affectée et
 * indicateurs du mois en cours. Permission : `stores.view` + magasin visible.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('stores.view');
    const { id } = await params;
    const storeId = parseId(id);
    assertStoreVisible(user, storeId);

    const store = await getStore(storeId);
    if (!store) throw new NotFoundError('Magasin introuvable');

    const period = resolvePeriod('month');
    const [users, indicators] = await Promise.all([
      listStoreUsers(storeId),
      getStoreIndicators(storeId, period.from, period.to),
    ]);

    return ok({ store, users, indicators, period });
  } catch (error) {
    return fail(error);
  }
}

/**
 * PUT /api/magasins/[id] — modification des informations (siège uniquement).
 * Seuls les champs présents dans le corps sont modifiés.
 * Permission : `stores.manage`.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('stores.manage');
    await requireCentralEdit();
    const { id } = await params;
    const storeId = parseId(id);
    const body = await readJson<any>(request);

    const patch: StoreInput = {};
    for (const key of [
      'code',
      'name',
      'address',
      'phone',
      'email',
      'openingDate',
      'openingHours',
      'receiptFooter',
      'notes',
    ] as const) {
      if (body[key] !== undefined) (patch as any)[key] = body[key];
    }
    if (body.kind !== undefined) patch.kind = body.kind === 'headquarters' ? 'headquarters' : 'store';
    if (body.managerUserId !== undefined) {
      patch.managerUserId = body.managerUserId ? Number(body.managerUserId) : null;
    }
    if (body.settings !== undefined) patch.settings = body.settings;

    return ok(await updateStore(storeId, patch, { id: user.id, name: user.name }));
  } catch (error) {
    return fail(error);
  }
}
