/**
 * Fournisseurs (§3, §7.3).
 *
 * Module **symétrique** de `lib/customers.ts` : les totaux d'achat et les
 * dettes ne sont **jamais stockés**, ils sont calculés depuis les factures
 * d'achat et les paiements (README §15). C'est ce qui garantit qu'une dette
 * fournisseur ne peut pas « dériver ».
 *
 * Le solde d'un fournisseur est la somme des `remaining_amount` de ses achats
 * **non annulés** — ce qui est exactement « Σ total − Σ paiements » (§15) :
 * `lib/payments.ts` recalcule `amount_paid` / `remaining_amount` depuis les
 * lignes de `payments`, il n'y a donc pas de double calcul à refaire ici.
 */

import { db, rawAll, rawGet } from '@/db';
import { suppliers } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueSyncWrite } from '@/lib/sync';
import { listPayments, type PaymentRow } from '@/lib/payments';

export type SupplierRow = {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  purchaseCount: number;
  totalPurchased: number;
  totalPaid: number;
  /** Σ `remaining_amount` des achats actifs : la dette envers ce fournisseur. */
  balance: number;
  lastPurchaseDate: string | null;
  createdAt: Date | null;
};

export type SupplierInput = {
  name: string;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  isActive?: boolean;
};

export type SupplierStats = {
  supplier: SupplierRow;
  purchaseCount: number;
  totalPurchased: number;
  totalPaid: number;
  balance: number;
  averageBasket: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
  /** Produits les plus achetés chez ce fournisseur (5 premiers, par montant). */
  topProducts: { productName: string; quantity: number; amount: number }[];
  recentPurchases: {
    id: number;
    reference: string;
    supplierReference: string | null;
    date: string;
    dueDate: string | null;
    total: number;
    amountPaid: number;
    remainingAmount: number;
    paymentStatus: string;
    status: string;
  }[];
};

export type SuppliersSummary = {
  totalSuppliers: number;
  activeSuppliers: number;
  debtorsCount: number;
  /** Total des dettes fournisseurs : Σ `remaining_amount` des achats non soldés. */
  totalPayables: number;
  totalPurchased: number;
};

export type PaginatedSuppliers = {
  data: SupplierRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

/**
 * Liste paginée avec agrégats calculés **en SQL** (jamais en JavaScript) :
 * afficher 20 fournisseurs ne doit pas charger 10 000 factures d'achat.
 */
export async function listSuppliers(
  options: {
    search?: string;
    page?: number;
    limit?: number;
    debtorsOnly?: boolean;
    includeInactive?: boolean;
    /** Restreint aux fiches désactivées — contrepartie stricte de `includeInactive`. */
    inactiveOnly?: boolean;
  } = {},
): Promise<PaginatedSuppliers> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (options.inactiveOnly) where.push('s.is_active = 0');
  else if (!options.includeInactive) where.push('s.is_active = 1');

  if (options.search) {
    where.push('(s.name LIKE ? OR s.phone LIKE ? OR s.address LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  /**
   * Filtre « avec dette ».
   *
   * ⚠️ Il ne peut **pas** s'écrire en `HAVING` : la requête extérieure n'a
   * aucun `GROUP BY` (l'agrégat est dans la sous-requête jointe) et SQLite
   * refuse alors avec « HAVING clause on a non-aggregate query ». Même défaut
   * que `lib/customers.ts` et `lib/balances.ts` — corrigé de la même façon :
   * on filtre à l'extérieur, sur la colonne déjà calculée.
   */
  const debtorFilter = options.debtorsOnly ? 'WHERE balance > 0.001' : '';

  const innerSql = `
    SELECT s.id, s.name, s.phone, s.address, s.notes, s.is_active,
           COALESCE(inv.purchase_count, 0)   AS purchase_count,
           COALESCE(inv.total_purchased, 0)  AS total_purchased,
           COALESCE(inv.total_paid, 0)       AS total_paid,
           COALESCE(inv.balance, 0)          AS balance,
           inv.last_purchase_date,
           s.created_at
    FROM suppliers s
    LEFT JOIN (
      SELECT supplier_id,
             COUNT(*)              AS purchase_count,
             SUM(total)            AS total_purchased,
             SUM(amount_paid)      AS total_paid,
             SUM(remaining_amount) AS balance,
             MAX(date)             AS last_purchase_date
      FROM purchase_invoices
      WHERE status = 'active' AND supplier_id IS NOT NULL
      GROUP BY supplier_id
    ) inv ON inv.supplier_id = s.id
    ${whereSql}
  `;

  const rows = await rawAll<{
    id: number;
    name: string;
    phone: string | null;
    address: string | null;
    notes: string | null;
    is_active: number;
    purchase_count: number | null;
    total_purchased: number | null;
    total_paid: number | null;
    balance: number | null;
    last_purchase_date: string | null;
    created_at: number | null;
  }>(
    `SELECT * FROM (${innerSql}) ${debtorFilter}
     ORDER BY name COLLATE NOCASE
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM (${innerSql}) ${debtorFilter}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapSupplierRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

function mapSupplierRow(row: any): SupplierRow {
  return {
    id: Number(row.id),
    name: row.name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    isActive: Boolean(row.is_active),
    purchaseCount: Number(row.purchase_count ?? 0),
    totalPurchased: Number(row.total_purchased ?? 0),
    totalPaid: Number(row.total_paid ?? 0),
    balance: Number(row.balance ?? 0),
    lastPurchaseDate: row.last_purchase_date ?? null,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

export async function getSupplier(id: number): Promise<SupplierRow | null> {
  const row = await rawGet<any>(
    `SELECT s.id, s.name, s.phone, s.address, s.notes, s.is_active, s.created_at,
            COALESCE(inv.purchase_count, 0)   AS purchase_count,
            COALESCE(inv.total_purchased, 0)  AS total_purchased,
            COALESCE(inv.total_paid, 0)       AS total_paid,
            COALESCE(inv.balance, 0)          AS balance,
            inv.last_purchase_date
     FROM suppliers s
     LEFT JOIN (
       SELECT supplier_id, COUNT(*) AS purchase_count, SUM(total) AS total_purchased,
              SUM(amount_paid) AS total_paid, SUM(remaining_amount) AS balance,
              MAX(date) AS last_purchase_date
       FROM purchase_invoices WHERE status = 'active' AND supplier_id IS NOT NULL
       GROUP BY supplier_id
     ) inv ON inv.supplier_id = s.id
     WHERE s.id = ?`,
    [id],
  );

  return row ? mapSupplierRow(row) : null;
}

export async function createSupplier(input: SupplierInput): Promise<SupplierRow> {
  const inserted = await db
    .insert(suppliers)
    .values({
      name: input.name.trim(),
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
      isActive: input.isActive ?? true,
    })
    .returning({ id: suppliers.id, syncId: suppliers.syncId });

  await enqueueSyncWrite('suppliers', inserted[0]?.syncId, 'insert', {
    name: input.name.trim(),
    phone: input.phone ?? null,
    address: input.address ?? null,
  });

  const created = await getSupplier(inserted[0].id);
  if (!created) throw new Error('Fournisseur créé mais introuvable');
  return created;
}

export async function updateSupplier(id: number, input: Partial<SupplierInput>): Promise<SupplierRow> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
  if (input.address !== undefined) patch.address = input.address?.trim() || null;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  const updated = await db
    .update(suppliers)
    .set(patch as any)
    .where(eq(suppliers.id, id))
    .returning({ id: suppliers.id, syncId: suppliers.syncId });

  if (updated.length === 0) throw new Error('Fournisseur introuvable');

  await enqueueSyncWrite('suppliers', updated[0].syncId, 'update', patch);

  const result = await getSupplier(id);
  if (!result) throw new Error('Fournisseur introuvable après modification');
  return result;
}

/**
 * Désactivation — **jamais** de suppression physique (README §26.13, repris au
 * §23.10) : un `DELETE` ferait ressusciter la ligne au prochain pull de
 * synchronisation, et une facture d'achat ancienne doit rester rattachée à son
 * fournisseur pour rester imprimable.
 */
export async function deactivateSupplier(id: number): Promise<void> {
  const updated = await db
    .update(suppliers)
    .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(suppliers.id, id))
    .returning({ syncId: suppliers.syncId });

  if (updated.length === 0) throw new Error('Fournisseur introuvable');

  await enqueueSyncWrite('suppliers', updated[0].syncId, 'delete', {
    deleted_at: new Date().toISOString(),
  });
}

export async function reactivateSupplier(id: number): Promise<void> {
  const updated = await db
    .update(suppliers)
    .set({ isActive: true, deletedAt: null, updatedAt: new Date() })
    .where(eq(suppliers.id, id))
    .returning({ syncId: suppliers.syncId });

  if (updated.length === 0) throw new Error('Fournisseur introuvable');

  // La réactivation est une écriture comme une autre : elle part en file aussi,
  // sinon le poste distant garderait la fiche désactivée.
  await enqueueSyncWrite('suppliers', updated[0].syncId, 'update', {
    is_active: true,
    deleted_at: null,
  });
}

/** Fiche détaillée : statistiques, produits les plus achetés, derniers achats. */
export async function getSupplierStats(id: number): Promise<SupplierStats | null> {
  const supplier = await getSupplier(id);
  if (!supplier) return null;

  const bounds = await rawGet<{ first_date: string | null; last_date: string | null }>(
    `SELECT MIN(date) AS first_date, MAX(date) AS last_date
     FROM purchase_invoices WHERE supplier_id = ? AND status = 'active'`,
    [id],
  );

  const topProducts = await rawAll<{ product_name: string; quantity: number; amount: number }>(
    `SELECT i.product_name,
            SUM(i.quantity) AS quantity,
            SUM(i.amount)   AS amount
     FROM purchase_invoice_items i
     JOIN purchase_invoices v ON v.id = i.invoice_id
     WHERE v.supplier_id = ? AND v.status = 'active'
     GROUP BY i.product_name
     ORDER BY amount DESC
     LIMIT 5`,
    [id],
  );

  const recentPurchases = await rawAll<any>(
    `SELECT id, reference, supplier_reference, date, due_date, total,
            amount_paid, remaining_amount, payment_status, status
     FROM purchase_invoices
     WHERE supplier_id = ?
     ORDER BY date DESC, id DESC
     LIMIT 10`,
    [id],
  );

  return {
    supplier,
    purchaseCount: supplier.purchaseCount,
    totalPurchased: supplier.totalPurchased,
    totalPaid: supplier.totalPaid,
    balance: supplier.balance,
    averageBasket:
      supplier.purchaseCount > 0 ? supplier.totalPurchased / supplier.purchaseCount : 0,
    firstPurchaseDate: bounds?.first_date ?? null,
    lastPurchaseDate: bounds?.last_date ?? null,
    topProducts: topProducts.map((p) => ({
      productName: p.product_name,
      quantity: Number(p.quantity ?? 0),
      amount: Number(p.amount ?? 0),
    })),
    recentPurchases: recentPurchases.map((p) => ({
      id: Number(p.id),
      reference: p.reference,
      supplierReference: p.supplier_reference ?? null,
      date: p.date,
      dueDate: p.due_date ?? null,
      total: Number(p.total ?? 0),
      amountPaid: Number(p.amount_paid ?? 0),
      remainingAmount: Number(p.remaining_amount ?? 0),
      paymentStatus: p.payment_status,
      status: p.status,
    })),
  };
}

/** Statistiques globales de l'en-tête de page. */
export async function getSuppliersSummary(): Promise<SuppliersSummary> {
  const row = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM suppliers) AS total_suppliers,
       (SELECT COUNT(*) FROM suppliers WHERE is_active = 1) AS active_suppliers,
       (SELECT COUNT(DISTINCT supplier_id) FROM purchase_invoices
         WHERE status = 'active' AND remaining_amount > 0.001 AND supplier_id IS NOT NULL) AS debtors_count,
       (SELECT COALESCE(SUM(remaining_amount), 0) FROM purchase_invoices
         WHERE status = 'active' AND supplier_id IS NOT NULL) AS total_payables,
       (SELECT COALESCE(SUM(total), 0) FROM purchase_invoices WHERE status = 'active') AS total_purchased`,
  );

  return {
    totalSuppliers: Number(row?.total_suppliers ?? 0),
    activeSuppliers: Number(row?.active_suppliers ?? 0),
    debtorsCount: Number(row?.debtors_count ?? 0),
    totalPayables: Number(row?.total_payables ?? 0),
    totalPurchased: Number(row?.total_purchased ?? 0),
  };
}

/**
 * Historique des règlements d'un fournisseur : les `payments` de type
 * `purchase` dont la facture lui appartient. Toute la logique de filtrage vit
 * dans `lib/payments.ts` — on ne la duplique pas ici.
 */
export async function listSupplierPayments(
  supplierId: number,
  options: { page?: number; limit?: number } = {},
): Promise<{ data: PaymentRow[]; total: number; page: number; limit: number; totalPages: number }> {
  return listPayments({
    type: 'purchase',
    supplierId,
    page: options.page,
    limit: options.limit,
  });
}

/** Recherche rapide pour une modale de sélection (achat, dépense, chantier). */
export async function searchSuppliers(term: string, limit = 20): Promise<SupplierRow[]> {
  const { data } = await listSuppliers({ search: term, limit });
  return data;
}
