import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/api';
import { listStores } from '@/lib/stores';
import { getDeviceConfig } from '@/lib/device';

/**
 * GET /api/auth/me — utilisateur courant, permissions effectives et contexte
 * de magasin (magasin actif + magasins accessibles sur ce poste).
 *
 * Tout est relu en base : le navigateur n'apporte que son jeton de session.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ user: null, permissions: [], stores: [], activeStoreId: null }, { status: 401 });
  }

  const [stores, device] = await Promise.all([listStores({ ids: user.storeIds }), getDeviceConfig()]);

  return NextResponse.json({
    user: { id: user.id, name: user.name, username: user.username, role: user.role },
    permissions: user.permissions,
    activeStoreId: user.storeId,
    allStores: user.allStores,
    stores: stores.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      kind: s.kind,
      status: s.status,
    })),
    device: {
      mode: device.mode,
      storeId: device.storeId,
      deviceCode: device.deviceCode,
      connected: Boolean(device.serverUrl && device.token),
    },
  });
}
