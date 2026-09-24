/**
 * Authentification (README §17.1).
 *
 * Deux ruptures assumées par rapport au projet Gaz :
 *  1. **hachage scrypt salé** (`node:crypto`) au lieu d'un SHA-256 nu ;
 *  2. **aucun compte en dur** — la backdoor `boubacar` / `1265` du projet Gaz
 *     est supprimée (§3.4). Elle serait une faille : un compte connu
 *     contournerait la base.
 */

import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Role } from '@/lib/permissions';

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const HASH_PREFIX = 'scrypt';

/** `scrypt$<saltHex>$<hashHex>` — format auto-décrit, versionnable. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN);
  return `${HASH_PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Vérifie un mot de passe.
 *
 * Les empreintes héritées (SHA-256 hexadécimal sans sel, format du projet Gaz)
 * restent vérifiables : un poste migré depuis Gaz ne doit pas se retrouver
 * bloqué dehors. Elles sont ré-encodées en scrypt à la première connexion
 * réussie (voir `upgradePasswordHashIfLegacy`).
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith(`${HASH_PREFIX}$`)) {
    const [, saltHex, hashHex] = storedHash.split('$');
    if (!saltHex || !hashHex) return false;
    try {
      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(hashHex, 'hex');
      const derived = scryptSync(password.normalize('NFKC'), salt, expected.length);
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }

  // Empreinte héritée SHA-256 (projet Gaz) — comparaison à temps constant.
  const legacy = await sha256Hex(password);
  const a = Buffer.from(legacy, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLegacyHash(storedHash: string): boolean {
  return !storedHash.startsWith(`${HASH_PREFIX}$`);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hasAdminUser(): Promise<boolean> {
  try {
    const result = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    return result.length > 0;
  } catch (err: any) {
    if (/no such table/i.test(err?.message ?? '')) return false;
    throw err;
  }
}

export async function getUserByUsername(username: string) {
  try {
    const result = await db.select().from(users).where(eq(users.username, username)).limit(1);
    return result[0] ?? null;
  } catch (err: any) {
    if (/no such table/i.test(err?.message ?? '')) return null;
    throw err;
  }
}

export async function getUserById(id: number) {
  try {
    const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0] ?? null;
  } catch (err: any) {
    if (/no such table/i.test(err?.message ?? '')) return null;
    throw err;
  }
}

export async function listUsers() {
  try {
    return await db
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        role: users.role,
        phone: users.phone,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.name);
  } catch (err: any) {
    if (/no such table/i.test(err?.message ?? '')) return [];
    throw err;
  }
}

export async function createUser(input: {
  name: string;
  username: string;
  password: string;
  role: Role;
  phone?: string | null;
}) {
  const result = await db
    .insert(users)
    .values({
      name: input.name,
      username: input.username,
      passwordHash: hashPassword(input.password),
      role: input.role,
      phone: input.phone ?? null,
    })
    .returning();
  return result[0];
}

/** Ré-encode une empreinte héritée après une connexion réussie. */
export async function upgradePasswordHashIfLegacy(
  userId: number,
  password: string,
  storedHash: string,
): Promise<void> {
  if (!isLegacyHash(storedHash)) return;
  await db
    .update(users)
    .set({ passwordHash: hashPassword(password), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function touchLastLogin(userId: number): Promise<void> {
  await db
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** Désactivation — jamais de suppression physique sur une table synchronisée (§26.13). */
export async function deactivateUser(id: number) {
  await db
    .update(users)
    .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, id));
}
