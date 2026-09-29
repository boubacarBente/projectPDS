/**
 * Briqueterie — fabrication des briques (README §20).
 *
 * Quatre principes structurants :
 *
 * 1. **Un seul moteur de stock.** Les matières premières (argile/terre, ciment,
 *    sable, eau, bois de chauffe) sont des `products` dont la *catégorie* porte
 *    `kind = 'raw_material'`. Rien n'est stocké ailleurs que dans
 *    `stock_movements` (§12).
 * 2. `brick_types.product_id` → **c'est le produit lié qui porte le prix de
 *    vente et le stock** de briques finies.
 * 3. Les **briques cassées** sont des mouvements `exit` avec un motif explicite
 *    (« briques cassées lot BRI-… ») : pas de type `loss` (§6.6).
 * 4. Le **coût de revient unitaire** = `total_cost ÷ (produced − broken)` est
 *    **calculé, jamais stocké** (§20, §6.5 règle 6).
 *
 * ── Unicité de l'entrée en stock des briques finies ─────────────────────────
 * `advanceStage()` est la **seule** fonction qui crédite le stock de briques
 * prêtes à vendre, et elle le fait à l'entrée dans l'étape `stored`. L'unicité
 * est garantie par **deux verrous indépendants** :
 *   a) les transitions d'étape sont **strictement croissantes**
 *      (`molding → drying → firing → stored`) : on ne peut pas « repasser » par
 *      `stored`, donc pas de second crédit ;
 *   b) avant de créditer, on vérifie qu'aucun mouvement `entry`
 *      (`reference_type = 'brick_production'`, `reference_id = lot`) n'existe
 *      déjà — la fonction est donc idempotente même si on la rappelle.
 * La quantité créditée est `produced_quantity` ; les briques cassées connues à
 * cet instant sortent dans le même mouvement comptable (`exit` motivé), ce qui
 * laisse un stock net exactement égal à `produced − broken`.
 */

import { db, rawAll, rawGet } from '@/db';
import { asc, eq } from 'drizzle-orm';
import {
  brickProductionMaterials,
  brickProductionWorkers,
  brickProductions,
  brickTypes,
} from '@/db/schema';
import { enqueueSyncWrite } from '@/lib/sync';
import { addStockMovement } from '@/lib/stock';
import { nextDocumentNumber } from '@/lib/settings';
import { DEFAULT_LIST_SORT, sqlOrderBy, type ListSort } from '@/lib/list-sort';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api';
import { roundMoney, today } from '@/lib/format';
import {
  createExpense,
  cancelExpense,
  getExpense,
  updateExpense,
  PRODUCTION_EXPENSE_REFERENCE,
  type ExpenseRow,
} from '@/lib/expenses';

/* ------------------------------------------------------------------ *
 * Types et listes fermées
 * ------------------------------------------------------------------ */

export const BRICK_SHAPES = ['solid', 'hollow', 'block'] as const;
export type BrickShape = (typeof BRICK_SHAPES)[number];

export const BRICK_STAGES = ['molding', 'drying', 'firing', 'stored'] as const;
export type BrickStage = (typeof BRICK_STAGES)[number];

/**
 * **Statut d'une fiche de production** (§20).
 *
 *  - `registered` : la fabrication est lancée, les dépenses s'y rattachent ;
 *  - `finished` : le lot est **terminé** — c'est le cas dès l'entrée dans
 *    l'étape `stored`, qui crédite le stock de briques finies ;
 *  - `cancelled` : annulée avec un motif obligatoire (jamais supprimée).
 *
 * Le tombstone `deleted_at` reste posé en même temps que `cancelled` : les
 * listes existantes filtrent déjà dessus, et la synchronisation aussi.
 */
export const BRICK_PRODUCTION_STATUSES = ['registered', 'finished', 'cancelled'] as const;
export type BrickProductionStatus = (typeof BRICK_PRODUCTION_STATUSES)[number];

export const BRICK_PRODUCTION_STATUS_LABELS: Record<BrickProductionStatus, string> = {
  registered: 'Enregistrée',
  finished: 'Terminée',
  cancelled: 'Annulée',
};

export function isBrickProductionStatus(value: unknown): value is BrickProductionStatus {
  return (
    typeof value === 'string' && (BRICK_PRODUCTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isBrickShape(value: unknown): value is BrickShape {
  return typeof value === 'string' && (BRICK_SHAPES as readonly string[]).includes(value);
}

export function isBrickStage(value: unknown): value is BrickStage {
  return typeof value === 'string' && (BRICK_STAGES as readonly string[]).includes(value);
}

export type BrickTypeRow = {
  id: number;
  productId: number;
  name: string;
  shape: BrickShape;
  dimensions: string | null;
  description: string | null;
  isActive: boolean;
  /** Produit lié : il porte le prix de vente et le stock. */
  productName: string;
  unit: string;
  salePrice: number;
  purchasePrice: number;
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
  /** Enregistrée | Terminée | Annulée. */
  status: BrickProductionStatus;
  /** Équipe ou responsable de production (texte libre). */
  team: string | null;
  /** Somme des matières premières **historiques** (§20 : plus de module matières). */
  materialCost: number;
  /** Main-d'œuvre des affectations (`days × daily_rate`). */
  laborCost: number;
  /** Somme des **dépenses rattachées** (`expenses.reference_type = 'brick_production'`). */
  expenseCost: number;
  totalCost: number;
  /** Calculé : `total_cost ÷ (produced − broken)`. */
  unitCost: number;
  /** Vrai si le stock de briques finies a **déjà** été crédité. */
  stored: boolean;
  materialsCount: number;
  workersCount: number;
  /** Nombre de dépenses rattachées à la fiche. */
  expensesCount: number;
  userId: number | null;
  userName: string | null;
  notes: string | null;
  isCancelled: boolean;
  cancelReason: string | null;
  cancelledAt: Date | null;
  createdAt: Date | null;
};

export type BrickProductionMaterialRow = {
  id: number;
  productionId: number;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  unitCost: number;
  amount: number;
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
  /** Matières premières **historiques** (lots antérieurs au §20 révisé). */
  materialCost: number;
  /** Main-d'œuvre : somme des affectations `days × daily_rate`. */
  laborCost: number;
  /** Dépenses **rattachées à la fiche** (ciment, sable, carburant…). */
  expenseCost: number;
  totalCost: number;
  producedQuantity: number;
  brokenQuantity: number;
  goodQuantity: number;
  /** **Calculé**, jamais stocké : coût de revient d'une brique vendable. */
  unitCost: number;
};

/** Une dépense rattachée à un lot — vue « production » de `expenses` (§9, §20). */
export type BrickProductionExpenseRow = {
  id: number;
  productionId: number;
  category: string;
  description: string | null;
  amount: number;
  paymentMethod: string;
  beneficiary: string | null;
  /** Date métier `YYYY-MM-DD`. */
  date: string;
  userId: number | null;
  userName: string | null;
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
};

export type BrickProductionDetail = {
  production: BrickProductionRow;
  brickType: BrickTypeRow | null;
  product: { id: number; name: string; unit: string; stock: number; salePrice: number } | null;
  materials: BrickProductionMaterialRow[];
  workers: BrickProductionWorkerRow[];
  /** Dépenses rattachées — la source de coût de la fiche (§20). */
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
  /** Équipe ou responsable de production. */
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
  search?: string;
  brickTypeId?: number;
  stage?: string;
  /** `registered` | `finished` | `cancelled`. */
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
  /** Dépenses rattachées aux lots de la période (ciment, sable, carburant…). */
  expensesCost: number;
  totalCost: number;
  /** Coût de revient moyen d'une brique vendable. */
  averageUnitCost: number;
  byType: {
    brickTypeId: number;
    brickTypeName: string;
    produced: number;
    broken: number;
    sold: number;
    unitCost: number;
  }[];
};

/* ------------------------------------------------------------------ *
 * Types de briques
 * ------------------------------------------------------------------ */

const BRICK_TYPE_SELECT = `
  SELECT bt.id, bt.product_id, bt.name, bt.shape, bt.dimensions, bt.description,
         bt.is_active, bt.created_at,
         p.name AS product_name, p.unit AS product_unit,
         p.sale_price, p.purchase_price, p.stock,
         (SELECT COUNT(*) FROM brick_productions bp WHERE bp.brick_type_id = bt.id AND bp.deleted_at IS NULL) AS productions_count
  FROM brick_types bt
  INNER JOIN products p ON p.id = bt.product_id
`;

function mapBrickTypeRow(row: any): BrickTypeRow {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    name: row.name,
    shape: isBrickShape(row.shape) ? row.shape : 'solid',
    dimensions: row.dimensions,
    description: row.description,
    isActive: Boolean(row.is_active),
    productName: row.product_name,
    unit: row.product_unit,
    salePrice: Number(row.sale_price ?? 0),
    purchasePrice: Number(row.purchase_price ?? 0),
    stock: Number(row.stock ?? 0),
    productionsCount: Number(row.productions_count ?? 0),
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

export async function listBrickTypes(
  options: {
    includeInactive?: boolean;
    /** `recent` (défaut) = dernière insertion ; `name` = ordre alphabétique. */
    sort?: ListSort;
  } = {},
): Promise<BrickTypeRow[]> {
  const where = options.includeInactive ? '' : 'WHERE bt.is_active = 1';
  const orderBy = sqlOrderBy(options.sort ?? DEFAULT_LIST_SORT, 'bt', ['recent', 'name']);
  const rows = await rawAll<any>(`${BRICK_TYPE_SELECT} ${where} ORDER BY ${orderBy}`);
  return rows.map(mapBrickTypeRow);
}

export async function getBrickType(id: number): Promise<BrickTypeRow | null> {
  const row = await rawGet<any>(`${BRICK_TYPE_SELECT} WHERE bt.id = ?`, [id]);
  return row ? mapBrickTypeRow(row) : null;
}

export async function createBrickType(input: BrickTypeInput): Promise<BrickTypeRow> {
  const productId = Number(input.productId);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new ValidationError('Le produit lié au type de brique est obligatoire');
  }

  const name = (input.name ?? '').trim();
  if (!name) throw new ValidationError('Le nom du type de brique est obligatoire');

  const product = await rawGet<{ id: number }>('SELECT id FROM products WHERE id = ?', [productId]);
  if (!product) throw new NotFoundError('Produit introuvable');

  const inserted = await db
    .insert(brickTypes)
    .values({
      productId,
      name,
      shape: isBrickShape(input.shape) ? input.shape : 'solid',
      dimensions: input.dimensions?.trim() || null,
      description: input.description?.trim() || null,
      isActive: input.isActive ?? true,
    })
    .returning({ id: brickTypes.id, syncId: brickTypes.syncId });

  await enqueueSyncWrite('brick_types', inserted[0]?.syncId, 'insert', {
    product_id: productId,
    name,
    shape: isBrickShape(input.shape) ? input.shape : 'solid',
    dimensions: input.dimensions?.trim() || null,
    is_active: input.isActive ?? true,
  });

  const created = await getBrickType(inserted[0].id);
  if (!created) throw new NotFoundError('Type de brique créé mais introuvable');
  return created;
}

export async function updateBrickType(id: number, patch: Partial<BrickTypeInput>): Promise<BrickTypeRow> {
  const values: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.productId !== undefined) {
    const productId = Number(patch.productId);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new ValidationError('Produit lié invalide');
    }
    const product = await rawGet<{ id: number }>('SELECT id FROM products WHERE id = ?', [productId]);
    if (!product) throw new NotFoundError('Produit introuvable');
    values.productId = productId;
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
  if (patch.isActive !== undefined) values.isActive = Boolean(patch.isActive);

  const updated = await db
    .update(brickTypes)
    .set(values as any)
    .where(eq(brickTypes.id, id))
    .returning({ id: brickTypes.id, syncId: brickTypes.syncId });

  if (updated.length === 0) throw new NotFoundError('Type de brique introuvable');

  await enqueueSyncWrite('brick_types', updated[0].syncId, 'update', values);

  const result = await getBrickType(id);
  if (!result) throw new NotFoundError('Type de brique introuvable après modification');
  return result;
}

/** Désactivation — **jamais** de suppression (§7). */
export async function deactivateBrickType(id: number): Promise<void> {
  const updated = await db
    .update(brickTypes)
    .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(brickTypes.id, id))
    .returning({ syncId: brickTypes.syncId });

  if (updated.length === 0) throw new NotFoundError('Type de brique introuvable');

  await enqueueSyncWrite('brick_types', updated[0].syncId, 'delete', {
    deleted_at: new Date().toISOString(),
  });
}

export async function reactivateBrickType(id: number): Promise<void> {
  const updated = await db
    .update(brickTypes)
    .set({ isActive: true, deletedAt: null, updatedAt: new Date() })
    .where(eq(brickTypes.id, id))
    .returning({ syncId: brickTypes.syncId });

  if (updated.length === 0) throw new NotFoundError('Type de brique introuvable');

  await enqueueSyncWrite('brick_types', updated[0].syncId, 'update', { is_active: true });
}

/* ------------------------------------------------------------------ *
 * Lots de fabrication
 * ------------------------------------------------------------------ */

const PRODUCTION_SELECT = `
  SELECT p.id, p.batch_number, p.brick_type_id, bt.name AS brick_type_name, bt.shape, bt.dimensions,
         bt.product_id, pr.name AS product_name, pr.unit AS product_unit,
         p.planned_quantity, p.produced_quantity, p.broken_quantity,
         p.start_date, p.end_date, p.stage, p.status, p.team,
         p.material_cost, p.labor_cost, p.expense_cost, p.total_cost,
         p.cancel_reason, p.cancelled_at,
         p.user_id, u.name AS user_name,
         p.notes, p.deleted_at, p.created_at,
         (SELECT COUNT(*) FROM brick_production_materials m WHERE m.production_id = p.id) AS materials_count,
         (SELECT COUNT(*) FROM brick_production_workers w WHERE w.production_id = p.id) AS workers_count,
         (SELECT COUNT(*) FROM expenses e
           WHERE e.reference_type = 'brick_production' AND e.reference_id = p.id
             AND e.deleted_at IS NULL) AS expenses_count,
         (SELECT COUNT(*) FROM stock_movements sm
           WHERE sm.reference_type = 'brick_production' AND sm.reference_id = p.id AND sm.type = 'entry') AS stored_count
  FROM brick_productions p
  INNER JOIN brick_types bt ON bt.id = p.brick_type_id
  INNER JOIN products pr ON pr.id = bt.product_id
  LEFT JOIN users u ON u.id = p.user_id
`;

function mapProductionRow(row: any): BrickProductionRow {
  const produced = Number(row.produced_quantity ?? 0);
  const broken = Number(row.broken_quantity ?? 0);
  const materialCost = Number(row.material_cost ?? 0);
  const laborCost = Number(row.labor_cost ?? 0);
  const expenseCost = Number(row.expense_cost ?? 0);
  const totalCost = Number(row.total_cost ?? 0) || roundMoney(materialCost + laborCost + expenseCost);
  const good = roundMoney(produced - broken);
  const isCancelled = row.deleted_at != null;

  return {
    id: Number(row.id),
    batchNumber: row.batch_number,
    brickTypeId: Number(row.brick_type_id),
    brickTypeName: row.brick_type_name,
    shape: isBrickShape(row.shape) ? row.shape : 'solid',
    dimensions: row.dimensions,
    productId: Number(row.product_id),
    productName: row.product_name,
    productUnit: row.product_unit,
    plannedQuantity: Number(row.planned_quantity ?? 0),
    producedQuantity: produced,
    brokenQuantity: broken,
    startDate: row.start_date,
    endDate: row.end_date,
    stage: isBrickStage(row.stage) ? row.stage : 'molding',
    // Une fiche annulée porte `status = 'cancelled'` **et** le tombstone : on
    // dérive le statut du tombstone quand la colonne n'a pas suivi, pour ne
    // jamais afficher « Enregistrée » sur un lot annulé.
    status: isCancelled
      ? 'cancelled'
      : isBrickProductionStatus(row.status)
        ? row.status
        : 'registered',
    team: row.team ?? null,
    materialCost,
    laborCost,
    expenseCost,
    totalCost,
    unitCost: good > 0 ? Math.round((totalCost / good) * 100) / 100 : 0,
    stored: Number(row.stored_count ?? 0) > 0,
    materialsCount: Number(row.materials_count ?? 0),
    workersCount: Number(row.workers_count ?? 0),
    expensesCount: Number(row.expenses_count ?? 0),
    userId: row.user_id,
    userName: row.user_name,
    notes: row.notes,
    isCancelled,
    cancelReason: row.cancel_reason ?? null,
    cancelledAt: row.cancelled_at ? new Date(Number(row.cancelled_at) * 1000) : null,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

/** Date métier du lot : `start_date`, avec repli sur la date de création. */
const PRODUCTION_DATE = "COALESCE(p.start_date, date(p.created_at, 'unixepoch'))";

export async function listBrickProductions(
  options: BrickProductionListOptions = {},
): Promise<{ data: BrickProductionRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  /*
   * Le filtre de statut commande le traitement du tombstone : par défaut un lot
   * annulé disparaît des listes (`deleted_at IS NULL`), mais si l'utilisateur
   * **demande** les annulés, il faut au contraire les inclure — sinon le filtre
   * « Annulée » serait toujours vide, ce qui est le pire des mensonges.
   */
  if (options.status === 'cancelled') {
    where.push("(p.status = 'cancelled' OR p.deleted_at IS NOT NULL)");
  } else {
    where.push('p.deleted_at IS NULL');
    if (isBrickProductionStatus(options.status)) {
      where.push('p.status = ?');
      args.push(options.status);
    }
  }

  if (options.search) {
    where.push('(p.batch_number LIKE ? OR bt.name LIKE ? OR p.notes LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
  }
  if (options.brickTypeId) {
    where.push('p.brick_type_id = ?');
    args.push(options.brickTypeId);
  }
  if (isBrickStage(options.stage)) {
    where.push('p.stage = ?');
    args.push(options.stage);
  }
  if (isBrickProductionStatus(options.status)) {
    // Traité plus haut : le filtre de statut décide aussi du tombstone.
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
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM brick_productions p
     INNER JOIN brick_types bt ON bt.id = p.brick_type_id
     ${whereSql}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapProductionRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function getBrickProductionRow(id: number): Promise<BrickProductionRow | null> {
  const row = await rawGet<any>(`${PRODUCTION_SELECT} WHERE p.id = ?`, [id]);
  return row ? mapProductionRow(row) : null;
}

export async function listProductionMaterials(productionId: number): Promise<BrickProductionMaterialRow[]> {
  const rows = await db
    .select()
    .from(brickProductionMaterials)
    .where(eq(brickProductionMaterials.productionId, productionId))
    .orderBy(asc(brickProductionMaterials.id));

  return rows.map((row) => ({
    id: row.id,
    productionId: row.productionId,
    productId: row.productId,
    productName: row.productName,
    unit: row.unit,
    quantity: Number(row.quantity),
    unitCost: Number(row.unitCost),
    amount: Number(row.amount),
    createdAt: row.createdAt,
  }));
}

export async function listProductionWorkers(productionId: number): Promise<BrickProductionWorkerRow[]> {
  const rows = await db
    .select()
    .from(brickProductionWorkers)
    .where(eq(brickProductionWorkers.productionId, productionId))
    .orderBy(asc(brickProductionWorkers.id));

  return rows.map((row) => ({
    id: row.id,
    productionId: row.productionId,
    workerId: row.workerId,
    workerName: row.workerName,
    role: row.role,
    days: Number(row.days),
    dailyRate: Number(row.dailyRate),
    amount: Number(row.amount),
    createdAt: row.createdAt,
  }));
}

/**
 * Coût de revient — **calculé**, jamais stocké (§20).
 *
 * Trois composantes, dans cet ordre :
 *  1. `materialCost` — **héritage** : les lignes de `brick_production_materials`
 *     des lots saisis avant la révision §20 (les matières premières ne sont plus
 *     un module : elles sont devenues des dépenses rattachées). On continue de
 *     les compter pour qu'un lot historique garde son coût réel.
 *  2. `laborCost` — les affectations d'équipe (`days × daily_rate`).
 *  3. `expenseCost` — les **dépenses rattachées** (`expenses`), qui portent
 *     désormais le ciment, le sable, le carburant, l'électricité…
 */
export function computeProductionCosts(
  production: BrickProductionRow,
  materials: BrickProductionMaterialRow[],
  workers: BrickProductionWorkerRow[],
  expenses: BrickProductionExpenseRow[] = [],
): ProductionCosts {
  const materialCost = roundMoney(materials.reduce((sum, m) => sum + m.amount, 0));
  const laborCost = roundMoney(workers.reduce((sum, w) => sum + w.amount, 0));
  const expenseCost = roundMoney(expenses.reduce((sum, e) => sum + e.amount, 0));
  const totalCost = roundMoney(materialCost + laborCost + expenseCost);
  const good = roundMoney(production.producedQuantity - production.brokenQuantity);

  return {
    materialCost,
    laborCost,
    expenseCost,
    totalCost,
    producedQuantity: production.producedQuantity,
    brokenQuantity: production.brokenQuantity,
    goodQuantity: good,
    unitCost: good > 0 ? Math.round((totalCost / good) * 100) / 100 : 0,
  };
}

export async function getBrickProduction(id: number): Promise<BrickProductionDetail | null> {
  const production = await getBrickProductionRow(id);
  if (!production) return null;

  const [brickType, materials, workers, expenses] = await Promise.all([
    getBrickType(production.brickTypeId),
    listProductionMaterials(id),
    listProductionWorkers(id),
    listProductionExpenses(id),
  ]);

  const productRow = await rawGet<{
    id: number;
    name: string;
    unit: string;
    stock: number;
    sale_price: number;
  }>('SELECT id, name, unit, stock, sale_price FROM products WHERE id = ?', [production.productId]);

  return {
    production,
    brickType,
    product: productRow
      ? {
          id: Number(productRow.id),
          name: productRow.name,
          unit: productRow.unit,
          stock: Number(productRow.stock ?? 0),
          salePrice: Number(productRow.sale_price ?? 0),
        }
      : null,
    materials,
    workers,
    expenses,
    costs: computeProductionCosts(production, materials, workers, expenses),
  };
}

export async function getProductionCost(id: number): Promise<ProductionCosts> {
  const production = await getBrickProductionRow(id);
  if (!production) throw new NotFoundError('Lot de fabrication introuvable');

  const [materials, workers, expenses] = await Promise.all([
    listProductionMaterials(id),
    listProductionWorkers(id),
    listProductionExpenses(id),
  ]);

  return computeProductionCosts(production, materials, workers, expenses);
}

/* ------------------------------------------------------------------ *
 * Dépenses rattachées à un lot (§20)
 * ------------------------------------------------------------------ */

/**
 * Les dépenses d'un lot sont des lignes de `expenses` portant
 * `reference_type = 'brick_production'` et `reference_id = <lot>`.
 *
 * Ce choix est structurant : **il n'y a pas de module de matières premières**.
 * Le ciment, le sable, le carburant ou la main-d'œuvre ponctuelle sont des
 * dépenses — elles sortent de la caisse (`lib/expenses.ts` s'en charge), elles
 * s'annulent avec un motif, elles sont synchronisées et elles apparaissent dans
 * les rapports par catégorie. Le lot ne fait que les **rattacher à lui-même**.
 */
export async function listProductionExpenses(
  productionId: number,
  options: { includeCancelled?: boolean } = {},
): Promise<BrickProductionExpenseRow[]> {
  const where = options.includeCancelled ? '' : 'AND e.deleted_at IS NULL';
  const rows = await rawAll<any>(
    `SELECT e.id, e.category, e.amount, e.description, e.payment_method, e.beneficiary,
            e.date, e.reference_id, e.user_id, e.created_at, e.deleted_at, u.name AS user_name
     FROM expenses e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.reference_type = 'brick_production' AND e.reference_id = ? ${where}
     ORDER BY e.date ASC, e.id ASC`,
    [productionId],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    productionId: Number(row.reference_id),
    category: row.category,
    description: row.description ?? null,
    amount: Number(row.amount ?? 0),
    paymentMethod: row.payment_method ?? 'Espèces',
    beneficiary: row.beneficiary ?? null,
    date: row.date,
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name ?? null,
    cancelled: row.deleted_at != null,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  }));
}

/**
 * Ajoute une dépense à la fiche — **interdit sur un lot annulé**.
 *
 * La validation de catégorie est celle de la portée `production` (liste métier
 * ciment/sable/carburant/main-d'œuvre…), pas celle des paramètres.
 */
export async function addProductionExpense(
  productionId: number,
  input: BrickProductionExpenseInput,
): Promise<BrickProductionExpenseRow> {
  const production = await assertProductionEditable(productionId);

  const expense = await createExpense({
    category: input.category,
    amount: input.amount,
    description: input.description ?? null,
    paymentMethod: input.paymentMethod,
    beneficiary: input.beneficiary ?? null,
    date: input.date,
    scope: 'production',
    referenceType: PRODUCTION_EXPENSE_REFERENCE,
    referenceId: productionId,
    userId: input.userId ?? null,
  });

  await syncProductionCosts(productionId);

  return {
    id: expense.id,
    productionId,
    category: expense.category,
    description: expense.description,
    amount: expense.amount,
    paymentMethod: expense.paymentMethod,
    beneficiary: expense.beneficiary,
    date: expense.date,
    userId: expense.userId,
    userName: expense.userName,
    cancelled: expense.cancelled,
    createdAt: expense.createdAt,
  };
}

/** Modifie une dépense du lot — le montant recalcule le coût total de la fiche. */
export async function updateProductionExpense(
  productionId: number,
  expenseId: number,
  patch: {
    category?: string;
    amount?: number;
    description?: string | null;
    paymentMethod?: string;
    beneficiary?: string | null;
    date?: string;
  },
  options: { userId?: number | null } = {},
): Promise<BrickProductionExpenseRow> {
  await assertProductionEditable(productionId);

  const expense = await getExpense(expenseId);
  if (!expense) throw new NotFoundError('Dépense introuvable');
  if (expense.referenceType !== PRODUCTION_EXPENSE_REFERENCE || expense.referenceId !== productionId) {
    throw new ValidationError('Cette dépense n’est pas rattachée à ce lot de fabrication');
  }

  const updated = await updateExpense(
    expenseId,
    {
      category: patch.category,
      amount: patch.amount,
      description: patch.description,
      paymentMethod: patch.paymentMethod,
      beneficiary: patch.beneficiary,
      date: patch.date,
    },
    { userId: options.userId ?? null },
  );

  await syncProductionCosts(productionId);

  return {
    id: updated.id,
    productionId,
    category: updated.category,
    description: updated.description,
    amount: updated.amount,
    paymentMethod: updated.paymentMethod,
    beneficiary: updated.beneficiary,
    date: updated.date,
    userId: updated.userId,
    userName: updated.userName,
    cancelled: updated.cancelled,
    createdAt: updated.createdAt,
  };
}

/**
 * Retire une dépense du lot : **annulation motivée**, jamais de suppression
 * (§7). L'argent revient en caisse par le mouvement inverse de `lib/expenses.ts`.
 */
export async function removeProductionExpense(
  productionId: number,
  expenseId: number,
  reason: string,
  options: { userId?: number | null } = {},
): Promise<BrickProductionRow> {
  await assertProductionEditable(productionId);

  const expense = await getExpense(expenseId);
  if (!expense) throw new NotFoundError('Dépense introuvable');
  if (expense.referenceType !== PRODUCTION_EXPENSE_REFERENCE || expense.referenceId !== productionId) {
    throw new ValidationError('Cette dépense n’est pas rattachée à ce lot de fabrication');
  }

  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif de retrait de la dépense est obligatoire');

  await cancelExpense(expenseId, { reason: motif, userId: options.userId ?? null });
  await syncProductionCosts(productionId);

  const result = await getBrickProductionRow(productionId);
  if (!result) throw new NotFoundError('Lot de fabrication introuvable');
  return result;
}

/* ------------------------------------------------------------------ *
 * Synthèse (cartes de la page /briqueterie)
 * ------------------------------------------------------------------ */

/**
 * Rapport fabriquées / cassées / vendues sur une période (README §20).
 *
 * « Vendues » se lit dans les **factures de vente actives** dont le produit est
 * un produit de brique : c'est la seule source de vérité du stock de briques
 * finies (§15).
 */
export async function getBrickSummary(options: { from?: string; to?: string } = {}): Promise<BrickSummary> {
  const from = options.from ?? null;
  const to = options.to ?? null;

  const prodWhere: string[] = ['p.deleted_at IS NULL'];
  const prodArgs: (string | number)[] = [];
  if (from) {
    prodWhere.push(`${PRODUCTION_DATE} >= ?`);
    prodArgs.push(from);
  }
  if (to) {
    prodWhere.push(`${PRODUCTION_DATE} <= ?`);
    prodArgs.push(to);
  }

  const productions = await rawAll<{
    brick_type_id: number;
    brick_type_name: string;
    lots: number;
    produced: number | null;
    broken: number | null;
    material_cost: number | null;
    labor_cost: number | null;
    expense_cost: number | null;
    total_cost: number | null;
  }>(
    `SELECT p.brick_type_id, bt.name AS brick_type_name,
            COUNT(*) AS lots,
            SUM(p.produced_quantity) AS produced,
            SUM(p.broken_quantity) AS broken,
            SUM(p.material_cost) AS material_cost,
            SUM(p.labor_cost) AS labor_cost,
            SUM(p.expense_cost) AS expense_cost,
            SUM(p.total_cost) AS total_cost
     FROM brick_productions p
     INNER JOIN brick_types bt ON bt.id = p.brick_type_id
     WHERE ${prodWhere.join(' AND ')}
     GROUP BY p.brick_type_id, bt.name`,
    prodArgs,
  );

  /*
   * Dépenses rattachées aux lots de la période. On les additionne via une
   * sous-requête sur les **mêmes** bornes que les lots : une dépense de
   * production peut porter une date de saisie différente de la date du lot, et
   * c'est le lot qui définit la période de rattachement.
   */
  const expenseTotal = await rawGet<{ total: number | null }>(
    `SELECT COALESCE(SUM(e.amount), 0) AS total
     FROM expenses e
     WHERE e.deleted_at IS NULL
       AND e.reference_type = ?
       AND e.reference_id IN (SELECT p.id FROM brick_productions p WHERE ${prodWhere.join(' AND ')})`,
    [PRODUCTION_EXPENSE_REFERENCE, ...prodArgs],
  );

  const salesWhere: string[] = ["v.status = 'active'", 'i.product_id IN (SELECT product_id FROM brick_types)'];
  const salesArgs: (string | number)[] = [];
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
     FROM sales_invoice_items i
     INNER JOIN sales_invoices v ON v.id = i.invoice_id
     WHERE ${salesWhere.join(' AND ')}
     GROUP BY i.product_id`,
    salesArgs,
  );

  // `product_id` (brique) → identité du type de brique
  const productToType = await rawAll<{ id: number; product_id: number; name: string }>(
    'SELECT id, product_id, name FROM brick_types',
  );
  const typeByProduct = new Map<number, { id: number; name: string }>();
  const typeNameById = new Map<number, string>();
  for (const row of productToType) {
    const type = { id: Number(row.id), name: row.name };
    typeByProduct.set(Number(row.product_id), type);
    typeNameById.set(type.id, type.name);
  }

  const soldByType = new Map<number, number>();
  let sold = 0;
  let soldRevenue = 0;
  for (const row of sales) {
    const quantity = Number(row.quantity ?? 0);
    sold += quantity;
    soldRevenue += Number(row.revenue ?? 0);
    const type = typeByProduct.get(Number(row.product_id));
    if (type) soldByType.set(type.id, (soldByType.get(type.id) ?? 0) + quantity);
  }

  const byTypeMap = new Map<number, BrickSummary['byType'][number]>();
  let produced = 0;
  let broken = 0;
  let materialsCost = 0;
  let laborCost = 0;
  let expensesCost = Number(expenseTotal?.total ?? 0);
  let productionsCount = 0;

  for (const row of productions) {
    const typeId = Number(row.brick_type_id);
    const typeProduced = Number(row.produced ?? 0);
    const typeBroken = Number(row.broken ?? 0);
    const typeCost = Number(row.total_cost ?? 0);
    const good = roundMoney(typeProduced - typeBroken);

    produced += typeProduced;
    broken += typeBroken;
    materialsCost += Number(row.material_cost ?? 0);
    laborCost += Number(row.labor_cost ?? 0);
    productionsCount += Number(row.lots ?? 0);

    byTypeMap.set(typeId, {
      brickTypeId: typeId,
      brickTypeName: row.brick_type_name,
      produced: typeProduced,
      broken: typeBroken,
      sold: soldByType.get(typeId) ?? 0,
      unitCost: good > 0 ? Math.round((typeCost / good) * 100) / 100 : 0,
    });
  }

  // Un type vendu sans fabrication sur la période doit tout de même apparaître :
  // sinon un rapport « vendues » afficherait un total sans ligne.
  for (const [typeId, quantity] of soldByType) {
    if (byTypeMap.has(typeId)) continue;
    byTypeMap.set(typeId, {
      brickTypeId: typeId,
      brickTypeName: typeNameById.get(typeId) ?? `Type #${typeId}`,
      produced: 0,
      broken: 0,
      sold: quantity,
      unitCost: 0,
    });
  }

  const totalCost = roundMoney(materialsCost + laborCost + expensesCost);
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
    materialsCost: roundMoney(materialsCost),
    laborCost: roundMoney(laborCost),
    expensesCost: roundMoney(expensesCost),
    totalCost,
    averageUnitCost: good > 0 ? Math.round((totalCost / good) * 100) / 100 : 0,
    byType: Array.from(byTypeMap.values()).sort((a, b) =>
      a.brickTypeName.localeCompare(b.brickTypeName, 'fr'),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Écriture
 * ------------------------------------------------------------------ */

async function assertProductionEditable(id: number): Promise<BrickProductionRow> {
  const production = await getBrickProductionRow(id);
  if (!production) throw new NotFoundError('Lot de fabrication introuvable');
  if (production.isCancelled) {
    throw new ConflictError('Ce lot est annulé : il n’accepte plus aucune modification.');
  }
  return production;
}

function cleanDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError('Les dates doivent être au format AAAA-MM-JJ');
  }
  return text;
}

/**
 * Un mouvement `entry` de briques finies existe-t-il déjà pour ce lot ?
 * C'est le verrou (b) de l'unicité du crédit de stock.
 */
async function finishedGoodsCredited(productionId: number): Promise<boolean> {
  const row = await rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stock_movements
     WHERE reference_type = 'brick_production' AND reference_id = ? AND type = 'entry'`,
    [productionId],
  );
  return Number(row?.c ?? 0) > 0;
}

/**
 * La sortie de stock d'une ligne de matière première a-t-elle déjà eu lieu ?
 * Le motif porte `(ligne #<id>)`, ce qui rend la vérification explicite et
 * auditable dans le journal de stock.
 */
async function materialExitExists(productionId: number, materialId: number): Promise<boolean> {
  const row = await rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stock_movements
     WHERE reference_type = 'brick_production' AND reference_id = ? AND type = 'exit' AND motif LIKE ?`,
    [productionId, `%(ligne #${materialId})%`],
  );
  return Number(row?.c ?? 0) > 0;
}

/**
 * Miroir des colonnes de coût du lot (`material_cost`, `labor_cost`,
 * `expense_cost`, `total_cost`).
 *
 * ⚠️ Le **coût de revient unitaire** n'est jamais stocké (§6.5 règle 6) : seules
 * ces quatre colonnes, qui sont la somme de lignes réelles, sont écrites — elles
 * servent aux agrégats SQL des rapports et sont recalculées ici à chaque
 * écriture de ligne.
 */
async function syncProductionCosts(productionId: number): Promise<void> {
  const materials = await rawGet<{ total: number | null }>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM brick_production_materials WHERE production_id = ?',
    [productionId],
  );
  const workers = await rawGet<{ total: number | null }>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM brick_production_workers WHERE production_id = ?',
    [productionId],
  );
  const expenseRow = await rawGet<{ total: number | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
     WHERE reference_type = ? AND reference_id = ? AND deleted_at IS NULL`,
    [PRODUCTION_EXPENSE_REFERENCE, productionId],
  );

  const materialCost = roundMoney(Number(materials?.total ?? 0));
  const laborCost = roundMoney(Number(workers?.total ?? 0));
  const expenseCost = roundMoney(Number(expenseRow?.total ?? 0));

  await db
    .update(brickProductions)
    .set({
      materialCost,
      laborCost,
      expenseCost,
      totalCost: roundMoney(materialCost + laborCost + expenseCost),
      updatedAt: new Date(),
    })
    .where(eq(brickProductions.id, productionId));

  await enqueueSyncWrite('brick_productions', null, 'update', {
    material_cost: materialCost,
    labor_cost: laborCost,
    expense_cost: expenseCost,
    total_cost: roundMoney(materialCost + laborCost + expenseCost),
  });
}

/** Numéro `BRI-2026-000001` puis création du lot. */
export async function createBrickProduction(input: BrickProductionInput): Promise<BrickProductionRow> {
  const brickTypeId = Number(input.brickTypeId);
  if (!Number.isInteger(brickTypeId) || brickTypeId <= 0) {
    throw new ValidationError('Le type de brique est obligatoire');
  }

  const brickType = await getBrickType(brickTypeId);
  if (!brickType) throw new NotFoundError('Type de brique introuvable');

  const plannedQuantity = Number(input.plannedQuantity ?? 0) || 0;
  if (plannedQuantity < 0) throw new ValidationError('La quantité prévue ne peut pas être négative');

  const batchNumber = await nextDocumentNumber('brick');

  const inserted = await db
    .insert(brickProductions)
    .values({
      batchNumber,
      brickTypeId,
      plannedQuantity,
      producedQuantity: Number(input.producedQuantity ?? 0) || 0,
      brokenQuantity: Number(input.brokenQuantity ?? 0) || 0,
      startDate: cleanDate(input.startDate) ?? today(),
      endDate: cleanDate(input.endDate),
      stage: 'molding',
      status: 'registered',
      team: input.team?.trim() || null,
      materialCost: 0,
      laborCost: 0,
      expenseCost: 0,
      totalCost: 0,
      userId: input.userId ?? null,
      notes: input.notes?.trim() || null,
    })
    .returning({ id: brickProductions.id, syncId: brickProductions.syncId });

  await enqueueSyncWrite('brick_productions', inserted[0]?.syncId, 'insert', {
    batch_number: batchNumber,
    brick_type_id: brickTypeId,
    planned_quantity: plannedQuantity,
    stage: 'molding',
    status: 'registered',
    team: input.team?.trim() || null,
  });

  const created = await getBrickProductionRow(inserted[0].id);
  if (!created) throw new NotFoundError('Lot créé mais introuvable');
  return created;
}

/**
 * Modification du lot : quantités, coûts (dérivés), dates, notes.
 *
 * ⚠️ Une fois le lot **mis en stock** (`stored`), ses quantités ne sont plus
 * modifiables : le stock de briques finies a déjà été crédité et le corriger
 * « en douce » le ferait diverger du journal. Les pertes constatées après coup
 * passent par `registerBroken()`.
 */
export async function updateBrickProduction(
  id: number,
  patch: BrickProductionPatch,
): Promise<BrickProductionRow> {
  const production = await assertProductionEditable(id);

  const values: Record<string, unknown> = { updatedAt: new Date() };
  const touchesQuantity =
    patch.producedQuantity !== undefined || patch.brokenQuantity !== undefined;

  if (touchesQuantity && production.stored) {
    throw new ConflictError(
      'Ce lot est déjà mis en stock : ses quantités ne sont plus modifiables. Enregistrez une perte si des briques se sont cassées.',
    );
  }

  if (patch.plannedQuantity !== undefined) {
    const planned = Number(patch.plannedQuantity) || 0;
    if (planned < 0) throw new ValidationError('La quantité prévue ne peut pas être négative');
    values.plannedQuantity = planned;
  }
  if (patch.producedQuantity !== undefined) {
    const produced = Number(patch.producedQuantity) || 0;
    if (produced < 0) throw new ValidationError('La quantité produite ne peut pas être négative');
    values.producedQuantity = produced;
  }
  if (patch.brokenQuantity !== undefined) {
    const broken = Number(patch.brokenQuantity) || 0;
    if (broken < 0) throw new ValidationError('La quantité cassée ne peut pas être négative');
    values.brokenQuantity = broken;
  }
  if (patch.startDate !== undefined) values.startDate = cleanDate(patch.startDate);
  if (patch.endDate !== undefined) values.endDate = cleanDate(patch.endDate);
  if (patch.team !== undefined) values.team = patch.team?.trim() || null;
  if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;

  if (
    (patch.producedQuantity !== undefined || patch.brokenQuantity !== undefined) &&
    Number(values.brokenQuantity ?? production.brokenQuantity) >
      Number(values.producedQuantity ?? production.producedQuantity)
  ) {
    throw new ValidationError('Les briques cassées ne peuvent pas dépasser la quantité produite');
  }

  const updated = await db
    .update(brickProductions)
    .set(values as any)
    .where(eq(brickProductions.id, id))
    .returning({ id: brickProductions.id, syncId: brickProductions.syncId });

  if (updated.length === 0) throw new NotFoundError('Lot de fabrication introuvable');

  await enqueueSyncWrite('brick_productions', updated[0].syncId, 'update', values);

  const result = await getBrickProductionRow(id);
  if (!result) throw new NotFoundError('Lot de fabrication introuvable après modification');
  return result;
}

/**
 * Avance l'étape du lot : `molding → drying → firing → stored`.
 *
 * Mouvements de stock gérés ici :
 *  - **sortie des matières premières** : chaque ligne de
 *    `brick_production_materials` doit avoir son mouvement `exit`
 *    (`reference_type = 'brick_production'`). Normalement créé au moment de
 *    l'ajout de la ligne ; cette fonction **vérifie et rattrape** les lignes non
 *    déduites, sans jamais déduire deux fois (vérification par le motif
 *    `(ligne #<id>)`).
 *  - **entrée en stock des briques finies** à l'étape `stored`, **une seule
 *    fois** : transitions strictement croissantes + vérification de l'absence
 *    d'un mouvement `entry` pour ce lot. Les briques cassées connues à cet
 *    instant sortent dans la foulée par un `exit` motivé.
 */
export async function advanceStage(id: number, stage: BrickStage): Promise<BrickProductionRow> {
  if (!isBrickStage(stage)) throw new ValidationError('Étape de fabrication invalide');

  const production = await assertProductionEditable(id);

  const currentIndex = BRICK_STAGES.indexOf(production.stage);
  const targetIndex = BRICK_STAGES.indexOf(stage);

  if (targetIndex <= currentIndex) {
    throw new ValidationError(
      `Le lot est déjà à l’étape « ${production.stage} » : une fabrication ne revient pas en arrière.`,
    );
  }

  // (1) Matières premières : rattrapage idempotent des sorties non enregistrées.
  const materials = await listProductionMaterials(id);
  for (const material of materials) {
    if (!material.productId) continue;
    if (await materialExitExists(id, material.id)) continue;
    await addStockMovement(material.productId, 'exit', material.quantity, {
      referenceType: 'brick_production',
      referenceId: id,
      motif: `production ${production.batchNumber} : ${material.productName} (ligne #${material.id})`,
    });
  }

  // (2) Briques finies : crédit unique à l'entrée dans `stored`.
  let storedNow = false;
  if (stage === 'stored') {
    const alreadyCredited = await finishedGoodsCredited(id);
    if (!alreadyCredited) {
      const goodBricks = roundMoney(production.producedQuantity);

      if (goodBricks > 0) {
        await addStockMovement(production.productId, 'entry', goodBricks, {
          referenceType: 'brick_production',
          referenceId: id,
          motif: `production ${production.batchNumber} : mise en stock`,
        });
      }

      const broken = roundMoney(production.brokenQuantity);
      if (broken > 0) {
        await addStockMovement(production.productId, 'exit', broken, {
          referenceType: 'brick_production',
          referenceId: id,
          motif: `briques cassées lot ${production.batchNumber}`,
        });
      }

      storedNow = true;
    }
  }

  const values: Record<string, unknown> = { stage, updatedAt: new Date() };
  if (stage === 'stored') {
    if (!production.endDate) values.endDate = today();
    // « Terminée » n'est pas un statut qu'on coche : c'est l'**entrée en stock**
    // qui le pose. Une fabrication est terminée quand ses briques sont vendables.
    values.status = 'finished';
  }

  await db.update(brickProductions).set(values as any).where(eq(brickProductions.id, id));

  await enqueueSyncWrite('brick_productions', null, 'update', {
    batch_number: production.batchNumber,
    stage,
    status: values.status ?? production.status,
    stored: storedNow,
  });

  await syncProductionCosts(id);

  const result = await getBrickProductionRow(id);
  if (!result) throw new NotFoundError('Lot de fabrication introuvable');
  return result;
}

export async function addProductionMaterial(
  productionId: number,
  input: { productId: number; quantity: number; unitCost?: number | null; userId?: number | null },
): Promise<BrickProductionMaterialRow> {
  const production = await assertProductionEditable(productionId);

  const productId = Number(input.productId);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new ValidationError('La matière première est obligatoire');
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
    .insert(brickProductionMaterials)
    .values({
      productionId,
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
      referenceType: 'brick_production',
      referenceId: productionId,
      motif: `production ${production.batchNumber} : ${product.name} (ligne #${row.id})`,
      userId: input.userId ?? null,
    });
  } catch (error) {
    await db.delete(brickProductionMaterials).where(eq(brickProductionMaterials.id, row.id));
    throw error;
  }

  await enqueueSyncWrite('brick_production_materials', row.syncId, 'insert', {
    batch_number: production.batchNumber,
    product_id: productId,
    product_name: product.name,
    unit: product.unit,
    quantity,
    unit_cost: unitCost,
    amount,
  });

  await syncProductionCosts(productionId);

  return {
    id: row.id,
    productionId: row.productionId,
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
 * Retire une ligne de matière première **et rend la matière au stock**
 * (`entry`), comme pour les chantiers : corriger une saisie ne doit pas
 * laisser de stock fantôme.
 */
export async function removeProductionMaterial(
  productionId: number,
  materialId: number,
): Promise<BrickProductionRow> {
  const production = await assertProductionEditable(productionId);

  const rows = await db
    .select()
    .from(brickProductionMaterials)
    .where(eq(brickProductionMaterials.id, materialId))
    .limit(1);

  const material = rows[0];
  if (!material || material.productionId !== productionId) {
    throw new NotFoundError('Ligne de matière première introuvable sur ce lot');
  }

  await db.delete(brickProductionMaterials).where(eq(brickProductionMaterials.id, materialId));

  if (material.productId) {
    await addStockMovement(material.productId, 'entry', Number(material.quantity), {
      referenceType: 'brick_production',
      referenceId: productionId,
      motif: `annulation ligne matière production ${production.batchNumber} : ${material.productName}`,
    });
  }

  await enqueueSyncWrite('brick_production_materials', material.syncId, 'delete', {
    batch_number: production.batchNumber,
    product_name: material.productName,
    quantity: Number(material.quantity),
    deleted_at: new Date().toISOString(),
  });

  await syncProductionCosts(productionId);

  const result = await getBrickProductionRow(productionId);
  if (!result) throw new NotFoundError('Lot de fabrication introuvable');
  return result;
}

/** Affecte un ouvrier : `amount = days × daily_rate`. */
export async function addProductionWorker(
  productionId: number,
  input: { workerId?: number | null; workerName?: string | null; role?: string | null; days: number; dailyRate?: number | null },
): Promise<BrickProductionWorkerRow> {
  const production = await assertProductionEditable(productionId);

  const days = Number(input.days);
  if (!Number.isFinite(days) || days <= 0) {
    throw new ValidationError('Le nombre de jours doit être strictement positif');
  }

  let workerId: number | null = null;
  let workerName = (input.workerName ?? '').trim();
  let role = input.role?.trim() || null;
  let dailyRate =
    input.dailyRate !== undefined && input.dailyRate !== null ? Number(input.dailyRate) : null;

  if (input.workerId) {
    const worker = await rawGet<{ id: number; name: string; role: string | null; daily_rate: number | null }>(
      'SELECT id, name, role, daily_rate FROM workers WHERE id = ?',
      [Number(input.workerId)],
    );
    if (!worker) throw new NotFoundError('Ouvrier introuvable');

    workerId = Number(worker.id);
    if (!workerName) workerName = worker.name;
    if (!role) role = worker.role;
    if (dailyRate === null) dailyRate = Number(worker.daily_rate ?? 0);
  }

  if (!workerName) throw new ValidationError('Le nom de l’ouvrier est obligatoire');

  const rate = roundMoney(Number(dailyRate ?? 0) || 0);
  if (rate < 0) throw new ValidationError('Le tarif journalier doit être positif');

  const amount = roundMoney(days * rate);

  const inserted = await db
    .insert(brickProductionWorkers)
    .values({ productionId, workerId, workerName, role, days, dailyRate: rate, amount })
    .returning();

  const row = inserted[0];

  await enqueueSyncWrite('brick_production_workers', row.syncId, 'insert', {
    batch_number: production.batchNumber,
    worker_id: workerId,
    worker_name: workerName,
    role,
    days,
    daily_rate: rate,
    amount,
  });

  await syncProductionCosts(productionId);

  return {
    id: row.id,
    productionId: row.productionId,
    workerId: row.workerId,
    workerName: row.workerName,
    role: row.role,
    days: Number(row.days),
    dailyRate: Number(row.dailyRate),
    amount: Number(row.amount),
    createdAt: row.createdAt,
  };
}

/** Retire une affectation — `workerId` = identifiant de la ligne d'affectation. */
export async function removeProductionWorker(
  productionId: number,
  workerId: number,
): Promise<BrickProductionRow> {
  const production = await assertProductionEditable(productionId);

  const rows = await db
    .select()
    .from(brickProductionWorkers)
    .where(eq(brickProductionWorkers.id, workerId))
    .limit(1);

  const assignment = rows[0];
  if (!assignment || assignment.productionId !== productionId) {
    throw new NotFoundError('Affectation introuvable sur ce lot');
  }

  await db.delete(brickProductionWorkers).where(eq(brickProductionWorkers.id, workerId));

  await enqueueSyncWrite('brick_production_workers', assignment.syncId, 'delete', {
    batch_number: production.batchNumber,
    worker_name: assignment.workerName,
    days: Number(assignment.days),
    deleted_at: new Date().toISOString(),
  });

  await syncProductionCosts(productionId);

  const result = await getBrickProductionRow(productionId);
  if (!result) throw new NotFoundError('Lot de fabrication introuvable');
  return result;
}

/**
 * Enregistre des briques cassées / ratées.
 *
 * Le mouvement `exit` motivé qui matérialise la perte est émis **quand les
 * briques sont effectivement en stock** :
 *  - lot déjà `stored` → `exit` immédiat de l'écart (le stock existe) ;
 *  - lot pas encore `stored` → seule `broken_quantity` augmente : le `exit` du
 *    total des pertes part avec l'entrée en stock, à l'étape `stored`
 *    (`advanceStage`). Émettre un `exit` avant toute entrée rendrait le stock
 *    négatif, ce que le moteur de stock refuse — à juste titre.
 */
export async function registerBroken(
  id: number,
  brokenQuantity: number,
  reason: string,
): Promise<BrickProductionRow> {
  const production = await assertProductionEditable(id);

  const additional = Number(brokenQuantity);
  if (!Number.isFinite(additional) || additional <= 0) {
    throw new ValidationError('La quantité cassée doit être strictement positive');
  }

  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif de la perte est obligatoire');

  const newBroken = roundMoney(production.brokenQuantity + additional);

  if (newBroken > production.producedQuantity) {
    throw new ValidationError(
      'Les briques cassées ne peuvent pas dépasser la quantité produite : mettez d’abord à jour la production.',
    );
  }

  let stockExitRecorded = false;

  if (production.stored) {
    await addStockMovement(production.productId, 'exit', additional, {
      referenceType: 'brick_production',
      referenceId: id,
      motif: `briques cassées lot ${production.batchNumber} : ${motif}`,
    });
    stockExitRecorded = true;
  }

  const stamp = `Perte de ${additional} brique(s) le ${today()} — motif : ${motif}`;
  const notes = production.notes ? `${production.notes}\n${stamp}` : stamp;

  await db
    .update(brickProductions)
    .set({ brokenQuantity: newBroken, notes, updatedAt: new Date() })
    .where(eq(brickProductions.id, id));

  await enqueueSyncWrite('brick_productions', null, 'update', {
    batch_number: production.batchNumber,
    broken_quantity: newBroken,
    reason: motif,
    stock_exit_recorded: stockExitRecorded,
  });

  const result = await getBrickProductionRow(id);
  if (!result) throw new NotFoundError('Lot de fabrication introuvable');
  return result;
}

/**
 * Annule un lot — **jamais de suppression physique** (§7).
 *
 * `brick_productions` n'a pas de colonne `status` : l'annulation pose le
 * tombstone `deleted_at` (le lot disparaît des listes, la ligne reste
 * synchronisable et traçable) et consigne le motif dans les notes.
 *
 * Le stock est **réversé** comme pour tout document annulé (§6.5 règle 4) :
 *  - les briques finies que ce lot a réellement mises en stock ressortent
 *    (mouvement `exit` égal au **solde net** du lot sur le produit lié, ce qui
 *    reste exact même après des pertes enregistrées) ;
 *  - les matières premières consommées sont rendues (`entry`).
 * L'opération est refusée sur un lot déjà annulé : la réversion n'a donc lieu
 * qu'une fois.
 */
export async function cancelBrickProduction(
  id: number,
  reason: string,
  user?: { id?: number | null; name?: string | null } | null,
): Promise<BrickProductionRow> {
  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire');

  const production = await getBrickProductionRow(id);
  if (!production) throw new NotFoundError('Lot de fabrication introuvable');
  if (production.isCancelled) throw new ConflictError('Ce lot est déjà annulé');

  // Solde net du lot sur le produit de briques finies (entrées − sorties).
  const balance = await rawGet<{ net: number | null }>(
    `SELECT COALESCE(
              SUM(CASE WHEN type = 'entry' THEN quantity ELSE -quantity END), 0
            ) AS net
     FROM stock_movements
     WHERE reference_type = 'brick_production' AND reference_id = ? AND product_id = ?`,
    [id, production.productId],
  );

  const net = roundMoney(Number(balance?.net ?? 0));
  if (net > 0) {
    await addStockMovement(production.productId, 'exit', net, {
      referenceType: 'brick_production',
      referenceId: id,
      motif: `annulation lot ${production.batchNumber} : ${motif}`,
      userId: user?.id ?? null,
    });
  }

  const materials = await listProductionMaterials(id);
  for (const material of materials) {
    if (!material.productId) continue;
    await addStockMovement(material.productId, 'entry', material.quantity, {
      referenceType: 'brick_production',
      referenceId: id,
      motif: `annulation lot ${production.batchNumber} : ${material.productName}`,
      userId: user?.id ?? null,
    });
  }

  const stamp = `Annulé le ${today()}${user?.name ? ` par ${user.name}` : ''} — motif : ${motif}`;
  const notes = production.notes ? `${production.notes}\n${stamp}` : stamp;

  await db
    .update(brickProductions)
    .set({
      notes,
      status: 'cancelled',
      cancelReason: motif,
      cancelledAt: new Date(),
      cancelledBy: user?.id ?? null,
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(brickProductions.id, id));

  await enqueueSyncWrite('brick_productions', null, 'delete', {
    batch_number: production.batchNumber,
    cancel_reason: motif,
    stock_reversed: net > 0,
    deleted_at: new Date().toISOString(),
  });

  const result = await getBrickProductionRow(id);
  if (!result) throw new NotFoundError('Lot de fabrication introuvable');
  return result;
}
