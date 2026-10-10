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
 *
 * **Filiales de production (README §31)** : ce module sert désormais toutes
 * les filiales (briqueterie, vitrerie, meubles…). Un « type de brique » est un
 * **modèle**, un « lot » une **production** ; chaque ligne porte `branch_id`.
 * Toute lecture est bornée aux filiales demandées (`branchIds`) et toute
 * écriture vérifie que le modèle ou la production appartient **à la filiale de
 * la route** — sans quoi on pourrait faire avancer la production d'une filiale
 * depuis l'espace d'une autre. Les étapes viennent de la filiale (`flow`).
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
import { branchSql, parseStages } from '@/lib/branches';
import type { ProductionBranch } from '@/lib/branches-shared';

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

/**
 * Matières **réellement sorties** pour une production `p` (SQL), chutes comprises
 * (README §31.4). Une ligne retirée (rendue au stock) porte `deleted_at`.
 */
export const MATERIAL_COST_SQL = `(SELECT COALESCE(SUM(m.amount), 0) FROM production_materials m
   WHERE m.production_id = p.id AND m.deleted_at IS NULL)`;

/** Coût total d'un lot `p` (SQL), jamais stocké : matières + équipe + dépenses. */
export const TOTAL_COST_SQL = `(${MATERIAL_COST_SQL} + ${LABOR_COST_SQL} + ${EXPENSE_COST_SQL})`;

/* ------------------------------------------------------------------ *
 * Types publics (formes de l'API, inchangées depuis la v1 + magasin)
 * ------------------------------------------------------------------ */

export type BrickTypeRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  branchId: number | null;
  branchName: string | null;
  productId: number;
  name: string;
  shape: BrickShape;
  dimensions: string | null;
  description: string | null;
  category: string | null;
  /** Unité de production (null = unité de vente du produit). */
  productionUnit: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  thickness: number | null;
  /** Seuil d'alerte effectif : celui du modèle, sinon celui du produit dans le magasin. */
  alertThreshold: number | null;
  /** Seuil propre au modèle (null = celui du produit). */
  ownAlertThreshold: number | null;
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
  category?: string | null;
  productionUnit?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  thickness?: number | null;
  alertThreshold?: number | null;
  isActive?: boolean;
};

export type BrickProductionRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  branchId: number | null;
  branchName: string | null;
  batchNumber: string;
  brickTypeId: number;
  brickTypeName: string;
  category: string | null;
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
  /** Clé d'étape de la filiale (`stored` = en stock). */
  stage: string;
  /** Libellé de l'étape dans la filiale (« Cuisson », « Découpe »…). */
  stageLabel: string;
  /** Rang de l'étape (0 = première) et nombre d'étapes, mise en stock comprise. */
  stageIndex: number;
  stageCount: number;
  /** Étape suivante (`null` une fois en stock). */
  nextStage: { key: string; label: string } | null;
  /** Libellé des pertes de la filiale (« Cassées », « Rebuts »…). */
  lossLabel: string;
  status: BrickProductionStatus;
  team: string | null;
  /** Matières sorties du stock (chutes comprises), README §31.4. */
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

export type ProductionMaterialRow = {
  id: number;
  productionId: number;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  wastageQuantity: number;
  unitCost: number;
  amount: number;
  userName: string | null;
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
  /** Matières sorties du stock pour cette production. */
  materials: ProductionMaterialRow[];
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
  /** Filiales lues (une seule depuis l'espace d'une filiale, plusieurs en vue consolidée). */
  branchIds: number[];
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

function optionalMeasure(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${label} : indiquez un nombre positif.`);
  return n;
}

/** Clé d'étape valable pour la filiale, sinon erreur lisible. */
export function assertStageOfBranch(branch: Pick<ProductionBranch, 'flow' | 'name'>, stage: unknown): string {
  const key = String(stage ?? '');
  if (!branch.flow.some((s) => s.key === key)) {
    throw new ValidationError(`Étape inconnue pour la filiale « ${branch.name} ».`);
  }
  return key;
}

/* ------------------------------------------------------------------ *
 * Types de briques
 * ------------------------------------------------------------------ */

const BRICK_TYPE_SELECT = `
  SELECT bt.id, bt.store_id, s.name AS store_name, bt.branch_id, br.name AS branch_name,
         bt.product_id, bt.name, bt.shape, bt.dimensions,
         bt.description, bt.category, bt.production_unit, bt.length, bt.width, bt.height, bt.thickness,
         COALESCE(bt.alert_threshold,
                  (SELECT ps.stock_min FROM product_stocks ps WHERE ps.product_id = bt.product_id AND ps.store_id = bt.store_id),
                  p.stock_min) AS alert_threshold,
         bt.alert_threshold AS own_alert_threshold,
         bt.is_active, bt.created_at,
         p.name AS product_name, p.unit AS product_unit, p.sale_price, p.purchase_price,
         COALESCE((SELECT ps.quantity FROM product_stocks ps WHERE ps.product_id = bt.product_id AND ps.store_id = bt.store_id), 0) AS stock,
         (SELECT COUNT(*) FROM brick_productions bp WHERE bp.brick_type_id = bt.id AND bp.status <> 'cancelled') AS productions_count
  FROM brick_types bt
  INNER JOIN products p ON p.id = bt.product_id
  LEFT JOIN stores s ON s.id = bt.store_id
  LEFT JOIN production_branches br ON br.id = bt.branch_id`;

function mapBrickTypeRow(row: any): BrickTypeRow {
  return {
    id: num(row.id),
    storeId: num(row.store_id),
    storeName: row.store_name ?? null,
    branchId: row.branch_id == null ? null : num(row.branch_id),
    branchName: row.branch_name ?? null,
    productId: num(row.product_id),
    name: row.name,
    shape: isBrickShape(row.shape) ? row.shape : 'solid',
    dimensions: row.dimensions ?? null,
    description: row.description ?? null,
    category: row.category ?? null,
    productionUnit: row.production_unit ?? null,
    length: row.length == null ? null : num(row.length),
    width: row.width == null ? null : num(row.width),
    height: row.height == null ? null : num(row.height),
    thickness: row.thickness == null ? null : num(row.thickness),
    alertThreshold: row.alert_threshold == null ? null : num(row.alert_threshold),
    ownAlertThreshold: row.own_alert_threshold == null ? null : num(row.own_alert_threshold),
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
  branchIds: number[];
  includeInactive?: boolean;
  sort?: 'recent' | 'name';
}): Promise<BrickTypeRow[]> {
  const where = [scopeSql('bt.store_id', options.scope), branchSql('bt.branch_id', options.branchIds)];
  if (!options.includeInactive) where.push('bt.is_active = 1');
  const orderBy = options.sort === 'name' ? 'bt.name COLLATE NOCASE, bt.id' : 'bt.created_at DESC, bt.id DESC';
  const rows = await rawAll<any>(`${BRICK_TYPE_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`);
  return rows.map(mapBrickTypeRow);
}

export async function getBrickType(id: number): Promise<BrickTypeRow | null> {
  const row = await rawGet<any>(`${BRICK_TYPE_SELECT} WHERE bt.id = ?`, [id]);
  return row ? mapBrickTypeRow(row) : null;
}

/** Le modèle doit exister, appartenir au magasin actif **et à la filiale**. */
export async function assertBrickTypeInStore(id: number, storeId: number, branchId: number): Promise<BrickTypeRow> {
  const type = await getBrickType(id);
  if (!type || type.branchId !== Number(branchId)) throw new NotFoundError('Modèle introuvable dans cette filiale');
  if (type.storeId !== Number(storeId)) {
    throw new ValidationError(
      `Le modèle « ${type.name} » appartient au magasin ${type.storeName ?? 'd’un autre magasin'} : il ne s’utilise que depuis ce magasin.`,
    );
  }
  return type;
}

/** Le produit lié doit exister et ne pas porter déjà un autre type actif du magasin. */
async function validateLinkedProduct(productId: number, storeId: number, exceptTypeId?: number): Promise<void> {
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new ValidationError('Le produit lié au modèle est obligatoire');
  }
  const product = await rawGet<{ id: number }>('SELECT id FROM products WHERE id = ?', [productId]);
  if (!product) throw new NotFoundError('Produit introuvable');
  const other = await rawGet<{ name: string }>(
    `SELECT name FROM brick_types WHERE product_id = ? AND store_id = ? AND is_active = 1 AND id <> ? LIMIT 1`,
    [productId, storeId, exceptTypeId ?? 0],
  );
  if (other) {
    throw new ValidationError(`Ce produit porte déjà le modèle « ${other.name} » : un produit = un modèle (il en porte le stock), toutes filiales confondues.`);
  }
}

export async function createBrickType(
  input: BrickTypeInput & { storeId: number; branchId: number; userId?: number | null },
): Promise<BrickTypeRow> {
  const productId = Number(input.productId);
  const name = (input.name ?? '').trim();
  if (!name) throw new ValidationError('Le nom du modèle est obligatoire');
  await validateLinkedProduct(productId, input.storeId);

  const inserted = await db
    .insert(brickTypes)
    .values({
      storeId: input.storeId,
      branchId: input.branchId,
      productId,
      name,
      shape: isBrickShape(input.shape) ? input.shape : 'solid',
      dimensions: input.dimensions?.trim() || null,
      description: input.description?.trim() || null,
      category: input.category?.trim() || null,
      productionUnit: input.productionUnit?.trim() || null,
      length: optionalMeasure(input.length, 'Longueur'),
      width: optionalMeasure(input.width, 'Largeur'),
      height: optionalMeasure(input.height, 'Hauteur'),
      thickness: optionalMeasure(input.thickness, 'Épaisseur'),
      alertThreshold: optionalMeasure(input.alertThreshold, 'Seuil d’alerte'),
      isActive: input.isActive ?? true,
      userId: input.userId ?? null,
    })
    .returning({ id: brickTypes.id });
  const created = await getBrickType(inserted[0].id);
  if (!created) throw new NotFoundError('Modèle créé mais introuvable');
  return created;
}

export async function updateBrickType(
  id: number,
  patch: Partial<BrickTypeInput>,
  storeId: number,
  branchId: number,
): Promise<BrickTypeRow> {
  const type = await assertBrickTypeInStore(id, storeId, branchId);
  const values: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.productId !== undefined && Number(patch.productId) !== type.productId) {
    // Changer le produit d'un type déjà fabriqué ferait « perdre » son stock.
    if (type.productionsCount > 0) {
      throw new ConflictError('Ce modèle a déjà des productions : son produit (qui porte le stock) ne se change plus.');
    }
    await validateLinkedProduct(Number(patch.productId), storeId, id);
    values.productId = Number(patch.productId);
  }
  if (patch.name !== undefined) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw new ValidationError('Le nom du modèle est obligatoire');
    values.name = name;
  }
  if (patch.shape !== undefined) {
    if (!isBrickShape(patch.shape)) throw new ValidationError('Forme de brique invalide');
    values.shape = patch.shape;
  }
  if (patch.dimensions !== undefined) values.dimensions = patch.dimensions?.trim() || null;
  if (patch.description !== undefined) values.description = patch.description?.trim() || null;
  if (patch.category !== undefined) values.category = patch.category?.trim() || null;
  if (patch.productionUnit !== undefined) values.productionUnit = patch.productionUnit?.trim() || null;
  if (patch.length !== undefined) values.length = optionalMeasure(patch.length, 'Longueur');
  if (patch.width !== undefined) values.width = optionalMeasure(patch.width, 'Largeur');
  if (patch.height !== undefined) values.height = optionalMeasure(patch.height, 'Hauteur');
  if (patch.thickness !== undefined) values.thickness = optionalMeasure(patch.thickness, 'Épaisseur');
  if (patch.alertThreshold !== undefined) values.alertThreshold = optionalMeasure(patch.alertThreshold, 'Seuil d’alerte');
  if (patch.isActive !== undefined) {
    if (patch.isActive) await validateLinkedProduct(type.productId, storeId, id);
    values.isActive = Boolean(patch.isActive);
  }

  await db.update(brickTypes).set(values as any).where(eq(brickTypes.id, id));
  const result = await getBrickType(id);
  if (!result) throw new NotFoundError('Modèle introuvable');
  return result;
}

/** Désactivation / réactivation — jamais de suppression. */
export async function setBrickTypeActive(id: number, isActive: boolean, storeId: number, branchId: number): Promise<BrickTypeRow> {
  return updateBrickType(id, { isActive }, storeId, branchId);
}

/* ------------------------------------------------------------------ *
 * Lots de fabrication — lecture
 * ------------------------------------------------------------------ */

const PRODUCTION_SELECT = `
  SELECT p.id, p.store_id, s.name AS store_name, p.branch_id, br.name AS branch_name,
         br.stages AS branch_stages, br.loss_label AS branch_loss_label,
         p.batch_number, p.brick_type_id,
         bt.name AS brick_type_name, bt.category, bt.shape, bt.dimensions,
         bt.product_id, pr.name AS product_name, pr.unit AS product_unit,
         p.planned_quantity, p.produced_quantity, p.broken_quantity,
         p.start_date, p.end_date, p.stage, p.status, p.team,
         p.cancel_reason, p.cancelled_at, cu.name AS cancelled_by_name,
         p.user_id, u.name AS user_name, p.notes, p.created_at,
         ${MATERIAL_COST_SQL} AS material_cost,
         ${LABOR_COST_SQL} AS labor_cost,
         ${EXPENSE_COST_SQL} AS expense_cost,
         (SELECT COUNT(*) FROM production_materials m WHERE m.production_id = p.id AND m.deleted_at IS NULL) AS materials_count,
         (SELECT COUNT(*) FROM brick_production_workers w WHERE w.production_id = p.id) AS workers_count,
         (SELECT COUNT(*) FROM expenses e
           WHERE e.reference_type = 'brick_production' AND e.reference_id = p.id AND e.deleted_at IS NULL) AS expenses_count,
         (SELECT COUNT(*) FROM stock_movements sm
           WHERE sm.reference_type = 'brick_production' AND sm.reference_id = p.id AND sm.type = 'entry') AS stored_count
  FROM brick_productions p
  INNER JOIN brick_types bt ON bt.id = p.brick_type_id
  INNER JOIN products pr ON pr.id = bt.product_id
  LEFT JOIN stores s ON s.id = p.store_id
  LEFT JOIN production_branches br ON br.id = p.branch_id
  LEFT JOIN users u ON u.id = p.user_id
  LEFT JOIN users cu ON cu.id = p.cancelled_by`;

function mapProductionRow(row: any): BrickProductionRow {
  const flow = [...parseStages(row.branch_stages), { key: 'stored', label: 'En stock' }];
  const stageKey = String(row.stage ?? '');
  const stageIndex = Math.max(0, flow.findIndex((s) => s.key === stageKey));
  const produced = num(row.produced_quantity);
  const broken = num(row.broken_quantity);
  const materialCost = roundMoney(num(row.material_cost));
  const laborCost = roundMoney(num(row.labor_cost));
  const expenseCost = roundMoney(num(row.expense_cost));
  const totalCost = roundMoney(materialCost + laborCost + expenseCost);
  const isCancelled = row.status === 'cancelled';
  return {
    id: num(row.id),
    storeId: num(row.store_id),
    storeName: row.store_name ?? null,
    branchId: row.branch_id == null ? null : num(row.branch_id),
    branchName: row.branch_name ?? null,
    batchNumber: row.batch_number,
    brickTypeId: num(row.brick_type_id),
    brickTypeName: row.brick_type_name,
    category: row.category ?? null,
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
    stage: stageKey,
    stageLabel: flow.find((s) => s.key === stageKey)?.label ?? stageKey,
    stageIndex,
    stageCount: flow.length,
    nextStage: row.status === 'registered' && stageIndex < flow.length - 1 ? flow[stageIndex + 1] : null,
    lossLabel: row.branch_loss_label || 'Pertes',
    status: isBrickProductionStatus(row.status) ? row.status : 'registered',
    team: row.team ?? null,
    materialCost,
    laborCost,
    expenseCost,
    totalCost,
    unitCost: unitCostOf(totalCost, roundMoney(produced - broken)),
    stored: num(row.stored_count) > 0,
    materialsCount: num(row.materials_count),
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
  const where: string[] = [scopeSql('p.store_id', options.scope), branchSql('p.branch_id', options.branchIds)];
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
  if (options.stage) {
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

/** Matières sorties pour la production (lignes retirées exclues). */
export async function listProductionMaterials(productionId: number): Promise<ProductionMaterialRow[]> {
  const rows = await rawAll<any>(
    `SELECT m.*, u.name AS user_name FROM production_materials m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.production_id = ? AND m.deleted_at IS NULL ORDER BY m.id`,
    [productionId],
  );
  return rows.map((row) => ({
    id: num(row.id),
    productionId: num(row.production_id),
    productId: row.product_id == null ? null : num(row.product_id),
    productName: row.product_name,
    unit: row.unit,
    quantity: num(row.quantity),
    wastageQuantity: num(row.wastage_quantity),
    unitCost: num(row.unit_cost),
    amount: roundMoney(num(row.amount)),
    userName: row.user_name ?? null,
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
  const [brickType, workers, expenses, materials] = await Promise.all([
    getBrickType(production.brickTypeId),
    listProductionWorkers(id),
    listProductionExpenses(id),
    listProductionMaterials(id),
  ]);
  const good = roundMoney(production.producedQuantity - production.brokenQuantity);
  return {
    production,
    brickType,
    product: brickType
      ? { id: brickType.productId, name: brickType.productName, unit: brickType.unit, stock: brickType.stock, salePrice: brickType.salePrice }
      : null,
    materials,
    workers,
    expenses,
    costs: {
      materialCost: production.materialCost,
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
export function hideProductionCosts<
  T extends { materialCost?: number | null; laborCost?: number | null; expenseCost?: number | null; totalCost?: number | null; unitCost?: number | null },
>(row: T): T {
  return { ...row, materialCost: null, laborCost: null, expenseCost: null, totalCost: null, unitCost: null };
}

/* ------------------------------------------------------------------ *
 * Synthèse « fabriquées / cassées / vendues »
 * ------------------------------------------------------------------ */

export async function getBrickSummary(options: { scope: StoreScope; branchIds: number[]; from?: string; to?: string }): Promise<BrickSummary> {
  const from = options.from ?? null;
  const to = options.to ?? null;
  const prodWhere = [`p.status <> 'cancelled'`, scopeSql('p.store_id', options.scope), branchSql('p.branch_id', options.branchIds)];
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
            SUM(${MATERIAL_COST_SQL}) AS material_cost,
            SUM(${LABOR_COST_SQL}) AS labor_cost, SUM(${EXPENSE_COST_SQL}) AS expense_cost
       FROM brick_productions p INNER JOIN brick_types bt ON bt.id = p.brick_type_id
      WHERE ${prodWhere.join(' AND ')}
      GROUP BY p.brick_type_id, bt.name`,
    prodArgs,
  );

  // Ventes de la filiale : factures **actives** du canal des filiales, de la portée.
  const salesWhere = [
    `v.status = 'active'`,
    `v.channel = 'brick'`,
    scopeSql('v.store_id', options.scope),
    branchSql('v.production_branch_id', options.branchIds),
  ];
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
    `SELECT bt.id, bt.product_id, bt.name FROM brick_types bt
      WHERE ${scopeSql('bt.store_id', options.scope)} AND ${branchSql('bt.branch_id', options.branchIds)}`,
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
  let materialsCost = 0;
  let laborCost = 0;
  let expensesCost = 0;
  let productionsCount = 0;
  for (const row of productions) {
    const typeId = num(row.brick_type_id);
    const typeProduced = num(row.produced);
    const typeBroken = num(row.broken);
    const typeCost = num(row.material_cost) + num(row.labor_cost) + num(row.expense_cost);
    produced += typeProduced;
    broken += typeBroken;
    materialsCost += num(row.material_cost);
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
    byType.set(typeId, { brickTypeId: typeId, brickTypeName: typeNameById.get(typeId) ?? `Modèle #${typeId}`, produced: 0, broken: 0, sold: quantity, unitCost: 0 });
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
    averageUnitCost: unitCostOf(totalCost, good),
    byType: Array.from(byType.values()).sort((a, b) => a.brickTypeName.localeCompare(b.brickTypeName, 'fr')),
  };
}

/* ------------------------------------------------------------------ *
 * Lots — écriture (magasin actif uniquement)
 * ------------------------------------------------------------------ */

export async function assertProductionEditable(id: number, storeId: number, branchId: number): Promise<BrickProductionRow> {
  const production = await getBrickProductionRow(id);
  if (!production || production.branchId !== Number(branchId)) throw new NotFoundError('Production introuvable dans cette filiale');
  if (production.storeId !== Number(storeId)) {
    throw new ValidationError(
      `Cette production appartient au magasin ${production.storeName ?? 'd’un autre magasin'} : elle ne se modifie que depuis ce magasin.`,
    );
  }
  if (production.isCancelled) throw new ConflictError('Cette production est annulée : elle n’accepte plus aucune modification.');
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

/**
 * Numéro au préfixe de la filiale (`BRI-KAL-2026-000001`, `VIT-…`) puis
 * création de la production, dans le magasin actif, à la **première étape** de
 * la filiale.
 */
export async function createBrickProduction(
  input: BrickProductionInput & { storeId: number; branch: ProductionBranch },
): Promise<BrickProductionRow> {
  return withTransaction(async () => {
    const branch = input.branch;
    const brickTypeId = Number(input.brickTypeId);
    if (!Number.isInteger(brickTypeId) || brickTypeId <= 0) throw new ValidationError('Le modèle est obligatoire');
    const type = await assertBrickTypeInStore(brickTypeId, input.storeId, branch.id);
    if (!type.isActive) throw new ValidationError(`Le modèle « ${type.name} » est désactivé : il ne sert plus à une nouvelle production.`);

    const plannedQuantity = num(input.plannedQuantity);
    const producedQuantity = num(input.producedQuantity);
    const brokenQuantity = num(input.brokenQuantity);
    if (plannedQuantity < 0 || producedQuantity < 0 || brokenQuantity < 0) {
      throw new ValidationError('Les quantités ne peuvent pas être négatives');
    }
    if (brokenQuantity > producedQuantity) {
      throw new ValidationError('Les pertes ne peuvent pas dépasser la quantité produite');
    }
    const startDate = cleanDate(input.startDate) ?? today();
    const endDate = cleanDate(input.endDate);
    if (endDate && endDate < startDate) throw new ValidationError('La date de fin ne peut pas précéder la date de début.');

    const inserted = await db
      .insert(brickProductions)
      .values({
        storeId: input.storeId,
        branchId: branch.id,
        batchNumber: await nextDocumentNumber('brick', input.storeId, { prefix: branch.batchPrefix }),
        brickTypeId,
        plannedQuantity,
        producedQuantity,
        brokenQuantity,
        startDate,
        endDate,
        stage: branch.flow[0].key,
        status: 'registered',
        team: input.team?.trim() || null,
        userId: input.userId ?? null,
        notes: input.notes?.trim() || null,
      })
      .returning({ id: brickProductions.id });
    const created = await getBrickProductionRow(inserted[0].id);
    if (!created) throw new NotFoundError('Production créée mais introuvable');
    return created;
  });
}

/**
 * Modification du lot. Une fois **mis en stock**, ses quantités ne bougent
 * plus (le journal de stock fait foi) : une perte constatée après coup passe
 * par `registerBroken()`.
 */
export async function updateBrickProduction(
  id: number,
  patch: BrickProductionPatch,
  storeId: number,
  branchId: number,
): Promise<BrickProductionRow> {
  return withTransaction(async () => {
    const production = await assertProductionEditable(id, storeId, branchId);
    const values: Record<string, unknown> = { updatedAt: new Date() };
    const touchesQuantity = patch.producedQuantity !== undefined || patch.brokenQuantity !== undefined;
    if (touchesQuantity && production.stored) {
      throw new ConflictError(
        'Cette production est déjà en stock : ses quantités ne sont plus modifiables. Enregistrez une perte si des pièces sont abîmées.',
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
    if (broken > produced) throw new ValidationError('Les pertes ne peuvent pas dépasser la quantité produite');
    if (patch.startDate !== undefined) values.startDate = cleanDate(patch.startDate) ?? production.startDate ?? today();
    if (patch.endDate !== undefined) values.endDate = cleanDate(patch.endDate);
    const start = String(values.startDate ?? production.startDate ?? '');
    const end = (values.endDate !== undefined ? values.endDate : production.endDate) as string | null;
    if (start && end && end < start) throw new ValidationError('La date de fin ne peut pas précéder la date de début.');
    if (patch.team !== undefined) values.team = patch.team?.trim() || null;
    if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;

    await db.update(brickProductions).set(values as any).where(eq(brickProductions.id, id));
    const result = await getBrickProductionRow(id);
    if (!result) throw new NotFoundError('Production introuvable');
    return result;
  });
}

/**
 * Avance la production dans les étapes **de sa filiale** (briqueterie :
 * `molding → drying → firing → stored`), sans retour. L'entrée dans `stored`
 * crédite le stock **une seule fois** des pièces produites, puis sort les
 * pertes connues (stock net = produites − pertes), et termine la production.
 */
export async function advanceStage(
  id: number,
  stage: string,
  storeId: number,
  userId: number | null | undefined,
  branch: ProductionBranch,
): Promise<BrickProductionRow> {
  const target = assertStageOfBranch(branch, stage);
  return withTransaction(async () => {
    const production = await assertProductionEditable(id, storeId, branch.id);
    const keys = branch.flow.map((s) => s.key);
    // Une étape retirée de la filiale compte comme « avant la première ».
    const currentIndex = keys.indexOf(production.stage);
    const targetIndex = keys.indexOf(target);
    if (targetIndex <= currentIndex) {
      const label = branch.flow[currentIndex]?.label ?? production.stage;
      throw new ValidationError(
        `La production est déjà à l’étape « ${label} » : une fabrication ne revient pas en arrière.`,
      );
    }

    const values: Record<string, unknown> = { stage: target, updatedAt: new Date() };
    if (target === 'stored') {
      if (production.producedQuantity <= 0) {
        throw new ValidationError('Indiquez la quantité produite avant de mettre la production en stock.');
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
            motif: `${branch.lossLabel.toLocaleLowerCase('fr')} production ${production.batchNumber}`,
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
    if (!result) throw new NotFoundError('Production introuvable');
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
  branchId: number,
): Promise<BrickProductionWorkerRow> {
  return withTransaction(async () => {
    await assertProductionEditable(productionId, storeId, branchId);
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
export async function removeProductionWorker(
  productionId: number,
  lineId: number,
  storeId: number,
  branchId: number,
): Promise<BrickProductionWorkerRow> {
  return withTransaction(async () => {
    await assertProductionEditable(productionId, storeId, branchId);
    const line = (await listProductionWorkers(productionId)).find((w) => w.id === lineId);
    if (!line) throw new NotFoundError('Affectation introuvable sur cette production');
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
  branchId: number,
): Promise<BrickProductionExpenseRow> {
  await assertProductionEditable(productionId, storeId, branchId);
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
    productionBranchId: branchId,
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
    throw new ValidationError('Cette dépense n’est pas rattachée à cette production');
  }
  return expense;
}

export async function updateProductionExpense(
  productionId: number,
  expenseId: number,
  patch: { category?: string; amount?: number; description?: string | null; paymentMethod?: string; beneficiary?: string | null; date?: string },
  options: { userId?: number | null; storeId: number; branchId: number; canSkipApproval?: boolean },
): Promise<BrickProductionExpenseRow> {
  await assertProductionEditable(productionId, options.storeId, options.branchId);
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
  options: { userId?: number | null; storeId: number; branchId: number },
): Promise<BrickProductionRow> {
  await assertProductionEditable(productionId, options.storeId, options.branchId);
  await assertExpenseOfProduction(productionId, expenseId);
  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif de retrait de la dépense est obligatoire');
  await cancelExpense(expenseId, { reason: motif, userId: options.userId ?? null, storeId: options.storeId });
  const result = await getBrickProductionRow(productionId);
  if (!result) throw new NotFoundError('Production introuvable');
  return result;
}

/**
 * Enregistre des pertes (briques cassées, vitres brisées, rebuts…). Production
 * déjà en stock : `exit` immédiat ; sinon seule la quantité perdue augmente et
 * sortira avec la mise en stock (un `exit` avant toute entrée rendrait le
 * stock négatif).
 */
export async function registerBroken(
  id: number,
  brokenQuantity: number,
  reason: string,
  storeId: number,
  userId: number | null | undefined,
  branch: ProductionBranch,
): Promise<BrickProductionRow> {
  return withTransaction(async () => {
    const production = await assertProductionEditable(id, storeId, branch.id);
    const additional = num(brokenQuantity);
    if (additional <= 0) throw new ValidationError('La quantité perdue doit être strictement positive');
    const motif = (reason ?? '').trim();
    if (!motif) throw new ValidationError('Le motif de la perte est obligatoire');
    const newBroken = roundMoney(production.brokenQuantity + additional);
    if (newBroken > production.producedQuantity) {
      throw new ValidationError('Les pertes ne peuvent pas dépasser la quantité produite : mettez d’abord à jour la production.');
    }
    if (production.stored) {
      await addStockMovement(production.productId, 'exit', additional, {
        storeId,
        referenceType: 'brick_production',
        referenceId: id,
        motif: `${branch.lossLabel.toLocaleLowerCase('fr')} production ${production.batchNumber} : ${motif}`,
        userId: userId ?? null,
      });
    }
    const stamp = `${branch.lossLabel} : ${additional} le ${today()} — motif : ${motif}`;
    await db
      .update(brickProductions)
      .set({ brokenQuantity: newBroken, notes: production.notes ? `${production.notes}\n${stamp}` : stamp, updatedAt: new Date() })
      .where(eq(brickProductions.id, id));
    const result = await getBrickProductionRow(id);
    if (!result) throw new NotFoundError('Production introuvable');
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
  branchId: number,
): Promise<BrickProductionRow> {
  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire');
  return withTransaction(async () => {
    const production = await assertProductionEditable(id, user.storeId, branchId);
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
        motif: `annulation production ${production.batchNumber} : ${motif}`,
        userId: user.id,
      });
    }
    // Matières sorties : rendues au stock avec leurs chutes (même règle que l'atelier, README §29).
    const materials = await listProductionMaterials(id);
    for (const material of materials) {
      const back = roundMoney(material.quantity + material.wastageQuantity);
      if (material.productId && back > 0) {
        await addStockMovement(material.productId, 'entry', back, {
          storeId: user.storeId,
          referenceType: 'production_material',
          referenceId: id,
          motif: `annulation production ${production.batchNumber} : retour ${material.productName}`,
          userId: user.id,
        });
      }
    }
    await db
      .update(brickProductions)
      .set({ status: 'cancelled', cancelReason: motif, cancelledAt: new Date(), cancelledBy: user.id, updatedAt: new Date() })
      .where(eq(brickProductions.id, id));
    const result = await getBrickProductionRow(id);
    if (!result) throw new NotFoundError('Production introuvable');
    return result;
  });
}
