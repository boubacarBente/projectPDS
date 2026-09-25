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
 */

import { db, rawAll, rawGet } from '@/db';
import { categories, products } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api';
import { enqueueSyncWrite } from '@/lib/sync';
import { addStockMovement, adjustStock } from '@/lib/stock';
import { getSettings, nextSequence } from '@/lib/settings';
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
  code: string;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryKind: CategoryKind | null;
  unit: string;
  /** Prix d'achat — base du calcul de marge. */
  purchasePrice: number;
  salePrice: number;
  /** `real` : le m² et le kg ne sont pas entiers. */
  stock: number;
  stockMin: number;
  description: string | null;
  isActive: boolean;
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
  /** Laisser vide pour une génération automatique (`PRD-0001`). */
  code?: string | null;
  name: string;
  categoryId?: number | null;
  unit?: string | null;
  purchasePrice?: number;
  salePrice?: number;
  /** Stock initial : enregistré comme mouvement `entry`, jamais écrit en dur. */
  stock?: number;
  stockMin?: number;
  description?: string | null;
  isActive?: boolean;
};

export type ProductListOptions = {
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
  categoriesCount: number;
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
  createdAt: Date | null;
};

export type CategoryInput = {
  name: string;
  kind?: CategoryKind;
  description?: string | null;
  isActive?: boolean;
};

/** Préfixe du code interne, généré quand il n'est pas saisi. */
export const PRODUCT_CODE_PREFIX = 'PRD';

/* ------------------------------------------------------------------ *
 * Lecture — produits
 * ------------------------------------------------------------------ */

const PRODUCT_FROM = `
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
`;

const PRODUCT_COLUMNS = `
  p.id, p.code, p.name, p.category_id, p.unit, p.purchase_price, p.sale_price,
  p.stock, p.stock_min, p.description, p.is_active, p.created_at,
  c.name AS category_name, c.kind AS category_kind
`;

function mapProductRow(row: any): ProductRow {
  const stock = Number(row.stock ?? 0);
  const stockMin = Number(row.stock_min ?? 0);
  const purchasePrice = Number(row.purchase_price ?? 0);
  const salePrice = Number(row.sale_price ?? 0);
  const margin = salePrice - purchasePrice;

  return {
    id: Number(row.id),
    code: row.code,
    name: row.name,
    categoryId: row.category_id == null ? null : Number(row.category_id),
    categoryName: row.category_name ?? null,
    categoryKind: isCategoryKind(row.category_kind) ? row.category_kind : null,
    unit: row.unit,
    purchasePrice,
    salePrice,
    stock,
    stockMin,
    description: row.description ?? null,
    isActive: Boolean(row.is_active),
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
  if (options.categoryId) {
    where.push('p.category_id = ?');
    args.push(options.categoryId);
  }
  if (options.kind) {
    where.push('c.kind = ?');
    args.push(options.kind);
  }
  if (options.search) {
    where.push('(p.code LIKE ? OR p.name LIKE ? OR p.description LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
  }
  if (options.lowStockOnly) {
    where.push('p.stock_min > 0 AND p.stock <= p.stock_min');
  }
  if (options.outOfStockOnly) {
    where.push('p.stock <= 0');
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
    `SELECT ${PRODUCT_COLUMNS}
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
export async function getProduct(id: number): Promise<ProductRow | null> {
  const row = await rawGet<any>(
    `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.id = ?`,
    [id],
  );

  return row ? mapProductRow(row) : null;
}

/** Recherche rapide pour les modales de sélection (vente, achat, chantier). */
export async function searchProducts(term: string, limit = 20): Promise<ProductRow[]> {
  const { data } = await listProducts({ search: term, limit: Math.max(1, Math.min(100, limit)) });
  return data;
}

/**
 * Compteurs du catalogue.
 *
 * `lowStockCount` et `outOfStockCount` sont **mutuellement exclusifs** : une
 * rupture n'est pas comptée deux fois (même convention que `lib/stock.ts`).
 */
export async function getProductsSummary(): Promise<ProductsSummary> {
  const row = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM products) AS total_products,
       (SELECT COUNT(*) FROM products WHERE is_active = 1) AS active_products,
       (SELECT COUNT(*) FROM categories WHERE is_active = 1) AS categories_count,
       (SELECT COUNT(*) FROM products
         WHERE is_active = 1 AND stock > 0 AND stock_min > 0 AND stock <= stock_min) AS low_stock_count,
       (SELECT COUNT(*) FROM products WHERE is_active = 1 AND stock <= 0) AS out_of_stock_count,
       (SELECT COALESCE(SUM(stock * purchase_price), 0) FROM products WHERE is_active = 1) AS stock_purchase_value,
       (SELECT COALESCE(SUM(stock * sale_price), 0) FROM products WHERE is_active = 1) AS stock_sale_value`,
  );

  return {
    totalProducts: Number(row?.total_products ?? 0),
    activeProducts: Number(row?.active_products ?? 0),
    categoriesCount: Number(row?.categories_count ?? 0),
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
  code: 'code',
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

async function assertCodeAvailable(code: string, exceptId?: number): Promise<void> {
  const row = await rawGet<{ id: number }>('SELECT id FROM products WHERE code = ?', [code]);
  if (row && Number(row.id) !== exceptId) {
    throw new ConflictError(`Le code « ${code} » est déjà utilisé par un autre produit.`);
  }
}

/**
 * Le **nom est l'identifiant visible du produit** (demande client) : le code
 * interne n'est plus saisi ni affiché, donc deux produits ne peuvent pas porter
 * le même nom. La comparaison ignore la casse et les espaces de bord —
 * `LOWER(TRIM(name))` — sinon « Ciment 50 kg » et « ciment 50 kg » seraient deux
 * produits différents à l'écran.
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
    throw new ConflictError(`Un produit porte déjà le nom « ${name} ».`);
  }
}

/**
 * Code interne généré (`PRD-0001`) via le compteur `settings.seq_product_*`.
 * Le compteur étant annuel, on vérifie l'unicité : un `PRD-0001` de l'année
 * précédente ne doit pas être écrasé.
 */
async function generateProductCode(): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const sequence = await nextSequence('product');
    const code = `${PRODUCT_CODE_PREFIX}-${String(sequence).padStart(4, '0')}`;
    const existing = await rawGet<{ id: number }>('SELECT id FROM products WHERE code = ?', [code]);
    if (!existing) return code;
  }

  // Repli déterministe : jamais de doublon, jamais d'échec de création.
  return `${PRODUCT_CODE_PREFIX}-${Date.now().toString(36).toUpperCase()}`;
}

export async function createProduct(
  input: ProductInput,
  options: { userId?: number | null } = {},
): Promise<ProductRow> {
  const name = (input.name ?? '').trim();
  if (!name) throw new ValidationError('Le champ « Nom » est obligatoire');
  await assertProductNameAvailable(name);

  const unit = await resolveUnit(input.unit);
  const category = await resolveCategory(input.categoryId);

  const providedCode = (input.code ?? '').trim();
  let code: string;
  if (providedCode) {
    await assertCodeAvailable(providedCode);
    code = providedCode;
  } else {
    code = await generateProductCode();
  }

  const initialStock = Number(input.stock ?? 0);
  if (!Number.isFinite(initialStock) || initialStock < 0) {
    throw new ValidationError('Le stock initial ne peut pas être négatif');
  }

  const inserted = await db
    .insert(products)
    .values({
      code,
      name,
      categoryId: category?.id ?? null,
      unit,
      purchasePrice: positive(input.purchasePrice),
      salePrice: positive(input.salePrice),
      // Toujours 0 puis mouvement `entry` : l'invariant du stock est préservé.
      stock: 0,
      stockMin: positive(input.stockMin),
      description: input.description?.trim() || null,
      isActive: input.isActive ?? true,
    })
    .returning({ id: products.id, syncId: products.syncId });

  if (!inserted[0]) throw new Error('Produit non créé');

  await enqueueSyncWrite(
    'products',
    inserted[0].syncId,
    'insert',
    toSyncPayload(
      {
        code,
        name,
        categoryId: category?.id ?? null,
        unit,
        purchasePrice: positive(input.purchasePrice),
        salePrice: positive(input.salePrice),
        stockMin: positive(input.stockMin),
        description: input.description?.trim() || null,
        isActive: input.isActive ?? true,
      },
      category?.syncId,
    ),
  );

  if (initialStock > 0) {
    await addStockMovement(inserted[0].id, 'entry', round3(initialStock), {
      motif: 'Stock initial',
      referenceType: 'inventory',
      userId: options.userId ?? null,
    });
  }

  const created = await getProduct(inserted[0].id);
  if (!created) throw new Error('Produit créé mais introuvable');
  return created;
}

export async function updateProduct(
  id: number,
  patch: Partial<ProductInput>,
  options: { userId?: number | null } = {},
): Promise<ProductRow> {
  const existing = await getProduct(id);
  if (!existing) throw new NotFoundError('Produit introuvable');

  const update: Record<string, unknown> = { updatedAt: new Date() };
  let categorySyncId: string | null | undefined;

  if (patch.name !== undefined) {
    const name = (patch.name ?? '').trim();
    if (!name) throw new ValidationError('Le champ « Nom » est obligatoire');
    if (name !== existing.name) await assertProductNameAvailable(name, id);
    update.name = name;
  }

  if (patch.code !== undefined) {
    const code = (patch.code ?? '').trim();
    if (!code) throw new ValidationError('Le code produit ne peut pas être vide');
    if (code !== existing.code) await assertCodeAvailable(code, id);
    update.code = code;
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

  const updated = await db
    .update(products)
    .set(update as any)
    .where(eq(products.id, id))
    .returning({ id: products.id, syncId: products.syncId });

  if (updated.length === 0) throw new NotFoundError('Produit introuvable');

  await enqueueSyncWrite('products', updated[0].syncId, 'update', toSyncPayload(update, categorySyncId));

  if (stockDelta !== 0) {
    await adjustStock(id, stockDelta, 'Correction depuis la fiche produit', {
      userId: options.userId ?? null,
    });
  }

  const result = await getProduct(id);
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

  await enqueueSyncWrite('products', updated[0].syncId, 'delete', {
    deleted_at: new Date().toISOString(),
  });
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

  await enqueueSyncWrite('products', updated[0].syncId, 'update', {
    is_active: true,
    deleted_at: null,
    updated_at: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ *
 * Lecture — catégories
 * ------------------------------------------------------------------ */

const CATEGORY_SELECT = `
  SELECT c.id, c.name, c.kind, c.description, c.is_active, c.created_at,
         (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count,
         (SELECT COUNT(*) FROM products p
           WHERE p.category_id = c.id AND p.is_active = 1) AS active_product_count
  FROM categories c
`;

function mapCategoryRow(row: any): CategoryRow {
  return {
    id: Number(row.id),
    name: row.name,
    kind: isCategoryKind(row.kind) ? row.kind : 'finished',
    description: row.description ?? null,
    isActive: Boolean(row.is_active),
    productCount: Number(row.product_count ?? 0),
    activeProductCount: Number(row.active_product_count ?? 0),
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
  } = {},
): Promise<CategoryRow[]> {
  const whereSql = options.includeInactive ? '' : 'WHERE c.is_active = 1';
  const orderBy = sqlOrderBy(options.sort ?? DEFAULT_LIST_SORT, 'c', ['recent', 'name']);
  const rows = await rawAll<any>(`${CATEGORY_SELECT} ${whereSql} ORDER BY ${orderBy}`);
  return rows.map(mapCategoryRow);
}

export async function getCategory(id: number): Promise<CategoryRow | null> {
  const row = await rawGet<any>(`${CATEGORY_SELECT} WHERE c.id = ?`, [id]);
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

  await enqueueSyncWrite('categories', inserted[0].syncId, 'insert', {
    name,
    kind,
    description: input.description?.trim() || null,
    is_active: input.isActive ?? true,
    updated_at: new Date().toISOString(),
  });

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

  await enqueueSyncWrite('categories', updated[0].syncId, 'update', {
    name: update.name ?? existing.name,
    kind: update.kind ?? existing.kind,
    description: update.description !== undefined ? update.description : existing.description,
    is_active: update.isActive ?? existing.isActive,
    updated_at: new Date().toISOString(),
  });

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

  await enqueueSyncWrite('categories', updated[0].syncId, 'delete', {
    deleted_at: new Date().toISOString(),
  });
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

  await enqueueSyncWrite('categories', updated[0].syncId, 'update', {
    is_active: true,
    deleted_at: null,
    updated_at: new Date().toISOString(),
  });
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
