/**
 * Permissions **par utilisateur** (demande explicite du client).
 *
 * Le rôle donne un jeu de permissions par défaut (`lib/permissions.ts`). Cette
 * couche permet à l'administrateur de déroger au rôle, **utilisateur par
 * utilisateur et action par action** :
 *   - `allow` accorde une action que le rôle n'accorde pas ;
 *   - `deny`  retire une action que le rôle accorde.
 *
 * **Aucune ligne = héritage du rôle.** Le rôle `admin` n'est jamais restreint :
 * il a toutes les permissions par construction, ce qui garantit qu'on ne peut
 * pas se verrouiller hors de sa propre application.
 *
 * Toute décision d'autorisation, côté serveur comme côté navigateur, doit
 * passer par `getEffectivePermissions()` afin que les deux appliquent
 * **exactement** la même règle.
 */

import { db, rawAll } from '@/db';
import { userPermissions } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import {
  ACTION_META,
  ALL_ACTIONS,
  isAction,
  isRole,
  resolvePermissions,
  type Action,
  type PermissionOverride,
  type Role,
} from '@/lib/permissions';
import { enqueueSyncWrite } from '@/lib/sync';
import { writeAudit } from '@/lib/audit';

/**
 * Cache court, uniquement pour éviter de relire la table à chaque requête HTTP
 * d'une même rafale (une page déclenche 3 à 6 appels d'API). Il est invalidé à
 * chaque écriture : une décision de permission ne doit jamais être servie
 * périmée au-delà de quelques secondes.
 */
const CACHE_TTL_MS = 5_000;
const permissionsCache = new Map<number, { permissions: Action[]; expiresAt: number }>();

export function invalidatePermissionsCache(userId?: number): void {
  if (userId === undefined) permissionsCache.clear();
  else permissionsCache.delete(userId);
}

/** Les surcharges explicites d'un utilisateur. */
export async function getUserOverrides(userId: number): Promise<PermissionOverride[]> {
  try {
    const rows = await db
      .select()
      .from(userPermissions)
      .where(eq(userPermissions.userId, userId));

    return rows
      .filter((row) => isAction(row.action))
      .map((row) => ({
        action: row.action as Action,
        effect: row.effect as 'allow' | 'deny',
      }));
  } catch (error) {
    // Table absente (base neuve) : aucune surcharge, le rôle s'applique.
    console.error('[permissions] Lecture des surcharges impossible :', error);
    return [];
  }
}

/**
 * Permissions **effectives** d'un utilisateur : matrice du rôle, puis
 * surcharges. C'est LA fonction à utiliser pour toute décision.
 */
export async function getEffectivePermissions(user: {
  id?: number | null;
  role?: string | null;
}): Promise<Action[]> {
  if (!user || !isRole(user.role)) return [];

  // L'administrateur a tout : inutile d'interroger la base.
  if (user.role === 'admin') return [...ALL_ACTIONS];

  if (!user.id) return resolvePermissions(user, []);

  const cached = permissionsCache.get(user.id);
  if (cached && cached.expiresAt > Date.now()) return cached.permissions;

  const overrides = await getUserOverrides(user.id);
  const permissions = resolvePermissions(user, overrides);

  permissionsCache.set(user.id, { permissions, expiresAt: Date.now() + CACHE_TTL_MS });

  return permissions;
}

/**
 * Remplace les surcharges d'un utilisateur.
 *
 * @param entries liste **complète** des surcharges voulues. Une action absente
 *   de cette liste revient à l'héritage du rôle. Pour ne rien changer, passer
 *   exactement les surcharges existantes.
 */
export async function setUserOverrides(
  userId: number,
  entries: PermissionOverride[],
  actor?: { id: number; name: string } | null,
): Promise<Action[]> {
  const target = await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, userId) });
  if (!target) throw new Error('Utilisateur introuvable');

  if (target.role === 'admin') {
    throw new Error(
      "L'administrateur dispose de toutes les permissions par construction : ses permissions ne peuvent pas être restreintes. Cela protège l'application contre un blocage définitif.",
    );
  }

  // Validation stricte : une action inconnue est un bug d'appelant, pas une
  // donnée à stocker silencieusement.
  const invalid = entries.filter((entry) => !isAction(entry.action));
  if (invalid.length > 0) {
    throw new Error(`Action(s) inconnue(s) : ${invalid.map((e) => e.action).join(', ')}`);
  }

  const before = await getUserOverrides(userId);

  await db.delete(userPermissions).where(eq(userPermissions.userId, userId));

  const unique = new Map<Action, 'allow' | 'deny'>();
  for (const entry of entries) unique.set(entry.action, entry.effect);

  for (const [action, effect] of unique) {
    const inserted = await db
      .insert(userPermissions)
      .values({
        userId,
        action,
        effect,
        grantedBy: actor?.id ?? null,
      })
      .returning({ syncId: userPermissions.syncId });

    await enqueueSyncWrite('user_permissions', inserted[0]?.syncId, 'insert', {
      user_id: userId,
      action,
      effect,
    });
  }

  invalidatePermissionsCache(userId);

  const after = [...unique].map(([action, effect]) => ({ action, effect }));

  await writeAudit({
    user: actor ?? null,
    action: 'update',
    entity: 'user_permissions',
    entityId: userId,
    details: {
      avant: before.map((o) => `${o.action}:${o.effect}`),
      apres: after.map((o) => `${o.action}:${o.effect}`),
    },
  });

  return getEffectivePermissions({ id: userId, role: target.role });
}

/**
 * Vue complète pour l'écran de réglage : pour chaque action, ce que le rôle
 * accorde et ce que la surcharge décide.
 */
export async function getPermissionMatrix(userId: number): Promise<{
  user: { id: number; name: string; username: string; role: Role };
  isAdmin: boolean;
  roleDefaults: Action[];
  overrides: PermissionOverride[];
  effective: Action[];
  groups: { group: string; actions: { action: Action; fromRole: boolean; effect: 'allow' | 'deny' | null; granted: boolean }[] }[];
}> {
  const user = await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, userId) });
  if (!user) throw new Error('Utilisateur introuvable');

  const role = isRole(user.role) ? user.role : 'seller';
  const roleDefaults = resolvePermissions({ role }, []);
  const effective = await getEffectivePermissions({ id: userId, role });
  const overrides = await getUserOverrides(userId);

  const overrideMap = new Map(overrides.map((o) => [o.action, o.effect]));
  const granted = new Set(effective);

  // On regroupe par domaine en conservant l'ordre de `ALL_ACTIONS`, donc
  // l'ordre voulu par `ACTION_GROUPS` — sans dépendre d'une seconde liste.
  const grouped = new Map<
    string,
    { action: Action; fromRole: boolean; effect: 'allow' | 'deny' | null; granted: boolean }[]
  >();

  for (const action of ALL_ACTIONS) {
    const meta = ACTION_META[action];
    const list = grouped.get(meta.group) ?? [];
    list.push({
      action,
      fromRole: roleDefaults.includes(action),
      effect: overrideMap.get(action) ?? null,
      granted: granted.has(action),
    });
    grouped.set(meta.group, list);
  }

  return {
    user: { id: user.id, name: user.name, username: user.username, role },
    isAdmin: role === 'admin',
    roleDefaults,
    overrides,
    effective,
    groups: [...grouped].map(([group, actions]) => ({ group, actions })),
  };
}

/** Surcharges de plusieurs utilisateurs, en une seule requête (listes). */
export async function getOverridesForUsers(
  userIds: number[],
): Promise<Map<number, PermissionOverride[]>> {
  const result = new Map<number, PermissionOverride[]>();
  if (userIds.length === 0) return result;

  try {
    const rows = await db
      .select()
      .from(userPermissions)
      .where(inArray(userPermissions.userId, userIds));

    for (const row of rows) {
      if (!isAction(row.action)) continue;
      const list = result.get(row.userId) ?? [];
      list.push({ action: row.action as Action, effect: row.effect as 'allow' | 'deny' });
      result.set(row.userId, list);
    }
  } catch {
    /* base neuve : aucune surcharge */
  }

  return result;
}

/** Compte les surcharges d'un utilisateur, pour l'afficher dans la liste. */
export async function countOverrides(userId: number): Promise<number> {
  const rows = await db
    .select({ id: userPermissions.id })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId));
  return rows.length;
}

/** Réinitialise toutes les surcharges (retour à la matrice du rôle). */
export async function clearUserOverrides(
  userId: number,
  actor?: { id: number; name: string } | null,
): Promise<Action[]> {
  const before = await getUserOverrides(userId);
  await db.delete(userPermissions).where(eq(userPermissions.userId, userId));
  invalidatePermissionsCache(userId);

  await writeAudit({
    user: actor ?? null,
    action: 'delete',
    entity: 'user_permissions',
    entityId: userId,
    details: { supprimees: before.map((o) => `${o.action}:${o.effect}`) },
  });

  const user = await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, userId) });
  return getEffectivePermissions({ id: userId, role: user?.role ?? null });
}

/** Vrai si l'utilisateur a au moins une surcharge explicite. */
export async function hasOverrides(userId: number): Promise<boolean> {
  const rows = await db
    .select({ id: userPermissions.id })
    .from(userPermissions)
    .where(and(eq(userPermissions.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** Purge les surcharges d'un utilisateur désactivé (ménage, jamais automatique). */
export async function listUsersWithOverrides(): Promise<number[]> {
  const rows = await rawAll<{ user_id: number }>(
    'SELECT DISTINCT user_id FROM user_permissions',
  );
  return rows.map((r) => Number(r.user_id));
}
