/**
 * Pilotage des chantiers — tableau de bord du magasin et vue consolidée de
 * l'administrateur (cahier « Prestations de chantier » §17 et §18).
 *
 * Une seule fonction pour les deux : la **portée** décide. Un gérant voit son
 * magasin ; l'administrateur choisit « tous les magasins » et obtient, en plus,
 * la comparaison par magasin — sans jamais mélanger les données locales (les
 * montants restent attribués à leur magasin).
 *
 * Filtres : magasin(s), période (date de début prévue du chantier), catégorie,
 * statut. Tout est calculé à la lecture.
 */

import { rawAll } from '@/db';
import { scopeSql, type StoreScope } from '@/lib/stores';
import { jobCategoryLabel, jobCategoryStoredValues } from '@/lib/job-categories';
import { getJobsSummary, isJobStatus, listServiceJobs, type JobsSummary, type ServiceJobRow } from '@/lib/jobs';
import { getQuotesSummary, type QuotesSummary } from '@/lib/quotes';
import { getRequestsSummary, type RequestsSummary } from '@/lib/service-requests';
import { roundMoney, today } from '@/lib/format';

export type StoreJobsRow = {
  storeId: number;
  storeName: string;
  jobs: number;
  open: number;
  late: number;
  billed: number;
  collected: number;
  outstanding: number;
  /** `null` sans `balances.view`. */
  totalCost: number | null;
  margin: number | null;
};

export type JobsDashboard = {
  summary: JobsSummary;
  requests: RequestsSummary;
  quotes: QuotesSummary;
  byStore: StoreJobsRow[];
  topServices: { name: string; storeName: string; quantity: number; unit: string; amount: number; jobs: number }[];
  byCategory: { category: string; jobs: number; billed: number; margin: number | null }[];
  monthly: { month: string; billed: number; collected: number }[];
  lateJobs: ServiceJobRow[];
  activity: {
    id: number;
    createdAt: string | null;
    userName: string;
    storeName: string | null;
    action: string;
    entity: string;
    entityId: number | null;
    details: string | null;
  }[];
};

type Filters = { scope: StoreScope; from?: string; to?: string; category?: string; status?: string; withCosts: boolean };

/** Conditions communes sur `service_jobs j` (portée, période, catégorie, statut). */
function jobWhere(filters: Filters): { sql: string; args: (string | number)[] } {
  const where = [scopeSql('j.store_id', filters.scope)];
  const args: (string | number)[] = [];
  if (filters.from) {
    where.push("COALESCE(j.start_date, date(j.created_at, 'unixepoch')) >= ?");
    args.push(filters.from);
  }
  if (filters.to) {
    where.push("COALESCE(j.start_date, date(j.created_at, 'unixepoch')) <= ?");
    args.push(filters.to);
  }
  if (filters.category?.trim()) {
    const values = jobCategoryStoredValues(filters.category);
    where.push(`j.category IN (${values.map(() => '?').join(',')})`);
    args.push(...values);
  }
  if (filters.status === 'open') {
    where.push(`j.status IN ('pending', 'planned', 'in_progress', 'suspended')`);
  } else if (isJobStatus(filters.status)) {
    where.push('j.status = ?');
    args.push(filters.status);
  }
  return { sql: where.join(' AND '), args };
}

/** Coût d'un chantier en SQL (matériaux + main-d'œuvre + sous-traitance convenue + dépenses validées). */
const JOB_COST_SQL = `(
  COALESCE((SELECT SUM(m.amount) FROM service_job_materials m WHERE m.job_id = j.id), 0)
  + COALESCE((SELECT SUM(w.amount) FROM service_job_workers w WHERE w.job_id = j.id), 0)
  + COALESCE((SELECT SUM(s.agreed_amount) FROM job_subcontracts s WHERE s.job_id = j.id AND s.status = 'active'), 0)
  + COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.reference_type = 'service_job' AND e.reference_id = j.id
               AND e.deleted_at IS NULL AND e.approval_status IN ('approved', 'to_pay')), 0)
)`;

/** Chantiers qui comptent dans le chiffre d'affaires. */
const BILLABLE = `j.status NOT IN ('cancelled', 'quote')`;

export async function getJobsDashboard(filters: Filters): Promise<JobsDashboard> {
  const { sql, args } = jobWhere(filters);
  const day = today();

  const [summary, requests, quotes, storeRows, topServices, categoryRows, monthlyRows, late, activity] = await Promise.all([
    getJobsSummary({ scope: filters.scope, from: filters.from, to: filters.to, category: filters.category }),
    getRequestsSummary(filters.scope, filters.from, filters.to),
    getQuotesSummary(filters.scope, filters.from, filters.to),
    rawAll<any>(
      `SELECT st.id AS store_id, st.name AS store_name,
              COUNT(j.id) AS jobs,
              SUM(CASE WHEN j.status IN ('pending', 'planned', 'in_progress', 'suspended') THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN j.status IN ('pending', 'planned', 'in_progress', 'suspended') AND j.end_date IS NOT NULL AND j.end_date < ? THEN 1 ELSE 0 END) AS late,
              SUM(CASE WHEN ${BILLABLE} THEN j.total ELSE 0 END) AS billed,
              SUM(CASE WHEN ${BILLABLE} THEN j.amount_paid ELSE 0 END) AS collected,
              SUM(CASE WHEN ${BILLABLE} THEN ${JOB_COST_SQL} ELSE 0 END) AS cost
       FROM service_jobs j
       JOIN stores st ON st.id = j.store_id
       WHERE ${sql}
       GROUP BY st.id ORDER BY billed DESC`,
      [day, ...args],
    ),
    rawAll<any>(
      `SELECT i.service_name AS name, st.name AS store_name, i.unit, SUM(i.quantity) AS quantity,
              SUM(i.amount) AS amount, COUNT(DISTINCT j.id) AS jobs
       FROM service_job_items i
       JOIN service_jobs j ON j.id = i.job_id
       JOIN stores st ON st.id = j.store_id
       WHERE ${BILLABLE} AND ${sql}
       GROUP BY j.store_id, COALESCE(i.service_id, i.service_name)
       ORDER BY amount DESC LIMIT 8`,
      args,
    ),
    rawAll<any>(
      `SELECT j.category, COUNT(*) AS jobs, SUM(j.total) AS billed, SUM(${JOB_COST_SQL}) AS cost
       FROM service_jobs j WHERE ${BILLABLE} AND ${sql}
       GROUP BY j.category ORDER BY billed DESC`,
      args,
    ),
    rawAll<any>(
      `SELECT substr(COALESCE(j.start_date, date(j.created_at, 'unixepoch')), 1, 7) AS month,
              SUM(j.total) AS billed, SUM(j.amount_paid) AS collected
       FROM service_jobs j WHERE ${BILLABLE} AND ${sql}
       GROUP BY month ORDER BY month`,
      args,
    ),
    listServiceJobs({ scope: filters.scope, late: true, category: filters.category, limit: 10 }),
    rawAll<any>(
      `SELECT a.id, a.created_at, a.user_name, st.name AS store_name, a.action, a.entity, a.entity_id, a.details
       FROM audit_logs a LEFT JOIN stores st ON st.id = a.store_id
       WHERE a.entity IN ('service_job', 'quote', 'service_request', 'service') AND ${scopeSql('a.store_id', filters.scope)}
       ORDER BY a.id DESC LIMIT 12`,
    ),
  ]);

  // Les anciens codes de type (v1) et les libellés actuels se regroupent sous le même libellé.
  const categories = new Map<string, { jobs: number; billed: number; cost: number }>();
  for (const row of categoryRows) {
    const label = jobCategoryLabel(row.category);
    const current = categories.get(label) ?? { jobs: 0, billed: 0, cost: 0 };
    current.jobs += Number(row.jobs);
    current.billed += Number(row.billed ?? 0);
    current.cost += Number(row.cost ?? 0);
    categories.set(label, current);
  }

  return {
    summary,
    requests,
    quotes,
    byStore: storeRows.map((row) => {
      const billed = roundMoney(Number(row.billed ?? 0));
      const collected = roundMoney(Number(row.collected ?? 0));
      const cost = roundMoney(Number(row.cost ?? 0));
      return {
        storeId: Number(row.store_id),
        storeName: row.store_name,
        jobs: Number(row.jobs ?? 0),
        open: Number(row.open ?? 0),
        late: Number(row.late ?? 0),
        billed,
        collected,
        outstanding: roundMoney(billed - collected),
        totalCost: filters.withCosts ? cost : null,
        margin: filters.withCosts ? roundMoney(billed - cost) : null,
      };
    }),
    topServices: topServices.map((row) => ({
      name: row.name,
      storeName: row.store_name,
      quantity: Number(row.quantity ?? 0),
      unit: row.unit,
      amount: roundMoney(Number(row.amount ?? 0)),
      jobs: Number(row.jobs ?? 0),
    })),
    byCategory: [...categories.entries()]
      .map(([category, v]) => ({
        category,
        jobs: v.jobs,
        billed: roundMoney(v.billed),
        margin: filters.withCosts ? roundMoney(v.billed - v.cost) : null,
      }))
      .sort((a, b) => b.billed - a.billed),
    monthly: monthlyRows
      .filter((row) => row.month)
      .map((row) => ({
        month: row.month,
        billed: roundMoney(Number(row.billed ?? 0)),
        collected: roundMoney(Number(row.collected ?? 0)),
      })),
    lateJobs: late.data,
    activity: activity.map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at ? new Date(Number(row.created_at) * 1000).toISOString() : null,
      userName: row.user_name,
      storeName: row.store_name ?? null,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id == null ? null : Number(row.entity_id),
      details: row.details ?? null,
    })),
  };
}
