/**
 * Moteur de stock unique (§4, §12).
 *
 * Invariant non négociable : `products.stock` = **somme algébrique** des
 * mouvements de `stock_movements`. Toute correction passe par `adjustStock()`
 * et `adjustment` stocke un **écart signé**, jamais une valeur absolue — c'est
 * ce qui préserve l'invariant (README §6.1).
 *
 * Trois types suffisent : `entry` (achat, mise en stock d'une production),
 * `exit` (vente, matériaux de chantier, matières premières consommées, meuble
 * livré), `adjustment` (inventaire). Les briques cassées (§17) et les chutes de
 * bois (§18) sont des `exit` avec un motif explicite, pas un type dédié.
 */

import { db, schema } from '@/db';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { enqueueSyncWrite } from '@/lib/sync';
import { DEFAULT_LIST_SORT, type ListSort } from '@/lib/list-sort';

export type StockMovementType = 'entry' | 'exit' | 'adjustment';

export type StockReferenceType =
  | 'sale'
  | 'purchase'
  | 'brick_production'
  | 'furniture_order'
  | 'service_job'
  | 'inventory';

/** Contexte d'exécution : la base, ou une transaction Drizzle. */
type Executor = typeof db | any;

export type AddStockMovementOptions = {
  referenceType?: StockReferenceType | null;
  referenceId?: number | null;
  motif?: string;
  userId?: number | null;
  /** Autorise un stock négatif (inventaire d'ouverture, régularisation). */
  allowNegative?: boolean;
  executor?: Executor;
};

export class InsufficientStockError extends Error {
  readonly status = 400;
  constructor(
    readonly productName: string,
    readonly available: number,
    readonly requested: number,
  ) {
    super(
      `Stock insuffisant : ${productName} (disponible : ${available}, demandé : ${requested})`,
    );
    this.name = 'InsufficientStockError';
  }
}

export type StockProduct = {
  id: number;
  name: string;
  unit: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryKind: string | null;
  stock: number;
  stockMin: number;
  purchasePrice: number;
  salePrice: number;
  stockValue: number;
  saleValue: number;
  isLow: boolean;
  isOut: boolean;
};

export type StockMovementRow = {
  id: number;
  productId: number;
  productName: string;
  unit: string;
  type: StockMovementType;
  quantity: number;
  motif: string;
  stockBefore: number;
  stockAfter: number;
  referenceType: string | null;
  referenceId: number | null;
  userId: number | null;
  userName: string | null;
  createdAt: Date | null;
};

/**
 * Insère un mouvement **et** met à jour `products.stock` dans la même
 * transaction logique, en conservant `stock_before` / `stock_after`.
 */
export async function addStockMovement(
  productId: number,
  type: StockMovementType,
  quantity: number,
  options: AddStockMovementOptions = {},
): Promise<{ stockBefore: number; stockAfter: number; movementId: number }> {
  const exec: Executor = options.executor ?? db;
  const qty = Number(quantity);

  if (!Number.isFinite(qty) || qty === 0) {
    throw new Error('Quantité de mouvement invalide (zéro ou non numérique)');
  }
  if ((type === 'entry' || type === 'exit') && qty < 0) {
    throw new Error(`Une quantité « ${type} » doit être positive (reçu : ${qty})`);
  }

  const [product] = await exec
    .select({
      id: schema.products.id,
      name: schema.products.name,
      stock: schema.products.stock,
      syncId: schema.products.syncId,
    })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);

  if (!product) throw new Error('Produit introuvable');

  const stockBefore = Number(product.stock ?? 0);
  let stockAfter: number;

  switch (type) {
    case 'entry':
      stockAfter = stockBefore + qty;
      break;
    case 'exit':
      stockAfter = stockBefore - qty;
      break;
    case 'adjustment':
      // `quantity` est un ÉCART signé, jamais la valeur absolue.
      stockAfter = stockBefore + qty;
      break;
  }

  if (stockAfter < 0 && !options.allowNegative) {
    throw new InsufficientStockError(product.name, stockBefore, qty);
  }

  const motif =
    options.motif ??
    (type === 'entry' ? 'Entrée manuelle' : type === 'exit' ? 'Sortie manuelle' : 'Ajustement');

  const inserted = await exec
    .insert(schema.stockMovements)
    .values({
      productId,
      type,
      quantity: qty,
      motif,
      stockBefore,
      stockAfter,
      referenceType: options.referenceType ?? null,
      referenceId: options.referenceId ?? null,
      userId: options.userId ?? null,
    })
    .returning({ id: schema.stockMovements.id, syncId: schema.stockMovements.syncId });

  await exec
    .update(schema.products)
    .set({ stock: stockAfter, updatedAt: new Date() })
    .where(eq(schema.products.id, productId));

  await enqueueSyncWrite('stock_movements', inserted[0]?.syncId, 'insert', {
    product_id: productId,
    type,
    quantity: qty,
    stock_before: stockBefore,
    stock_after: stockAfter,
    motif,
  });
  await enqueueSyncWrite('products', product.syncId, 'update', {
    stock: stockAfter,
  });

  return { stockBefore, stockAfter, movementId: inserted[0]?.id ?? 0 };
}

/**
 * Recalcule le stock depuis le journal des mouvements (réparation / audit).
 * Utilisé par l'écran d'inventaire pour vérifier l'invariant.
 */
export async function updateProductStock(productId: number): Promise<number> {
  const movements = await db
    .select({
      type: schema.stockMovements.type,
      quantity: schema.stockMovements.quantity,
    })
    .from(schema.stockMovements)
    .where(eq(schema.stockMovements.productId, productId))
    .orderBy(asc(schema.stockMovements.id));

  const stock = movements.reduce((sum, m) => {
    if (m.type === 'entry') return sum + Number(m.quantity);
    if (m.type === 'exit') return sum - Number(m.quantity);
    return sum + Number(m.quantity); // adjustment = écart signé
  }, 0);

  const safe = Math.max(0, Math.round(stock * 1000) / 1000);
  await db
    .update(schema.products)
    .set({ stock: safe, updatedAt: new Date() })
    .where(eq(schema.products.id, productId));

  return safe;
}

/** Liste des produits avec leur état de stock, `stock_value` et `is_low`. */
export async function listStockProducts(options: {
  search?: string;
  lowStockOnly?: boolean;
  outOfStockOnly?: boolean;
  categoryId?: number;
  page?: number;
  limit?: number;
  /** `recent` (défaut) = dernier produit enregistré ; `name` = ordre alphabétique. */
  sort?: ListSort;
} = {}): Promise<{ data: StockProduct[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [eq(schema.products.isActive, true)];
  if (options.search) {
    conditions.push(
      sql`(${schema.products.name} LIKE ${`%${options.search}%`})`,
    );
  }
  if (options.categoryId) conditions.push(eq(schema.products.categoryId, options.categoryId));
  if (options.lowStockOnly) {
    conditions.push(sql`${schema.products.stock} <= ${schema.products.stockMin}`);
  }
  if (options.outOfStockOnly) {
    conditions.push(sql`${schema.products.stock} <= 0`);
  }

  const where = and(...conditions);

  /**
   * Par défaut : **le dernier produit enregistré en premier**
   * (`created_at DESC, id DESC`) — l'`id` départage deux produits créés dans
   * la même seconde, sinon l'ordre n'est pas déterministe d'une page à l'autre.
   */
  const sort = options.sort ?? DEFAULT_LIST_SORT;
  const orderBy =
    sort === 'name'
      ? [asc(schema.products.name), asc(schema.products.id)]
      : [desc(schema.products.createdAt), desc(schema.products.id)];

  const [rows, totalResult] = await Promise.all([
    db.query.products.findMany({
      where,
      orderBy,
      with: { category: { columns: { name: true, kind: true } } },
      limit,
      offset,
    }),
    db.select({ count: sql<number>`count(*)` }).from(schema.products).where(where),
  ]);

  const total = Number(totalResult[0]?.count ?? 0);

  const data: StockProduct[] = rows.map((p) => {
    const stock = Number(p.stock ?? 0);
    const stockMin = Number(p.stockMin ?? 0);
    return {
      id: p.id,
      name: p.name,
      unit: p.unit,
      categoryId: p.categoryId,
      categoryName: p.category?.name ?? null,
      categoryKind: p.category?.kind ?? null,
      stock,
      stockMin,
      purchasePrice: Number(p.purchasePrice ?? 0),
      salePrice: Number(p.salePrice ?? 0),
      stockValue: stock * Number(p.purchasePrice ?? 0),
      saleValue: stock * Number(p.salePrice ?? 0),
      isLow: stockMin > 0 && stock <= stockMin,
      isOut: stock <= 0,
    };
  });

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

/** Historique paginé des mouvements. */
export async function listStockMovements(options: {
  productId?: number;
  type?: StockMovementType;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
} = {}): Promise<{ data: StockMovementRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];
  if (options.productId) conditions.push(eq(schema.stockMovements.productId, options.productId));
  if (options.type) conditions.push(eq(schema.stockMovements.type, options.type));
  if (options.from) {
    conditions.push(sql`${schema.stockMovements.createdAt} >= ${new Date(`${options.from}T00:00:00`).getTime() / 1000}`);
  }
  if (options.to) {
    conditions.push(sql`${schema.stockMovements.createdAt} <= ${new Date(`${options.to}T23:59:59`).getTime() / 1000}`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalResult] = await Promise.all([
    db.query.stockMovements.findMany({
      where,
      orderBy: [desc(schema.stockMovements.createdAt), desc(schema.stockMovements.id)],
      with: {
        product: { columns: { name: true, unit: true } },
        user: { columns: { name: true } },
      },
      limit,
      offset,
    }),
    db.select({ count: sql<number>`count(*)` }).from(schema.stockMovements).where(where),
  ]);

  const total = Number(totalResult[0]?.count ?? 0);

  const data: StockMovementRow[] = rows.map((m) => ({
    id: m.id,
    productId: m.productId,
    productName: m.product?.name ?? '',
    unit: m.product?.unit ?? '',
    type: m.type as StockMovementType,
    quantity: Number(m.quantity),
    motif: m.motif,
    stockBefore: Number(m.stockBefore),
    stockAfter: Number(m.stockAfter),
    referenceType: m.referenceType,
    referenceId: m.referenceId,
    userId: m.userId,
    userName: m.user?.name ?? null,
    createdAt: m.createdAt,
  }));

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

export type StockSummary = {
  totalProducts: number;
  totalStock: number;
  totalStockValue: number;
  totalSaleValue: number;
  lowStockCount: number;
  outOfStockCount: number;
};

/** Synthèse du stock : totaux, valeur d'achat, valeur de vente, alertes. */
export async function getStockSummary(): Promise<StockSummary> {
  const rows = await db
    .select({
      stock: schema.products.stock,
      stockMin: schema.products.stockMin,
      purchasePrice: schema.products.purchasePrice,
      salePrice: schema.products.salePrice,
    })
    .from(schema.products)
    .where(eq(schema.products.isActive, true));

  let totalStock = 0;
  let totalStockValue = 0;
  let totalSaleValue = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;

  for (const p of rows) {
    const stock = Number(p.stock ?? 0);
    const stockMin = Number(p.stockMin ?? 0);
    totalStock += stock;
    totalStockValue += stock * Number(p.purchasePrice ?? 0);
    totalSaleValue += stock * Number(p.salePrice ?? 0);
    if (stock <= 0) outOfStockCount += 1;
    else if (stockMin > 0 && stock <= stockMin) lowStockCount += 1;
  }

  return {
    totalProducts: rows.length,
    totalStock: Math.round(totalStock * 1000) / 1000,
    totalStockValue,
    totalSaleValue,
    lowStockCount,
    outOfStockCount,
  };
}

/**
 * Inventaire / correction : enregistre un **écart signé** (`adjustment`).
 * `delta > 0` = on a trouvé plus que le stock théorique, `delta < 0` = moins.
 */
export async function adjustStock(
  productId: number,
  delta: number,
  motif: string,
  options: { userId?: number | null; executor?: Executor } = {},
): Promise<{ stockBefore: number; stockAfter: number; movementId: number }> {
  return addStockMovement(productId, 'adjustment', delta, {
    referenceType: 'inventory',
    motif: motif || 'Inventaire',
    userId: options.userId ?? null,
    allowNegative: false,
    executor: options.executor,
  });
}

/**
 * Vérifie l'invariant « stock = somme des mouvements » pour un produit.
 * Utilisé par l'écran d'inventaire et par les tests.
 */
export async function verifyStockInvariant(productId: number): Promise<{
  productId: number;
  stored: number;
  computed: number;
  ok: boolean;
}> {
  const [product] = await db
    .select({ stock: schema.products.stock })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);

  const rows = await db
    .select({ type: schema.stockMovements.type, quantity: schema.stockMovements.quantity })
    .from(schema.stockMovements)
    .where(eq(schema.stockMovements.productId, productId));

  const computed = rows.reduce((sum, m) => {
    if (m.type === 'exit') return sum - Number(m.quantity);
    return sum + Number(m.quantity);
  }, 0);

  const stored = Number(product?.stock ?? 0);
  const rounded = Math.round(computed * 1000) / 1000;

  return { productId, stored, computed: rounded, ok: Math.abs(stored - rounded) < 0.001 };
}

export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  entry: 'Entrée',
  exit: 'Sortie',
  adjustment: 'Ajustement',
};

export const STOCK_REFERENCE_LABELS: Record<string, string> = {
  sale: 'Vente',
  purchase: 'Achat',
  brick_production: 'Fabrication de briques',
  furniture_order: 'Commande de meuble',
  service_job: 'Chantier',
  inventory: 'Inventaire',
};
