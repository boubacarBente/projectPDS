/**
 * Atelier de meubles (README §21, §18 du cahier des charges).
 *
 * Trois idées portent tout ce module :
 *
 * 1. **La fiche modèle porte la nomenclature** (`furniture_model_materials`).
 *    Les besoins en matières d'une commande standard se **calculent** depuis
 *    cette nomenclature — on ne les ressaisit pas. C'est ce qui rend la fiche
 *    modèle utile, et c'est ce qui évite l'oubli d'un matériau.
 *
 * 2. **Le coût de revient est calculé, jamais saisi** : bois et matériaux
 *    (instantanés figés sur la ligne) + main-d'œuvre (`days × daily_rate`).
 *    Aucun total n'est stocké en dehors des colonnes d'agrégat du document,
 *    qui sont recalculées après chaque écriture (§6.5 règle 6).
 *
 * 3. **Le stock ne bouge que par `lib/stock.ts`** : une matière consommée est
 *    un `exit` motivé (`reference_type = 'furniture_order'`), les chutes de
 *    bois sont un **second** `exit` explicite, et le meuble fini entre en stock
 *    par un **unique** `entry` à la livraison.
 *
 * Règle 11 (synchronisation) : toute écriture appelle `enqueueSyncWrite`, et
 * **aucune** opération ne dépend de la synchronisation.
 */

import { db, rawAll, rawGet } from '@/db';
import {
  furnitureModelMaterials,
  furnitureModels,
  furnitureOrderMaterials,
  furnitureOrders,
  furnitureOrderWorkers,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueSyncWrite } from '@/lib/sync';
import { addStockMovement } from '@/lib/stock';
import { ValidationError } from '@/lib/api';
import { nextDocumentNumber } from '@/lib/settings';
import { roundMoney, today } from '@/lib/format';
import { DEFAULT_LIST_SORT, sqlOrderBy, type ListSort } from '@/lib/list-sort';

/* ------------------------------------------------------------------ *
 * Types publics
 * ------------------------------------------------------------------ */

/** Étapes d'atelier, dans l'ordre imposé par §21 (aucun saut possible). */
export const FURNITURE_STAGES = [
  'cutting',
  'assembly',
  'sanding',
  'painting',
  'finishing',
  'delivered',
] as const;

export type FurnitureStage = (typeof FURNITURE_STAGES)[number];

export const FURNITURE_STAGE_LABELS: Record<FurnitureStage, string> = {
  cutting: 'Découpe',
  assembly: 'Assemblage',
  sanding: 'Ponçage',
  painting: 'Peinture / vernis',
  finishing: 'Finition',
  delivered: 'Livré',
};

/** Étapes affichées par `StageTracker` — la clé doit rester stable. */
export const FURNITURE_STAGE_STEPS = FURNITURE_STAGES.map((stage) => ({
  key: stage as string,
  label: FURNITURE_STAGE_LABELS[stage],
}));

export function isFurnitureStage(value: unknown): value is FurnitureStage {
  return typeof value === 'string' && (FURNITURE_STAGES as readonly string[]).includes(value);
}

/** Index d'une étape ; `-1` si inconnue (une donnée abîmée ne doit pas planter). */
export function furnitureStageIndex(stage: string | null | undefined): number {
  return FURNITURE_STAGES.indexOf((stage ?? '') as FurnitureStage);
}

/** Étape suivante, ou `null` si la commande est déjà livrée. */
export function nextFurnitureStage(stage: string | null | undefined): FurnitureStage | null {
  const index = furnitureStageIndex(stage);
  if (index < 0 || index >= FURNITURE_STAGES.length - 1) return null;
  return FURNITURE_STAGES[index + 1];
}

export type FurnitureModelRow = {
  id: number;
  syncId: string;
  code: string;
  name: string;
  description: string | null;
  standardDimensions: string | null;
  laborHours: number;
  salePrice: number;
  isActive: boolean;
  /** Nombre de matériaux de la nomenclature (calculé). */
  materialCount: number;
  /** Coût matière estimé d'une unité, d'après la nomenclature (calculé). */
  estimatedMaterialCost: number;
  orderCount: number;
  createdAt: Date | null;
};

export type FurnitureModelMaterialRow = {
  id: number;
  syncId: string;
  modelId: number;
  productId: number;
  productCode: string;
  productName: string;
  unit: string;
  quantity: number;
  notes: string | null;
  /** Titre de la fiche produit (prix d'achat) — base du coût matière. */
  purchasePrice: number;
  /** Stock disponible du produit, au moment de la lecture. */
  availableStock: number;
  /** Coût matière de la ligne : `quantity × purchase_price`. */
  amount: number;
};

export type FurnitureModelInput = {
  /** Généré (`MOD-0001`) s'il est absent ou vide. */
  code?: string | null;
  name: string;
  description?: string | null;
  standardDimensions?: string | null;
  laborHours?: number;
  salePrice?: number;
  isActive?: boolean;
};

/** Ligne de nomenclature fournie par l'appelant (remplace la BOM entière). */
export type FurnitureModelMaterialInput = {
  productId: number;
  quantity: number;
  unit?: string | null;
  notes?: string | null;
};

/** Besoin en matière pour N unités d'un modèle, stock et manquant compris. */
export type FurnitureRequirementLine = {
  productId: number;
  productCode: string;
  productName: string;
  unit: string;
  quantityPerUnit: number;
  requiredQuantity: number;
  availableStock: number;
  /** Ce qu'il faudra acheter : `max(0, requis − disponible)`. */
  missingQuantity: number;
  purchasePrice: number;
  estimatedCost: number;
  isCovered: boolean;
};

export type FurnitureRequirements = {
  model: FurnitureModelRow | null;
  quantity: number;
  laborHours: number;
  lines: FurnitureRequirementLine[];
  /** Coût matière total estimé (hors chutes). */
  totalMaterialCost: number;
  /** Vrai si **toutes** les lignes sont couvertes par le stock. */
  isCovered: boolean;
  missingMaterialCount: number;
};

export type FurnitureOrderMaterialRow = {
  id: number;
  syncId: string;
  orderId: number;
  productId: number | null;
  productCode: string;
  productName: string;
  unit: string;
  quantity: number;
  wastageQuantity: number;
  unitCost: number;
  amount: number;
  createdAt: Date | null;
};

export type FurnitureOrderWorkerRow = {
  id: number;
  syncId: string;
  orderId: number;
  workerId: number | null;
  workerName: string;
  role: string | null;
  days: number;
  dailyRate: number;
  amount: number;
  createdAt: Date | null;
};

export type FurnitureOrderCost = {
  materialCost: number;
  laborCost: number;
  totalCost: number;
  agreedPrice: number;
  amountPaid: number;
  remainingAmount: number;
  margin: number;
  marginPercent: number;
};

export type FurnitureOrderRow = {
  id: number;
  syncId: string;
  orderNumber: string;
  customerId: number | null;
  customerName: string;
  modelId: number | null;
  modelName: string;
  isCustom: boolean;
  dimensions: string | null;
  finish: string | null;
  quantity: number;
  startDate: string | null;
  promisedDate: string | null;
  deliveryDate: string | null;
  stage: FurnitureStage;
  stageLabel: string;
  materialCost: number;
  laborCost: number;
  totalCost: number;
  agreedPrice: number;
  amountPaid: number;
  totalCostComputed: number;
  margin: number;
  marginPercent: number;
  productId: number | null;
  productName: string | null;
  userId: number | null;
  notes: string | null;
  /** Commande annulée (tombstone `deleted_at`) — jamais supprimée (§7). */
  isCancelled: boolean;
  /** `delivery_date <= promised_date` (§21). */
  isLate: boolean;
  isDelivered: boolean;
  isDeliveredOnTime: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type FurnitureOrderDetail = {
  order: FurnitureOrderRow;
  materials: FurnitureOrderMaterialRow[];
  workers: FurnitureOrderWorkerRow[];
  costs: FurnitureOrderCost;
  /** Modèle utilisé (`null` pour une commande sur mesure sans modèle). */
  model: FurnitureModelRow | null;
};

export type FurnitureOrderInput = {
  customerId?: number | null;
  customerName?: string | null;
  modelId?: number | null;
  modelName?: string | null;
  isCustom?: boolean;
  dimensions?: string | null;
  finish?: string | null;
  quantity?: number;
  startDate?: string | null;
  promisedDate?: string | null;
  deliveryDate?: string | null;
  agreedPrice?: number;
  amountPaid?: number;
  productId?: number | null;
  userId?: number | null;
  notes?: string | null;
  /** Nombre d'unités à préremplir depuis la nomenclature (défaut : `quantity`). */
  bomQuantity?: number;
};

export type FurnitureOrderListOptions = {
  search?: string;
  stage?: FurnitureStage;
  customerId?: number;
  lateOnly?: boolean;
  includeCancelled?: boolean;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  /**
   * `recent` (défaut) = dernière commande enregistrée — même règle que toutes
   * les listes (`lib/list-sort.ts`) ; `promised` = date promise la plus proche
   * (planning d'atelier), les commandes sans date promise en dernier.
   */
  sort?: 'recent' | 'promised';
};

export type WorkshopSummary = {
  from: string | null;
  to: string | null;
  total: number;
  /** Commandes créées sur la période. */
  manufactured: number;
  inProgress: number;
  delivered: number;
  deliveredOnTime: number;
  late: number;
  cancelled: number;
  /** Chiffre d'affaires convenu des commandes non annulées. */
  revenue: number;
  totalCost: number;
  margin: number;
  marginPercent: number;
  totalWastage: number;
  materialCost: number;
  laborCost: number;
};

/* ------------------------------------------------------------------ *
 * Utilitaires internes
 * ------------------------------------------------------------------ */

function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function trimmed(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/** Date métier `YYYY-MM-DD` acceptée telle quelle, sinon `null`. */
function businessDateOrNull(value: unknown): string | null {
  const text = trimmed(value);
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(0, 10) : null;
}

/**
 * `delivery_date <= promised_date` → livré à temps (§21).
 * Un délai promis absent n'est **pas** un retard : on ne peut rien affirmer.
 */
function computeIsLate(
  deliveryDate: string | null,
  promisedDate: string | null,
): { isLate: boolean; isDeliveredOnTime: boolean } {
  if (!deliveryDate || !promisedDate) return { isLate: false, isDeliveredOnTime: false };
  const isLate = deliveryDate > promisedDate;
  return { isLate, isDeliveredOnTime: !isLate };
}

/** Marge d'un document : prix convenu − coût de revient total. */
function computeMargin(agreedPrice: number, totalCost: number): { margin: number; marginPercent: number } {
  const margin = roundMoney(agreedPrice - totalCost);
  const marginPercent = agreedPrice > 0 ? Math.round((margin / agreedPrice) * 1000) / 10 : 0;
  return { margin, marginPercent };
}

/** Nombre lisible d'une quantité : évite « 3.0000000001 » dans un libellé. */
function formatQuantityLabel(value: number): string {
  return String(Math.round(value * 1000) / 1000).replace('.', ',');
}

/**
 * Motif du mouvement de perte (chutes de bois, §21). Le motif est **explicite**
 * parce que le journal de stock est le seul endroit où la perte est lisible :
 * trois types de mouvements suffisent, on ne crée pas de type `loss` (§12).
 */
export function wastageMotif(orderNumber: string, productName: string): string {
  return `chutes de bois — commande ${orderNumber} (${productName})`;
}

/** Motif du mouvement de consommation de matière. */
export function materialMotif(orderNumber: string, productName: string): string {
  return `matières atelier — commande ${orderNumber} (${productName})`;
}

/* ------------------------------------------------------------------ *
 * Modèles — lecture
 * ------------------------------------------------------------------ */

const MODEL_COLUMNS = `
  m.id, m.sync_id, m.code, m.name, m.description, m.standard_dimensions,
  m.labor_hours, m.sale_price, m.is_active, m.created_at,
  (SELECT COUNT(*) FROM furniture_model_materials b WHERE b.model_id = m.id) AS material_count,
  (SELECT COUNT(*) FROM furniture_orders o WHERE o.model_id = m.id) AS order_count,
  (SELECT COALESCE(SUM(b.quantity * COALESCE(p.purchase_price, 0)), 0)
     FROM furniture_model_materials b
     LEFT JOIN products p ON p.id = b.product_id
    WHERE b.model_id = m.id) AS estimated_material_cost
`;

const MODEL_FROM = 'FROM furniture_models m';

function mapModelRow(row: any): FurnitureModelRow {
  return {
    id: num(row.id),
    syncId: String(row.sync_id ?? ''),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    description: row.description ?? null,
    standardDimensions: row.standard_dimensions ?? null,
    laborHours: num(row.labor_hours),
    salePrice: num(row.sale_price),
    isActive: Boolean(row.is_active),
    materialCount: num(row.material_count),
    estimatedMaterialCost: roundMoney(num(row.estimated_material_cost)),
    orderCount: num(row.order_count),
    createdAt: row.created_at ? new Date(num(row.created_at) * 1000) : null,
  };
}

/** Liste paginée des modèles, nomenclature comptée et coût matière estimé. */
export async function listFurnitureModels(
  options: {
    search?: string;
    page?: number;
    limit?: number;
    includeInactive?: boolean;
    /** `recent` (défaut) = dernière insertion ; `name` = ordre alphabétique. */
    sort?: ListSort;
  } = {},
): Promise<{
  data: FurnitureModelRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (!options.includeInactive) where.push('m.is_active = 1');
  if (options.search) {
    where.push('(m.code LIKE ? OR m.name LIKE ? OR m.description LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await rawAll<any>(
    `SELECT ${MODEL_COLUMNS} ${MODEL_FROM} ${whereSql}
     ORDER BY ${sqlOrderBy(options.sort ?? DEFAULT_LIST_SORT, 'm', ['recent', 'name'])}
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total ${MODEL_FROM} ${whereSql}`,
    args,
  );

  const total = num(countRow?.total);

  return {
    data: rows.map(mapModelRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/** Tous les modèles actifs, pour les sélecteurs de modale. */
export async function listActiveFurnitureModels(): Promise<FurnitureModelRow[]> {
  const { data } = await listFurnitureModels({ limit: 500 });
  return data;
}

/**
 * Fiche modèle **avec sa nomenclature** : c'est le contrat attendu par la
 * modale BOM et par le calcul des besoins.
 */
export async function getFurnitureModel(
  id: number,
): Promise<{ model: FurnitureModelRow; materials: FurnitureModelMaterialRow[] } | null> {
  const row = await rawGet<any>(`SELECT ${MODEL_COLUMNS} ${MODEL_FROM} WHERE m.id = ?`, [id]);
  if (!row) return null;

  return { model: mapModelRow(row), materials: await getModelMaterials(id) };
}

/** Nomenclature d'un modèle, avec nom, unité, prix d'achat et stock du produit. */
export async function getModelMaterials(modelId: number): Promise<FurnitureModelMaterialRow[]> {
  const rows = await rawAll<any>(
    `SELECT b.id, b.sync_id, b.model_id, b.product_id, b.quantity, b.unit, b.notes,
            p.code AS product_code, p.name AS product_name, p.unit AS product_unit,
            p.purchase_price, p.stock
       FROM furniture_model_materials b
       LEFT JOIN products p ON p.id = b.product_id
      WHERE b.model_id = ?
      ORDER BY p.name COLLATE NOCASE, b.id`,
    [modelId],
  );

  return rows.map((row) => {
    const quantity = num(row.quantity);
    const purchasePrice = num(row.purchase_price);
    return {
      id: num(row.id),
      syncId: String(row.sync_id ?? ''),
      modelId: num(row.model_id),
      productId: num(row.product_id),
      productCode: String(row.product_code ?? ''),
      productName: String(row.product_name ?? 'Produit supprimé'),
      unit: String(row.product_unit ?? row.unit ?? 'pièce'),
      quantity,
      notes: row.notes ?? null,
      purchasePrice,
      availableStock: num(row.stock),
      amount: roundMoney(quantity * purchasePrice),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Modèles — écriture
 * ------------------------------------------------------------------ */

/**
 * Code de modèle unique, au format `MOD-0001`.
 *
 * Le compteur ne vit pas dans `settings` : il est **dérivé du maximum
 * existant**, ce qui évite de consommer un numéro quand la création échoue et
 * reste juste après un import de synchronisation.
 */
export async function generateFurnitureModelCode(): Promise<string> {
  const row = await rawGet<{ max_code: string | null }>(
    `SELECT MAX(code) AS max_code FROM furniture_models WHERE code LIKE 'MOD-%'`,
  );
  const current = Number(String(row?.max_code ?? '').replace('MOD-', ''));
  const next = Number.isFinite(current) ? current + 1 : 1;
  return `MOD-${String(next).padStart(4, '0')}`;
}

export async function createFurnitureModel(input: FurnitureModelInput): Promise<FurnitureModelRow> {
  const name = trimmed(input.name);
  if (!name) throw new ValidationError('Le nom du modèle est obligatoire');

  const code = trimmed(input.code) ?? (await generateFurnitureModelCode());

  const existing = await rawGet<{ id: number }>(
    'SELECT id FROM furniture_models WHERE code = ? LIMIT 1',
    [code],
  );
  if (existing) throw new ValidationError(`Le code « ${code} » est déjà utilisé par un autre modèle`);

  const inserted = await db
    .insert(furnitureModels)
    .values({
      code,
      name,
      description: trimmed(input.description),
      standardDimensions: trimmed(input.standardDimensions),
      laborHours: num(input.laborHours),
      salePrice: num(input.salePrice),
      isActive: input.isActive ?? true,
    })
    .returning({ id: furnitureModels.id, syncId: furnitureModels.syncId });

  await enqueueSyncWrite('furniture_models', inserted[0]?.syncId, 'insert', {
    code,
    name,
    description: trimmed(input.description),
    standard_dimensions: trimmed(input.standardDimensions),
    labor_hours: num(input.laborHours),
    sale_price: num(input.salePrice),
    is_active: input.isActive ?? true,
  });

  const created = await getFurnitureModel(Number(inserted[0].id));
  if (!created) throw new Error('Modèle créé mais introuvable');
  return created.model;
}

export async function updateFurnitureModel(
  id: number,
  patch: Partial<FurnitureModelInput>,
): Promise<FurnitureModelRow> {
  const existing = await rawGet<{ id: number; sync_id: string }>(
    'SELECT id, sync_id FROM furniture_models WHERE id = ? LIMIT 1',
    [id],
  );
  if (!existing) throw new Error('Modèle introuvable');

  if (patch.code !== undefined) {
    const code = trimmed(patch.code);
    if (!code) throw new ValidationError('Le code du modèle ne peut pas être vide');
    const duplicate = await rawGet<{ id: number }>(
      'SELECT id FROM furniture_models WHERE code = ? AND id <> ? LIMIT 1',
      [code, id],
    );
    if (duplicate) {
      throw new ValidationError(`Le code « ${code} » est déjà utilisé par un autre modèle`);
    }
  }

  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.code !== undefined) values.code = trimmed(patch.code);
  if (patch.name !== undefined) {
    const name = trimmed(patch.name);
    if (!name) throw new ValidationError('Le nom du modèle est obligatoire');
    values.name = name;
  }
  if (patch.description !== undefined) values.description = trimmed(patch.description);
  if (patch.standardDimensions !== undefined) {
    values.standardDimensions = trimmed(patch.standardDimensions);
  }
  if (patch.laborHours !== undefined) values.laborHours = num(patch.laborHours);
  if (patch.salePrice !== undefined) values.salePrice = num(patch.salePrice);
  if (patch.isActive !== undefined) values.isActive = Boolean(patch.isActive);

  await db
    .update(furnitureModels)
    .set(values as any)
    .where(eq(furnitureModels.id, id));

  await enqueueSyncWrite('furniture_models', existing.sync_id, 'update', values);

  const updated = await getFurnitureModel(id);
  if (!updated) throw new Error('Modèle introuvable après modification');
  return updated.model;
}

export async function deactivateFurnitureModel(id: number): Promise<void> {
  const existing = await rawGet<{ sync_id: string }>(
    'SELECT sync_id FROM furniture_models WHERE id = ? LIMIT 1',
    [id],
  );
  if (!existing) throw new Error('Modèle introuvable');

  const now = new Date();
  await db
    .update(furnitureModels)
    .set({ isActive: false, deletedAt: now, updatedAt: now })
    .where(eq(furnitureModels.id, id));

  await enqueueSyncWrite('furniture_models', existing.sync_id, 'delete', {
    deleted_at: now.toISOString(),
    is_active: false,
  });
}

export async function reactivateFurnitureModel(id: number): Promise<void> {
  const existing = await rawGet<{ sync_id: string }>(
    'SELECT sync_id FROM furniture_models WHERE id = ? LIMIT 1',
    [id],
  );
  if (!existing) throw new Error('Modèle introuvable');

  await db
    .update(furnitureModels)
    .set({ isActive: true, deletedAt: null, updatedAt: new Date() })
    .where(eq(furnitureModels.id, id));

  await enqueueSyncWrite('furniture_models', existing.sync_id, 'update', {
    deleted_at: null,
    is_active: true,
  });
}

/**
 * Remplace la nomenclature d'un modèle (BOM).
 *
 * Les lignes retirées sont **marquées supprimées** (`deleted_at`) plutôt que
 * supprimées physiquement : `furniture_model_materials` est une table
 * synchronisée, et un `DELETE` réel ferait ressusciter la ligne au prochain
 * pull (§11 règle 2). Une ligne déjà présente est mise à jour — son `sync_id`
 * ne change donc pas.
 */
export async function setModelMaterials(
  modelId: number,
  lines: FurnitureModelMaterialInput[],
): Promise<FurnitureModelMaterialRow[]> {
  const model = await rawGet<{ id: number }>(
    'SELECT id FROM furniture_models WHERE id = ? LIMIT 1',
    [modelId],
  );
  if (!model) throw new Error('Modèle introuvable');

  const cleaned: FurnitureModelMaterialInput[] = [];
  for (const line of lines) {
    const productId = num(line.productId);
    const quantity = num(line.quantity);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new ValidationError('Chaque ligne de nomenclature doit désigner un produit');
    }
    if (quantity <= 0) {
      throw new ValidationError('La quantité d’une ligne de nomenclature doit être supérieure à zéro');
    }
    cleaned.push({ ...line, productId, quantity });
  }

  const existing = await rawAll<{ id: number; product_id: number; sync_id: string }>(
    'SELECT id, product_id, sync_id FROM furniture_model_materials WHERE model_id = ?',
    [modelId],
  );

  const byProduct = new Map<number, { id: number; sync_id: string }>();
  for (const row of existing) byProduct.set(num(row.product_id), { id: num(row.id), sync_id: row.sync_id });

  const kept = new Set<number>();

  for (const line of cleaned) {
    const product = await rawGet<{ code: string; name: string; unit: string }>(
      'SELECT code, name, unit FROM products WHERE id = ? LIMIT 1',
      [line.productId],
    );
    if (!product) throw new ValidationError('Produit introuvable dans la nomenclature');

    const unit = trimmed(line.unit) ?? product.unit;
    const previous = byProduct.get(line.productId);

    if (previous) {
      kept.add(previous.id);
      await db
        .update(furnitureModelMaterials)
        .set({
          quantity: line.quantity,
          unit,
          notes: trimmed(line.notes),
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(furnitureModelMaterials.id, previous.id));

      await enqueueSyncWrite('furniture_model_materials', previous.sync_id, 'update', {
        model_id: modelId,
        product_id: line.productId,
        quantity: line.quantity,
        unit,
        notes: trimmed(line.notes),
        deleted_at: null,
      });
      continue;
    }

    const inserted = await db
      .insert(furnitureModelMaterials)
      .values({
        modelId,
        productId: line.productId,
        quantity: line.quantity,
        unit,
        notes: trimmed(line.notes),
      })
      .returning({ id: furnitureModelMaterials.id, syncId: furnitureModelMaterials.syncId });

    kept.add(Number(inserted[0].id));

    await enqueueSyncWrite('furniture_model_materials', inserted[0]?.syncId, 'insert', {
      model_id: modelId,
      product_id: line.productId,
      product_code: product.code,
      product_name: product.name,
      quantity: line.quantity,
      unit,
      notes: trimmed(line.notes),
    });
  }

  // Lignes surnuméraires : tombstone, jamais de suppression physique.
  const now = new Date();
  for (const row of existing) {
    if (kept.has(num(row.id))) continue;
    await db
      .update(furnitureModelMaterials)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(furnitureModelMaterials.id, num(row.id)));

    await enqueueSyncWrite('furniture_model_materials', row.sync_id, 'delete', {
      deleted_at: now.toISOString(),
    });
  }

  return getModelMaterials(modelId);
}

/**
 * Besoins en matières pour **N unités** d'un modèle — avec le stock disponible
 * et le manquant. C'est le calcul qui rend la fiche modèle réellement utile
 * (§21) : sans lui, la nomenclature ne serait qu'une liste décorative.
 */
export async function computeModelRequirements(
  modelId: number,
  quantity = 1,
): Promise<FurnitureRequirements> {
  const units = Math.max(0, num(quantity, 1));
  const model = await rawGet<any>(`SELECT ${MODEL_COLUMNS} ${MODEL_FROM} WHERE m.id = ?`, [modelId]);

  if (!model) {
    return {
      model: null,
      quantity: units,
      laborHours: 0,
      lines: [],
      totalMaterialCost: 0,
      isCovered: true,
      missingMaterialCount: 0,
    };
  }

  const materials = await getModelMaterials(modelId);

  const lines: FurnitureRequirementLine[] = materials.map((material) => {
    const requiredQuantity = Math.round(material.quantity * units * 1000) / 1000;
    const missingQuantity = Math.max(0, Math.round((requiredQuantity - material.availableStock) * 1000) / 1000);
    return {
      productId: material.productId,
      productCode: material.productCode,
      productName: material.productName,
      unit: material.unit,
      quantityPerUnit: material.quantity,
      requiredQuantity,
      availableStock: material.availableStock,
      missingQuantity,
      purchasePrice: material.purchasePrice,
      estimatedCost: roundMoney(requiredQuantity * material.purchasePrice),
      isCovered: missingQuantity <= 0.0001,
    };
  });

  const totalMaterialCost = roundMoney(lines.reduce((sum, line) => sum + line.estimatedCost, 0));
  const missingMaterialCount = lines.filter((line) => !line.isCovered).length;

  return {
    model: mapModelRow(model),
    quantity: units,
    laborHours: Math.round(num(model.labor_hours) * units * 100) / 100,
    lines,
    totalMaterialCost,
    isCovered: missingMaterialCount === 0,
    missingMaterialCount,
  };
}

/* ------------------------------------------------------------------ *
 * Commandes — lecture
 * ------------------------------------------------------------------ */

const ORDER_SELECT = `
  SELECT o.id, o.sync_id, o.order_number, o.customer_id, o.customer_name,
         o.model_id, o.model_name, o.is_custom, o.dimensions, o.finish, o.quantity,
         o.start_date, o.promised_date, o.delivery_date, o.stage,
         o.material_cost, o.labor_cost, o.total_cost, o.agreed_price, o.amount_paid,
         o.product_id, o.user_id, o.notes, o.created_at, o.updated_at, o.deleted_at,
         c.name AS joined_customer_name,
         m.name AS joined_model_name,
         p.name AS joined_product_name,
         (SELECT COALESCE(SUM(om.amount), 0) FROM furniture_order_materials om
           WHERE om.order_id = o.id) AS computed_material_cost,
         (SELECT COALESCE(SUM(ow.amount), 0) FROM furniture_order_workers ow
           WHERE ow.order_id = o.id) AS computed_labor_cost,
         (SELECT COALESCE(SUM(om.wastage_quantity), 0) FROM furniture_order_materials om
           WHERE om.order_id = o.id) AS wastage_total
    FROM furniture_orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN furniture_models m ON m.id = o.model_id
    LEFT JOIN products p ON p.id = o.product_id
`;

function mapOrderRow(row: any): FurnitureOrderRow {
  // `row` vient d'une requête brute : l'étape est revalidée, jamais supposée.
  const stage: FurnitureStage = isFurnitureStage(row.stage) ? row.stage : 'cutting';
  const deliveryDate = row.delivery_date ?? null;
  const promisedDate = row.promised_date ?? null;
  const { isLate, isDeliveredOnTime } = computeIsLate(deliveryDate, promisedDate);

  // Le coût de revient est **recalculé** depuis les lignes : les colonnes
  // `material_cost` / `labor_cost` ne sont qu'un cache réécrit après chaque
  // écriture, jamais une source de vérité (§6.5 règle 6).
  const materialCost = roundMoney(num(row.computed_material_cost));
  const laborCost = roundMoney(num(row.computed_labor_cost));
  const totalCostComputed = roundMoney(materialCost + laborCost);
  const agreedPrice = num(row.agreed_price);
  const { margin, marginPercent } = computeMargin(agreedPrice, totalCostComputed);

  return {
    id: num(row.id),
    syncId: String(row.sync_id ?? ''),
    orderNumber: String(row.order_number ?? ''),
    customerId: row.customer_id == null ? null : num(row.customer_id),
    customerName: String(row.customer_name ?? row.joined_customer_name ?? 'Client de passage'),
    modelId: row.model_id == null ? null : num(row.model_id),
    modelName: String(row.model_name ?? row.joined_model_name ?? 'Sur mesure'),
    isCustom: Boolean(row.is_custom),
    dimensions: row.dimensions ?? null,
    finish: row.finish ?? null,
    quantity: num(row.quantity, 1),
    startDate: row.start_date ?? null,
    promisedDate,
    deliveryDate,
    stage,
    stageLabel: FURNITURE_STAGE_LABELS[stage],
    materialCost,
    laborCost,
    totalCost: totalCostComputed,
    agreedPrice,
    amountPaid: num(row.amount_paid),
    totalCostComputed,
    margin,
    marginPercent,
    productId: row.product_id == null ? null : num(row.product_id),
    productName: row.joined_product_name ?? null,
    userId: row.user_id == null ? null : num(row.user_id),
    notes: row.notes ?? null,
    isCancelled: Boolean(row.deleted_at),
    isLate,
    isDelivered: stage === 'delivered',
    isDeliveredOnTime: isDeliveredOnTime,
    createdAt: row.created_at ? new Date(num(row.created_at) * 1000) : null,
    updatedAt: row.updated_at ? new Date(num(row.updated_at) * 1000) : null,
  };
}

/**
 * Liste paginée des commandes d'atelier, avec client, modèle, coût, marge et
 * l'indicateur de retard.
 *
 * `lateOnly` porte sur le **retard avéré** : livré après la date promise. Une
 * commande en cours dont la date promise est dépassée est signalée dans l'IHM
 * par `isLate` calculé à la lecture, ce qui reste lisible sans requête
 * supplémentaire.
 */
export async function listFurnitureOrders(options: FurnitureOrderListOptions = {}): Promise<{
  data: FurnitureOrderRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (!options.includeCancelled) where.push('o.deleted_at IS NULL');
  if (options.search) {
    where.push(
      '(o.order_number LIKE ? OR o.customer_name LIKE ? OR c.name LIKE ? OR o.model_name LIKE ? OR m.name LIKE ?)',
    );
    const like = `%${options.search}%`;
    args.push(like, like, like, like, like);
  }
  if (options.stage) {
    where.push('o.stage = ?');
    args.push(options.stage);
  }
  if (options.customerId && options.customerId > 0) {
    where.push('o.customer_id = ?');
    args.push(options.customerId);
  }
  if (options.from) {
    where.push('COALESCE(o.start_date, o.promised_date, o.delivery_date) >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('COALESCE(o.start_date, o.promised_date, o.delivery_date) <= ?');
    args.push(options.to);
  }
  if (options.lateOnly) {
    where.push('o.delivery_date IS NOT NULL AND o.promised_date IS NOT NULL AND o.delivery_date > o.promised_date');
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // L'alias `c` / `m` n'existe que dans `ORDER_SELECT` : la clause de recherche
  // s'appuie donc sur la même jointure, ce que garantit la construction unique.
  //
  // Tri par défaut : **dernière commande enregistrée** (même règle que partout,
  // `lib/list-sort.ts`). `?sort=promised` retrouve le planning d'atelier
  // (date promise la plus proche d'abord, sans date promise en dernier).
  const orderBy =
    options.sort === 'promised'
      ? 'o.promised_date IS NULL, o.promised_date, o.id DESC'
      : 'o.created_at DESC, o.id DESC';

  const rows = await rawAll<any>(
    `${ORDER_SELECT} ${whereSql}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total
       FROM furniture_orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN furniture_models m ON m.id = o.model_id
       ${whereSql}`,
    args,
  );

  const total = num(countRow?.total);

  return {
    data: rows.map(mapOrderRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function getOrderMaterials(orderId: number): Promise<FurnitureOrderMaterialRow[]> {
  const rows = await rawAll<any>(
    `SELECT om.id, om.sync_id, om.order_id, om.product_id, om.product_code, om.product_name,
            om.unit, om.quantity, om.wastage_quantity, om.unit_cost, om.amount, om.created_at
       FROM furniture_order_materials om
      WHERE om.order_id = ?
      ORDER BY om.id`,
    [orderId],
  );

  return rows.map((row) => ({
    id: num(row.id),
    syncId: String(row.sync_id ?? ''),
    orderId: num(row.order_id),
    productId: row.product_id == null ? null : num(row.product_id),
    productCode: String(row.product_code ?? ''),
    productName: String(row.product_name ?? ''),
    unit: String(row.unit ?? 'pièce'),
    quantity: num(row.quantity),
    wastageQuantity: num(row.wastage_quantity),
    unitCost: num(row.unit_cost),
    amount: roundMoney(num(row.amount)),
    createdAt: row.created_at ? new Date(num(row.created_at) * 1000) : null,
  }));
}

export async function getOrderWorkers(orderId: number): Promise<FurnitureOrderWorkerRow[]> {
  const rows = await rawAll<any>(
    `SELECT ow.id, ow.sync_id, ow.order_id, ow.worker_id, ow.worker_name, ow.role,
            ow.days, ow.daily_rate, ow.amount, ow.created_at
       FROM furniture_order_workers ow
      WHERE ow.order_id = ?
      ORDER BY ow.id`,
    [orderId],
  );

  return rows.map((row) => ({
    id: num(row.id),
    syncId: String(row.sync_id ?? ''),
    orderId: num(row.order_id),
    workerId: row.worker_id == null ? null : num(row.worker_id),
    workerName: String(row.worker_name ?? ''),
    role: row.role ?? null,
    days: num(row.days),
    dailyRate: num(row.daily_rate),
    amount: roundMoney(num(row.amount)),
    createdAt: row.created_at ? new Date(num(row.created_at) * 1000) : null,
  }));
}

/** Coût de revient d'une commande : matériaux + main-d'œuvre, **calculé**. */
export async function getOrderCost(orderId: number): Promise<FurnitureOrderCost | null> {
  const order = await rawGet<any>(
    'SELECT id, agreed_price, amount_paid FROM furniture_orders WHERE id = ? LIMIT 1',
    [orderId],
  );
  if (!order) return null;

  const [materials, workers] = await Promise.all([
    getOrderMaterials(orderId),
    getOrderWorkers(orderId),
  ]);

  const materialCost = roundMoney(materials.reduce((sum, line) => sum + line.amount, 0));
  const laborCost = roundMoney(workers.reduce((sum, line) => sum + line.amount, 0));
  const totalCost = roundMoney(materialCost + laborCost);
  const agreedPrice = num(order.agreed_price);
  const amountPaid = num(order.amount_paid);
  const { margin, marginPercent } = computeMargin(agreedPrice, totalCost);

  return {
    materialCost,
    laborCost,
    totalCost,
    agreedPrice,
    amountPaid,
    remainingAmount: roundMoney(agreedPrice - amountPaid),
    margin,
    marginPercent,
  };
}

/** Fiche complète d'une commande : matériaux, équipe, coûts et modèle. */
export async function getFurnitureOrder(id: number): Promise<FurnitureOrderDetail | null> {
  const row = await rawGet<any>(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
  if (!row) return null;

  const order = mapOrderRow(row);
  const [materials, workers, costRecord] = await Promise.all([
    getOrderMaterials(id),
    getOrderWorkers(id),
    getOrderCost(id),
  ]);

  const model = order.modelId != null ? await getFurnitureModel(order.modelId) : null;

  const costs: FurnitureOrderCost = costRecord ?? {
    materialCost: 0,
    laborCost: 0,
    totalCost: 0,
    agreedPrice: order.agreedPrice,
    amountPaid: order.amountPaid,
    remainingAmount: roundMoney(order.agreedPrice - order.amountPaid),
    margin: 0,
    marginPercent: 0,
  };

  return { order, materials, workers, costs, model: model?.model ?? null };
}

/* ------------------------------------------------------------------ *
 * Commandes — écriture
 * ------------------------------------------------------------------ */

/**
 * Recalcule et fige les agrégats de coût de la commande.
 *
 * Appelée après **chaque** changement de matériaux ou d'équipe : c'est le seul
 * chemin par lequel `material_cost`, `labor_cost` et `total_cost` évoluent,
 * ce qui garantit qu'ils ne peuvent pas diverger des lignes.
 */
export async function recalculateOrderCosts(orderId: number): Promise<FurnitureOrderCost | null> {
  const costs = await getOrderCost(orderId);
  if (!costs) return null;

  const order = await rawGet<{ sync_id: string }>(
    'SELECT sync_id FROM furniture_orders WHERE id = ? LIMIT 1',
    [orderId],
  );

  await db
    .update(furnitureOrders)
    .set({
      materialCost: costs.materialCost,
      laborCost: costs.laborCost,
      totalCost: costs.totalCost,
      updatedAt: new Date(),
    })
    .where(eq(furnitureOrders.id, orderId));

  await enqueueSyncWrite('furniture_orders', order?.sync_id, 'update', {
    material_cost: costs.materialCost,
    labor_cost: costs.laborCost,
    total_cost: costs.totalCost,
  });

  return costs;
}

/** Résout le nom du client à figer sur la commande (`customer_name`). */
async function resolveCustomer(
  customerId: number | null,
  fallbackName: string | null,
): Promise<{ customerId: number | null; customerName: string }> {
  if (customerId && customerId > 0) {
    const customer = await rawGet<{ id: number; name: string }>(
      'SELECT id, name FROM customers WHERE id = ? LIMIT 1',
      [customerId],
    );
    if (!customer) throw new ValidationError('Client introuvable');
    return { customerId: customer.id, customerName: customer.name };
  }
  return { customerId: null, customerName: fallbackName ?? 'Client de passage' };
}

/** Résout le modèle et fige son nom — une commande reste lisible après renommage. */
async function resolveModel(
  modelId: number | null,
  fallbackName: string | null,
): Promise<{ modelId: number | null; modelName: string }> {
  if (modelId && modelId > 0) {
    const model = await rawGet<{ id: number; name: string }>(
      'SELECT id, name FROM furniture_models WHERE id = ? LIMIT 1',
      [modelId],
    );
    if (!model) throw new ValidationError('Modèle introuvable');
    return { modelId: model.id, modelName: model.name };
  }
  return { modelId: null, modelName: fallbackName ?? 'Sur mesure' };
}

/**
 * Création d'une commande d'atelier.
 *
 * **Cœur de §21** : si `modelId` est fourni et que la commande est standard,
 * les matériaux sont **préremplis depuis la nomenclature** (× la quantité).
 * Ils sont écrits en base **sans mouvement de stock** : la consommation réelle
 * est enregistrée plus tard, ligne par ligne, par `addOrderMaterial()` — c'est
 * ce qui permet de constater les chutes réelles plutôt que théoriques.
 */
export async function createFurnitureOrder(input: FurnitureOrderInput): Promise<FurnitureOrderDetail> {
  const isCustom = Boolean(input.isCustom);
  const quantity = Math.max(0, num(input.quantity, 1)) || 1;

  const customer = await resolveCustomer(num(input.customerId) || null, trimmed(input.customerName));
  const model = await resolveModel(isCustom ? null : num(input.modelId) || null, trimmed(input.modelName));

  if (!isCustom && !model.modelId && !trimmed(input.dimensions)) {
    throw new ValidationError(
      'Une commande standard doit référencer un modèle (ou devenir une commande sur mesure)',
    );
  }

  const orderNumber = await nextDocumentNumber('furniture');

  const inserted = await db
    .insert(furnitureOrders)
    .values({
      orderNumber,
      customerId: customer.customerId,
      customerName: customer.customerName,
      modelId: model.modelId,
      modelName: model.modelName,
      isCustom,
      dimensions: trimmed(input.dimensions),
      finish: trimmed(input.finish),
      quantity,
      startDate: businessDateOrNull(input.startDate) ?? today(),
      promisedDate: businessDateOrNull(input.promisedDate),
      deliveryDate: businessDateOrNull(input.deliveryDate),
      stage: 'cutting',
      materialCost: 0,
      laborCost: 0,
      totalCost: 0,
      agreedPrice: num(input.agreedPrice),
      amountPaid: num(input.amountPaid),
      productId: num(input.productId) || null,
      userId: num(input.userId) || null,
      notes: trimmed(input.notes),
    })
    .returning({ id: furnitureOrders.id, syncId: furnitureOrders.syncId });

  const orderId = num(inserted[0].id);

  await enqueueSyncWrite('furniture_orders', inserted[0]?.syncId, 'insert', {
    order_number: orderNumber,
    customer_name: customer.customerName,
    model_name: model.modelName,
    is_custom: isCustom,
    quantity,
    dimensions: trimmed(input.dimensions),
    finish: trimmed(input.finish),
    promised_date: businessDateOrNull(input.promisedDate),
    stage: 'cutting',
    agreed_price: num(input.agreedPrice),
  });

  // Préremplissage de la nomenclature : le besoin est **calculé**, jamais saisi.
  if (!isCustom && model.modelId) {
    const bomQuantity = num(input.bomQuantity, quantity) || quantity;
    const requirements = await computeModelRequirements(model.modelId, bomQuantity);

    for (const line of requirements.lines) {
      const materialInserted = await db
        .insert(furnitureOrderMaterials)
        .values({
          orderId,
          productId: line.productId,
          productCode: line.productCode,
          productName: line.productName,
          unit: line.unit,
          quantity: line.requiredQuantity,
          wastageQuantity: 0,
          unitCost: line.purchasePrice,
          amount: line.estimatedCost,
        })
        .returning({ id: furnitureOrderMaterials.id, syncId: furnitureOrderMaterials.syncId });

      await enqueueSyncWrite('furniture_order_materials', materialInserted[0]?.syncId, 'insert', {
        order_id: orderId,
        product_id: line.productId,
        product_code: line.productCode,
        product_name: line.productName,
        quantity: line.requiredQuantity,
        wastage_quantity: 0,
        unit_cost: line.purchasePrice,
        amount: line.estimatedCost,
      });
    }

    await recalculateOrderCosts(orderId);
  }

  const created = await getFurnitureOrder(orderId);
  if (!created) throw new Error('Commande créée mais introuvable');
  return created;
}

export type FurnitureOrderPatch = {
  customerId?: number | null;
  customerName?: string | null;
  modelId?: number | null;
  modelName?: string | null;
  isCustom?: boolean;
  dimensions?: string | null;
  finish?: string | null;
  quantity?: number;
  startDate?: string | null;
  promisedDate?: string | null;
  deliveryDate?: string | null;
  agreedPrice?: number;
  amountPaid?: number;
  productId?: number | null;
  notes?: string | null;
};

/**
 * Modification d'une commande : coûts, dates, dimensions, finition, prix
 * convenu, acompte. L'étape **ne se modifie pas ici** : elle avance uniquement
 * par `advanceStage()`, pour que le mouvement d'entrée du meuble fini ne puisse
 * pas être contourné.
 */
export async function updateFurnitureOrder(
  id: number,
  patch: FurnitureOrderPatch,
): Promise<FurnitureOrderDetail> {
  const existing = await rawGet<{ sync_id: string; order_number: string }>(
    'SELECT sync_id, order_number FROM furniture_orders WHERE id = ? LIMIT 1',
    [id],
  );
  if (!existing) throw new Error('Commande introuvable');

  const values: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.customerId !== undefined || patch.customerName !== undefined) {
    const customer = await resolveCustomer(
      num(patch.customerId) || null,
      patch.customerName !== undefined ? trimmed(patch.customerName) : null,
    );
    values.customerId = customer.customerId;
    values.customerName = customer.customerName;
  }
  if (patch.modelId !== undefined || patch.modelName !== undefined) {
    const model = await resolveModel(
      num(patch.modelId) || null,
      patch.modelName !== undefined ? trimmed(patch.modelName) : null,
    );
    values.modelId = model.modelId;
    values.modelName = model.modelName;
  }
  if (patch.isCustom !== undefined) values.isCustom = Boolean(patch.isCustom);
  if (patch.dimensions !== undefined) values.dimensions = trimmed(patch.dimensions);
  if (patch.finish !== undefined) values.finish = trimmed(patch.finish);
  if (patch.quantity !== undefined) values.quantity = Math.max(0, num(patch.quantity));
  if (patch.startDate !== undefined) values.startDate = businessDateOrNull(patch.startDate);
  if (patch.promisedDate !== undefined) values.promisedDate = businessDateOrNull(patch.promisedDate);
  if (patch.deliveryDate !== undefined) values.deliveryDate = businessDateOrNull(patch.deliveryDate);
  if (patch.agreedPrice !== undefined) values.agreedPrice = num(patch.agreedPrice);
  if (patch.amountPaid !== undefined) values.amountPaid = num(patch.amountPaid);
  if (patch.productId !== undefined) values.productId = num(patch.productId) || null;
  if (patch.notes !== undefined) values.notes = trimmed(patch.notes);

  await db
    .update(furnitureOrders)
    .set(values as any)
    .where(eq(furnitureOrders.id, id));

  await enqueueSyncWrite('furniture_orders', existing.sync_id, 'update', values);

  const updated = await getFurnitureOrder(id);
  if (!updated) throw new Error('Commande introuvable après modification');
  return updated;
}

/** Vrai si le meuble fini de cette commande a **déjà** été mis en stock. */
async function hasFinishedGoodsEntry(orderId: number): Promise<boolean> {
  const row = await rawGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stock_movements
      WHERE reference_type = 'furniture_order' AND reference_id = ? AND type = 'entry'`,
    [orderId],
  );
  return num(row?.n) > 0;
}

/**
 * Avance une commande à l'étape demandée.
 *
 * ── Unicité du crédit de stock de meubles finis ──────────────────────────────
 * La règle §21 est « un mouvement `entry` **à la livraison** ». Deux garde-fous
 * indépendants l'appliquent, et il en faut deux :
 *
 *  1. **Transition** : depuis une étape autre que `delivered`, on ne peut
 *     atteindre que l'étape suivante. `delivered` est donc atteignable une
 *     seule fois dans le cycle normal.
 *  2. **Preuve dans le journal de stock** : avant de créditer, on vérifie
 *     qu'aucun mouvement `entry` de `reference_type = 'furniture_order'` et
 *     `reference_id = <commande>` n'existe déjà. Ce drapeau est **dérivé de
 *     l'état du journal**, pas de l'étape courante : il reste donc vrai même si
 *     la commande était déjà livrée, même après un import de synchronisation,
 *     même si deux appels concurrents arrivent. Un second appel ne crédite
 *     rien — il se contente de re-confirmer l'étape.
 *
 * Le bouton « Étape suivante » est en outre désactivé pendant l'envoi côté
 * interface, et deux appels strictement simultanés ne peuvent pas s'imbriquer
 * (le pilote SQLite sérialise les écritures). Le garde-fou décisif reste
 * toutefois le journal : c'est lui qui rend l'opération **idempotente**, y
 * compris pour une commande livrée par un import de paquet `.json`.
 *
 * Le stock lui-même est modifié exclusivement par `addStockMovement()`, qui met
 * à jour `products.stock` et les deux colonnes `stock_before` / `stock_after`
 * dans la même opération.
 */
export async function advanceStage(id: number, stage: FurnitureStage): Promise<FurnitureOrderDetail> {
  if (!isFurnitureStage(stage)) throw new ValidationError('Étape d’atelier inconnue');

  const current = await rawGet<any>(
    `SELECT id, sync_id, order_number, stage, delivery_date, promised_date, product_id, customer_id,
            model_name, dimensions
       FROM furniture_orders WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!current) throw new Error('Commande introuvable');

  const currentIndex = furnitureStageIndex(current.stage);
  const targetIndex = furnitureStageIndex(stage);
  const currentStage: FurnitureStage = isFurnitureStage(current.stage) ? current.stage : 'cutting';

  if (targetIndex < currentIndex) {
    throw new ValidationError(
      `Impossible de revenir à l’étape « ${FURNITURE_STAGE_LABELS[stage]} » : la commande est déjà à « ${
        FURNITURE_STAGE_LABELS[currentStage]
      } »`,
    );
  }

  const values: Record<string, unknown> = { stage, updatedAt: new Date() };

  // La date de livraison est posée au moment de la livraison si l'utilisateur
  // ne l'a pas déjà saisie — sinon l'indicateur « livré à temps » serait vide.
  if (stage === 'delivered' && !current.delivery_date) {
    values.deliveryDate = today();
  }

  await db
    .update(furnitureOrders)
    .set(values as any)
    .where(eq(furnitureOrders.id, id));

  await enqueueSyncWrite('furniture_orders', current.sync_id, 'update', values);

  // Entrée en stock du meuble fini — **une seule fois**.
  if (stage === 'delivered' && current.product_id) {
    const alreadyCredited = await hasFinishedGoodsEntry(id);

    if (!alreadyCredited) {
      const quantity = num(
        (
          await rawGet<{ quantity: number }>(
            'SELECT quantity FROM furniture_orders WHERE id = ? LIMIT 1',
            [id],
          )
        )?.quantity,
        1,
      );

      await addStockMovement(num(current.product_id), 'entry', Math.max(quantity, 0.0001), {
        referenceType: 'furniture_order',
        referenceId: id,
        motif: `livraison meuble — commande ${current.order_number}`,
        userId: null,
      });
    }
  }

  const updated = await getFurnitureOrder(id);
  if (!updated) throw new Error('Commande introuvable après changement d’étape');
  return updated;
}

/**
 * Ajoute un matériau consommé à une commande.
 *
 * Trois effets, dans cet ordre :
 *  1. **Déduction du stock** par un `exit` motivé — le stock ne peut pas
 *     devenir négatif, `addStockMovement` lève `InsufficientStockError` (400) ;
 *  2. **Mouvement de perte séparé** pour `wastageQuantity`, avec un motif
 *     explicite (`chutes de bois — commande MEU-…`) : les chutes sont ainsi
 *     lisibles dans le journal de stock au même titre qu'une vente ;
 *  3. **Instantanés figés** (`product_code`, `product_name`, `unit`, `unit_cost`)
 *     et recalcul des coûts de la commande.
 */
export async function addOrderMaterial(
  orderId: number,
  input: { productId: number; quantity: number; wastageQuantity?: number; unitCost?: number; motif?: string },
): Promise<FurnitureOrderDetail> {
  const productId = num(input.productId);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new ValidationError('Sélectionnez un produit');
  }

  const quantity = num(input.quantity);
  if (quantity <= 0) throw new ValidationError('La quantité doit être supérieure à zéro');

  const wastage = Math.max(0, num(input.wastageQuantity));

  const order = await rawGet<any>(
    'SELECT id, sync_id, order_number, deleted_at FROM furniture_orders WHERE id = ? LIMIT 1',
    [orderId],
  );
  if (!order) throw new Error('Commande introuvable');
  if (order.deleted_at) throw new ValidationError('Cette commande est annulée : ajout impossible');

  const product = await rawGet<any>(
    'SELECT id, code, name, unit, purchase_price, stock FROM products WHERE id = ? LIMIT 1',
    [productId],
  );
  if (!product) throw new ValidationError('Produit introuvable');

  const unitCost =
    input.unitCost !== undefined && input.unitCost !== null && Number(input.unitCost) > 0
      ? num(input.unitCost)
      : num(product.purchase_price);

  // 1. Consommation réelle.
  await addStockMovement(productId, 'exit', quantity, {
    referenceType: 'furniture_order',
    referenceId: orderId,
    motif: trimmed(input.motif) ?? materialMotif(order.order_number, product.name),
    userId: null,
  });

  // 2. Chutes de bois et pertes : un mouvement **distinct**, donc lisible.
  if (wastage > 0) {
    await addStockMovement(productId, 'exit', wastage, {
      referenceType: 'furniture_order',
      referenceId: orderId,
      motif: wastageMotif(order.order_number, product.name),
      userId: null,
    });
  }

  // 3. Instantanés + ligne de commande.
  const amount = roundMoney(quantity * unitCost);

  const inserted = await db
    .insert(furnitureOrderMaterials)
    .values({
      orderId,
      productId,
      productCode: String(product.code ?? ''),
      productName: String(product.name ?? ''),
      unit: String(product.unit ?? 'pièce'),
      quantity,
      wastageQuantity: wastage,
      unitCost,
      amount,
    })
    .returning({ id: furnitureOrderMaterials.id, syncId: furnitureOrderMaterials.syncId });

  await enqueueSyncWrite('furniture_order_materials', inserted[0]?.syncId, 'insert', {
    order_id: orderId,
    product_id: productId,
    product_code: product.code,
    product_name: product.name,
    unit: product.unit,
    quantity,
    wastage_quantity: wastage,
    unit_cost: unitCost,
    amount,
  });

  await recalculateOrderCosts(orderId);

  const updated = await getFurnitureOrder(orderId);
  if (!updated) throw new Error('Commande introuvable après ajout de matière');
  return updated;
}

/**
 * Retire une ligne de matériau : le stock est **ré-incrémenté** (entrée de
 * contrepassation) et les coûts recalculés. La ligne est marquée supprimée
 * (`deleted_at`) — jamais supprimée physiquement (§11 règle 2).
 */
export async function removeOrderMaterial(
  orderId: number,
  materialId: number,
): Promise<FurnitureOrderDetail> {
  const line = await rawGet<any>(
    `SELECT id, sync_id, product_id, product_code, product_name, unit, quantity, wastage_quantity, unit_cost
       FROM furniture_order_materials WHERE id = ? AND order_id = ? LIMIT 1`,
    [materialId, orderId],
  );
  if (!line) throw new ValidationError('Ligne de matériau introuvable sur cette commande');

  const order = await rawGet<{ order_number: string }>(
    'SELECT order_number FROM furniture_orders WHERE id = ? LIMIT 1',
    [orderId],
  );

  const quantity = num(line.quantity);
  const wastage = num(line.wastage_quantity);
  const productId = num(line.product_id);

  if (productId > 0) {
    if (quantity > 0) {
      await addStockMovement(productId, 'entry', quantity, {
        referenceType: 'furniture_order',
        referenceId: orderId,
        motif: `annulation matière — commande ${order?.order_number ?? orderId}`,
        userId: null,
      });
    }
    if (wastage > 0) {
      await addStockMovement(productId, 'entry', wastage, {
        referenceType: 'furniture_order',
        referenceId: orderId,
        motif: `reprise des chutes — commande ${order?.order_number ?? orderId}`,
        userId: null,
      });
    }
  }

  const now = new Date();
  await db
    .update(furnitureOrderMaterials)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(furnitureOrderMaterials.id, materialId));

  await enqueueSyncWrite('furniture_order_materials', line.sync_id, 'delete', {
    deleted_at: now.toISOString(),
  });

  await recalculateOrderCosts(orderId);

  const updated = await getFurnitureOrder(orderId);
  if (!updated) throw new Error('Commande introuvable après retrait de matière');
  return updated;
}

/**
 * Affecte un ouvrier (ou un journalier ponctuel) à une commande.
 * `days × dailyRate = amount` : aucune saisie de montant n'est nécessaire.
 */
export async function addOrderWorker(
  orderId: number,
  input: { workerId?: number | null; workerName?: string | null; role?: string | null; days: number; dailyRate: number },
): Promise<FurnitureOrderDetail> {
  const order = await rawGet<{ id: number; deleted_at: number | null }>(
    'SELECT id, deleted_at FROM furniture_orders WHERE id = ? LIMIT 1',
    [orderId],
  );
  if (!order) throw new Error('Commande introuvable');
  if (order.deleted_at) throw new ValidationError('Cette commande est annulée : affectation impossible');

  const days = num(input.days);
  const dailyRate = num(input.dailyRate);

  if (days <= 0) throw new ValidationError('Le nombre de jours doit être supérieur à zéro');
  if (dailyRate < 0) throw new ValidationError('Le tarif journalier ne peut pas être négatif');

  let workerId: number | null = num(input.workerId) || null;
  let workerName = trimmed(input.workerName);
  let role = trimmed(input.role);

  if (workerId) {
    const worker = await rawGet<any>(
      'SELECT id, name, role, daily_rate FROM workers WHERE id = ? LIMIT 1',
      [workerId],
    );
    if (!worker) throw new ValidationError('Ouvrier introuvable');
    workerName = workerName ?? worker.name;
    role = role ?? worker.role;
  } else {
    // Journalier ponctuel : `worker_name` est saisissable (§6.3).
    workerId = null;
    if (!workerName) throw new ValidationError('Indiquez le nom de l’ouvrier ou du journalier');
  }

  const amount = roundMoney(days * dailyRate);

  const inserted = await db
    .insert(furnitureOrderWorkers)
    .values({
      orderId,
      workerId,
      workerName: workerName ?? 'Ouvrier',
      role,
      days,
      dailyRate,
      amount,
    })
    .returning({ id: furnitureOrderWorkers.id, syncId: furnitureOrderWorkers.syncId });

  await enqueueSyncWrite('furniture_order_workers', inserted[0]?.syncId, 'insert', {
    order_id: orderId,
    worker_id: workerId,
    worker_name: workerName,
    role,
    days,
    daily_rate: dailyRate,
    amount,
  });

  await recalculateOrderCosts(orderId);

  const updated = await getFurnitureOrder(orderId);
  if (!updated) throw new Error('Commande introuvable après affectation');
  return updated;
}

export async function removeOrderWorker(
  orderId: number,
  workerLineId: number,
): Promise<FurnitureOrderDetail> {
  const line = await rawGet<{ id: number; sync_id: string }>(
    'SELECT id, sync_id FROM furniture_order_workers WHERE id = ? AND order_id = ? LIMIT 1',
    [workerLineId, orderId],
  );
  if (!line) throw new ValidationError('Ligne d’équipe introuvable sur cette commande');

  const now = new Date();
  await db
    .update(furnitureOrderWorkers)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(furnitureOrderWorkers.id, workerLineId));

  await enqueueSyncWrite('furniture_order_workers', line.sync_id, 'delete', {
    deleted_at: now.toISOString(),
  });

  await recalculateOrderCosts(orderId);

  const updated = await getFurnitureOrder(orderId);
  if (!updated) throw new Error('Commande introuvable après retrait de l’équipe');
  return updated;
}

/**
 * Annulation d'une commande : **jamais de suppression** (§7).
 *
 * Le motif est obligatoire — une annulation sans raison écrite est une perte
 * d'information comptable. Les matières déjà consommées sont **rendues au
 * stock** par des entrées de contrepassation, et le meuble fini n'est jamais
 * dé-crédité : s'il a été livré, c'est un retour de marchandise qui doit être
 * traité comme tel, pas une écriture silencieuse.
 */
export async function cancelFurnitureOrder(
  id: number,
  reason: string,
  user?: { id: number; name: string } | null,
): Promise<FurnitureOrderDetail> {
  const motif = trimmed(reason);
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire');

  const order = await rawGet<any>(
    'SELECT id, sync_id, order_number, deleted_at FROM furniture_orders WHERE id = ? LIMIT 1',
    [id],
  );
  if (!order) throw new Error('Commande introuvable');
  if (order.deleted_at) throw new ValidationError('Cette commande est déjà annulée');

  const materials = await getOrderMaterials(id);

  // Retour au stock des matières **réellement** sorties (consommation + chutes).
  for (const line of materials) {
    if (!line.productId || line.productId <= 0) continue;

    if (line.quantity > 0) {
      await addStockMovement(line.productId, 'entry', line.quantity, {
        referenceType: 'furniture_order',
        referenceId: id,
        motif: `annulation commande ${order.order_number} — retour matière`,
        userId: user?.id ?? null,
      });
    }
    if (line.wastageQuantity > 0) {
      await addStockMovement(line.productId, 'entry', line.wastageQuantity, {
        referenceType: 'furniture_order',
        referenceId: id,
        motif: `annulation commande ${order.order_number} — reprise des chutes`,
        userId: user?.id ?? null,
      });
    }
  }

  // Les lignes de la commande sont des enfants du document : on les marque
  // supprimées pour qu'elles ne ressuscitent pas au prochain pull (§23.7).
  const now = new Date();
  await db
    .update(furnitureOrderMaterials)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(furnitureOrderMaterials.orderId, id));
  await db
    .update(furnitureOrderWorkers)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(furnitureOrderWorkers.orderId, id));

  // Le motif d'annulation est conservé dans `notes` : `furniture_orders` ne
  // porte pas de colonne `cancel_reason` (contrairement à `sales_invoices`),
  // et le journal d'actions (`writeAudit`, appelé par la route) garde de toute
  // façon la trace structurée de l'opération.
  await db
    .update(furnitureOrders)
    .set({ deletedAt: now, updatedAt: now, notes: `Annulée : ${motif}` })
    .where(eq(furnitureOrders.id, id));

  await enqueueSyncWrite('furniture_orders', order.sync_id, 'delete', {
    deleted_at: now.toISOString(),
    cancel_reason: motif,
  });

  const updated = await getFurnitureOrder(id);
  if (!updated) throw new Error('Commande introuvable après annulation');
  return updated;
}

/* ------------------------------------------------------------------ *
 * Synthèse d'atelier (§21 : rapport fabriqués / en cours / livrés)
 * ------------------------------------------------------------------ */

export async function getWorkshopSummary(
  options: { from?: string; to?: string } = {},
): Promise<WorkshopSummary> {
  const where: string[] = [];
  const args: (string | number)[] = [];

  if (options.from) {
    where.push('COALESCE(o.start_date, o.promised_date, o.delivery_date) >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('COALESCE(o.start_date, o.promised_date, o.delivery_date) <= ?');
    args.push(options.to);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  /** Même filtre de période, appliqué aux tables enfants (lignes non annulées). */
  const childrenWhereSql = where.length > 0 ? `AND ${where.join(' AND ')}` : '';

  const row = await rawGet<any>(
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN o.deleted_at IS NULL THEN 1 ELSE 0 END) AS active_total,
        SUM(CASE WHEN o.deleted_at IS NULL AND o.stage <> 'delivered' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN o.deleted_at IS NULL AND o.stage = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN o.deleted_at IS NULL AND o.stage = 'delivered'
                  AND o.delivery_date IS NOT NULL AND o.promised_date IS NOT NULL
                  AND o.delivery_date <= o.promised_date THEN 1 ELSE 0 END) AS delivered_on_time,
        SUM(CASE WHEN o.deleted_at IS NULL AND o.delivery_date IS NOT NULL
                  AND o.promised_date IS NOT NULL AND o.delivery_date > o.promised_date
                 THEN 1 ELSE 0 END) AS late,
        SUM(CASE WHEN o.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN o.deleted_at IS NULL THEN o.agreed_price ELSE 0 END) AS revenue
       FROM furniture_orders o
       ${whereSql}`,
    args,
  );

  const costRow = await rawGet<any>(
    `SELECT
        COALESCE(SUM(om.amount), 0) AS material_cost,
        COALESCE(SUM(om.wastage_quantity), 0) AS wastage_total
       FROM furniture_order_materials om
       JOIN furniture_orders o ON o.id = om.order_id
      WHERE om.deleted_at IS NULL AND o.deleted_at IS NULL ${childrenWhereSql}`,
    args,
  );

  const laborRow = await rawGet<any>(
    `SELECT COALESCE(SUM(ow.amount), 0) AS labor_cost
       FROM furniture_order_workers ow
       JOIN furniture_orders o ON o.id = ow.order_id
      WHERE ow.deleted_at IS NULL AND o.deleted_at IS NULL ${childrenWhereSql}`,
    args,
  );

  const materialCost = roundMoney(num(costRow?.material_cost));
  const laborCost = roundMoney(num(laborRow?.labor_cost));
  const totalCost = roundMoney(materialCost + laborCost);
  const revenue = roundMoney(num(row?.revenue));
  const margin = roundMoney(revenue - totalCost);
  const activeTotal = num(row?.active_total);

  return {
    from: options.from ?? null,
    to: options.to ?? null,
    total: num(row?.total),
    manufactured: activeTotal,
    inProgress: num(row?.in_progress),
    delivered: num(row?.delivered),
    deliveredOnTime: num(row?.delivered_on_time),
    late: num(row?.late),
    cancelled: num(row?.cancelled),
    revenue,
    totalCost,
    margin,
    marginPercent: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : 0,
    totalWastage: Math.round(num(costRow?.wastage_total) * 1000) / 1000,
    materialCost,
    laborCost,
  };
}

/** Libellé d'une quantité de besoin, pour les messages d'alerte de stock. */
export function requirementShortageLabel(line: FurnitureRequirementLine): string {
  return `${line.productName} : manquant ${formatQuantityLabel(line.missingQuantity)} ${line.unit}`;
}
