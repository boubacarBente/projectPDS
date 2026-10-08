/**
 * Chantiers — prestations de service (README §19, cahier « Prestations de
 * chantier multi-magasins »).
 *
 * Principes structurants :
 *
 * 1. Le **montant facturé** d'un chantier est la somme de ses **lignes de
 *    prestations** (`service_job_items`), prix figés au moment de la saisie.
 *    Les matériaux, la main-d'œuvre, la sous-traitance et les dépenses sont
 *    des **coûts** : ils ne changent jamais le prix payé par le client.
 *    ⚠️ Avant la v2, le total était recalculé comme « matériaux au prix
 *    d'achat + main-d'œuvre » : le client payait le coût, la marge valait
 *    toujours zéro (constaté sur la démonstration : 7 940 000 facturés pour
 *    7 940 000 de coût). Un chantier **sans** ligne garde son montant saisi
 *    (anciens chantiers compris : rien n'est réécrit).
 * 2. Le devis est désormais un **document distinct** (`lib/quotes.ts`),
 *    converti en chantier une fois accepté. Les colonnes `quote_*` et le
 *    statut `quote` ne servent plus qu'aux chantiers d'avant la v2.
 * 3. La prestation est un **document facturable autonome** : son propre
 *    `reference`, ses propres `payments` (`type = 'service_job'`). Elle ne
 *    génère **jamais** de facture de vente (§15).
 * 4. Coûts, marge, avancement et retard sont **calculés à la lecture**.
 * 5. Cloisonnement : un chantier ne se modifie que depuis **son** magasin, et
 *    n'utilise que des prestations **de ce magasin**.
 *
 * ⚠️ Aucune suppression physique d'un chantier : il s'**annule** avec motif.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { asc, eq } from 'drizzle-orm';
import {
  customers,
  jobStages,
  jobSubcontracts,
  serviceJobItems,
  serviceJobMaterials,
  serviceJobWorkers,
  serviceJobs,
} from '@/db/schema';
import { scopeSql, type StoreScope } from '@/lib/stores';
import { addStockMovement } from '@/lib/stock';
import { listPayments, recomputeDocumentPayments, type PaymentRow } from '@/lib/payments';
import { getSettings, nextDocumentNumber } from '@/lib/settings';
import { jobCategoryLabel, jobCategoryStoredValues, matchJobCategory } from '@/lib/job-categories';
import { assertServiceUsable, lineAmount } from '@/lib/services';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api';
import { assertCustomerInStore } from '@/lib/customers';
import { assertSupplierInStore } from '@/lib/suppliers';
import { roundMoney, today } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types et listes fermées
 * ------------------------------------------------------------------ */

export type JobCategory = string;

/**
 * Statuts du chantier (cahier §6). « En retard » n'est **pas** un statut : il
 * se calcule (fin prévue dépassée, chantier non terminé) — un statut stocké
 * deviendrait faux sans que personne ne le change. `quote` ne concerne que les
 * chantiers d'avant la v2 (le devis est désormais un document distinct).
 */
export const JOB_STATUSES = [
  'quote',
  'pending',
  'planned',
  'in_progress',
  'suspended',
  'completed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuts « ouverts » : le chantier peut être en retard. */
export const OPEN_JOB_STATUSES: JobStatus[] = ['pending', 'planned', 'in_progress', 'suspended'];

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'refused'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const STAGE_STATUS_VALUES = ['todo', 'in_progress', 'done', 'blocked'] as const;
export type StageStatus = (typeof STAGE_STATUS_VALUES)[number];

/** Valide un type de prestation contre la liste des paramètres (libellé canonique). */
export async function validateJobCategory(value: unknown): Promise<string> {
  const list = (await getSettings()).jobCategories;
  const match = matchJobCategory(value, list);
  if (!match) {
    throw new ValidationError(
      `Type de prestation inconnu. Choisissez l’un des types définis dans les paramètres : ${list.join(', ')}.`,
    );
  }
  return match;
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === 'string' && (QUOTE_STATUSES as readonly string[]).includes(value);
}

export function isStageStatus(value: unknown): value is StageStatus {
  return typeof value === 'string' && (STAGE_STATUS_VALUES as readonly string[]).includes(value);
}

/** Une ligne de `service_jobs`, enrichie de ses agrégats calculés. */
export type ServiceJobRow = {
  id: number;
  storeId: number | null;
  storeName: string | null;
  reference: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  category: JobCategory;
  title: string | null;
  siteAddress: string | null;
  description: string | null;
  /** Début et fin **prévus**. */
  startDate: string | null;
  endDate: string | null;
  /** Début et fin **réels**. */
  actualStartDate: string | null;
  actualEndDate: string | null;
  status: JobStatus;
  quoteStatus: QuoteStatus;
  quoteMaterials: number;
  quoteLabor: number;
  quoteTotal: number;
  total: number;
  amountPaid: number;
  /** Recalculé par `lib/payments.ts` depuis les paiements réels. */
  remainingAmount: number;
  paymentStatus: string;
  userId: number | null;
  userName: string | null;
  responsibleUserId: number | null;
  responsibleName: string | null;
  notes: string | null;
  /** Avancement affiché (0–100) : moyenne des étapes s'il y en a, sinon saisi. */
  progress: number;
  /** Avancement saisi à la main (sans étapes). */
  manualProgress: number | null;
  /** Fin prévue dépassée et chantier non terminé — calculé, jamais stocké. */
  isLate: boolean;
  quoteId: number | null;
  quoteReference: string | null;
  requestId: number | null;
  requestReference: string | null;
  itemsCount: number;
  stagesCount: number;
  materialsCount: number;
  workersCount: number;
  createdAt: Date | null;
};

export type ServiceJobItemRow = {
  id: number;
  jobId: number;
  serviceId: number | null;
  serviceCode: string | null;
  serviceName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  amount: number;
  position: number;
};

export type ServiceJobMaterialRow = {
  id: number;
  jobId: number;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  unitCost: number;
  amount: number;
  createdAt: Date | null;
};

export type ServiceJobWorkerRow = {
  id: number;
  jobId: number;
  workerId: number | null;
  workerName: string;
  role: string | null;
  days: number;
  dailyRate: number;
  amount: number;
  createdAt: Date | null;
};

export type JobStageRow = {
  id: number;
  jobId: number;
  name: string;
  serviceId: number | null;
  serviceName: string | null;
  responsible: string | null;
  plannedDate: string | null;
  actualDate: string | null;
  progress: number;
  status: StageStatus;
  comment: string | null;
  position: number;
  /** Date prévue dépassée et étape non terminée. */
  isLate: boolean;
};

export type JobSubcontractRow = {
  id: number;
  jobId: number;
  supplierId: number;
  supplierName: string;
  supplierPhone: string | null;
  work: string;
  agreedAmount: number;
  /** Dépenses décaissées rattachées — calculé. */
  paid: number;
  /** Dépenses rattachées en attente d'approbation ou de décaissement. */
  pending: number;
  remaining: number;
  status: 'active' | 'cancelled';
  notes: string | null;
};

export type JobExpenseRow = {
  id: number;
  date: string;
  category: string;
  amount: number;
  description: string | null;
  beneficiary: string | null;
  paymentMethod: string;
  approvalStatus: string;
  /** `service_job` (dépense directe) ou `job_subcontract` (paiement de sous-traitant). */
  referenceType: string;
  subcontractId: number | null;
};

/**
 * Rentabilité d'un chantier (cahier §15), affichée séparément ligne à ligne.
 * Donnée sensible : renvoyée seulement à qui détient `balances.view`.
 */
export type JobCosts = {
  /** Montant facturé (lignes de prestations, ou montant saisi). */
  billed: number;
  collected: number;
  remaining: number;
  /** Matériaux sortis du stock, au **prix d'achat**. */
  materialsCost: number;
  /** Main-d'œuvre : jours × tarif. */
  laborCost: number;
  /** Sous-traitance : montants **convenus** des travaux non annulés. */
  subcontractCost: number;
  /** Autres dépenses rattachées au chantier (approuvées ou à décaisser). */
  expensesCost: number;
  totalCost: number;
  /** Bénéfice brut estimatif = facturé − coûts. */
  margin: number;
  marginPercent: number;
};

export type ServiceJobDetail = {
  job: ServiceJobRow;
  items: ServiceJobItemRow[];
  materials: ServiceJobMaterialRow[];
  workers: ServiceJobWorkerRow[];
  stages: JobStageRow[];
  subcontracts: JobSubcontractRow[];
  expenses: JobExpenseRow[];
  payments: PaymentRow[];
  /** `null` pour un utilisateur sans `balances.view` (invariant n° 13). */
  costs: JobCosts | null;
};

export type JobItemInput = {
  serviceId: number;
  quantity: number;
  /** Prix unitaire ; par défaut le prix estimatif du catalogue (modifiable par chantier). */
  unitPrice?: number | null;
  discountPercent?: number | null;
};

export type ServiceJobInput = {
  customerId: number;
  category?: JobCategory;
  title?: string | null;
  siteAddress?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  actualStartDate?: string | null;
  actualEndDate?: string | null;
  status?: JobStatus;
  quoteStatus?: QuoteStatus;
  quoteMaterials?: number;
  quoteLabor?: number;
  /** Montant contractuel saisi, utilisé tant que le chantier n'a pas de ligne. */
  amount?: number | null;
  progress?: number | null;
  responsibleUserId?: number | null;
  notes?: string | null;
  userId?: number | null;
  items?: JobItemInput[];
};

export type ServiceJobPatch = Partial<Omit<ServiceJobInput, 'userId' | 'items'>>;

export type ServiceJobListOptions = {
  scope: StoreScope;
  search?: string;
  category?: string;
  status?: string;
  quoteStatus?: string;
  customerId?: number;
  /** Seulement les chantiers en retard. */
  late?: boolean;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
};

export type JobsSummary = {
  totalJobs: number;
  byStatus: Record<JobStatus, number>;
  late: number;
  /** Chiffre d'affaires des prestations (hors annulées et anciens devis). */
  billed: number;
  collected: number;
  outstanding: number;
  materialsCost: number;
  laborCost: number;
  subcontractCost: number;
  expensesCost: number;
  totalCost: number;
  margin: number;
  marginPercent: number;
};

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

type JobSqlRow = {
  id: number;
  store_id: number | null;
  store_name: string | null;
  reference: string;
  customer_id: number;
  customer_name: string | null;
  customer_phone: string | null;
  category: string;
  title: string | null;
  site_address: string | null;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  actual_start_date: string | null;
  actual_end_date: string | null;
  status: string;
  quote_status: string;
  quote_materials: number | null;
  quote_labor: number | null;
  quote_total: number | null;
  total: number | null;
  amount_paid: number | null;
  remaining_amount: number | null;
  payment_status: string | null;
  user_id: number | null;
  user_name: string | null;
  responsible_user_id: number | null;
  responsible_name: string | null;
  notes: string | null;
  progress: number | null;
  quote_id: number | null;
  quote_reference: string | null;
  request_id: number | null;
  request_reference: string | null;
  items_count: number | null;
  stages_count: number | null;
  stages_progress: number | null;
  materials_count: number | null;
  workers_count: number | null;
  created_at: number | null;
};

/**
 * Colonnes communes à la liste et à la fiche.
 *
 * La date de période utilisée est `start_date` — la **date métier** du chantier
 * (début prévu) — avec repli sur la date de création.
 */
const JOB_SELECT = `
  SELECT j.id, j.store_id, st.name AS store_name, j.reference, j.customer_id, c.name AS customer_name, c.phone AS customer_phone,
         j.category, j.title, j.site_address, j.description, j.start_date, j.end_date,
         j.actual_start_date, j.actual_end_date,
         j.status, j.quote_status, j.quote_materials, j.quote_labor, j.quote_total, j.total,
         j.amount_paid, j.remaining_amount, j.payment_status, j.user_id, u.name AS user_name,
         j.responsible_user_id, ru.name AS responsible_name,
         j.notes, j.progress, j.created_at,
         j.quote_id, q.reference AS quote_reference, j.request_id, rq.reference AS request_reference,
         (SELECT COUNT(*) FROM service_job_items i WHERE i.job_id = j.id) AS items_count,
         (SELECT COUNT(*) FROM job_stages s WHERE s.job_id = j.id) AS stages_count,
         (SELECT AVG(s.progress) FROM job_stages s WHERE s.job_id = j.id) AS stages_progress,
         (SELECT COUNT(*) FROM service_job_materials m WHERE m.job_id = j.id) AS materials_count,
         (SELECT COUNT(*) FROM service_job_workers w WHERE w.job_id = j.id) AS workers_count
  FROM service_jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN users u ON u.id = j.user_id
  LEFT JOIN users ru ON ru.id = j.responsible_user_id
  LEFT JOIN stores st ON st.id = j.store_id
  LEFT JOIN quotes q ON q.id = j.quote_id
  LEFT JOIN service_requests rq ON rq.id = j.request_id
`;

/** Condition SQL « en retard » (paramètre : la date du jour). */
const LATE_SQL = `(j.status IN ('pending', 'planned', 'in_progress', 'suspended') AND j.end_date IS NOT NULL AND j.end_date < ?)`;

function effectiveProgress(status: JobStatus, stagesCount: number, stagesProgress: number | null, manual: number | null): number {
  if (status === 'completed') return 100;
  if (stagesCount > 0) return Math.round(Number(stagesProgress ?? 0));
  return Math.max(0, Math.min(100, Number(manual ?? 0)));
}

function mapJobRow(row: JobSqlRow): ServiceJobRow {
  const status = isJobStatus(row.status) ? row.status : 'quote';
  const stagesCount = Number(row.stages_count ?? 0);
  return {
    id: Number(row.id),
    storeId: row.store_id == null ? null : Number(row.store_id),
    storeName: row.store_name ?? null,
    reference: row.reference,
    customerId: Number(row.customer_id),
    customerName: row.customer_name ?? 'Client supprimé',
    customerPhone: row.customer_phone,
    // Anciens codes (v1) traduits en libellés : un chantier ne change jamais de type.
    category: jobCategoryLabel(row.category),
    title: row.title,
    siteAddress: row.site_address,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    actualStartDate: row.actual_start_date,
    actualEndDate: row.actual_end_date,
    status,
    quoteStatus: isQuoteStatus(row.quote_status) ? row.quote_status : 'draft',
    quoteMaterials: Number(row.quote_materials ?? 0),
    quoteLabor: Number(row.quote_labor ?? 0),
    quoteTotal: Number(row.quote_total ?? 0),
    total: Number(row.total ?? 0),
    amountPaid: Number(row.amount_paid ?? 0),
    remainingAmount: Number(row.remaining_amount ?? 0),
    paymentStatus: row.payment_status ?? 'unpaid',
    userId: row.user_id,
    userName: row.user_name,
    responsibleUserId: row.responsible_user_id == null ? null : Number(row.responsible_user_id),
    responsibleName: row.responsible_name ?? null,
    notes: row.notes,
    progress: effectiveProgress(status, stagesCount, row.stages_progress, row.progress),
    manualProgress: row.progress == null ? null : Number(row.progress),
    isLate: OPEN_JOB_STATUSES.includes(status) && Boolean(row.end_date) && String(row.end_date) < today(),
    quoteId: row.quote_id == null ? null : Number(row.quote_id),
    quoteReference: row.quote_reference ?? null,
    requestId: row.request_id == null ? null : Number(row.request_id),
    requestReference: row.request_reference ?? null,
    itemsCount: Number(row.items_count ?? 0),
    stagesCount,
    materialsCount: Number(row.materials_count ?? 0),
    workersCount: Number(row.workers_count ?? 0),
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

/** Liste paginée, filtrable par catégorie, statut, retard, client, période. */
export async function listServiceJobs(
  options: ServiceJobListOptions,
): Promise<{ data: ServiceJobRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [scopeSql('j.store_id', options.scope)];
  const args: (string | number)[] = [];

  if (options.search) {
    where.push(
      '(j.reference LIKE ? OR c.name LIKE ? OR j.title LIKE ? OR j.site_address LIKE ? OR j.description LIKE ?)',
    );
    const like = `%${options.search}%`;
    args.push(like, like, like, like, like);
  }
  if (typeof options.category === 'string' && options.category.trim()) {
    const values = jobCategoryStoredValues(options.category);
    where.push(`j.category IN (${values.map(() => '?').join(', ')})`);
    args.push(...values);
  }
  if (options.status === 'open') {
    where.push(`j.status IN ('pending', 'planned', 'in_progress', 'suspended')`);
  } else if (isJobStatus(options.status)) {
    where.push('j.status = ?');
    args.push(options.status);
  }
  if (isQuoteStatus(options.quoteStatus)) {
    where.push('j.quote_status = ?');
    args.push(options.quoteStatus);
  }
  if (options.late) {
    where.push(LATE_SQL);
    args.push(today());
  }
  if (options.customerId) {
    where.push('j.customer_id = ?');
    args.push(options.customerId);
  }
  if (options.from) {
    where.push("COALESCE(j.start_date, date(j.created_at, 'unixepoch')) >= ?");
    args.push(options.from);
  }
  if (options.to) {
    where.push("COALESCE(j.start_date, date(j.created_at, 'unixepoch')) <= ?");
    args.push(options.to);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await rawAll<JobSqlRow>(
    `${JOB_SELECT} ${whereSql}
     ORDER BY COALESCE(j.start_date, date(j.created_at, 'unixepoch')) DESC, j.id DESC
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM service_jobs j
     LEFT JOIN customers c ON c.id = j.customer_id
     ${whereSql}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapJobRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function getServiceJobRow(id: number): Promise<ServiceJobRow | null> {
  const row = await rawGet<JobSqlRow>(`${JOB_SELECT} WHERE j.id = ?`, [id]);
  return row ? mapJobRow(row) : null;
}

export async function listJobItems(jobId: number): Promise<ServiceJobItemRow[]> {
  const rows = await rawAll<any>(
    `SELECT i.*, s.code AS service_code FROM service_job_items i
     LEFT JOIN services s ON s.id = i.service_id
     WHERE i.job_id = ? ORDER BY i.position, i.id`,
    [jobId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    jobId: Number(row.job_id),
    serviceId: row.service_id == null ? null : Number(row.service_id),
    serviceCode: row.service_code ?? null,
    serviceName: row.service_name,
    unit: row.unit,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    discountPercent: Number(row.discount_percent ?? 0),
    amount: Number(row.amount),
    position: Number(row.position ?? 0),
  }));
}

export async function listJobMaterials(jobId: number): Promise<ServiceJobMaterialRow[]> {
  const rows = await db
    .select()
    .from(serviceJobMaterials)
    .where(eq(serviceJobMaterials.jobId, jobId))
    .orderBy(asc(serviceJobMaterials.id));

  return rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    productId: row.productId,
    productName: row.productName,
    unit: row.unit,
    quantity: Number(row.quantity),
    unitCost: Number(row.unitCost),
    amount: Number(row.amount),
    createdAt: row.createdAt,
  }));
}

export async function listJobWorkers(jobId: number): Promise<ServiceJobWorkerRow[]> {
  const rows = await db
    .select()
    .from(serviceJobWorkers)
    .where(eq(serviceJobWorkers.jobId, jobId))
    .orderBy(asc(serviceJobWorkers.id));

  return rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    workerId: row.workerId,
    workerName: row.workerName,
    role: row.role,
    days: Number(row.days),
    dailyRate: Number(row.dailyRate),
    amount: Number(row.amount),
    createdAt: row.createdAt,
  }));
}

export async function listJobStages(jobId: number): Promise<JobStageRow[]> {
  const rows = await rawAll<any>(
    `SELECT g.*, s.name AS service_name FROM job_stages g
     LEFT JOIN services s ON s.id = g.service_id
     WHERE g.job_id = ? ORDER BY g.position, g.id`,
    [jobId],
  );
  const day = today();
  return rows.map((row) => {
    const status: StageStatus = isStageStatus(row.status) ? row.status : 'todo';
    return {
      id: Number(row.id),
      jobId: Number(row.job_id),
      name: row.name,
      serviceId: row.service_id == null ? null : Number(row.service_id),
      serviceName: row.service_name ?? null,
      responsible: row.responsible ?? null,
      plannedDate: row.planned_date ?? null,
      actualDate: row.actual_date ?? null,
      progress: Number(row.progress ?? 0),
      status,
      comment: row.comment ?? null,
      position: Number(row.position ?? 0),
      isLate: status !== 'done' && Boolean(row.planned_date) && String(row.planned_date) < day,
    };
  });
}

/** Travaux sous-traités, avec le payé **calculé** depuis les dépenses rattachées. */
export async function listJobSubcontracts(jobId: number): Promise<JobSubcontractRow[]> {
  const rows = await rawAll<any>(
    `SELECT s.*, f.name AS supplier_name, f.phone AS supplier_phone,
            COALESCE((SELECT SUM(e.amount) FROM expenses e
                      WHERE e.reference_type = 'job_subcontract' AND e.reference_id = s.id
                        AND e.deleted_at IS NULL AND e.approval_status = 'approved'), 0) AS paid,
            COALESCE((SELECT SUM(e.amount) FROM expenses e
                      WHERE e.reference_type = 'job_subcontract' AND e.reference_id = s.id
                        AND e.deleted_at IS NULL AND e.approval_status IN ('pending', 'to_pay')), 0) AS pending
     FROM job_subcontracts s
     LEFT JOIN suppliers f ON f.id = s.supplier_id
     WHERE s.job_id = ? ORDER BY s.id`,
    [jobId],
  );
  return rows.map((row) => {
    const agreed = Number(row.agreed_amount ?? 0);
    const paid = roundMoney(Number(row.paid ?? 0));
    return {
      id: Number(row.id),
      jobId: Number(row.job_id),
      supplierId: Number(row.supplier_id),
      supplierName: row.supplier_name ?? 'Sous-traitant supprimé',
      supplierPhone: row.supplier_phone ?? null,
      work: row.work,
      agreedAmount: agreed,
      paid,
      pending: roundMoney(Number(row.pending ?? 0)),
      remaining: row.status === 'cancelled' ? 0 : roundMoney(Math.max(agreed - paid, 0)),
      status: row.status === 'cancelled' ? 'cancelled' : 'active',
      notes: row.notes ?? null,
    };
  });
}

/** Dépenses du chantier : directes et paiements de ses sous-traitants. */
export async function listJobExpenses(jobId: number): Promise<JobExpenseRow[]> {
  const rows = await rawAll<any>(
    `SELECT e.* FROM expenses e
     WHERE e.deleted_at IS NULL AND (
       (e.reference_type = 'service_job' AND e.reference_id = ?)
       OR (e.reference_type = 'job_subcontract' AND e.reference_id IN (SELECT id FROM job_subcontracts WHERE job_id = ?))
     )
     ORDER BY e.date DESC, e.id DESC`,
    [jobId, jobId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    date: row.date,
    category: row.category,
    amount: Number(row.amount),
    description: row.description ?? null,
    beneficiary: row.beneficiary ?? null,
    paymentMethod: row.payment_method ?? 'Espèces',
    approvalStatus: row.approval_status ?? 'approved',
    referenceType: row.reference_type,
    subcontractId: row.reference_type === 'job_subcontract' ? Number(row.reference_id) : null,
  }));
}

/** Une dépense compte dans le coût dès qu'elle est validée (décaissée ou à décaisser). */
function countsAsCost(expense: JobExpenseRow): boolean {
  return expense.approvalStatus === 'approved' || expense.approvalStatus === 'to_pay';
}

/**
 * Rentabilité — **jamais stockée**.
 *
 * La sous-traitance compte pour son montant **convenu** (engagement) ; ses
 * paiements, qui sont des dépenses `job_subcontract`, ne sont donc **pas**
 * ajoutés une seconde fois aux « autres dépenses ».
 */
export function computeJobCosts(
  job: ServiceJobRow,
  materials: ServiceJobMaterialRow[],
  workers: ServiceJobWorkerRow[],
  subcontracts: JobSubcontractRow[] = [],
  expenses: JobExpenseRow[] = [],
): JobCosts {
  const cancelled = job.status === 'cancelled';
  const materialsCost = roundMoney(materials.reduce((sum, m) => sum + m.amount, 0));
  const laborCost = roundMoney(workers.reduce((sum, w) => sum + w.amount, 0));
  const subcontractCost = roundMoney(
    subcontracts.filter((s) => s.status === 'active').reduce((sum, s) => sum + s.agreedAmount, 0),
  );
  const expensesCost = roundMoney(
    expenses.filter((e) => e.referenceType === 'service_job' && countsAsCost(e)).reduce((sum, e) => sum + e.amount, 0),
  );
  const totalCost = roundMoney(materialsCost + laborCost + subcontractCost + expensesCost);
  const billed = cancelled ? 0 : roundMoney(job.total);
  const margin = roundMoney(billed - totalCost);

  return {
    billed,
    collected: roundMoney(job.amountPaid),
    remaining: cancelled ? 0 : roundMoney(job.remainingAmount),
    materialsCost,
    laborCost,
    subcontractCost,
    expensesCost,
    totalCost,
    margin,
    marginPercent: billed > 0 ? Math.round((margin / billed) * 1000) / 10 : 0,
  };
}

/** Fiche complète. `withCosts = false` masque la rentabilité (invariant n° 13). */
export async function getServiceJob(id: number, options: { withCosts?: boolean } = {}): Promise<ServiceJobDetail | null> {
  const job = await getServiceJobRow(id);
  if (!job) return null;

  const [items, materials, workers, stages, subcontracts, expenses, payments] = await Promise.all([
    listJobItems(id),
    listJobMaterials(id),
    listJobWorkers(id),
    listJobStages(id),
    listJobSubcontracts(id),
    listJobExpenses(id),
    listPayments({ scope: job.storeId ? [job.storeId] : [], type: 'service_job', referenceId: id, limit: 200 }),
  ]);

  return {
    job,
    items,
    materials,
    workers,
    stages,
    subcontracts,
    expenses,
    payments: payments.data,
    costs: options.withCosts === false ? null : computeJobCosts(job, materials, workers, subcontracts, expenses),
  };
}

export async function getJobCosts(jobId: number): Promise<JobCosts> {
  const job = await getServiceJobRow(jobId);
  if (!job) throw new NotFoundError('Chantier introuvable');

  const [materials, workers, subcontracts, expenses] = await Promise.all([
    listJobMaterials(jobId),
    listJobWorkers(jobId),
    listJobSubcontracts(jobId),
    listJobExpenses(jobId),
  ]);
  return computeJobCosts(job, materials, workers, subcontracts, expenses);
}

/* ------------------------------------------------------------------ *
 * Synthèse (cartes de la page /chantiers et pilotage)
 * ------------------------------------------------------------------ */

/**
 * Synthèse par statut + CA, coûts et marge.
 *
 * Agrégation en JavaScript sur une seule requête : la base locale compte
 * quelques milliers de lignes et cette forme évite de répéter la même
 * clause de période dans chaque sous-requête.
 */
export async function getJobsSummary(options: {
  scope: StoreScope;
  from?: string;
  to?: string;
  category?: string;
}): Promise<JobsSummary> {
  const where: string[] = [scopeSql('j.store_id', options.scope)];
  const args: (string | number)[] = [];

  if (options.from) {
    where.push("COALESCE(j.start_date, date(j.created_at, 'unixepoch')) >= ?");
    args.push(options.from);
  }
  if (options.to) {
    where.push("COALESCE(j.start_date, date(j.created_at, 'unixepoch')) <= ?");
    args.push(options.to);
  }
  if (options.category?.trim()) {
    const values = jobCategoryStoredValues(options.category);
    where.push(`j.category IN (${values.map(() => '?').join(', ')})`);
    args.push(...values);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await rawAll<{
    id: number;
    status: string;
    end_date: string | null;
    total: number | null;
    amount_paid: number | null;
    materials_cost: number | null;
    labor_cost: number | null;
    subcontract_cost: number | null;
    expenses_cost: number | null;
  }>(
    `SELECT j.id, j.status, j.end_date, j.total, j.amount_paid,
            COALESCE((SELECT SUM(m.amount) FROM service_job_materials m WHERE m.job_id = j.id), 0) AS materials_cost,
            COALESCE((SELECT SUM(w.amount) FROM service_job_workers w WHERE w.job_id = j.id), 0) AS labor_cost,
            COALESCE((SELECT SUM(s.agreed_amount) FROM job_subcontracts s WHERE s.job_id = j.id AND s.status = 'active'), 0) AS subcontract_cost,
            COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.reference_type = 'service_job' AND e.reference_id = j.id
                        AND e.deleted_at IS NULL AND e.approval_status IN ('approved', 'to_pay')), 0) AS expenses_cost
     FROM service_jobs j
     ${whereSql}`,
    args,
  );

  const byStatus = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  const day = today();

  let billed = 0;
  let collected = 0;
  let materialsCost = 0;
  let laborCost = 0;
  let subcontractCost = 0;
  let expensesCost = 0;
  let late = 0;

  for (const row of rows) {
    const status = isJobStatus(row.status) ? row.status : 'quote';
    byStatus[status] += 1;
    if (OPEN_JOB_STATUSES.includes(status) && row.end_date && row.end_date < day) late += 1;

    // Un chantier annulé, ou un ancien devis jamais accepté, ne rapporte rien.
    if (status === 'cancelled' || status === 'quote') continue;

    billed += Number(row.total ?? 0);
    collected += Number(row.amount_paid ?? 0);
    materialsCost += Number(row.materials_cost ?? 0);
    laborCost += Number(row.labor_cost ?? 0);
    subcontractCost += Number(row.subcontract_cost ?? 0);
    expensesCost += Number(row.expenses_cost ?? 0);
  }

  const totalCost = roundMoney(materialsCost + laborCost + subcontractCost + expensesCost);
  const margin = roundMoney(billed - totalCost);

  return {
    totalJobs: rows.length,
    byStatus,
    late,
    billed: roundMoney(billed),
    collected: roundMoney(collected),
    outstanding: roundMoney(billed - collected),
    materialsCost: roundMoney(materialsCost),
    laborCost: roundMoney(laborCost),
    subcontractCost: roundMoney(subcontractCost),
    expensesCost: roundMoney(expensesCost),
    totalCost,
    margin,
    marginPercent: billed > 0 ? Math.round((margin / billed) * 1000) / 10 : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Écriture — garde commune
 * ------------------------------------------------------------------ */

export async function assertJobEditable(jobId: number, storeId: number): Promise<ServiceJobRow> {
  const job = await getServiceJobRow(jobId);
  if (!job) throw new NotFoundError('Chantier introuvable');
  // Cloisonnement : un chantier ne se modifie que depuis son magasin.
  if (!storeId || job.storeId !== Number(storeId)) {
    throw new ValidationError(
      'Ce chantier appartient à un autre magasin : il ne peut être modifié que depuis ce magasin.',
    );
  }
  if (job.status === 'cancelled') {
    throw new ConflictError('Ce chantier est annulé : il n’accepte plus aucune modification.');
  }
  return job;
}


export function cleanDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError('Les dates doivent être au format AAAA-MM-JJ');
  }
  return text;
}

function cleanProgress(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new ValidationError('L’avancement est un pourcentage entre 0 et 100.');
  return n;
}

async function validResponsible(value: unknown): Promise<number | null> {
  if (value === null || value === undefined || value === '' || Number(value) === 0) return null;
  const id = Number(value);
  const row = await rawGet<{ id: number }>('SELECT id FROM users WHERE id = ?', [id]);
  if (!row) throw new ValidationError('Responsable introuvable');
  return id;
}

function checkDateOrder(start: string | null, end: string | null, label: string) {
  if (start && end && end < start) throw new ValidationError(`La fin ${label} ne peut pas précéder le début ${label}.`);
}

/* ------------------------------------------------------------------ *
 * Lignes de prestations
 * ------------------------------------------------------------------ */

/**
 * Prépare une ligne : prestation **de ce magasin** et **active**, quantité
 * positive, prix figé (catalogue par défaut, ou prix négocié), remise 0–100 %.
 */
export async function prepareServiceLine(
  input: JobItemInput,
  storeId: number,
): Promise<{
  serviceId: number;
  serviceName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  amount: number;
}> {
  const service = await assertServiceUsable(Number(input.serviceId), storeId);
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ValidationError(`Quantité invalide pour « ${service.name} » : elle doit être strictement positive.`);
  }
  const unitPrice =
    input.unitPrice === null || input.unitPrice === undefined || String(input.unitPrice) === ''
      ? service.unitPrice
      : roundMoney(Number(input.unitPrice));
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new ValidationError(`Prix invalide pour « ${service.name} ».`);
  }
  const discountPercent = Math.round(Math.min(100, Math.max(0, Number(input.discountPercent ?? 0) || 0)) * 100) / 100;
  return {
    serviceId: service.id,
    serviceName: service.name,
    unit: service.unit,
    quantity,
    unitPrice,
    discountPercent,
    amount: lineAmount(quantity, unitPrice, discountPercent),
  };
}

/**
 * Réaligne le montant facturé sur les lignes, puis resynchronise le reste à
 * payer depuis les paiements réels.
 *
 * Sans ligne, le montant saisi (ou celui d'un ancien chantier) est conservé :
 * rien n'est réécrit rétroactivement. Les matériaux et la main-d'œuvre n'ont
 * **plus aucun effet** sur le prix facturé.
 */
export async function recomputeJobTotals(jobId: number): Promise<ServiceJobRow> {
  const job = await getServiceJobRow(jobId);
  if (!job) throw new NotFoundError('Chantier introuvable');

  const items = await rawGet<{ count: number; total: number | null }>(
    'SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM service_job_items WHERE job_id = ?',
    [jobId],
  );

  if (Number(items?.count ?? 0) > 0) {
    const total = roundMoney(Number(items?.total ?? 0));
    await db
      .update(serviceJobs)
      .set({ total, quoteTotal: total, updatedAt: new Date() })
      .where(eq(serviceJobs.id, jobId));
  }

  await recomputeDocumentPayments('service_job', jobId);

  const refreshed = await getServiceJobRow(jobId);
  if (!refreshed) throw new NotFoundError('Chantier introuvable');
  return refreshed;
}

/**
 * « Montant à définir » : un chantier peut s'ouvrir **sans prix** (appel du client,
 * visite à faire), mais il reste alors « En préparation ». Le prix — au moins une
 * prestation ou un montant forfaitaire — devient obligatoire pour le planifier, le
 * démarrer ou le terminer, comme pour l'encaisser (lib/payments.ts) et éditer sa
 * facture. Règle serveur : le formulaire n'est qu'un confort.
 */
const PRICE_REQUIRED_STATUSES: Partial<Record<JobStatus, string>> = {
  planned: 'planifier',
  in_progress: 'démarrer',
  completed: 'terminer',
  suspended: 'suspendre',
};

export function assertJobPriced(status: JobStatus, total: number): void {
  const action = PRICE_REQUIRED_STATUSES[status];
  if (action && !(total > 0.001)) {
    throw new ValidationError(
      `Montant à définir : ajoutez une prestation ou un montant forfaitaire avant de ${action} le chantier.`,
    );
  }
}

/** Un montant facturé ne peut pas descendre sous ce que le client a déjà payé. */
async function assertTotalCoversPayments(jobId: number): Promise<void> {
  const row = await rawGet<{ total: number; paid: number; count: number }>(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM service_job_items WHERE job_id = ?) AS total,
            (SELECT COUNT(*) FROM service_job_items WHERE job_id = ?) AS count,
            amount_paid AS paid
     FROM service_jobs WHERE id = ?`,
    [jobId, jobId, jobId],
  );
  if (!row || Number(row.count) === 0) return;
  if (Number(row.total) + 0.01 < Number(row.paid ?? 0)) {
    throw new ConflictError(
      'Le montant du chantier deviendrait inférieur à ce que le client a déjà payé : enregistrez d’abord un remboursement ou ajustez autrement.',
    );
  }
}

async function nextItemPosition(jobId: number): Promise<number> {
  const row = await rawGet<{ p: number | null }>('SELECT MAX(position) AS p FROM service_job_items WHERE job_id = ?', [jobId]);
  return Number(row?.p ?? 0) + 1;
}

export async function addJobItem(jobId: number, input: JobItemInput, storeId: number): Promise<ServiceJobRow> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    const line = await prepareServiceLine(input, storeId);
    await db.insert(serviceJobItems).values({ jobId, ...line, position: await nextItemPosition(jobId) });
    return recomputeJobTotals(jobId);
  });
}

export async function updateJobItem(
  jobId: number,
  itemId: number,
  patch: { quantity?: number; unitPrice?: number; discountPercent?: number },
  storeId: number,
): Promise<ServiceJobRow> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    const item = (await listJobItems(jobId)).find((i) => i.id === itemId);
    if (!item) throw new NotFoundError('Ligne introuvable sur ce chantier');

    const quantity = patch.quantity !== undefined ? Number(patch.quantity) : item.quantity;
    const unitPrice = patch.unitPrice !== undefined ? roundMoney(Number(patch.unitPrice)) : item.unitPrice;
    const discountPercent =
      patch.discountPercent !== undefined ? Math.min(100, Math.max(0, Number(patch.discountPercent) || 0)) : item.discountPercent;
    if (!Number.isFinite(quantity) || quantity <= 0) throw new ValidationError('La quantité doit être strictement positive.');
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new ValidationError('Le prix doit être positif ou nul.');

    await db
      .update(serviceJobItems)
      .set({ quantity, unitPrice, discountPercent, amount: lineAmount(quantity, unitPrice, discountPercent), updatedAt: new Date() })
      .where(eq(serviceJobItems.id, itemId));
    await assertTotalCoversPayments(jobId);
    return recomputeJobTotals(jobId);
  });
}

/**
 * Retire une ligne de prestation. C'est une correction de saisie sur un
 * document en cours (comme une ligne de matériau) : elle est journalisée.
 * Le dernier retrait laisse le chantier à son dernier montant.
 */
export async function removeJobItem(jobId: number, itemId: number, storeId: number): Promise<{ job: ServiceJobRow; removed: ServiceJobItemRow }> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    const item = (await listJobItems(jobId)).find((i) => i.id === itemId);
    if (!item) throw new NotFoundError('Ligne introuvable sur ce chantier');
    await db.delete(serviceJobItems).where(eq(serviceJobItems.id, itemId));
    await assertTotalCoversPayments(jobId);
    return { job: await recomputeJobTotals(jobId), removed: item };
  });
}

/* ------------------------------------------------------------------ *
 * Création et modification
 * ------------------------------------------------------------------ */

/** Numéro `CHA-KAL-2026-000001` puis création du chantier. */
export async function createServiceJob(
  input: ServiceJobInput & {
    storeId: number;
    quoteId?: number | null;
    requestId?: number | null;
    /** Lignes déjà figées (conversion d'un devis) : prix et noms repris tels quels. */
    frozenItems?: {
      serviceId: number | null;
      serviceName: string;
      unit: string;
      quantity: number;
      unitPrice: number;
      discountPercent: number;
      amount: number;
    }[];
  },
): Promise<ServiceJobRow> {
  return withTransaction(() => createServiceJobInTx(input));
}

async function createServiceJobInTx(
  input: Parameters<typeof createServiceJob>[0],
): Promise<ServiceJobRow> {
  if (!input.storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new ValidationError('Le client du chantier est obligatoire');
  }
  // Le client doit être de ce magasin (README §28.5).
  await assertCustomerInStore(customerId, input.storeId);

  const lines = [...(input.frozenItems ?? [])];
  for (const item of input.items ?? []) lines.push(await prepareServiceLine(item, input.storeId));

  const startDate = cleanDate(input.startDate);
  const endDate = cleanDate(input.endDate);
  checkDateOrder(startDate, endDate, 'prévue');

  const reference = await nextDocumentNumber('job', input.storeId);

  // Sans ligne : montant contractuel saisi (ou l'ancienne estimation matériaux + main-d'œuvre).
  const quoteMaterials = roundMoney(Number(input.quoteMaterials ?? 0) || 0);
  const quoteLabor = roundMoney(Number(input.quoteLabor ?? 0) || 0);
  const manualAmount =
    input.amount !== undefined && input.amount !== null ? roundMoney(Number(input.amount) || 0) : quoteMaterials + quoteLabor;
  if (manualAmount < 0) throw new ValidationError('Le montant du chantier doit être positif.');
  const total = lines.length > 0 ? roundMoney(lines.reduce((sum, l) => sum + l.amount, 0)) : manualAmount;

  const status = isJobStatus(input.status) && input.status !== 'cancelled' && input.status !== 'quote' ? input.status : 'pending';
  assertJobPriced(status, total);

  const inserted = await db
    .insert(serviceJobs)
    .values({
      storeId: input.storeId,
      reference,
      customerId,
      category: await validateJobCategory(input.category),
      title: input.title?.trim() || null,
      siteAddress: input.siteAddress?.trim() || null,
      description: input.description?.trim() || null,
      startDate,
      endDate,
      actualStartDate: cleanDate(input.actualStartDate) ?? (status === 'in_progress' ? today() : null),
      actualEndDate: cleanDate(input.actualEndDate),
      status,
      // Le devis vit désormais à part : un chantier est par construction « accepté ».
      quoteStatus: 'accepted',
      quoteMaterials,
      quoteLabor,
      quoteTotal: total,
      total,
      amountPaid: 0,
      remainingAmount: total,
      paymentStatus: 'unpaid',
      progress: cleanProgress(input.progress),
      responsibleUserId: await validResponsible(input.responsibleUserId),
      quoteId: input.quoteId ?? null,
      requestId: input.requestId ?? null,
      userId: input.userId ?? null,
      notes: input.notes?.trim() || null,
    })
    .returning({ id: serviceJobs.id });

  const jobId = inserted[0].id;
  let position = 1;
  for (const line of lines) {
    await db.insert(serviceJobItems).values({ jobId, ...line, position: position++ });
  }

  const created = await getServiceJobRow(jobId);
  if (!created) throw new NotFoundError('Chantier créé mais introuvable');
  return created;
}

/**
 * Modification des informations du chantier.
 *
 * Le montant saisi (`amount`) ne s'applique qu'à un chantier **sans** ligne de
 * prestation : dès qu'une ligne existe, ce sont les lignes qui font le prix.
 */
export async function updateServiceJob(id: number, patch: ServiceJobPatch, storeId: number): Promise<ServiceJobRow> {
  return withTransaction(async () => {
    const job = await assertJobEditable(id, storeId);

    const values: Record<string, unknown> = { updatedAt: new Date() };

    if (patch.customerId !== undefined) {
      const customerId = Number(patch.customerId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        throw new ValidationError('Le client du chantier est obligatoire');
      }
      if (customerId !== job.customerId) await assertCustomerInStore(customerId, storeId);
      values.customerId = customerId;
    }
    if (patch.category !== undefined) {
      // Le type actuel reste accepté même s'il a été retiré de la liste depuis.
      values.category =
        jobCategoryLabel(patch.category).toLowerCase() === jobCategoryLabel(job.category).toLowerCase()
          ? job.category
          : await validateJobCategory(patch.category);
    }
    if (patch.title !== undefined) values.title = patch.title?.trim() || null;
    if (patch.siteAddress !== undefined) values.siteAddress = patch.siteAddress?.trim() || null;
    if (patch.description !== undefined) values.description = patch.description?.trim() || null;
    if (patch.startDate !== undefined) values.startDate = cleanDate(patch.startDate);
    if (patch.endDate !== undefined) values.endDate = cleanDate(patch.endDate);
    if (patch.actualStartDate !== undefined) values.actualStartDate = cleanDate(patch.actualStartDate);
    if (patch.actualEndDate !== undefined) values.actualEndDate = cleanDate(patch.actualEndDate);
    if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;
    if (patch.progress !== undefined) values.progress = cleanProgress(patch.progress);
    if (patch.responsibleUserId !== undefined) values.responsibleUserId = await validResponsible(patch.responsibleUserId);

    checkDateOrder(
      (values.startDate as string | null | undefined) ?? (patch.startDate !== undefined ? null : job.startDate),
      (values.endDate as string | null | undefined) ?? (patch.endDate !== undefined ? null : job.endDate),
      'prévue',
    );
    checkDateOrder(
      (values.actualStartDate as string | null | undefined) ?? (patch.actualStartDate !== undefined ? null : job.actualStartDate),
      (values.actualEndDate as string | null | undefined) ?? (patch.actualEndDate !== undefined ? null : job.actualEndDate),
      'réelle',
    );

    if (patch.quoteStatus !== undefined) {
      if (!isQuoteStatus(patch.quoteStatus)) throw new ValidationError('Statut de devis invalide');
      values.quoteStatus = patch.quoteStatus;
    }

    if (patch.status !== undefined) {
      if (!isJobStatus(patch.status)) throw new ValidationError('Statut de chantier invalide');
      if (patch.status === 'cancelled') {
        throw new ValidationError('L’annulation d’un chantier passe par un motif obligatoire (route d’annulation).');
      }
      values.status = patch.status;
    }

    let totalsChanged = false;
    if (patch.amount !== undefined && patch.amount !== null) {
      if (job.itemsCount > 0) {
        throw new ValidationError('Ce chantier a des lignes de prestations : son montant se calcule à partir d’elles.');
      }
      const amount = roundMoney(Number(patch.amount) || 0);
      if (amount < 0) throw new ValidationError('Le montant du chantier doit être positif.');
      if (amount + 0.01 < job.amountPaid) {
        throw new ConflictError('Le montant ne peut pas être inférieur à ce que le client a déjà payé.');
      }
      values.total = amount;
      values.quoteTotal = amount;
      totalsChanged = true;
    } else if (patch.quoteMaterials !== undefined || patch.quoteLabor !== undefined) {
      // Ancien formulaire (v1) : estimation matériaux + main-d'œuvre.
      if (job.itemsCount === 0) {
        const quoteMaterials = roundMoney(
          patch.quoteMaterials !== undefined ? Number(patch.quoteMaterials) || 0 : job.quoteMaterials,
        );
        const quoteLabor = roundMoney(patch.quoteLabor !== undefined ? Number(patch.quoteLabor) || 0 : job.quoteLabor);
        values.quoteMaterials = quoteMaterials;
        values.quoteLabor = quoteLabor;
        values.quoteTotal = roundMoney(quoteMaterials + quoteLabor);
        values.total = values.quoteTotal;
        totalsChanged = true;
      }
    }

    // Statut et montant après modification : un chantier lancé ne retombe pas à 0.
    assertJobPriced(
      (values.status as JobStatus | undefined) ?? job.status,
      values.total !== undefined ? Number(values.total) : job.total,
    );

    const updated = await db
      .update(serviceJobs)
      .set(values as any)
      .where(eq(serviceJobs.id, id))
      .returning({ id: serviceJobs.id });

    if (updated.length === 0) throw new NotFoundError('Chantier introuvable');

    if (totalsChanged) await recomputeDocumentPayments('service_job', id);

    const result = await getServiceJobRow(id);
    if (!result) throw new NotFoundError('Chantier introuvable après modification');
    return result;
  });
}

/** Statut d'acceptation d'un **ancien** chantier-devis (v1). */
export async function updateQuoteStatus(id: number, quoteStatus: QuoteStatus, storeId: number): Promise<ServiceJobRow> {
  if (!isQuoteStatus(quoteStatus)) throw new ValidationError('Statut de devis invalide');

  const job = await assertJobEditable(id, storeId);

  const values: Record<string, unknown> = { quoteStatus, updatedAt: new Date() };
  if (quoteStatus === 'accepted' && job.status === 'quote') values.status = 'pending';

  await db.update(serviceJobs).set(values as any).where(eq(serviceJobs.id, id));

  const result = await getServiceJobRow(id);
  if (!result) throw new NotFoundError('Chantier introuvable après modification');
  return result;
}

/**
 * Changement de statut. « En cours » renseigne le début réel s'il manque,
 * « Terminé » la fin réelle — les dates prévues ne sont jamais écrasées.
 */
export async function updateStatus(id: number, status: JobStatus, storeId: number): Promise<ServiceJobRow> {
  if (!isJobStatus(status)) throw new ValidationError('Statut de chantier invalide');
  if (status === 'cancelled') {
    throw new ValidationError('L’annulation d’un chantier passe par un motif obligatoire (route d’annulation).');
  }

  const job = await assertJobEditable(id, storeId);
  assertJobPriced(status, job.total);

  const values: Record<string, unknown> = { status, updatedAt: new Date() };
  if (status === 'in_progress' && !job.actualStartDate) values.actualStartDate = today();
  if (status === 'completed') {
    if (!job.actualStartDate) values.actualStartDate = job.startDate && job.startDate <= today() ? job.startDate : today();
    if (!job.actualEndDate) values.actualEndDate = today();
  }

  await db.update(serviceJobs).set(values as any).where(eq(serviceJobs.id, id));

  const result = await getServiceJobRow(id);
  if (!result) throw new NotFoundError('Chantier introuvable après modification');
  return result;
}

/* ------------------------------------------------------------------ *
 * Étapes
 * ------------------------------------------------------------------ */

export type StageInput = {
  name?: string;
  serviceId?: number | null;
  responsible?: string | null;
  plannedDate?: string | null;
  actualDate?: string | null;
  progress?: number;
  status?: StageStatus;
  comment?: string | null;
};

/** Statut et avancement d'une étape restent cohérents (100 % = terminée). */
function normalizeStage(progress: number, status: StageStatus): { progress: number; status: StageStatus } {
  if (status === 'done') return { progress: 100, status };
  if (progress >= 100) return { progress: 100, status: 'done' };
  if (progress > 0 && status === 'todo') return { progress, status: 'in_progress' };
  return { progress, status };
}

async function validStageService(serviceId: unknown, storeId: number): Promise<number | null> {
  if (serviceId === null || serviceId === undefined || serviceId === '' || Number(serviceId) === 0) return null;
  const row = await rawGet<{ store_id: number }>('SELECT store_id FROM services WHERE id = ?', [Number(serviceId)]);
  if (!row || Number(row.store_id) !== Number(storeId)) {
    throw new ValidationError('La prestation associée doit appartenir au catalogue de ce magasin.');
  }
  return Number(serviceId);
}

export async function addJobStage(jobId: number, input: StageInput, storeId: number): Promise<JobStageRow> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    const name = String(input.name ?? '').trim();
    if (!name) throw new ValidationError('Le nom de l’étape est obligatoire.');
    const base = normalizeStage(cleanProgress(input.progress) ?? 0, isStageStatus(input.status) ? input.status : 'todo');
    const pos = await rawGet<{ p: number | null }>('SELECT MAX(position) AS p FROM job_stages WHERE job_id = ?', [jobId]);
    const inserted = await db
      .insert(jobStages)
      .values({
        jobId,
        name,
        serviceId: await validStageService(input.serviceId, storeId),
        responsible: input.responsible?.trim() || null,
        plannedDate: cleanDate(input.plannedDate),
        actualDate: cleanDate(input.actualDate) ?? (base.status === 'done' ? today() : null),
        progress: base.progress,
        status: base.status,
        comment: input.comment?.trim() || null,
        position: Number(pos?.p ?? 0) + 1,
      })
      .returning({ id: jobStages.id });
    const stage = (await listJobStages(jobId)).find((s) => s.id === inserted[0].id);
    if (!stage) throw new NotFoundError('Étape créée mais introuvable');
    return stage;
  });
}

export async function updateJobStage(jobId: number, stageId: number, patch: StageInput, storeId: number): Promise<JobStageRow> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    const current = (await listJobStages(jobId)).find((s) => s.id === stageId);
    if (!current) throw new NotFoundError('Étape introuvable sur ce chantier');

    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = String(patch.name ?? '').trim();
      if (!name) throw new ValidationError('Le nom de l’étape est obligatoire.');
      values.name = name;
    }
    if (patch.serviceId !== undefined) values.serviceId = await validStageService(patch.serviceId, storeId);
    if (patch.responsible !== undefined) values.responsible = patch.responsible?.trim() || null;
    if (patch.plannedDate !== undefined) values.plannedDate = cleanDate(patch.plannedDate);
    if (patch.actualDate !== undefined) values.actualDate = cleanDate(patch.actualDate);
    if (patch.comment !== undefined) values.comment = patch.comment?.trim() || null;

    const progress = patch.progress !== undefined ? (cleanProgress(patch.progress) ?? 0) : current.progress;
    const requestedStatus = patch.status !== undefined && isStageStatus(patch.status) ? patch.status : current.status;
    // Baisser l'avancement d'une étape terminée la rouvre.
    const status = requestedStatus === 'done' && patch.progress !== undefined && progress < 100 && patch.status === undefined
      ? 'in_progress'
      : requestedStatus;
    const normalized = normalizeStage(progress, status);
    values.progress = normalized.progress;
    values.status = normalized.status;
    if (normalized.status === 'done' && !current.actualDate && patch.actualDate === undefined) values.actualDate = today();

    await db.update(jobStages).set(values as any).where(eq(jobStages.id, stageId));
    const stage = (await listJobStages(jobId)).find((s) => s.id === stageId);
    if (!stage) throw new NotFoundError('Étape introuvable');
    return stage;
  });
}

/** Retire une étape (élément de planification, pas un document financier). */
export async function removeJobStage(jobId: number, stageId: number, storeId: number): Promise<JobStageRow> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    const current = (await listJobStages(jobId)).find((s) => s.id === stageId);
    if (!current) throw new NotFoundError('Étape introuvable sur ce chantier');
    await db.delete(jobStages).where(eq(jobStages.id, stageId));
    return current;
  });
}

/* ------------------------------------------------------------------ *
 * Sous-traitance
 * ------------------------------------------------------------------ */

export async function addJobSubcontract(
  jobId: number,
  input: { supplierId: number; work: string; agreedAmount: number; notes?: string | null; userId?: number | null },
  storeId: number,
): Promise<JobSubcontractRow> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    // Sous-traitant **de ce magasin** (README §28.5).
    const supplier = await assertSupplierInStore(Number(input.supplierId), storeId, 'sous-traitant');
    if (!supplier.isActive) throw new ValidationError('Ce sous-traitant est désactivé.');
    const work = String(input.work ?? '').trim();
    if (!work) throw new ValidationError('Décrivez les travaux confiés.');
    const agreedAmount = roundMoney(Number(input.agreedAmount));
    if (!Number.isFinite(agreedAmount) || agreedAmount < 0) throw new ValidationError('Le montant convenu doit être positif.');

    const inserted = await db
      .insert(jobSubcontracts)
      .values({
        jobId,
        supplierId: Number(input.supplierId),
        work,
        agreedAmount,
        notes: input.notes?.trim() || null,
        userId: input.userId ?? null,
      })
      .returning({ id: jobSubcontracts.id });
    // Le fournisseur devient (ou reste) un sous-traitant.
    await rawAll('UPDATE suppliers SET is_subcontractor = 1, updated_at = unixepoch() WHERE id = ? AND is_subcontractor = 0', [
      Number(input.supplierId),
    ]);
    const row = (await listJobSubcontracts(jobId)).find((s) => s.id === inserted[0].id);
    if (!row) throw new NotFoundError('Sous-traitance créée mais introuvable');
    return row;
  });
}

export async function updateJobSubcontract(
  jobId: number,
  subcontractId: number,
  patch: { work?: string; agreedAmount?: number; notes?: string | null },
  storeId: number,
): Promise<JobSubcontractRow> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    const current = (await listJobSubcontracts(jobId)).find((s) => s.id === subcontractId);
    if (!current) throw new NotFoundError('Sous-traitance introuvable sur ce chantier');
    if (current.status === 'cancelled') throw new ConflictError('Ces travaux sont annulés.');

    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.work !== undefined) {
      const work = String(patch.work ?? '').trim();
      if (!work) throw new ValidationError('Décrivez les travaux confiés.');
      values.work = work;
    }
    if (patch.agreedAmount !== undefined) {
      const amount = roundMoney(Number(patch.agreedAmount));
      if (!Number.isFinite(amount) || amount < 0) throw new ValidationError('Le montant convenu doit être positif.');
      values.agreedAmount = amount;
    }
    if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;
    await db.update(jobSubcontracts).set(values as any).where(eq(jobSubcontracts.id, subcontractId));
    const row = (await listJobSubcontracts(jobId)).find((s) => s.id === subcontractId);
    if (!row) throw new NotFoundError('Sous-traitance introuvable');
    return row;
  });
}

/**
 * Annule des travaux sous-traités (jamais de suppression). Refusé s'ils ont
 * déjà été payés : il faut d'abord annuler les dépenses de paiement.
 */
export async function cancelJobSubcontract(jobId: number, subcontractId: number, storeId: number): Promise<JobSubcontractRow> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    const current = (await listJobSubcontracts(jobId)).find((s) => s.id === subcontractId);
    if (!current) throw new NotFoundError('Sous-traitance introuvable sur ce chantier');
    if (current.status === 'cancelled') throw new ConflictError('Ces travaux sont déjà annulés.');
    if (current.paid > 0 || current.pending > 0) {
      throw new ConflictError(
        'Des paiements sont rattachés à ces travaux : annulez d’abord ces dépenses depuis la page Dépenses.',
      );
    }
    await db
      .update(jobSubcontracts)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(jobSubcontracts.id, subcontractId));
    const row = (await listJobSubcontracts(jobId)).find((s) => s.id === subcontractId);
    if (!row) throw new NotFoundError('Sous-traitance introuvable');
    return row;
  });
}

/* ------------------------------------------------------------------ *
 * Matériaux — sortie de stock et retour
 * ------------------------------------------------------------------ */

/**
 * Ajoute un matériau au chantier et **déduit le stock** par un mouvement
 * `exit` (`reference_type = 'service_job'`). C'est un **coût** du chantier :
 * il ne change pas le montant facturé au client.
 *
 * Les colonnes `product_name` / `unit` sont **figées** : le chantier doit
 * rester lisible même si le produit est renommé ou désactivé.
 *
 * Ordre des opérations : la ligne est insérée d'abord, puis le mouvement de
 * stock. Si le stock est insuffisant, `InsufficientStockError` remonte du
 * moteur de stock et la transaction annule la ligne.
 */
export async function addJobMaterial(
  jobId: number,
  input: { productId: number; quantity: number; unitCost?: number | null; userId?: number | null; storeId: number },
): Promise<ServiceJobMaterialRow> {
  return withTransaction(() => addJobMaterialInTx(jobId, input));
}

async function addJobMaterialInTx(
  jobId: number,
  input: { productId: number; quantity: number; unitCost?: number | null; userId?: number | null; storeId: number },
): Promise<ServiceJobMaterialRow> {
  const job = await assertJobEditable(jobId, input.storeId);

  const productId = Number(input.productId);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new ValidationError('Le produit est obligatoire');
  }

  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ValidationError('La quantité doit être strictement positive');
  }

  const product = await rawGet<{
    id: number;
    name: string;
    unit: string;
    purchase_price: number | null;
  }>('SELECT id, name, unit, purchase_price FROM products WHERE id = ?', [productId]);

  if (!product) throw new NotFoundError('Produit introuvable');

  const unitCost = roundMoney(
    input.unitCost !== undefined && input.unitCost !== null
      ? Number(input.unitCost) || 0
      : Number(product.purchase_price ?? 0),
  );
  const amount = roundMoney(quantity * unitCost);

  const inserted = await db
    .insert(serviceJobMaterials)
    .values({
      jobId,
      productId,
      productName: product.name,
      unit: product.unit,
      quantity,
      unitCost,
      amount,
    })
    .returning();

  const row = inserted[0];

  // Dans la transaction : si le stock est insuffisant, la ligne est annulée avec.
  await addStockMovement(productId, 'exit', quantity, {
    storeId: input.storeId,
    referenceType: 'service_job',
    referenceId: jobId,
    motif: `chantier ${job.reference} : ${product.name}`,
    userId: input.userId ?? null,
  });

  await recomputeJobTotals(jobId);

  return {
    id: row.id,
    jobId: row.jobId,
    productId: row.productId,
    productName: row.productName,
    unit: row.unit,
    quantity: Number(row.quantity),
    unitCost: Number(row.unitCost),
    amount: Number(row.amount),
    createdAt: row.createdAt,
  };
}

/**
 * Retire une ligne de matériau **et ré-incrémente le stock** (`entry`).
 *
 * Suppression volontaire : corriger une quantité mal saisie doit rendre la
 * matière au magasin. Tracée dans le journal d'audit et le journal de stock.
 */
export async function removeJobMaterial(jobId: number, materialId: number, storeId: number): Promise<ServiceJobRow> {
  return withTransaction(async () => {
    const job = await assertJobEditable(jobId, storeId);

    const rows = await db
      .select()
      .from(serviceJobMaterials)
      .where(eq(serviceJobMaterials.id, materialId))
      .limit(1);

    const material = rows[0];
    if (!material || material.jobId !== jobId) {
      throw new NotFoundError('Ligne de matériau introuvable sur ce chantier');
    }

    await db.delete(serviceJobMaterials).where(eq(serviceJobMaterials.id, materialId));

    if (material.productId) {
      await addStockMovement(material.productId, 'entry', Number(material.quantity), {
        storeId,
        referenceType: 'service_job',
        referenceId: jobId,
        motif: `annulation ligne matériau chantier ${job.reference} : ${material.productName}`,
      });
    }

    return recomputeJobTotals(jobId);
  });
}

/* ------------------------------------------------------------------ *
 * Équipe
 * ------------------------------------------------------------------ */

/** Un ouvrier rattaché à un autre magasin ne travaille pas sur ce chantier. */
async function assertWorkerAvailable(workerId: number, storeId: number) {
  const worker = await rawGet<{ store_id: number | null }>('SELECT store_id FROM workers WHERE id = ?', [workerId]);
  if (worker && worker.store_id != null && Number(worker.store_id) !== Number(storeId)) {
    throw new ValidationError('Cet ouvrier est rattaché à un autre magasin.');
  }
}

/**
 * Affecte un ouvrier : `amount = days × daily_rate`.
 *
 * `worker_name` reste **saisissable** pour un journalier ponctuel qui n'est pas
 * enregistré dans `workers`. Le tarif journalier est pré-rempli depuis la
 * fiche de l'ouvrier quand elle existe, et reste modifiable.
 */
export async function addJobWorker(
  jobId: number,
  input: {
    workerId?: number | null;
    workerName?: string | null;
    role?: string | null;
    days: number;
    dailyRate?: number | null;
  },
  storeId: number,
): Promise<ServiceJobWorkerRow> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);

    const days = Number(input.days);
    if (!Number.isFinite(days) || days <= 0) {
      throw new ValidationError('Le nombre de jours doit être strictement positif');
    }

    let workerId: number | null = null;
    let workerName = (input.workerName ?? '').trim();
    let role = input.role?.trim() || null;
    let dailyRate = input.dailyRate !== undefined && input.dailyRate !== null ? Number(input.dailyRate) : null;

    if (input.workerId) {
      const worker = await rawGet<{
        id: number;
        name: string;
        role: string | null;
        daily_rate: number | null;
      }>('SELECT id, name, role, daily_rate FROM workers WHERE id = ?', [Number(input.workerId)]);

      if (!worker) throw new NotFoundError('Ouvrier introuvable');
      await assertWorkerAvailable(Number(worker.id), storeId);

      workerId = Number(worker.id);
      if (!workerName) workerName = worker.name;
      if (!role) role = worker.role;
      if (dailyRate === null) dailyRate = Number(worker.daily_rate ?? 0);
    }

    if (!workerName) {
      throw new ValidationError('Le nom de l’ouvrier est obligatoire');
    }

    const rate = roundMoney(Number(dailyRate ?? 0) || 0);
    if (rate < 0) throw new ValidationError('Le tarif journalier doit être positif');

    const amount = roundMoney(days * rate);

    const inserted = await db
      .insert(serviceJobWorkers)
      .values({
        jobId,
        workerId,
        workerName,
        role,
        days,
        dailyRate: rate,
        amount,
      })
      .returning();

    const row = inserted[0];

    await recomputeJobTotals(jobId);

    return {
      id: row.id,
      jobId: row.jobId,
      workerId: row.workerId,
      workerName: row.workerName,
      role: row.role,
      days: Number(row.days),
      dailyRate: Number(row.dailyRate),
      amount: Number(row.amount),
      createdAt: row.createdAt,
    };
  });
}

/**
 * « Affecter une équipe » : ajoute d'un coup chaque ouvrier actif de l'équipe
 * (de ce magasin ou commun) pour le même nombre de jours, à son tarif.
 */
export async function addJobTeam(jobId: number, team: string, days: number, storeId: number): Promise<number> {
  return withTransaction(async () => {
    await assertJobEditable(jobId, storeId);
    const name = String(team ?? '').trim();
    if (!name) throw new ValidationError('Choisissez une équipe.');
    const members = await rawAll<{ id: number }>(
      `SELECT id FROM workers WHERE is_active = 1 AND team = ? AND (store_id IS NULL OR store_id = ?) ORDER BY name`,
      [name, storeId],
    );
    if (members.length === 0) throw new ValidationError(`L’équipe « ${name} » n’a aucun ouvrier actif dans ce magasin.`);
    for (const member of members) {
      await addJobWorker(jobId, { workerId: Number(member.id), days }, storeId);
    }
    return members.length;
  });
}

/**
 * Retire une affectation. `workerId` désigne l'**identifiant de la ligne**
 * `service_job_workers`, pas celui de l'ouvrier.
 */
export async function removeJobWorker(jobId: number, workerId: number, storeId: number): Promise<ServiceJobRow> {
  await assertJobEditable(jobId, storeId);

  const rows = await db
    .select()
    .from(serviceJobWorkers)
    .where(eq(serviceJobWorkers.id, workerId))
    .limit(1);

  const assignment = rows[0];
  if (!assignment || assignment.jobId !== jobId) {
    throw new NotFoundError('Affectation introuvable sur ce chantier');
  }

  await db.delete(serviceJobWorkers).where(eq(serviceJobWorkers.id, workerId));

  return recomputeJobTotals(jobId);
}

/* ------------------------------------------------------------------ *
 * Annulation
 * ------------------------------------------------------------------ */

/**
 * Annule un chantier — **jamais de suppression**.
 *
 * Le motif est obligatoire et consigné dans les notes. Les matériaux sortis du
 * stock sont **rendus**. L'annulation est refusée sur un chantier déjà annulé,
 * ce qui garantit que la réversion n'a lieu qu'une fois. Le devis d'origine
 * reste « accepté » : c'est un fait commercial, pas une erreur.
 */
export async function cancelServiceJob(
  id: number,
  reason: string,
  user?: { id?: number | null; name?: string | null; storeId?: number | null } | null,
): Promise<ServiceJobRow> {
  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire');

  return withTransaction(async () => {
    const job = await getServiceJobRow(id);
    if (!job) throw new NotFoundError('Chantier introuvable');
    if (!user?.storeId || job.storeId !== Number(user.storeId)) {
      throw new ValidationError('Ce chantier appartient à un autre magasin : il ne peut être annulé que depuis ce magasin.');
    }
    if (job.status === 'cancelled') {
      throw new ConflictError('Ce chantier est déjà annulé');
    }

    const materials = await listJobMaterials(id);

    for (const material of materials) {
      if (!material.productId) continue;
      await addStockMovement(material.productId, 'entry', material.quantity, {
        storeId: Number(job.storeId),
        referenceType: 'service_job',
        referenceId: id,
        motif: `annulation chantier ${job.reference} : ${material.productName}`,
        userId: user?.id ?? null,
      });
    }

    const stamp = `Annulé le ${today()}${user?.name ? ` par ${user.name}` : ''} — motif : ${motif}`;
    const notes = job.notes ? `${job.notes}\n${stamp}` : stamp;

    await db
      .update(serviceJobs)
      .set({ status: 'cancelled', notes, updatedAt: new Date() })
      .where(eq(serviceJobs.id, id));

    await recomputeDocumentPayments('service_job', id);

    const result = await getServiceJobRow(id);
    if (!result) throw new NotFoundError('Chantier introuvable');
    return result;
  });
}
