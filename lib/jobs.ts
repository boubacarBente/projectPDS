/**
 * Chantiers — prestations de service (README §19).
 *
 * Trois principes structurants, repris tels quels du contrat de conception :
 *
 * 1. **Le devis et le suivi vivent dans la même table** (`service_jobs`) :
 *    `quote_*` porte le devis, `status` l'avancement, `quote_status`
 *    l'acceptation. Il n'y a **pas** de table de devis versionnée (§6.6).
 * 2. La prestation est un **document facturable autonome** : son propre
 *    `reference`, ses propres `payments` (`type = 'service_job'`). Elle ne
 *    génère **jamais** de facture de vente — sinon le chiffre d'affaires serait
 *    compté deux fois (§15).
 * 3. Les coûts et la marge sont **calculés à la lecture**, jamais stockés
 *    (§6.5 règle 6).
 *
 * ⚠️ Aucune suppression physique d'un chantier (§7) : il s'**annule** avec
 * motif. Une ligne de matériau, en revanche, se supprime réellement : c'est la
 * seule façon de corriger une saisie erronée, et l'opération ré-incrémente le
 * stock et part au journal d'audit.
 */

import { db, rawAll, rawGet } from '@/db';
import { asc, eq } from 'drizzle-orm';
import {
  customers,
  serviceJobMaterials,
  serviceJobWorkers,
  serviceJobs,
} from '@/db/schema';
import { enqueueSyncWrite } from '@/lib/sync';
import { addStockMovement } from '@/lib/stock';
import { listPayments, recomputeDocumentPayments, type PaymentRow } from '@/lib/payments';
import { nextDocumentNumber } from '@/lib/settings';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api';
import { roundMoney, today } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types et listes fermées
 * ------------------------------------------------------------------ */

export const JOB_CATEGORIES = ['alucobond', 'staff', 'placo', 'furniture', 'painting'] as const;
export type JobCategory = (typeof JOB_CATEGORIES)[number];

export const JOB_STATUSES = ['quote', 'pending', 'in_progress', 'completed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'refused'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export function isJobCategory(value: unknown): value is JobCategory {
  return typeof value === 'string' && (JOB_CATEGORIES as readonly string[]).includes(value);
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === 'string' && (QUOTE_STATUSES as readonly string[]).includes(value);
}

/** Une ligne de `service_jobs`, enrichie de ses agrégats calculés. */
export type ServiceJobRow = {
  id: number;
  reference: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  category: JobCategory;
  title: string | null;
  siteAddress: string | null;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
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
  notes: string | null;
  materialsCount: number;
  workersCount: number;
  createdAt: Date | null;
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

export type JobCosts = {
  /** Matériaux au **prix d'achat** (README §19). */
  materialsCost: number;
  /** Main-d'œuvre : jours × tarif. */
  laborCost: number;
  totalCost: number;
  /** Montant facturé de la prestation. */
  billed: number;
  margin: number;
  marginPercent: number;
};

export type ServiceJobDetail = {
  job: ServiceJobRow;
  materials: ServiceJobMaterialRow[];
  workers: ServiceJobWorkerRow[];
  payments: PaymentRow[];
  costs: JobCosts;
};

export type ServiceJobInput = {
  customerId: number;
  category?: JobCategory;
  title?: string | null;
  siteAddress?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: JobStatus;
  quoteStatus?: QuoteStatus;
  quoteMaterials?: number;
  quoteLabor?: number;
  notes?: string | null;
  userId?: number | null;
};

export type ServiceJobPatch = Partial<Omit<ServiceJobInput, 'userId'>>;

export type ServiceJobListOptions = {
  search?: string;
  category?: string;
  status?: string;
  quoteStatus?: string;
  customerId?: number;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
};

export type JobsSummary = {
  totalJobs: number;
  byStatus: Record<JobStatus, number>;
  /** Chiffre d'affaires des prestations (hors annulées). */
  billed: number;
  collected: number;
  outstanding: number;
  materialsCost: number;
  laborCost: number;
  totalCost: number;
  margin: number;
  marginPercent: number;
};

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

type JobSqlRow = {
  id: number;
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
  notes: string | null;
  materials_count: number | null;
  workers_count: number | null;
  created_at: number | null;
};

/**
 * Colonnes communes à la liste et à la fiche.
 *
 * La date de période utilisée est `start_date` — la **date métier** du chantier
 * (§6.5 règle 2) — avec repli sur la date de création pour un chantier encore
 * au stade du devis, qui n'a légitimement pas encore de date de début.
 */
const JOB_SELECT = `
  SELECT j.id, j.reference, j.customer_id, c.name AS customer_name, c.phone AS customer_phone,
         j.category, j.title, j.site_address, j.description, j.start_date, j.end_date,
         j.status, j.quote_status, j.quote_materials, j.quote_labor, j.quote_total, j.total,
         j.amount_paid, j.remaining_amount, j.payment_status, j.user_id, u.name AS user_name,
         j.notes, j.created_at,
         (SELECT COUNT(*) FROM service_job_materials m WHERE m.job_id = j.id) AS materials_count,
         (SELECT COUNT(*) FROM service_job_workers w WHERE w.job_id = j.id) AS workers_count
  FROM service_jobs j
  LEFT JOIN customers c ON c.id = j.customer_id
  LEFT JOIN users u ON u.id = j.user_id
`;

function mapJobRow(row: JobSqlRow): ServiceJobRow {
  return {
    id: Number(row.id),
    reference: row.reference,
    customerId: Number(row.customer_id),
    customerName: row.customer_name ?? 'Client supprimé',
    customerPhone: row.customer_phone,
    category: isJobCategory(row.category) ? row.category : 'placo',
    title: row.title,
    siteAddress: row.site_address,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    status: isJobStatus(row.status) ? row.status : 'quote',
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
    notes: row.notes,
    materialsCount: Number(row.materials_count ?? 0),
    workersCount: Number(row.workers_count ?? 0),
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

/** Liste paginée, filtrable par catégorie, statut, statut de devis, client, période. */
export async function listServiceJobs(
  options: ServiceJobListOptions = {},
): Promise<{ data: ServiceJobRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (options.search) {
    where.push(
      '(j.reference LIKE ? OR c.name LIKE ? OR j.title LIKE ? OR j.site_address LIKE ? OR j.description LIKE ?)',
    );
    const like = `%${options.search}%`;
    args.push(like, like, like, like, like);
  }
  if (isJobCategory(options.category)) {
    where.push('j.category = ?');
    args.push(options.category);
  }
  if (isJobStatus(options.status)) {
    where.push('j.status = ?');
    args.push(options.status);
  }
  if (isQuoteStatus(options.quoteStatus)) {
    where.push('j.quote_status = ?');
    args.push(options.quoteStatus);
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

/** Coûts calculés — **jamais stockés** (§19, §6.5 règle 6). */
export function computeJobCosts(job: ServiceJobRow, materials: ServiceJobMaterialRow[], workers: ServiceJobWorkerRow[]): JobCosts {
  const materialsCost = roundMoney(materials.reduce((sum, m) => sum + m.amount, 0));
  const laborCost = roundMoney(workers.reduce((sum, w) => sum + w.amount, 0));
  const totalCost = roundMoney(materialsCost + laborCost);
  const billed = job.status === 'cancelled' ? 0 : roundMoney(job.total);
  const margin = roundMoney(billed - totalCost);

  return {
    materialsCost,
    laborCost,
    totalCost,
    billed,
    margin,
    marginPercent: billed > 0 ? Math.round((margin / billed) * 1000) / 10 : 0,
  };
}

/** Fiche complète : chantier, matériaux, équipe, paiements, coûts. */
export async function getServiceJob(id: number): Promise<ServiceJobDetail | null> {
  const job = await getServiceJobRow(id);
  if (!job) return null;

  const [materials, workers, payments] = await Promise.all([
    listJobMaterials(id),
    listJobWorkers(id),
    listPayments({ type: 'service_job', referenceId: id, limit: 200 }),
  ]);

  return {
    job,
    materials,
    workers,
    payments: payments.data,
    costs: computeJobCosts(job, materials, workers),
  };
}

export async function getJobCosts(jobId: number): Promise<JobCosts> {
  const job = await getServiceJobRow(jobId);
  if (!job) throw new NotFoundError('Chantier introuvable');

  const [materials, workers] = await Promise.all([listJobMaterials(jobId), listJobWorkers(jobId)]);
  return computeJobCosts(job, materials, workers);
}

/* ------------------------------------------------------------------ *
 * Synthèse (cartes de la page /chantiers)
 * ------------------------------------------------------------------ */

/**
 * Synthèse par statut + CA, coût et marge des prestations.
 *
 * Agrégation en JavaScript sur une seule requête : la base locale compte
 * quelques milliers de lignes et cette forme évite de répéter six fois la même
 * clause de période dans six sous-requêtes SQL (source d'erreur d'argument).
 */
export async function getJobsSummary(options: { from?: string; to?: string } = {}): Promise<JobsSummary> {
  const where: string[] = [];
  const args: (string | number)[] = [];

  if (options.from) {
    where.push("COALESCE(j.start_date, date(j.created_at, 'unixepoch')) >= ?");
    args.push(options.from);
  }
  if (options.to) {
    where.push("COALESCE(j.start_date, date(j.created_at, 'unixepoch')) <= ?");
    args.push(options.to);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await rawAll<{
    id: number;
    status: string;
    total: number | null;
    amount_paid: number | null;
    materials_cost: number | null;
    labor_cost: number | null;
  }>(
    `SELECT j.id, j.status, j.total, j.amount_paid,
            COALESCE((SELECT SUM(m.amount) FROM service_job_materials m WHERE m.job_id = j.id), 0) AS materials_cost,
            COALESCE((SELECT SUM(w.amount) FROM service_job_workers w WHERE w.job_id = j.id), 0) AS labor_cost
     FROM service_jobs j
     ${whereSql}`,
    args,
  );

  const byStatus: Record<JobStatus, number> = {
    quote: 0,
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };

  let billed = 0;
  let collected = 0;
  let materialsCost = 0;
  let laborCost = 0;

  for (const row of rows) {
    const status = isJobStatus(row.status) ? row.status : 'quote';
    byStatus[status] += 1;

    if (status === 'cancelled') continue;

    billed += Number(row.total ?? 0);
    collected += Number(row.amount_paid ?? 0);
    materialsCost += Number(row.materials_cost ?? 0);
    laborCost += Number(row.labor_cost ?? 0);
  }

  const totalCost = roundMoney(materialsCost + laborCost);
  const margin = roundMoney(billed - totalCost);

  return {
    totalJobs: rows.length,
    byStatus,
    billed: roundMoney(billed),
    collected: roundMoney(collected),
    outstanding: roundMoney(billed - collected),
    materialsCost: roundMoney(materialsCost),
    laborCost: roundMoney(laborCost),
    totalCost,
    margin,
    marginPercent: billed > 0 ? Math.round((margin / billed) * 1000) / 10 : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Écriture
 * ------------------------------------------------------------------ */

async function assertJobEditable(jobId: number): Promise<ServiceJobRow> {
  const job = await getServiceJobRow(jobId);
  if (!job) throw new NotFoundError('Chantier introuvable');
  if (job.status === 'cancelled') {
    throw new ConflictError('Ce chantier est annulé : il n’accepte plus aucune modification.');
  }
  return job;
}

async function customerExists(customerId: number): Promise<boolean> {
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return rows.length > 0;
}

function cleanDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError('Les dates doivent être au format AAAA-MM-JJ');
  }
  return text;
}

/** Numéro `CHA-2026-000001` puis création du chantier. */
export async function createServiceJob(input: ServiceJobInput): Promise<ServiceJobRow> {
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new ValidationError('Le client du chantier est obligatoire');
  }
  if (!(await customerExists(customerId))) {
    throw new ValidationError('Client introuvable');
  }

  const reference = await nextDocumentNumber('job');

  const quoteMaterials = roundMoney(Number(input.quoteMaterials ?? 0) || 0);
  const quoteLabor = roundMoney(Number(input.quoteLabor ?? 0) || 0);
  const quoteTotal = roundMoney(quoteMaterials + quoteLabor);

  const inserted = await db
    .insert(serviceJobs)
    .values({
      reference,
      customerId,
      category: isJobCategory(input.category) ? input.category : 'placo',
      title: input.title?.trim() || null,
      siteAddress: input.siteAddress?.trim() || null,
      description: input.description?.trim() || null,
      startDate: cleanDate(input.startDate),
      endDate: cleanDate(input.endDate),
      status: isJobStatus(input.status) && input.status !== 'cancelled' ? input.status : 'quote',
      quoteStatus: isQuoteStatus(input.quoteStatus) ? input.quoteStatus : 'draft',
      quoteMaterials,
      quoteLabor,
      quoteTotal,
      total: quoteTotal,
      amountPaid: 0,
      remainingAmount: quoteTotal,
      paymentStatus: 'unpaid',
      userId: input.userId ?? null,
      notes: input.notes?.trim() || null,
    })
    .returning({ id: serviceJobs.id, syncId: serviceJobs.syncId });

  await enqueueSyncWrite('service_jobs', inserted[0]?.syncId, 'insert', {
    reference,
    customer_id: customerId,
    category: input.category ?? 'placo',
    status: 'quote',
    quote_status: input.quoteStatus ?? 'draft',
    quote_materials: quoteMaterials,
    quote_labor: quoteLabor,
    quote_total: quoteTotal,
    total: quoteTotal,
  });

  const created = await getServiceJobRow(inserted[0].id);
  if (!created) throw new NotFoundError('Chantier créé mais introuvable');
  return created;
}

/**
 * Modification du chantier **et du devis**.
 *
 * `quote_materials` et `quote_labor` peuvent être saisis à la main tant que le
 * chantier n'a pas de lignes : c'est l'estimation du devis. Dès qu'une ligne de
 * matériau ou une affectation existe, `recomputeJobTotals()` reprend la main et
 * réaligne le devis sur le réalisé — le devis reste ainsi cohérent avec ce qui
 * a réellement été sorti du stock et payé comme main-d'œuvre.
 */
export async function updateServiceJob(id: number, patch: ServiceJobPatch): Promise<ServiceJobRow> {
  const job = await assertJobEditable(id);

  const values: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.customerId !== undefined) {
    const customerId = Number(patch.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      throw new ValidationError('Le client du chantier est obligatoire');
    }
    if (!(await customerExists(customerId))) throw new ValidationError('Client introuvable');
    values.customerId = customerId;
  }
  if (patch.category !== undefined) {
    if (!isJobCategory(patch.category)) throw new ValidationError('Catégorie de prestation invalide');
    values.category = patch.category;
  }
  if (patch.title !== undefined) values.title = patch.title?.trim() || null;
  if (patch.siteAddress !== undefined) values.siteAddress = patch.siteAddress?.trim() || null;
  if (patch.description !== undefined) values.description = patch.description?.trim() || null;
  if (patch.startDate !== undefined) values.startDate = cleanDate(patch.startDate);
  if (patch.endDate !== undefined) values.endDate = cleanDate(patch.endDate);
  if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;

  if (patch.quoteStatus !== undefined) {
    if (!isQuoteStatus(patch.quoteStatus)) throw new ValidationError('Statut de devis invalide');
    values.quoteStatus = patch.quoteStatus;
  }

  if (patch.status !== undefined) {
    if (!isJobStatus(patch.status)) throw new ValidationError('Statut de chantier invalide');
    if (patch.status === 'cancelled') {
      throw new ValidationError(
        'L’annulation d’un chantier passe par un motif obligatoire (route d’annulation).',
      );
    }
    values.status = patch.status;
  }

  let totalsChanged = false;
  if (patch.quoteMaterials !== undefined || patch.quoteLabor !== undefined) {
    const quoteMaterials = roundMoney(
      patch.quoteMaterials !== undefined ? Number(patch.quoteMaterials) || 0 : job.quoteMaterials,
    );
    const quoteLabor = roundMoney(
      patch.quoteLabor !== undefined ? Number(patch.quoteLabor) || 0 : job.quoteLabor,
    );
    const quoteTotal = roundMoney(quoteMaterials + quoteLabor);

    values.quoteMaterials = quoteMaterials;
    values.quoteLabor = quoteLabor;
    values.quoteTotal = quoteTotal;
    values.total = quoteTotal;
    totalsChanged = true;
  }

  const updated = await db
    .update(serviceJobs)
    .set(values as any)
    .where(eq(serviceJobs.id, id))
    .returning({ id: serviceJobs.id, syncId: serviceJobs.syncId });

  if (updated.length === 0) throw new NotFoundError('Chantier introuvable');

  await enqueueSyncWrite('service_jobs', updated[0].syncId, 'update', values);

  // Le total a bougé : le reste à payer et le statut de paiement suivent,
  // recalculés depuis les paiements réels (§7).
  if (totalsChanged) await recomputeDocumentPayments('service_job', id);

  const result = await getServiceJobRow(id);
  if (!result) throw new NotFoundError('Chantier introuvable après modification');
  return result;
}

/**
 * Statut du devis. Un devis **accepté** fait passer un chantier encore au stade
 * « devis » en « en attente » : c'est exactement la raison d'être de l'état
 * `pending`, et cela évite un chantier accepté qui resterait affiché comme un
 * simple devis.
 */
export async function updateQuoteStatus(id: number, quoteStatus: QuoteStatus): Promise<ServiceJobRow> {
  if (!isQuoteStatus(quoteStatus)) throw new ValidationError('Statut de devis invalide');

  const job = await assertJobEditable(id);

  const values: Record<string, unknown> = { quoteStatus, updatedAt: new Date() };
  if (quoteStatus === 'accepted' && job.status === 'quote') values.status = 'pending';

  const updated = await db
    .update(serviceJobs)
    .set(values as any)
    .where(eq(serviceJobs.id, id))
    .returning({ id: serviceJobs.id, syncId: serviceJobs.syncId });

  if (updated.length === 0) throw new NotFoundError('Chantier introuvable');

  await enqueueSyncWrite('service_jobs', updated[0].syncId, 'update', values);

  const result = await getServiceJobRow(id);
  if (!result) throw new NotFoundError('Chantier introuvable après modification');
  return result;
}

/** Avancement du chantier. « Terminé » renseigne la date de fin si elle manque. */
export async function updateStatus(id: number, status: JobStatus): Promise<ServiceJobRow> {
  if (!isJobStatus(status)) throw new ValidationError('Statut de chantier invalide');
  if (status === 'cancelled') {
    throw new ValidationError(
      'L’annulation d’un chantier passe par un motif obligatoire (route d’annulation).',
    );
  }

  const job = await assertJobEditable(id);

  const values: Record<string, unknown> = { status, updatedAt: new Date() };
  if (status === 'completed' && !job.endDate) values.endDate = today();

  const updated = await db
    .update(serviceJobs)
    .set(values as any)
    .where(eq(serviceJobs.id, id))
    .returning({ id: serviceJobs.id, syncId: serviceJobs.syncId });

  if (updated.length === 0) throw new NotFoundError('Chantier introuvable');

  await enqueueSyncWrite('service_jobs', updated[0].syncId, 'update', values);

  const result = await getServiceJobRow(id);
  if (!result) throw new NotFoundError('Chantier introuvable après modification');
  return result;
}

/**
 * Réaligne `quote_materials` / `quote_labor` / `quote_total` / `total` sur les
 * lignes réellement enregistrées, puis resynchronise le reste à payer.
 *
 * Appelée après **chaque** ajout ou retrait de matériau / d'ouvrier : le devis
 * et la facturation ne peuvent donc pas diverger du réalisé.
 */
export async function recomputeJobTotals(jobId: number): Promise<ServiceJobRow> {
  const job = await getServiceJobRow(jobId);
  if (!job) throw new NotFoundError('Chantier introuvable');

  const materials = await rawGet<{ total: number | null }>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM service_job_materials WHERE job_id = ?',
    [jobId],
  );
  const workers = await rawGet<{ total: number | null }>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM service_job_workers WHERE job_id = ?',
    [jobId],
  );

  const quoteMaterials = roundMoney(Number(materials?.total ?? 0));
  const quoteLabor = roundMoney(Number(workers?.total ?? 0));
  const quoteTotal = roundMoney(quoteMaterials + quoteLabor);

  await db
    .update(serviceJobs)
    .set({
      quoteMaterials,
      quoteLabor,
      quoteTotal,
      total: quoteTotal,
      updatedAt: new Date(),
    })
    .where(eq(serviceJobs.id, jobId));

  await enqueueSyncWrite('service_jobs', null, 'update', {
    reference: job.reference,
    quote_materials: quoteMaterials,
    quote_labor: quoteLabor,
    quote_total: quoteTotal,
    total: quoteTotal,
  });

  await recomputeDocumentPayments('service_job', jobId);

  const refreshed = await getServiceJobRow(jobId);
  if (!refreshed) throw new NotFoundError('Chantier introuvable');
  return refreshed;
}

/* ------------------------------------------------------------------ *
 * Matériaux — sortie de stock et retour
 * ------------------------------------------------------------------ */

/**
 * Ajoute un matériau au chantier et **déduit le stock** par un mouvement
 * `exit` (`reference_type = 'service_job'`, §19 « matériaux déduits du stock »).
 *
 * Les colonnes `product_name` / `unit` sont **figées** :
 * le chantier doit rester imprimable même si le produit est renommé ou
 * désactivé (§6.5 règle 6).
 *
 * Ordre des opérations : la ligne est insérée d'abord, puis le mouvement de
 * stock. Si le stock est insuffisant, `InsufficientStockError` remonte du
 * moteur de stock et la ligne est **retirée** — jamais de ligne fantôme, jamais
 * de sortie de stock sans trace.
 */
export async function addJobMaterial(
  jobId: number,
  input: { productId: number; quantity: number; unitCost?: number | null; userId?: number | null },
): Promise<ServiceJobMaterialRow> {
  const job = await assertJobEditable(jobId);

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

  try {
    await addStockMovement(productId, 'exit', quantity, {
      referenceType: 'service_job',
      referenceId: jobId,
      motif: `chantier ${job.reference} : ${product.name}`,
      userId: input.userId ?? null,
    });
  } catch (error) {
    // Compensation : la ligne ne doit pas survivre à une sortie de stock refusée.
    await db.delete(serviceJobMaterials).where(eq(serviceJobMaterials.id, row.id));
    throw error;
  }

  await enqueueSyncWrite('service_job_materials', row.syncId, 'insert', {
    job_reference: job.reference,
    product_id: productId,
    product_name: product.name,
    unit: product.unit,
    quantity,
    unit_cost: unitCost,
    amount,
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
 * C'est la seule suppression physique du module, et elle est volontaire :
 * corriger une quantité mal saisie doit rendre la matière au magasin. Le stock
 * ne peut donc jamais « dériver » à cause d'une erreur de frappe. L'opération
 * est tracée dans le journal d'audit et dans le journal de stock (motif
 * explicite).
 */
export async function removeJobMaterial(jobId: number, materialId: number): Promise<ServiceJobRow> {
  const job = await assertJobEditable(jobId);

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
      referenceType: 'service_job',
      referenceId: jobId,
      motif: `annulation ligne matériau chantier ${job.reference} : ${material.productName}`,
    });
  }

  await enqueueSyncWrite('service_job_materials', material.syncId, 'delete', {
    job_reference: job.reference,
    product_name: material.productName,
    quantity: Number(material.quantity),
    deleted_at: new Date().toISOString(),
  });

  return recomputeJobTotals(jobId);
}

/* ------------------------------------------------------------------ *
 * Équipe
 * ------------------------------------------------------------------ */

/**
 * Affecte un ouvrier : `amount = days × daily_rate`.
 *
 * `worker_name` reste **saisissable** pour un journalier ponctuel qui n'est pas
 * enregistré dans `workers` (§17). Le tarif journalier est pré-rempli depuis la
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
): Promise<ServiceJobWorkerRow> {
  const job = await assertJobEditable(jobId);

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

  await enqueueSyncWrite('service_job_workers', row.syncId, 'insert', {
    job_reference: job.reference,
    worker_id: workerId,
    worker_name: workerName,
    role,
    days,
    daily_rate: rate,
    amount,
  });

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
}

/**
 * Retire une affectation.
 *
 * `workerId` désigne l'**identifiant de la ligne** `service_job_workers`, pas
 * celui de l'ouvrier : un journalier ponctuel n'a pas de `worker_id`, et un
 * même ouvrier peut intervenir deux fois (deux rôles, deux périodes).
 */
export async function removeJobWorker(jobId: number, workerId: number): Promise<ServiceJobRow> {
  await assertJobEditable(jobId);

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

  await enqueueSyncWrite('service_job_workers', assignment.syncId, 'delete', {
    worker_name: assignment.workerName,
    days: Number(assignment.days),
    deleted_at: new Date().toISOString(),
  });

  return recomputeJobTotals(jobId);
}

/* ------------------------------------------------------------------ *
 * Annulation
 * ------------------------------------------------------------------ */

/**
 * Annule un chantier — **jamais de suppression** (§7).
 *
 * Le motif est obligatoire et consigné dans les notes (la table `service_jobs`
 * n'a pas de colonne `cancel_reason` : le schéma cible du README §6.3 est
 * respecté tel quel). Les matériaux sortis du stock sont **rendus** : un
 * document annulé se réverse, comme une facture (§6.5 règle 4). L'annulation
 * est refusée sur un chantier déjà annulé, ce qui garantit que la réversion
 * n'a lieu qu'une fois.
 */
export async function cancelServiceJob(
  id: number,
  reason: string,
  user?: { id?: number | null; name?: string | null } | null,
): Promise<ServiceJobRow> {
  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire');

  const job = await getServiceJobRow(id);
  if (!job) throw new NotFoundError('Chantier introuvable');
  if (job.status === 'cancelled') {
    throw new ConflictError('Ce chantier est déjà annulé');
  }

  const materials = await listJobMaterials(id);

  for (const material of materials) {
    if (!material.productId) continue;
    await addStockMovement(material.productId, 'entry', material.quantity, {
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

  await enqueueSyncWrite('service_jobs', null, 'update', {
    reference: job.reference,
    status: 'cancelled',
    cancel_reason: motif,
  });

  await recomputeDocumentPayments('service_job', id);

  const result = await getServiceJobRow(id);
  if (!result) throw new NotFoundError('Chantier introuvable');
  return result;
}
