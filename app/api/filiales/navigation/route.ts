import { fail, ok, requireUser } from '@/lib/api';
import { canManageBranches, listBranchNavLinks } from '@/lib/branches';

/**
 * GET /api/filiales/navigation — liens de la barre latérale (README §31.2) :
 * une entrée par filiale **active et autorisée**, dans l'ordre choisi par
 * l'administrateur. Un compte sans droit sur les filiales reçoit une liste vide.
 */
export async function GET() {
  try {
    const user = await requireUser();
    if (!user.permissions.includes('brick.view')) return ok({ data: [], canManage: canManageBranches(user) });
    return ok({ data: await listBranchNavLinks(user), canManage: canManageBranches(user) });
  } catch (error) {
    return fail(error);
  }
}
