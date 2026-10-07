/**
 * Moteur de stock unique, **par magasin** (§4, §12 ; multi-magasins §7).
 *
 * Invariant non négociable : `product_stocks.quantity` (magasin × produit) =
 * **somme algébrique** des mouvements de `stock_movements` de ce magasin.
 * Toute correction passe par `adjustStock()` et `adjustment` stocke un **écart
 * signé**, jamais une valeur absolue.
 *
 * Trois types suffisent : `entry` (achat, réception de transfert), `exit`
 * (vente, matériaux de chantier, expédition de transfert), `adjustment`
 * (inventaire, correction).
 *
 * Chaque mouvement s'exécute dans une transaction (`withTransaction`) : la
 * lecture du stock et son écriture sont atomiques, deux ventes simultanées ne
 * peuvent plus se « voler » une quantité.
 */

import { db, schema, rawAll, rawGet, rawRun, withTransaction } from '@/db';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_LIST_SORT, type ListSort } from '@/lib/list-sort';
import { scopeSql, type StoreScope } from '@/lib/stores';
import { getSettings } from '@/lib/settings';

export type StockMovementType = 'entry' | 'exit' | 'adjustment';

export type StockReferenceType = 'sale' | 'purchase' | 'service_job' | 'furniture_order' | 'brick_production' | 'inventory' | 'transfer';

export type AddStockMovementOptions = {
  /** Magasin concerné — obligatoire. */
  storeId: number;
  referenceType?: StockReferenceType | null;
  referenceId?: number | null;
  motif?: string;
  userId?: number | null;
  /** Autorise un stock négatif (dérogation explicite, tracée dans le motif). */
  allowNegative?: boolean;
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
  barcode: string | null;
  categoryId: number | null;
  categoryName: string | null;
  categoryKind: string | null;
  stock: number;
  stockMin: number;
  /** Quantités en transit vers le(s) magasin(s) consulté(s). */
  inTransit: number;
  purchasePrice: number;
  salePrice: number;
  stockValue: number;
  saleValue: number;
  isLow: boolean;
  isOut: boolean;
  /** Détail par magasin (vue consolidée uniquement). */
  byStore?: { storeId: number; storeName: string; stock: number }[];
};

export type StockMovementRow = {
  id: number;
  storeId: number | null;
  storeName: string | null;
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

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Stock d'un produit dans un magasin (0 si la ligne n'existe pas encore). */
export async function getStoreStock(storeId: number, productId: number): Promise<number> {
  const row = await rawGet<{ quantity: number }>(
    `SELECT quantity FROM product_stocks WHERE store_id = ? AND product_id = ?`,
    [storeId, productId],
  );
  return Number(row?.quantity ?? 0);
}

/** Crée la ligne magasin × produit si elle manque. */
/**
 * Crée la ligne magasin × produit si elle manque.
 *
 * Son `sync_id` est **déterministe** (`ps-<magasin>-<produit>`) : deux postes
 * qui créent chacun la ligne hors ligne produisent la même identité, donc
 * aucun doublon après synchronisation.
 */
export async function ensureProductStockRow(storeId: number, productId: number): Promise<void> {
  await rawRun(
    `INSERT INTO product_stocks (store_id, product_id, quantity, created_at, sync_id, updated_at)
     SELECT s.id, p.id, 0, unixepoch(), 'ps-' || s.sync_id || '-' || p.sync_id, unixepoch()
       FROM stores s, products p
      WHERE s.id = ? AND p.id = ?
     ON CONFLICT(store_id, product_id) DO NOTHING`,
    [storeId, productId],
  );
}

/**
 * Insère un mouvement **et** met à jour le stock du magasin dans la même
 * transaction, en conservant `stock_before` / `stock_after`.
 */
export async function addStockMovement(
  productId: number,
  type: StockMovementType,
  quantity: number,
  options: AddStockMovementOptions,
): Promise<{ stockBefore: number; stockAfter: number; movementId: number }> {
  const qty = Number(quantity);
  const storeId = Number(options.storeId);

  if (!Number.isInteger(storeId) || storeId <= 0) {
    throw new Error('Magasin obligatoire pour un mouvement de stock');
  }
  if (!Number.isFinite(qty) || qty === 0) {
    throw new Error('Quantité de mouvement invalide (zéro ou non numérique)');
  }
  if ((type === 'entry' || type === 'exit') && qty < 0) {
    throw new Error(`Une quantité « ${type} » doit être positive (reçu : ${qty})`);
  }

  return withTransaction(async () => {
    const product = await rawGet<{ id: number; name: string }>(
      `SELECT id, name FROM products WHERE id = ?`,
      [productId],
    );
    if (!product) throw new Error('Produit introuvable');

    await ensureProductStockRow(storeId, productId);
    // Un magasin qui reçoit, vend ou corrige un produit le **propose** : tout
    // mouvement le (re)met dans l'assortiment (transfert reçu, achat…).
    await rawRun(
      `UPDATE product_stocks SET is_listed = 1, updated_at = unixepoch()
        WHERE store_id = ? AND product_id = ? AND is_listed = 0`,
      [storeId, productId],
    );
    const stockBefore = await getStoreStock(storeId, productId);

    const stockAfter = round3(type === 'exit' ? stockBefore - qty : stockBefore + qty);

    if (stockAfter < 0 && !options.allowNegative) {
      throw new InsufficientStockError(product.name, stockBefore, qty);
    }

    const motif =
      options.motif ??
      (type === 'entry' ? 'Entrée manuelle' : type === 'exit' ? 'Sortie manuelle' : 'Ajustement');

    const inserted = await db
      .insert(schema.stockMovements)
      .values({
        storeId,
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
      .returning({ id: schema.stockMovements.id });

    await rawRun(
      `UPDATE product_stocks SET quantity = ?, updated_at = unixepoch() WHERE store_id = ? AND product_id = ?`,
      [stockAfter, storeId, productId],
    );

    return { stockBefore, stockAfter, movementId: inserted[0]?.id ?? 0 };
  });
}

/**
 * Recalcule le stock d'un magasin depuis le journal des mouvements.
 * Utilisé après réception de données synchronisées et par la vérification
 * d'invariant.
 */
export async function recomputeStoreStock(storeId: number, productId: number): Promise<number> {
  const row = await rawGet<{ total: number | null }>(
    `SELECT SUM(CASE type WHEN 'exit' THEN -quantity ELSE quantity END) AS total
       FROM stock_movements
      WHERE store_id = ? AND product_id = ? AND deleted_at IS NULL`,
    [storeId, productId],
  );
  const stock = round3(Number(row?.total ?? 0));
  await ensureProductStockRow(storeId, productId);
  await rawRun(
    `UPDATE product_stocks SET quantity = ? WHERE store_id = ? AND product_id = ? AND quantity <> ?`,
    [stock, storeId, productId, stock],
  );
  return stock;
}

/** Recalcule tous les stocks touchés par une liste de couples magasin × produit. */
export async function recomputeStocks(pairs: { storeId: number; productId: number }[]): Promise<void> {
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = `${pair.storeId}:${pair.productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await recomputeStoreStock(pair.storeId, pair.productId);
  }
}

/**
 * **Assortiment** (README §28.5) : le produit `p` est-il proposé par au moins
 * un magasin de la portée ? Toute liste de produits « du magasin » (produits,
 * stocks, alertes, inventaires, sélecteurs) passe par ce filtre.
 */
export function listedSql(scope: StoreScope, alias = 'p'): string {
  return `EXISTS (SELECT 1 FROM product_stocks pl WHERE pl.product_id = ${alias}.id AND pl.is_listed = 1 AND ${scopeSql('pl.store_id', scope)})`;
}

/** Expression SQL du stock d'un produit `p` sur une portée. */
function stockExpr(scope: StoreScope): string {
  return `COALESCE((SELECT SUM(ps.quantity) FROM product_stocks ps WHERE ps.product_id = p.id AND ${scopeSql('ps.store_id', scope)}), 0)`;
}

/**
 * Seuil d'alerte sur une portée : pour un magasin, son seuil local ou celui du
 * produit ; en consolidé, la somme des seuils des magasins.
 */
function stockMinExpr(scope: StoreScope): string {
  if (scope.length === 1) {
    return `COALESCE((SELECT ps.stock_min FROM product_stocks ps WHERE ps.product_id = p.id AND ps.store_id = ${Number(scope[0])}), p.stock_min)`;
  }
  return `(p.stock_min * ${Math.max(1, scope.length)})`;
}

/** Prix effectif : local au magasin s'il existe **et** si les prix locaux sont autorisés. */
function salePriceExpr(scope: StoreScope, allowLocalPrice: boolean): string {
  if (scope.length === 1 && allowLocalPrice) {
    return `COALESCE((SELECT ps.sale_price FROM product_stocks ps WHERE ps.product_id = p.id AND ps.store_id = ${Number(scope[0])}), p.sale_price)`;
  }
  return 'p.sale_price';
}

function inTransitExpr(scope: StoreScope): string {
  return `COALESCE((SELECT SUM(ti.quantity_shipped - ti.quantity_received)
      FROM stock_transfer_items ti JOIN stock_transfers t ON t.id = ti.transfer_id
     WHERE ti.product_id = p.id AND t.status IN ('in_transit', 'partially_received')
       AND ${scopeSql('t.destination_store_id', scope)}), 0)`;
}

/** Liste des produits avec leur état de stock sur la portée demandée. */
export async function listStockProducts(options: {
  scope: StoreScope;
  search?: string;
  lowStockOnly?: boolean;
  outOfStockOnly?: boolean;
  categoryId?: number;
  page?: number;
  limit?: number;
  sort?: ListSort;
  withStoreDetail?: boolean;
}): Promise<{ data: StockProduct[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;
  const scope = options.scope;

  const stock = stockExpr(scope);
  const stockMin = stockMinExpr(scope);

  const conditions: string[] = ['p.is_active = 1', 'p.deleted_at IS NULL', listedSql(scope)];
  const args: unknown[] = [];
  if (options.search) {
    conditions.push('(p.name LIKE ? OR p.barcode = ?)');
    args.push(`%${options.search}%`, options.search.trim());
  }
  if (options.categoryId) {
    conditions.push('p.category_id = ?');
    args.push(options.categoryId);
  }
  if (options.lowStockOnly) conditions.push(`${stock} <= ${stockMin} AND ${stockMin} > 0`);
  if (options.outOfStockOnly) conditions.push(`${stock} <= 0`);

  const where = conditions.join(' AND ');
  const sort = options.sort ?? DEFAULT_LIST_SORT;
  const orderBy = sort === 'name' ? 'p.name ASC, p.id ASC' : 'p.created_at DESC, p.id DESC';

  const [rows, totalRow] = await Promise.all([
    rawAll<any>(
      `SELECT p.id, p.name, p.unit, p.barcode, p.category_id, p.purchase_price,
              ${salePriceExpr(scope, (await getSettings()).localPricesAllowed)} AS sale_price,
              c.name AS category_name, c.kind AS category_kind,
              ${stock} AS stock, ${stockMin} AS stock_min, ${inTransitExpr(scope)} AS in_transit
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...args, limit, offset] as any,
    ),
    rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM products p WHERE ${where}`, args as any),
  ]);

  let detail = new Map<number, { storeId: number; storeName: string; stock: number }[]>();
  if (options.withStoreDetail && scope.length > 1 && rows.length > 0) {
    const ids = rows.map((r) => Number(r.id)).join(',');
    const detailRows = await rawAll<any>(
      `SELECT ps.product_id, ps.store_id, s.name, ps.quantity
         FROM product_stocks ps JOIN stores s ON s.id = ps.store_id
        WHERE ps.product_id IN (${ids}) AND ps.is_listed = 1 AND ${scopeSql('ps.store_id', scope)}
        ORDER BY s.name`,
    );
    detail = new Map();
    for (const d of detailRows) {
      const list = detail.get(Number(d.product_id)) ?? [];
      list.push({ storeId: Number(d.store_id), storeName: String(d.name), stock: Number(d.quantity) });
      detail.set(Number(d.product_id), list);
    }
  }

  const data: StockProduct[] = rows.map((p) => {
    const qty = round3(Number(p.stock ?? 0));
    const min = Number(p.stock_min ?? 0);
    const purchasePrice = Number(p.purchase_price ?? 0);
    const salePrice = Number(p.sale_price ?? 0);
    return {
      id: Number(p.id),
      name: p.name,
      unit: p.unit,
      barcode: p.barcode ?? null,
      categoryId: p.category_id === null ? null : Number(p.category_id),
      categoryName: p.category_name ?? null,
      categoryKind: p.category_kind ?? null,
      stock: qty,
      stockMin: min,
      inTransit: round3(Number(p.in_transit ?? 0)),
      purchasePrice,
      salePrice,
      stockValue: qty * purchasePrice,
      saleValue: qty * salePrice,
      isLow: min > 0 && qty <= min,
      isOut: qty <= 0,
      ...(options.withStoreDetail && scope.length > 1 ? { byStore: detail.get(Number(p.id)) ?? [] } : {}),
    };
  });

  const total = Number(totalRow?.n ?? 0);
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

/** Historique paginé des mouvements, sur la portée demandée. */
export async function listStockMovements(options: {
  scope: StoreScope;
  productId?: number;
  type?: StockMovementType;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}): Promise<{ data: StockMovementRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const conditions: string[] = [scopeSql('m.store_id', options.scope)];
  const args: unknown[] = [];
  if (options.productId) {
    conditions.push('m.product_id = ?');
    args.push(options.productId);
  }
  if (options.type) {
    conditions.push('m.type = ?');
    args.push(options.type);
  }
  if (options.from) {
    conditions.push('m.created_at >= ?');
    args.push(Math.floor(new Date(`${options.from}T00:00:00`).getTime() / 1000));
  }
  if (options.to) {
    conditions.push('m.created_at <= ?');
    args.push(Math.floor(new Date(`${options.to}T23:59:59`).getTime() / 1000));
  }
  const where = conditions.join(' AND ');

  const [rows, totalRow] = await Promise.all([
    rawAll<any>(
      `SELECT m.*, p.name AS product_name, p.unit AS product_unit, u.name AS user_name, s.name AS store_name
         FROM stock_movements m
         LEFT JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN stores s ON s.id = m.store_id
        WHERE ${where}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ? OFFSET ?`,
      [...args, limit, offset] as any,
    ),
    rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_movements m WHERE ${where}`, args as any),
  ]);

  const data: StockMovementRow[] = rows.map((m) => ({
    id: Number(m.id),
    storeId: m.store_id === null ? null : Number(m.store_id),
    storeName: m.store_name ?? null,
    productId: Number(m.product_id),
    productName: m.product_name ?? '',
    unit: m.product_unit ?? '',
    type: m.type as StockMovementType,
    quantity: Number(m.quantity),
    motif: m.motif,
    stockBefore: Number(m.stock_before),
    stockAfter: Number(m.stock_after),
    referenceType: m.reference_type ?? null,
    referenceId: m.reference_id === null ? null : Number(m.reference_id),
    userId: m.user_id === null ? null : Number(m.user_id),
    userName: m.user_name ?? null,
    createdAt: m.created_at ? new Date(Number(m.created_at) * 1000) : null,
  }));

  const total = Number(totalRow?.n ?? 0);
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

export type StockSummary = {
  totalProducts: number;
  totalStock: number;
  totalStockValue: number;
  totalSaleValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  inTransitCount: number;
};

/** Synthèse du stock sur une portée : totaux, valeurs, alertes. */
export async function getStockSummary(scope: StoreScope): Promise<StockSummary> {
  const rows = await rawAll<any>(
    `SELECT ${stockExpr(scope)} AS stock, ${stockMinExpr(scope)} AS stock_min,
            p.purchase_price, ${salePriceExpr(scope, (await getSettings()).localPricesAllowed)} AS sale_price, ${inTransitExpr(scope)} AS in_transit
       FROM products p WHERE p.is_active = 1 AND p.deleted_at IS NULL AND ${listedSql(scope)}`,
  );

  let totalStock = 0;
  let totalStockValue = 0;
  let totalSaleValue = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  let inTransitCount = 0;

  for (const p of rows) {
    const stock = Number(p.stock ?? 0);
    const stockMin = Number(p.stock_min ?? 0);
    totalStock += stock;
    totalStockValue += stock * Number(p.purchase_price ?? 0);
    totalSaleValue += stock * Number(p.sale_price ?? 0);
    if (stock <= 0) outOfStockCount += 1;
    else if (stockMin > 0 && stock <= stockMin) lowStockCount += 1;
    if (Number(p.in_transit ?? 0) > 0) inTransitCount += 1;
  }

  return {
    totalProducts: rows.length,
    totalStock: round3(totalStock),
    totalStockValue,
    totalSaleValue,
    lowStockCount,
    outOfStockCount,
    inTransitCount,
  };
}

/**
 * Correction : enregistre un **écart signé** (`adjustment`).
 * `delta > 0` = on a trouvé plus que le stock théorique, `delta < 0` = moins.
 */
export async function adjustStock(
  storeId: number,
  productId: number,
  delta: number,
  motif: string,
  options: { userId?: number | null; referenceType?: StockReferenceType; referenceId?: number | null } = {},
): Promise<{ stockBefore: number; stockAfter: number; movementId: number }> {
  return addStockMovement(productId, 'adjustment', delta, {
    storeId,
    referenceType: options.referenceType ?? 'inventory',
    referenceId: options.referenceId ?? null,
    motif: motif || 'Inventaire',
    userId: options.userId ?? null,
    allowNegative: false,
  });
}

/** Règle le seuil d'alerte et/ou le prix local d'un produit dans un magasin. */
export async function setLocalProductSettings(
  storeId: number,
  productId: number,
  values: { stockMin?: number | null; salePrice?: number | null },
): Promise<void> {
  await ensureProductStockRow(storeId, productId);
  const updates: Record<string, unknown> = {};
  if (values.stockMin !== undefined) updates.stockMin = values.stockMin;
  if (values.salePrice !== undefined) updates.salePrice = values.salePrice;
  if (Object.keys(updates).length === 0) return;
  await db
    .update(schema.productStocks)
    .set(updates)
    .where(and(eq(schema.productStocks.storeId, storeId), eq(schema.productStocks.productId, productId)));
}

export class AssortmentError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'AssortmentError';
  }
}

/**
 * Ajoute un produit du catalogue à l'assortiment d'un magasin, ou l'en retire.
 *
 * Retirer est refusé tant que le magasin en a en stock ou en attend par
 * transfert : la marchandise disparaîtrait des listes sans avoir quitté le
 * magasin. On vide d'abord (transfert, ajustement). Rien n'est supprimé : la
 * ligne garde son historique et revient au premier mouvement.
 */
export async function setProductListed(storeId: number, productId: number, listed: boolean): Promise<void> {
  const product = await rawGet<{ name: string; is_active: number }>('SELECT name, is_active FROM products WHERE id = ?', [productId]);
  if (!product) throw new AssortmentError('Produit introuvable');

  if (listed) {
    if (!product.is_active) throw new AssortmentError(`« ${product.name} » est désactivé dans le catalogue.`);
    await ensureProductStockRow(storeId, productId);
    await rawRun(
      `UPDATE product_stocks SET is_listed = 1, updated_at = unixepoch()
        WHERE store_id = ? AND product_id = ? AND is_listed = 0`,
      [storeId, productId],
    );
    return;
  }

  const stock = await getStoreStock(storeId, productId);
  if (Math.abs(stock) > 0.0005) {
    throw new AssortmentError(
      `« ${product.name} » est encore en stock dans ce magasin (${round3(stock)}) : transférez-le ou ajustez le stock à zéro avant de le retirer.`,
    );
  }
  const incoming = await rawGet<{ reference: string }>(
    `SELECT t.reference FROM stock_transfer_items ti JOIN stock_transfers t ON t.id = ti.transfer_id
      WHERE ti.product_id = ? AND t.destination_store_id = ?
        AND t.status IN ('draft', 'pending', 'approved', 'preparing', 'in_transit', 'partially_received', 'disputed') LIMIT 1`,
    [productId, storeId],
  );
  if (incoming) {
    throw new AssortmentError(`« ${product.name} » est attendu par le transfert ${incoming.reference} : terminez-le d'abord.`);
  }
  await rawRun(
    `UPDATE product_stocks SET is_listed = 0, updated_at = unixepoch()
      WHERE store_id = ? AND product_id = ? AND is_listed = 1`,
    [storeId, productId],
  );
}

/** Prix de vente effectif d'un produit dans un magasin (prix local sinon catalogue). */
export async function getEffectiveSalePrice(storeId: number, productId: number): Promise<number> {
  const allowLocal = (await getSettings()).localPricesAllowed;
  const row = await rawGet<{ price: number }>(
    `SELECT ${allowLocal ? 'COALESCE(ps.sale_price, p.sale_price)' : 'p.sale_price'} AS price
       FROM products p LEFT JOIN product_stocks ps ON ps.product_id = p.id AND ps.store_id = ?
      WHERE p.id = ?`,
    [storeId, productId],
  );
  return Number(row?.price ?? 0);
}

/**
 * Vérifie l'invariant « stock = somme des mouvements » pour un magasin.
 */
export async function verifyStockInvariant(
  storeId: number,
  productId: number,
): Promise<{ productId: number; storeId: number; stored: number; computed: number; ok: boolean }> {
  const stored = await getStoreStock(storeId, productId);
  const row = await rawGet<{ total: number | null }>(
    `SELECT SUM(CASE type WHEN 'exit' THEN -quantity ELSE quantity END) AS total
       FROM stock_movements WHERE store_id = ? AND product_id = ? AND deleted_at IS NULL`,
    [storeId, productId],
  );
  const computed = round3(Number(row?.total ?? 0));
  return { productId, storeId, stored, computed, ok: Math.abs(stored - computed) < 0.001 };
}

export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  entry: 'Entrée',
  exit: 'Sortie',
  adjustment: 'Ajustement',
};

export const STOCK_REFERENCE_LABELS: Record<string, string> = {
  sale: 'Vente',
  purchase: 'Achat',
  service_job: 'Chantier',
  inventory: 'Inventaire',
  transfer: 'Transfert',
  brick_production: 'Fabrication de briques',
  furniture_order: 'Atelier de meubles',
  // Lignes de la v1 (migration 0014) : leurs documents n'existent plus.
  brick_production_v1: 'Fabrication de briques (archive v1)',
  furniture_order_v1: 'Atelier de meubles (archive v1)',
};
