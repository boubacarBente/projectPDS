import { writeAudit } from '@/lib/audit';
import { getSessionUser } from '@/lib/api';
import { clearSessionResponse } from '@/lib/session';

/** POST /api/auth/logout */
export async function POST() {
  const user = await getSessionUser();

  if (user) {
    await writeAudit({ user, action: 'logout', entity: 'user', entityId: user.id });
  }

  return clearSessionResponse();
}
