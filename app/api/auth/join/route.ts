import { NextResponse } from 'next/server';
import { rawGet } from '@/db';
import { enrollDevice, syncNow } from '@/lib/sync-engine';

/**
 * POST /api/auth/join — **installation d'un poste de magasin** (§19.2).
 *
 * Accessible sans connexion, mais **uniquement sur une base vide** (aucun
 * utilisateur) : un poste neuf rejoint le serveur avec le code d'inscription
 * fourni par le siège, puis reçoit les comptes, le catalogue et les données de
 * son magasin. Dès qu'un compte existe localement, cette route est fermée.
 */
export async function POST(request: Request) {
  try {
    const users = await rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM users`);
    if (Number(users?.n ?? 0) > 0) {
      return NextResponse.json({ error: 'Ce poste est déjà configuré.' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const code = String(body?.code ?? '').trim();
    if (!code) return NextResponse.json({ error: "Saisissez le code d'inscription" }, { status: 400 });

    const device = await enrollDevice({
      serverUrl: String(body?.serverUrl ?? ''),
      deviceName: String(body?.deviceName ?? ''),
      code,
    });
    const result = await syncNow();
    const after = await rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM users`);

    return NextResponse.json({
      device: { mode: device.mode, deviceCode: device.deviceCode },
      sync: result,
      users: Number(after?.n ?? 0),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Inscription impossible' }, { status: error?.status ?? 500 });
  }
}
