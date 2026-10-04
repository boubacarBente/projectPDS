/**
 * Inventaires physiques par établissement (cahier des charges §7).
 *
 * Étapes : **ouverture** (liste des produits à compter, éventuellement limitée
 * à une catégorie) → **comptage** (saisie des quantités constatées, avec
 * justification des écarts, **obligatoire** pour valider) → **validation** (chaque écart devient un
 * mouvement `adjustment` signé dans le journal de stock du magasin).
 *
 * Le stock théorique de chaque ligne est relevé **au moment où le comptage
 * est saisi** : une vente faite entre l'ouverture et le comptage ne fausse donc
 * pas l'écart. L'écart appliqué à la validation est `compté − théorique`.
 *
 * Une seule session d'inventaire ouverte par magasin.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { inventories, inventoryItems } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError, ValidationError } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { nextDocumentNumber } from '@/lib/settings';
import { adjustStock, getStoreStock, listedSql } from '@/lib/stock';
import { assertStoreWritable, scopeSql, type StoreScope } from '@/lib/stores';

export type InventoryStatus = 'open' | 'validated' | 'cancelled';

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  open: 'Comptage en cours',
  validated: 'Validé',
  cancelled: 'Annulé',
};

export type InventoryUser = { id: number; name: string; storeId: number | null };

export type InventoryRow = {
  id: number;
  reference: string;
  storeId: number;
  storeName: string;
  status: InventoryStatus;
  categoryId: number | null;
  categoryName: string | null;
  openedByName: string | null;
  validatedByName: string | null;
  validatedAt: Date | null;
  notes: string | null;
  itemCount: number;
  countedCount: number;
  discrepancyCount: number;
  /** Valeur des écarts au prix d'achat (positive = surplus). */
  discrepancyValue: number;
  createdAt: Date | null;
};

export type InventoryItemRow = {
  id: number;
  productId: number;
  productName: string;
  unit: string;
  expectedQuantity: number;
  countedQuantity: number | null;
  difference: number | null;
  purchasePrice: number;
  justification: string | null;
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const ts = (value: unknown) => (value ? new Date(Number(value) * 1000) : null);

const INVENTORY_SELECT = `
  SELECT i.*, s.name AS store_name, c.name AS category_name,
         uo.name AS opened_by_name, uv.name AS validated_by_name,
         (SELECT COUNT(*) FROM inventory_items ii WHERE ii.inventory_id = i.id) AS item_count,
         (SELECT COUNT(*) FROM inventory_items ii WHERE ii.inventory_id = i.id AND ii.counted_quantity IS NOT NULL) AS counted_count,
         (SELECT COUNT(*) FROM inventory_items ii WHERE ii.inventory_id = i.id AND ii.counted_quantity IS NOT NULL
            AND abs(ii.counted_quantity - ii.expected_quantity) > 0.0001) AS discrepancy_count,
         (SELECT COALESCE(SUM((ii.counted_quantity - ii.expected_quantity) * COALESCE(p.purchase_price, 0)), 0)
            FROM inventory_items ii LEFT JOIN products p ON p.id = ii.product_id
           WHERE ii.inventory_id = i.id AND ii.counted_quantity IS NOT NULL) AS discrepancy_value
    FROM inventories i
    JOIN stores s ON s.id = i.store_id
    LEFT JOIN categories c ON c.id = i.category_id
    LEFT JOIN users uo ON uo.id = i.opened_by
    LEFT JOIN users uv ON uv.id = i.validated_by`;

function mapInventory(row: any): InventoryRow {
  return {
    id: Number(row.id),
    reference: String(row.reference),
    storeId: Number(row.store_id),
    storeName: String(row.store_name),
    status: row.status as InventoryStatus,
    categoryId: row.category_id == null ? null : Number(row.category_id),
    categoryName: row.category_name ?? null,
    openedByName: row.opened_by_name ?? null,
    validatedByName: row.validated_by_name ?? null,
    validatedAt: ts(row.validated_at),
    notes: row.notes ?? null,
    itemCount: Number(row.item_count ?? 0),
    countedCount: Number(row.counted_count ?? 0),
    discrepancyCount: Number(row.discrepancy_count ?? 0),
    discrepancyValue: Math.round(Number(row.discrepancy_value ?? 0)),
    createdAt: ts(row.created_at),
  };
}

export async function listInventories(options: {
  scope: StoreScope;
  status?: string;
  page?: number;
  limit?: number;
}): Promise<{ data: InventoryRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const where = [scopeSql('i.store_id', options.scope)];
  const args: unknown[] = [];
  if (options.status && options.status !== 'all') {
    where.push('i.status = ?');
    args.push(options.status);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [rows, count] = await Promise.all([
    rawAll<any>(`${INVENTORY_SELECT} ${whereSql} ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`, [
      ...args,
      limit,
      (page - 1) * limit,
    ] as any),
    rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM inventories i ${whereSql}`, args as any),
  ]);
  const total = Number(count?.n ?? 0);
  return { data: rows.map(mapInventory), total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

export async function getInventory(
  id: number,
): Promise<{ inventory: InventoryRow; items: InventoryItemRow[] } | null> {
  const row = await rawGet<any>(`${INVENTORY_SELECT} WHERE i.id = ?`, [id]);
  if (!row) return null;
  /*
   * Ligne pas encore comptée d'un inventaire ouvert : on montre le stock
   * **actuel**, pas celui relevé à l'ouverture. Sinon, après une vente faite
   * pendant l'inventaire, la feuille affichait un théorique périmé et un écart
   * faux pendant la saisie (constaté en recette). Le serveur relève de toute
   * façon le théorique au moment où le comptage est enregistré.
   */
  const items = await rawAll<any>(
    `SELECT ii.*, COALESCE(p.purchase_price, 0) AS purchase_price,
            CASE WHEN ii.counted_quantity IS NULL AND ? = 'open'
                 THEN COALESCE(ps.quantity, 0) ELSE ii.expected_quantity END AS shown_expected
       FROM inventory_items ii
       LEFT JOIN products p ON p.id = ii.product_id
       LEFT JOIN product_stocks ps ON ps.product_id = ii.product_id AND ps.store_id = ?
      WHERE ii.inventory_id = ?
      ORDER BY ii.product_name COLLATE NOCASE`,
    [String(row.status), Number(row.store_id), id],
  );
  return {
    inventory: mapInventory(row),
    items: items.map((i) => {
      const counted = i.counted_quantity == null ? null : round3(Number(i.counted_quantity));
      const expected = round3(Number(i.shown_expected ?? i.expected_quantity ?? 0));
      return {
        id: Number(i.id),
        productId: Number(i.product_id),
        productName: String(i.product_name),
        unit: String(i.unit),
        expectedQuantity: expected,
        countedQuantity: counted,
        difference: counted === null ? null : round3(counted - expected),
        purchasePrice: Number(i.purchase_price ?? 0),
        justification: i.justification ?? null,
      };
    }),
  };
}

function assertStore(inventory: InventoryRow, user: InventoryUser) {
  if (!user.storeId || inventory.storeId !== user.storeId) {
    throw new ValidationError(
      'Cet inventaire appartient à un autre magasin : il ne se traite que depuis ce magasin.',
    );
  }
}

export async function openInventory(
  input: { categoryId?: number | null; notes?: string | null },
  user: InventoryUser,
): Promise<number> {
  if (!user.storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');
  const storeId = user.storeId;
  await assertStoreWritable(storeId);

  return withTransaction(async () => {
    const open = await rawGet<{ reference: string }>(
      `SELECT reference FROM inventories WHERE store_id = ? AND status = 'open' LIMIT 1`,
      [storeId],
    );
    if (open) {
      throw new ValidationError(`Un inventaire est déjà en cours dans ce magasin (${open.reference}).`);
    }

    const categoryId = input.categoryId ? Number(input.categoryId) : null;
    const products = await rawAll<any>(
      `SELECT p.id, p.name, p.unit,
              COALESCE((SELECT ps.quantity FROM product_stocks ps WHERE ps.product_id = p.id AND ps.store_id = ?), 0) AS stock
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = 1 AND p.deleted_at IS NULL
          AND ${listedSql([storeId])}
          AND (c.kind IS NULL OR c.kind <> 'service')
          ${categoryId ? 'AND p.category_id = ?' : ''}
        ORDER BY p.name COLLATE NOCASE`,
      (categoryId ? [storeId, categoryId] : [storeId]) as any,
    );
    if (products.length === 0) throw new ValidationError('Aucun produit à inventorier');

    const reference = await nextDocumentNumber('inventory', storeId);
    const [created] = await db
      .insert(inventories)
      .values({
        reference,
        storeId,
        status: 'open',
        categoryId,
        openedBy: user.id,
        notes: input.notes?.trim() || null,
      })
      .returning({ id: inventories.id });

    for (const product of products) {
      await db.insert(inventoryItems).values({
        inventoryId: created.id,
        productId: Number(product.id),
        productName: String(product.name),
        unit: String(product.unit),
        expectedQuantity: round3(Number(product.stock ?? 0)),
      });
    }

    await writeAudit({
      user,
      storeId,
      action: 'create',
      entity: 'inventory',
      entityId: created.id,
      details: { reference, produits: products.length, categoryId },
    });

    return Number(created.id);
  });
}

/** Saisie des comptages. Le théorique est relevé au moment de la saisie. */
export async function recordCounts(
  id: number,
  counts: { itemId: number; countedQuantity: number | null; justification?: string | null }[],
  user: InventoryUser,
): Promise<void> {
  await withTransaction(async () => {
    const detail = await getInventory(id);
    if (!detail) throw new NotFoundError('Inventaire introuvable');
    assertStore(detail.inventory, user);
    if (detail.inventory.status !== 'open') throw new ValidationError('Cet inventaire est clôturé');

    const byId = new Map(detail.items.map((item) => [item.id, item]));
    for (const count of counts) {
      const item = byId.get(Number(count.itemId));
      if (!item) continue;
      const value =
        count.countedQuantity === null || count.countedQuantity === undefined || (count.countedQuantity as any) === ''
          ? null
          : Number(count.countedQuantity);
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new ValidationError(`Quantité comptée invalide pour ${item.productName}`);
      }
      const expected = await getStoreStock(detail.inventory.storeId, item.productId);
      await db
        .update(inventoryItems)
        .set({
          countedQuantity: value === null ? null : round3(value),
          expectedQuantity: round3(expected),
          justification: count.justification?.trim() || null,
        })
        .where(eq(inventoryItems.id, item.id));
    }
  });
}

/** Validation : chaque écart devient un ajustement de stock motivé. */
export async function validateInventory(
  id: number,
  user: InventoryUser,
): Promise<{ adjustments: number; value: number }> {
  return withTransaction(async () => {
    const detail = await getInventory(id);
    if (!detail) throw new NotFoundError('Inventaire introuvable');
    assertStore(detail.inventory, user);
    if (detail.inventory.status !== 'open') throw new ValidationError('Cet inventaire est déjà clôturé');
    await assertStoreWritable(detail.inventory.storeId);

    const counted = detail.items.filter((item) => item.countedQuantity !== null);
    if (counted.length === 0) throw new ValidationError('Aucun comptage saisi');

    /*
     * Chaque écart doit être expliqué (cahier des charges §7 : « écarts,
     * justification et validation »). Un ajustement de stock sans motif est
     * exactement ce que le contrôle interne doit empêcher : une perte (ou un
     * surplus) que personne n'a expliquée. Avant v2, la justification était
     * facultative.
     */
    const unexplained = counted.filter(
      (item) =>
        Math.abs(Number(item.countedQuantity) - Number(item.expectedQuantity)) > 0.0001 && !item.justification?.trim(),
    );
    if (unexplained.length > 0) {
      throw new ValidationError(
        `Justifiez chaque écart avant de valider (casse, vol, erreur de saisie…) : ${unexplained
          .slice(0, 5)
          .map((item) => item.productName)
          .join(', ')}${unexplained.length > 5 ? ` et ${unexplained.length - 5} autre(s)` : ''}.`,
      );
    }

    let adjustments = 0;
    let value = 0;
    for (const item of counted) {
      // Théorique relu à la validation : il reflète les ventes faites depuis la saisie.
      const current = await getStoreStock(detail.inventory.storeId, item.productId);
      const delta = round3(Number(item.countedQuantity) - Number(item.expectedQuantity));
      if (Math.abs(delta) < 0.0001) continue;
      if (current + delta < -0.0001) {
        throw new ValidationError(
          `${item.productName} : l'écart (${delta}) rendrait le stock négatif. Recomptez ce produit.`,
        );
      }
      await adjustStock(
        detail.inventory.storeId,
        item.productId,
        delta,
        `Inventaire ${detail.inventory.reference}${item.justification ? ` — ${item.justification}` : ''}`,
        { userId: user.id, referenceType: 'inventory', referenceId: id },
      );
      adjustments += 1;
      value += delta * item.purchasePrice;
    }

    await db
      .update(inventories)
      .set({ status: 'validated', validatedBy: user.id, validatedAt: new Date() })
      .where(eq(inventories.id, id));

    await writeAudit({
      user,
      storeId: detail.inventory.storeId,
      action: 'validate',
      entity: 'inventory',
      entityId: id,
      details: { reference: detail.inventory.reference, ajustements: adjustments, valeur: Math.round(value) },
    });

    return { adjustments, value: Math.round(value) };
  });
}

export async function cancelInventory(id: number, user: InventoryUser, reason: string): Promise<void> {
  if (!reason?.trim()) throw new ValidationError("Le motif d'annulation est obligatoire");
  await withTransaction(async () => {
    const detail = await getInventory(id);
    if (!detail) throw new NotFoundError('Inventaire introuvable');
    assertStore(detail.inventory, user);
    if (detail.inventory.status !== 'open') throw new ValidationError('Cet inventaire est déjà clôturé');
    await db
      .update(inventories)
      .set({
        status: 'cancelled',
        notes: [detail.inventory.notes, `Annulé : ${reason.trim()}`].filter(Boolean).join(' — '),
      })
      .where(eq(inventories.id, id));
    await writeAudit({
      user,
      storeId: detail.inventory.storeId,
      action: 'cancel',
      entity: 'inventory',
      entityId: id,
      details: { reference: detail.inventory.reference, motif: reason },
    });
  });
}
