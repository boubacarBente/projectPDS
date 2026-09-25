/**
 * Agrégation complète d'un rapport (README §11, §15, §16.1 ; CONVENTIONS §4).
 *
 * **Tous les agrégats sont calculés en SQL**, jamais additionnés ligne à ligne
 * en JavaScript : afficher un rapport ne doit pas charger 10 000 lignes de
 * factures pour en faire une somme. Les seuls calculs faits ici sont des
 * **ratios** (parts, pourcentages, variations) à partir de totaux déjà agrégés.
 *
 * Aucun montant n'est stocké (§6.5 règle 6) : tout est relu depuis les
 * factures, les paiements, les dépenses et le stock.
 *
 * ⚠️ Module **serveur** (`@/db`). Il ne doit jamais être importé à l'exécution
 * par un composant client (§11 bis) : côté navigateur, on passe par
 * `GET /api/rapports` et par les types de `lib/rapports-types.ts`.
 *
 * Réutilisation imposée : `calculateSalesProfitMetrics()`, `getProductMargins()`
 * et `previousPeriod()` ne sont pas réécrits. `lib/dashboard.ts` n'est **pas**
 * modifié — on ne fait que l'appeler.
 */

import { rawAll, rawGet } from '@/db';
import { calculateSalesProfitMetrics, getProductMargins } from '@/lib/dashboard';
import { getCustomersSummary, listDebtors } from '@/lib/customers';
import { getSuppliersSummary } from '@/lib/suppliers';
import { getStockSummary, listStockProducts } from '@/lib/stock';
import { getCashSummary } from '@/lib/caisse';
import { getPaymentsSummary } from '@/lib/payments';
import { getSettings } from '@/lib/settings';
import {
  endOfMonth,
  formatCurrency,
  formatNumber,
  formatPercent,
  parseBusinessDate,
  previousPeriod,
  today,
} from '@/lib/format';
import { formatDateLong, formatDateShort } from '@/lib/date-format';
import type {
  RapportComparison,
  RapportData,
  RapportExpenseCategory,
  RapportFilters,
  RapportJobCosts,
  RapportPayables,
  RapportReceivables,
  RapportSoldProduct,
  RapportStockInsights,
  RapportTopCustomer,
} from '@/lib/rapports-types';

type SqlArg = string | number;

/* ------------------------------------------------------------------ *
 * Périmètres de filtres — construits une seule fois, réutilisés partout
 * ------------------------------------------------------------------ */

/**
 * Périmètre des **ventes** : toujours `status = 'active'` (§15 : une facture
 * annulée ne compte ni en CA, ni en créance, ni en marge).
 */
function salesScope(
  filters: RapportFilters,
  range: { from: string; to: string },
  options: { includeProduct?: boolean } = {},
): { conditions: string[]; args: SqlArg[]; sql: string } {
  const conditions = ["v.status = 'active'", 'v.date >= ?', 'v.date <= ?'];
  const args: SqlArg[] = [range.from, range.to];

  if (filters.customerId) {
    conditions.push('v.customer_id = ?');
    args.push(filters.customerId);
  }
  if (filters.paymentStatus) {
    conditions.push('v.payment_status = ?');
    args.push(filters.paymentStatus);
  }
  if (filters.productId && options.includeProduct !== false) {
    conditions.push(
      'EXISTS (SELECT 1 FROM sales_invoice_items x WHERE x.invoice_id = v.id AND x.product_id = ?)',
    );
    args.push(filters.productId);
  }

  return { conditions, args, sql: conditions.join(' AND ') };
}

/** Périmètre des **achats** (factures fournisseurs actives). */
function purchasesScope(
  filters: RapportFilters,
  range: { from: string; to: string },
): { conditions: string[]; args: SqlArg[]; sql: string } {
  const conditions = ["p.status = 'active'", 'p.date >= ?', 'p.date <= ?'];
  const args: SqlArg[] = [range.from, range.to];

  if (filters.supplierId) {
    conditions.push('p.supplier_id = ?');
    args.push(filters.supplierId);
  }

  return { conditions, args, sql: conditions.join(' AND ') };
}

/** Périmètre des **prestations** (chantiers) — document facturable autonome (§15). */
function jobsScope(
  filters: RapportFilters,
  range: { from: string; to: string },
): { conditions: string[]; args: SqlArg[]; sql: string } {
  const conditions = [
    "j.status <> 'cancelled'",
    'date(j.start_date) >= date(?)',
    'date(j.start_date) <= date(?)',
  ];
  const args: SqlArg[] = [range.from, range.to];

  if (filters.customerId) {
    conditions.push('j.customer_id = ?');
    args.push(filters.customerId);
  }
  if (filters.paymentStatus) {
    conditions.push('j.payment_status = ?');
    args.push(filters.paymentStatus);
  }

  return { conditions, args, sql: conditions.join(' AND ') };
}

/* ------------------------------------------------------------------ *
 * Petits utilises
 * ------------------------------------------------------------------ */

/** Variation en %, `null` quand la période précédente ne fournit aucune base. */
function computeDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Libellé lisible d'une période, en français. */
function periodLabel(from: string, to: string): string {
  if (from === to) return formatDateLong(from);
  return `du ${formatDateShort(from)} au ${formatDateShort(to)}`;
}

/**
 * Les 12 mois se terminant à `endDate` — **mêmes abscisses pour les trois
 * séries** (ventes, achats, dépenses). Un graphique dont les séries divergent
 * est faux à la lecture : on aligne donc les clés avant de mapper.
 */
function buildMonthKeys(endDate: string, count = 12): string[] {
  const end = parseBusinessDate(endDate) ?? new Date();
  const cursor = new Date(end.getFullYear(), end.getMonth(), 1);
  cursor.setMonth(cursor.getMonth() - (count - 1));

  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    keys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
}

/** Dépenses de la période : total, nombre, moyenne et répartition par catégorie. */
async function getExpensesAggregate(
  from: string,
  to: string,
): Promise<{ total: number; count: number; average: number; byCategory: RapportExpenseCategory[] }> {
  const where = "e.deleted_at IS NULL AND e.date >= ? AND e.date <= ?";

  const [totals, byCategory] = await Promise.all([
    rawGet<{ count: number; total: number | null }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(e.amount), 0) AS total FROM expenses e WHERE ${where}`,
      [from, to],
    ),
    rawAll<{ category: string; total: number | null; count: number }>(
      `SELECT e.category, COALESCE(SUM(e.amount), 0) AS total, COUNT(*) AS count
       FROM expenses e
       WHERE ${where}
       GROUP BY e.category
       ORDER BY total DESC, e.category COLLATE NOCASE`,
      [from, to],
    ),
  ]);

  const count = Number(totals?.count ?? 0);
  const total = Number(totals?.total ?? 0);

  return {
    total,
    count,
    average: count > 0 ? total / count : 0,
    byCategory: byCategory.map((row) => ({
      category: row.category,
      total: Number(row.total ?? 0),
      count: Number(row.count ?? 0),
    })),
  };
}

/** Main-d'œuvre et matières des chantiers, de la briqueterie et de l'atelier. */
async function getJobCosts(from: string, to: string): Promise<RapportJobCosts> {
  const row = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM service_jobs j
         WHERE j.status <> 'cancelled' AND date(j.start_date) >= date(?) AND date(j.start_date) <= date(?)) AS jobs_count,
       (SELECT COALESCE(SUM(j.total), 0) FROM service_jobs j
         WHERE j.status <> 'cancelled' AND date(j.start_date) >= date(?) AND date(j.start_date) <= date(?)) AS jobs_revenue,
       (SELECT COALESCE(SUM(j.remaining_amount), 0) FROM service_jobs j
         WHERE j.status <> 'cancelled' AND date(j.start_date) >= date(?) AND date(j.start_date) <= date(?)) AS jobs_outstanding,
       (SELECT COALESCE(SUM(m.amount), 0) FROM service_job_materials m
          JOIN service_jobs j ON j.id = m.job_id
         WHERE date(j.start_date) >= date(?) AND date(j.start_date) <= date(?)) AS jobs_material,
       (SELECT COALESCE(SUM(w.amount), 0) FROM service_job_workers w
          JOIN service_jobs j ON j.id = w.job_id
         WHERE date(j.start_date) >= date(?) AND date(j.start_date) <= date(?)) AS jobs_labor,
       (SELECT COUNT(*) FROM brick_productions b
         WHERE date(b.start_date) >= date(?) AND date(b.start_date) <= date(?)) AS brick_count,
       (SELECT COALESCE(SUM(b.material_cost), 0) FROM brick_productions b
         WHERE date(b.start_date) >= date(?) AND date(b.start_date) <= date(?)) AS brick_material,
       (SELECT COALESCE(SUM(b.labor_cost), 0) FROM brick_productions b
         WHERE date(b.start_date) >= date(?) AND date(b.start_date) <= date(?)) AS brick_labor,
       (SELECT COUNT(*) FROM furniture_orders o
         WHERE date(o.start_date) >= date(?) AND date(o.start_date) <= date(?)) AS furniture_count,
       (SELECT COALESCE(SUM(o.material_cost), 0) FROM furniture_orders o
         WHERE date(o.start_date) >= date(?) AND date(o.start_date) <= date(?)) AS furniture_material,
       (SELECT COALESCE(SUM(o.labor_cost), 0) FROM furniture_orders o
         WHERE date(o.start_date) >= date(?) AND date(o.start_date) <= date(?)) AS furniture_labor`,
    [
      from, to, from, to, from, to,
      from, to, from, to,
      from, to, from, to,
      from, to, from, to,
    ],
  );

  const brickMaterial = Number(row?.brick_material ?? 0);
  const brickLabor = Number(row?.brick_labor ?? 0);
  const furnitureMaterial = Number(row?.furniture_material ?? 0);
  const furnitureLabor = Number(row?.furniture_labor ?? 0);
  const jobsMaterial = Number(row?.jobs_material ?? 0);
  const jobsLabor = Number(row?.jobs_labor ?? 0);

  return {
    serviceJobs: {
      count: Number(row?.jobs_count ?? 0),
      revenue: Number(row?.jobs_revenue ?? 0),
      outstanding: Number(row?.jobs_outstanding ?? 0),
      materialCost: jobsMaterial,
      laborCost: jobsLabor,
    },
    brickProductions: {
      count: Number(row?.brick_count ?? 0),
      materialCost: brickMaterial,
      laborCost: brickLabor,
    },
    furnitureOrders: {
      count: Number(row?.furniture_count ?? 0),
      materialCost: furnitureMaterial,
      laborCost: furnitureLabor,
    },
    totalMaterialCost: jobsMaterial + brickMaterial + furnitureMaterial,
    totalLaborCost: jobsLabor + brickLabor + furnitureLabor,
  };
}

/**
 * Créances clients : totaux **en SQL** (`getCustomersSummary`) et liste des
 * débiteurs (`listDebtors`), enrichie de l'échéance la plus ancienne.
 *
 * La situation est **indépendante de la période** : une dette n'appartient pas
 * à un exercice, elle existe au jour du rapport.
 */
async function getReceivables(): Promise<RapportReceivables> {
  const [summary, debtors, dueRows] = await Promise.all([
    getCustomersSummary(),
    listDebtors(),
    rawAll<{ customer_id: number; oldest_due: string | null }>(
      `SELECT v.customer_id, MIN(v.due_date) AS oldest_due
       FROM sales_invoices v
       WHERE v.status = 'active' AND v.remaining_amount > 0.001 AND v.customer_id IS NOT NULL
       GROUP BY v.customer_id`,
    ),
  ]);

  const dueByCustomer = new Map<number, string | null>();
  for (const row of dueRows) dueByCustomer.set(Number(row.customer_id), row.oldest_due ?? null);

  const reference = today();

  const items = debtors
    .filter((customer) => Number(customer.balance ?? 0) > 0.001)
    .sort((a, b) => Number(b.balance) - Number(a.balance))
    .slice(0, 12)
    .map((customer) => {
      const oldestDueDate = dueByCustomer.get(customer.id) ?? null;
      return {
        customerId: customer.id,
        customerName: customer.name,
        phone: customer.phone,
        balance: Number(customer.balance ?? 0),
        invoiceCount: Number(customer.invoiceCount ?? 0),
        oldestDueDate,
        overdue: Boolean(oldestDueDate) && String(oldestDueDate) < reference,
      };
    });

  return {
    total: Number(summary.totalReceivables ?? 0),
    debtorsCount: Number(summary.debtorsCount ?? 0),
    items,
  };
}

/** Dettes fournisseurs : totaux en SQL (`getSuppliersSummary`) + détail par fournisseur. */
async function getPayables(): Promise<RapportPayables> {
  const [summary, rows] = await Promise.all([
    getSuppliersSummary(),
    rawAll<any>(
      `SELECT a.supplier_id,
              MAX(s.name)                     AS supplier_name,
              MAX(s.phone)                    AS phone,
              COUNT(*)                        AS invoice_count,
              COALESCE(SUM(a.remaining_amount), 0) AS balance,
              MIN(a.due_date)                 AS oldest_due
       FROM purchase_invoices a
       LEFT JOIN suppliers s ON s.id = a.supplier_id
       WHERE a.status = 'active' AND a.remaining_amount > 0.001 AND a.supplier_id IS NOT NULL
       GROUP BY a.supplier_id
       ORDER BY balance DESC
       LIMIT 12`,
    ),
  ]);

  const reference = today();

  return {
    total: Number(summary.totalPayables ?? 0),
    creditorsCount: Number(summary.debtorsCount ?? 0),
    items: rows.map((row) => {
      const oldestDueDate = row.oldest_due ?? null;
      return {
        supplierId: Number(row.supplier_id),
        supplierName: row.supplier_name ?? 'Fournisseur supprimé',
        phone: row.phone ?? null,
        balance: Number(row.balance ?? 0),
        invoiceCount: Number(row.invoice_count ?? 0),
        oldestDueDate,
        overdue: Boolean(oldestDueDate) && String(oldestDueDate) < reference,
      };
    }),
  };
}

/** Valeur du stock, alertes et ruptures (reprend `getStockSummary` et `listStockProducts`). */
async function getStockInsights(): Promise<RapportStockInsights> {
  const [summary, lowStock, outOfStock] = await Promise.all([
    getStockSummary(),
    listStockProducts({ lowStockOnly: true, limit: 50 }),
    listStockProducts({ outOfStockOnly: true, limit: 50 }),
  ]);

  const mapAlert = (product: {
    id: number;
    name: string;
    unit: string;
    stock: number;
    stockMin: number;
    stockValue: number;
  }) => ({
    productId: product.id,
    name: product.name,
    unit: product.unit,
    stock: Number(product.stock ?? 0),
    stockMin: Number(product.stockMin ?? 0),
    stockValue: Number(product.stockValue ?? 0),
  });

  // Une rupture n'est pas une « alerte » : les deux listes restent disjointes.
  const alerts = lowStock.data.filter((product) => !product.isOut).map(mapAlert);

  return {
    totalProducts: summary.totalProducts,
    purchaseValue: summary.totalStockValue,
    saleValue: summary.totalSaleValue,
    potentialMargin: summary.totalSaleValue - summary.totalStockValue,
    lowStockCount: summary.lowStockCount,
    outOfStockCount: summary.outOfStockCount,
    alerts,
    outOfStock: outOfStock.data.map(mapAlert),
  };
}

/* ------------------------------------------------------------------ *
 * Résumé décisionnel — 3 à 5 phrases, chacune adossée à un chiffre
 * ------------------------------------------------------------------ */

function buildDecisionSummary(data: {
  currency: string;
  summary: RapportData['summary'];
  comparison: RapportComparison;
  netProfit: RapportData['netProfit'];
  expenses: RapportData['expenses'];
  soldByProduct: RapportSoldProduct[];
  receivables: RapportReceivables;
  payables: RapportPayables;
  stockInsights: RapportStockInsights;
  jobCosts: RapportJobCosts;
}): string[] {
  const money = (value: number) => formatCurrency(value, data.currency);
  const sentences: string[] = [];

  /* 1. Chiffre d'affaires — la première phrase que le dirigeant lit. */
  const delta = data.comparison.revenue.deltaPercent;
  const salesWord = data.summary.salesCount > 1 ? 'ventes' : 'vente';

  if (data.summary.revenueTtc <= 0) {
    sentences.push(
      `Aucune vente facturée sur la période : le chiffre d'affaires est nul pour ${formatNumber(
        data.summary.salesCount,
      )} ${salesWord}.`,
    );
  } else if (delta === null) {
    sentences.push(
      `Le chiffre d'affaires atteint ${money(data.summary.revenueTtc)} pour ${formatNumber(
        data.summary.salesCount,
      )} ${salesWord}, sans base de comparaison sur la période précédente.`,
    );
  } else if (delta > 0) {
    sentences.push(
      `Le chiffre d'affaires progresse de ${formatPercent(delta)} par rapport à la période précédente, à ${money(
        data.summary.revenueTtc,
      )}.`,
    );
  } else if (delta < 0) {
    sentences.push(
      `Le chiffre d'affaires recule de ${formatPercent(Math.abs(delta))} par rapport à la période précédente, à ${money(
        data.summary.revenueTtc,
      )}.`,
    );
  } else {
    sentences.push(
      `Le chiffre d'affaires est stable par rapport à la période précédente, à ${money(data.summary.revenueTtc)}.`,
    );
  }

  /* 2. Bénéfice net — le second chiffre décisif. */
  const net = data.netProfit.netProfit;
  if (net > 0 && data.summary.revenueTtc > 0) {
    sentences.push(
      `Le bénéfice net s'établit à ${money(net)}, soit ${formatPercent(
        Math.round((net / data.summary.revenueTtc) * 1000) / 10,
      )} du chiffre d'affaires.`,
    );
  } else if (net > 0) {
    sentences.push(`Le bénéfice net s'établit à ${money(net)} sur la période.`);
  } else if (net < 0) {
    sentences.push(
      `Le bénéfice net est négatif (${money(net)}) : dépenses et main-d'œuvre dépassent la marge brute de ${money(
        data.netProfit.grossProfit,
      )}.`,
    );
  } else {
    sentences.push("Le bénéfice net est à l'équilibre sur la période.");
  }

  /* 3. Créances clients — concentration et ancienneté. */
  if (data.receivables.total > 0 && data.receivables.items.length > 0) {
    const top = data.receivables.items[0];
    const share = Math.round((top.balance / data.receivables.total) * 1000) / 10;
    const overdueCount = data.receivables.items.filter((item) => item.overdue).length;

    sentences.push(
      `${formatNumber(data.receivables.debtorsCount)} client${
        data.receivables.debtorsCount > 1 ? 's restent débiteurs' : ' reste débiteur'
      } pour ${money(data.receivables.total)} ; ${top.customerName} en porte à lui seul ${formatPercent(share)}${
        overdueCount > 0
          ? `, et ${formatNumber(overdueCount)} créance${overdueCount > 1 ? 's sont échues' : ' est échue'}`
          : ''
      }.`,
    );
  }

  /* 4. Stock — ruptures d'abord, alertes ensuite. */
  if (data.stockInsights.outOfStockCount > 0) {
    const names = data.stockInsights.outOfStock.slice(0, 3).map((item) => item.name).join(', ');
    sentences.push(
      `${formatNumber(data.stockInsights.outOfStockCount)} produit${
        data.stockInsights.outOfStockCount > 1 ? 's sont en rupture' : ' est en rupture'
      } : ${names}${data.stockInsights.outOfStockCount > 3 ? '…' : ''}.`,
    );
  } else if (data.stockInsights.lowStockCount > 0) {
    const first = data.stockInsights.alerts[0];
    sentences.push(
      `${formatNumber(data.stockInsights.lowStockCount)} produit${
        data.stockInsights.lowStockCount > 1 ? 's sont sous le seuil' : ' est sous le seuil'
      } d'alerte${first ? `, à commencer par ${first.name} (${formatNumber(first.stock)} ${first.unit})` : ''}.`,
    );
  }

  /* 5. Dettes fournisseurs. */
  if (data.payables.total > 0) {
    sentences.push(
      `Les dettes fournisseurs s'élèvent à ${money(data.payables.total)} auprès de ${formatNumber(
        data.payables.creditorsCount,
      )} fournisseur${data.payables.creditorsCount > 1 ? 's' : ''}.`,
    );
  }

  /* 6. Dépenses et produit le plus vendu — compléments factuels. */
  if (data.expenses.total > 0 && data.summary.revenueTtc > 0) {
    sentences.push(
      `Les dépenses représentent ${formatPercent(
        Math.round((data.expenses.total / data.summary.revenueTtc) * 1000) / 10,
      )} du chiffre d'affaires, soit ${money(data.expenses.total)} en ${formatNumber(
        data.expenses.count,
      )} écriture${data.expenses.count > 1 ? 's' : ''}.`,
    );
  }

  if (data.soldByProduct.length > 0 && data.soldByProduct[0].revenue > 0) {
    const top = data.soldByProduct[0];
    sentences.push(
      `${top.productName} est le produit le plus vendu : ${money(top.revenue)}, soit ${formatPercent(
        top.sharePercent,
      )} du chiffre d'affaires des produits vendus.`,
    );
  }

  /* Garde-fou : au moins trois phrases, même sur une période très calme. */
  if (sentences.length < 3) {
    sentences.push(
      `Le stock compte ${formatNumber(data.stockInsights.totalProducts)} produit${
        data.stockInsights.totalProducts > 1 ? 's actifs' : ' actif'
      } pour ${money(data.stockInsights.purchaseValue)} au prix d'achat.`,
    );
  }

  return sentences.slice(0, 5);
}

/* ------------------------------------------------------------------ *
 * Point d'entrée
 * ------------------------------------------------------------------ */

/**
 * Construit **toutes** les données d'un rapport pour une période et des filtres
 * donnés. Une seule fonction : la page, le message d'envoi et les exports
 * partagent exactement les mêmes chiffres.
 */
export async function getRapportData(filters: RapportFilters): Promise<RapportData> {
  const from = String(filters.from);
  const to = String(filters.to);

  const fallbackPrevious = previousPeriod(from, to);
  const previousFrom = filters.previousFrom || fallbackPrevious.from;
  const previousTo = filters.previousTo || fallbackPrevious.to;

  const currentSales = salesScope(filters, { from, to });
  const previousSales = salesScope(filters, { from: previousFrom, to: previousTo });
  const currentJobs = jobsScope(filters, { from, to });
  const previousJobs = jobsScope(filters, { from: previousFrom, to: previousTo });

  /* ------------------------- 1. Agrégats parallèles ------------------------ */

  const [
    salesRow,
    previousSalesRow,
    jobsRow,
    previousJobsRow,
    cashSummary,
    paymentsSummary,
    expenses,
    currentMetrics,
    previousMetrics,
    jobCosts,
  ] = await Promise.all([
    rawGet<any>(
      `SELECT COUNT(*)                                  AS count,
              COALESCE(SUM(v.total), 0)                 AS total,
              COALESCE(SUM(v.total_ht), 0)              AS total_ht,
              COALESCE(SUM(v.tax_amount), 0)            AS tax_amount,
              COALESCE(SUM(v.remaining_amount), 0)      AS outstanding
       FROM sales_invoices v
       WHERE ${currentSales.sql}`,
      currentSales.args,
    ),
    rawGet<any>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(v.total), 0) AS total
       FROM sales_invoices v
       WHERE ${previousSales.sql}`,
      previousSales.args,
    ),
    rawGet<any>(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(j.total), 0)            AS revenue,
              COALESCE(SUM(j.remaining_amount), 0) AS outstanding
       FROM service_jobs j
       WHERE ${currentJobs.sql}`,
      currentJobs.args,
    ),
    rawGet<any>(
      `SELECT COALESCE(SUM(j.total), 0) AS revenue
       FROM service_jobs j
       WHERE ${previousJobs.sql}`,
      previousJobs.args,
    ),
    getCashSummary({ from, to }),
    getPaymentsSummary({ from, to }),
    getExpensesAggregate(from, to),
    calculateSalesProfitMetrics(from, to),
    calculateSalesProfitMetrics(previousFrom, previousTo),
    getJobCosts(from, to),
  ]);

  /* --------------------------- 2. Synthèse --------------------------------- */

  const collectedRow = await rawGet<{ total: number | null }>(
    `SELECT COALESCE(SUM(p.amount), 0) AS total
     FROM payments p
     WHERE p.date >= ? AND p.date <= ? AND p.type <> 'purchase'`,
    [from, to],
  );

  const collected = Number(collectedRow?.total ?? 0);

  const collectedByMethodMap = new Map<string, { total: number; count: number }>();
  for (const row of paymentsSummary) {
    if (row.type === 'purchase') continue;
    const current = collectedByMethodMap.get(row.paymentMethod) ?? { total: 0, count: 0 };
    collectedByMethodMap.set(row.paymentMethod, {
      total: current.total + row.total,
      count: current.count + row.count,
    });
  }

  const salesTotal = Number(salesRow?.total ?? 0);
  const salesTotalHt = Number(salesRow?.total_ht ?? 0);
  const salesCount = Number(salesRow?.count ?? 0);
  const jobsRevenue = Number(jobsRow?.revenue ?? 0);

  const revenueTtc = salesTotal + jobsRevenue;
  const revenueHt = salesTotalHt + jobsRevenue;
  const outstanding = Number(salesRow?.outstanding ?? 0) + Number(jobsRow?.outstanding ?? 0);

  const netProfit = currentMetrics.grossProfit - expenses.total - jobCosts.totalLaborCost;

  const comparison: RapportComparison = {
    revenue: {
      current: revenueTtc,
      previous: Number(previousSalesRow?.total ?? 0) + Number(previousJobsRow?.revenue ?? 0),
      deltaPercent: 0,
    },
    margin: {
      current: currentMetrics.grossProfit,
      previous: previousMetrics.grossProfit,
      deltaPercent: 0,
    },
    salesCount: {
      current: salesCount,
      previous: Number(previousSalesRow?.count ?? 0),
      deltaPercent: 0,
    },
  };

  comparison.revenue.deltaPercent = computeDelta(comparison.revenue.current, comparison.revenue.previous);
  comparison.margin.deltaPercent = computeDelta(comparison.margin.current, comparison.margin.previous);
  comparison.salesCount.deltaPercent = computeDelta(
    comparison.salesCount.current,
    comparison.salesCount.previous,
  );

  /* ------------------------- 3. Séries mensuelles -------------------------- */

  const monthKeys = buildMonthKeys(to, 12);
  const monthlyFrom = `${monthKeys[0]}-01`;
  const monthlyTo = endOfMonth(`${monthKeys[monthKeys.length - 1]}-01`);
  const monthlyRange = { from: monthlyFrom, to: monthlyTo };

  const monthlySalesScope = salesScope(filters, monthlyRange);
  const monthlyPurchasesScope = purchasesScope(filters, monthlyRange);

  const [monthlyRevenue, monthlyPurchases, monthlyExpenses] = await Promise.all([
    rawAll<{ month: string; total: number | null }>(
      `SELECT substr(v.date, 1, 7) AS month, COALESCE(SUM(v.total), 0) AS total
       FROM sales_invoices v
       WHERE ${monthlySalesScope.sql}
       GROUP BY month
       ORDER BY month`,
      monthlySalesScope.args,
    ),
    rawAll<{ month: string; total: number | null }>(
      `SELECT substr(p.date, 1, 7) AS month, COALESCE(SUM(p.total), 0) AS total
       FROM purchase_invoices p
       WHERE ${monthlyPurchasesScope.sql}
       GROUP BY month
       ORDER BY month`,
      monthlyPurchasesScope.args,
    ),
    rawAll<{ month: string; total: number | null }>(
      `SELECT substr(e.date, 1, 7) AS month, COALESCE(SUM(e.amount), 0) AS total
       FROM expenses e
       WHERE e.deleted_at IS NULL AND e.date >= ? AND e.date <= ?
       GROUP BY month
       ORDER BY month`,
      [monthlyFrom, monthlyTo],
    ),
  ]);

  const revenueByMonth = new Map(monthlyRevenue.map((row) => [row.month, Number(row.total ?? 0)]));
  const purchasesByMonth = new Map(monthlyPurchases.map((row) => [row.month, Number(row.total ?? 0)]));
  const expensesByMonth = new Map(monthlyExpenses.map((row) => [row.month, Number(row.total ?? 0)]));

  // Les trois séries partagent **exactement** les mêmes abscisses.
  const monthlyData = monthKeys.map((month) => ({
    month,
    revenue: revenueByMonth.get(month) ?? 0,
    purchases: purchasesByMonth.get(month) ?? 0,
    expenses: expensesByMonth.get(month) ?? 0,
  }));

  /* --------------------------- 4. Produits vendus -------------------------- */

  const soldScope = salesScope(filters, { from, to }, { includeProduct: false });
  const productCondition = filters.productId ? 'AND i.product_id = ?' : '';
  const soldArgs: SqlArg[] = filters.productId
    ? [...soldScope.args, filters.productId]
    : [...soldScope.args];

  const [soldRows, soldTotalRow] = await Promise.all([
    rawAll<any>(
      `SELECT i.product_id,
              MAX(i.product_name)            AS product_name,
              MAX(i.unit)                    AS unit,
              COALESCE(SUM(i.quantity), 0)   AS quantity,
              COALESCE(SUM(i.amount), 0)     AS revenue
       FROM sales_invoice_items i
       JOIN sales_invoices v ON v.id = i.invoice_id
       WHERE ${soldScope.sql} ${productCondition}
       GROUP BY i.product_id
       ORDER BY revenue DESC
       LIMIT 50`,
      soldArgs,
    ),
    rawGet<{ total: number | null }>(
      `SELECT COALESCE(SUM(i.amount), 0) AS total
       FROM sales_invoice_items i
       JOIN sales_invoices v ON v.id = i.invoice_id
       WHERE ${soldScope.sql} ${productCondition}`,
      soldArgs,
    ),
  ]);

  const soldTotal = Number(soldTotalRow?.total ?? 0);
  const soldByProduct: RapportSoldProduct[] = soldRows.map((row) => {
    const revenue = Number(row.revenue ?? 0);
    return {
      productId: row.product_id == null ? null : Number(row.product_id),
      productName: row.product_name ?? 'Produit supprimé',
      unit: row.unit ?? '',
      quantity: Number(row.quantity ?? 0),
      revenue,
      sharePercent: soldTotal > 0 ? Math.round((revenue / soldTotal) * 1000) / 10 : 0,
    };
  });

  /* --------------------------- 5. Marges produits -------------------------- */

  const margins = await getProductMargins(from, to, 50);
  const productMargins = filters.productId
    ? margins.filter((row) => row.productId === filters.productId)
    : margins;

  /* --------------------------- 6. Meilleurs clients ------------------------ */

  const topCustomerRows = await rawAll<any>(
    `SELECT v.customer_id,
            MAX(v.customer_name)                   AS customer_name,
            COUNT(*)                               AS sales_count,
            COALESCE(SUM(v.total), 0)              AS revenue,
            COALESCE(SUM(v.amount_paid), 0)        AS collected,
            COALESCE(SUM(v.remaining_amount), 0)   AS outstanding
     FROM sales_invoices v
     WHERE ${currentSales.sql} AND v.customer_id IS NOT NULL
     GROUP BY v.customer_id
     ORDER BY revenue DESC
     LIMIT 10`,
    currentSales.args,
  );

  const topCustomers: RapportTopCustomer[] = topCustomerRows.map((row) => ({
    customerId: Number(row.customer_id),
    customerName: row.customer_name ?? 'Client supprimé',
    salesCount: Number(row.sales_count ?? 0),
    revenue: Number(row.revenue ?? 0),
    collected: Number(row.collected ?? 0),
    outstanding: Number(row.outstanding ?? 0),
  }));

  /* --------------------- 7. Créances, dettes, stock ------------------------ */

  const [receivables, payables, stockInsights, settings] = await Promise.all([
    getReceivables(),
    getPayables(),
    getStockInsights(),
    getSettings(),
  ]);

  /* --------------------------- 8. Assemblage ------------------------------- */

  const summary: RapportData['summary'] = {
    revenueTtc,
    revenueHt,
    salesCount,
    averageBasket: salesCount > 0 ? salesTotal / salesCount : 0,
    collected,
    collectedByMethod: [...collectedByMethodMap.entries()]
      .map(([method, value]) => ({ method, total: value.total, count: value.count }))
      .sort((a, b) => b.total - a.total),
    outstanding,
    expenses: expenses.total,
    netProfit,
    cash: {
      balance: cashSummary.balance,
      income: cashSummary.incomeTotal,
      expense: cashSummary.expenseTotal,
      net: cashSummary.incomeTotal - cashSummary.expenseTotal,
      byMethod: cashSummary.byMethod,
      // Une session ouverte fait basculer le résumé sur la session en cours :
      // on le transporte pour que l'écran le dise au lieu de laisser croire
      // qu'il s'agit de la période.
      sessionStatus: cashSummary.sessionStatus,
    },
  };

  const netProfitSection: RapportData['netProfit'] = {
    revenue: currentMetrics.revenue,
    cogs: currentMetrics.cogs,
    grossProfit: currentMetrics.grossProfit,
    grossMarginPercent: currentMetrics.grossMarginPercent,
    expenses: expenses.total,
    laborCost: jobCosts.totalLaborCost,
    netProfit,
  };

  const decisionSummary = buildDecisionSummary({
    currency: settings.currency,
    summary,
    comparison,
    netProfit: netProfitSection,
    expenses,
    soldByProduct,
    receivables,
    payables,
    stockInsights,
    jobCosts,
  });

  return {
    period: { from, to, label: periodLabel(from, to) },
    previousPeriod: { from: previousFrom, to: previousTo },
    summary,
    comparison,
    monthlyData,
    soldByProduct,
    productMargins,
    topCustomers,
    receivables,
    payables,
    stockInsights,
    decisionSummary,
    expenses,
    netProfit: netProfitSection,
    jobCosts,
  };
}
