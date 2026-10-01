/**
 * Périmètre de gestion des comptes (cahier des charges §5, §6).
 *
 *  - L'**administrateur général** (accès à tous les magasins) gère tous les
 *    comptes et peut affecter n'importe quel magasin.
 *  - Un **gérant de magasin** qui détient `users.manage` ne voit et ne gère
 *    que les comptes affectés à **ses** magasins ; il ne peut ni créer ni
 *    modifier un administrateur, ni affecter un magasin hors de son périmètre.
 *
 * Ces règles sont appliquées côté serveur, quelle que soit l'interface.
 */
import { NotFoundError, type SessionUser } from '@/lib/api';
import { listUserAssignments } from '@/lib/stores';
import { getUser } from '@/lib/users';

export class UserScopeError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'UserScopeError';
  }
}

export async function assertCanManageUser(actor: SessionUser, targetId: number): Promise<void> {
  const target = await getUser(targetId);
  if (!target) throw new NotFoundError('Utilisateur introuvable');
  if (actor.allStores) return;

  if (target.role === 'admin') {
    throw new UserScopeError('Seul un administrateur général peut modifier un compte administrateur.');
  }
  if (target.id === actor.id) return;

  const assignments = await listUserAssignments(targetId);
  const visible = assignments.some((a) => a.isActive && actor.storeIds.includes(a.storeId));
  if (!visible) {
    throw new UserScopeError('Ce compte n’est affecté à aucun de vos magasins.');
  }
}

export function assertAssignableRole(actor: SessionUser, role: string): void {
  if (!actor.allStores && role === 'admin') {
    throw new UserScopeError('Seul un administrateur général peut attribuer le rôle Administrateur.');
  }
}

export function assertAssignableStores(actor: SessionUser, storeIds: number[]): void {
  if (actor.allStores) return;
  const outside = storeIds.filter((id) => !actor.storeIds.includes(id));
  if (outside.length > 0) {
    throw new UserScopeError('Vous ne pouvez affecter un compte qu’à vos propres magasins.');
  }
}
