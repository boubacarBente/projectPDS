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
 *
 * ⚠️ **Le bloc `profit` ne se calcule plus ici.** Il vient de
 * `getPeriodResult()` (`lib/profit.ts`), la **même** fonction que `/soldes`.
 * Avant, le tableau de bord portait sa propre formule et annonçait donc un
 * autre « bénéfice net » que `/soldes` pour la même période — mesuré sur la
 * base de recette : **−2 389 000 GNF** contre **+2 535 000 GNF** sur le même
 * mois, parce qu'il ignorait les prestations de chantier, sommait les dépenses
 * annulées et rapportait une marge TTC à des coûts HT. Un montant recalculé à
 * deux endroits finit toujours par diverger : il n'y a plus qu'un seul calcul.
 */

import { rawAll, rawGet } from '@/db';
import { getCashBalance, getCashSummary, getOpenSession } from '@/lib/caisse';
import { previousPeriod, startOfMonth, startOfWeek, today, endOfMonth } from '@/lib/format';
import { getPeriodResult } from '@/lib/profit';
import { getStockSummary, listedSql } from '@/lib/stock';
import { getStoreIndicators, scopeSql, type StoreScope } from '@/lib/stores';

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
  /**
   * Bénéfice net de chacun des 12 mois de `monthly` (même calcul que `/soldes`,
   * `getPeriodResult`). `null` pour un compte sans `balances.view` : le
   * bénéfice est une donnée sensible, gardée côté serveur (AGENTS.md, invariant 13).
   */
  monthlyProfit: { month: string; netProfit: number }[] | null;
  /** Comparaison entre magasins (vue consolidée, §6) — un objet par magasin. */
  stores: {
    storeId: number;
    code: string;
    name: string;
    status: string;
    revenue: number;
    salesCount: number;
    averageBasket: number;
    purchases: number;
    expenses: number;
    collected: number;
    receivables: number;
    payables: number;
    stockValue: number;
    lowStock: number;
    cashBalance: number;
    cashOpen: boolean;
  }[];
  /** Points d'attention multi-magasins (§21). */
  alerts: {
    transfersToApprove: number;
    transfersInTransit: number;
    transfersDisputed: number;
    expensesPending: number;
    cashSessionsOpen: number;
    inventoriesOpen: number;
  };
  /** Activité récente (connexions, ventes, validations, opérations sensibles). */
  activity: { id: number; createdAt: string | null; userName: string; storeName: string | null; action: string; entity: string; entityId: number | null }[];
};

/**
 * Instantané complet du tableau de bord pour une période nommée.
 *
 * Le calcul de marge et de bénéfice (COGS, dépenses, main-d'œuvre) n'est **pas**
 * fait ici : il vient de `getPeriodResult()` (`lib/profit.ts`), comme pour
 * `/soldes`. Ce module ne porte que ce qui est propre au tableau de bord —
 * caisse, créances, dettes, stock, dernières ventes, courbes.
 */
export async function getDashboardSnapshot(
  periodKey: PeriodKey,
  scope: StoreScope,
  options: { includeCentralActivity?: boolean; includeMonthlyProfit?: boolean } = {},
): Promise<DashboardSnapshot> {
  const period = resolvePeriod(periodKey);
  const { from, to } = period;
  const v = scopeSql('store_id', scope);
  const vv = scopeSql('v.store_id', scope);
  const aa = scopeSql('a.store_id', scope);

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
     WHERE date >= ? AND date <= ? AND status <> 'draft' AND ${v}`,
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
     WHERE status <> 'cancelled' AND ${v} AND date(start_date) >= date(?) AND date(start_date) <= date(?)`,
    [from, to],
  );

  /* ------------------- Comparaison et résultat de la période -------------- */
  /*
   * Le résultat de la période sort de `getPeriodResult()` — la **même**
   * fonction que `/soldes` : CA HT des ventes + prestations de chantier, coût
   * des marchandises, dépenses non annulées et main-d'œuvre. La comparaison
   * porte donc sur exactement la grandeur affichée dans la carte « Chiffre
   * d'affaires » : un écart « vs période précédente » calculé sur une autre
   * base serait un faux signal.
   *
   * `activeRevenue` reste, lui, le CA **des ventes** (TTC, factures actives) :
   * il sert au compteur de ventes et au panier moyen, pas au bénéfice.
   */
  const previous = previousPeriod(from, to);
  const [result, previousResult, activeRow] = await Promise.all([
    getPeriodResult(from, to, scope),
    getPeriodResult(previous.from, previous.to, scope),
    rawGet<{ revenue: number | null }>(
      `SELECT COALESCE(SUM(total), 0) AS revenue
       FROM sales_invoices
       WHERE status = 'active' AND date >= ? AND date <= ? AND ${v}`,
      [from, to],
    ),
  ]);

  const activeRevenue = Number(activeRow?.revenue ?? 0);
  const previousRevenue = previousResult.revenue;

  const deltaPercent =
    previousRevenue > 0
      ? Math.round(((result.revenue - previousRevenue) / previousRevenue) * 1000) / 10
      : null;

  /* -------------------------------- Bénéfice ------------------------------ */
  /*
   * Plus aucun calcul de bénéfice ici : `result` (ci-dessus) porte déjà le CA,
   * le coût des marchandises, la marge, les dépenses, la main-d'œuvre et le
   * bénéfice net du §15 — même définition que `/soldes`.
   */

  /* --------------------------------- Caisse ------------------------------- */
  const [cashBalance, cashSummary, openSession] = await Promise.all([
    getCashBalance(scope),
    getCashSummary({ scope, from, to }),
    scope.length === 1 ? getOpenSession(scope[0]) : Promise.resolve(null),
  ]);

  /* ------------------------- Créances et dettes --------------------------- */
  const receivablesRow = await rawGet<any>(
    `SELECT COALESCE(SUM(remaining_amount), 0) AS total,
            COUNT(DISTINCT customer_id)        AS debtors
     FROM sales_invoices
     WHERE status = 'active' AND remaining_amount > 0.001 AND customer_id IS NOT NULL AND ${v}`,
  );

  const receivableTop = await rawAll<any>(
    `SELECT c.id, c.name, c.phone,
            SUM(v.remaining_amount) AS balance,
            MIN(v.due_date)         AS oldest_due
     FROM sales_invoices v
     JOIN customers c ON c.id = v.customer_id
     WHERE v.status = 'active' AND v.remaining_amount > 0.001 AND ${vv}
     GROUP BY c.id, c.name, c.phone
     ORDER BY balance DESC
     LIMIT 6`,
  );

  const todayDate = today();

  const payablesRow = await rawGet<any>(
    `SELECT COALESCE(SUM(remaining_amount), 0) AS total,
            COUNT(DISTINCT supplier_id)        AS creditors
     FROM purchase_invoices
     WHERE status = 'active' AND remaining_amount > 0.001 AND supplier_id IS NOT NULL AND ${v}`,
  );

  const payableTop = await rawAll<any>(
    `SELECT s.id, s.name, s.phone, SUM(a.remaining_amount) AS balance
     FROM purchase_invoices a
     JOIN suppliers s ON s.id = a.supplier_id
     WHERE a.status = 'active' AND a.remaining_amount > 0.001 AND ${aa}
     GROUP BY s.id, s.name, s.phone
     ORDER BY balance DESC
     LIMIT 6`,
  );

  /* --------------------------------- Stock -------------------------------- */
  const stockSummary = await getStockSummary(scope);
  const stockExpr = `COALESCE((SELECT SUM(ps.quantity) FROM product_stocks ps WHERE ps.product_id = p.id AND ${scopeSql('ps.store_id', scope)}), 0)`;
  const minExpr =
    scope.length === 1
      ? `COALESCE((SELECT ps.stock_min FROM product_stocks ps WHERE ps.product_id = p.id AND ps.store_id = ${Number(scope[0])}), p.stock_min)`
      : `(p.stock_min * ${Math.max(1, scope.length)})`;
  const stockAlerts = await rawAll<any>(
    `SELECT * FROM (
       SELECT p.id, p.name, p.unit, ${stockExpr} AS stock, ${minExpr} AS stock_min
         FROM products p WHERE p.is_active = 1 AND p.deleted_at IS NULL AND ${listedSql(scope)}
     ) WHERE stock <= 0 OR (stock_min > 0 AND stock <= stock_min)
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
     WHERE v.status = 'active' AND v.date >= ? AND v.date <= ? AND ${vv}
     GROUP BY i.product_id, i.product_name
     ORDER BY amount DESC
     LIMIT 8`,
    [from, to],
  );

  /* --------------------------- Dernières ventes --------------------------- */
  const recentSales = await rawAll<any>(
    `SELECT id, invoice_number, customer_name, date, total, amount_paid, remaining_amount, payment_status
     FROM sales_invoices
     WHERE status <> 'draft' AND ${v}
     ORDER BY date DESC, id DESC
     LIMIT 8`,
  );

  /* ------------------------- Évolution mensuelle -------------------------- */
  const monthlySales = await rawAll<any>(
    `SELECT substr(date, 1, 7) AS month, SUM(total) AS revenue
     FROM sales_invoices
     WHERE status = 'active' AND ${v} AND date >= date('now', '-11 months', 'start of month')
     GROUP BY month ORDER BY month`,
  );

  const monthlyPurchases = await rawAll<any>(
    `SELECT substr(date, 1, 7) AS month, SUM(total) AS total
     FROM purchase_invoices
     WHERE status = 'active' AND ${v} AND date >= date('now', '-11 months', 'start of month')
     GROUP BY month ORDER BY month`,
  );

  const monthlyExpenses = await rawAll<any>(
    `SELECT substr(date, 1, 7) AS month, SUM(amount) AS total
     FROM expenses
     WHERE deleted_at IS NULL AND approval_status = 'approved' AND ${v}
       AND date >= date('now', '-11 months', 'start of month')
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

  // Bénéfice mois par mois : `getPeriodResult()` sur les bornes de chaque mois,
  // pour que la barre d'un mois soit exactement le « Bénéfice net » de /soldes.
  const monthlyProfit = options.includeMonthlyProfit
    ? await Promise.all(
        monthKeys.map(async (month) => {
          const [year, m] = month.split('-').map(Number);
          const lastDay = new Date(year, m, 0).getDate();
          const result = await getPeriodResult(`${month}-01`, `${month}-${String(lastDay).padStart(2, '0')}`, scope);
          return { month, netProfit: result.netProfit };
        }),
      )
    : null;

  const salesByMonth = new Map(monthlySales.map((r) => [r.month, Number(r.revenue ?? 0)]));
  const purchasesByMonth = new Map(monthlyPurchases.map((r) => [r.month, Number(r.total ?? 0)]));
  const expensesByMonth = new Map(monthlyExpenses.map((r) => [r.month, Number(r.total ?? 0)]));

  /* ----------------------- Comparaison entre magasins --------------------- */
  const storeRows = scope.length > 1
    ? await rawAll<any>(`SELECT id, code, name, status FROM stores WHERE ${scopeSql('id', scope)} ORDER BY name`)
    : [];
  const stores: DashboardSnapshot['stores'] = [];
  for (const store of storeRows) {
    const storeId = Number(store.id);
    const [indicators, balance, open] = await Promise.all([
      getStoreIndicators(storeId, from, to),
      getCashBalance([storeId]),
      getOpenSession(storeId),
    ]);
    stores.push({
      storeId,
      code: store.code,
      name: store.name,
      status: store.status,
      revenue: indicators.revenue,
      salesCount: indicators.salesCount,
      averageBasket: indicators.averageBasket,
      purchases: indicators.purchases,
      expenses: indicators.expenses,
      collected: indicators.collected,
      receivables: indicators.receivables,
      payables: indicators.payables,
      stockValue: indicators.stockValue,
      lowStock: indicators.lowStock,
      cashBalance: balance,
      cashOpen: Boolean(open),
    });
  }

  /* ------------------------- Points d'attention --------------------------- */
  const alertRow = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM stock_transfers WHERE status = 'pending'
          AND (${scopeSql('source_store_id', scope)} OR ${scopeSql('destination_store_id', scope)})) AS to_approve,
       (SELECT COUNT(*) FROM stock_transfers WHERE status IN ('in_transit', 'partially_received')
          AND (${scopeSql('source_store_id', scope)} OR ${scopeSql('destination_store_id', scope)})) AS in_transit,
       (SELECT COUNT(*) FROM stock_transfers WHERE status = 'disputed'
          AND (${scopeSql('source_store_id', scope)} OR ${scopeSql('destination_store_id', scope)})) AS disputed,
       (SELECT COUNT(*) FROM expenses WHERE deleted_at IS NULL AND approval_status IN ('pending', 'to_pay') AND ${v}) AS expenses_pending,
       (SELECT COUNT(*) FROM cash_sessions WHERE status = 'open' AND ${v}) AS cash_open,
       (SELECT COUNT(*) FROM inventories WHERE status = 'open' AND ${v}) AS inventories_open`,
  );

  const activityRows = await rawAll<any>(
    `SELECT a.id, a.created_at, a.user_name, a.action, a.entity, a.entity_id, s.name AS store_name
       FROM audit_logs a LEFT JOIN stores s ON s.id = a.store_id
      WHERE ${options.includeCentralActivity ? `(${aa} OR a.store_id IS NULL)` : aa}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 10`,
  );

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
      // §15, via `getPeriodResult()` : CA HT + prestations de chantier, coût
      // des marchandises (matériaux des chantiers inclus), dépenses non
      // annulées et main-d'œuvre. Exactement le chiffre de la carte
      // « Bénéfice net » de `/soldes` pour la même période.
      revenue: result.revenue,
      cogs: result.cogs,
      grossProfit: result.grossProfit,
      grossMarginPercent: result.grossMarginPercent,
      expenses: result.expenses,
      laborCost: result.laborCost,
      netProfit: result.netProfit,
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
      lowStockCount: stockSummary.lowStockCount,
      outOfStockCount: stockSummary.outOfStockCount,
      purchaseValue: stockSummary.totalStockValue,
      saleValue: stockSummary.totalSaleValue,
      alerts: stockAlerts.map((r) => ({
        id: Number(r.id),
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
    monthlyProfit,
    stores,
    alerts: {
      transfersToApprove: Number(alertRow?.to_approve ?? 0),
      transfersInTransit: Number(alertRow?.in_transit ?? 0),
      transfersDisputed: Number(alertRow?.disputed ?? 0),
      expensesPending: Number(alertRow?.expenses_pending ?? 0),
      cashSessionsOpen: Number(alertRow?.cash_open ?? 0),
      inventoriesOpen: Number(alertRow?.inventories_open ?? 0),
    },
    activity: activityRows.map((r) => ({
      id: Number(r.id),
      createdAt: r.created_at ? new Date(Number(r.created_at) * 1000).toISOString() : null,
      userName: r.user_name,
      storeName: r.store_name ?? null,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id == null ? null : Number(r.entity_id),
    })),
  };
}

/*
 * `calculateSalesProfitMetrics()` et `getProductMargins()` vivaient ici : elles
 * sont passées dans `lib/profit.ts`, aux côtés de `getPeriodResult()`, pour que
 * le résultat d'une période n'ait qu'un seul foyer de calcul. `lib/rapports.ts`
 * et `lib/balances.ts` les importent désormais de là.
 */
