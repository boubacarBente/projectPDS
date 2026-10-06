import { NextRequest } from 'next/server';
import { fail, ok, readJson, required, requireAction, requireCentralEdit, toBool } from '@/lib/api';
import { createStore, getStoreIndicators, listStores } from '@/lib/stores';
import { resolvePeriod, type PeriodKey } from '@/lib/dashboard';

const PERIODS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];

/**
 * GET /api/magasins — magasins visibles par l'utilisateur.
 *
 * `?includeArchived=true` ajoute les magasins archivés (administrateur).
 * `?indicators=true&period=month` ajoute pour chacun ses indicateurs rapides
 * (CA, ventes, dépenses, créances, valeur du stock…) — tableau comparatif.
 * Permission : `stores.view`.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('stores.view');
    const params = request.nextUrl.searchParams;

    const stores = await listStores({
      includeArchived: user.allStores && toBool(params.get('includeArchived'), false),
      ids: user.allStores ? undefined : user.storeIds,
    });

    if (!toBool(params.get('indicators'), false)) return ok({ data: stores });

    const requested = (params.get('period') ?? 'month') as PeriodKey;
    const period = resolvePeriod(PERIODS.includes(requested) ? requested : 'month');
    const data = await Promise.all(
      stores.map(async (store) => ({
        ...store,
        indicators: await getStoreIndicators(store.id, period.from, period.to),
      })),
    );
    return ok({ data, period });
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/magasins — création d'un magasin (siège uniquement).
 * Corps : `{ code, name, kind?, address?, phone?, email?, managerUserId?,
 * openingDate?, openingHours?, receiptFooter?, notes?, copyAssortmentFrom? }`.
 * `copyAssortmentFrom` : magasin dont on recopie la liste des produits proposés.
 * Sans copie, le nouveau magasin part d’un assortiment vide (README §28.5).
 * Permission : `stores.manage`.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('stores.manage');
    await requireCentralEdit();
    const body = await readJson<any>(request);

    const store = await createStore(
      {
        code: required(body.code, 'Code'),
        name: required(body.name, 'Nom'),
        kind: body.kind === 'headquarters' ? 'headquarters' : 'store',
        address: body.address ?? null,
        phone: body.phone ?? null,
        email: body.email ?? null,
        managerUserId: body.managerUserId ? Number(body.managerUserId) : null,
        openingDate: body.openingDate ?? null,
        openingHours: body.openingHours ?? null,
        receiptFooter: body.receiptFooter ?? null,
        documentPhones: body.documentPhones,
        notes: body.notes ?? null,
        copyAssortmentFrom: body.copyAssortmentFrom ? Number(body.copyAssortmentFrom) : null,
      },
      { id: user.id, name: user.name },
    );

    return ok(store, 201);
  } catch (error) {
    return fail(error);
  }
}
