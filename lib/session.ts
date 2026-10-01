import { NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { rawGet, rawRun } from '@/db';
import type { Role } from '@/lib/permissions';

/**
 * Sessions de connexion — **stockées en base, révocables** (correctif de
 * sécurité, cahier des charges §5 et §19.3).
 *
 * Avant : le cookie `session_user` contenait le JSON de l'utilisateur, rôle
 * compris, sans signature. Il suffisait de le modifier (F12 → Cookies) pour
 * devenir administrateur.
 *
 * Désormais :
 *  - le cookie `pd_session` ne contient qu'un **jeton aléatoire** de 256 bits ;
 *  - la base ne stocke que son **SHA-256** (une fuite de la base ne donne pas
 *    de session utilisable) ;
 *  - à **chaque requête**, l'utilisateur est relu en base : un compte désactivé
 *    ou dont le rôle change perd immédiatement ses anciens droits ;
 *  - la session expire après 12 h d'inactivité ;
 *  - désactiver un compte ou changer son mot de passe révoque ses sessions.
 */

export const SESSION_COOKIE = 'pd_session';
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** On ne réécrit `last_seen_at` qu'une fois par minute au plus. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export type SessionPayload = {
  id: number;
  name: string;
  username: string;
  role: Role;
};

export type SessionRecord = SessionPayload & {
  sessionId: string;
  /** Magasin actif enregistré dans la session (vérifié à chaque usage). */
  storeId: number | null;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieOptions(maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    // `secure` reste à false : l'application tourne en HTTP sur 127.0.0.1.
    secure: false,
    sameSite: 'strict' as const,
    path: '/',
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}

/** Crée la session en base et renvoie la réponse portant le cookie. */
export async function createSessionResponse(
  user: SessionPayload,
  status = 200,
  options: { storeId?: number | null; extra?: Record<string, unknown> } = {},
): Promise<NextResponse> {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();

  await rawRun(
    `INSERT INTO sessions (id, user_id, store_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      hashToken(token),
      user.id,
      options.storeId ?? null,
      Math.floor(now / 1000),
      Math.floor((now + SESSION_IDLE_MS) / 1000),
      Math.floor(now / 1000),
    ],
  );

  // Ménage opportuniste : sessions expirées ou révoquées depuis plus de 30 jours.
  await rawRun(
    `DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
    [Math.floor((now - 30 * 86_400_000) / 1000), Math.floor((now - 30 * 86_400_000) / 1000)],
  ).catch(() => {});

  const response = NextResponse.json({ user, ...(options.extra ?? {}) }, { status });
  response.cookies.set(SESSION_COOKIE, token, cookieOptions());
  // Anciens cookies (versions ≤ 1.3) : on les efface pour ne rien laisser traîner.
  for (const legacy of ['session', 'session_user', 'user']) {
    response.cookies.set(legacy, '', { ...cookieOptions(0), httpOnly: legacy !== 'user' });
  }
  return response;
}

/**
 * Relit la session depuis le jeton du cookie.
 * Renvoie `null` si le jeton est inconnu, expiré, révoqué, ou si le compte est
 * désactivé.
 */
export async function loadSession(token: string | undefined | null): Promise<SessionRecord | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;

  const id = hashToken(token);
  const nowSec = Math.floor(Date.now() / 1000);

  let row:
    | {
        user_id: number;
        store_id: number | null;
        expires_at: number;
        last_seen_at: number | null;
        name: string;
        username: string;
        role: string;
        is_active: number;
        deleted_at: number | null;
      }
    | undefined;

  try {
    row = await rawGet(
      `SELECT s.user_id, s.store_id, s.expires_at, s.last_seen_at,
              u.name, u.username, u.role, u.is_active, u.deleted_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.revoked_at IS NULL`,
      [id],
    );
  } catch (error: any) {
    if (/no such table/i.test(error?.message ?? '')) return null;
    throw error;
  }

  if (!row) return null;
  if (Number(row.expires_at) < nowSec) return null;
  if (!row.is_active || row.deleted_at) return null;

  const lastSeen = Number(row.last_seen_at ?? 0);
  if (nowSec - lastSeen > TOUCH_INTERVAL_MS / 1000) {
    await rawRun(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`, [
      nowSec,
      nowSec + SESSION_IDLE_MS / 1000,
      id,
    ]).catch(() => {});
  }

  return {
    sessionId: id,
    id: Number(row.user_id),
    name: String(row.name),
    username: String(row.username),
    role: row.role as Role,
    storeId: row.store_id === null || row.store_id === undefined ? null : Number(row.store_id),
  };
}

export async function setSessionStore(sessionId: string, storeId: number | null): Promise<void> {
  await rawRun(`UPDATE sessions SET store_id = ? WHERE id = ?`, [storeId, sessionId]);
}

export async function revokeSession(sessionId: string): Promise<void> {
  await rawRun(`UPDATE sessions SET revoked_at = ? WHERE id = ?`, [
    Math.floor(Date.now() / 1000),
    sessionId,
  ]);
}

/** Révoque toutes les sessions d'un utilisateur (désactivation, mot de passe changé). */
export async function revokeUserSessions(userId: number, exceptSessionId?: string): Promise<void> {
  await rawRun(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`,
    [Math.floor(Date.now() / 1000), userId, exceptSessionId ?? null],
  );
}

/** Efface le cookie de session. */
export function clearSessionResponse(): NextResponse {
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, '', cookieOptions(0));
  for (const legacy of ['session', 'session_user', 'user']) {
    response.cookies.set(legacy, '', { ...cookieOptions(0), httpOnly: legacy !== 'user' });
  }
  return response;
}
