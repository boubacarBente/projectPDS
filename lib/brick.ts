/**
 * Briqueterie — fabrication des briques, par magasin (README §30).
 *
 * Retirée en v2, rétablie le 7 octobre 2026 à la demande du client. On reprend
 * la v1.4 (§20 : pas de module de matières premières, les intrants sont des
 * **dépenses rattachées au lot**) aux règles de la v2 :
 *
 * 1. **Tout appartient à un magasin** : types de briques, lots, équipe. Écriture
 *    dans le magasin actif seulement ; un lot d'un autre magasin se lit
 *    (`assertStoreVisible`) mais ne se modifie pas.
 * 2. Le **produit lié** à un type porte le prix de vente et le stock ; le stock
 *    du magasin ne bouge que par `addStockMovement` (jamais négatif).
 * 3. **Aucun coût stocké** : coût du lot = équipe (`jours × tarif`) + dépenses
 *    rattachées **validées** (`expenses.reference_type = 'brick_production'`,
 *    approuvées ou à décaisser). ⚠️ La v1 recopiait ces sommes dans
 *    `material_cost` / `labor_cost` / `expense_cost` / `total_cost`, recalculées
 *    à chaque écriture — et une dépense approuvée plus tard dans `/depenses`
 *    ne mettait pas le lot à jour. Coût unitaire = coût ÷ (produites − cassées).
 * 4. Une dépense de production suit **le circuit normal des dépenses** (seuil
 *    d'approbation, décaissement, annulation motivée) : en v1 elle sortait de
 *    la caisse sans approbation.
 * 5. **Mise en stock unique** à l'étape `stored` (transitions strictement
 *    croissantes + aucune entrée existante au journal) ; les cassées connues à
 *    cet instant sortent par un `exit` motivé.
 * 6. Annulation = statut `cancelled` + motif + auteur + date ; le solde net du
 *    lot en stock est repris (refusé si les briques ont déjà été vendues au
 *    point de rendre le stock négatif).
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { eq } from 'drizzle-orm';
import { brickProductionWorkers, brickProductions, brickTypes } from '@/db/schema';
import { addStockMovement } from '@/lib/stock';
import { nextDocumentNumber } from '@/lib/settings';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api';
import { roundMoney, today } from '@/lib/format';
import { cancelExpense, createExpense, getExpense, updateExpense } from '@/lib/expenses';
import { scopeSql, type StoreScope } from '@/lib/stores';

/* ------------------------------------------------------------------ *
 * Listes fermées
 * ------------------------------------------------------------------ */

export const PRODUCTION_EXPENSE_REFERENCE = 'brick_production';

export const BRICK_SHAPES = ['solid', 'hollow', 'block'] as const;
export type BrickShape = (typeof BRICK_SHAPES)[number];

export const BRICK_STAGES = ['molding', 'drying', 'firing', 'stored'] as const;
export type BrickStage = (typeof BRICK_STAGES)[number];

export const BRICK_STAGE_LABELS: Record<BrickStage, string> = {
  molding: 'Moulage',
  drying: 'Séchage',
  firing: 'Cuisson',
  stored: 'En stock',
};

export const BRICK_PRODUCTION_STATUSES = ['registered', 'finished', 'cancelled'] as const;
export type BrickProductionStatus = (typeof BRICK_PRODUCTION_STATUSES)[number];

export function isBrickShape(value: unknown): value is BrickShape {
  return typeof value === 'string' && (BRICK_SHAPES as readonly string[]).includes(value);
}

export function isBrickStage(value: unknown): value is BrickStage {
  return typeof value === 'string' && (BRICK_STAGES as readonly string[]).includes(value);
}

export function isBrickProductionStatus(value: unknown): value is BrickProductionStatus {
  return typeof value === 'string' && (BRICK_PRODUCTION_STATUSES as readonly string[]).includes(value);
}

/** Date métier d'un lot : `start_date`, avec repli sur la date de création. */
export const PRODUCTION_DATE = "COALESCE(p.start_date, date(p.created_at, 'unixepoch'))";

/** Main-d'œuvre d'un lot `p` (SQL). */
export const LABOR_COST_SQL = `(SELECT COALESCE(SUM(w.amount), 0) FROM brick_production_workers w WHERE w.production_id = p.id)`;

/**
 * Dépenses rattachées **validées** d'un lot `p` (SQL) : approuvées ou à
 * décaisser, non annulées — même règle que le coût d'un chantier.
 */
export const EXPENSE_COST_SQL = `(SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
   WHERE e.reference_type = 'brick_production' AND e.reference_id = p.id
     AND e.deleted_at IS NULL AND e.approval_status IN ('approved', 'to_pay'))`;

/** Coût total d'un lot `p` (SQL), jamais stocké. */
export const TOTAL_COST_SQL = `(${LABOR_COST_SQL} + ${EXPENSE_COST_SQL})`;

/* ------------------------------------------------------------------ *
 * Types publics (formes de l'API, inchangées depuis la v1 + magasin)
 * ------------------------------------------------------------------ */

export type BrickTypeRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  productId: number;
  name: string;
  shape: BrickShape;
  dimensions: string | null;
  description: string | null;
  isActive: boolean;
  productName: string;
  unit: string;
  salePrice: number;
  purchasePrice: number;
  /** Stock du produit **dans le magasin du type**. */
  stock: number;
  productionsCount: number;
  createdAt: Date | null;
};

export type BrickTypeInput = {
  productId: number;
  name: string;
  shape?: BrickShape;
  dimensions?: string | null;
  description?: string | null;
  isActive?: boolean;
};

export type BrickProductionRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  batchNumber: string;
  brickTypeId: number;
  brickTypeName: string;
  shape: BrickShape;
  dimensions: string | null;
  productId: number;
  productName: string;
  productUnit: string;
  plannedQuantity: number;
  producedQuantity: number;
  brokenQuantity: number;
  startDate: string | null;
  endDate: string | null;
  stage: BrickStage;
  status: BrickProductionStatus;
  team: string | null;
  /** Toujours 0 : plus de module matières (§20) ; conservé pour l'interface. */
  materialCost: number;
  laborCost: number;
  expenseCost: number;
  totalCost: number;
  unitCost: number;
  /** Vrai si le stock de briques finies a déjà été crédité. */
  stored: boolean;
  materialsCount: number;
  workersCount: number;
  expensesCount: number;
  userId: number | null;
  userName: string | null;
  notes: string | null;
  isCancelled: boolean;
  cancelReason: string | null;
  cancelledAt: Date | null;
  cancelledByName: string | null;
  createdAt: Date | null;
};

export type BrickProductionWorkerRow = {
  id: number;
  productionId: number;
  workerId: number | null;
  workerName: string;
  role: string | null;
  days: number;
  dailyRate: number;
  amount: number;
  createdAt: Date | null;
};

export type ProductionCosts = {
  materialCost: number;
  laborCost: number;
  expenseCost: number;
  totalCost: number;
  producedQuantity: number;
  brokenQuantity: number;
  goodQuantity: number;
  unitCost: number;
};

export type BrickProductionExpenseRow = {
  id: number;
  productionId: number;
  category: string;
  description: string | null;
  amount: number;
  paymentMethod: string;
  beneficiary: string | null;
  date: string;
  userId: number | null;
  userName: string | null;
  /** approved | to_pay | pending | rejected : seules les deux premières comptent. */
  approvalStatus: string;
  cancelled: boolean;
  createdAt: Date | null;
};

export type BrickProductionExpenseInput = {
  category: string;
  amount: number;
  description?: string | null;
  paymentMethod?: string;
  beneficiary?: string | null;
  date: string;
  userId?: number | null;
  canSkipApproval?: boolean;
};

export type BrickProductionDetail = {
  production: BrickProductionRow;
  brickType: BrickTypeRow | null;
  product: { id: number; name: string; unit: string; stock: number; salePrice: number } | null;
  /** Toujours vide (plus de module matières) ; conservé pour l'interface. */
  materials: never[];
  workers: BrickProductionWorkerRow[];
  expenses: BrickProductionExpenseRow[];
  costs: ProductionCosts;
};

export type BrickProductionInput = {
  brickTypeId: number;
  plannedQuantity: number;
  producedQuantity?: number;
  brokenQuantity?: number;
  startDate?: string | null;
  endDate?: string | null;
  team?: string | null;
  notes?: string | null;
  userId?: number | null;
};

export type BrickProductionPatch = {
  plannedQuantity?: number;
  producedQuantity?: number;
  brokenQuantity?: number;
  startDate?: string | null;
  endDate?: string | null;
  team?: string | null;
  notes?: string | null;
};

export type BrickProductionListOptions = {
  scope: StoreScope;
  search?: string;
  brickTypeId?: number;
  stage?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
};

export type BrickSummary = {
  from: string | null;
  to: string | null;
  productionsCount: number;
  produced: number;
  broken: number;
  good: number;
  sold: number;
  soldRevenue: number;
  materialsCost: number;
  laborCost: number;
  expensesCost: number;
  totalCost: number;
  averageUnitCost: number;
  byType: { brickTypeId: number; brickTypeName: string; produced: number; broken: number; sold: number; unitCost: number }[];
};

/* ------------------------------------------------------------------ *
 * Utilitaires
 * ------------------------------------------------------------------ */

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toDate(value: unknown): Date | null {
  return value ? new Date(num(value) * 1000) : null;
}

function cleanDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ValidationError('Les dates doivent être au format AAAA-MM-JJ');
  return text;
}

function unitCostOf(totalCost: number, good: number): number {
  return good > 0 ? Math.round((totalCost / good) * 100) / 100 : 0;
}

/* ------------------------------------------------------------------ *
 * Types de briques
 * ------------------------------------------------------------------ */

const BRICK_TYPE_SELECT = `
  SELECT bt.id, bt.store_id, s.name AS store_name, bt.product_id, bt.name, bt.shape, bt.dimensions,
         bt.description, bt.is_active, bt.created_at,
         p.name AS product_name, p.unit AS product_unit, p.sale_price, p.purchase_price,
         COALESCE((SELECT ps.quantity FROM product_stocks ps WHERE ps.product_id = bt.product_id AND ps.store_id = bt.store_id), 0) AS stock,
         (SELECT COUNT(*) FROM brick_productions bp WHERE bp.brick_type_id = bt.id AND bp.status <> 'cancelled') AS productions_count
  FROM brick_types bt
  INNER JOIN products p ON p.id = bt.product_id
  LEFT JOIN stores s ON s.id = bt.store_id`;

function mapBrickTypeRow(row: any): BrickTypeRow {
  return {
    id: num(row.id),
    storeId: num(row.store_id),
    storeName: row.store_name ?? null,
    productId: num(row.product_id),
    name: row.name,
    shape: isBrickShape(row.shape) ? row.shape : 'solid',
    dimensions: row.dimensions ?? null,
    description: row.description ?? null,
    isActive: Boolean(row.is_active),
    productName: row.product_name,
    unit: row.product_unit,
    salePrice: num(row.sale_price),
    purchasePrice: num(row.purchase_price),
    stock: num(row.stock),
    productionsCount: num(row.productions_count),
    createdAt: toDate(row.created_at),
  };
}

export async function listBrickTypes(options: {
  scope: StoreScope;
  includeInactive?: boolean;
  sort?: 'recent' | 'name';
}): Promise<BrickTypeRow[]> {
  const where = [scopeSql('bt.store_id', options.scope)];
  if (!options.includeInactive) where.push('bt.is_active = 1');
  const orderBy = options.sort === 'name' ? 'bt.name COLLATE NOCASE, bt.id' : 'bt.created_at DESC, bt.id DESC';
  const rows = await rawAll<any>(`${BRICK_TYPE_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`);
  return rows.map(mapBrickTypeRow);
}

export async function getBrickType(id: number): Promise<BrickTypeRow | null> {
  const row = await rawGet<any>(`${BRICK_TYPE_SELECT} WHERE bt.id = ?`, [id]);
  return row ? mapBrickTypeRow(row) : null;
}

/** Le type doit exister et appartenir au magasin actif. */
export async function assertBrickTypeInStore(id: number, storeId: number): Promise<BrickTypeRow> {
  const type = await getBrickType(id);
  if (!type) throw new NotFoundError('Type de brique introuvable');
  if (type.storeId !== Number(storeId)) {
    throw new ValidationError(
      `Le type « ${type.name} » appartient au magasin ${type.storeName ?? 'd’un autre magasin'} : il ne s’utilise que depuis ce magasin.`,
    );
  }
  return type;
}

/** Le produit lié doit exister et ne pas porter déjà un autre type actif du magasin. */
async function validateLinkedProduct(productId: number, storeId: number, exceptTypeId?: number): Promise<void> {
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new ValidationError('Le produit lié au type de brique est obligatoire');
  }
  const product = await rawGet<{ id: number }>('SELECT id FROM products WHERE id = ?', [productId]);
  if (!product) throw new NotFoundError('Produit introuvable');
  const other = await rawGet<{ name: string }>(
    `SELECT name FROM brick_types WHERE product_id = ? AND store_id = ? AND is_active = 1 AND id <> ? LIMIT 1`,
    [productId, storeId, exceptTypeId ?? 0],
  );
  if (other) {
    throw new ValidationError(`Ce produit porte déjà le type « ${other.name} » : un produit = un type de brique (il en porte le stock).`);
  }
}

export async function createBrickType(
  input: BrickTypeInput & { storeId: number; userId?: number | null },
): Promise<BrickTypeRow> {
  const productId = Number(input.productId);
  const name = (input.name ?? '').trim();
  if (!name) throw new ValidationError('Le nom du type de brique est obligatoire');
  await validateLinkedProduct(productId, input.storeId);

  const inserted = await db
    .insert(brickTypes)
    .values({
      storeId: input.storeId,
      productId,
      name,
      shape: isBrickShape(input.shape) ? input.shape : 'solid',
      dimensions: input.dimensions?.trim() || null,
      description: input.description?.trim() || null,
      isActive: input.isActive ?? true,
      userId: input.userId ?? null,
    })
    .returning({ id: brickTypes.id });
  const created = await getBrickType(inserted[0].id);
  if (!created) throw new NotFoundError('Type de brique créé mais introuvable');
  return created;
}

export async function updateBrickType(id: number, patch: Partial<BrickTypeInput>, storeId: number): Promise<BrickTypeRow> {
  const type = await assertBrickTypeInStore(id, storeId);
  const values: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.productId !== undefined && Number(patch.productId) !== type.productId) {
    // Changer le produit d'un type déjà fabriqué ferait « perdre » son stock.
    if (type.productionsCount > 0) {
      throw new ConflictError('Ce type a déjà des lots : son produit (qui porte le stock) ne se change plus.');
    }
    await validateLinkedProduct(Number(patch.productId), storeId, id);
    values.productId = Number(patch.productId);
  }
  if (patch.name !== undefined) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw new ValidationError('Le nom du type de brique est obligatoire');
    values.name = name;
  }
  if (patch.shape !== undefined) {
    if (!isBrickShape(patch.shape)) throw new ValidationError('Forme de brique invalide');
    values.shape = patch.shape;
  }
  if (patch.dimensions !== undefined) values.dimensions = patch.dimensions?.trim() || null;
  if (patch.description !== undefined) values.description = patch.description?.trim() || null;
  if (patch.isActive !== undefined) {
    if (patch.isActive) await validateLinkedProduct(type.productId, storeId, id);
    values.isActive = Boolean(patch.isActive);
  }

  await db.update(brickTypes).set(values as any).where(eq(brickTypes.id, id));
  const result = await getBrickType(id);
  if (!result) throw new NotFoundError('Type de brique introuvable');
  return result;
}

/** Désactivation / réactivation — jamais de suppression. */
export async function setBrickTypeActive(id: number, isActive: boolean, storeId: number): Promise<BrickTypeRow> {
  return updateBrickType(id, { isActive }, storeId);
}

/* ------------------------------------------------------------------ *
 * Lots de fabrication — lecture
 * ------------------------------------------------------------------ */

const PRODUCTION_SELECT = `
  SELECT p.id, p.store_id, s.name AS store_name, p.batch_number, p.brick_type_id,
         bt.name AS brick_type_name, bt.shape, bt.dimensions,
         bt.product_id, pr.name AS product_name, pr.unit AS product_unit,
         p.planned_quantity, p.produced_quantity, p.broken_quantity,
         p.start_date, p.end_date, p.stage, p.status, p.team,
         p.cancel_reason, p.cancelled_at, cu.name AS cancelled_by_name,
         p.user_id, u.name AS user_name, p.notes, p.created_at,
         ${LABOR_COST_SQL} AS labor_cost,
         ${EXPENSE_COST_SQL} AS expense_cost,
         (SELECT COUNT(*) FROM brick_production_workers w WHERE w.production_id = p.id) AS workers_count,
         (SELECT COUNT(*) FROM expenses e
           WHERE e.reference_type = 'brick_production' AND e.reference_id = p.id AND e.deleted_at IS NULL) AS expenses_count,
         (SELECT COUNT(*) FROM stock_movements sm
           WHERE sm.reference_type = 'brick_production' AND sm.reference_id = p.id AND sm.type = 'entry') AS stored_count
  FROM brick_productions p
  INNER JOIN brick_types bt ON bt.id = p.brick_type_id
  INNER JOIN products pr ON pr.id = bt.product_id
  LEFT JOIN stores s ON s.id = p.store_id
  LEFT JOIN users u ON u.id = p.user_id
  LEFT JOIN users cu ON cu.id = p.cancelled_by`;

function mapProductionRow(row: any): BrickProductionRow {
  const produced = num(row.produced_quantity);
  const broken = num(row.broken_quantity);
  const laborCost = roundMoney(num(row.labor_cost));
  const expenseCost = roundMoney(num(row.expense_cost));
  const totalCost = roundMoney(laborCost + expenseCost);
  const isCancelled = row.status === 'cancelled';
  return {
    id: num(row.id),
    storeId: num(row.store_id),
    storeName: row.store_name ?? null,
    batchNumber: row.batch_number,
    brickTypeId: num(row.brick_type_id),
    brickTypeName: row.brick_type_name,
    shape: isBrickShape(row.shape) ? row.shape : 'solid',
    dimensions: row.dimensions ?? null,
    productId: num(row.product_id),
    productName: row.product_name,
    productUnit: row.product_unit,
    plannedQuantity: num(row.planned_quantity),
    producedQuantity: produced,
    brokenQuantity: broken,
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null,
    stage: isBrickStage(row.stage) ? row.stage : 'molding',
    status: isBrickProductionStatus(row.status) ? row.status : 'registered',
    team: row.team ?? null,
    materialCost: 0,
    laborCost,
    expenseCost,
    totalCost,
    unitCost: unitCostOf(totalCost, roundMoney(produced - broken)),
    stored: num(row.stored_count) > 0,
    materialsCount: 0,
    workersCount: num(row.workers_count),
    expensesCount: num(row.expenses_count),
    userId: row.user_id == null ? null : num(row.user_id),
    userName: row.user_name ?? null,
    notes: row.notes ?? null,
    isCancelled,
    cancelReason: row.cancel_reason ?? null,
    cancelledAt: toDate(row.cancelled_at),
    cancelledByName: row.cancelled_by_name ?? null,
    createdAt: toDate(row.created_at),
  };
}

export async function listBrickProductions(
  options: BrickProductionListOptions,
): Promise<{ data: BrickProductionRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const where: string[] = [scopeSql('p.store_id', options.scope)];
  const args: (string | number)[] = [];

  // Par défaut un lot annulé sort des listes ; le filtre « Annulée » les montre.
  if (isBrickProductionStatus(options.status)) {
    where.push('p.status = ?');
    args.push(options.status);
  } else {
    where.push(`p.status <> 'cancelled'`);
  }
  if (options.search) {
    where.push('(p.batch_number LIKE ? OR bt.name LIKE ? OR p.notes LIKE ? OR p.team LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like, like);
  }
  if (options.brickTypeId) {
    where.push('p.brick_type_id = ?');
    args.push(options.brickTypeId);
  }
  if (isBrickStage(options.stage)) {
    where.push('p.stage = ?');
    args.push(options.stage);
  }
  if (options.from) {
    where.push(`${PRODUCTION_DATE} >= ?`);
    args.push(options.from);
  }
  if (options.to) {
    where.push(`${PRODUCTION_DATE} <= ?`);
    args.push(options.to);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = await rawAll<any>(
    `${PRODUCTION_SELECT} ${whereSql} ORDER BY ${PRODUCTION_DATE} DESC, p.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, (page - 1) * limit],
  );
  const count = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM brick_productions p INNER JOIN brick_types bt ON bt.id = p.brick_type_id ${whereSql}`,
    args,
  );
  const total = num(count?.total);
  return { data: rows.map(mapProductionRow), total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

export async function getBrickProductionRow(id: number): Promise<BrickProductionRow | null> {
  const row = await rawGet<any>(`${PRODUCTION_SELECT} WHERE p.id = ?`, [id]);
  return row ? mapProductionRow(row) : null;
}

export async function listProductionWorkers(productionId: number): Promise<BrickProductionWorkerRow[]> {
  const rows = await rawAll<any>(
    `SELECT id, production_id, worker_id, worker_name, role, days, daily_rate, amount, created_at
       FROM brick_production_workers WHERE production_id = ? ORDER BY id`,
    [productionId],
  );
  return rows.map((row) => ({
    id: num(row.id),
    productionId: num(row.production_id),
    workerId: row.worker_id == null ? null : num(row.worker_id),
    workerName: row.worker_name,
    role: row.role ?? null,
    days: num(row.days),
    dailyRate: num(row.daily_rate),
    amount: roundMoney(num(row.amount)),
    createdAt: toDate(row.created_at),
  }));
}

/** Dépenses rattachées au lot (annulées exclues, en attente comprises : on les voit). */
export async function listProductionExpenses(productionId: number): Promise<BrickProductionExpenseRow[]> {
  const rows = await rawAll<any>(
    `SELECT e.id, e.category, e.amount, e.description, e.payment_method, e.beneficiary, e.approval_status,
            e.date, e.reference_id, e.user_id, e.created_at, e.deleted_at, u.name AS user_name
       FROM expenses e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.reference_type = 'brick_production' AND e.reference_id = ? AND e.deleted_at IS NULL
      ORDER BY e.date ASC, e.id ASC`,
    [productionId],
  );
  return rows.map((row) => ({
    id: num(row.id),
    productionId: num(row.reference_id),
    category: row.category,
    description: row.description ?? null,
    amount: num(row.amount),
    paymentMethod: row.payment_method ?? 'Espèces',
    beneficiary: row.beneficiary ?? null,
    date: row.date,
    userId: row.user_id == null ? null : num(row.user_id),
    userName: row.user_name ?? null,
    approvalStatus: row.approval_status ?? 'approved',
    cancelled: row.deleted_at != null,
    createdAt: toDate(row.created_at),
  }));
}

export async function getBrickProduction(id: number): Promise<BrickProductionDetail | null> {
  const production = await getBrickProductionRow(id);
  if (!production) return null;
  const [brickType, workers, expenses] = await Promise.all([
    getBrickType(production.brickTypeId),
    listProductionWorkers(id),
    listProductionExpenses(id),
  ]);
  const good = roundMoney(production.producedQuantity - production.brokenQuantity);
  return {
    production,
    brickType,
    product: brickType
      ? { id: brickType.productId, name: brickType.productName, unit: brickType.unit, stock: brickType.stock, salePrice: brickType.salePrice }
      : null,
    materials: [],
    workers,
    expenses,
    costs: {
      materialCost: 0,
      laborCost: production.laborCost,
      expenseCost: production.expenseCost,
      totalCost: production.totalCost,
      producedQuantity: production.producedQuantity,
      brokenQuantity: production.brokenQuantity,
      goodQuantity: good,
      unitCost: unitCostOf(production.totalCost, good),
    },
  };
}

/** Coûts et coût unitaire masqués (invariant 13 : sans `balances.view`). */
export function hideProductionCosts<T extends { laborCost?: number | null; expenseCost?: number | null; totalCost?: number | null; unitCost?: number | null }>(
  row: T,
): T {
  return { ...row, laborCost: null, expenseCost: null, totalCost: null, unitCost: null };
}

/* ------------------------------------------------------------------ *
 * Synthèse « fabriquées / cassées / vendues »
 * ------------------------------------------------------------------ */

export async function getBrickSummary(options: { scope: StoreScope; from?: string; to?: string }): Promise<BrickSummary> {
  const from = options.from ?? null;
  const to = options.to ?? null;
  const prodWhere = [`p.status <> 'cancelled'`, scopeSql('p.store_id', options.scope)];
  const prodArgs: string[] = [];
  if (from) {
    prodWhere.push(`${PRODUCTION_DATE} >= ?`);
    prodArgs.push(from);
  }
  if (to) {
    prodWhere.push(`${PRODUCTION_DATE} <= ?`);
    prodArgs.push(to);
  }
  const productions = await rawAll<any>(
    `SELECT p.brick_type_id, bt.name AS brick_type_name, COUNT(*) AS lots,
            SUM(p.produced_quantity) AS produced, SUM(p.broken_quantity) AS broken,
            SUM(${LABOR_COST_SQL}) AS labor_cost, SUM(${EXPENSE_COST_SQL}) AS expense_cost
       FROM brick_productions p INNER JOIN brick_types bt ON bt.id = p.brick_type_id
      WHERE ${prodWhere.join(' AND ')}
      GROUP BY p.brick_type_id, bt.name`,
    prodArgs,
  );

  // Ventes de briques : factures **actives** du canal briqueterie de la portée.
  const salesWhere = [`v.status = 'active'`, `v.channel = 'brick'`, scopeSql('v.store_id', options.scope)];
  const salesArgs: string[] = [];
  if (from) {
    salesWhere.push('v.date >= ?');
    salesArgs.push(from);
  }
  if (to) {
    salesWhere.push('v.date <= ?');
    salesArgs.push(to);
  }
  const sales = await rawAll<{ product_id: number; quantity: number | null; revenue: number | null }>(
    `SELECT i.product_id, SUM(i.quantity) AS quantity, SUM(i.amount) AS revenue
       FROM sales_invoice_items i INNER JOIN sales_invoices v ON v.id = i.invoice_id
      WHERE ${salesWhere.join(' AND ')}
      GROUP BY i.product_id`,
    salesArgs,
  );
  const types = await rawAll<{ id: number; product_id: number; name: string }>(
    `SELECT bt.id, bt.product_id, bt.name FROM brick_types bt WHERE ${scopeSql('bt.store_id', options.scope)}`,
  );
  const typeByProduct = new Map(types.map((t) => [num(t.product_id), { id: num(t.id), name: t.name }]));
  const typeNameById = new Map(types.map((t) => [num(t.id), t.name]));

  const soldByType = new Map<number, number>();
  let sold = 0;
  let soldRevenue = 0;
  for (const row of sales) {
    const quantity = num(row.quantity);
    sold += quantity;
    soldRevenue += num(row.revenue);
    const type = typeByProduct.get(num(row.product_id));
    if (type) soldByType.set(type.id, (soldByType.get(type.id) ?? 0) + quantity);
  }

  const byType = new Map<number, BrickSummary['byType'][number]>();
  let produced = 0;
  let broken = 0;
  let laborCost = 0;
  let expensesCost = 0;
  let productionsCount = 0;
  for (const row of productions) {
    const typeId = num(row.brick_type_id);
    const typeProduced = num(row.produced);
    const typeBroken = num(row.broken);
    const typeCost = num(row.labor_cost) + num(row.expense_cost);
    produced += typeProduced;
    broken += typeBroken;
    laborCost += num(row.labor_cost);
    expensesCost += num(row.expense_cost);
    productionsCount += num(row.lots);
    byType.set(typeId, {
      brickTypeId: typeId,
      brickTypeName: row.brick_type_name,
      produced: typeProduced,
      broken: typeBroken,
      sold: soldByType.get(typeId) ?? 0,
      unitCost: unitCostOf(typeCost, roundMoney(typeProduced - typeBroken)),
    });
  }
  for (const [typeId, quantity] of soldByType) {
    if (byType.has(typeId)) continue;
    byType.set(typeId, { brickTypeId: typeId, brickTypeName: typeNameById.get(typeId) ?? `Type #${typeId}`, produced: 0, broken: 0, sold: quantity, unitCost: 0 });
  }
  const totalCost = roundMoney(laborCost + expensesCost);
  const good = roundMoney(produced - broken);
  return {
    from,
    to,
    productionsCount,
    produced: roundMoney(produced),
    broken: roundMoney(broken),
    good,
    sold: roundMoney(sold),
    soldRevenue: roundMoney(soldRevenue),
    materialsCost: 0,
    laborCost: roundMoney(laborCost),
    expensesCost: roundMoney(expensesCost),
    totalCost,
    averageUnitCost: unitCostOf(totalCost, good),
    byType: Array.from(byType.values()).sort((a, b) => a.brickTypeName.localeCompare(b.brickTypeName, 'fr')),
  };
}

/* ------------------------------------------------------------------ *
 * Lots — écriture (magasin actif uniquement)
 * ------------------------------------------------------------------ */

async function assertProductionEditable(id: number, storeId: number): Promise<BrickProductionRow> {
  const production = await getBrickProductionRow(id);
  if (!production) throw new NotFoundError('Lot de fabrication introuvable');
  if (production.storeId !== Number(storeId)) {
    throw new ValidationError(
      `Ce lot appartient au magasin ${production.storeName ?? 'd’un autre magasin'} : il ne se modifie que depuis ce magasin.`,
    );
  }
  if (production.isCancelled) throw new ConflictError('Ce lot est annulé : il n’accepte plus aucune modification.');
  return production;
}

async function finishedGoodsCredited(productionId: number): Promise<boolean> {
  const row = await rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stock_movements
      WHERE reference_type = 'brick_production' AND reference_id = ? AND type = 'entry'`,
    [productionId],
  );
  return num(row?.c) > 0;
}

/** Numéro `BRI-KAL-2026-000001` puis création du lot, dans le magasin actif. */
export async function createBrickProduction(input: BrickProductionInput & { storeId: number }): Promise<BrickProductionRow> {
  return withTransaction(async () => {
    const brickTypeId = Number(input.brickTypeId);
    if (!Number.isInteger(brickTypeId) || brickTypeId <= 0) throw new ValidationError('Le type de brique est obligatoire');
    const type = await assertBrickTypeInStore(brickTypeId, input.storeId);
    if (!type.isActive) throw new ValidationError(`Le type « ${type.name} » est désactivé.`);

    const plannedQuantity = num(input.plannedQuantity);
    const producedQuantity = num(input.producedQuantity);
    const brokenQuantity = num(input.brokenQuantity);
    if (plannedQuantity < 0 || producedQuantity < 0 || brokenQuantity < 0) {
      throw new ValidationError('Les quantités ne peuvent pas être négatives');
    }
    if (brokenQuantity > producedQuantity) {
      throw new ValidationError('Les briques cassées ne peuvent pas dépasser la quantité produite');
    }
    const startDate = cleanDate(input.startDate) ?? today();
    const endDate = cleanDate(input.endDate);
    if (endDate && endDate < startDate) throw new ValidationError('La date de fin ne peut pas précéder la date de début.');

    const inserted = await db
      .insert(brickProductions)
      .values({
        storeId: input.storeId,
        batchNumber: await nextDocumentNumber('brick', input.storeId),
        brickTypeId,
        plannedQuantity,
        producedQuantity,
        brokenQuantity,
        startDate,
        endDate,
        stage: 'molding',
        status: 'registered',
        team: input.team?.trim() || null,
        userId: input.userId ?? null,
        notes: input.notes?.trim() || null,
      })
      .returning({ id: brickProductions.id });
    const created = await getBrickProductionRow(inserted[0].id);
    if (!created) throw new NotFoundError('Lot créé mais introuvable');
    return created;
  });
}

/**
 * Modification du lot. Une fois **mis en stock**, ses quantités ne bougent
 * plus (le journal de stock fait foi) : une perte constatée après coup passe
 * par `registerBroken()`.
 */
export async function updateBrickProduction(id: number, patch: BrickProductionPatch, storeId: number): Promise<BrickProductionRow> {
  return withTransaction(async () => {
    const production = await assertProductionEditable(id, storeId);
    const values: Record<string, unknown> = { updatedAt: new Date() };
    const touchesQuantity = patch.producedQuantity !== undefined || patch.brokenQuantity !== undefined;
    if (touchesQuantity && production.stored) {
      throw new ConflictError(
        'Ce lot est déjà mis en stock : ses quantités ne sont plus modifiables. Enregistrez une perte si des briques se sont cassées.',
      );
    }
    for (const key of ['plannedQuantity', 'producedQuantity', 'brokenQuantity'] as const) {
      if (patch[key] === undefined) continue;
      const value = num(patch[key]);
      if (value < 0) throw new ValidationError('Les quantités ne peuvent pas être négatives');
      values[key] = value;
    }
    const produced = num(values.producedQuantity ?? production.producedQuantity);
    const broken = num(values.brokenQuantity ?? production.brokenQuantity);
    if (broken > produced) throw new ValidationError('Les briques cassées ne peuvent pas dépasser la quantité produite');
    if (patch.startDate !== undefined) values.startDate = cleanDate(patch.startDate) ?? production.startDate ?? today();
    if (patch.endDate !== undefined) values.endDate = cleanDate(patch.endDate);
    const start = String(values.startDate ?? production.startDate ?? '');
    const end = (values.endDate !== undefined ? values.endDate : production.endDate) as string | null;
    if (start && end && end < start) throw new ValidationError('La date de fin ne peut pas précéder la date de début.');
    if (patch.team !== undefined) values.team = patch.team?.trim() || null;
    if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;

    await db.update(brickProductions).set(values as any).where(eq(brickProductions.id, id));
    const result = await getBrickProductionRow(id);
    if (!result) throw new NotFoundError('Lot de fabrication introuvable');
    return result;
  });
}

/**
 * Avance le lot : `molding → drying → firing → stored`, sans retour. L'entrée
 * dans `stored` crédite le stock **une seule fois** des briques produites, puis
 * sort les cassées connues (stock net = produites − cassées), et termine le lot.
 */
export async function advanceStage(
  id: number,
  stage: BrickStage,
  storeId: number,
  userId?: number | null,
): Promise<BrickProductionRow> {
  if (!isBrickStage(stage)) throw new ValidationError('Étape de fabrication invalide');
  return withTransaction(async () => {
    const production = await assertProductionEditable(id, storeId);
    const currentIndex = BRICK_STAGES.indexOf(production.stage);
    const targetIndex = BRICK_STAGES.indexOf(stage);
    if (targetIndex <= currentIndex) {
      throw new ValidationError(
        `Le lot est déjà à l’étape « ${BRICK_STAGE_LABELS[production.stage]} » : une fabrication ne revient pas en arrière.`,
      );
    }

    const values: Record<string, unknown> = { stage, updatedAt: new Date() };
    if (stage === 'stored') {
      if (production.producedQuantity <= 0) {
        throw new ValidationError('Indiquez la quantité produite avant de mettre le lot en stock.');
      }
      if (!(await finishedGoodsCredited(id))) {
        await addStockMovement(production.productId, 'entry', production.producedQuantity, {
          storeId,
          referenceType: 'brick_production',
          referenceId: id,
          motif: `production ${production.batchNumber} : mise en stock`,
          userId: userId ?? null,
        });
        if (production.brokenQuantity > 0) {
          await addStockMovement(production.productId, 'exit', production.brokenQuantity, {
            storeId,
            referenceType: 'brick_production',
            referenceId: id,
            motif: `briques cassées lot ${production.batchNumber}`,
            userId: userId ?? null,
          });
        }
      }
      if (!production.endDate) values.endDate = today();
      // « Terminée » n'est pas une case à cocher : c'est l'entrée en stock qui la pose.
      values.status = 'finished';
    }
    await db.update(brickProductions).set(values as any).where(eq(brickProductions.id, id));
    const result = await getBrickProductionRow(id);
    if (!result) throw new NotFoundError('Lot de fabrication introuvable');
    return result;
  });
}

/** Un ouvrier rattaché à un autre magasin ne travaille pas sur ce lot. */
async function assertWorkerAvailable(workerId: number, storeId: number) {
  const worker = await rawGet<{ store_id: number | null }>('SELECT store_id FROM workers WHERE id = ?', [workerId]);
  if (worker && worker.store_id != null && Number(worker.store_id) !== Number(storeId)) {
    throw new ValidationError('Cet ouvrier est rattaché à un autre magasin.');
  }
}

/** Affecte un ouvrier (ou un journalier) : `amount = jours × tarif`. */
export async function addProductionWorker(
  productionId: number,
  input: { workerId?: number | null; workerName?: string | null; role?: string | null; days: number; dailyRate?: number | null },
  storeId: number,
): Promise<BrickProductionWorkerRow> {
  return withTransaction(async () => {
    await assertProductionEditable(productionId, storeId);
    const days = num(input.days);
    if (days <= 0) throw new ValidationError('Le nombre de jours doit être strictement positif');
    let workerId: number | null = null;
    let workerName = (input.workerName ?? '').trim();
    let role = input.role?.trim() || null;
    let dailyRate = input.dailyRate === undefined || input.dailyRate === null ? null : num(input.dailyRate);
    if (input.workerId) {
      const worker = await rawGet<{ id: number; name: string; role: string | null; daily_rate: number | null }>(
        'SELECT id, name, role, daily_rate FROM workers WHERE id = ?',
        [Number(input.workerId)],
      );
      if (!worker) throw new NotFoundError('Ouvrier introuvable');
      await assertWorkerAvailable(num(worker.id), storeId);
      workerId = num(worker.id);
      if (!workerName) workerName = worker.name;
      if (!role) role = worker.role;
      if (dailyRate === null) dailyRate = num(worker.daily_rate);
    }
    if (!workerName) throw new ValidationError('Le nom de l’ouvrier est obligatoire');
    const rate = roundMoney(dailyRate ?? 0);
    if (rate < 0) throw new ValidationError('Le tarif journalier doit être positif');
    const inserted = await db
      .insert(brickProductionWorkers)
      .values({ productionId, workerId, workerName, role, days, dailyRate: rate, amount: roundMoney(days * rate) })
      .returning();
    const row = inserted[0];
    return {
      id: row.id,
      productionId: row.productionId,
      workerId: row.workerId,
      workerName: row.workerName,
      role: row.role,
      days: num(row.days),
      dailyRate: num(row.dailyRate),
      amount: num(row.amount),
      createdAt: row.createdAt,
    };
  });
}

/** Retire une affectation (`lineId` = identifiant de la ligne d'affectation). */
export async function removeProductionWorker(productionId: number, lineId: number, storeId: number): Promise<BrickProductionWorkerRow> {
  return withTransaction(async () => {
    await assertProductionEditable(productionId, storeId);
    const line = (await listProductionWorkers(productionId)).find((w) => w.id === lineId);
    if (!line) throw new NotFoundError('Affectation introuvable sur ce lot');
    await db.delete(brickProductionWorkers).where(eq(brickProductionWorkers.id, lineId));
    return line;
  });
}

/**
 * Ajoute une dépense au lot : une **dépense** du magasin, rattachée au lot, qui
 * suit le circuit normal (seuil d'approbation, caisse) — `lib/expenses.ts`.
 */
export async function addProductionExpense(
  productionId: number,
  input: BrickProductionExpenseInput,
  storeId: number,
): Promise<BrickProductionExpenseRow> {
  await assertProductionEditable(productionId, storeId);
  const expense = await createExpense({
    storeId,
    canSkipApproval: Boolean(input.canSkipApproval),
    category: input.category,
    amount: input.amount,
    description: input.description ?? null,
    paymentMethod: input.paymentMethod ?? 'Espèces',
    beneficiary: input.beneficiary ?? null,
    date: input.date,
    referenceType: PRODUCTION_EXPENSE_REFERENCE,
    referenceId: productionId,
    userId: input.userId ?? null,
  });
  const row = (await listProductionExpenses(productionId)).find((e) => e.id === expense.id);
  if (!row) throw new NotFoundError('Dépense créée mais introuvable');
  return row;
}

async function assertExpenseOfProduction(productionId: number, expenseId: number) {
  const expense = await getExpense(expenseId);
  if (!expense) throw new NotFoundError('Dépense introuvable');
  if (expense.referenceType !== PRODUCTION_EXPENSE_REFERENCE || expense.referenceId !== productionId) {
    throw new ValidationError('Cette dépense n’est pas rattachée à ce lot de fabrication');
  }
  return expense;
}

export async function updateProductionExpense(
  productionId: number,
  expenseId: number,
  patch: { category?: string; amount?: number; description?: string | null; paymentMethod?: string; beneficiary?: string | null; date?: string },
  options: { userId?: number | null; storeId: number; canSkipApproval?: boolean },
): Promise<BrickProductionExpenseRow> {
  await assertProductionEditable(productionId, options.storeId);
  await assertExpenseOfProduction(productionId, expenseId);
  await updateExpense(expenseId, patch, { userId: options.userId ?? null, storeId: options.storeId, canSkipApproval: options.canSkipApproval });
  const row = (await listProductionExpenses(productionId)).find((e) => e.id === expenseId);
  if (!row) throw new NotFoundError('Dépense introuvable');
  return row;
}

/** Retire une dépense du lot : **annulation motivée** (l'argent revient en caisse). */
export async function removeProductionExpense(
  productionId: number,
  expenseId: number,
  reason: string,
  options: { userId?: number | null; storeId: number },
): Promise<BrickProductionRow> {
  await assertProductionEditable(productionId, options.storeId);
  await assertExpenseOfProduction(productionId, expenseId);
  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif de retrait de la dépense est obligatoire');
  await cancelExpense(expenseId, { reason: motif, userId: options.userId ?? null, storeId: options.storeId });
  const result = await getBrickProductionRow(productionId);
  if (!result) throw new NotFoundError('Lot de fabrication introuvable');
  return result;
}

/**
 * Enregistre des briques cassées. Lot déjà en stock : `exit` immédiat ; sinon
 * seule la quantité cassée augmente et sortira avec la mise en stock (un `exit`
 * avant toute entrée rendrait le stock négatif).
 */
export async function registerBroken(
  id: number,
  brokenQuantity: number,
  reason: string,
  storeId: number,
  userId?: number | null,
): Promise<BrickProductionRow> {
  return withTransaction(async () => {
    const production = await assertProductionEditable(id, storeId);
    const additional = num(brokenQuantity);
    if (additional <= 0) throw new ValidationError('La quantité cassée doit être strictement positive');
    const motif = (reason ?? '').trim();
    if (!motif) throw new ValidationError('Le motif de la perte est obligatoire');
    const newBroken = roundMoney(production.brokenQuantity + additional);
    if (newBroken > production.producedQuantity) {
      throw new ValidationError('Les briques cassées ne peuvent pas dépasser la quantité produite : mettez d’abord à jour la production.');
    }
    if (production.stored) {
      await addStockMovement(production.productId, 'exit', additional, {
        storeId,
        referenceType: 'brick_production',
        referenceId: id,
        motif: `briques cassées lot ${production.batchNumber} : ${motif}`,
        userId: userId ?? null,
      });
    }
    const stamp = `Perte de ${additional} brique(s) le ${today()} — motif : ${motif}`;
    await db
      .update(brickProductions)
      .set({ brokenQuantity: newBroken, notes: production.notes ? `${production.notes}\n${stamp}` : stamp, updatedAt: new Date() })
      .where(eq(brickProductions.id, id));
    const result = await getBrickProductionRow(id);
    if (!result) throw new NotFoundError('Lot de fabrication introuvable');
    return result;
  });
}

/**
 * Annule un lot — jamais de suppression. Le **solde net** que le lot a mis en
 * stock ressort (refusé par le moteur si ces briques ont déjà été vendues : on
 * ne crée pas de stock négatif). Les dépenses rattachées restent des dépenses
 * réelles : elles s'annulent une à une si elles n'ont pas eu lieu.
 */
export async function cancelBrickProduction(
  id: number,
  reason: string,
  user: { id: number; storeId: number },
): Promise<BrickProductionRow> {
  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire');
  return withTransaction(async () => {
    const production = await assertProductionEditable(id, user.storeId);
    const balance = await rawGet<{ net: number | null }>(
      `SELECT COALESCE(SUM(CASE WHEN type = 'entry' THEN quantity ELSE -quantity END), 0) AS net
         FROM stock_movements
        WHERE reference_type = 'brick_production' AND reference_id = ? AND product_id = ? AND store_id = ?`,
      [id, production.productId, user.storeId],
    );
    const net = roundMoney(num(balance?.net));
    if (net > 0) {
      await addStockMovement(production.productId, 'exit', net, {
        storeId: user.storeId,
        referenceType: 'brick_production',
        referenceId: id,
        motif: `annulation lot ${production.batchNumber} : ${motif}`,
        userId: user.id,
      });
    }
    await db
      .update(brickProductions)
      .set({ status: 'cancelled', cancelReason: motif, cancelledAt: new Date(), cancelledBy: user.id, updatedAt: new Date() })
      .where(eq(brickProductions.id, id));
    const result = await getBrickProductionRow(id);
    if (!result) throw new NotFoundError('Lot de fabrication introuvable');
    return result;
  });
}
