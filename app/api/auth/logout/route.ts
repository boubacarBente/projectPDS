import { writeAudit } from '@/lib/audit';
import { getSessionUser } from '@/lib/api';
import { clearSessionResponse, revokeSession } from '@/lib/session';

/** POST /api/auth/logout — la session est révoquée en base, pas seulement oubliée. */
export async function POST() {
  const user = await getSessionUser();

  if (user) {
    await writeAudit({ user, action: 'logout', entity: 'user', entityId: user.id });
    await revokeSession(user.sessionId).catch(() => {});
  }

  return clearSessionResponse();
}
