/**
 * Ouvriers — **une seule table pour les 3 modules** (README §6.3, §19, §20).
 *
 * `workers` est partagée par les chantiers (`service_job_workers`), la
 * briqueterie (`brick_production_workers`) et l'atelier
 * (`furniture_order_workers`) : le référentiel de main-d'œuvre est saisi une
 * fois, et les affectations portent leurs propres `days` / `daily_rate`.
 *
 * ⚠️ `worker_name` reste saisissable dans les tables de liaison : un
 * **journalier ponctuel** qui n'est pas enregistré ici doit pouvoir être payé
 * (§17 « ouvriers journaliers »). Cette table ne remplace donc pas la saisie
 * libre, elle l'évite quand l'ouvrier est connu.
 *
 * Aucune suppression physique (§7) : un ouvrier se **désactive**
 * (`is_active = false` + tombstone `deleted_at`), sinon ses affectations
 * passées perdraient leur rattachement et la ligne ressusciterait au prochain
 * pull de synchronisation.
 */

import { db, rawAll, rawGet } from '@/db';
import { workers } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueSyncWrite } from '@/lib/sync';
import { NotFoundError, ValidationError } from '@/lib/api';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export const WORKER_ROLES = ['foreman', 'worker', 'apprentice'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export function isWorkerRole(value: unknown): value is WorkerRole {
  return typeof value === 'string' && (WORKER_ROLES as readonly string[]).includes(value);
}

/** Une ligne de `workers`, enrichie de ses agrégats **calculés**. */
export type WorkerRow = {
  id: number;
  name: string;
  phone: string | null;
  role: WorkerRole;
  specialty: string | null;
  dailyRate: number;
  isActive: boolean;
  /** Nombre d'affectations (chantiers + fabrications), calculé. */
  assignmentCount: number;
  /** Jours cumulés, calculés — jamais stockés. */
  totalDays: number;
  /** Coût de main-d'œuvre cumulé, calculé — jamais stocké. */
  totalLaborCost: number;
  createdAt: Date | null;
};

export type WorkerInput = {
  name: string;
  phone?: string | null;
  role?: WorkerRole;
  specialty?: string | null;
  dailyRate?: number;
  isActive?: boolean;
};

export type WorkerListOptions = {
  search?: string;
  role?: string;
  includeInactive?: boolean;
  page?: number;
  limit?: number;
};

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

type WorkerSqlRow = {
  id: number;
  name: string;
  phone: string | null;
  role: string;
  specialty: string | null;
  daily_rate: number | null;
  is_active: number;
  assignment_count: number | null;
  total_days: number | null;
  total_labor_cost: number | null;
  created_at: number | null;
};

/**
 * Les agrégats sont calculés **en SQL** : afficher 20 ouvriers ne doit pas
 * charger l'historique complet des chantiers de l'entreprise.
 */
const WORKER_SELECT = `
  SELECT w.id, w.name, w.phone, w.role, w.specialty, w.daily_rate, w.is_active, w.created_at,
         (
           (SELECT COUNT(*) FROM service_job_workers sjw WHERE sjw.worker_id = w.id)
           + (SELECT COUNT(*) FROM brick_production_workers bpw WHERE bpw.worker_id = w.id)
         ) AS assignment_count,
         (
           COALESCE((SELECT SUM(sjw.days) FROM service_job_workers sjw WHERE sjw.worker_id = w.id), 0)
           + COALESCE((SELECT SUM(bpw.days) FROM brick_production_workers bpw WHERE bpw.worker_id = w.id), 0)
         ) AS total_days,
         (
           COALESCE((SELECT SUM(sjw.amount) FROM service_job_workers sjw WHERE sjw.worker_id = w.id), 0)
           + COALESCE((SELECT SUM(bpw.amount) FROM brick_production_workers bpw WHERE bpw.worker_id = w.id), 0)
         ) AS total_labor_cost
  FROM workers w
`;

function mapWorkerRow(row: WorkerSqlRow): WorkerRow {
  return {
    id: Number(row.id),
    name: row.name,
    phone: row.phone,
    role: isWorkerRole(row.role) ? row.role : 'worker',
    specialty: row.specialty,
    dailyRate: Number(row.daily_rate ?? 0),
    isActive: Boolean(row.is_active),
    assignmentCount: Number(row.assignment_count ?? 0),
    totalDays: Number(row.total_days ?? 0),
    totalLaborCost: Number(row.total_labor_cost ?? 0),
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

/** Liste paginée et filtrable du référentiel de main-d'œuvre. */
export async function listWorkers(
  options: WorkerListOptions = {},
): Promise<{ data: WorkerRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (!options.includeInactive) where.push('w.is_active = 1');
  if (isWorkerRole(options.role)) {
    where.push('w.role = ?');
    args.push(options.role);
  }
  if (options.search) {
    where.push('(w.name LIKE ? OR w.phone LIKE ? OR w.specialty LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await rawAll<WorkerSqlRow>(
    `${WORKER_SELECT} ${whereSql} ORDER BY w.name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM workers w ${whereSql}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapWorkerRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/** Un ouvrier, ou `null`. */
export async function getWorker(id: number): Promise<WorkerRow | null> {
  const row = await rawGet<WorkerSqlRow>(`${WORKER_SELECT} WHERE w.id = ?`, [id]);
  return row ? mapWorkerRow(row) : null;
}

/** Recherche rapide pour une modale de sélection d'équipe. */
export async function searchWorkers(term: string, limit = 20): Promise<WorkerRow[]> {
  const { data } = await listWorkers({ search: term, limit });
  return data;
}

/** Ouvriers actifs, pour un `<select>` d'affectation. */
export async function listActiveWorkers(limit = 200): Promise<WorkerRow[]> {
  const { data } = await listWorkers({ limit });
  return data.filter((w) => w.isActive);
}

/* ------------------------------------------------------------------ *
 * Écriture
 * ------------------------------------------------------------------ */

function normalizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new ValidationError('Le nom de l’ouvrier est obligatoire');
  return name;
}

function normalizeRate(value: unknown): number {
  const rate = Number(value ?? 0);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new ValidationError('Le tarif journalier doit être un nombre positif');
  }
  return rate;
}

export async function createWorker(input: WorkerInput): Promise<WorkerRow> {
  const inserted = await db
    .insert(workers)
    .values({
      name: normalizeName(input.name),
      phone: input.phone?.trim() || null,
      role: isWorkerRole(input.role) ? input.role : 'worker',
      specialty: input.specialty?.trim() || null,
      dailyRate: normalizeRate(input.dailyRate),
      isActive: input.isActive ?? true,
    })
    .returning({ id: workers.id, syncId: workers.syncId });

  await enqueueSyncWrite('workers', inserted[0]?.syncId, 'insert', {
    name: normalizeName(input.name),
    phone: input.phone?.trim() || null,
    role: isWorkerRole(input.role) ? input.role : 'worker',
    specialty: input.specialty?.trim() || null,
    daily_rate: normalizeRate(input.dailyRate),
    is_active: input.isActive ?? true,
  });

  const created = await getWorker(inserted[0].id);
  if (!created) throw new NotFoundError('Ouvrier créé mais introuvable');
  return created;
}

export async function updateWorker(id: number, patch: Partial<WorkerInput>): Promise<WorkerRow> {
  const values: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.name !== undefined) values.name = normalizeName(patch.name);
  if (patch.phone !== undefined) values.phone = patch.phone?.trim() || null;
  if (patch.role !== undefined) {
    if (!isWorkerRole(patch.role)) throw new ValidationError('Rôle d’ouvrier invalide');
    values.role = patch.role;
  }
  if (patch.specialty !== undefined) values.specialty = patch.specialty?.trim() || null;
  if (patch.dailyRate !== undefined) values.dailyRate = normalizeRate(patch.dailyRate);
  if (patch.isActive !== undefined) values.isActive = Boolean(patch.isActive);

  const updated = await db
    .update(workers)
    .set(values as any)
    .where(eq(workers.id, id))
    .returning({ id: workers.id, syncId: workers.syncId });

  if (updated.length === 0) throw new NotFoundError('Ouvrier introuvable');

  await enqueueSyncWrite('workers', updated[0].syncId, 'update', values);

  const result = await getWorker(id);
  if (!result) throw new NotFoundError('Ouvrier introuvable après modification');
  return result;
}

/**
 * Désactivation — **jamais** de `DELETE` : les affectations passées doivent
 * rester rattachées à leur ouvrier (§6.6 « Soft-delete »).
 */
export async function deactivateWorker(id: number): Promise<void> {
  const updated = await db
    .update(workers)
    .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(workers.id, id))
    .returning({ syncId: workers.syncId });

  if (updated.length === 0) throw new NotFoundError('Ouvrier introuvable');

  await enqueueSyncWrite('workers', updated[0].syncId, 'delete', {
    deleted_at: new Date().toISOString(),
  });
}

export async function reactivateWorker(id: number): Promise<void> {
  const updated = await db
    .update(workers)
    .set({ isActive: true, deletedAt: null, updatedAt: new Date() })
    .where(eq(workers.id, id))
    .returning({ syncId: workers.syncId });

  if (updated.length === 0) throw new NotFoundError('Ouvrier introuvable');

  await enqueueSyncWrite('workers', updated[0].syncId, 'update', { is_active: true });
}
