/**
 * Commandes clients de briques, par magasin (README §30).
 *
 * Une commande est un **engagement commercial** (client, types de briques,
 * quantités, prix, remise, livraison promise). Elle suit son cycle (`draft` →
 * `confirmed` → `in_production` → `ready` → `partially_delivered` →
 * `delivered`, ou `cancelled`) et se **facture** : la facture de vente du
 * canal `brick` est le seul document qui sort le stock et fait le chiffre
 * d'affaires. La commande, elle, ne touche jamais le stock.
 *
 * L'acompte est un `payments` de type `brick_order` (reçu, caisse, reste
 * recalculé). À la facturation, ces paiements sont **transférés** sur la
 * facture (même reçu, même mouvement de caisse) : l'argent n'est jamais compté
 * deux fois.
 *
 * v2 : la commande appartient au magasin actif, son client aussi
 * (`assertCustomerInStore`), ses lignes sont des types de briques de ce magasin.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { and, eq } from 'drizzle-orm';
import { brickOrderItems, brickOrders, payments } from '@/db/schema';
import { nextDocumentNumber } from '@/lib/settings';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api';
import { roundMoney, today } from '@/lib/format';
import { listPayments, recomputeDocumentPayments, getPaymentSchedule } from '@/lib/payments';
import { createSalesInvoice } from '@/lib/sales';
import { assertCustomerInStore } from '@/lib/customers';
import { scopeSql, type StoreScope } from '@/lib/stores';

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

/** Transitions autorisées — la règle vit ici, l'API la subit aussi. */
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
  storeId: number;
  storeName: string | null;
  orderNumber: string;
  customerId: number | null;
  customerName: string;
  userId: number | null;
  userName: string | null;
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
  cancelledByName: string | null;
  notes: string | null;
  itemsCount: number;
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

export type BrickOrderItemInput = { brickTypeId: number; quantity: number; unitPrice: number; discount?: number };

export type BrickOrderInput = {
  customerId?: number | null;
  customerName?: string | null;
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
  scope: StoreScope;
  search?: string;
  status?: string;
  customerId?: number;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  includeCancelled?: boolean;
};

function cleanDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ValidationError(`La ${label} doit être au format AAAA-MM-JJ`);
  return text;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const ORDER_SELECT = `
  SELECT o.id, o.store_id, s.name AS store_name, o.order_number, o.customer_id, o.customer_name,
         o.user_id, u.name AS user_name, o.date, o.due_date, o.delivery_date, o.promised_date,
         o.sub_total, o.discount, o.total, o.amount_paid, o.remaining_amount, o.payment_status,
         o.status, o.sales_invoice_id, o.cancel_reason, cu.name AS cancelled_by_name, o.notes, o.created_at,
         v.invoice_number AS sales_invoice_number,
         (SELECT COUNT(*) FROM brick_order_items i WHERE i.order_id = o.id) AS items_count,
         (SELECT COALESCE(SUM(i.quantity), 0) FROM brick_order_items i WHERE i.order_id = o.id) AS quantity_ordered,
         (SELECT COALESCE(SUM(i.delivered_quantity), 0) FROM brick_order_items i WHERE i.order_id = o.id) AS quantity_delivered
  FROM brick_orders o
  LEFT JOIN stores s ON s.id = o.store_id
  LEFT JOIN users u ON u.id = o.user_id
  LEFT JOIN users cu ON cu.id = o.cancelled_by
  LEFT JOIN sales_invoices v ON v.id = o.sales_invoice_id`;

function mapOrderRow(row: any): BrickOrderRow {
  return {
    id: num(row.id),
    storeId: num(row.store_id),
    storeName: row.store_name ?? null,
    orderNumber: row.order_number,
    customerId: row.customer_id == null ? null : num(row.customer_id),
    customerName: row.customer_name,
    userId: row.user_id == null ? null : num(row.user_id),
    userName: row.user_name ?? null,
    date: row.date,
    dueDate: row.due_date ?? null,
    deliveryDate: row.delivery_date ?? null,
    promisedDate: row.promised_date ?? null,
    subTotal: num(row.sub_total),
    discount: num(row.discount),
    total: num(row.total),
    amountPaid: num(row.amount_paid),
    remainingAmount: num(row.remaining_amount),
    paymentStatus: row.payment_status ?? 'unpaid',
    status: isBrickOrderStatus(row.status) ? row.status : 'draft',
    salesInvoiceId: row.sales_invoice_id == null ? null : num(row.sales_invoice_id),
    salesInvoiceNumber: row.sales_invoice_number ?? null,
    cancelReason: row.cancel_reason ?? null,
    cancelledByName: row.cancelled_by_name ?? null,
    notes: row.notes ?? null,
    itemsCount: num(row.items_count),
    quantityOrdered: num(row.quantity_ordered),
    quantityDelivered: num(row.quantity_delivered),
    isCancelled: row.status === 'cancelled',
    createdAt: row.created_at ? new Date(num(row.created_at) * 1000) : null,
  };
}

function mapItemRow(row: any): BrickOrderItemRow {
  return {
    id: num(row.id),
    orderId: num(row.order_id),
    brickTypeId: row.brick_type_id == null ? null : num(row.brick_type_id),
    productId: row.product_id == null ? null : num(row.product_id),
    productName: String(row.product_name ?? ''),
    unit: String(row.unit ?? 'pièce'),
    quantity: num(row.quantity),
    unitPrice: num(row.unit_price),
    discount: num(row.discount),
    amount: num(row.amount),
    deliveredQuantity: num(row.delivered_quantity),
  };
}

async function listItems(orderId: number): Promise<BrickOrderItemRow[]> {
  const rows = await rawAll<any>('SELECT * FROM brick_order_items WHERE order_id = ? ORDER BY id', [orderId]);
  return rows.map(mapItemRow);
}

/** Client du magasin (fiche), sinon nom libre (client de passage). */
async function resolveCustomer(
  customerId: number | null,
  customerName: string | null,
  storeId: number,
): Promise<{ customerId: number | null; customerName: string }> {
  if (customerId) {
    const customer = await assertCustomerInStore(customerId, storeId);
    return { customerId: customer.id, customerName: customer.name };
  }
  const name = (customerName ?? '').trim();
  if (!name) throw new ValidationError('Le client est obligatoire');
  // Rapprochement par nom, **dans ce magasin** (chaque magasin a ses clients).
  const existing = await rawGet<{ id: number; name: string }>(
    'SELECT id, name FROM customers WHERE store_id = ? AND lower(trim(name)) = lower(trim(?)) LIMIT 1',
    [storeId, name],
  );
  return existing ? { customerId: num(existing.id), customerName: existing.name } : { customerId: null, customerName: name };
}

/** Lignes validées : types de briques **actifs de ce magasin**, nom et unité figés. */
async function buildItems(items: BrickOrderItemInput[], storeId: number) {
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('Une commande doit contenir au moins un produit');
  const rows = await rawAll<{ id: number; name: string; product_id: number; product_name: string; unit: string; is_active: number }>(
    `SELECT bt.id, bt.name, bt.product_id, bt.is_active, p.name AS product_name, p.unit
       FROM brick_types bt INNER JOIN products p ON p.id = bt.product_id
      WHERE bt.store_id = ?`,
    [storeId],
  );
  const byTypeId = new Map(rows.map((row) => [num(row.id), row]));
  return items.map((line) => {
    const brickTypeId = Number(line.brickTypeId);
    const type = byTypeId.get(brickTypeId);
    if (!type) throw new ValidationError(`Type de brique introuvable dans ce magasin (id ${brickTypeId})`);
    if (!type.is_active) throw new ValidationError(`Le type « ${type.name} » est désactivé.`);
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ValidationError(`Quantité invalide pour « ${type.name} » : elle doit être positive`);
    }
    const unitPrice = roundMoney(num(line.unitPrice));
    if (unitPrice < 0) throw new ValidationError(`Prix unitaire négatif pour « ${type.name} »`);
    const gross = roundMoney(quantity * unitPrice);
    const discount = Math.min(Math.max(roundMoney(num(line.discount)), 0), gross);
    return {
      brickTypeId,
      productId: num(type.product_id),
      productName: type.product_name,
      unit: type.unit,
      quantity,
      unitPrice,
      discount,
      amount: roundMoney(gross - discount),
    };
  });
}

/** Lignes reçues d'un corps de requête (la validation métier est dans `buildItems`). */
export function readOrderItems(body: any): BrickOrderItemInput[] {
  const raw = Array.isArray(body?.items) ? body.items : [];
  return raw.map((item: any) => ({
    brickTypeId: Math.trunc(num(item?.brickTypeId)),
    quantity: num(item?.quantity),
    unitPrice: num(item?.unitPrice),
    discount: num(item?.discount),
  }));
}

export function computeOrderTotals(items: { amount: number }[], globalDiscount: number) {
  const subTotal = roundMoney(items.reduce((sum, item) => sum + item.amount, 0));
  const discount = Math.min(Math.max(roundMoney(globalDiscount), 0), subTotal);
  return { subTotal, discount, total: roundMoney(subTotal - discount) };
}

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

export async function listBrickOrders(
  options: BrickOrderListOptions,
): Promise<{ data: BrickOrderRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const where: string[] = [scopeSql('o.store_id', options.scope)];
  const args: (string | number)[] = [];
  if (isBrickOrderStatus(options.status)) {
    where.push('o.status = ?');
    args.push(options.status);
  } else if (!options.includeCancelled) {
    // Une commande annulée reste consultable mais sort des listes par défaut.
    where.push(`o.status <> 'cancelled'`);
  }
  if (options.search) {
    where.push('(o.order_number LIKE ? OR o.customer_name LIKE ? OR o.notes LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
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
  const rows = await rawAll<any>(`${ORDER_SELECT} ${whereSql} ORDER BY o.date DESC, o.id DESC LIMIT ? OFFSET ?`, [
    ...args,
    limit,
    (page - 1) * limit,
  ]);
  const count = await rawGet<{ total: number }>(`SELECT COUNT(*) AS total FROM brick_orders o ${whereSql}`, args);
  const total = num(count?.total);
  return { data: rows.map(mapOrderRow), total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

export async function countBrickOrdersByStatus(scope: StoreScope): Promise<Record<BrickOrderStatus, number>> {
  const rows = await rawAll<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM brick_orders WHERE ${scopeSql('store_id', scope)} GROUP BY status`,
  );
  const result = Object.fromEntries(BRICK_ORDER_STATUSES.map((status) => [status, 0])) as Record<BrickOrderStatus, number>;
  for (const row of rows) if (isBrickOrderStatus(row.status)) result[row.status] = num(row.count);
  return result;
}

export async function getBrickOrderRow(id: number): Promise<BrickOrderRow | null> {
  const row = await rawGet<any>(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
  return row ? mapOrderRow(row) : null;
}

export async function getBrickOrder(id: number): Promise<BrickOrderDetail | null> {
  const order = await getBrickOrderRow(id);
  if (!order) return null;
  const [items, paymentList, schedule] = await Promise.all([
    listItems(id),
    listPayments({ scope: [order.storeId], type: 'brick_order', referenceId: id, limit: 200 }),
    getPaymentSchedule('brick_order', id),
  ]);
  return { order, items, payments: paymentList.data, schedule };
}

/* ------------------------------------------------------------------ *
 * Écriture (magasin actif uniquement)
 * ------------------------------------------------------------------ */

async function assertOrderInStore(id: number, storeId: number): Promise<BrickOrderRow> {
  const order = await getBrickOrderRow(id);
  if (!order) throw new NotFoundError('Commande introuvable');
  if (order.storeId !== Number(storeId)) {
    throw new ValidationError(
      `Cette commande appartient au magasin ${order.storeName ?? 'd’un autre magasin'} : elle ne se modifie que depuis ce magasin.`,
    );
  }
  return order;
}

function assertOrderEditable(order: BrickOrderRow): void {
  if (order.isCancelled) throw new ConflictError('Cette commande est annulée : elle n’accepte plus aucune modification.');
  if (order.status === 'delivered') {
    throw new ConflictError('Cette commande est livrée : on ne la modifie plus. Corrigez la facture de vente si nécessaire.');
  }
  if (order.salesInvoiceId) {
    throw new ConflictError(
      `Cette commande a déjà été facturée (${order.salesInvoiceNumber ?? 'facture'}). Modifiez la facture, pas la commande.`,
    );
  }
}

async function insertItems(orderId: number, items: Awaited<ReturnType<typeof buildItems>>): Promise<void> {
  for (const item of items) {
    await db.insert(brickOrderItems).values({ orderId, ...item, deliveredQuantity: 0 });
  }
}

export async function createBrickOrder(input: BrickOrderInput & { storeId: number }): Promise<BrickOrderDetail> {
  const orderId = await withTransaction(async () => {
    const items = await buildItems(input.items, input.storeId);
    const customer = await resolveCustomer(input.customerId ? Number(input.customerId) : null, input.customerName ?? null, input.storeId);
    const date = cleanDate(input.date, 'date') ?? today();
    const totals = computeOrderTotals(items, num(input.discount));
    const inserted = await db
      .insert(brickOrders)
      .values({
        storeId: input.storeId,
        orderNumber: await nextDocumentNumber('brick_order', input.storeId),
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
        status: input.status === 'confirmed' ? 'confirmed' : 'draft',
        notes: text(input.notes),
      })
      .returning({ id: brickOrders.id });
    const id = num(inserted[0].id);
    await insertItems(id, items);
    return id;
  });
  const created = await getBrickOrder(orderId);
  if (!created) throw new Error('Commande créée mais introuvable');
  return created;
}

/** Modification : les lignes sont **remplacées**, les paiements ne bougent pas. */
export async function updateBrickOrder(id: number, input: BrickOrderInput, storeId: number): Promise<BrickOrderDetail> {
  await withTransaction(async () => {
    const existing = await assertOrderInStore(id, storeId);
    assertOrderEditable(existing);
    const items = await buildItems(input.items, storeId);
    const customer =
      input.customerId || input.customerName
        ? await resolveCustomer(input.customerId ? Number(input.customerId) : null, input.customerName ?? existing.customerName, storeId)
        : { customerId: existing.customerId, customerName: existing.customerName };
    const totals = computeOrderTotals(items, num(input.discount));
    // Le montant ne descend jamais sous ce que le client a déjà payé.
    if (totals.total + 0.01 < existing.amountPaid) {
      throw new ConflictError(
        `Le client a déjà payé ${existing.amountPaid.toLocaleString('fr-FR')} : le total de la commande ne peut pas descendre en dessous.`,
      );
    }
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
    await insertItems(id, items);
    await recomputeDocumentPayments('brick_order', id);
  });
  const result = await getBrickOrder(id);
  if (!result) throw new NotFoundError('Commande introuvable après modification');
  return result;
}

/** Changement d'état, avec transitions contrôlées (l'annulation passe par `cancelBrickOrder`). */
export async function updateBrickOrderStatus(id: number, status: BrickOrderStatus, storeId: number): Promise<BrickOrderRow> {
  if (!isBrickOrderStatus(status)) throw new ValidationError('Statut de commande invalide');
  if (status === 'cancelled') throw new ValidationError('L’annulation exige un motif : utilisez « Annuler la commande ».');
  const order = await assertOrderInStore(id, storeId);
  if (order.isCancelled) throw new ConflictError('Cette commande est déjà annulée');
  if (!STATUS_TRANSITIONS[order.status].includes(status)) {
    throw new ValidationError(
      `Passage impossible de « ${BRICK_ORDER_STATUS_LABELS[order.status]} » à « ${BRICK_ORDER_STATUS_LABELS[status]} ».`,
    );
  }
  await db
    .update(brickOrders)
    .set({ status, deliveryDate: status === 'delivered' ? (order.deliveryDate ?? today()) : order.deliveryDate, updatedAt: new Date() })
    .where(eq(brickOrders.id, id));
  const result = await getBrickOrderRow(id);
  if (!result) throw new NotFoundError('Commande introuvable');
  return result;
}

/**
 * Enregistre une **livraison** (constat de ce qui est parti chez le client).
 * Aucun mouvement de stock ici : c'est la facture qui sort le stock.
 */
export async function registerBrickOrderDelivery(
  id: number,
  deliveries: { itemId: number; quantity: number }[],
  storeId: number,
): Promise<BrickOrderDetail> {
  await withTransaction(async () => {
    const order = await assertOrderInStore(id, storeId);
    if (order.isCancelled) throw new ConflictError('Cette commande est annulée');
    if (!['ready', 'partially_delivered'].includes(order.status)) {
      throw new ValidationError('Une livraison ne s’enregistre que sur une commande « Prête » ou « Partiellement livrée ».');
    }
    if (!Array.isArray(deliveries) || deliveries.length === 0) throw new ValidationError('Indiquez au moins une quantité livrée');
    const lines = await listItems(id);
    const byId = new Map(lines.map((line) => [line.id, line]));
    let any = false;
    for (const delivery of deliveries) {
      const line = byId.get(Number(delivery.itemId));
      if (!line) throw new NotFoundError('Ligne de commande introuvable');
      const quantity = Number(delivery.quantity);
      if (!Number.isFinite(quantity) || quantity < 0) throw new ValidationError('Quantité livrée invalide');
      const next = roundMoney(line.deliveredQuantity + quantity);
      if (next > line.quantity + 0.001) {
        throw new ValidationError(`« ${line.productName} » : la quantité livrée (${next}) dépasse la quantité commandée (${line.quantity}).`);
      }
      if (quantity > 0) {
        any = true;
        await db.update(brickOrderItems).set({ deliveredQuantity: next, updatedAt: new Date() }).where(eq(brickOrderItems.id, line.id));
      }
    }
    if (!any) throw new ValidationError('Indiquez au moins une quantité livrée supérieure à zéro');
    const refreshed = await listItems(id);
    const fully = refreshed.every((row) => row.deliveredQuantity >= row.quantity - 0.001);
    await db
      .update(brickOrders)
      .set({ status: fully ? 'delivered' : 'partially_delivered', deliveryDate: fully ? today() : order.deliveryDate, updatedAt: new Date() })
      .where(eq(brickOrders.id, id));
  });
  const result = await getBrickOrder(id);
  if (!result) throw new NotFoundError('Commande introuvable');
  return result;
}

/** Annulation motivée — jamais de suppression. Refusée si la commande est facturée ou a reçu un acompte. */
export async function cancelBrickOrder(id: number, reason: string, user: { id: number; storeId: number }): Promise<BrickOrderRow> {
  const motif = (reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire');
  const order = await assertOrderInStore(id, user.storeId);
  if (order.isCancelled) throw new ConflictError('Cette commande est déjà annulée');
  if (order.salesInvoiceId) {
    const invoice = await rawGet<{ status: string }>('SELECT status FROM sales_invoices WHERE id = ?', [order.salesInvoiceId]);
    if (invoice?.status !== 'cancelled') {
      throw new ConflictError('Cette commande a été facturée : annulez d’abord la facture de vente, puis la commande.');
    }
  }
  await db
    .update(brickOrders)
    .set({ status: 'cancelled', cancelReason: motif, cancelledAt: new Date(), cancelledBy: user.id, updatedAt: new Date() })
    .where(eq(brickOrders.id, id));
  const result = await getBrickOrderRow(id);
  if (!result) throw new NotFoundError('Commande introuvable');
  return result;
}

/**
 * **Facture la commande** : vente du canal `brick` (sort le stock du magasin,
 * refusée si le stock ne suffit pas), puis **transfert** des acomptes sur la
 * facture — mêmes reçus, même caisse, document repointé.
 */
export async function invoiceBrickOrder(
  id: number,
  user: { id: number; storeId: number },
): Promise<{ order: BrickOrderRow; invoiceId: number; invoiceNumber: string }> {
  return withTransaction(async () => {
    const order = await assertOrderInStore(id, user.storeId);
    if (order.isCancelled) throw new ConflictError('Cette commande est annulée');
    if (order.salesInvoiceId) throw new ConflictError(`Cette commande est déjà facturée (${order.salesInvoiceNumber}).`);
    if (order.status === 'draft') throw new ValidationError('Confirmez la commande avant de la facturer.');
    const items = await listItems(id);

    const invoice = await createSalesInvoice({
      storeId: user.storeId,
      customerId: order.customerId,
      customerName: order.customerName,
      date: today(),
      dueDate: order.dueDate,
      paymentMethod: 'Espèces',
      // Aucun encaissement immédiat : les acomptes sont transférés juste après.
      amountPaid: 0,
      discount: order.discount,
      taxRate: 0,
      notes: text(`Commande ${order.orderNumber}${order.notes ? ` — ${order.notes}` : ''}`),
      status: 'active',
      channel: 'brick',
      userId: user.id,
      lines: items.map((item) => ({
        productId: Number(item.productId),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
      })),
    });

    const transferred = await rawGet<{ total: number | null }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE type = 'brick_order' AND reference_id = ?`,
      [id],
    );
    if (num(transferred?.total) > 0) {
      // Type **et** identifiant : un identifiant seul viserait aussi les
      // paiements d'autres documents portant le même numéro.
      await db
        .update(payments)
        .set({ type: 'sale', referenceId: invoice.id, updatedAt: new Date() })
        .where(and(eq(payments.type, 'brick_order'), eq(payments.referenceId, id)));
      await recomputeDocumentPayments('sale', invoice.id);
    }

    // L'argent vit désormais sur la facture : la commande n'a plus de reste
    // propre (sinon la liste afficherait en rouge un montant déjà facturé).
    await db
      .update(brickOrders)
      .set({
        salesInvoiceId: invoice.id,
        status: 'delivered',
        deliveryDate: order.deliveryDate ?? today(),
        amountPaid: 0,
        remainingAmount: 0,
        paymentStatus: 'invoiced',
        updatedAt: new Date(),
      })
      .where(eq(brickOrders.id, id));

    const updated = await getBrickOrderRow(id);
    if (!updated) throw new NotFoundError('Commande introuvable');
    return { order: updated, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber };
  });
}
