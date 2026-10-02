import { fail, ok, requireAction } from '@/lib/api';
import { listStores } from '@/lib/stores';

/**
 * GET /api/transferts/magasins — annuaire des magasins **actifs** pour choisir
 * la source et la destination d'un transfert.
 *
 * Pourquoi une route dédiée : `GET /api/magasins` ne renvoie à un gérant que
 * ses propres magasins, alors qu'un transfert relie justement son magasin à un
 * **autre** (le plus souvent : il demande de la marchandise au siège). Seuls le
 * code, le nom et le type sont exposés — ni coordonnées, ni indicateurs.
 * `createTransfer` revérifie que l'utilisateur appartient à l'un des deux.
 *
 * Réponse : `[{ id, code, name, kind }]`. Permission : `transfers.create`.
 */
export async function GET() {
  try {
    await requireAction('transfers.create');
    const stores = await listStores();
    return ok(
      stores
        .filter((store) => store.status === 'active')
        .map((store) => ({ id: store.id, code: store.code, name: store.name, kind: store.kind })),
    );
  } catch (error) {
    return fail(error);
  }
}
