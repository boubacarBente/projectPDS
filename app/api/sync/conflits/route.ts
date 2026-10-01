import { NextRequest } from 'next/server';
import { fail, ok, requireAction } from '@/lib/api';
import { listConflicts } from '@/lib/sync-engine';

/** GET /api/sync/conflits — conflits consignés (`?status=all` pour l'historique). */
export async function GET(request: NextRequest) {
  try {
    await requireAction('sync.manage');
    const status = request.nextUrl.searchParams.get('status') === 'all' ? 'all' : 'pending';
    const data = await listConflicts({ status, limit: 200 });
    return ok({ data, total: data.length });
  } catch (error) {
    return fail(error);
  }
}
