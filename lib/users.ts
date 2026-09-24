/**
 * Utilisateurs : modification, mot de passe, (ré)activation et statistiques
 * (README §17).
 *
 * Ce fichier **complète** `lib/auth.ts` sans le modifier. `lib/auth.ts` porte
 * l'authentification et la création (`hashPassword`, `createUser`, `listUsers`,
 * `deactivateUser`…) ; `lib/users.ts` porte la gestion administrative
 * (modification de rôle, changement de mot de passe, réactivation, agrégats).
 *
 * Deux invariants tenus ici :
 *
 *  1. **Aucun mot de passe ne sort jamais.** `password_hash` n'est ni renvoyé,
 *     ni journalisé, ni mis dans un `details` d'audit.
 *  2. **L'application ne peut pas devenir inadministrable.** Retirer le rôle
 *     `admin` au dernier administrateur actif, ou le désactiver, est refusé
 *     avec un message explicite (§ mission).
 *
 * Toute écriture enfile une opération de synchronisation (§26.13) : jamais de
 * suppression physique, uniquement `is_active` / `deleted_at`.
 */

import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  deactivateUser as deactivateUserFromAuth,
  hashPassword,
  listUsers as listUsersFromAuth,
} from '@/lib/auth';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api';
import { ROLES, isRole, type Role } from '@/lib/permissions';
import { enqueueSyncWrite } from '@/lib/sync';
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from '@/lib/constants';

/**
 * Longueur minimale du mot de passe.
 *
 * La constante vit dans `lib/constants.ts`, un module **sans dépendance
 * serveur** : `components/utilisateurs/utilisateurs-modals.tsx` est un composant
 * client et doit pouvoir valider la longueur sans importer ce fichier (qui
 * entraînerait `@libsql/client` et `fs` dans le bundle navigateur).
 */
export { MIN_PASSWORD_LENGTH, USERNAME_PATTERN };

/** Projection publique d'un utilisateur : **jamais** `password_hash`. */
export type UserRow = {
  id: number;
  name: string;
  username: string;
  role: Role;
  phone: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date | null;
};

export type UserInput = {
  name: string;
  username: string;
  password: string;
  role: Role;
  phone?: string | null;
};

export type UserPatch = {
  name?: string;
  username?: string;
  role?: Role;
  phone?: string | null;
  isActive?: boolean;
};

export type UserStats = {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  administrators: number;
  byRole: { role: Role; count: number }[];
};

/* ------------------------------------------------------------------ *
 * Normalisation et projections
 * ------------------------------------------------------------------ */

/** Identifiant de connexion : minuscules, sans espace superflu. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** `null` au lieu d'une chaîne vide : une colonne texte nullable reste nullable. */
function normalizePhone(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * Toute ligne `users` est projetée par ici avant de sortir de `lib/`.
 * C'est le point unique qui garantit qu'aucune empreinte ne fuit.
 *
 * `listUsers()` de `lib/auth.ts` sélectionne déjà les bonnes colonnes ; le
 * passage par cette fonction reste une ceinture de sécurité (un `select()`
 * complet ailleurs ne pourrait pas faire fuiter `password_hash`).
 */
export function toUserRow(row: {
  id: number;
  name: string;
  username: string;
  role: string;
  phone: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt?: Date | null;
}): UserRow {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: (isRole(row.role) ? row.role : 'seller') as Role,
    phone: row.phone,
    isActive: Boolean(row.isActive),
    lastLoginAt: row.lastLoginAt ?? null,
    createdAt: row.createdAt ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

/**
 * Tous les utilisateurs, projection publique, triés par nom.
 *
 * Réutilise volontairement `listUsers()` de `lib/auth.ts` (ne pas dupliquer une
 * requête existante) et ajoute la projection publique. Le filtrage et la
 * pagination sont faits par `listUsersPage` ci-dessous : la table `users` compte
 * quelques dizaines de lignes, un `LIMIT` SQL n'apporterait rien.
 */
export async function listUsers(): Promise<UserRow[]> {
  const rows = await listUsersFromAuth();
  return rows.map((row) => toUserRow(row as any));
}

/** Fiche d'un utilisateur, ou `null` — jamais l'empreinte. */
export async function getUser(id: number): Promise<UserRow | null> {
  const rows = await listUsersFromAuth();
  const found = rows.find((row) => row.id === id);
  return found ? toUserRow(found as any) : null;
}

/** Liste filtrée + paginée au format imposé `{ data, total, page, limit, totalPages }`. */
export async function listUsersPage(options: {
  search?: string;
  role?: string;
  /** `true` → uniquement les inactifs (comptes désactivés à réactiver). */
  inactiveOnly?: boolean;
  includeInactive?: boolean;
  page?: number;
  limit?: number;
} = {}): Promise<{ data: UserRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));

  let rows = await listUsers();

  if (options.inactiveOnly) {
    rows = rows.filter((row) => !row.isActive);
  } else if (!options.includeInactive) {
    rows = rows.filter((row) => row.isActive);
  }

  if (options.role && isRole(options.role)) {
    rows = rows.filter((row) => row.role === options.role);
  }

  const search = options.search?.trim().toLowerCase();
  if (search) {
    rows = rows.filter(
      (row) =>
        row.name.toLowerCase().includes(search) ||
        row.username.toLowerCase().includes(search) ||
        (row.phone ?? '').toLowerCase().includes(search),
    );
  }

  const total = rows.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const offset = (page - 1) * limit;

  return {
    data: rows.slice(offset, offset + limit),
    total,
    page,
    limit,
    totalPages,
  };
}

/** Compteurs de l'en-tête de page : totaux et répartition par rôle. */
export async function getUserStats(): Promise<UserStats> {
  const rows = await listUsers();

  const byRole: { role: Role; count: number }[] = [];
  for (const role of ROLES) {
    const count = rows.filter((row) => row.role === role).length;
    if (count > 0) byRole.push({ role, count });
  }

  return {
    totalUsers: rows.length,
    activeUsers: rows.filter((row) => row.isActive).length,
    inactiveUsers: rows.filter((row) => !row.isActive).length,
    administrators: rows.filter((row) => row.role === 'admin' && row.isActive).length,
    byRole,
  };
}

/* ------------------------------------------------------------------ *
 * Garde-fou : le dernier administrateur actif est indestructible
 * ------------------------------------------------------------------ */

/**
 * Combien d'administrateurs **actifs** resterait-il si `id` cessait de l'être ?
 *
 * On compte les administrateurs actifs à l'exclusion de l'utilisateur visé :
 * c'est exactement la question « reste-t-il quelqu'un pour administrer ? ».
 */
async function remainingActiveAdmins(excludeId: number): Promise<number> {
  const rows = await listUsersFromAuth();
  return rows.filter((row) => row.role === 'admin' && row.isActive && row.id !== excludeId).length;
}

/**
 * Refuse une opération qui laisserait l'application **sans administrateur actif**.
 *
 * Sans ce garde-fou, un administrateur peut se rétrograder ou se désactiver
 * lui-même : plus personne ne peut alors gérer les utilisateurs (le README
 * §17.2 réserve `users.manage` au rôle `admin`), et la seule issue serait une
 * intervention directe dans la base SQLite.
 */
async function assertNotLastActiveAdmin(
  id: number,
  target: { name: string; role: string; isActive: boolean },
  reason: 'demote' | 'deactivate',
): Promise<void> {
  if (target.role !== 'admin' || !target.isActive) return;

  const remaining = await remainingActiveAdmins(id);
  if (remaining > 0) return;

  throw new ConflictError(
    reason === 'demote'
      ? `Impossible de changer le rôle de « ${target.name} » : c'est le dernier administrateur actif. ` +
          'Désignez d’abord un autre administrateur, sinon plus personne ne pourra gérer les utilisateurs.'
      : `Impossible de désactiver « ${target.name} » : c'est le dernier administrateur actif. ` +
          'Désignez d’abord un autre administrateur, sinon l’application deviendrait inadministrable.',
  );
}

/* ------------------------------------------------------------------ *
 * Écritures
 * ------------------------------------------------------------------ */

/** Vrai si l'identifiant est déjà utilisé par **un autre** compte. */
async function assertUsernameAvailable(username: string, excludeId?: number): Promise<void> {
  const rows = await listUsersFromAuth();
  const taken = rows.some((row) => row.id !== excludeId && row.username.toLowerCase() === username);
  if (taken) {
    throw new ConflictError(`L'identifiant de connexion « ${username} » est déjà utilisé par un autre compte.`);
  }
}

/** Valide et normalise les champs communs (nom + identifiant). */
function validateIdentity(name: string, username: string): { name: string; username: string } {
  const cleanName = normalizeName(name);
  if (!cleanName) throw new ValidationError('Le champ « Nom » est obligatoire');

  const cleanUsername = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(cleanUsername)) {
    throw new ValidationError(
      "L'identifiant doit contenir au moins 3 caractères (lettres minuscules, chiffres, « . », « _ » ou « - »)",
    );
  }

  return { name: cleanName, username: cleanUsername };
}

/**
 * Création d'un compte (§17.1) — le mot de passe est haché en **scrypt salé**
 * par `hashPassword` de `lib/auth.ts`, jamais stocké en clair.
 */
export async function createUser(input: UserInput): Promise<UserRow> {
  const { name, username } = validateIdentity(input.name, input.username);

  if (!isRole(input.role)) throw new ValidationError('Rôle invalide');
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères`);
  }

  await assertUsernameAvailable(username);

  const inserted = await db
    .insert(users)
    .values({
      name,
      username,
      passwordHash: hashPassword(input.password),
      role: input.role,
      phone: normalizePhone(input.phone),
    })
    .returning({ id: users.id, syncId: users.syncId });

  if (inserted.length === 0) throw new ValidationError('Création de l’utilisateur impossible');

  await enqueueSyncWrite('users', inserted[0].syncId, 'insert', {
    name,
    username,
    role: input.role,
    phone: normalizePhone(input.phone),
    is_active: true,
  });

  const created = await getUser(inserted[0].id);
  if (!created) throw new NotFoundError('Utilisateur créé mais introuvable');
  return created;
}

/**
 * Modification d'un compte : nom, identifiant, rôle, téléphone, activation.
 *
 * Le mot de passe n'est **jamais** modifié ici (route dédiée
 * `PUT /api/users/[id]/password`), et l'empreinte ne figure dans aucun payload
 * de synchronisation.
 */
export async function updateUser(id: number, patch: UserPatch): Promise<UserRow> {
  const existing = await getUser(id);
  if (!existing) throw new NotFoundError('Utilisateur introuvable');

  const values: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.name !== undefined || patch.username !== undefined) {
    const identity = validateIdentity(
      patch.name ?? existing.name,
      patch.username ?? existing.username,
    );
    values.name = identity.name;
    values.username = identity.username;
    if (identity.username !== existing.username) {
      await assertUsernameAvailable(identity.username, id);
    }
  }

  if (patch.role !== undefined) {
    if (!isRole(patch.role)) throw new ValidationError('Rôle invalide');
    if (patch.role !== existing.role) {
      // Retirer `admin` au dernier administrateur actif rendrait l'application
      // inadministrable : refusé, avec un message qui dit quoi faire.
      await assertNotLastActiveAdmin(id, existing, 'demote');
      values.role = patch.role;
    }
  }

  if (patch.phone !== undefined) values.phone = normalizePhone(patch.phone);

  if (patch.isActive !== undefined && patch.isActive !== existing.isActive) {
    if (!patch.isActive) {
      await assertNotLastActiveAdmin(id, existing, 'deactivate');
      values.isActive = false;
      values.deletedAt = new Date();
    } else {
      values.isActive = true;
      values.deletedAt = null;
    }
  }

  const updated = await db
    .update(users)
    .set(values as any)
    .where(eq(users.id, id))
    .returning({ id: users.id, syncId: users.syncId });

  if (updated.length === 0) throw new NotFoundError('Utilisateur introuvable');

  // Payload de synchronisation sans aucune donnée d'authentification.
  await enqueueSyncWrite('users', updated[0].syncId, 'update', {
    name: values.name ?? existing.name,
    username: values.username ?? existing.username,
    role: values.role ?? existing.role,
    phone: values.phone ?? existing.phone,
    is_active: values.isActive ?? existing.isActive,
  });

  const result = await getUser(id);
  if (!result) throw new NotFoundError('Utilisateur introuvable après modification');
  return result;
}

/**
 * Changement de mot de passe par un administrateur (réinitialisation).
 *
 * Le mot de passe n'est ni journalisé, ni mis en file de synchronisation : les
 * empreintes scrypt ne sont pas propagées entre postes par ce canal.
 */
export async function changePassword(id: number, newPassword: string): Promise<void> {
  const existing = await getUser(id);
  if (!existing) throw new NotFoundError('Utilisateur introuvable');

  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères`);
  }

  await db
    .update(users)
    .set({ passwordHash: hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, id));
}

/**
 * Désactivation — **jamais** de suppression physique (§26.13) : `deleted_at`
 * est un tombstone, la ligne et son historique restent en base.
 *
 * Réutilise `deactivateUser` de `lib/auth.ts` après le garde-fou du dernier
 * administrateur actif.
 */
export async function deactivateUser(id: number): Promise<void> {
  const existing = await getUser(id);
  if (!existing) throw new NotFoundError('Utilisateur introuvable');

  await assertNotLastActiveAdmin(id, existing, 'deactivate');

  await deactivateUserFromAuth(id);

  const row = await db
    .select({ syncId: users.syncId })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  await enqueueSyncWrite('users', row[0]?.syncId, 'delete', {
    id,
    deleted_at: new Date().toISOString(),
  });
}

/** Réactivation d'un compte désactivé (aucune donnée n'a été supprimée). */
export async function reactivateUser(id: number): Promise<void> {
  const existing = await getUser(id);
  if (!existing) throw new NotFoundError('Utilisateur introuvable');
  if (existing.isActive) return;

  const updated = await db
    .update(users)
    .set({ isActive: true, deletedAt: null, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({ id: users.id, syncId: users.syncId });

  if (updated.length === 0) throw new NotFoundError('Utilisateur introuvable');

  await enqueueSyncWrite('users', updated[0].syncId, 'update', {
    id,
    is_active: true,
    deleted_at: null,
  });
}
