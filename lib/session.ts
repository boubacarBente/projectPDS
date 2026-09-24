import { NextResponse } from 'next/server';
import type { Role } from '@/lib/permissions';

export type SessionPayload = {
  id: number;
  name: string;
  username: string;
  role: Role;
};

/**
 * Création de la session (repris du projet Gaz, §17.1).
 *
 * Trois cookies, comme dans Gaz :
 *  - `session` : jeton opaque httpOnly, vérifié par `proxy.ts` ;
 *  - `session_user` : payload httpOnly, lu côté serveur ;
 *  - `user` : payload lisible, pour l'affichage immédiat côté client.
 *
 * `secure` reste à `false` : l'application tourne sur `127.0.0.1` en HTTP, un
 * cookie `secure` ne serait jamais renvoyé et casserait la session en desktop.
 */
export async function createSessionResponse(
  user: SessionPayload,
  status = 200,
): Promise<NextResponse> {
  const data = new TextEncoder().encode(`${JSON.stringify(user)}-${Date.now()}-${Math.random()}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const sessionToken = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const response = NextResponse.json({ user }, { status });

  const base = { secure: false, sameSite: 'lax' as const, path: '/' };

  response.cookies.set('session', sessionToken, { ...base, httpOnly: true });
  response.cookies.set('session_user', JSON.stringify(user), { ...base, httpOnly: true });
  response.cookies.set('user', JSON.stringify(user), { ...base, httpOnly: false });

  return response;
}

/** Efface les trois cookies de session. */
export function clearSessionResponse(): NextResponse {
  const response = NextResponse.json({ success: true });
  const base = { secure: false, sameSite: 'lax' as const, path: '/' };

  for (const name of ['session', 'session_user', 'user']) {
    response.cookies.set(name, '', { ...base, httpOnly: name !== 'user', maxAge: 0 });
  }

  return response;
}
