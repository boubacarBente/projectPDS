/**
 * Périmètre de gestion des comptes (cahier des charges §5, §6 ; README §17.2).
 *
 *  - Le **super administrateur** (un seul compte) commande les administrateurs :
 *    lui seul peut modifier, rétrograder, désactiver ou réinitialiser un autre
 *    administrateur, et lui seul attribue le rôle Administrateur. Personne ne
 *    peut modifier son compte, sauf lui-même.
 *  - Un **administrateur** gère tous les comptes non administrateurs.
 *  - Un **gérant de magasin** qui détient `users.manage` ne gère que les
 *    comptes dont **toutes** les affectations sont dans **ses** magasins et
 *    dont les droits ne dépassent pas les siens. Il ne touche ni à ses propres
 *    droits, ni à son rôle, ni à ses magasins.
 *
 * Correctif de sécurité (revue du 4 octobre 2026) : un gérant pouvait
 * s'accorder `stores.viewAll` sur son propre compte, devenir « tous magasins »,
 * puis se nommer administrateur. Il pouvait aussi réinitialiser le mot de
 * passe d'un compte mieux doté que lui (affecté à d'autres magasins, ou avec
 * la vue consolidée) et s'en servir.
 *
 * Ces règles sont appliquées côté serveur, quelle que soit l'interface.
 */
import { NotFoundError, type SessionUser } from '@/lib/api';
import { permissionsOf, type Action, type PermissionOverride, type Role } from '@/lib/permissions';
import { listUserAssignments } from '@/lib/stores';
import { getEffectivePermissions } from '@/lib/user-permissions';
import { getUser, type UserRow } from '@/lib/users';

export class UserScopeError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'UserScopeError';
  }
}

/**
 * Droits qu'un non-administrateur ne peut **jamais** accorder par surcharge,
 * même s'il les détient : ils ouvrent tous les magasins, la gestion des
 * comptes ou l'administration du poste.
 */
export const ADMIN_ONLY_ACTIONS: readonly Action[] = [
  'stores.viewAll',
  'stores.manage',
  'users.manage',
  'settings.critical',
  'backup.manage',
  'sync.manage',
];

function isAdmin(actor: SessionUser): boolean {
  return actor.role === 'admin';
}

/**
 * L'auteur peut-il agir sur ce compte ?
 *
 * Un non-administrateur peut toujours viser **son propre** compte (fiche, mot
 * de passe) ; les routes qui changent des droits refusent ensuite ce cas par
 * `assertNotOwnPrivileges`.
 */
export async function assertCanManageUser(actor: SessionUser, targetId: number): Promise<UserRow> {
  const target = await getUser(targetId);
  if (!target) throw new NotFoundError('Utilisateur introuvable');
  const self = target.id === actor.id;

  if (target.isSuperAdmin) {
    if (self) return target;
    throw new UserScopeError('Le compte du super administrateur ne peut être modifié que par lui-même.');
  }
  if (target.role === 'admin') {
    if (self || actor.isSuperAdmin) return target;
    throw new UserScopeError('Seul le super administrateur peut modifier un compte administrateur.');
  }
  if (isAdmin(actor) || self) return target;

  // Gérant : toutes les affectations du compte doivent être dans son périmètre.
  if (!actor.allStores) {
    const active = (await listUserAssignments(targetId)).filter((a) => a.isActive);
    if (!active.some((a) => actor.storeIds.includes(a.storeId))) {
      throw new UserScopeError('Ce compte n’est affecté à aucun de vos magasins.');
    }
    if (active.some((a) => !actor.storeIds.includes(a.storeId))) {
      throw new UserScopeError(
        'Ce compte est aussi affecté à des magasins que vous ne gérez pas : seul un administrateur peut le modifier.',
      );
    }
  }

  // …et ses droits ne doivent pas dépasser les siens.
  const targetPermissions = await getEffectivePermissions({ id: target.id, role: target.role });
  const beyond = targetPermissions.filter((action) => !actor.permissions.includes(action));
  if (beyond.length > 0) {
    throw new UserScopeError('Ce compte a des droits que vous n’avez pas : seul un administrateur peut le modifier.');
  }
  return target;
}

/** Un non-administrateur ne change ni son rôle, ni ses droits, ni ses magasins, ni son statut. */
export function assertNotOwnPrivileges(actor: SessionUser, targetId: number): void {
  if (isAdmin(actor) || targetId !== actor.id) return;
  throw new UserScopeError('Vous ne pouvez pas modifier vos propres droits : demandez-le à un administrateur.');
}

/**
 * Rôle attribuable par l'auteur : Administrateur → super administrateur
 * seulement ; pour un non-administrateur, un rôle dont tous les droits sont
 * déjà les siens.
 */
export function assertAssignableRole(actor: SessionUser, role: Role): void {
  if (role === 'admin') {
    if (actor.isSuperAdmin) return;
    throw new UserScopeError('Seul le super administrateur peut attribuer le rôle Administrateur.');
  }
  if (isAdmin(actor)) return;
  if (permissionsOf({ role }).some((action) => !actor.permissions.includes(action))) {
    throw new UserScopeError('Ce rôle donne des droits que vous n’avez pas : seul un administrateur peut l’attribuer.');
  }
}

/** Surcharges accordables : un non-administrateur n'accorde que ce qu'il détient, hors droits réservés. */
export function assertGrantableOverrides(actor: SessionUser, entries: PermissionOverride[]): void {
  if (isAdmin(actor)) return;
  for (const entry of entries) {
    if (entry.effect !== 'allow') continue;
    if (ADMIN_ONLY_ACTIONS.includes(entry.action) || !actor.permissions.includes(entry.action)) {
      throw new UserScopeError(`Vous ne pouvez pas accorder « ${entry.action} » : seul un administrateur le peut.`);
    }
  }
}

export function assertAssignableStores(actor: SessionUser, storeIds: number[]): void {
  if (actor.allStores) return;
  const outside = storeIds.filter((id) => !actor.storeIds.includes(id));
  if (outside.length > 0) {
    throw new UserScopeError('Vous ne pouvez affecter un compte qu’à vos propres magasins.');
  }
}
