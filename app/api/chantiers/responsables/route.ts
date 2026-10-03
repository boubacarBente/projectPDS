import { NextRequest } from 'next/server';
import { rawAll } from '@/db';
import { fail, ok, requireAction } from '@/lib/api';

/**
 * GET /api/chantiers/responsables — personnes pouvant être désignées
 * responsables d'un chantier du magasin actif : comptes actifs affectés à ce
 * magasin, plus les administrateurs généraux.
 *
 * Nom et rôle seulement : la liste complète des comptes reste réservée à
 * `users.manage`.
 */
export async function GET(_request: NextRequest) {
  try {
    const user = await requireAction('jobs.view');
    const rows = await rawAll<{ id: number; name: string; role: string }>(
      `SELECT DISTINCT u.id, u.name, u.role FROM users u
       LEFT JOIN user_stores us ON us.user_id = u.id AND us.is_active = 1
       WHERE u.is_active = 1 AND (u.role = 'admin' OR us.store_id = ?)
       ORDER BY u.name COLLATE NOCASE`,
      [user.storeId ?? 0],
    );
    return ok({ data: rows.map((r) => ({ id: Number(r.id), name: r.name, role: r.role })) });
  } catch (error) {
    return fail(error);
  }
}
