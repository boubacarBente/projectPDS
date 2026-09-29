/**
 * Commandes clients de briques (README §20, « Commandes et ventes »).
 *
 * ## Ce qu'est une commande — et ce qu'elle n'est pas
 *
 * Une commande est un **engagement commercial** : un client, plusieurs types de
 * briques, des quantités, un prix négocié, une remise, une livraison promise.
 * Elle suit son cycle (`draft` → `confirmed` → `in_production` → `ready` →
 * `partially_delivered` → `delivered`, ou `cancelled`) et peut être **facturée**.
 *
 * Ce qui sort le stock et fait entrer le chiffre d'affaires, c'est la **facture
 * de vente** née de la commande (`invoiceBrickOrder()`), canal `brick` : la
 * commande, elle, ne touche **jamais** le stock. C'est le choix de workflow
 * explicitement autorisé par le cahier des charges (« sortie automatique lors
 * d'une vente ou livraison **selon le workflow choisi** »). Conséquence : un
 * seul document peut être pris pour source de vérité du stock, et il est déjà
 * écrit, testé et sauvegardé.
 *
 * ## L'acompte
 *
 * L'acompte versé sur une commande est un `payments` de type `brick_order` :
 * reçu numéroté, mouvement de caisse, reste à payer recalculé — exactement comme
 * un encaissement de vente. À la facturation, ces paiements sont **transférés**
 * sur la facture (`type = 'sale'`, `reference_id = <facture>`) : le numéro de
 * reçu et le mouvement de caisse restent identiques, et l'argent n'est jamais
 * compté deux fois.
 */

import { db, rawAll, rawGet, rawRun } from '@/db';
import { eq } from 'drizzle-orm';
import { brickOrderItems, brickOrders } from '@/db/schema';
import { enqueueSyncWrite } from '@/lib/sync';
import { nextDocumentNumber } from '@/lib/settings';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api';
import { roundMoney, today } from '@/lib/format';
import { createPayment, listPayments, recomputeDocumentPayments, getPaymentSchedule } from '@/lib/payments';
import { createSalesInvoice } from '@/lib/sales';

/* ------------------------------------------------------------------ *
 * Types et listes fermées
 * ------------------------------------------------------------------ */

export const BRICK_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'in_production',
  'ready',
  'partially_delivered',
  'delivered',
  'cancelled',
] as const;
export type BrickOrderStatus = (typeof BRICK_ORDER_STATUSES)[number];

export const BRICK_ORDER_STATUS_LABELS: Record<BrickOrderStatus, string> = {
  draft: 'Brouillon',
  confirmed: 'Confirmée',
  in_production: 'En production',
  ready: 'Prête',
  partially_delivered: 'Partiellement livrée',
  delivered: 'Livrée',
  cancelled: 'Annulée',
};

/**
 * Transitions autorisées. Une livraison se pose **après** la préparation ; un
 * brouillon ne saute pas directement à « livrée ». La règle vit ici, pas dans
 * l'interface : un appel direct à l'API la subit aussi.
 */
const STATUS_TRANSITIONS: Record<BrickOrderStatus, BrickOrderStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['in_production', 'cancelled'],
  in_production: ['ready', 'cancelled'],
  ready: ['partially_delivered', 'delivered', 'cancelled'],
  partially_delivered: ['partially_delivered', 'delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export function isBrickOrderStatus(value: unknown): value is BrickOrderStatus {
  return typeof value === 'string' && (BRICK_ORDER_STATUSES as readonly string[]).includes(value);
}

export type BrickOrderItemRow = {
  id: number;
  orderId: number;
  brickTypeId: number | null;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  amount: number;
  deliveredQuantity: number;
};

export type BrickOrderRow = {
  id: number;
  orderNumber: string;
  customerId: number | null;
  customerName: string;
  userId: number | null;
  userName: string | null;
  /** Date métier `YYYY-MM-DD`. */
  date: string;
  dueDate: string | null;
  deliveryDate: string | null;
  promisedDate: string | null;
  subTotal: number;
  discount: number;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  status: BrickOrderStatus;
  salesInvoiceId: number | null;
  salesInvoiceNumber: string | null;
  cancelReason: string | null;
  notes: string | null;
  itemsCount: number;
  /** Quantité totale commandée et total déjà livré (suivi de livraison). */
  quantityOrdered: number;
  quantityDelivered: number;
  isCancelled: boolean;
  createdAt: Date | null;
};

export type BrickOrderDetail = {
  order: BrickOrderRow;
  items: BrickOrderItemRow[];
  payments: Awaited<ReturnType<typeof listPayments>>['data'];
  schedule: Awaited<ReturnType<typeof getPaymentSchedule>>;
};

export type BrickOrderItemInput = {
  brickTypeId: number;
  quantity: number;
  unitPrice: number;
  discount?: number;
};

export type BrickOrderInput = {
  customerId?: number | null;
  customerName?: string;
  date: string;
  dueDate?: string | null;
  promisedDate?: string | null;
  discount?: number;
  notes?: string | null;
  status?: BrickOrderStatus;
  items: BrickOrderItemInput[];
  userId?: number | null;
};

export type BrickOrderListOptions = {
  search?: string;
  status?: string;
  customerId?: number;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  includeAllStatuses?: boolean;
};

/* ------------------------------------------------------------------ *
 * Utilitaires
 * ------------------------------------------------------------------ */

function cleanDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError(`La ${label} doit être au format AAAA-MM-JJ`);
  }
  return text;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

const ORDER_SELECT = `
  SELECT o.id, o.order_number, o.customer_id, o.customer_name, o.user_id, u.name AS user_name,
         o.date, o.due_date, o.delivery_date, o.promised_date,
         o.sub_total, o.discount, o.total, o.amount_paid, o.remaining_amount, o.payment_status,
         o.status, o.sales_invoice_id, o.cancel_reason, o.notes, o.created_at, o.deleted_at,
         v.invoice_number AS sales_invoice_number,
         (SELECT COUNT(*) FROM brick_order_items i WHERE i.order_id = o.id) AS items_count,
         (SELECT COALESCE(SUM(i.quantity), 0) FROM brick_order_items i WHERE i.order_id = o.id) AS quantity_ordered,
         (SELECT COALESCE(SUM(i.delivered_quantity), 0) FROM brick_order_items i WHERE i.order_id = o.id) AS quantity_delivered
  FROM brick_orders o
  LEFT JOIN users u ON u.id = o.user_id
  LEFT JOIN sales_invoices v ON v.id = o.sales_invoice_id
`;

function mapOrderRow(row: any): BrickOrderRow {
  return {
    id: Number(row.id),
    orderNumber: row.order_number,
    customerId: row.customer_id == null ? null : Number(row.customer_id),
    customerName: row.customer_name,
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name ?? null,
    date: row.date,
    dueDate: row.due_date ?? null,
    deliveryDate: row.delivery_date ?? null,
    promisedDate: row.promised_date ?? null,
    subTotal: Number(row.sub_total ?? 0),
    discount: Number(row.discount ?? 0),
    total: Number(row.total ?? 0),
    amountPaid: Number(row.amount_paid ?? 0),
    remainingAmount: Number(row.remaining_amount ?? 0),
    paymentStatus: row.payment_status ?? 'unpaid',
    status: isBrickOrderStatus(row.status) ? row.status : 'draft',
    salesInvoiceId: row.sales_invoice_id == null ? null : Number(row.sales_invoice_id),
    salesInvoiceNumber: row.sales_invoice_number ?? null,
    cancelReason: row.cancel_reason ?? null,
    notes: row.notes ?? null,
    itemsCount: Number(row.items_count ?? 0),
    quantityOrdered: Number(row.quantity_ordered ?? 0),
    quantityDelivered: Number(row.quantity_delivered ?? 0),
    isCancelled: row.deleted_at != null || row.status === 'cancelled',
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

/**
 * Normalise une ligne de commande en objet applicatif.
 *
 * ⚠️ **Cette fonction reçoit deux formes différentes**, exactement comme
 * `mapPaymentRow` de `lib/payments.ts` :
 *  - un objet **Drizzle** (`db.select().from(brickOrderItems)`), en camelCase ;
 *  - une ligne de **SQL brut**, en snake_case.
 *
 * En ne lisant qu'une des deux, `product_id` ressortait `null` et la
 * facturation échouait sur « Ligne 1 : le produit est obligatoire » — bug
 * constaté en vérification. On lit donc les deux.
 */
function mapItemRow(row: any): BrickOrderItemRow {
  const pick = <T>(camel: string, snake: string): T => (row[camel] ?? row[snake]) as T;

  return {
    id: Number(pick('id', 'id')),
    orderId: Number(pick('orderId', 'order_id') ?? 0) || 0,
    brickTypeId:
      pick('brickTypeId', 'brick_type_id') == null ? null : Number(pick('brickTypeId', 'brick_type_id')),
    productId: pick('productId', 'product_id') == null ? null : Number(pick('productId', 'product_id')),
    productName: String(pick('productName', 'product_name') ?? ''),
    unit: String(pick('unit', 'unit') ?? 'pièce'),
    quantity: Number(pick('quantity', 'quantity') ?? 0),
    unitPrice: Number(pick('unitPrice', 'unit_price') ?? 0),
    discount: Number(pick('discount', 'discount') ?? 0),
    amount: Number(pick('amount', 'amount') ?? 0),
    deliveredQuantity: Number(pick('deliveredQuantity', 'delivered_quantity') ?? 0),
  };
}

/** Client : fiche existante, sinon nom libre (vente comptoir possible). */
async function resolveCustomer(
  customerId: number | null,
  customerName: string | null,
): Promise<{ customerId: number | null; customerName: string }> {
  if (customerId) {
    const row = await rawGet<{ id: number; name: string }>('SELECT id, name FROM customers WHERE id = ?', [
      customerId,
    ]);
    if (!row) throw new NotFoundError('Client introuvable');
    return { customerId: Number(row.id), customerName: row.name };
  }

  const name = (customerName ?? '').trim();
  if (!name) throw new ValidationError('Le client est obligatoire');

  // Rapprochement par nom : la commande se rattache à la fiche si elle existe.
  const existing = await rawGet<{ id: number; name: string }>(
    'SELECT id, name FROM customers WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1',
    [name],
  );

  return existing
    ? { customerId: Number(existing.id), customerName: existing.name }
    : { customerId: null, customerName: name };
}

/**
 * Construit les lignes validées : le **produit lié** au type de brique est
 * résolu ici (il porte le stock et le prix de vente), et l'instantané du nom et
 * de l'unité est posé sur la ligne — une commande doit rester imprimable même si
 * le type est renommé (§6.5 règle 5).
 */
async function buildItems(items: BrickOrderItemInput[]) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('Une commande doit contenir au moins un produit');
  }

  const rows = await rawAll<{
    id: number;
    name: string;
    product_id: number;
    product_name: string;
    unit: string;
    sale_price: number;
  }>(
    `SELECT bt.id, bt.name, bt.product_id, p.name AS product_name, p.unit, p.sale_price
     FROM brick_types bt
     INNER JOIN products p ON p.id = bt.product_id`,
  );

  const byTypeId = new Map(rows.map((row) => [Number(row.id), row]));
  const built = [];

  for (const line of items) {
    const brickTypeId = Number(line.brickTypeId);
    const type = byTypeId.get(brickTypeId);
    if (!type) throw new NotFoundError(`Type de brique introuvable (id ${brickTypeId})`);

    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ValidationError(`Quantité invalide pour « ${type.name} » : elle doit être positive`);
    }

    const unitPrice = roundMoney(Number(line.unitPrice) || 0);
    if (unitPrice < 0) {
      throw new ValidationError(`Prix unitaire négatif pour « ${type.name} »`);
    }

    const gross = roundMoney(quantity * unitPrice);
    const discount = Math.min(Math.max(roundMoney(Number(line.discount) || 0), 0), gross);

    built.push({
      brickTypeId,
      productId: Number(type.product_id),
      productName: type.product_name,
      unit: type.unit,
      quantity,
      unitPrice,
      discount,
      amount: roundMoney(gross - discount),
    });
  }

  return built;
}

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

export async function listBrickOrders(
  options: BrickOrderListOptions = {},
): Promise<{ data: BrickOrderRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  // Une commande annulée reste consultable mais sort des listes par défaut.
  const where: string[] = ['o.deleted_at IS NULL'];
  const args: (string | number)[] = [];

  if (options.search) {
    where.push('(o.order_number LIKE ? OR o.customer_name LIKE ? OR o.notes LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
  }
  if (isBrickOrderStatus(options.status)) {
    where.push('o.status = ?');
    args.push(options.status);
  }
  if (options.customerId) {
    where.push('o.customer_id = ?');
    args.push(Number(options.customerId));
  }
  if (options.from) {
    where.push('o.date >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('o.date <= ?');
    args.push(options.to);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = await rawAll<any>(
    `${ORDER_SELECT} ${whereSql} ORDER BY o.date DESC, o.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM brick_orders o ${whereSql}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapOrderRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/** Compteurs par statut — alimente le tableau de bord (§20, « commandes »). */
export async function countBrickOrdersByStatus(): Promise<Record<BrickOrderStatus, number>> {
  const rows = await rawAll<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM brick_orders WHERE deleted_at IS NULL GROUP BY status`,
  );

  const result = Object.fromEntries(
    BRICK_ORDER_STATUSES.map((status) => [status, 0]),
  ) as Record<BrickOrderStatus, number>;

  for (const row of rows) {
    if (isBrickOrderStatus(row.status)) result[row.status] = Number(row.count ?? 0);
  }
  return result;
}

export async function getBrickOrder(id: number): Promise<BrickOrderDetail | null> {
  const row = await rawGet<any>(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
  if (!row) return null;

  const itemRows = await db
    .select()
    .from(brickOrderItems)
    .where(eq(brickOrderItems.orderId, id));

  const payments = await listPayments({ type: 'brick_order', referenceId: id, limit: 200 });
  const schedule = await getPaymentSchedule('brick_order', id);

  return {
    order: mapOrderRow(row),
    items: itemRows.map(mapItemRow),
    payments: payments.data,
    schedule,
  };
}

export async function getBrickOrderRow(id: number): Promise<BrickOrderRow | null> {
  const row = await rawGet<any>(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
  return row ? mapOrderRow(row) : null;
}

/* ------------------------------------------------------------------ *
 * Écriture
 * ------------------------------------------------------------------ */

export async function createBrickOrder(input: BrickOrderInput): Promise<BrickOrderDetail> {
  const items = await buildItems(input.items);
  const customer = await resolveCustomer(
    input.customerId ? Number(input.customerId) : null,
    input.customerName ?? null,
  );

  const date = cleanDate(input.date, 'date') ?? today();
  const status: BrickOrderStatus =
    input.status === 'confirmed' ? 'confirmed' : input.status === 'draft' ? 'draft' : 'draft';

  const totals = computeOrderTotals(items, Number(input.discount) || 0);
  const orderNumber = await nextDocumentNumber('brick_order');

  const inserted = await db
    .insert(brickOrders)
    .values({
      orderNumber,
      customerId: customer.customerId,
      customerName: customer.customerName,
      userId: input.userId ?? null,
      date,
      dueDate: cleanDate(input.dueDate, 'échéance'),
      promisedDate: cleanDate(input.promisedDate, 'date promise'),
      subTotal: totals.subTotal,
      discount: totals.discount,
      total: totals.total,
      amountPaid: 0,
      remainingAmount: totals.total,
      paymentStatus: 'unpaid',
      status,
      notes: text(input.notes),
    })
    .returning({ id: brickOrders.id, syncId: brickOrders.syncId });

  const orderId = Number(inserted[0].id);

  await enqueueSyncWrite('brick_orders', inserted[0]?.syncId, 'insert', {
    order_number: orderNumber,
    customer_name: customer.customerName,
    date,
    total: totals.total,
    status,
  });

  await insertItems(orderId, orderNumber, items);

  const created = await getBrickOrder(orderId);
  if (!created) throw new Error('Commande créée mais introuvable');
  return created;
}

export function computeOrderTotals(
  items: { amount: number }[],
  globalDiscount: number,
): { subTotal: number; discount: number; total: number } {
  const subTotal = roundMoney(items.reduce((sum, item) => sum + item.amount, 0));
  const discount = Math.min(Math.max(roundMoney(globalDiscount), 0), subTotal);
  return { subTotal, discount, total: roundMoney(subTotal - discount) };
}

async function insertItems(
  orderId: number,
  orderNumber: string,
  items: Awaited<ReturnType<typeof buildItems>>,
): Promise<void> {
  for (const item of items) {
    const inserted = await db
      .insert(brickOrderItems)
      .values({
        orderId,
        brickTypeId: item.brickTypeId,
        productId: item.productId,
        productName: item.productName,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        amount: item.amount,
        deliveredQuantity: 0,
      })
      .returning({ id: brickOrderItems.id, syncId: brickOrderItems.syncId });

    await enqueueSyncWrite('brick_order_items', inserted[0]?.syncId, 'insert', {
      order_number: orderNumber,
      product_name: item.productName,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      amount: item.amount,
    });
  }
}

function assertOrderEditable(order: BrickOrderRow): void {
  if (order.isCancelled) {
    throw new ConflictError('Cette commande est annulée : elle n’accepte plus aucune modification.');
  }
  if (order.status === 'delivered') {
    throw new ConflictError(
      'Cette commande est livrée : on ne la modifie plus. Corrigez la facture de vente si nécessaire.',
    );
  }
  if (order.salesInvoiceId) {
    throw new ConflictError(
      `Cette commande a déjà été facturée (${order.salesInvoiceNumber ?? 'facture'}). Modifiez la facture, pas la commande.`,
    );
  }
}

/** Modification : les lignes sont **remplacées**, les paiements ne bougent pas. */
export async function updateBrickOrder(id: number, input: BrickOrderInput): Promise<BrickOrderDetail> {
  const existing = await getBrickOrderRow(id);
  if (!existing) throw new NotFoundError('Commande introuvable');
  assertOrderEditable(existing);

  const items = await buildItems(input.items);
  const customer =
    input.customerId || input.customerName
      ? await resolveCustomer(
          input.customerId ? Number(input.customerId) : null,
          input.customerName ?? existing.customerName,
        )
      : { customerId: existing.customerId, customerName: existing.customerName };

  const totals = computeOrderTotals(items, Number(input.discount) || 0);

  await db
    .update(brickOrders)
    .set({
      customerId: customer.customerId,
      customerName: customer.customerName,
      date: cleanDate(input.date, 'date') ?? existing.date,
      dueDate: cleanDate(input.dueDate, 'échéance'),
      promisedDate: cleanDate(input.promisedDate, 'date promise'),
      subTotal: totals.subTotal,
      discount: totals.discount,
      total: totals.total,
      notes: text(input.notes),
      updatedAt: new Date(),
    })
    .where(eq(brickOrders.id, id));

  await db.delete(brickOrderItems).where(eq(brickOrderItems.orderId, id));
  await insertItems(id, existing.orderNumber, items);

  // Le total a pu changer : le reste à payer se recalcule depuis les paiements
  // réels, jamais depuis l'ancien reste.
  await recomputeDocumentPayments('brick_order', id);

  await enqueueSyncWrite('brick_orders', null, 'update', {
    order_number: existing.orderNumber,
    customer_name: customer.customerName,
    total: totals.total,
  });

  const result = await getBrickOrder(id);
  if (!result) throw new NotFoundError('Commande introuvable après modification');
  return result;
}

/** Changement d'état, avec transitions contrôlées. */
export async function updateBrickOrderStatus(
  id: number,
  status: BrickOrderStatus,
): Promise<BrickOrderRow> {
  if (!isBrickOrderStatus(status)) throw new ValidationError('Statut de commande invalide');

  const order = await getBrickOrderRow(id);
  if (!order) throw new NotFoundError('Commande introuvable');
  if (order.isCancelled) throw new ConflictError('Cette commande est déjà annulée');

  const allowed = STATUS_TRANSITIONS[order.status];
  if (!allowed.includes(status)) {
    throw new ValidationError(
      `Passage impossible de « ${BRICK_ORDER_STATUS_LABELS[order.status]} » à « ${BRICK_ORDER_STATUS_LABELS[status]} ».`,
    );
  }

  await db
    .update(brickOrders)
    .set({ status, updatedAt: new Date() })
    .where(eq(brickOrders.id, id));

  await enqueueSyncWrite('brick_orders', null, 'update', {
    order_number: order.orderNumber,
    status,
  });

  const result = await getBrickOrderRow(id);
  if (!result) throw new NotFoundError('Commande introuvable');
  return result;
}

/**
 * Enregistre une **livraison**. Aucun mouvement de stock ici : c'est la facture
 * qui sort le stock (choix de workflow documenté en tête de fichier). La
 * livraison ne fait que constater ce qui est parti chez le client.
 */
export async function registerBrickOrderDelivery(
  id: number,
  deliveries: { itemId: number; quantity: number }[],
): Promise<BrickOrderDetail> {
  const order = await getBrickOrderRow(id);
  if (!order) throw new NotFoundError('Commande introuvable');
  if (order.isCancelled) throw new ConflictError('Cette commande est annulée');

  if (!['ready', 'partially_delivered'].includes(order.status)) {
    throw new ValidationError(
      'Une livraison ne s’enregistre que sur une commande « Prête » ou « Partiellement livrée ».',
    );
  }

  const rows = await db.select().from(brickOrderItems).where(eq(brickOrderItems.orderId, id));
  const byId = new Map(rows.map((row) => [row.id, row]));

  if (!Array.isArray(deliveries) || deliveries.length === 0) {
    throw new ValidationError('Indiquez au moins une quantité livrée');
  }

  for (const delivery of deliveries) {
    const line = byId.get(Number(delivery.itemId));
    if (!line) throw new NotFoundError('Ligne de commande introuvable');

    const quantity = Number(delivery.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new ValidationError('Quantité livrée invalide');
    }

    const nextDelivered = roundMoney(Number(line.deliveredQuantity) + quantity);
    if (nextDelivered > Number(line.quantity) + 0.001) {
      throw new ValidationError(
        `« ${line.productName} » : la quantité livrée (${nextDelivered}) dépasse la quantité commandée (${Number(line.quantity)}).`,
      );
    }

    if (quantity > 0) {
      await db
        .update(brickOrderItems)
        .set({ deliveredQuantity: nextDelivered, updatedAt: new Date() })
        .where(eq(brickOrderItems.id, line.id));

      await enqueueSyncWrite('brick_order_items', line.syncId, 'update', {
        delivered_quantity: nextDelivered,
      });
    }
  }

  // Le statut découle des quantités : « livrée » seulement si tout est parti.
  const refreshed = await db.select().from(brickOrderItems).where(eq(brickOrderItems.orderId, id));
  const fullyDelivered = refreshed.every(
    (row) => Number(row.deliveredQuantity) >= Number(row.quantity) - 0.001,
  );
  const anyDelivered = refreshed.some((row) => Number(row.deliveredQuantity) > 0);

  const nextStatus: BrickOrderStatus = fullyDelivered
    ? 'delivered'
    : anyDelivered
      ? 'partially_delivered'
      : order.status;

  await db
    .update(brickOrders)
    .set({
      status: nextStatus,
      deliveryDate: fullyDelivered ? today() : order.deliveryDate,
      updatedAt: new Date(),
    })
    .where(eq(brickOrders.id, id));

  const result = await getBrickOrder(id);
  if (!result) throw new NotFoundError('Commande introuvable');
  return result;
}

/** Annulation motivée — jamais de suppression (§7). */
export async function cancelBrickOrder(
  id: number,
  reason: string,
  user?: { id?: number | null; name?: string | null } | null,
): Promise<BrickOrderRow> {
  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire');

  const order = await getBrickOrderRow(id);
  if (!order) throw new NotFoundError('Commande introuvable');
  if (order.isCancelled) throw new ConflictError('Cette commande est déjà annulée');
  if (order.salesInvoiceId) {
    throw new ConflictError(
      'Cette commande a été facturée : annulez d’abord la facture de vente, puis la commande.',
    );
  }

  const now = new Date();
  await db
    .update(brickOrders)
    .set({
      status: 'cancelled',
      cancelReason: motif,
      cancelledAt: now,
      cancelledBy: user?.id ?? null,
      deletedAt: now,
      updatedAt: now,
    })
    .where(eq(brickOrders.id, id));

  await enqueueSyncWrite('brick_orders', null, 'delete', {
    order_number: order.orderNumber,
    cancel_reason: motif,
    cancelled_by: user?.id ?? null,
    deleted_at: now.toISOString(),
  });

  const result = await getBrickOrderRow(id);
  if (!result) throw new NotFoundError('Commande introuvable');
  return result;
}

/**
 * Ajoute un encaissement (acompte, solde) sur la commande.
 *
 * Le paiement porte `type = 'brick_order'` : reçu numéroté, entrée en caisse,
 * reste à payer recalculé par `lib/payments.ts`.
 */
export async function addBrickOrderPayment(
  id: number,
  input: {
    amount: number;
    paymentMethod?: string;
    date?: string;
    notes?: string | null;
    userId?: number | null;
  },
): Promise<void> {
  const order = await getBrickOrderRow(id);
  if (!order) throw new NotFoundError('Commande introuvable');

  await createPayment({
    type: 'brick_order',
    referenceId: id,
    amount: input.amount,
    paymentMethod: input.paymentMethod,
    date: input.date,
    notes: input.notes ?? `Encaissement commande ${order.orderNumber}`,
    userId: input.userId ?? null,
  });
}

/**
 * **Facture la commande** : crée une vente du canal `brick` avec ses lignes,
 * puis **transfère** les acomptes déjà encaissés sur la facture.
 *
 * Le transfert consiste à repointer les lignes de `payments` (`brick_order` →
 * `sale`, `reference_id` = facture). Rien n'est recréé : le numéro de reçu et le
 * mouvement de caisse restent ceux d'origine, et le chiffre d'affaires n'est
 * compté qu'une fois — sur la facture.
 */
export async function invoiceBrickOrder(
  id: number,
  user?: { id?: number | null } | null,
): Promise<{ order: BrickOrderRow; invoiceId: number; invoiceNumber: string }> {
  const detail = await getBrickOrder(id);
  if (!detail) throw new NotFoundError('Commande introuvable');

  const { order, items } = detail;
  if (order.isCancelled) throw new ConflictError('Cette commande est annulée');
  if (order.salesInvoiceId) {
    throw new ConflictError(`Cette commande est déjà facturée (${order.salesInvoiceNumber}).`);
  }
  if (order.status === 'draft') {
    throw new ValidationError('Confirmez la commande avant de la facturer.');
  }

  const invoice = await createSalesInvoice({
    customerId: order.customerId,
    customerName: order.customerName,
    date: order.date,
    dueDate: order.dueDate,
    paymentMethod: 'Espèces',
    // Aucun encaissement immédiat : l'acompte éventuel est **transféré** juste
    // après, ce qui évite de créer deux reçus pour le même argent.
    amountPaid: 0,
    discount: order.discount,
    taxRate: 0,
    notes: text(`Commande ${order.orderNumber}${order.notes ? ` — ${order.notes}` : ''}`),
    status: 'active',
    channel: 'brick',
    userId: user?.id ?? null,
    lines: items.map((item) => ({
      productId: Number(item.productId),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount,
    })),
  });

  // Transfert des acomptes : mêmes reçus, même caisse, nouveau document.
  const transferred = await rawGet<{ total: number | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
     WHERE type = 'brick_order' AND reference_id = ?`,
    [id],
  );

  if (Number(transferred?.total ?? 0) > 0) {
    await rawRun(
      `UPDATE payments SET type = 'sale', reference_id = ?, updated_at = ? WHERE type = 'brick_order' AND reference_id = ?`,
      [invoice.id, Date.now(), id],
    );
    await recomputeDocumentPayments('sale', invoice.id);
  }

  await db
    .update(brickOrders)
    .set({
      salesInvoiceId: invoice.id,
      status: 'delivered',
      deliveryDate: order.deliveryDate ?? today(),
      amountPaid: 0,
      remainingAmount: 0,
      paymentStatus: 'unpaid',
      updatedAt: new Date(),
    })
    .where(eq(brickOrders.id, id));

  // La commande n'est plus un document encaissable : ses compteurs repassent à
  // zéro puisque l'argent est désormais rattaché à la facture.
  await enqueueSyncWrite('brick_orders', null, 'update', {
    order_number: order.orderNumber,
    sales_invoice_id: invoice.id,
    status: 'delivered',
    transferred_deposits: Number(transferred?.total ?? 0),
  });

  const updated = await getBrickOrderRow(id);
  if (!updated) throw new NotFoundError('Commande introuvable');

  return { order: updated, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber };
}
