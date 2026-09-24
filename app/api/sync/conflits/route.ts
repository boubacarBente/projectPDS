import { NextRequest } from 'next/server';
import { fail, ok, requireAction, toBool } from '@/lib/api';
import { listPendingConflicts } from '@/lib/sync-export';

/**
 * GET /api/sync/conflits — conflits à trancher (§23.7, §23.10).
 *
 * Chaque conflit porte la **version locale** et la **version distante** : le
 * choix « garder local » / « garder distant » se fait sur une comparaison
 * lisible, jamais à l'aveugle.
 *
 * `?pendingOnly=true` (défaut) ne renvoie que les conflits non tranchés ;
 * `?pendingOnly=false` renvoie aussi l'historique des arbitrages.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('sync.manage');

    const pendingOnly = toBool(request.nextUrl.searchParams.get('pendingOnly'), true);
    const all = await listPendingConflicts();
    const data = pendingOnly ? all.filter((conflict) => conflict.resolution === 'pending') : all;

    return ok({
      data,
      total: data.length,
      pending: all.filter((conflict) => conflict.resolution === 'pending').length,
      resolved: all.filter((conflict) => conflict.resolution !== 'pending').length,
    });
  } catch (error) {
    return fail(error);
  }
}
