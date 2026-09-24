/**
 * Instantané du tableau de bord (§7.1) et calculs de marge/bénéfice (§15).
 *
 * **Aucun de ces montants n'est stocké** : tout est calculé à la lecture depuis
 * les factures, les paiements et les dépenses. C'est ce qui garantit qu'un solde
 * ou un bénéfice ne peut jamais « dériver » (README §15).
 *
 * Le chiffre d'affaires est la somme de deux **documents facturables
 * autonomes** : `sales_invoices` (ventes) **et** `service_jobs` (prestations de
 * chantier). Ils ne sont jamais comptés deux fois (§6.1).
 */

import { rawAll, rawGet } from '@/db';
import { getCashBalance, getCashSummary, getOpenSession } from '@/lib/caisse';
import { previousPeriod, startOfMonth, startOfWeek, today, endOfMonth } from '@/lib/format';

export type PeriodKey = 'day' | 'week' | 'month' | 'year' | 'total';

export type SnapshotPeriod = { from: string; to: string; label: string; key: PeriodKey };

/** Bornes d'une période nommée, en dates métier `YYYY-MM-DD`. */
export function resolvePeriod(key: PeriodKey, reference = today()): SnapshotPeriod {
  switch (key) {
    case 'day':
      return { key, from: reference, to: reference, label: "Aujourd'hui" };
    case 'week':
      return { from: startOfWeek(reference), to: reference, label: 'Cette semaine', key };
    case 'month':
      return {
        from: startOfMonth(reference),
        to: endOfMonth(reference),
        label: 'Ce mois',
        key,
      };
    case 'year':
      return { from: `${reference.slice(0, 4)}-01-01`, to: `${reference.slice(0, 4)}-12-31`, label: 'Cette année', key };
    case 'total':
    default:
      return { key: 'total', from: '1900-01-01', to: '2999-12-31', label: 'Depuis le début' };
  }
}

export type DashboardSnapshot = {
  period: SnapshotPeriod;
  sales: {
    count: number;
    revenue: number;
    totalHt: number;
    taxAmount: number;
    collected: number;
    outstanding: number;
    averageBasket: number;
    cancelledCount: number;
  };
  jobs: { count: number; revenue: number; outstanding: number };
  comparison: {
    previousFrom: string;
    previousTo: string;
    previousRevenue: number;
    deltaPercent: number | null;
  };
  profit: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    grossMarginPercent: number;
    expenses: number;
    laborCost: number;
    netProfit: number;
  };
  cash: {
    balance: number;
    sessionStatus: 'open' | 'closed';
    sessionOpenedAt: string | null;
    income: number;
    expense: number;
    net: number;
    byMethod: { method: string; income: number; expense: number; net: number }[];
  };
  receivables: {
    total: number;
    debtorsCount: number;
    top: { id: number; name: string; phone: string | null; balance: number; overdue: boolean }[];
  };
  payables: {
    total: number;
    creditorsCount: number;
    top: { id: number; name: string; phone: string | null; balance: number }[];
  };
  stock: {
    lowStockCount: number;
    outOfStockCount: number;
    purchaseValue: number;
    saleValue: number;
    alerts: {
      id: number;
      code: string;
      name: string;
      unit: string;
      stock: number;
      stockMin: number;
      isOut: boolean;
    }[];
  };
  topProducts: { productId: number | null; productName: string; quantity: number; amount: number }[];
  recentSales: {
    id: number;
    invoiceNumber: string;
    customerName: string;
    date: string;
    total: number;
    amountPaid: number;
    remainingAmount: number;
    paymentStatus: string;
  }[];
  monthly: { month: string; revenue: number; purchases: number; expenses: number }[];
};

/**
 * Coût des marchandises vendues (COGS).
 *
 * Le README §15 précise que le prix d'achat utilisé pour la marge est celui **du
 * jour de la vente**, lu sur `products.purchase_price` — et non celui du jour de
 * l'édition du rapport. Comme les lignes de facture figent le prix de vente mais
 * pas le prix d'achat, on interroge `products` : c'est le compromis retenu en
 * V1 (Q20 : l'instantané du coût pourra être ajouté si les marges historiques
 * doivent être figées).
 */
async function computeCogs(from: string, to: string): Promise<number> {
  const row = await rawGet<{ cogs: number | null }>(
    `SELECT SUM(i.quantity * COALESCE(p.purchase_price, 0)) AS cogs
     FROM sales_invoice_items i
     JOIN sales_invoices v ON v.id = i.invoice_id
     LEFT JOIN products p ON p.id = i.product_id
     WHERE v.status = 'active' AND v.date >= ? AND v.date <= ?`,
    [from, to],
  );
  return Number(row?.cogs ?? 0);
}

export async function getDashboardSnapshot(periodKey: PeriodKey): Promise<DashboardSnapshot> {
  const period = resolvePeriod(periodKey);
  const { from, to } = period;

  /* -------------------------------- Ventes -------------------------------- */
  const salesRow = await rawGet<any>(
    `SELECT COUNT(*)                                   AS count,
            COALESCE(SUM(total), 0)                    AS revenue,
            COALESCE(SUM(total_ht), 0)                 AS total_ht,
            COALESCE(SUM(tax_amount), 0)               AS tax_amount,
            COALESCE(SUM(amount_paid), 0)              AS collected,
            COALESCE(SUM(remaining_amount), 0)         AS outstanding,
            COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count
     FROM sales_invoices
     WHERE date >= ? AND date <= ?`,
    [from, to],
  );

  const salesCount = Number(salesRow?.count ?? 0);
  const salesRevenue = Number(salesRow?.revenue ?? 0);
  const cancelledCount = Number(salesRow?.cancelled_count ?? 0);
  const activeSalesCount = Math.max(0, salesCount - cancelledCount);

  /* ----------------------------- Prestations ------------------------------ */
  const jobsRow = await rawGet<any>(
    `SELECT COUNT(*)                              AS count,
            COALESCE(SUM(total), 0)               AS revenue,
            COALESCE(SUM(remaining_amount), 0)    AS outstanding
     FROM service_jobs
     WHERE status <> 'cancelled' AND date(start_date) >= date(?) AND date(start_date) <= date(?)`,
    [from, to],
  );

  /* ------------------------------ Comparaison ----------------------------- */
  const previous = previousPeriod(from, to);
  const previousRow = await rawGet<{ revenue: number | null }>(
    `SELECT COALESCE(SUM(total), 0) AS revenue
     FROM sales_invoices
     WHERE status = 'active' AND date >= ? AND date <= ?`,
    [previous.from, previous.to],
  );
  const previousRevenue = Number(previousRow?.revenue ?? 0);

  const activeRow = await rawGet<{ revenue: number | null }>(
    `SELECT COALESCE(SUM(total), 0) AS revenue
     FROM sales_invoices
     WHERE status = 'active' AND date >= ? AND date <= ?`,
    [from, to],
  );
  const activeRevenue = Number(activeRow?.revenue ?? 0);

  const deltaPercent =
    previousRevenue > 0
      ? Math.round(((activeRevenue - previousRevenue) / previousRevenue) * 1000) / 10
      : null;

  /* -------------------------------- Bénéfice ------------------------------ */
  const cogs = await computeCogs(from, to);

  const expensesRow = await rawGet<{ total: number | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE date >= ? AND date <= ?`,
    [from, to],
  );
  const expensesTotal = Number(expensesRow?.total ?? 0);

  // La main-d'œuvre des chantiers et des fabrications entre dans le bénéfice
  // net (§15), en plus des dépenses de fonctionnement.
  const laborRow = await rawGet<any>(
    `SELECT
       (SELECT COALESCE(SUM(labor_cost), 0) FROM brick_productions
         WHERE date(start_date) >= date(?) AND date(start_date) <= date(?)) +
       (SELECT COALESCE(SUM(labor_cost), 0) FROM furniture_orders
         WHERE date(start_date) >= date(?) AND date(start_date) <= date(?)) +
       (SELECT COALESCE(SUM(amount), 0) FROM service_job_workers w
          JOIN service_jobs j ON j.id = w.job_id
         WHERE date(j.start_date) >= date(?) AND date(j.start_date) <= date(?))
       AS labor`,
    [from, to, from, to, from, to],
  );
  const laborCost = Number(laborRow?.labor ?? 0);

  const grossProfit = activeRevenue - cogs;
  const netProfit = grossProfit - expensesTotal - laborCost;

  /* --------------------------------- Caisse ------------------------------- */
  const [cashBalance, cashSummary, openSession] = await Promise.all([
    getCashBalance(),
    getCashSummary({ from, to }),
    getOpenSession(),
  ]);

  /* ------------------------- Créances et dettes --------------------------- */
  const receivablesRow = await rawGet<any>(
    `SELECT COALESCE(SUM(remaining_amount), 0) AS total,
            COUNT(DISTINCT customer_id)        AS debtors
     FROM sales_invoices
     WHERE status = 'active' AND remaining_amount > 0.001 AND customer_id IS NOT NULL`,
  );

  const receivableTop = await rawAll<any>(
    `SELECT c.id, c.name, c.phone,
            SUM(v.remaining_amount) AS balance,
            MIN(v.due_date)         AS oldest_due
     FROM sales_invoices v
     JOIN customers c ON c.id = v.customer_id
     WHERE v.status = 'active' AND v.remaining_amount > 0.001
     GROUP BY c.id, c.name, c.phone
     ORDER BY balance DESC
     LIMIT 6`,
  );

  const todayDate = today();

  const payablesRow = await rawGet<any>(
    `SELECT COALESCE(SUM(remaining_amount), 0) AS total,
            COUNT(DISTINCT supplier_id)        AS creditors
     FROM purchase_invoices
     WHERE status = 'active' AND remaining_amount > 0.001 AND supplier_id IS NOT NULL`,
  );

  const payableTop = await rawAll<any>(
    `SELECT s.id, s.name, s.phone, SUM(a.remaining_amount) AS balance
     FROM purchase_invoices a
     JOIN suppliers s ON s.id = a.supplier_id
     WHERE a.status = 'active' AND a.remaining_amount > 0.001
     GROUP BY s.id, s.name, s.phone
     ORDER BY balance DESC
     LIMIT 6`,
  );

  /* --------------------------------- Stock -------------------------------- */
  const stockRow = await rawGet<any>(
    `SELECT
       COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END), 0) AS out_of_stock,
       COALESCE(SUM(CASE WHEN stock > 0 AND stock_min > 0 AND stock <= stock_min THEN 1 ELSE 0 END), 0) AS low_stock,
       COALESCE(SUM(stock * purchase_price), 0) AS purchase_value,
       COALESCE(SUM(stock * sale_price), 0)     AS sale_value
     FROM products WHERE is_active = 1`,
  );

  const stockAlerts = await rawAll<any>(
    `SELECT id, code, name, unit, stock, stock_min
     FROM products
     WHERE is_active = 1 AND (stock <= 0 OR (stock_min > 0 AND stock <= stock_min))
     ORDER BY (stock <= 0) DESC, stock ASC
     LIMIT 8`,
  );

  /* ---------------------------- Produits vendus --------------------------- */
  const topProducts = await rawAll<any>(
    `SELECT i.product_id, i.product_name,
            SUM(i.quantity) AS quantity,
            SUM(i.amount)   AS amount
     FROM sales_invoice_items i
     JOIN sales_invoices v ON v.id = i.invoice_id
     WHERE v.status = 'active' AND v.date >= ? AND v.date <= ?
     GROUP BY i.product_id, i.product_name
     ORDER BY amount DESC
     LIMIT 8`,
    [from, to],
  );

  /* --------------------------- Dernières ventes --------------------------- */
  const recentSales = await rawAll<any>(
    `SELECT id, invoice_number, customer_name, date, total, amount_paid, remaining_amount, payment_status
     FROM sales_invoices
     WHERE status <> 'draft'
     ORDER BY date DESC, id DESC
     LIMIT 8`,
  );

  /* ------------------------- Évolution mensuelle -------------------------- */
  const monthlySales = await rawAll<any>(
    `SELECT substr(date, 1, 7) AS month, SUM(total) AS revenue
     FROM sales_invoices
     WHERE status = 'active' AND date >= date('now', '-11 months', 'start of month')
     GROUP BY month ORDER BY month`,
  );

  const monthlyPurchases = await rawAll<any>(
    `SELECT substr(date, 1, 7) AS month, SUM(total) AS total
     FROM purchase_invoices
     WHERE status = 'active' AND date >= date('now', '-11 months', 'start of month')
     GROUP BY month ORDER BY month`,
  );

  const monthlyExpenses = await rawAll<any>(
    `SELECT substr(date, 1, 7) AS month, SUM(amount) AS total
     FROM expenses
     WHERE date >= date('now', '-11 months', 'start of month')
     GROUP BY month ORDER BY month`,
  );

  // On aligne les trois séries sur les 12 mêmes mois : un graphique dont les
  // séries n'ont pas les mêmes abscisses serait faux à la lecture.
  const monthKeys: string[] = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() - 11);
  for (let i = 0; i < 12; i += 1) {
    const month = String(cursor.getMonth() + 1).padStart(2, '0');
    monthKeys.push(`${cursor.getFullYear()}-${month}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const salesByMonth = new Map(monthlySales.map((r) => [r.month, Number(r.revenue ?? 0)]));
  const purchasesByMonth = new Map(monthlyPurchases.map((r) => [r.month, Number(r.total ?? 0)]));
  const expensesByMonth = new Map(monthlyExpenses.map((r) => [r.month, Number(r.total ?? 0)]));

  return {
    period,
    sales: {
      count: activeSalesCount,
      revenue: activeRevenue,
      totalHt: Number(salesRow?.total_ht ?? 0),
      taxAmount: Number(salesRow?.tax_amount ?? 0),
      collected: Number(salesRow?.collected ?? 0),
      outstanding: Number(salesRow?.outstanding ?? 0),
      averageBasket: activeSalesCount > 0 ? activeRevenue / activeSalesCount : 0,
      cancelledCount,
    },
    jobs: {
      count: Number(jobsRow?.count ?? 0),
      revenue: Number(jobsRow?.revenue ?? 0),
      outstanding: Number(jobsRow?.outstanding ?? 0),
    },
    comparison: {
      previousFrom: previous.from,
      previousTo: previous.to,
      previousRevenue,
      deltaPercent,
    },
    profit: {
      revenue: activeRevenue,
      cogs,
      grossProfit,
      grossMarginPercent: activeRevenue > 0 ? Math.round((grossProfit / activeRevenue) * 1000) / 10 : 0,
      expenses: expensesTotal,
      laborCost,
      netProfit,
    },
    cash: {
      balance: cashBalance,
      sessionStatus: cashSummary.sessionStatus,
      sessionOpenedAt: openSession?.openedAt ? openSession.openedAt.toISOString() : null,
      income: cashSummary.incomeTotal,
      expense: cashSummary.expenseTotal,
      net: cashSummary.incomeTotal - cashSummary.expenseTotal,
      byMethod: cashSummary.byMethod,
    },
    receivables: {
      total: Number(receivablesRow?.total ?? 0),
      debtorsCount: Number(receivablesRow?.debtors ?? 0),
      top: receivableTop.map((r) => ({
        id: Number(r.id),
        name: r.name,
        phone: r.phone,
        balance: Number(r.balance ?? 0),
        overdue: Boolean(r.oldest_due) && String(r.oldest_due) < todayDate,
      })),
    },
    payables: {
      total: Number(payablesRow?.total ?? 0),
      creditorsCount: Number(payablesRow?.creditors ?? 0),
      top: payableTop.map((r) => ({
        id: Number(r.id),
        name: r.name,
        phone: r.phone,
        balance: Number(r.balance ?? 0),
      })),
    },
    stock: {
      lowStockCount: Number(stockRow?.low_stock ?? 0),
      outOfStockCount: Number(stockRow?.out_of_stock ?? 0),
      purchaseValue: Number(stockRow?.purchase_value ?? 0),
      saleValue: Number(stockRow?.sale_value ?? 0),
      alerts: stockAlerts.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        unit: r.unit ?? '',
        stock: Number(r.stock ?? 0),
        stockMin: Number(r.stock_min ?? 0),
        isOut: Number(r.stock ?? 0) <= 0,
      })),
    },
    topProducts: topProducts.map((r) => ({
      productId: r.product_id == null ? null : Number(r.product_id),
      productName: r.product_name,
      quantity: Number(r.quantity ?? 0),
      amount: Number(r.amount ?? 0),
    })),
    recentSales: recentSales.map((r) => ({
      id: Number(r.id),
      invoiceNumber: r.invoice_number,
      customerName: r.customer_name,
      date: r.date,
      total: Number(r.total ?? 0),
      amountPaid: Number(r.amount_paid ?? 0),
      remainingAmount: Number(r.remaining_amount ?? 0),
      paymentStatus: r.payment_status,
    })),
    monthly: monthKeys.map((month) => ({
      month,
      revenue: salesByMonth.get(month) ?? 0,
      purchases: purchasesByMonth.get(month) ?? 0,
      expenses: expensesByMonth.get(month) ?? 0,
    })),
  };
}

/**
 * Métriques de marge et de profit (reprise de `calculateSalesProfitMetrics()`
 * du projet Gaz, enrichie des dépenses — README §15).
 */
export async function calculateSalesProfitMetrics(from: string, to: string) {
  const revenueRow = await rawGet<{ revenue: number | null; quantity: number | null }>(
    `SELECT COALESCE(SUM(i.amount), 0) AS revenue, COALESCE(SUM(i.quantity), 0) AS quantity
     FROM sales_invoice_items i
     JOIN sales_invoices v ON v.id = i.invoice_id
     WHERE v.status = 'active' AND v.date >= ? AND v.date <= ?`,
    [from, to],
  );

  const cogs = await computeCogs(from, to);
  const revenue = Number(revenueRow?.revenue ?? 0);

  return {
    from,
    to,
    revenue,
    quantity: Number(revenueRow?.quantity ?? 0),
    cogs,
    grossProfit: revenue - cogs,
    grossMarginPercent: revenue > 0 ? Math.round(((revenue - cogs) / revenue) * 1000) / 10 : 0,
  };
}

/** Marge par produit, triée par marge cumulée (README §15). */
export async function getProductMargins(from: string, to: string, limit = 20) {
  const rows = await rawAll<any>(
    `SELECT i.product_id,
            i.product_name,
            SUM(i.quantity)                                AS quantity,
            SUM(i.amount)                                  AS revenue,
            SUM(i.quantity * COALESCE(p.purchase_price, 0)) AS cost
     FROM sales_invoice_items i
     JOIN sales_invoices v ON v.id = i.invoice_id
     LEFT JOIN products p ON p.id = i.product_id
     WHERE v.status = 'active' AND v.date >= ? AND v.date <= ?
     GROUP BY i.product_id, i.product_name
     ORDER BY (SUM(i.amount) - SUM(i.quantity * COALESCE(p.purchase_price, 0))) DESC
     LIMIT ?`,
    [from, to, limit],
  );

  return rows.map((r) => {
    const revenue = Number(r.revenue ?? 0);
    const cost = Number(r.cost ?? 0);
    const quantity = Number(r.quantity ?? 0);
    return {
      productId: r.product_id == null ? null : Number(r.product_id),
      productName: r.product_name,
      quantity,
      revenue,
      cost,
      margin: revenue - cost,
      marginPercent: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0,
      unitMargin: quantity > 0 ? (revenue - cost) / quantity : 0,
    };
  });
}
