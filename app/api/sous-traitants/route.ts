import { NextRequest } from 'next/server';
import { rawAll } from '@/db';
import { fail, ok, requireAction, scopeFromRequest } from '@/lib/api';
import { scopeSql } from '@/lib/stores';
import { roundMoney } from '@/lib/format';

/**
 * GET /api/sous-traitants — sous-traitants (fournisseurs marqués comme tels)
 * avec leurs travaux sur les chantiers des magasins visibles : montant
 * convenu, payé (dépenses décaissées rattachées) et reste (cahier §12).
 *
 * La fiche reste commune (référentiel fournisseurs) ; les montants sont ceux
 * des chantiers du ou des magasins choisis (`?store=`).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('jobs.view');
    const scope = scopeFromRequest(user, request);
    const search = request.nextUrl.searchParams.get('search')?.trim();
    const args: string[] = [];
    let searchSql = '';
    if (search) {
      searchSql = 'AND (f.name LIKE ? OR f.phone LIKE ? OR f.specialty LIKE ?)';
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const rows = await rawAll<any>(
      `SELECT f.id, f.name, f.phone, f.specialty, f.is_active,
              COUNT(DISTINCT s.job_id) AS jobs,
              COALESCE(SUM(s.agreed_amount), 0) AS agreed,
              COALESCE(SUM((SELECT SUM(e.amount) FROM expenses e
                             WHERE e.reference_type = 'job_subcontract' AND e.reference_id = s.id
                               AND e.deleted_at IS NULL AND e.approval_status = 'approved')), 0) AS paid
       FROM suppliers f
       LEFT JOIN job_subcontracts s ON s.supplier_id = f.id AND s.status = 'active'
         AND s.job_id IN (SELECT j.id FROM service_jobs j WHERE ${scopeSql('j.store_id', scope)} AND j.status <> 'cancelled')
       WHERE f.is_subcontractor = 1 ${searchSql}
       GROUP BY f.id
       ORDER BY f.is_active DESC, agreed DESC, f.name COLLATE NOCASE`,
      args,
    );

    return ok({
      data: rows.map((row) => {
        const agreed = roundMoney(Number(row.agreed ?? 0));
        const paid = roundMoney(Number(row.paid ?? 0));
        return {
          id: Number(row.id),
          name: row.name,
          phone: row.phone ?? null,
          specialty: row.specialty ?? null,
          isActive: Boolean(row.is_active),
          jobs: Number(row.jobs ?? 0),
          agreed,
          paid,
          remaining: roundMoney(Math.max(agreed - paid, 0)),
        };
      }),
    });
  } catch (error) {
    return fail(error);
  }
}
