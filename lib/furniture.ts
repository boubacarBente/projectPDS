/**
 * Atelier de meubles par magasin (README §29).
 *
 * Retiré en v2, rétabli le 7 octobre 2026 à la demande du client. Le module
 * reprend la v1 (modèles avec nomenclature, commandes suivies par étapes,
 * matières, chutes de bois, équipe, livraison à temps) **aux règles de la v2** :
 *
 * 1. **Tout appartient à un magasin** : un modèle, une commande, ses matières
 *    et son équipe. On n'écrit que dans le magasin actif ; un document d'un
 *    autre magasin se lit (`assertStoreVisible`) mais ne se modifie pas.
 * 2. **Deux natures de commande** : `customer` (commande d'un client, facturée
 *    au prix convenu, encaissée par `payments` de type `furniture_order`) et
 *    `stock` (fabrication pour le stock : jamais facturée, le meuble fini entre
 *    en stock à la dernière étape). ⚠️ En v1, *toute* commande portant un
 *    produit fini le faisait entrer en stock **à la livraison au client** : le
 *    meuble livré restait compté en stock.
 * 3. **Aucun total stocké hors paiements** : coût matières, main-d'œuvre, marge
 *    se calculent depuis les lignes ; `amount_paid` / `remaining_amount` sont
 *    recalculés depuis `payments` (invariant 2). La v1 stockait un « acompte »
 *    saisi à la main qui ne passait ni par la caisse ni par un reçu.
 * 4. **Les matières ne sont des lignes que lorsqu'elles sortent du stock.** En
 *    v1, la nomenclature était recopiée en lignes à la création, *sans* sortie
 *    de stock : ces lignes étaient comptées dans le coût, et l'annulation les
 *    « rendait » au stock — créant de la marchandise qui n'en était jamais
 *    sortie. Désormais la nomenclature donne des **besoins** (calculés), et
 *    « Sortir les matières prévues » les consomme réellement, tout ou rien.
 * 5. **Les chutes coûtent** : `amount = (quantité + chutes) × coût unitaire`.
 *    La v1 ne valorisait que la quantité utile ; le coût de revient était donc
 *    sous-estimé de toute la perte de bois.
 * 6. Annulation = statut `cancelled` + motif + auteur + date ; les matières
 *    sorties reviennent au stock. Une commande livrée ne s'annule pas.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { eq } from 'drizzle-orm';
import {
  furnitureModelMaterials,
  furnitureModels,
  furnitureOrderMaterials,
  furnitureOrders,
  furnitureOrderWorkers,
} from '@/db/schema';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api';
import { assertCustomerInStore } from '@/lib/customers';
import { addStockMovement } from '@/lib/stock';
import { getFurnitureBranch } from '@/lib/branches';
import { listPayments, recomputeDocumentPayments, type PaymentRow } from '@/lib/payments';
import { nextDocumentNumber } from '@/lib/settings';
import { roundMoney, today } from '@/lib/format';
import { scopeSql, type StoreScope } from '@/lib/stores';
import {
  FURNITURE_STAGES,
  furnitureStageIndex,
  furnitureStageLabel,
  isFurnitureStage,
  nextFurnitureStage,
  type FurniturePurpose,
  type FurnitureStage,
} from '@/lib/furniture-shared';

export type { FurniturePurpose, FurnitureStage } from '@/lib/furniture-shared';

/* ------------------------------------------------------------------ *
 * Types publics
 * ------------------------------------------------------------------ */

export type FurnitureModelRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  code: string;
  name: string;
  description: string | null;
  standardDimensions: string | null;
  laborHours: number;
  salePrice: number;
  isActive: boolean;
  /** Nombre de matériaux de la nomenclature (calculé). */
  materialCount: number;
  /** Coût matière estimé d'une unité, au prix d'achat du jour (calculé). */
  estimatedMaterialCost: number;
  orderCount: number;
  createdAt: Date | null;
};

export type FurnitureModelMaterialRow = {
  id: number;
  modelId: number;
  productId: number;
  productName: string;
  unit: string;
  quantity: number;
  notes: string | null;
  purchasePrice: number;
  /** Stock du produit **dans le magasin du modèle**. */
  availableStock: number;
  amount: number;
};

export type FurnitureModelInput = {
  code?: string | null;
  name: string;
  description?: string | null;
  standardDimensions?: string | null;
  laborHours?: number;
  salePrice?: number;
  isActive?: boolean;
};

export type FurnitureModelMaterialInput = {
  productId: number;
  quantity: number;
  unit?: string | null;
  notes?: string | null;
};

/** Besoin en matière pour N unités d'un modèle, stock du magasin et manquant compris. */
export type FurnitureRequirementLine = {
  productId: number;
  productName: string;
  unit: string;
  quantityPerUnit: number;
  requiredQuantity: number;
  /** Déjà sorti du stock pour cette commande (0 hors commande). */
  consumedQuantity: number;
  /** Reste à sortir : `max(0, requis − déjà sorti)`. */
  toConsumeQuantity: number;
  availableStock: number;
  /** Ce qu'il faudra acheter : `max(0, reste à sortir − disponible)`. */
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
  totalMaterialCost: number;
  isCovered: boolean;
  missingMaterialCount: number;
};

export type FurnitureOrderMaterialRow = {
  id: number;
  orderId: number;
  productId: number | null;
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
  orderId: number;
  workerId: number | null;
  workerName: string;
  role: string | null;
  days: number;
  dailyRate: number;
  amount: number;
  createdAt: Date | null;
};

/** Coûts d'une commande : `null` sans `balances.view` (invariant 13). */
export type FurnitureOrderCost = {
  materialCost: number | null;
  laborCost: number | null;
  totalCost: number | null;
  /** Coût de revient d'une unité (`totalCost ÷ quantité`). */
  unitCost: number | null;
  /** Prix convenu = montant facturé (0 pour une fabrication pour le stock). */
  agreedPrice: number;
  /** Marge d'une commande client ; `null` pour une fabrication pour le stock. */
  margin: number | null;
  marginPercent: number | null;
};

export type FurnitureOrderRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  orderNumber: string;
  purpose: FurniturePurpose;
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
  status: 'active' | 'cancelled';
  cancelReason: string | null;
  cancelledByName: string | null;
  cancelledAt: Date | null;
  /** Prix convenu (montant facturé). */
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  /** Coûts calculés depuis les lignes (masqués sans `balances.view`). */
  materialCost: number | null;
  laborCost: number | null;
  totalCost: number | null;
  margin: number | null;
  marginPercent: number | null;
  productId: number | null;
  productName: string | null;
  notes: string | null;
  isCancelled: boolean;
  isDelivered: boolean;
  /** Date promise dépassée (livrée en retard, ou pas encore livrée). */
  isLate: boolean;
  isDeliveredOnTime: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type FurnitureOrderDetail = {
  order: FurnitureOrderRow;
  materials: FurnitureOrderMaterialRow[];
  workers: FurnitureOrderWorkerRow[];
  costs: FurnitureOrderCost;
  /** Besoins calculés depuis la nomenclature du modèle (`null` sans modèle). */
  requirements: FurnitureRequirements | null;
  payments: PaymentRow[];
};

export type FurnitureOrderInput = {
  purpose?: FurniturePurpose;
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
  agreedPrice?: number;
  productId?: number | null;
  notes?: string | null;
};

export type FurnitureOrderPatch = Omit<FurnitureOrderInput, 'purpose'> & { deliveryDate?: string | null };

export type FurnitureOrderListOptions = {
  scope: StoreScope;
  search?: string;
  stage?: FurnitureStage;
  purpose?: FurniturePurpose;
  customerId?: number;
  lateOnly?: boolean;
  includeCancelled?: boolean;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  /** `recent` (défaut) ou `promised` (date promise la plus proche : planning). */
  sort?: 'recent' | 'promised';
};

export type WorkshopSummary = {
  from: string | null;
  to: string | null;
  total: number;
  inProgress: number;
  delivered: number;
  deliveredOnTime: number;
  late: number;
  cancelled: number;
  /** Prix convenus des commandes clients non annulées. */
  revenue: number;
  /** Encore dû par les clients sur ces commandes. */
  outstanding: number;
  materialCost: number | null;
  laborCost: number | null;
  totalCost: number | null;
  margin: number | null;
  marginPercent: number | null;
  totalWastage: number;
};

/* ------------------------------------------------------------------ *
 * Utilitaires
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

function businessDateOrNull(value: unknown): string | null {
  const text = trimmed(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ValidationError(`Date invalide : « ${text} »`);
  return text;
}

function qty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toDate(value: unknown): Date | null {
  return value ? new Date(num(value) * 1000) : null;
}

function marginOf(price: number, cost: number): { margin: number; marginPercent: number } {
  const margin = roundMoney(price - cost);
  return { margin, marginPercent: price > 0 ? Math.round((margin / price) * 1000) / 10 : 0 };
}

/* ------------------------------------------------------------------ *
 * Modèles — lecture
 * ------------------------------------------------------------------ */

const MODEL_SELECT = `
  SELECT m.id, m.store_id, s.name AS store_name, m.code, m.name, m.description,
         m.standard_dimensions, m.labor_hours, m.sale_price, m.is_active, m.created_at,
         (SELECT COUNT(*) FROM furniture_model_materials b WHERE b.model_id = m.id) AS material_count,
         (SELECT COUNT(*) FROM furniture_orders o WHERE o.model_id = m.id) AS order_count,
         (SELECT COALESCE(SUM(b.quantity * COALESCE(p.purchase_price, 0)), 0)
            FROM furniture_model_materials b
            LEFT JOIN products p ON p.id = b.product_id
           WHERE b.model_id = m.id) AS estimated_material_cost
    FROM furniture_models m
    LEFT JOIN stores s ON s.id = m.store_id`;

function mapModelRow(row: any): FurnitureModelRow {
  return {
    id: num(row.id),
    storeId: num(row.store_id),
    storeName: row.store_name ?? null,
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
    createdAt: toDate(row.created_at),
  };
}

export async function listFurnitureModels(options: {
  scope: StoreScope;
  search?: string;
  page?: number;
  limit?: number;
  includeInactive?: boolean;
  sort?: 'recent' | 'name';
}): Promise<{ data: FurnitureModelRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const where: string[] = [scopeSql('m.store_id', options.scope)];
  const args: (string | number)[] = [];
  if (!options.includeInactive) where.push('m.is_active = 1');
  if (options.search) {
    where.push('(m.code LIKE ? OR m.name LIKE ? OR m.description LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderBy = options.sort === 'name' ? 'm.name COLLATE NOCASE, m.id' : 'm.created_at DESC, m.id DESC';

  const rows = await rawAll<any>(`${MODEL_SELECT} ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
    ...args,
    limit,
    (page - 1) * limit,
  ]);
  const count = await rawGet<{ total: number }>(`SELECT COUNT(*) AS total FROM furniture_models m ${whereSql}`, args);
  const total = num(count?.total);
  return { data: rows.map(mapModelRow), total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

async function getModelRow(id: number): Promise<FurnitureModelRow | null> {
  const row = await rawGet<any>(`${MODEL_SELECT} WHERE m.id = ?`, [id]);
  return row ? mapModelRow(row) : null;
}

export async function getFurnitureModel(
  id: number,
): Promise<{ model: FurnitureModelRow; materials: FurnitureModelMaterialRow[] } | null> {
  const model = await getModelRow(id);
  if (!model) return null;
  return { model, materials: await getModelMaterials(id, model.storeId) };
}

/** Nomenclature d'un modèle, avec prix d'achat et stock **du magasin**. */
export async function getModelMaterials(modelId: number, storeId: number): Promise<FurnitureModelMaterialRow[]> {
  const rows = await rawAll<any>(
    `SELECT b.id, b.model_id, b.product_id, b.quantity, b.unit, b.notes,
            p.name AS product_name, p.unit AS product_unit, p.purchase_price,
            COALESCE((SELECT ps.quantity FROM product_stocks ps WHERE ps.product_id = b.product_id AND ps.store_id = ?), 0) AS stock
       FROM furniture_model_materials b
       LEFT JOIN products p ON p.id = b.product_id
      WHERE b.model_id = ?
      ORDER BY p.name COLLATE NOCASE, b.id`,
    [storeId, modelId],
  );
  return rows.map((row) => {
    const quantity = num(row.quantity);
    const purchasePrice = num(row.purchase_price);
    return {
      id: num(row.id),
      modelId: num(row.model_id),
      productId: num(row.product_id),
      productName: String(row.product_name ?? 'Produit introuvable'),
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
 * Modèles — écriture (magasin actif uniquement)
 * ------------------------------------------------------------------ */

/** Le modèle doit exister et appartenir au magasin actif. */
async function assertModelInStore(modelId: number, storeId: number): Promise<FurnitureModelRow> {
  const model = await getModelRow(modelId);
  if (!model) throw new NotFoundError('Modèle introuvable');
  if (model.storeId !== Number(storeId)) {
    throw new ValidationError(
      `Le modèle « ${model.name} » appartient au magasin ${model.storeName ?? 'd’un autre magasin'} : il ne se modifie que depuis ce magasin.`,
    );
  }
  return model;
}

/** Code `MOD-0001`, dérivé du plus grand code du magasin (aucun compteur consommé en cas d'échec). */
async function generateModelCode(storeId: number): Promise<string> {
  const rows = await rawAll<{ code: string }>(
    `SELECT code FROM furniture_models WHERE store_id = ? AND code LIKE 'MOD-%'`,
    [storeId],
  );
  const max = rows.reduce((acc, r) => Math.max(acc, Number(String(r.code).slice(4)) || 0), 0);
  return `MOD-${String(max + 1).padStart(4, '0')}`;
}

export async function createFurnitureModel(
  input: FurnitureModelInput & { storeId: number; userId?: number | null },
): Promise<FurnitureModelRow> {
  const name = trimmed(input.name);
  if (!name) throw new ValidationError('Le nom du modèle est obligatoire');
  const code = trimmed(input.code)?.toUpperCase() ?? (await generateModelCode(input.storeId));
  const duplicate = await rawGet('SELECT id FROM furniture_models WHERE store_id = ? AND code = ?', [input.storeId, code]);
  if (duplicate) throw new ValidationError(`Le code « ${code} » est déjà utilisé par un autre modèle de ce magasin`);
  const laborHours = num(input.laborHours);
  const salePrice = roundMoney(num(input.salePrice));
  if (laborHours < 0 || salePrice < 0) throw new ValidationError('Les heures et le prix doivent être positifs');

  const inserted = await db
    .insert(furnitureModels)
    .values({
      storeId: input.storeId,
      // L'atelier appartient à la filiale « Meuble » (README §31.9).
      branchId: (await getFurnitureBranch())?.id ?? null,
      code,
      name,
      description: trimmed(input.description),
      standardDimensions: trimmed(input.standardDimensions),
      laborHours,
      salePrice,
      isActive: input.isActive ?? true,
      userId: input.userId ?? null,
    })
    .returning({ id: furnitureModels.id });
  const created = await getModelRow(Number(inserted[0].id));
  if (!created) throw new NotFoundError('Modèle créé mais introuvable');
  return created;
}

export async function updateFurnitureModel(
  id: number,
  patch: Partial<FurnitureModelInput>,
  storeId: number,
): Promise<FurnitureModelRow> {
  await assertModelInStore(id, storeId);
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.code !== undefined) {
    const code = trimmed(patch.code)?.toUpperCase();
    if (!code) throw new ValidationError('Le code du modèle ne peut pas être vide');
    const duplicate = await rawGet('SELECT id FROM furniture_models WHERE store_id = ? AND code = ? AND id <> ?', [storeId, code, id]);
    if (duplicate) throw new ValidationError(`Le code « ${code} » est déjà utilisé par un autre modèle de ce magasin`);
    values.code = code;
  }
  if (patch.name !== undefined) {
    const name = trimmed(patch.name);
    if (!name) throw new ValidationError('Le nom du modèle est obligatoire');
    values.name = name;
  }
  if (patch.description !== undefined) values.description = trimmed(patch.description);
  if (patch.standardDimensions !== undefined) values.standardDimensions = trimmed(patch.standardDimensions);
  if (patch.laborHours !== undefined) {
    if (num(patch.laborHours) < 0) throw new ValidationError('Les heures doivent être positives');
    values.laborHours = num(patch.laborHours);
  }
  if (patch.salePrice !== undefined) {
    if (num(patch.salePrice) < 0) throw new ValidationError('Le prix doit être positif');
    values.salePrice = roundMoney(num(patch.salePrice));
  }
  if (patch.isActive !== undefined) values.isActive = Boolean(patch.isActive);

  await db.update(furnitureModels).set(values as any).where(eq(furnitureModels.id, id));
  const updated = await getModelRow(id);
  if (!updated) throw new NotFoundError('Modèle introuvable');
  return updated;
}

/** Désactivation (jamais de suppression : les commandes passées gardent leur modèle). */
export async function setFurnitureModelActive(id: number, isActive: boolean, storeId: number): Promise<FurnitureModelRow> {
  return updateFurnitureModel(id, { isActive }, storeId);
}

/**
 * Remplace la nomenclature d'un modèle. Une ligne retirée est supprimée : c'est
 * une **fiche de configuration**, pas un document — les commandes passées ont
 * leurs propres lignes de matières, qui ne dépendent pas de la nomenclature.
 */
export async function setModelMaterials(
  modelId: number,
  lines: FurnitureModelMaterialInput[],
  storeId: number,
): Promise<FurnitureModelMaterialRow[]> {
  return withTransaction(async () => {
    await assertModelInStore(modelId, storeId);
    const seen = new Set<number>();
    const cleaned: { productId: number; quantity: number; unit: string; notes: string | null }[] = [];
    for (const line of lines) {
      const productId = num(line.productId);
      const quantity = num(line.quantity);
      if (!Number.isInteger(productId) || productId <= 0) {
        throw new ValidationError('Chaque ligne de nomenclature doit désigner un produit');
      }
      if (quantity <= 0) throw new ValidationError('La quantité d’une ligne de nomenclature doit être supérieure à zéro');
      if (seen.has(productId)) throw new ValidationError('Un même produit apparaît deux fois dans la nomenclature');
      seen.add(productId);
      const product = await rawGet<{ unit: string }>('SELECT unit FROM products WHERE id = ?', [productId]);
      if (!product) throw new ValidationError('Produit introuvable dans la nomenclature');
      cleaned.push({ productId, quantity, unit: trimmed(line.unit) ?? product.unit, notes: trimmed(line.notes) });
    }

    const existing = await rawAll<{ id: number; product_id: number }>(
      'SELECT id, product_id FROM furniture_model_materials WHERE model_id = ?',
      [modelId],
    );
    const byProduct = new Map(existing.map((r) => [num(r.product_id), num(r.id)]));
    for (const line of cleaned) {
      const previous = byProduct.get(line.productId);
      if (previous) {
        // Mise à jour en place : la ligne garde son identité de synchronisation.
        await db
          .update(furnitureModelMaterials)
          .set({ quantity: line.quantity, unit: line.unit, notes: line.notes, updatedAt: new Date() })
          .where(eq(furnitureModelMaterials.id, previous));
        byProduct.delete(line.productId);
      } else {
        await db.insert(furnitureModelMaterials).values({ modelId, ...line });
      }
    }
    for (const id of byProduct.values()) {
      await db.delete(furnitureModelMaterials).where(eq(furnitureModelMaterials.id, id));
    }
    return getModelMaterials(modelId, storeId);
  });
}

/**
 * Besoins en matières pour N unités d'un modèle, sur le stock **du magasin**.
 * `consumed` (par produit) déduit ce qu'une commande a déjà sorti.
 */
export async function computeModelRequirements(
  modelId: number,
  quantity: number,
  storeId: number,
  consumed: Map<number, number> = new Map(),
): Promise<FurnitureRequirements> {
  const units = Math.max(0, num(quantity, 1));
  const model = await getModelRow(modelId);
  if (!model) {
    return { model: null, quantity: units, laborHours: 0, lines: [], totalMaterialCost: 0, isCovered: true, missingMaterialCount: 0 };
  }
  const materials = await getModelMaterials(modelId, storeId);
  const lines: FurnitureRequirementLine[] = materials.map((material) => {
    const requiredQuantity = qty(material.quantity * units);
    const consumedQuantity = qty(consumed.get(material.productId) ?? 0);
    const toConsumeQuantity = qty(Math.max(0, requiredQuantity - consumedQuantity));
    const missingQuantity = qty(Math.max(0, toConsumeQuantity - material.availableStock));
    return {
      productId: material.productId,
      productName: material.productName,
      unit: material.unit,
      quantityPerUnit: material.quantity,
      requiredQuantity,
      consumedQuantity,
      toConsumeQuantity,
      availableStock: material.availableStock,
      missingQuantity,
      purchasePrice: material.purchasePrice,
      estimatedCost: roundMoney(requiredQuantity * material.purchasePrice),
      isCovered: missingQuantity <= 0.0001,
    };
  });
  const missingMaterialCount = lines.filter((line) => !line.isCovered).length;
  return {
    model,
    quantity: units,
    laborHours: Math.round(model.laborHours * units * 100) / 100,
    lines,
    totalMaterialCost: roundMoney(lines.reduce((sum, line) => sum + line.estimatedCost, 0)),
    isCovered: missingMaterialCount === 0,
    missingMaterialCount,
  };
}

/* ------------------------------------------------------------------ *
 * Commandes — lecture
 * ------------------------------------------------------------------ */

const ORDER_SELECT = `
  SELECT o.*, s.name AS store_name, c.name AS joined_customer_name, m.name AS joined_model_name,
         p.name AS joined_product_name, cu.name AS cancelled_by_name,
         (SELECT COALESCE(SUM(om.amount), 0) FROM furniture_order_materials om WHERE om.order_id = o.id) AS computed_material_cost,
         (SELECT COALESCE(SUM(ow.amount), 0) FROM furniture_order_workers ow WHERE ow.order_id = o.id) AS computed_labor_cost
    FROM furniture_orders o
    LEFT JOIN stores s ON s.id = o.store_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN furniture_models m ON m.id = o.model_id
    LEFT JOIN products p ON p.id = o.product_id
    LEFT JOIN users cu ON cu.id = o.cancelled_by`;

function mapOrderRow(row: any): FurnitureOrderRow {
  const stage: FurnitureStage = isFurnitureStage(row.stage) ? row.stage : 'cutting';
  const purpose: FurniturePurpose = row.purpose === 'stock' ? 'stock' : 'customer';
  const promisedDate: string | null = row.promised_date ?? null;
  const deliveryDate: string | null = row.delivery_date ?? null;
  const isDelivered = stage === 'delivered';
  const isCancelled = row.status === 'cancelled';
  // Retard : livré après la date promise, ou date promise dépassée sans livraison.
  const isLate = Boolean(
    promisedDate && !isCancelled && (isDelivered ? Boolean(deliveryDate && deliveryDate > promisedDate) : today() > promisedDate),
  );

  const materialCost = roundMoney(num(row.computed_material_cost));
  const laborCost = roundMoney(num(row.computed_labor_cost));
  const totalCost = roundMoney(materialCost + laborCost);
  const total = num(row.total);
  const { margin, marginPercent } = marginOf(total, totalCost);

  return {
    id: num(row.id),
    storeId: num(row.store_id),
    storeName: row.store_name ?? null,
    orderNumber: String(row.order_number ?? ''),
    purpose,
    customerId: row.customer_id == null ? null : num(row.customer_id),
    customerName:
      purpose === 'stock' ? 'Stock du magasin' : String(row.customer_name ?? row.joined_customer_name ?? 'Client de passage'),
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
    stageLabel: isCancelled ? 'Annulée' : furnitureStageLabel(stage, purpose),
    status: isCancelled ? 'cancelled' : 'active',
    cancelReason: row.cancel_reason ?? null,
    cancelledByName: row.cancelled_by_name ?? null,
    cancelledAt: toDate(row.cancelled_at),
    total,
    amountPaid: num(row.amount_paid),
    remainingAmount: num(row.remaining_amount),
    paymentStatus: String(row.payment_status ?? 'unpaid'),
    materialCost,
    laborCost,
    totalCost,
    margin: purpose === 'customer' ? margin : null,
    marginPercent: purpose === 'customer' ? marginPercent : null,
    productId: row.product_id == null ? null : num(row.product_id),
    productName: row.joined_product_name ?? null,
    notes: row.notes ?? null,
    isCancelled,
    isDelivered,
    isLate,
    isDeliveredOnTime: Boolean(isDelivered && promisedDate && deliveryDate && deliveryDate <= promisedDate),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export async function listFurnitureOrders(options: FurnitureOrderListOptions): Promise<{
  data: FurnitureOrderRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const where: string[] = [scopeSql('o.store_id', options.scope)];
  const args: (string | number)[] = [];

  if (!options.includeCancelled) where.push(`o.status = 'active'`);
  if (options.search) {
    where.push('(o.order_number LIKE ? OR o.customer_name LIKE ? OR c.name LIKE ? OR o.model_name LIKE ? OR m.name LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like, like, like);
  }
  if (options.stage) {
    where.push('o.stage = ?');
    args.push(options.stage);
  }
  if (options.purpose) {
    where.push('o.purpose = ?');
    args.push(options.purpose);
  }
  if (options.customerId && options.customerId > 0) {
    where.push('o.customer_id = ?');
    args.push(options.customerId);
  }
  if (options.from) {
    where.push('o.start_date >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('o.start_date <= ?');
    args.push(options.to);
  }
  if (options.lateOnly) {
    where.push(`o.status = 'active' AND o.promised_date IS NOT NULL
      AND ((o.stage = 'delivered' AND o.delivery_date > o.promised_date) OR (o.stage <> 'delivered' AND o.promised_date < ?))`);
    args.push(today());
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderBy =
    options.sort === 'promised'
      ? 'o.promised_date IS NULL, o.promised_date, o.id DESC'
      : 'o.start_date DESC, o.id DESC';

  const rows = await rawAll<any>(`${ORDER_SELECT} ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
    ...args,
    limit,
    (page - 1) * limit,
  ]);
  const count = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM furniture_orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN furniture_models m ON m.id = o.model_id
     ${whereSql}`,
    args,
  );
  const total = num(count?.total);
  return { data: rows.map(mapOrderRow), total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

export async function getFurnitureOrderRow(id: number): Promise<FurnitureOrderRow | null> {
  const row = await rawGet<any>(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
  return row ? mapOrderRow(row) : null;
}

export async function getOrderMaterials(orderId: number): Promise<FurnitureOrderMaterialRow[]> {
  const rows = await rawAll<any>(
    `SELECT id, order_id, product_id, product_name, unit, quantity, wastage_quantity, unit_cost, amount, created_at
       FROM furniture_order_materials WHERE order_id = ? ORDER BY id`,
    [orderId],
  );
  return rows.map((row) => ({
    id: num(row.id),
    orderId: num(row.order_id),
    productId: row.product_id == null ? null : num(row.product_id),
    productName: String(row.product_name ?? ''),
    unit: String(row.unit ?? 'pièce'),
    quantity: num(row.quantity),
    wastageQuantity: num(row.wastage_quantity),
    unitCost: num(row.unit_cost),
    amount: roundMoney(num(row.amount)),
    createdAt: toDate(row.created_at),
  }));
}

export async function getOrderWorkers(orderId: number): Promise<FurnitureOrderWorkerRow[]> {
  const rows = await rawAll<any>(
    `SELECT id, order_id, worker_id, worker_name, role, days, daily_rate, amount, created_at
       FROM furniture_order_workers WHERE order_id = ? ORDER BY id`,
    [orderId],
  );
  return rows.map((row) => ({
    id: num(row.id),
    orderId: num(row.order_id),
    workerId: row.worker_id == null ? null : num(row.worker_id),
    workerName: String(row.worker_name ?? ''),
    role: row.role ?? null,
    days: num(row.days),
    dailyRate: num(row.daily_rate),
    amount: roundMoney(num(row.amount)),
    createdAt: toDate(row.created_at),
  }));
}

/** Quantités déjà sorties par produit (consommation utile + chutes). */
function consumedByProduct(materials: FurnitureOrderMaterialRow[]): Map<number, number> {
  const consumed = new Map<number, number>();
  for (const line of materials) {
    if (!line.productId) continue;
    consumed.set(line.productId, (consumed.get(line.productId) ?? 0) + line.quantity);
  }
  return consumed;
}

/** Fiche complète : commande, matières, équipe, coûts calculés, besoins, paiements. */
export async function getFurnitureOrder(id: number): Promise<FurnitureOrderDetail | null> {
  const order = await getFurnitureOrderRow(id);
  if (!order) return null;
  const [materials, workers, payments] = await Promise.all([
    getOrderMaterials(id),
    getOrderWorkers(id),
    listPayments({ scope: [order.storeId], type: 'furniture_order', referenceId: id, limit: 200 }),
  ]);
  const materialCost = roundMoney(materials.reduce((sum, line) => sum + line.amount, 0));
  const laborCost = roundMoney(workers.reduce((sum, line) => sum + line.amount, 0));
  const totalCost = roundMoney(materialCost + laborCost);
  const { margin, marginPercent } = marginOf(order.total, totalCost);
  const requirements =
    order.modelId && !order.isCustom
      ? await computeModelRequirements(order.modelId, order.quantity, order.storeId, consumedByProduct(materials))
      : null;

  return {
    order,
    materials,
    workers,
    costs: {
      materialCost,
      laborCost,
      totalCost,
      unitCost: order.quantity > 0 ? roundMoney(totalCost / order.quantity) : totalCost,
      agreedPrice: order.total,
      margin: order.purpose === 'customer' ? margin : null,
      marginPercent: order.purpose === 'customer' ? marginPercent : null,
    },
    requirements,
    payments: payments.data,
  };
}

/** Retire les coûts et marges d'une ligne (invariant 13 : sans `balances.view`). */
export function hideOrderCosts(order: FurnitureOrderRow): FurnitureOrderRow {
  return { ...order, materialCost: null, laborCost: null, totalCost: null, margin: null, marginPercent: null };
}

/** Même chose pour une fiche complète. */
export function hideDetailCosts(detail: FurnitureOrderDetail): FurnitureOrderDetail {
  return {
    ...detail,
    order: hideOrderCosts(detail.order),
    costs: { ...detail.costs, materialCost: null, laborCost: null, totalCost: null, unitCost: null, margin: null, marginPercent: null },
  };
}

/* ------------------------------------------------------------------ *
 * Commandes — écriture
 * ------------------------------------------------------------------ */

/**
 * La commande doit exister, appartenir au magasin actif et être active.
 * `allowDelivered` : les informations (notes, dates) restent modifiables
 * après la livraison ; pas les matières ni l'équipe.
 */
async function assertOrderEditable(
  orderId: number,
  storeId: number,
  options: { allowDelivered?: boolean } = {},
): Promise<FurnitureOrderRow> {
  const order = await getFurnitureOrderRow(orderId);
  if (!order) throw new NotFoundError('Commande d’atelier introuvable');
  if (order.storeId !== Number(storeId)) {
    throw new ValidationError(
      `Cette commande appartient au magasin ${order.storeName ?? 'd’un autre magasin'} : elle ne se modifie que depuis ce magasin.`,
    );
  }
  if (order.isCancelled) throw new ConflictError('Cette commande est annulée : elle ne se modifie plus.');
  if (order.isDelivered && !options.allowDelivered) {
    throw new ConflictError(
      order.purpose === 'stock'
        ? 'Ce meuble est déjà en stock : la commande ne se modifie plus.'
        : 'Cette commande est livrée : ses matières et son équipe ne se modifient plus.',
    );
  }
  return order;
}

async function resolveModelForOrder(modelId: number | null, storeId: number): Promise<{ id: number; name: string } | null> {
  if (!modelId) return null;
  const model = await assertModelInStore(modelId, storeId);
  if (!model.isActive) throw new ValidationError(`Le modèle « ${model.name} » est désactivé.`);
  return { id: model.id, name: model.name };
}

/** Produit fini d'une fabrication pour le stock : obligatoire, il recevra l'entrée en stock. */
async function resolveFinishedProduct(productId: number | null): Promise<number> {
  if (!productId) {
    throw new ValidationError('Choisissez le produit fini : c’est lui qui entrera en stock à la fin de la fabrication.');
  }
  const product = await rawGet<{ id: number }>('SELECT id FROM products WHERE id = ?', [productId]);
  if (!product) throw new ValidationError('Produit fini introuvable');
  return productId;
}

export async function createFurnitureOrder(
  input: FurnitureOrderInput & { storeId: number; userId?: number | null },
): Promise<FurnitureOrderRow> {
  return withTransaction(async () => {
    if (!input.storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');
    const purpose: FurniturePurpose = input.purpose === 'stock' ? 'stock' : 'customer';
    const isCustom = Boolean(input.isCustom);
    const quantity = num(input.quantity, 1);
    if (quantity <= 0) throw new ValidationError('La quantité doit être supérieure à zéro');

    const model = isCustom ? null : await resolveModelForOrder(num(input.modelId) || null, input.storeId);
    if (!isCustom && !model) {
      throw new ValidationError('Choisissez un modèle, ou cochez « Sur mesure ».');
    }

    let customerId: number | null = null;
    let customerName: string | null = null;
    let total = 0;
    let productId: number | null = null;
    if (purpose === 'customer') {
      const id = num(input.customerId) || null;
      if (id) {
        // Le client doit être de ce magasin (README §28.5).
        const customer = await assertCustomerInStore(id, input.storeId);
        customerId = customer.id;
        customerName = customer.name;
      } else {
        customerName = trimmed(input.customerName) ?? 'Client de passage';
      }
      total = roundMoney(num(input.agreedPrice));
      if (total < 0) throw new ValidationError('Le prix convenu doit être positif');
    } else {
      productId = await resolveFinishedProduct(num(input.productId) || null);
    }

    const startDate = businessDateOrNull(input.startDate) ?? today();
    const promisedDate = businessDateOrNull(input.promisedDate);
    if (promisedDate && promisedDate < startDate) {
      throw new ValidationError('La date promise ne peut pas précéder la date de début.');
    }

    const inserted = await db
      .insert(furnitureOrders)
      .values({
        storeId: input.storeId,
        branchId: (await getFurnitureBranch())?.id ?? null,
        orderNumber: await nextDocumentNumber('furniture', input.storeId),
        purpose,
        customerId,
        customerName,
        modelId: model?.id ?? null,
        modelName: model?.name ?? trimmed(input.modelName) ?? 'Sur mesure',
        isCustom,
        dimensions: trimmed(input.dimensions),
        finish: trimmed(input.finish),
        quantity,
        startDate,
        promisedDate,
        stage: 'cutting',
        status: 'active',
        total,
        amountPaid: 0,
        remainingAmount: total,
        paymentStatus: 'unpaid',
        productId,
        userId: input.userId ?? null,
        notes: trimmed(input.notes),
      })
      .returning({ id: furnitureOrders.id });

    const created = await getFurnitureOrderRow(Number(inserted[0].id));
    if (!created) throw new NotFoundError('Commande créée mais introuvable');
    return created;
  });
}

/**
 * Modification des informations. L'étape ne change **pas** ici
 * (`advanceFurnitureStage`), ni la nature de la commande.
 */
export async function updateFurnitureOrder(
  id: number,
  patch: FurnitureOrderPatch,
  storeId: number,
): Promise<FurnitureOrderRow> {
  return withTransaction(async () => {
    const order = await assertOrderEditable(id, storeId, { allowDelivered: true });
    const values: Record<string, unknown> = { updatedAt: new Date() };
    // Ce qui change le meuble fabriqué ne se modifie plus une fois livré.
    const touchesProduct =
      patch.modelId !== undefined || patch.isCustom !== undefined || patch.quantity !== undefined || patch.productId !== undefined;
    if (order.isDelivered && touchesProduct) {
      throw new ConflictError('Cette commande est livrée : le modèle, la quantité et le produit fini ne se modifient plus.');
    }

    if (order.purpose === 'customer' && (patch.customerId !== undefined || patch.customerName !== undefined)) {
      const customerId = num(patch.customerId) || null;
      if (customerId) {
        const customer = await assertCustomerInStore(customerId, storeId);
        values.customerId = customer.id;
        values.customerName = customer.name;
      } else {
        values.customerId = null;
        values.customerName = trimmed(patch.customerName) ?? 'Client de passage';
      }
    }
    if (patch.isCustom !== undefined) values.isCustom = Boolean(patch.isCustom);
    const isCustom = patch.isCustom !== undefined ? Boolean(patch.isCustom) : order.isCustom;
    if (patch.modelId !== undefined || patch.isCustom !== undefined) {
      const model = isCustom ? null : await resolveModelForOrder(num(patch.modelId ?? order.modelId) || null, storeId);
      if (!isCustom && !model) throw new ValidationError('Choisissez un modèle, ou cochez « Sur mesure ».');
      values.modelId = model?.id ?? null;
      values.modelName = model?.name ?? trimmed(patch.modelName) ?? 'Sur mesure';
    }
    if (patch.dimensions !== undefined) values.dimensions = trimmed(patch.dimensions);
    if (patch.finish !== undefined) values.finish = trimmed(patch.finish);
    if (patch.quantity !== undefined) {
      const quantity = num(patch.quantity);
      if (quantity <= 0) throw new ValidationError('La quantité doit être supérieure à zéro');
      values.quantity = quantity;
    }
    const startDate = patch.startDate !== undefined ? businessDateOrNull(patch.startDate) ?? today() : order.startDate;
    const promisedDate = patch.promisedDate !== undefined ? businessDateOrNull(patch.promisedDate) : order.promisedDate;
    if (startDate && promisedDate && promisedDate < startDate) {
      throw new ValidationError('La date promise ne peut pas précéder la date de début.');
    }
    if (patch.startDate !== undefined) values.startDate = startDate;
    if (patch.promisedDate !== undefined) values.promisedDate = promisedDate;
    if (patch.deliveryDate !== undefined) {
      if (!order.isDelivered) throw new ValidationError('La date de livraison se pose à la livraison (dernière étape).');
      const deliveryDate = businessDateOrNull(patch.deliveryDate);
      if (!deliveryDate) throw new ValidationError('Une commande livrée garde une date de livraison.');
      values.deliveryDate = deliveryDate;
    }
    if (order.purpose === 'customer' && patch.agreedPrice !== undefined) {
      const total = roundMoney(num(patch.agreedPrice));
      if (total < 0) throw new ValidationError('Le prix convenu doit être positif');
      // Un montant facturé ne descend jamais sous ce que le client a déjà payé.
      if (total + 0.01 < order.amountPaid) {
        throw new ConflictError(
          `Le client a déjà payé ${order.amountPaid.toLocaleString('fr-FR')} : le prix convenu ne peut pas descendre en dessous.`,
        );
      }
      values.total = total;
    }
    if (order.purpose === 'stock' && patch.productId !== undefined) {
      values.productId = await resolveFinishedProduct(num(patch.productId) || null);
    }
    if (patch.notes !== undefined) values.notes = trimmed(patch.notes);

    await db.update(furnitureOrders).set(values as any).where(eq(furnitureOrders.id, id));
    if (values.total !== undefined) await recomputeDocumentPayments('furniture_order', id);
    const updated = await getFurnitureOrderRow(id);
    if (!updated) throw new NotFoundError('Commande introuvable');
    return updated;
  });
}

/**
 * Passe la commande à l'**étape suivante** (aucun saut, aucun retour).
 *
 * La dernière étape :
 *  - commande client → « Livré », date de livraison posée (aujourd'hui par défaut) ;
 *  - fabrication pour le stock → « Mis en stock » : **une** entrée de
 *    `quantity` unités du produit fini dans le magasin. Le journal de stock
 *    fait foi : si une entrée existe déjà pour cette commande (import de
 *    synchronisation, double clic), on ne recrédite pas.
 */
export async function advanceFurnitureStage(
  id: number,
  target: FurnitureStage,
  storeId: number,
  options: { userId?: number | null; deliveryDate?: string | null } = {},
): Promise<FurnitureOrderRow> {
  if (!isFurnitureStage(target)) throw new ValidationError('Étape d’atelier inconnue');
  return withTransaction(async () => {
    const order = await assertOrderEditable(id, storeId);
    const next = nextFurnitureStage(order.stage);
    if (!next || target !== next) {
      throw new ValidationError(
        `La commande est à l’étape « ${order.stageLabel} » : elle ne peut passer qu’à « ${
          next ? furnitureStageLabel(next, order.purpose) : '—'
        } ».`,
      );
    }

    const values: Record<string, unknown> = { stage: target, updatedAt: new Date() };
    if (target === 'delivered') {
      const deliveryDate = businessDateOrNull(options.deliveryDate) ?? today();
      if (order.startDate && deliveryDate < order.startDate) {
        throw new ValidationError('La date de livraison ne peut pas précéder la date de début.');
      }
      values.deliveryDate = deliveryDate;
    }
    await db.update(furnitureOrders).set(values as any).where(eq(furnitureOrders.id, id));

    if (target === 'delivered' && order.purpose === 'stock' && order.productId) {
      const already = await rawGet<{ n: number }>(
        `SELECT COUNT(*) AS n FROM stock_movements
          WHERE reference_type = 'furniture_order' AND reference_id = ? AND type = 'entry' AND product_id = ?`,
        [id, order.productId],
      );
      if (num(already?.n) === 0) {
        await addStockMovement(order.productId, 'entry', order.quantity, {
          storeId,
          referenceType: 'furniture_order',
          referenceId: id,
          motif: `fabrication atelier ${order.orderNumber} : ${order.modelName}`,
          userId: options.userId ?? null,
        });
      }
    }

    const updated = await getFurnitureOrderRow(id);
    if (!updated) throw new NotFoundError('Commande introuvable');
    return updated;
  });
}

/** Insère une ligne de matière et sort la quantité (et les chutes) du stock du magasin. */
async function consumeMaterialInTx(
  order: FurnitureOrderRow,
  input: { productId: number; quantity: number; wastageQuantity?: number; unitCost?: number | null; userId?: number | null },
  storeId: number,
): Promise<FurnitureOrderMaterialRow> {
  const productId = num(input.productId);
  if (!Number.isInteger(productId) || productId <= 0) throw new ValidationError('Sélectionnez un produit');
  const quantity = qty(num(input.quantity));
  const wastage = qty(Math.max(0, num(input.wastageQuantity)));
  if (quantity <= 0) throw new ValidationError('La quantité doit être supérieure à zéro');

  const product = await rawGet<{ id: number; name: string; unit: string; purchase_price: number | null }>(
    'SELECT id, name, unit, purchase_price FROM products WHERE id = ?',
    [productId],
  );
  if (!product) throw new NotFoundError('Produit introuvable');
  const unitCost = roundMoney(
    input.unitCost !== undefined && input.unitCost !== null && num(input.unitCost) > 0
      ? num(input.unitCost)
      : num(product.purchase_price),
  );

  const inserted = await db
    .insert(furnitureOrderMaterials)
    .values({
      orderId: order.id,
      productId,
      productName: product.name,
      unit: product.unit,
      quantity,
      wastageQuantity: wastage,
      unitCost,
      // Les chutes ont été achetées comme le reste : elles font partie du coût.
      amount: roundMoney((quantity + wastage) * unitCost),
    })
    .returning();

  // Dans la transaction : un stock insuffisant annule la ligne avec (aucun stock négatif).
  await addStockMovement(productId, 'exit', quantity, {
    storeId,
    referenceType: 'furniture_order',
    referenceId: order.id,
    motif: `matières atelier ${order.orderNumber} : ${product.name}`,
    userId: input.userId ?? null,
  });
  if (wastage > 0) {
    // Mouvement distinct : les chutes restent lisibles dans le journal de stock.
    await addStockMovement(productId, 'exit', wastage, {
      storeId,
      referenceType: 'furniture_order',
      referenceId: order.id,
      motif: `chutes de bois atelier ${order.orderNumber} : ${product.name}`,
      userId: input.userId ?? null,
    });
  }

  const row = inserted[0];
  return {
    id: row.id,
    orderId: row.orderId,
    productId: row.productId,
    productName: row.productName,
    unit: row.unit,
    quantity: num(row.quantity),
    wastageQuantity: num(row.wastageQuantity),
    unitCost: num(row.unitCost),
    amount: num(row.amount),
    createdAt: row.createdAt,
  };
}

export async function addOrderMaterial(
  orderId: number,
  input: { productId: number; quantity: number; wastageQuantity?: number; unitCost?: number | null; userId?: number | null },
  storeId: number,
): Promise<FurnitureOrderMaterialRow> {
  return withTransaction(async () => {
    const order = await assertOrderEditable(orderId, storeId);
    return consumeMaterialInTx(order, input, storeId);
  });
}

/**
 * « Sortir les matières prévues » : consomme d'un coup ce que la nomenclature
 * demande et qui n'est pas encore sorti. **Tout ou rien** : si une seule
 * matière manque, rien ne sort (la transaction est annulée) et le message dit
 * laquelle.
 */
export async function consumePlannedMaterials(
  orderId: number,
  storeId: number,
  userId?: number | null,
): Promise<FurnitureOrderMaterialRow[]> {
  return withTransaction(async () => {
    const order = await assertOrderEditable(orderId, storeId);
    if (!order.modelId || order.isCustom) {
      throw new ValidationError('Une commande sur mesure n’a pas de nomenclature : ajoutez ses matières une à une.');
    }
    const requirements = await computeModelRequirements(
      order.modelId,
      order.quantity,
      storeId,
      consumedByProduct(await getOrderMaterials(orderId)),
    );
    const toConsume = requirements.lines.filter((line) => line.toConsumeQuantity > 0);
    if (toConsume.length === 0) throw new ValidationError('Toutes les matières prévues sont déjà sorties du stock.');
    const missing = toConsume.filter((line) => !line.isCovered);
    if (missing.length > 0) {
      throw new ValidationError(
        `Stock insuffisant dans ce magasin : ${missing
          .map((line) => `${line.productName} (manque ${String(line.missingQuantity).replace('.', ',')} ${line.unit})`)
          .join(', ')}. Rien n’a été sorti.`,
      );
    }
    const added: FurnitureOrderMaterialRow[] = [];
    for (const line of toConsume) {
      added.push(await consumeMaterialInTx(order, { productId: line.productId, quantity: line.toConsumeQuantity, userId }, storeId));
    }
    return added;
  });
}

/**
 * Retire une ligne de matière : la quantité **et les chutes** reviennent au
 * stock (correction de saisie, tracée au journal de stock et d'audit).
 */
export async function removeOrderMaterial(
  orderId: number,
  materialId: number,
  storeId: number,
  userId?: number | null,
): Promise<FurnitureOrderMaterialRow> {
  return withTransaction(async () => {
    const order = await assertOrderEditable(orderId, storeId);
    const line = (await getOrderMaterials(orderId)).find((m) => m.id === materialId);
    if (!line) throw new NotFoundError('Ligne de matière introuvable sur cette commande');
    await db.delete(furnitureOrderMaterials).where(eq(furnitureOrderMaterials.id, materialId));
    if (line.productId) {
      const back = qty(line.quantity + line.wastageQuantity);
      if (back > 0) {
        await addStockMovement(line.productId, 'entry', back, {
          storeId,
          referenceType: 'furniture_order',
          referenceId: orderId,
          motif: `retour matière atelier ${order.orderNumber} : ${line.productName}`,
          userId: userId ?? null,
        });
      }
    }
    return line;
  });
}

/** Un ouvrier rattaché à un autre magasin ne travaille pas dans cet atelier. */
async function assertWorkerAvailable(workerId: number, storeId: number) {
  const worker = await rawGet<{ store_id: number | null }>('SELECT store_id FROM workers WHERE id = ?', [workerId]);
  if (worker && worker.store_id != null && Number(worker.store_id) !== Number(storeId)) {
    throw new ValidationError('Cet ouvrier est rattaché à un autre magasin.');
  }
}

/** Affecte un ouvrier (ou un journalier ponctuel) : `amount = jours × tarif`. */
export async function addOrderWorker(
  orderId: number,
  input: { workerId?: number | null; workerName?: string | null; role?: string | null; days: number; dailyRate?: number | null },
  storeId: number,
): Promise<FurnitureOrderWorkerRow> {
  return withTransaction(async () => {
    await assertOrderEditable(orderId, storeId);
    const days = num(input.days);
    if (days <= 0) throw new ValidationError('Le nombre de jours doit être supérieur à zéro');

    let workerId: number | null = null;
    let workerName = trimmed(input.workerName);
    let role = trimmed(input.role);
    let dailyRate = input.dailyRate === undefined || input.dailyRate === null ? null : num(input.dailyRate);
    if (input.workerId) {
      const worker = await rawGet<{ id: number; name: string; role: string | null; daily_rate: number | null }>(
        'SELECT id, name, role, daily_rate FROM workers WHERE id = ?',
        [num(input.workerId)],
      );
      if (!worker) throw new NotFoundError('Ouvrier introuvable');
      await assertWorkerAvailable(num(worker.id), storeId);
      workerId = num(worker.id);
      workerName = workerName ?? worker.name;
      role = role ?? worker.role;
      if (dailyRate === null) dailyRate = num(worker.daily_rate);
    }
    if (!workerName) throw new ValidationError('Indiquez le nom de l’ouvrier ou du journalier');
    const rate = roundMoney(dailyRate ?? 0);
    if (rate < 0) throw new ValidationError('Le tarif journalier ne peut pas être négatif');

    const inserted = await db
      .insert(furnitureOrderWorkers)
      .values({ orderId, workerId, workerName, role, days, dailyRate: rate, amount: roundMoney(days * rate) })
      .returning();
    const row = inserted[0];
    return {
      id: row.id,
      orderId: row.orderId,
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

export async function removeOrderWorker(orderId: number, lineId: number, storeId: number): Promise<FurnitureOrderWorkerRow> {
  return withTransaction(async () => {
    await assertOrderEditable(orderId, storeId);
    const line = (await getOrderWorkers(orderId)).find((w) => w.id === lineId);
    if (!line) throw new NotFoundError('Affectation introuvable sur cette commande');
    await db.delete(furnitureOrderWorkers).where(eq(furnitureOrderWorkers.id, lineId));
    return line;
  });
}

/**
 * Annule une commande — **jamais de suppression**. Motif obligatoire ; les
 * matières sorties (et leurs chutes) reviennent au stock. Une commande livrée
 * ou mise en stock ne s'annule pas : le meuble existe, c'est un retour à
 * traiter comme tel.
 */
export async function cancelFurnitureOrder(
  id: number,
  reason: string,
  user: { id: number; storeId: number },
): Promise<FurnitureOrderRow> {
  const motif = trimmed(reason);
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire');
  return withTransaction(async () => {
    const order = await assertOrderEditable(id, user.storeId);
    for (const line of await getOrderMaterials(id)) {
      if (!line.productId) continue;
      const back = qty(line.quantity + line.wastageQuantity);
      if (back <= 0) continue;
      await addStockMovement(line.productId, 'entry', back, {
        storeId: user.storeId,
        referenceType: 'furniture_order',
        referenceId: id,
        motif: `annulation atelier ${order.orderNumber} : ${line.productName}`,
        userId: user.id,
      });
    }
    await db
      .update(furnitureOrders)
      .set({ status: 'cancelled', cancelReason: motif, cancelledBy: user.id, cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(furnitureOrders.id, id));
    await recomputeDocumentPayments('furniture_order', id);
    const updated = await getFurnitureOrderRow(id);
    if (!updated) throw new NotFoundError('Commande introuvable');
    return updated;
  });
}

/* ------------------------------------------------------------------ *
 * Synthèse de l'atelier (fabriqués, en cours, livrés, à temps)
 * ------------------------------------------------------------------ */

export async function getWorkshopSummary(options: {
  scope: StoreScope;
  from?: string;
  to?: string;
  withCosts: boolean;
}): Promise<WorkshopSummary> {
  const where = [scopeSql('o.store_id', options.scope)];
  const args: string[] = [];
  if (options.from) {
    where.push('o.start_date >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('o.start_date <= ?');
    args.push(options.to);
  }
  const whereSql = where.join(' AND ');
  const now = today();

  const row = await rawGet<any>(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN o.status = 'active' AND o.stage <> 'delivered' THEN 1 ELSE 0 END) AS in_progress,
       SUM(CASE WHEN o.status = 'active' AND o.stage = 'delivered' THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN o.status = 'active' AND o.stage = 'delivered' AND o.promised_date IS NOT NULL
                 AND o.delivery_date <= o.promised_date THEN 1 ELSE 0 END) AS delivered_on_time,
       SUM(CASE WHEN o.status = 'active' AND o.promised_date IS NOT NULL
                 AND ((o.stage = 'delivered' AND o.delivery_date > o.promised_date)
                   OR (o.stage <> 'delivered' AND o.promised_date < ?)) THEN 1 ELSE 0 END) AS late,
       SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
       SUM(CASE WHEN o.status = 'active' AND o.purpose = 'customer' THEN o.total ELSE 0 END) AS revenue,
       SUM(CASE WHEN o.status = 'active' AND o.purpose = 'customer' THEN o.remaining_amount ELSE 0 END) AS outstanding
     FROM furniture_orders o WHERE ${whereSql}`,
    [now, ...args],
  );
  // Coûts des commandes clients seulement : la marge se compare à leur prix.
  const costRow = await rawGet<any>(
    `SELECT
       (SELECT COALESCE(SUM(om.amount), 0) FROM furniture_order_materials om JOIN furniture_orders o ON o.id = om.order_id
         WHERE o.status = 'active' AND o.purpose = 'customer' AND ${whereSql}) AS material_cost,
       (SELECT COALESCE(SUM(om.wastage_quantity), 0) FROM furniture_order_materials om JOIN furniture_orders o ON o.id = om.order_id
         WHERE o.status = 'active' AND ${whereSql}) AS wastage,
       (SELECT COALESCE(SUM(ow.amount), 0) FROM furniture_order_workers ow JOIN furniture_orders o ON o.id = ow.order_id
         WHERE o.status = 'active' AND o.purpose = 'customer' AND ${whereSql}) AS labor_cost`,
    [...args, ...args, ...args],
  );

  const revenue = roundMoney(num(row?.revenue));
  const materialCost = roundMoney(num(costRow?.material_cost));
  const laborCost = roundMoney(num(costRow?.labor_cost));
  const totalCost = roundMoney(materialCost + laborCost);
  const { margin, marginPercent } = marginOf(revenue, totalCost);
  return {
    from: options.from ?? null,
    to: options.to ?? null,
    total: num(row?.total),
    inProgress: num(row?.in_progress),
    delivered: num(row?.delivered),
    deliveredOnTime: num(row?.delivered_on_time),
    late: num(row?.late),
    cancelled: num(row?.cancelled),
    revenue,
    outstanding: roundMoney(num(row?.outstanding)),
    materialCost: options.withCosts ? materialCost : null,
    laborCost: options.withCosts ? laborCost : null,
    totalCost: options.withCosts ? totalCost : null,
    margin: options.withCosts ? margin : null,
    marginPercent: options.withCosts ? marginPercent : null,
    totalWastage: qty(num(costRow?.wastage)),
  };
}

export { FURNITURE_STAGES, furnitureStageIndex };
