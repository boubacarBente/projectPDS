/**
 * Clients (§2, §7.2).
 *
 * Les totaux d'achat et les soldes ne sont **jamais stockés** : ils sont
 * calculés depuis les factures et les paiements (README §15). C'est ce qui
 * garantit qu'un solde ne peut pas « dériver ».
 *
 * Le solde d'un client est la somme des `remaining_amount` de ses factures
 * **non annulées** — ce qui est exactement « Σ total − Σ paiements » (§15),
 * sans double calcul.
 */

import { db, rawAll, rawGet } from '@/db';
import { customers } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueSyncWrite } from '@/lib/sync';
import { DEFAULT_LIST_SORT, sqlOrderBy, type ListSort } from '@/lib/list-sort';

export type CustomerRow = {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  creditLimit: number;
  isActive: boolean;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
  lastPurchaseDate: string | null;
  createdAt: Date | null;
};

export type CustomerInput = {
  name: string;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  creditLimit?: number;
  isActive?: boolean;
};

export type CustomerStats = {
  customer: CustomerRow;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
  averageBasket: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
  /** Alerte de plafond (Q18 : avertir, pas bloquer, en V1). */
  creditLimitExceeded: boolean;
  topProducts: { productName: string; quantity: number; amount: number }[];
  recentInvoices: {
    id: number;
    invoiceNumber: string;
    date: string;
    total: number;
    amountPaid: number;
    remainingAmount: number;
    paymentStatus: string;
    status: string;
  }[];
};

/**
 * Liste paginée avec agrégats calculés en SQL (pas en JavaScript) : une
 * base locale de quelques milliers de lignes n'a pas besoin d'index
 * explicites (§6.6), mais elle n'a pas non plus besoin de charger 10 000
 * factures pour afficher 10 clients.
 */
export async function listCustomers(options: {
  search?: string;
  page?: number;
  limit?: number;
  debtorsOnly?: boolean;
  includeInactive?: boolean;
  /** `recent` (défaut) = dernière insertion ; `name` ; `balance` = solde décroissant. */
  sort?: ListSort;
} = {}): Promise<{ data: CustomerRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (!options.includeInactive) where.push('c.is_active = 1');
  if (options.search) {
    where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.address LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  /**
   * Filtre « débiteurs ».
   *
   * ⚠️ Il ne peut **pas** s'écrire en `HAVING` : la requête extérieure ne
   * comporte aucun `GROUP BY` (l'agrégat est calculé dans la sous-requête
   * jointe), et SQLite refuse alors avec
   * « HAVING clause on a non-aggregate query ». Bug constaté en vérification :
   * il faisait échouer `/api/rapports` et la liste des clients débiteurs.
   *
   * On enveloppe donc le calcul dans une sous-requête et on filtre à
   * l'extérieur, sur la colonne `balance` déjà calculée.
   */
  const debtorFilter = options.debtorsOnly ? 'WHERE balance > 0.001' : '';

  const innerSql = `
    SELECT c.id, c.name, c.phone, c.address, c.notes, c.credit_limit, c.is_active,
           COALESCE(inv.invoice_count, 0)   AS invoice_count,
           COALESCE(inv.total_invoiced, 0)  AS total_invoiced,
           COALESCE(inv.total_paid, 0)      AS total_paid,
           COALESCE(inv.balance, 0)         AS balance,
           inv.last_purchase_date,
           c.created_at
    FROM customers c
    LEFT JOIN (
      SELECT customer_id,
             COUNT(*)              AS invoice_count,
             SUM(total)            AS total_invoiced,
             SUM(amount_paid)      AS total_paid,
             SUM(remaining_amount) AS balance,
             MAX(date)             AS last_purchase_date
      FROM sales_invoices
      WHERE status = 'active' AND customer_id IS NOT NULL
      GROUP BY customer_id
    ) inv ON inv.customer_id = c.id
    ${whereSql}
  `;

  /**
   * Tri **en SQL**, sur la requête extérieure : la sous-requête expose déjà
   * `created_at`, `id`, `name` et `balance`.
   *
   * ⚠️ Ne jamais trier cette liste en JavaScript dans la page : la pagination
   * est faite ici (`LIMIT/OFFSET`), un tri local ne trierait que la page
   * affichée — « solde décroissant » montrerait alors le plus gros solde de la
   * page 1 et non celui de la base.
   */
  const orderBy = sqlOrderBy(options.sort ?? DEFAULT_LIST_SORT);

  const rows = await rawAll<{
    id: number;
    name: string;
    phone: string | null;
    address: string | null;
    notes: string | null;
    credit_limit: number | null;
    is_active: number;
    invoice_count: number | null;
    total_invoiced: number | null;
    total_paid: number | null;
    balance: number | null;
    last_purchase_date: string | null;
    created_at: number | null;
  }>(
    `SELECT * FROM (${innerSql}) ${debtorFilter}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM (${innerSql}) ${debtorFilter}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapCustomerRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

function mapCustomerRow(row: any): CustomerRow {
  return {
    id: Number(row.id),
    name: row.name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    creditLimit: Number(row.credit_limit ?? 0),
    isActive: Boolean(row.is_active),
    invoiceCount: Number(row.invoice_count ?? 0),
    totalInvoiced: Number(row.total_invoiced ?? 0),
    totalPaid: Number(row.total_paid ?? 0),
    balance: Number(row.balance ?? 0),
    lastPurchaseDate: row.last_purchase_date ?? null,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

export async function getCustomer(id: number): Promise<CustomerRow | null> {
  const row = await rawGet<any>(
    `SELECT c.id, c.name, c.phone, c.address, c.notes, c.credit_limit, c.is_active, c.created_at,
            COALESCE(inv.invoice_count, 0)   AS invoice_count,
            COALESCE(inv.total_invoiced, 0)  AS total_invoiced,
            COALESCE(inv.total_paid, 0)      AS total_paid,
            COALESCE(inv.balance, 0)         AS balance,
            inv.last_purchase_date
     FROM customers c
     LEFT JOIN (
       SELECT customer_id, COUNT(*) AS invoice_count, SUM(total) AS total_invoiced,
              SUM(amount_paid) AS total_paid, SUM(remaining_amount) AS balance,
              MAX(date) AS last_purchase_date
       FROM sales_invoices WHERE status = 'active' AND customer_id IS NOT NULL
       GROUP BY customer_id
     ) inv ON inv.customer_id = c.id
     WHERE c.id = ?`,
    [id],
  );

  return row ? mapCustomerRow(row) : null;
}

export async function createCustomer(input: CustomerInput): Promise<CustomerRow> {
  const inserted = await db
    .insert(customers)
    .values({
      name: input.name.trim(),
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
      creditLimit: Number(input.creditLimit ?? 0) || 0,
      isActive: input.isActive ?? true,
    })
    .returning({ id: customers.id, syncId: customers.syncId });

  await enqueueSyncWrite('customers', inserted[0]?.syncId, 'insert', {
    name: input.name.trim(),
    phone: input.phone ?? null,
    credit_limit: Number(input.creditLimit ?? 0) || 0,
  });

  const created = await getCustomer(inserted[0].id);
  if (!created) throw new Error('Client créé mais introuvable');
  return created;
}

export async function updateCustomer(id: number, input: Partial<CustomerInput>): Promise<CustomerRow> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
  if (input.address !== undefined) patch.address = input.address?.trim() || null;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  if (input.creditLimit !== undefined) patch.creditLimit = Number(input.creditLimit) || 0;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  const updated = await db
    .update(customers)
    .set(patch as any)
    .where(eq(customers.id, id))
    .returning({ id: customers.id, syncId: customers.syncId });

  if (updated.length === 0) throw new Error('Client introuvable');

  await enqueueSyncWrite('customers', updated[0].syncId, 'update', patch);

  const result = await getCustomer(id);
  if (!result) throw new Error('Client introuvable après modification');
  return result;
}

/**
 * Désactivation — **jamais** de suppression physique (§26.13) : un `DELETE`
 * ferait ressusciter la ligne au prochain pull de synchronisation, et une
 * facture ancienne doit rester rattachée à son client.
 */
export async function deactivateCustomer(id: number): Promise<void> {
  const updated = await db
    .update(customers)
    .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(customers.id, id))
    .returning({ syncId: customers.syncId });

  if (updated.length === 0) throw new Error('Client introuvable');

  await enqueueSyncWrite('customers', updated[0].syncId, 'delete', { deleted_at: new Date().toISOString() });
}

export async function reactivateCustomer(id: number): Promise<void> {
  await db
    .update(customers)
    .set({ isActive: true, deletedAt: null, updatedAt: new Date() })
    .where(eq(customers.id, id));
}

/** Fiche détaillée : statistiques, produits les plus achetés, dernières factures. */
export async function getCustomerStats(id: number): Promise<CustomerStats | null> {
  const customer = await getCustomer(id);
  if (!customer) return null;

  const bounds = await rawGet<{ first_date: string | null; last_date: string | null }>(
    `SELECT MIN(date) AS first_date, MAX(date) AS last_date
     FROM sales_invoices WHERE customer_id = ? AND status = 'active'`,
    [id],
  );

  const topProducts = await rawAll<{ product_name: string; quantity: number; amount: number }>(
    `SELECT i.product_name,
            SUM(i.quantity) AS quantity,
            SUM(i.amount)   AS amount
     FROM sales_invoice_items i
     JOIN sales_invoices v ON v.id = i.invoice_id
     WHERE v.customer_id = ? AND v.status = 'active'
     GROUP BY i.product_name
     ORDER BY amount DESC
     LIMIT 5`,
    [id],
  );

  const recentInvoices = await rawAll<any>(
    `SELECT id, invoice_number, date, total, amount_paid, remaining_amount, payment_status, status
     FROM sales_invoices
     WHERE customer_id = ?
     ORDER BY date DESC, id DESC
     LIMIT 10`,
    [id],
  );

  return {
    customer,
    invoiceCount: customer.invoiceCount,
    totalInvoiced: customer.totalInvoiced,
    totalPaid: customer.totalPaid,
    balance: customer.balance,
    averageBasket: customer.invoiceCount > 0 ? customer.totalInvoiced / customer.invoiceCount : 0,
    firstPurchaseDate: bounds?.first_date ?? null,
    lastPurchaseDate: bounds?.last_date ?? null,
    creditLimitExceeded: customer.creditLimit > 0 && customer.balance > customer.creditLimit,
    topProducts: topProducts.map((p) => ({
      productName: p.product_name,
      quantity: Number(p.quantity ?? 0),
      amount: Number(p.amount ?? 0),
    })),
    recentInvoices: recentInvoices.map((i) => ({
      id: Number(i.id),
      invoiceNumber: i.invoice_number,
      date: i.date,
      total: Number(i.total ?? 0),
      amountPaid: Number(i.amount_paid ?? 0),
      remainingAmount: Number(i.remaining_amount ?? 0),
      paymentStatus: i.payment_status,
      status: i.status,
    })),
  };
}

/** Liste des clients débiteurs, triée par ancienneté de dette. */
export async function listDebtors(): Promise<CustomerRow[]> {
  const { data } = await listCustomers({ debtorsOnly: true, limit: 500 });
  return data;
}

/** Statistiques globales de l'en-tête de page. */
export async function getCustomersSummary(): Promise<{
  totalCustomers: number;
  activeCustomers: number;
  debtorsCount: number;
  totalReceivables: number;
  totalInvoiced: number;
}> {
  const row = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM customers) AS total_customers,
       (SELECT COUNT(*) FROM customers WHERE is_active = 1) AS active_customers,
       (SELECT COUNT(DISTINCT customer_id) FROM sales_invoices
         WHERE status = 'active' AND remaining_amount > 0.001 AND customer_id IS NOT NULL) AS debtors_count,
       (SELECT COALESCE(SUM(remaining_amount), 0) FROM sales_invoices
         WHERE status = 'active' AND customer_id IS NOT NULL) AS total_receivables,
       (SELECT COALESCE(SUM(total), 0) FROM sales_invoices WHERE status = 'active') AS total_invoiced`,
  );

  return {
    totalCustomers: Number(row?.total_customers ?? 0),
    activeCustomers: Number(row?.active_customers ?? 0),
    debtorsCount: Number(row?.debtors_count ?? 0),
    totalReceivables: Number(row?.total_receivables ?? 0),
    totalInvoiced: Number(row?.total_invoiced ?? 0),
  };
}

/** Recherche rapide pour une modale de sélection (vente, chantier, commande). */
export async function searchCustomers(term: string, limit = 20): Promise<CustomerRow[]> {
  const { data } = await listCustomers({ search: term, limit });
  return data;
}
