/**
 * Soldes, dettes et bénéfices (§10, §15).
 *
 * **Aucun de ces montants n'est stocké** : soldes clients, dettes fournisseurs,
 * chiffre d'affaires, marge et bénéfice sont intégralement **calculés à la
 * lecture** depuis `sales_invoices`, `purchase_invoices`, `payments`,
 * `expenses` et la main-d'œuvre. C'est ce qui garantit qu'un solde ne peut
 * jamais « dériver » (README §15).
 *
 * Module **en lecture seule** : il n'écrit ni dans la base, ni dans la file de
 * synchronisation — il ne fait donc aucun appel à `enqueueSyncWrite`.
 *
 * Deux règles de calcul à ne jamais perdre de vue :
 *
 *  1. **Tous les agrégats sont faits en SQL** (`SUM`, `GROUP BY`, `COUNT`).
 *     Additionner des lignes en JavaScript pour afficher un total donnerait le
 *     même résultat sur dix lignes et un résultat faux sur dix mille.
 *  2. Le chiffre d'affaires est la somme de deux **documents facturables
 *     autonomes** : `sales_invoices` (ventes, en HT) **et** `service_jobs`
 *     (prestations de chantier). Ils ne sont jamais comptés deux fois (§15).
 *
 * La marge et le bénéfice brut réutilisent `calculateSalesProfitMetrics()` et
 * `getProductMargins()` de `lib/dashboard.ts` : ce qui existe déjà n'est pas
 * recalculé ici (CONVENTIONS §2, règle de propriété).
 */

import { rawAll, rawGet } from '@/db';
import {
  calculateSalesProfitMetrics,
  getProductMargins,
  type PeriodKey,
} from '@/lib/dashboard';
import { today } from '@/lib/format';

/** Enveloppe paginée imposée (CONVENTIONS §4). */
export type PaginatedBalances<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

/* ------------------------------------------------------------------ *
 * Types publics
 * ------------------------------------------------------------------ */

export type ClientBalanceRow = {
  id: number;
  name: string;
  phone: string | null;
  /** Nombre de factures de vente **actives**. */
  invoiceCount: number;
  /** Σ `sales_invoices.total` — tout ce qui a été facturé au client. */
  totalInvoiced: number;
  /** Σ des paiements encaissés sur ses factures. */
  totalPaid: number;
  /** Σ `total` − Σ `payments` : ce qu'il doit encore. */
  balance: number;
  /** Échéance la plus ancienne non réglée, `YYYY-MM-DD` ou `null`. */
  oldestDueDate: string | null;
  /** Vrai si une facture non soldée est échue. */
  overdue: boolean;
};

export type SupplierBalanceRow = {
  id: number;
  name: string;
  phone: string | null;
  /** Nombre de factures d'achat **actives**. */
  purchaseCount: number;
  totalPurchased: number;
  totalPaid: number;
  /** Σ `total` − Σ `payments` : ce que l'entreprise doit au fournisseur. */
  balance: number;
  oldestDueDate: string | null;
  overdue: boolean;
};

export type BalancesByMonth = {
  month: string;
  revenue: number;
  expenses: number;
  profit: number;
};

export type BalancesSummary = {
  /** Σ `remaining_amount` des factures de vente actives : créances clients. */
  totalReceivables: number;
  debtorsCount: number;
  /** Σ `remaining_amount` des achats actifs non soldés : dettes fournisseurs. */
  totalPayables: number;
  creditorsCount: number;
  /** Chiffre d'affaires de la période : ventes (HT) + prestations. */
  revenue: number;
  /** Part « ventes de marchandises », HT — c'est elle qui porte la marge. */
  revenueHt: number;
  /** Part « prestations de chantier » : document autonome, jamais recomptée. */
  jobsRevenue: number;
  /** Coût des marchandises vendues + matériaux consommés par les chantiers. */
  cogs: number;
  /** Bénéfice brut = CA − coût des marchandises vendues. */
  grossProfit: number;
  grossMarginPercent: number;
  /** Dépenses de fonctionnement de la période (annulées exclues). */
  expenses: number;
  /** Main-d'œuvre des chantiers, fabrications et commandes d'atelier. */
  laborCost: number;
  expensesTotal: number;
  /** Bénéfice net = bénéfice brut − dépenses − main-d'œuvre (§15). */
  netProfit: number;
  /** Coût des matériaux consommés par les chantiers (inclus dans `cogs`). */
  jobsMaterialCost: number;
  /** Nombre de prestations de la période. */
  jobsCount: number;
  byMonth: BalancesByMonth[];
};

export type TopCustomerRow = {
  id: number;
  name: string;
  phone: string | null;
  invoiceCount: number;
  revenue: number;
  paid: number;
  balance: number;
  oldestDueDate: string | null;
  overdue: boolean;
};

export type TopSupplierRow = {
  id: number;
  name: string;
  phone: string | null;
  purchaseCount: number;
  purchased: number;
  paid: number;
  balance: number;
};

/** Marge par produit — forme exacte de `getProductMargins()` (lib/dashboard.ts). */
export type ProductMarginRow = Awaited<ReturnType<typeof getProductMargins>>[number];

/* ------------------------------------------------------------------ *
 * Solde d'un client / d'un fournisseur — calcul, jamais stockage
 * ------------------------------------------------------------------ */

/**
 * Solde d'un client = Σ `total` de ses factures actives − Σ `payments` de ses
 * factures (README §15). L'égalité avec Σ `remaining_amount` est garantie par
 * `lib/payments.ts`, qui recalcule `remaining_amount` depuis les paiements ;
 * on expose néanmoins les deux termes pour que la fiche soit lisible.
 *
 * Seuls `customer_id IS NOT NULL` sont retenus : une vente comptoir (client
 * `null`) n'ouvre aucune créance (§10.5).
 */
const CLIENT_BALANCE_CTE = `
  WITH inv AS (
    SELECT customer_id,
           COUNT(*)         AS invoice_count,
           SUM(total)       AS total_invoiced,
           SUM(amount_paid) AS total_paid,
           SUM(remaining_amount) AS remaining,
           MIN(due_date)    AS oldest_due
    FROM sales_invoices
    WHERE status = 'active' AND customer_id IS NOT NULL
    GROUP BY customer_id
  ),
  pay AS (
    SELECT v.customer_id, SUM(p.amount) AS total_payments
    FROM payments p
    JOIN sales_invoices v ON v.id = p.reference_id
    WHERE p.type = 'sale' AND v.customer_id IS NOT NULL
    GROUP BY v.customer_id
  )
`;

/** Solde d'un fournisseur = Σ `total` des achats actifs − Σ `payments`. */
const SUPPLIER_BALANCE_CTE = `
  WITH inv AS (
    SELECT supplier_id,
           COUNT(*)         AS purchase_count,
           SUM(total)       AS total_purchased,
           SUM(amount_paid) AS total_paid,
           SUM(remaining_amount) AS remaining,
           MIN(due_date)    AS oldest_due
    FROM purchase_invoices
    WHERE status = 'active' AND supplier_id IS NOT NULL
    GROUP BY supplier_id
  ),
  pay AS (
    SELECT a.supplier_id, SUM(p.amount) AS total_payments
    FROM payments p
    JOIN purchase_invoices a ON a.id = p.reference_id
    WHERE p.type = 'purchase' AND a.supplier_id IS NOT NULL
    GROUP BY a.supplier_id
  )
`;

/**
 * Soldes clients, du plus débiteur au moins débiteur.
 *
 * `debtorsOnly` restreint aux clients qui doivent encore quelque chose : c'est
 * le filtre de l'onglet « Créances clients ».
 */
export async function getClientBalances(options: {
  search?: string;
  debtorsOnly?: boolean;
  page?: number;
  limit?: number;
} = {}): Promise<PaginatedBalances<ClientBalanceRow>> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (options.search) {
    where.push('(c.name LIKE ? OR c.phone LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  /**
   * Filtre « débiteurs ».
   *
   * ⚠️ **Pas de `HAVING` ici.** La requête extérieure n'a pas de `GROUP BY`
   * (l'agrégat vient d'une CTE jointe) : SQLite refuse alors avec
   * « HAVING clause on a non-aggregate query ». Même défaut que
   * `lib/customers.ts` et `lib/suppliers.ts`, corrigé de la même façon — on
   * enveloppe et on filtre à l'extérieur sur la colonne déjà calculée.
   */
  const debtorFilter = options.debtorsOnly ? 'WHERE remaining > 0.001' : '';

  const joins = `
    FROM customers c
    LEFT JOIN inv ON inv.customer_id = c.id
    LEFT JOIN pay ON pay.customer_id = c.id
    ${whereSql}
  `;

  const innerSql = `
    ${CLIENT_BALANCE_CTE}
    SELECT c.id, c.name, c.phone,
           COALESCE(inv.invoice_count, 0)   AS invoice_count,
           COALESCE(inv.total_invoiced, 0)  AS total_invoiced,
           COALESCE(inv.total_paid, 0)      AS total_paid,
           COALESCE(inv.remaining, 0)       AS remaining,
           inv.oldest_due
    ${joins}
  `;

  const rows = await rawAll<any>(
    `SELECT * FROM (${innerSql}) ${debtorFilter}
     ORDER BY remaining DESC, name COLLATE NOCASE
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM (${innerSql}) ${debtorFilter}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      phone: row.phone ?? null,
      invoiceCount: Number(row.invoice_count ?? 0),
      totalInvoiced: Number(row.total_invoiced ?? 0),
      totalPaid: Number(row.total_paid ?? 0),
      balance: Math.round(Number(row.remaining ?? 0) * 100) / 100,
      oldestDueDate: row.oldest_due ?? null,
      overdue: Boolean(row.oldest_due) && String(row.oldest_due) < today(),
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/**
 * Soldes fournisseurs, du plus créditeur au moins créditeur.
 *
 * Les colonnes restent nommées `totalInvoiced` / `invoiceCount` pour que les
 * tableaux « créances » et « dettes » partagent le même vocabulaire d'affichage,
 * même si le document d'origine est un achat.
 */
export async function getSupplierBalances(options: {
  search?: string;
  creditorsOnly?: boolean;
  page?: number;
  limit?: number;
} = {}): Promise<PaginatedBalances<SupplierBalanceRow>> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (options.search) {
    where.push('(s.name LIKE ? OR s.phone LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  /** Idem créances : on filtre à l'extérieur, jamais en `HAVING`. */
  const creditorFilter = options.creditorsOnly ? 'WHERE remaining > 0.001' : '';

  const joins = `
    FROM suppliers s
    LEFT JOIN inv ON inv.supplier_id = s.id
    LEFT JOIN pay ON pay.supplier_id = s.id
    ${whereSql}
  `;

  const innerSql = `
    ${SUPPLIER_BALANCE_CTE}
    SELECT s.id, s.name, s.phone,
           COALESCE(inv.purchase_count, 0)   AS purchase_count,
           COALESCE(inv.total_purchased, 0)  AS total_purchased,
           COALESCE(inv.total_paid, 0)       AS total_paid,
           COALESCE(inv.remaining, 0)        AS remaining,
           inv.oldest_due
    ${joins}
  `;

  const rows = await rawAll<any>(
    `SELECT * FROM (${innerSql}) ${creditorFilter}
     ORDER BY remaining DESC, name COLLATE NOCASE
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM (${innerSql}) ${creditorFilter}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map((row) => {
      const oldestDueDate: string | null = row.oldest_due ?? null;
      return {
        id: Number(row.id),
        name: row.name,
        phone: row.phone ?? null,
        purchaseCount: Number(row.purchase_count ?? 0),
        totalPurchased: Number(row.total_purchased ?? 0),
        totalPaid: Number(row.total_paid ?? 0),
        balance: Math.round(Number(row.remaining ?? 0) * 100) / 100,
        oldestDueDate,
        overdue: Boolean(oldestDueDate) && String(oldestDueDate) < today(),
      };
    }),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/* ------------------------------------------------------------------ *
 * Résultat de la période : CA, marge, bénéfice net
 * ------------------------------------------------------------------ */

/**
 * Main-d'œuvre de la période : chantiers, fabrications de briques et commandes
 * d'atelier — les trois sources de `labor_cost` du §15, en une seule requête.
 */
async function sumLaborCost(from: string, to: string): Promise<number> {
  const row = await rawGet<{ labor: number | null }>(
    `SELECT
       (SELECT COALESCE(SUM(labor_cost), 0) FROM brick_productions
         WHERE date(start_date) >= date(?) AND date(start_date) <= date(?)) +
       (SELECT COALESCE(SUM(labor_cost), 0) FROM furniture_orders
         WHERE date(start_date) >= date(?) AND date(start_date) <= date(?)) +
       (SELECT COALESCE(SUM(amount), 0) FROM service_job_workers w
          JOIN service_jobs j ON j.id = w.job_id
         WHERE j.status <> 'cancelled'
           AND date(j.start_date) >= date(?) AND date(j.start_date) <= date(?))
       AS labor`,
    [from, to, from, to, from, to],
  );
  return Number(row?.labor ?? 0);
}

/**
 * Treize mois d'historique (le mois courant inclus) : chiffre d'affaires,
 * dépenses et bénéfice brut par mois. Sert la courbe de la page `/soldes`.
 */
async function getMonthlyTrend(): Promise<BalancesByMonth[]> {
  const [salesRows, jobsRows, expenseRows] = await Promise.all([
    rawAll<{ month: string; total: number | null }>(
      `SELECT substr(date, 1, 7) AS month, SUM(total_ht) AS total
       FROM sales_invoices
       WHERE status = 'active' AND date >= date('now', '-11 months', 'start of month')
       GROUP BY month`,
    ),
    rawAll<{ month: string; total: number | null }>(
      `SELECT substr(date(start_date), 1, 7) AS month, SUM(total) AS total
       FROM service_jobs
       WHERE status <> 'cancelled'
         AND date(start_date) >= date('now', '-11 months', 'start of month')
       GROUP BY month`,
    ),
    rawAll<{ month: string; total: number | null }>(
      `SELECT substr(date, 1, 7) AS month, SUM(amount) AS total
       FROM expenses
       WHERE deleted_at IS NULL AND date >= date('now', '-11 months', 'start of month')
       GROUP BY month`,
    ),
  ]);

  const salesByMonth = new Map(salesRows.map((r) => [r.month, Number(r.total ?? 0)]));
  const jobsByMonth = new Map(jobsRows.map((r) => [r.month, Number(r.total ?? 0)]));
  const expensesByMonth = new Map(expenseRows.map((r) => [r.month, Number(r.total ?? 0)]));

  // Les trois séries sont alignées sur les mêmes douze mois : un graphique dont
  // les abscisses diffèrent d'une série à l'autre serait faux à la lecture.
  const months: string[] = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() - 11);
  for (let i = 0; i < 12; i += 1) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return months.map((month) => {
    const revenue = (salesByMonth.get(month) ?? 0) + (jobsByMonth.get(month) ?? 0);
    const expenses = expensesByMonth.get(month) ?? 0;
    return {
      month,
      revenue,
      expenses,
      // Le coût des marchandises n'est pas ventilé par mois ici : la courbe
      // affiche donc un résultat avant coût d'achat, jamais un bénéfice net.
      profit: revenue - expenses,
    };
  });
}

/**
 * Synthèse complète d'une période (§15).
 *
 * Les bornes sont inclusives et portent sur la **date métier** `YYYY-MM-DD` —
 * le seul champ filtré (CONVENTIONS §6 règle 2) : un `BETWEEN` sur un
 * horodatage renverrait zéro ligne.
 */
export async function getBalancesSummary(options: {
  from?: string;
  to?: string;
} = {}): Promise<BalancesSummary> {
  const from = options.from ?? '1900-01-01';
  const to = options.to ?? '2999-12-31';

  const [salesRow, jobsRow, jobsMaterialsRow, marginMetrics, expensesRow, laborCost, trend] =
    await Promise.all([
      rawGet<{ total: number | null }>(
        `SELECT COALESCE(SUM(total_ht), 0) AS total
         FROM sales_invoices
         WHERE status = 'active' AND date >= ? AND date <= ?`,
        [from, to],
      ),
      rawGet<{ count: number; total: number | null }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
         FROM service_jobs
         WHERE status <> 'cancelled'
           AND date(start_date) >= date(?) AND date(start_date) <= date(?)`,
        [from, to],
      ),
      rawGet<{ total: number | null }>(
        `SELECT COALESCE(SUM(m.amount), 0) AS total
         FROM service_job_materials m
         JOIN service_jobs j ON j.id = m.job_id
         WHERE j.status <> 'cancelled'
           AND date(j.start_date) >= date(?) AND date(j.start_date) <= date(?)`,
        [from, to],
      ),
      calculateSalesProfitMetrics(from, to),
      rawGet<{ total: number | null }>(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM expenses
         WHERE deleted_at IS NULL AND date >= ? AND date <= ?`,
        [from, to],
      ),
      sumLaborCost(from, to),
      getMonthlyTrend(),
    ]);

  const revenueHt = Number(salesRow?.total ?? 0);
  const jobsRevenue = Number(jobsRow?.total ?? 0);
  const jobsCount = Number(jobsRow?.count ?? 0);
  const jobsMaterialCost = Number(jobsMaterialsRow?.total ?? 0);

  const revenue = revenueHt + jobsRevenue;
  // Coût des marchandises vendues (marchandises revendues) + matériaux
  // consommés par les chantiers : les deux sont des coûts directs.
  const cogs = marginMetrics.cogs + jobsMaterialCost;
  const grossProfit = revenue - cogs;
  const expenses = Number(expensesRow?.total ?? 0);
  const netProfit = grossProfit - expenses - laborCost;

  const [receivablesRow, payablesRow] = await Promise.all([
    rawGet<{ total: number | null; debtors: number }>(
      `SELECT COALESCE(SUM(remaining_amount), 0) AS total,
              COUNT(DISTINCT customer_id)        AS debtors
       FROM sales_invoices
       WHERE status = 'active' AND remaining_amount > 0.001 AND customer_id IS NOT NULL`,
    ),
    rawGet<{ total: number | null; creditors: number }>(
      `SELECT COALESCE(SUM(remaining_amount), 0) AS total,
              COUNT(DISTINCT supplier_id)        AS creditors
       FROM purchase_invoices
       WHERE status = 'active' AND remaining_amount > 0.001 AND supplier_id IS NOT NULL`,
    ),
  ]);

  return {
    totalReceivables: Number(receivablesRow?.total ?? 0),
    debtorsCount: Number(receivablesRow?.debtors ?? 0),
    totalPayables: Number(payablesRow?.total ?? 0),
    creditorsCount: Number(payablesRow?.creditors ?? 0),
    revenue,
    revenueHt,
    jobsRevenue,
    cogs,
    grossProfit,
    // La marge est rapportée au chiffre d'affaires complet : c'est le seul
    // pourcentage qui ne surestime pas la rentabilité réelle de l'activité.
    grossMarginPercent:
      revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : 0,
    expenses,
    laborCost,
    expensesTotal: expenses,
    netProfit,
    jobsMaterialCost,
    jobsCount,
    byMonth: trend,
  };
}

/* ------------------------------------------------------------------ *
 * Palmarès : meilleurs clients, meilleurs fournisseurs
 * ------------------------------------------------------------------ */

/**
 * Meilleurs clients de la période, au **chiffre d'affaires facturé** (Σ `total`,
 * toutes taxes comprises) : c'est le montant réellement dû par le client, donc
 * la base naturelle d'un encours.
 */
export async function getTopCustomers(
  from: string,
  to: string,
  limit = 10,
): Promise<TopCustomerRow[]> {
  const safeLimit = Math.max(1, Math.min(100, limit));

  const rows = await rawAll<any>(
    `SELECT c.id, c.name, c.phone,
            COUNT(v.id)                 AS invoice_count,
            COALESCE(SUM(v.total), 0)   AS revenue,
            COALESCE(SUM(v.amount_paid), 0)      AS paid,
            COALESCE(SUM(v.remaining_amount), 0) AS balance,
            MIN(CASE WHEN v.remaining_amount > 0.001 THEN v.due_date END) AS oldest_due
     FROM sales_invoices v
     JOIN customers c ON c.id = v.customer_id
     WHERE v.status = 'active' AND v.date >= ? AND v.date <= ?
     GROUP BY c.id, c.name, c.phone
     ORDER BY revenue DESC, c.name COLLATE NOCASE
     LIMIT ?`,
    [from, to, safeLimit],
  );

  return rows.map((row) => {
    const oldestDueDate: string | null = row.oldest_due ?? null;
    return {
      id: Number(row.id),
      name: row.name,
      phone: row.phone ?? null,
      invoiceCount: Number(row.invoice_count ?? 0),
      revenue: Number(row.revenue ?? 0),
      paid: Number(row.paid ?? 0),
      balance: Number(row.balance ?? 0),
      oldestDueDate,
      overdue: Boolean(oldestDueDate) && String(oldestDueDate) < today(),
    };
  });
}

/** Meilleurs fournisseurs de la période, au total acheté. */
export async function getTopSuppliers(
  from: string,
  to: string,
  limit = 10,
): Promise<TopSupplierRow[]> {
  const safeLimit = Math.max(1, Math.min(100, limit));

  const rows = await rawAll<any>(
    `SELECT s.id, s.name, s.phone,
            COUNT(a.id)                  AS purchase_count,
            COALESCE(SUM(a.total), 0)    AS purchased,
            COALESCE(SUM(a.amount_paid), 0)      AS paid,
            COALESCE(SUM(a.remaining_amount), 0) AS balance
     FROM purchase_invoices a
     JOIN suppliers s ON s.id = a.supplier_id
     WHERE a.status = 'active' AND a.date >= ? AND a.date <= ?
     GROUP BY s.id, s.name, s.phone
     ORDER BY purchased DESC, s.name COLLATE NOCASE
     LIMIT ?`,
    [from, to, safeLimit],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    phone: row.phone ?? null,
    purchaseCount: Number(row.purchase_count ?? 0),
    purchased: Number(row.purchased ?? 0),
    paid: Number(row.paid ?? 0),
    balance: Number(row.balance ?? 0),
  }));
}

/* ------------------------------------------------------------------ *
 * Réexport utilitaire
 * ------------------------------------------------------------------ */

/**
 * Marges par produit de la période — délégué à `lib/dashboard.ts`, qui porte
 * déjà la règle du §15 (prix d'achat lu sur `products.purchase_price`).
 */
export async function getMargins(
  from: string,
  to: string,
  limit = 20,
): Promise<ProductMarginRow[]> {
  return getProductMargins(from, to, limit);
}

/** Bornes d'une période nommée, transmises telles quelles par l'API. */
export type { PeriodKey };
