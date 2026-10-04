/**
 * Produits et catégories (§4, §7.4).
 *
 * Deux règles structurent ce module :
 *
 * 1. **Le type est porté par la catégorie**, jamais par le produit
 *    (`categories.kind` = `finished` | `raw_material` | `service`). C'est le
 *    choix assumé du schéma cible : un seul endroit à paramétrer, et une
 *    catégorie homogène.
 * 2. **Le stock ne s'écrit jamais directement.** `products.stock` est la somme
 *    algébrique des `stock_movements` (§6.1 règle 4) : une correction passe par
 *    `adjustStock()` avec un **écart signé**, et un stock initial par un
 *    mouvement `entry`. Écrire `stock` dans un `UPDATE` de produit casserait
 *    l'invariant — ce module ne le fait donc jamais.
 *
 * Aucune suppression physique (§26.13) : désactiver, jamais `DELETE`.
 *
 * **Assortiment par magasin** (README §28.5) : le catalogue reste commun (un
 * nom = un produit, ce qui permet transferts et rapports réseau), mais chaque
 * magasin ne voit que **ses** produits (`product_stocks.is_listed`). Un
 * magasin crée ses produits ou reprend un produit du catalogue ; il modifie la
 * fiche d'un produit qu'il a créé tant qu'aucun autre magasin ne le propose.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { categories, products } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api';
import { addStockMovement, adjustStock, ensureProductStockRow, listedSql, setLocalProductSettings } from '@/lib/stock';
import { scopeSql, type StoreScope } from '@/lib/stores';
import { getSettings } from '@/lib/settings';
import { DEFAULT_SETTINGS } from '@/lib/settings-schema';
import { DEFAULT_LIST_SORT, sqlOrderBy, type ListSort } from '@/lib/list-sort';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** Types de catégorie : seul endroit où le type d'un article est décidé. */
export const CATEGORY_KINDS = ['finished', 'raw_material', 'service'] as const;

export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export function isCategoryKind(value: unknown): value is CategoryKind {
  return typeof value === 'string' && (CATEGORY_KINDS as readonly string[]).includes(value);
}

export type ProductRow = {
  id: number;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryKind: CategoryKind | null;
  unit: string;
  /** Prix d'achat — base du calcul de marge. */
  purchasePrice: number;
  salePrice: number;
  /** Stock sur la portée consultée (magasin actif, ou somme en consolidé). */
  stock: number;
  /** Seuil d'alerte effectif (local au magasin s'il est défini). */
  stockMin: number;
  /** Seuil d'alerte par défaut du catalogue. */
  catalogStockMin: number;
  /** Prix de vente du catalogue (le `salePrice` peut être un prix local). */
  catalogSalePrice: number;
  /** Prix local défini pour le magasin consulté (et prix locaux autorisés), sinon `null`. */
  localSalePrice: number | null;
  /** Seuil d'alerte local du magasin consulté, sinon `null` (seuil du catalogue). */
  localStockMin: number | null;
  barcode: string | null;
  description: string | null;
  isActive: boolean;
  /** Proposé par le magasin consulté (assortiment) ; en consolidé, par l'un des magasins. */
  listed: boolean;
  /** Magasin qui a créé le produit (`null` = catalogue commun du siège). */
  ownerStoreId: number | null;
  ownerStoreName: string | null;
  /** Nombre de magasins qui proposent ce produit (tout le réseau). */
  listedStoreCount: number;
  /** Agrégats **calculés**, jamais stockés. */
  stockValue: number;
  saleValue: number;
  margin: number;
  marginRate: number;
  /** `stock <= stock_min` **et** `stock_min > 0` (§4, alerte de stock faible). */
  isLow: boolean;
  isOut: boolean;
  createdAt: Date | null;
};

export type ProductInput = {
  name: string;
  categoryId?: number | null;
  unit?: string | null;
  purchasePrice?: number;
  salePrice?: number;
  /** Stock initial (magasin actif) : enregistré comme mouvement `entry`. */
  stock?: number;
  stockMin?: number;
  barcode?: string | null;
  /** Prix de vente local au magasin actif (`null` = prix du catalogue). */
  localSalePrice?: number | null;
  /** Seuil d'alerte local au magasin actif (`null` = seuil du catalogue). */
  localStockMin?: number | null;
  description?: string | null;
  isActive?: boolean;
};

export type ProductListOptions = {
  /** Magasins dont on lit le stock (vide = aucun stock affiché). */
  scope?: StoreScope;
  /**
   * `true` : tout le catalogue commun, y compris les produits que la portée ne
   * propose pas (pour « Ajouter un produit du catalogue »). Par défaut, seuls
   * les produits de l'assortiment de la portée sont listés.
   */
  catalog?: boolean;
  search?: string;
  categoryId?: number;
  /** Filtre sur `categories.kind`. */
  kind?: CategoryKind;
  lowStockOnly?: boolean;
  outOfStockOnly?: boolean;
  includeInactive?: boolean;
  page?: number;
  limit?: number;
  /** `recent` (défaut) = dernière insertion ; `name` = ordre alphabétique. */
  sort?: ListSort;
};

export type ProductsSummary = {
  totalProducts: number;
  activeProducts: number;
  /** Catégories **utilisées** par la portée (au moins un produit de son assortiment). */
  categoriesCount: number;
  /** Catégories actives de toute l'entreprise (liste commune). */
  catalogCategoriesCount: number;
  lowStockCount: number;
  outOfStockCount: number;
  stockPurchaseValue: number;
  stockSaleValue: number;
};

export type CategoryRow = {
  id: number;
  name: string;
  kind: CategoryKind;
  description: string | null;
  isActive: boolean;
  productCount: number;
  activeProductCount: number;
  /**
   * Produits actifs de cette catégorie dans l'assortiment de la portée
   * demandée (`null` sans portée). Sert à ne proposer, dans les filtres d'un
   * magasin, que **ses** catégories (README §28.5).
   */
  storeProductCount: number | null;
  createdAt: Date | null;
};

export type CategoryInput = {
  name: string;
  kind?: CategoryKind;
  description?: string | null;
  isActive?: boolean;
};

/* ------------------------------------------------------------------ *
 * Lecture — produits
 * ------------------------------------------------------------------ */

const PRODUCT_FROM = `
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN stores os ON os.id = p.owner_store_id
`;

/**
 * Colonnes, avec stock / seuil / prix calculés pour la portée demandée.
 *
 * `allowLocalPrice` = paramètre `localPricesAllowed`. Désactivé, le prix du
 * catalogue s'applique partout : les prix locaux déjà saisis sont **ignorés**
 * (mais conservés, pour une réactivation). Avant v2, ils continuaient de
 * s'appliquer : le réglage ne bloquait que la saisie de nouveaux prix.
 */
function productColumns(scope: StoreScope, allowLocalPrice: boolean): string {
  const single = scope.length === 1 ? Number(scope[0]) : null;
  const stock = `COALESCE((SELECT SUM(ps.quantity) FROM product_stocks ps WHERE ps.product_id = p.id AND ${scopeSql('ps.store_id', scope)}), 0)`;
  const localMin = single
    ? `(SELECT ps.stock_min FROM product_stocks ps WHERE ps.product_id = p.id AND ps.store_id = ${single})`
    : 'NULL';
  const localPrice =
    single && allowLocalPrice
      ? `(SELECT ps.sale_price FROM product_stocks ps WHERE ps.product_id = p.id AND ps.store_id = ${single})`
      : 'NULL';
  const effectiveMin = single ? `COALESCE(${localMin}, p.stock_min)` : `(p.stock_min * ${Math.max(1, scope.length)})`;
  return `
  p.id, p.name, p.category_id, p.unit, p.purchase_price, p.sale_price, p.barcode,
  ${stock} AS stock, ${effectiveMin} AS stock_min, p.stock_min AS catalog_stock_min,
  ${localPrice} AS local_sale_price, ${localMin} AS local_stock_min,
  p.description, p.is_active, p.created_at,
  CASE WHEN ${listedSql(scope)} THEN 1 ELSE 0 END AS listed,
  p.owner_store_id, os.name AS owner_store_name,
  (SELECT COUNT(*) FROM product_stocks pc WHERE pc.product_id = p.id AND pc.is_listed = 1) AS listed_store_count,
  c.name AS category_name, c.kind AS category_kind`;
}

function mapProductRow(row: any): ProductRow {
  const stock = Math.round(Number(row.stock ?? 0) * 1000) / 1000;
  const stockMin = Number(row.stock_min ?? 0);
  const purchasePrice = Number(row.purchase_price ?? 0);
  const localSalePrice = row.local_sale_price == null ? null : Number(row.local_sale_price);
  const catalogSalePrice = Number(row.sale_price ?? 0);
  const salePrice = localSalePrice ?? catalogSalePrice;
  const margin = salePrice - purchasePrice;

  return {
    id: Number(row.id),
    name: row.name,
    categoryId: row.category_id == null ? null : Number(row.category_id),
    categoryName: row.category_name ?? null,
    categoryKind: isCategoryKind(row.category_kind) ? row.category_kind : null,
    unit: row.unit,
    purchasePrice,
    salePrice,
    stock,
    stockMin,
    catalogStockMin: Number(row.catalog_stock_min ?? row.stock_min ?? 0),
    catalogSalePrice,
    localSalePrice,
    localStockMin: row.local_stock_min == null ? null : Number(row.local_stock_min),
    barcode: row.barcode ?? null,
    description: row.description ?? null,
    isActive: Boolean(row.is_active),
    listed: Boolean(row.listed),
    ownerStoreId: row.owner_store_id == null ? null : Number(row.owner_store_id),
    ownerStoreName: row.owner_store_name ?? null,
    listedStoreCount: Number(row.listed_store_count ?? 0),
    stockValue: stock * purchasePrice,
    saleValue: stock * salePrice,
    margin,
    marginRate: purchasePrice > 0 ? (margin / purchasePrice) * 100 : 0,
    isLow: stockMin > 0 && stock <= stockMin,
    isOut: stock <= 0,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

function buildProductWhere(options: ProductListOptions): { whereSql: string; args: (string | number)[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];

  // Un produit désactivé doit rester consultable (« Inclure les désactivés »),
  // mais il est hors du catalogue courant par défaut.
  if (!options.includeInactive) where.push('p.is_active = 1');
  // Assortiment : seuls les produits proposés par la portée, sauf vue « catalogue ».
  if (!options.catalog) where.push(listedSql(options.scope ?? []));
  if (options.categoryId) {
    where.push('p.category_id = ?');
    args.push(options.categoryId);
  }
  if (options.kind) {
    where.push('c.kind = ?');
    args.push(options.kind);
  }
  if (options.search) {
    where.push('(p.name LIKE ? OR p.description LIKE ? OR p.barcode = ?)');
    const like = `%${options.search}%`;
    args.push(like, like, options.search.trim());
  }
  const scope = options.scope ?? [];
  const stockSql = `COALESCE((SELECT SUM(ps.quantity) FROM product_stocks ps WHERE ps.product_id = p.id AND ${scopeSql('ps.store_id', scope)}), 0)`;
  if (options.lowStockOnly) {
    where.push(`p.stock_min > 0 AND ${stockSql} <= p.stock_min`);
  }
  if (options.outOfStockOnly) {
    where.push(`${stockSql} <= 0`);
  }

  return { whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', args };
}

/** Liste paginée du catalogue, enrichie de la catégorie et des agrégats de stock. */
export async function listProducts(options: ProductListOptions = {}): Promise<{
  data: ProductRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const { whereSql, args } = buildProductWhere(options);

  const rows = await rawAll<any>(
    `SELECT ${productColumns(options.scope ?? [], (await getSettings()).localPricesAllowed)}
     ${PRODUCT_FROM}
     ${whereSql}
     ORDER BY ${sqlOrderBy(options.sort ?? DEFAULT_LIST_SORT, 'p', ['recent', 'name'])}
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total ${PRODUCT_FROM} ${whereSql}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapProductRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/** Une ligne enrichie, ou `null` (le Route Handler traduit en 404). */
export async function getProduct(id: number, scope: StoreScope = []): Promise<ProductRow | null> {
  const row = await rawGet<any>(
    `SELECT ${productColumns(scope, (await getSettings()).localPricesAllowed)} ${PRODUCT_FROM} WHERE p.id = ?`,
    [id],
  );

  return row ? mapProductRow(row) : null;
}

/** Recherche rapide pour les modales de sélection (vente, achat, chantier). */
export async function searchProducts(term: string, limit = 20, scope: StoreScope = []): Promise<ProductRow[]> {
  const { data } = await listProducts({ search: term, scope, limit: Math.max(1, Math.min(100, limit)) });
  return data;
}

/**
 * Compteurs du catalogue.
 *
 * `lowStockCount` et `outOfStockCount` sont **mutuellement exclusifs** : une
 * rupture n'est pas comptée deux fois (même convention que `lib/stock.ts`).
 */
export async function getProductsSummary(scope: StoreScope = []): Promise<ProductsSummary> {
  const stock = `COALESCE((SELECT SUM(ps.quantity) FROM product_stocks ps WHERE ps.product_id = p.id AND ${scopeSql('ps.store_id', scope)}), 0)`;
  // Compteurs sur l'**assortiment** de la portée, pas sur tout le catalogue.
  const listed = listedSql(scope);
  const row = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM products p WHERE ${listed}) AS total_products,
       (SELECT COUNT(*) FROM products p WHERE p.is_active = 1 AND ${listed}) AS active_products,
       (SELECT COUNT(*) FROM categories c WHERE c.is_active = 1
          AND EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.is_active = 1 AND ${listed})) AS categories_count,
       (SELECT COUNT(*) FROM categories WHERE is_active = 1) AS catalog_categories_count,
       (SELECT COUNT(*) FROM products p
         WHERE p.is_active = 1 AND ${listed} AND ${stock} > 0 AND p.stock_min > 0 AND ${stock} <= p.stock_min) AS low_stock_count,
       (SELECT COUNT(*) FROM products p WHERE p.is_active = 1 AND ${listed} AND ${stock} <= 0) AS out_of_stock_count,
       (SELECT COALESCE(SUM(${stock} * p.purchase_price), 0) FROM products p WHERE p.is_active = 1) AS stock_purchase_value,
       (SELECT COALESCE(SUM(${stock} * p.sale_price), 0) FROM products p WHERE p.is_active = 1) AS stock_sale_value`,
  );

  return {
    totalProducts: Number(row?.total_products ?? 0),
    activeProducts: Number(row?.active_products ?? 0),
    categoriesCount: Number(row?.categories_count ?? 0),
    catalogCategoriesCount: Number(row?.catalog_categories_count ?? 0),
    lowStockCount: Number(row?.low_stock_count ?? 0),
    outOfStockCount: Number(row?.out_of_stock_count ?? 0),
    stockPurchaseValue: Number(row?.stock_purchase_value ?? 0),
    stockSaleValue: Number(row?.stock_sale_value ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Écriture — produits
 * ------------------------------------------------------------------ */

/** Champs de `products` écrits en base, et leur nom de colonne pour le payload. */
const PRODUCT_SYNC_FIELDS: Record<string, string> = {
  name: 'name',
  unit: 'unit',
  purchasePrice: 'purchase_price',
  salePrice: 'sale_price',
  stockMin: 'stock_min',
  description: 'description',
  isActive: 'is_active',
};

/**
 * Payload de synchronisation : **jamais** d'`id` local (§11.3), la catégorie
 * est référencée par son `sync_id`.
 */
function toSyncPayload(
  patch: Record<string, unknown>,
  categorySyncId?: string | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, column] of Object.entries(PRODUCT_SYNC_FIELDS)) {
    if (patch[key] !== undefined) payload[column] = patch[key];
  }
  if (patch.categoryId !== undefined) {
    payload.category_sync_id = patch.categoryId === null ? null : (categorySyncId ?? null);
  }
  if (patch.deletedAt !== undefined) {
    payload.deleted_at = patch.deletedAt ? new Date(patch.deletedAt as any).toISOString() : null;
  }
  payload.updated_at = new Date().toISOString();

  return payload;
}

/** La catégorie doit exister : on refuse une référence orpheline. */
async function resolveCategory(
  categoryId: number | null | undefined,
): Promise<{ id: number; syncId: string } | null> {
  if (categoryId === null || categoryId === undefined || categoryId === 0) return null;

  const row = await rawGet<{ id: number; sync_id: string; name: string }>(
    'SELECT id, sync_id, name FROM categories WHERE id = ?',
    [categoryId],
  );

  if (!row) throw new ValidationError('Catégorie introuvable');
  if (row.sync_id == null) throw new ValidationError(`Catégorie « ${row.name} » sans identifiant de synchronisation`);

  return { id: Number(row.id), syncId: row.sync_id };
}

/**
 * L'unité est une **liste fermée** portée par `settings.units` (§9.2) : une
 * saisie libre rendrait les rapports par unité faux.
 * @returns l'orthographe canonique du paramètre (`m2` → `m²`).
 */
async function resolveUnit(unit: string | null | undefined): Promise<string> {
  const settings = await getSettings();
  const units =
    Array.isArray(settings.units) && settings.units.length > 0
      ? settings.units
      : DEFAULT_SETTINGS.units;

  const value = (unit ?? '').trim();
  if (!value) return units[0] ?? 'pièce';

  const match = units.find((u) => u.toLowerCase() === value.toLowerCase());
  if (!match) {
    throw new ValidationError(
      `Unité « ${value} » inconnue. Unités autorisées : ${units.join(', ')}.`,
    );
  }
  return match;
}

/**
 * Le **nom est l'identifiant du produit** (demande client) : deux produits ne
 * peuvent donc pas porter le même. La comparaison ignore la casse et les espaces
 * de bord — `LOWER(TRIM(name))` — sinon « Ciment 50 kg » et « ciment 50 kg »
 * seraient deux produits différents à l'écran.
 *
 * La même règle existe en base (index unique `products_name_unique`), pour
 * qu'aucun import, script ou synchronisation ne puisse la contourner.
 */
async function assertProductNameAvailable(name: string, exceptId?: number): Promise<void> {
  const row = await rawGet<{ id: number }>(
    'SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))',
    [name],
  );
  if (row && Number(row.id) !== exceptId) {
    // Le nom est unique dans tout le réseau : un magasin qui ne voit pas ce
    // produit doit savoir qu'il peut le reprendre au lieu de le recréer.
    throw new ConflictError(
      exceptId === undefined
        ? `« ${name} » existe déjà dans le catalogue commun : ajoutez-le à votre magasin avec « Ajouter du catalogue » au lieu de le recréer.`
        : `Un produit porte déjà le nom « ${name} ».`,
    );
  }
}

/** Refus de modifier ou désactiver la fiche commune d'un produit (403). */
export class CatalogEditError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'CatalogEditError';
  }
}

/**
 * Qui peut modifier la **fiche** d'un produit (nom, catégorie, prix catalogue…) :
 *  - le siège ou une installation autonome (`central`) : toujours ;
 *  - sinon, le magasin qui l'a créé, tant qu'aucun autre magasin ne le propose
 *    (sa modification changerait le produit des autres).
 * Prix local, seuil local et stock restent modifiables par chaque magasin.
 */
export async function canEditProductCatalog(
  productId: number,
  context: { central: boolean; storeId: number | null },
): Promise<boolean> {
  if (context.central) return true;
  if (!context.storeId) return false;
  const row = await rawGet<{ owner_store_id: number | null; others: number }>(
    `SELECT p.owner_store_id,
            (SELECT COUNT(*) FROM product_stocks ps
              WHERE ps.product_id = p.id AND ps.is_listed = 1 AND ps.store_id <> ?) AS others
       FROM products p WHERE p.id = ?`,
    [context.storeId, productId],
  );
  return Boolean(row) && Number(row!.owner_store_id) === Number(context.storeId) && Number(row!.others) === 0;
}

export async function createProduct(
  input: ProductInput,
  options: { userId?: number | null; storeId?: number | null; ownerStoreId?: number | null } = {},
): Promise<ProductRow> {
  return withTransaction(() => createProductInTx(input, options));
}

async function createProductInTx(
  input: ProductInput,
  options: { userId?: number | null; storeId?: number | null; ownerStoreId?: number | null },
): Promise<ProductRow> {
  const name = (input.name ?? '').trim();
  if (!name) throw new ValidationError('Le champ « Nom » est obligatoire');
  await assertProductNameAvailable(name);

  const unit = await resolveUnit(input.unit);
  const category = await resolveCategory(input.categoryId);

  const initialStock = Number(input.stock ?? 0);
  if (!Number.isFinite(initialStock) || initialStock < 0) {
    throw new ValidationError('Le stock initial ne peut pas être négatif');
  }

  const inserted = await db
    .insert(products)
    .values({
      name,
      categoryId: category?.id ?? null,
      unit,
      purchasePrice: positive(input.purchasePrice),
      salePrice: positive(input.salePrice),
      stockMin: positive(input.stockMin),
      barcode: input.barcode?.trim() || null,
      description: input.description?.trim() || null,
      isActive: input.isActive ?? true,
      ownerStoreId: options.ownerStoreId ?? null,
    })
    .returning({ id: products.id, syncId: products.syncId });

  if (!inserted[0]) throw new Error('Produit non créé');

  // Le produit entre dans l'assortiment du **seul** magasin qui le crée ; les
  // autres le reprendront du catalogue s'ils le vendent (avant v2 : partout).
  if (options.storeId) await ensureProductStockRow(options.storeId, inserted[0].id);

  if (options.storeId && (input.localSalePrice !== undefined || input.localStockMin !== undefined)) {
    await setLocalProductSettings(options.storeId, inserted[0].id, {
      salePrice: input.localSalePrice === undefined ? undefined : input.localSalePrice,
      stockMin: input.localStockMin === undefined ? undefined : input.localStockMin,
    });
  }

  if (initialStock > 0) {
    if (!options.storeId) throw new ValidationError('Choisissez un magasin pour enregistrer un stock initial.');
    await addStockMovement(inserted[0].id, 'entry', round3(initialStock), {
      storeId: options.storeId,
      motif: 'Stock initial',
      referenceType: 'inventory',
      userId: options.userId ?? null,
    });
  }

  const created = await getProduct(inserted[0].id, options.storeId ? [options.storeId] : []);
  if (!created) throw new Error('Produit créé mais introuvable');
  return created;
}

export async function updateProduct(
  id: number,
  patch: Partial<ProductInput>,
  options: { userId?: number | null; storeId?: number | null; canEditCatalog?: boolean } = {},
): Promise<ProductRow> {
  return withTransaction(() => updateProductInTx(id, patch, options));
}

async function updateProductInTx(
  id: number,
  patch: Partial<ProductInput>,
  options: { userId?: number | null; storeId?: number | null; canEditCatalog?: boolean },
): Promise<ProductRow> {
  const scope = options.storeId ? [options.storeId] : [];
  const existing = await getProduct(id, scope);
  if (!existing) throw new NotFoundError('Produit introuvable');

  const update: Record<string, unknown> = { updatedAt: new Date() };
  let categorySyncId: string | null | undefined;

  if (patch.name !== undefined) {
    const name = (patch.name ?? '').trim();
    if (!name) throw new ValidationError('Le champ « Nom » est obligatoire');
    if (name !== existing.name) await assertProductNameAvailable(name, id);
    update.name = name;
  }

  if (patch.categoryId !== undefined) {
    const category = await resolveCategory(patch.categoryId);
    update.categoryId = category?.id ?? null;
    categorySyncId = category?.syncId ?? null;
  }

  if (patch.unit !== undefined) update.unit = await resolveUnit(patch.unit);
  if (patch.purchasePrice !== undefined) update.purchasePrice = positive(patch.purchasePrice);
  if (patch.salePrice !== undefined) update.salePrice = positive(patch.salePrice);
  if (patch.stockMin !== undefined) update.stockMin = positive(patch.stockMin);
  if (patch.barcode !== undefined) update.barcode = patch.barcode?.trim() || null;
  if (patch.description !== undefined) update.description = patch.description?.trim() || null;
  if (patch.isActive !== undefined) {
    update.isActive = patch.isActive;
    // Réactiver efface le tombstone de synchronisation posé par la désactivation.
    if (patch.isActive) update.deletedAt = null;
  }

  // Le stock n'est jamais écrit : on convertit la valeur visée en **écart signé**.
  let stockDelta = 0;
  if (patch.stock !== undefined) {
    const target = Number(patch.stock);
    if (!Number.isFinite(target) || target < 0) {
      throw new ValidationError('Le stock ne peut pas être négatif');
    }
    stockDelta = round3(target - existing.stock);
  }

  // Fiche commune (§7, README §28.5) : seuls le siège, ou le magasin créateur
  // d'un produit qu'il est seul à proposer, la modifient. Les autres ne
  // touchent qu'aux réglages locaux (prix local, seuil local, stock).
  const centralKeys = Object.keys(update).filter((key) => key !== 'updatedAt');
  if (centralKeys.length > 0 && options.canEditCatalog === false) {
    throw new ValidationError(
      'Ce produit appartient au catalogue commun : seuls le prix local, le seuil local et le stock de votre magasin sont modifiables. La fiche se modifie au siège (ou par le magasin qui l’a créé, s’il est seul à le vendre).',
    );
  }

  if (centralKeys.length > 0) {
    const updated = await db
      .update(products)
      .set(update as any)
      .where(eq(products.id, id))
      .returning({ id: products.id });
    if (updated.length === 0) throw new NotFoundError('Produit introuvable');
  }

  if (options.storeId && (patch.localSalePrice !== undefined || patch.localStockMin !== undefined)) {
    await setLocalProductSettings(options.storeId, id, {
      salePrice:
        patch.localSalePrice === undefined ? undefined : patch.localSalePrice === null ? null : positive(patch.localSalePrice),
      stockMin:
        patch.localStockMin === undefined ? undefined : patch.localStockMin === null ? null : positive(patch.localStockMin),
    });
  }

  if (stockDelta !== 0) {
    if (!options.storeId) throw new ValidationError('Choisissez un magasin pour corriger le stock.');
    await adjustStock(options.storeId, id, stockDelta, 'Correction depuis la fiche produit', {
      userId: options.userId ?? null,
    });
  }

  const result = await getProduct(id, scope);
  if (!result) throw new Error('Produit introuvable après modification');
  return result;
}

/**
 * Désactivation — **jamais** de suppression physique (§26.13) : un `DELETE`
 * ferait ressusciter la ligne au prochain pull, et une facture ancienne doit
 * rester lisible avec son produit.
 */
export async function deactivateProduct(id: number): Promise<void> {
  const existing = await getProduct(id);
  if (!existing) throw new NotFoundError('Produit introuvable');

  const updated = await db
    .update(products)
    .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(products.id, id))
    .returning({ syncId: products.syncId });

  if (updated.length === 0) throw new NotFoundError('Produit introuvable');

}

export async function reactivateProduct(id: number): Promise<void> {
  const existing = await getProduct(id);
  if (!existing) throw new NotFoundError('Produit introuvable');

  const updated = await db
    .update(products)
    .set({ isActive: true, deletedAt: null, updatedAt: new Date() })
    .where(eq(products.id, id))
    .returning({ syncId: products.syncId });

  if (updated.length === 0) throw new NotFoundError('Produit introuvable');

}

/* ------------------------------------------------------------------ *
 * Lecture — catégories
 * ------------------------------------------------------------------ */

function categorySelect(scope?: StoreScope): string {
  const storeCount = scope
    ? `(SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1 AND ${listedSql(scope)})`
    : 'NULL';
  return `
  SELECT c.id, c.name, c.kind, c.description, c.is_active, c.created_at,
         (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count,
         (SELECT COUNT(*) FROM products p
           WHERE p.category_id = c.id AND p.is_active = 1) AS active_product_count,
         ${storeCount} AS store_product_count
  FROM categories c
`;
}

function mapCategoryRow(row: any): CategoryRow {
  return {
    id: Number(row.id),
    name: row.name,
    kind: isCategoryKind(row.kind) ? row.kind : 'finished',
    description: row.description ?? null,
    isActive: Boolean(row.is_active),
    productCount: Number(row.product_count ?? 0),
    activeProductCount: Number(row.active_product_count ?? 0),
    storeProductCount: row.store_product_count == null ? null : Number(row.store_product_count),
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

/**
 * Catégories du catalogue. Par défaut, seules les catégories actives sont
 * renvoyées : c'est ce qu'attend un sélecteur de formulaire. La page de gestion
 * passe `includeInactive: true` pour pouvoir réactiver une catégorie.
 */
export async function listCategories(
  options: {
    includeInactive?: boolean;
    /** `recent` (défaut) = dernière insertion ; `name` = ordre alphabétique. */
    sort?: ListSort;
    /** Magasins dont on compte les produits (`storeProductCount`). */
    scope?: StoreScope;
  } = {},
): Promise<CategoryRow[]> {
  const whereSql = options.includeInactive ? '' : 'WHERE c.is_active = 1';
  const orderBy = sqlOrderBy(options.sort ?? DEFAULT_LIST_SORT, 'c', ['recent', 'name']);
  const rows = await rawAll<any>(`${categorySelect(options.scope)} ${whereSql} ORDER BY ${orderBy}`);
  return rows.map(mapCategoryRow);
}

export async function getCategory(id: number): Promise<CategoryRow | null> {
  const row = await rawGet<any>(`${categorySelect()} WHERE c.id = ?`, [id]);
  return row ? mapCategoryRow(row) : null;
}

/* ------------------------------------------------------------------ *
 * Écriture — catégories
 * ------------------------------------------------------------------ */

async function assertNameAvailable(name: string, exceptId?: number): Promise<void> {
  const row = await rawGet<{ id: number }>(
    'SELECT id FROM categories WHERE LOWER(name) = LOWER(?)',
    [name],
  );
  if (row && Number(row.id) !== exceptId) {
    throw new ConflictError(`Une catégorie porte déjà le nom « ${name} ».`);
  }
}

export async function createCategory(input: CategoryInput): Promise<CategoryRow> {
  const name = (input.name ?? '').trim();
  if (!name) throw new ValidationError('Le champ « Nom » est obligatoire');

  const kind = input.kind ?? 'finished';
  if (!isCategoryKind(kind)) {
    throw new ValidationError('Type de catégorie invalide (produit fini, matière première ou service)');
  }

  await assertNameAvailable(name);

  const inserted = await db
    .insert(categories)
    .values({
      name,
      kind,
      description: input.description?.trim() || null,
      isActive: input.isActive ?? true,
    })
    .returning({ id: categories.id, syncId: categories.syncId });

  if (!inserted[0]) throw new Error('Catégorie non créée');

  const created = await getCategory(inserted[0].id);
  if (!created) throw new Error('Catégorie créée mais introuvable');
  return created;
}

export async function updateCategory(
  id: number,
  patch: Partial<CategoryInput>,
): Promise<CategoryRow> {
  const existing = await getCategory(id);
  if (!existing) throw new NotFoundError('Catégorie introuvable');

  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.name !== undefined) {
    const name = (patch.name ?? '').trim();
    if (!name) throw new ValidationError('Le champ « Nom » est obligatoire');
    if (name.toLowerCase() !== existing.name.toLowerCase()) await assertNameAvailable(name, id);
    update.name = name;
  }

  if (patch.kind !== undefined) {
    if (!isCategoryKind(patch.kind)) {
      throw new ValidationError('Type de catégorie invalide (produit fini, matière première ou service)');
    }
    update.kind = patch.kind;
  }

  if (patch.description !== undefined) update.description = patch.description?.trim() || null;
  if (patch.isActive !== undefined) {
    update.isActive = patch.isActive;
    // Réactiver efface le tombstone posé par la désactivation.
    if (patch.isActive) update.deletedAt = null;
  }

  const updated = await db
    .update(categories)
    .set(update as any)
    .where(eq(categories.id, id))
    .returning({ id: categories.id, syncId: categories.syncId });

  if (updated.length === 0) throw new NotFoundError('Catégorie introuvable');

  const result = await getCategory(id);
  if (!result) throw new Error('Catégorie introuvable après modification');
  return result;
}

/**
 * Désactivation d'une catégorie.
 *
 * ⚠️ On **refuse** tant qu'elle contient des produits actifs : désactiver une
 * catégorie encore utilisée retirerait ces produits des listes filtrées par
 * catégorie sans que personne ne comprenne pourquoi. Le message dit quoi faire.
 */
export async function deactivateCategory(id: number): Promise<void> {
  const existing = await getCategory(id);
  if (!existing) throw new NotFoundError('Catégorie introuvable');

  const active = await rawGet<{ total: number }>(
    'SELECT COUNT(*) AS total FROM products WHERE category_id = ? AND is_active = 1',
    [id],
  );
  const activeCount = Number(active?.total ?? 0);

  if (activeCount > 0) {
    throw new ConflictError(
      `Impossible de désactiver « ${existing.name} » : ${activeCount} produit(s) actif(s) y sont encore rattachés. ` +
        'Déplacez-les vers une autre catégorie ou désactivez-les d’abord.',
    );
  }

  const updated = await db
    .update(categories)
    .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(categories.id, id))
    .returning({ syncId: categories.syncId });

  if (updated.length === 0) throw new NotFoundError('Catégorie introuvable');

}

export async function reactivateCategory(id: number): Promise<void> {
  const existing = await getCategory(id);
  if (!existing) throw new NotFoundError('Catégorie introuvable');

  const updated = await db
    .update(categories)
    .set({ isActive: true, deletedAt: null, updatedAt: new Date() })
    .where(eq(categories.id, id))
    .returning({ syncId: categories.syncId });

  if (updated.length === 0) throw new NotFoundError('Catégorie introuvable');

}

/* ------------------------------------------------------------------ *
 * Aides
 * ------------------------------------------------------------------ */

function positive(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return round3(n);
}

/** Arrondi au millième : les quantités sont décimales (m², kg). */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
