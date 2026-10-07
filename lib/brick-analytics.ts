/**
 * Tableau de bord, rapports et rentabilité de la briqueterie (README §20).
 *
 * ## Tout est calculé à la lecture
 *
 * Aucun total n'est stocké (invariant §6.5 règle 6) : ce module ne fait que
 * **lire** les tables écrites par les autres (`brick_productions`,
 * `stock_movements`, `sales_invoices`, `expenses`, `brick_orders`) et agréger.
 * Conséquence directe : une correction de dépense ou l'annulation d'une vente se
 * répercute immédiatement sur le tableau de bord, sans recalcul à lancer.
 *
 * ## Deux sources d'argent, jamais mélangées
 *
 *  - **Dépenses de production** : `expenses` avec
 *    `reference_type = 'brick_production'` — rattachées à un lot, elles entrent
 *    dans le **coût de production**.
 *  - **Dépenses générales** : toutes les autres — elles sortent du **résultat
 *    estimé**, jamais du coût de revient d'une brique (sinon un loyer
 *    augmenterait le prix de revient d'un lot qui n'y est pour rien).
 *
 * ## Périmètre des ventes
 *
 * Les ventes de briques sont celles du **canal `brick`** : c'est exactement ce
 * que produit `/ventes/nouvelle?canal=briqueterie`. Les ventes du commerce
 * général ne sont donc jamais comptées ici, et réciproquement `channel` protège
 * `/ventes` des ventes de briques.
 */

import { rawAll, rawGet } from '@/db';
import { roundMoney, startOfMonth, startOfWeek, today } from '@/lib/format';
import { PRODUCTION_DATE, PRODUCTION_EXPENSE_REFERENCE, TOTAL_COST_SQL } from '@/lib/brick';
import { BRICK_ORDER_STATUSES, type BrickOrderStatus } from '@/lib/brick-orders';
import { scopeSql, type StoreScope } from '@/lib/stores';

/*
 * v2 (README §30) : toutes les lectures portent sur une **portée de magasins** ;
 * le coût d'un lot est `TOTAL_COST_SQL` (équipe + dépenses rattachées
 * validées), plus une colonne recopiée ; une dépense ne compte qu'**approuvée**
 * (ou à décaisser pour un lot), comme dans `lib/profit.ts` et les chantiers.
 */
const COUNTED_PRODUCTION_EXPENSE = `e.deleted_at IS NULL AND e.approval_status IN ('approved', 'to_pay')`;
const COUNTED_EXPENSE = `deleted_at IS NULL AND approval_status = 'approved'`;

export type BrickPeriod = { from: string; to: string; label: string };

export type BrickStockLine = {
  brickTypeId: number;
  brickTypeName: string;
  storeId: number;
  storeName: string | null;
  shape: string;
  dimensions: string | null;
  productId: number;
  productName: string;
  unit: string;
  salePrice: number;
  purchasePrice: number;
  stock: number;
  stockMin: number;
  /** Coût de revient moyen constaté (calculé depuis les lots terminés). */
  averageUnitCost: number;
  isLow: boolean;
  isOut: boolean;
  stockValue: number;
  saleValue: number;
  potentialMargin: number;
};

export type BrickDashboard = {
  /** Mois en cours — les cartes « du mois » et les graphiques le partagent. */
  period: BrickPeriod;
  production: {
    today: number;
    week: number;
    month: number;
    /** Coût des lots fabriqués sur le mois (dépenses + main-d'œuvre). */
    monthCost: number;
    monthLots: number;
    monthBroken: number;
    /** Coût de revient unitaire moyen du mois. */
    monthUnitCost: number;
  };
  sales: {
    today: number;
    todayCount: number;
    month: number;
    monthCount: number;
    year: number;
    yearCount: number;
  };
  /** Encaissé et reste à recevoir sur les ventes de briques **validées**. */
  collected: number;
  outstanding: number;
  expenses: {
    /** Dépenses rattachées aux lots du mois. */
    productionMonth: number;
    /** Frais de fonctionnement du mois. */
    generalMonth: number;
  };
  profitability: {
    revenue: number;
    productionCost: number;
    grossMargin: number;
    generalExpenses: number;
    estimatedResult: number;
    marginRate: number;
  };
  stock: {
    lines: BrickStockLine[];
    totalQuantity: number;
    totalPurchaseValue: number;
    totalSaleValue: number;
    lowCount: number;
    outCount: number;
  };
  orders: Record<BrickOrderStatus, number>;
  /** Production du mois par type de brique — alimente le tableau « par produit ». */
  productionByType: {
    brickTypeId: number;
    brickTypeName: string;
    lots: number;
    produced: number;
    broken: number;
    cost: number;
    unitCost: number;
  }[];
  charts: {
    production: { date: string; produced: number; cost: number }[];
    sales: { date: string; revenue: number; quantity: number }[];
    expenses: { date: string; production: number; general: number }[];
  };
  topProducts: { productName: string; quantity: number; revenue: number }[];
  alerts: { brickTypeId: number; name: string; stock: number; stockMin: number; unit: string }[];
};

/* ------------------------------------------------------------------ *
 * Utilitaires de période
 * ------------------------------------------------------------------ */

function rangeOf(reference: string) {
  return {
    day: { from: reference, to: reference },
    week: { from: startOfWeek(reference), to: reference },
    month: { from: startOfMonth(reference), to: reference },
    year: { from: `${reference.slice(0, 4)}-01-01`, to: reference },
  };
}

/** Une somme bornée sur `[from, to]`, sur une expression SQL donnée. */
async function sumBetween(
  expression: string,
  from: string,
  to: string,
  where: string[],
  args: (string | number)[] = [],
): Promise<number> {
  const row = await rawGet<{ total: number | null }>(
    `SELECT COALESCE(SUM(${expression}), 0) AS total ${where.join(' ')}`,
    [...args, from, to],
  );
  return roundMoney(Number(row?.total ?? 0));
}

/* ------------------------------------------------------------------ *
 * Stock des produits finis
 * ------------------------------------------------------------------ */

/**
 * Le stock d'un type de brique est celui de son **produit lié** : il n'est jamais
 * lu ailleurs que dans `products.stock`, lui-même somme des `stock_movements`
 * (§12). Une seule source, donc aucun risque d'écart entre le stock affiché ici
 * et celui de `/stocks`.
 */
export async function listBrickStock(scope: StoreScope): Promise<BrickStockLine[]> {
  const rows = await rawAll<{
    brick_type_id: number;
    brick_type_name: string;
    shape: string;
    dimensions: string | null;
    product_id: number;
    product_name: string;
    unit: string;
    sale_price: number;
    purchase_price: number;
    stock: number;
    stock_min: number;
    is_active: number;
    average_unit_cost: number | null;
    store_id: number;
    store_name: string | null;
  }>(
    `SELECT bt.id AS brick_type_id, bt.name AS brick_type_name, bt.shape, bt.dimensions,
            p.id AS product_id, p.name AS product_name, p.unit, p.sale_price, p.purchase_price,
            COALESCE((SELECT ps.quantity FROM product_stocks ps WHERE ps.product_id = p.id AND ps.store_id = bt.store_id), 0) AS stock,
            COALESCE((SELECT ps.stock_min FROM product_stocks ps WHERE ps.product_id = p.id AND ps.store_id = bt.store_id), p.stock_min) AS stock_min,
            p.is_active, s.name AS store_name, bt.store_id,
            (SELECT CASE WHEN SUM(bp.produced_quantity - bp.broken_quantity) > 0
                         THEN SUM(${TOTAL_COST_SQL.replace(/p\.id/g, 'bp.id')}) / SUM(bp.produced_quantity - bp.broken_quantity)
                         ELSE 0 END
               FROM brick_productions bp
              WHERE bp.brick_type_id = bt.id AND bp.status <> 'cancelled') AS average_unit_cost
     FROM brick_types bt
     INNER JOIN products p ON p.id = bt.product_id
     LEFT JOIN stores s ON s.id = bt.store_id
     WHERE ${scopeSql('bt.store_id', scope)}
     ORDER BY bt.name COLLATE NOCASE`,
  );

  return rows.map((row) => {
    const stock = Number(row.stock ?? 0);
    const stockMin = Number(row.stock_min ?? 0);
    const salePrice = Number(row.sale_price ?? 0);

    return {
      brickTypeId: Number(row.brick_type_id),
      brickTypeName: row.brick_type_name,
      storeId: Number(row.store_id),
      storeName: row.store_name ?? null,
      shape: row.shape,
      dimensions: row.dimensions,
      productId: Number(row.product_id),
      productName: row.product_name,
      unit: row.unit,
      salePrice,
      purchasePrice: Number(row.purchase_price ?? 0),
      stock,
      stockMin,
      averageUnitCost: roundMoney(Number(row.average_unit_cost ?? 0)),
      isLow: stockMin > 0 && stock <= stockMin,
      isOut: stock <= 0,
      stockValue: roundMoney(stock * Number(row.purchase_price ?? 0)),
      saleValue: roundMoney(stock * salePrice),
      potentialMargin: roundMoney(stock * (salePrice - Number(row.purchase_price ?? 0))),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Tableau de bord
 * ------------------------------------------------------------------ */

export async function getBrickDashboard(scope: StoreScope, reference = today()): Promise<BrickDashboard> {
  const PS = scopeSql('p.store_id', scope);
  const VS = scopeSql('store_id', scope);
  const VVS = scopeSql('v.store_id', scope);
  const ES = scopeSql('e.store_id', scope);
  const EXS = scopeSql('store_id', scope);
  const PAYS = scopeSql('p.store_id', scope);
  const ranges = rangeOf(reference);
  const month = ranges.month;
  const year = ranges.year;

  const productionWhere = ['FROM brick_productions p', `WHERE p.status <> 'cancelled' AND ${PS}`, `AND ${PRODUCTION_DATE} >= ?`, `AND ${PRODUCTION_DATE} <= ?`];

  const [prodToday, prodWeek, prodMonth, prodMonthLots, brokenMonth] = await Promise.all([
    sumBetween('p.produced_quantity', ranges.day.from, ranges.day.to, productionWhere),
    sumBetween('p.produced_quantity', ranges.week.from, ranges.week.to, productionWhere),
    sumBetween('p.produced_quantity', month.from, month.to, productionWhere),
    rawGet<{ lots: number; cost: number | null; broken: number | null }>(
      `SELECT COUNT(*) AS lots,
              COALESCE(SUM(${TOTAL_COST_SQL}), 0) AS cost,
              COALESCE(SUM(p.broken_quantity), 0) AS broken
         FROM brick_productions p
        WHERE p.status <> 'cancelled' AND ${PS} AND ${PRODUCTION_DATE} >= ? AND ${PRODUCTION_DATE} <= ?`,
      [month.from, month.to],
    ),
    sumBetween('p.broken_quantity', month.from, month.to, productionWhere),
  ]);

  const salesBase = [
    'FROM sales_invoices',
    `WHERE status = 'active' AND channel = 'brick' AND ${VS}`,
    'AND date >= ?',
    'AND date <= ?',
  ];

  const [salesToday, salesTodayCount, salesMonth, salesMonthCount, salesYear, salesYearCount] =
    await Promise.all([
      sumBetween('total', ranges.day.from, ranges.day.to, salesBase),
      rawGet<{ c: number }>(
        `SELECT COUNT(*) AS c FROM sales_invoices WHERE status = 'active' AND channel = 'brick' AND ${VS} AND date >= ? AND date <= ?`,
        [ranges.day.from, ranges.day.to],
      ),
      sumBetween('total', month.from, month.to, salesBase),
      rawGet<{ c: number }>(
        `SELECT COUNT(*) AS c FROM sales_invoices WHERE status = 'active' AND channel = 'brick' AND ${VS} AND date >= ? AND date <= ?`,
        [month.from, month.to],
      ),
      sumBetween('total', year.from, year.to, salesBase),
      rawGet<{ c: number }>(
        `SELECT COUNT(*) AS c FROM sales_invoices WHERE status = 'active' AND channel = 'brick' AND ${VS} AND date >= ? AND date <= ?`,
        [year.from, year.to],
      ),
    ]);

  const receivables = await rawGet<{ collected: number | null; outstanding: number | null }>(
    `SELECT COALESCE(SUM(amount_paid), 0) AS collected,
            COALESCE(SUM(remaining_amount), 0) AS outstanding
       FROM sales_invoices
      WHERE status = 'active' AND channel = 'brick' AND ${VS}`,
  );

  // Dépenses de production rattachées aux lots du mois.
  const productionExpensesMonth = await rawGet<{ total: number | null }>(
    `SELECT COALESCE(SUM(e.amount), 0) AS total
       FROM expenses e
      WHERE ${COUNTED_PRODUCTION_EXPENSE} AND ${ES} AND e.reference_type = ?
        AND e.reference_id IN (
          SELECT p.id FROM brick_productions p
           WHERE p.status <> 'cancelled' AND ${PS} AND ${PRODUCTION_DATE} >= ? AND ${PRODUCTION_DATE} <= ?)`,
    [PRODUCTION_EXPENSE_REFERENCE, month.from, month.to],
  );

  // Dépenses générales du mois : tout ce qui n'est pas rattaché à un lot.
  const generalExpensesMonth = await rawGet<{ total: number | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM expenses
      WHERE ${COUNTED_EXPENSE} AND ${EXS} AND date >= ? AND date <= ?
        AND (reference_type IS NULL OR reference_type <> ?)`,
    [month.from, month.to, PRODUCTION_EXPENSE_REFERENCE],
  );

  const stockLines = await listBrickStock(scope);
  const stock = {
    lines: stockLines,
    totalQuantity: roundMoney(stockLines.reduce((sum, line) => sum + line.stock, 0)),
    totalPurchaseValue: roundMoney(stockLines.reduce((sum, line) => sum + line.stockValue, 0)),
    totalSaleValue: roundMoney(stockLines.reduce((sum, line) => sum + line.saleValue, 0)),
    lowCount: stockLines.filter((line) => line.isLow && !line.isOut).length,
    outCount: stockLines.filter((line) => line.isOut).length,
  };

  const orderRows = await rawAll<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM brick_orders WHERE ${VS} GROUP BY status`,
  );
  const orders = Object.fromEntries(
    BRICK_ORDER_STATUSES.map((status) => [status, 0]),
  ) as Record<BrickOrderStatus, number>;
  for (const row of orderRows) {
    if ((BRICK_ORDER_STATUSES as readonly string[]).includes(row.status)) {
      orders[row.status as BrickOrderStatus] = Number(row.count ?? 0);
    }
  }

  // ── Séries des graphiques : 30 derniers jours, jours vides inclus ──
  const chartFrom = shiftDays(reference, -29);

  const producedRows = await rawAll<{ date: string; produced: number | null; cost: number | null }>(
    `SELECT ${PRODUCTION_DATE} AS date,
            COALESCE(SUM(p.produced_quantity), 0) AS produced,
            COALESCE(SUM(${TOTAL_COST_SQL}), 0) AS cost
       FROM brick_productions p
      WHERE p.status <> 'cancelled' AND ${PS} AND ${PRODUCTION_DATE} >= ? AND ${PRODUCTION_DATE} <= ?
      GROUP BY date`,
    [chartFrom, reference],
  );

  const soldRows = await rawAll<{ date: string; revenue: number | null; quantity: number | null }>(
    `SELECT v.date AS date,
            COALESCE(SUM(v.total), 0) AS revenue,
            COALESCE(SUM((SELECT COALESCE(SUM(i.quantity), 0) FROM sales_invoice_items i WHERE i.invoice_id = v.id)), 0) AS quantity
       FROM sales_invoices v
      WHERE v.status = 'active' AND v.channel = 'brick' AND ${VVS} AND v.date >= ? AND v.date <= ?
      GROUP BY v.date`,
    [chartFrom, reference],
  );

  const expenseRows = await rawAll<{ date: string; production: number | null; general: number | null }>(
    `SELECT date,
            COALESCE(SUM(CASE WHEN reference_type = ? THEN amount ELSE 0 END), 0) AS production,
            COALESCE(SUM(CASE WHEN reference_type IS NULL OR reference_type <> ? THEN amount ELSE 0 END), 0) AS general
       FROM expenses
      WHERE ${COUNTED_EXPENSE} AND ${EXS} AND date >= ? AND date <= ?
      GROUP BY date`,
    [PRODUCTION_EXPENSE_REFERENCE, PRODUCTION_EXPENSE_REFERENCE, chartFrom, reference],
  );

  const productionByTypeRows = await rawAll<{
    brick_type_id: number;
    brick_type_name: string;
    lots: number;
    produced: number | null;
    broken: number | null;
    cost: number | null;
  }>(
    `SELECT bt.id AS brick_type_id, bt.name AS brick_type_name,
            COUNT(*) AS lots,
            COALESCE(SUM(p.produced_quantity), 0) AS produced,
            COALESCE(SUM(p.broken_quantity), 0) AS broken,
            COALESCE(SUM(${TOTAL_COST_SQL}), 0) AS cost
       FROM brick_productions p
       INNER JOIN brick_types bt ON bt.id = p.brick_type_id
      WHERE p.status <> 'cancelled' AND ${PS} AND ${PRODUCTION_DATE} >= ? AND ${PRODUCTION_DATE} <= ?
      GROUP BY bt.id, bt.name
      ORDER BY produced DESC`,
    [month.from, month.to],
  );

  const topProducts = await rawAll<{ product_name: string; quantity: number | null; revenue: number | null }>(
    `SELECT i.product_name AS product_name,
            COALESCE(SUM(i.quantity), 0) AS quantity,
            COALESCE(SUM(i.amount), 0) AS revenue
       FROM sales_invoice_items i
       INNER JOIN sales_invoices v ON v.id = i.invoice_id
      WHERE v.status = 'active' AND v.channel = 'brick' AND ${VVS} AND v.date >= ? AND v.date <= ?
      GROUP BY i.product_name
      ORDER BY revenue DESC
      LIMIT 8`,
    [month.from, month.to],
  );

  const days = listDays(chartFrom, reference);
  const producedByDate = new Map(producedRows.map((row) => [row.date, row]));
  const soldByDate = new Map(soldRows.map((row) => [row.date, row]));
  const expenseByDate = new Map(expenseRows.map((row) => [row.date, row]));

  const monthCost = roundMoney(Number(prodMonthLots?.cost ?? 0));
  const producedMonth = prodMonth;
  const goodMonth = roundMoney(producedMonth - brokenMonth);

  const revenue = salesMonth;
  const productionCost = monthCost;
  const grossMargin = roundMoney(revenue - productionCost);
  const generalExpenses = roundMoney(Number(generalExpensesMonth?.total ?? 0));

  return {
    period: { from: month.from, to: month.to, label: 'Mois en cours' },
    production: {
      today: prodToday,
      week: prodWeek,
      month: producedMonth,
      monthCost,
      monthLots: Number(prodMonthLots?.lots ?? 0),
      monthBroken: brokenMonth,
      monthUnitCost: goodMonth > 0 ? Math.round((monthCost / goodMonth) * 100) / 100 : 0,
    },
    sales: {
      today: salesToday,
      todayCount: Number(salesTodayCount?.c ?? 0),
      month: salesMonth,
      monthCount: Number(salesMonthCount?.c ?? 0),
      year: salesYear,
      yearCount: Number(salesYearCount?.c ?? 0),
    },
    collected: roundMoney(Number(receivables?.collected ?? 0)),
    outstanding: roundMoney(Number(receivables?.outstanding ?? 0)),
    expenses: {
      productionMonth: roundMoney(Number(productionExpensesMonth?.total ?? 0)),
      generalMonth: generalExpenses,
    },
    profitability: {
      revenue,
      productionCost,
      grossMargin,
      generalExpenses,
      estimatedResult: roundMoney(grossMargin - generalExpenses),
      marginRate: revenue > 0 ? Math.round((grossMargin / revenue) * 10000) / 100 : 0,
    },
    stock,
    orders,
    productionByType: productionByTypeRows.map((row) => {
      const produced = Number(row.produced ?? 0);
      const broken = Number(row.broken ?? 0);
      const good = Math.max(0, produced - broken);
      const cost = roundMoney(Number(row.cost ?? 0));
      return {
        brickTypeId: Number(row.brick_type_id),
        brickTypeName: row.brick_type_name,
        lots: Number(row.lots ?? 0),
        produced: roundMoney(produced),
        broken: roundMoney(broken),
        cost,
        unitCost: good > 0 ? Math.round((cost / good) * 100) / 100 : 0,
      };
    }),
    charts: {
      production: days.map((date) => ({
        date,
        produced: Number(producedByDate.get(date)?.produced ?? 0),
        cost: roundMoney(Number(producedByDate.get(date)?.cost ?? 0)),
      })),
      sales: days.map((date) => ({
        date,
        revenue: roundMoney(Number(soldByDate.get(date)?.revenue ?? 0)),
        quantity: Number(soldByDate.get(date)?.quantity ?? 0),
      })),
      expenses: days.map((date) => ({
        date,
        production: roundMoney(Number(expenseByDate.get(date)?.production ?? 0)),
        general: roundMoney(Number(expenseByDate.get(date)?.general ?? 0)),
      })),
    },
    topProducts: topProducts.map((row) => ({
      productName: row.product_name,
      quantity: Number(row.quantity ?? 0),
      revenue: roundMoney(Number(row.revenue ?? 0)),
    })),
    alerts: stockLines
      .filter((line) => line.isLow || line.isOut)
      .map((line) => ({
        brickTypeId: line.brickTypeId,
        name: line.brickTypeName,
        stock: line.stock,
        stockMin: line.stockMin,
        unit: line.unit,
      })),
  };
}

/* ------------------------------------------------------------------ *
 * Dates — petites utiles locales
 * ------------------------------------------------------------------ */

function shiftDays(reference: string, delta: number): string {
  const date = new Date(`${reference}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Tous les jours entre deux bornes incluses — un graphique ne doit pas avoir de trou. */
function listDays(from: string, to: string, max = 400): string[] {
  const days: string[] = [];
  let current = from;
  while (current <= to && days.length < max) {
    days.push(current);
    current = shiftDays(current, 1);
  }
  return days;
}

/* ------------------------------------------------------------------ *
 * Rapports (§20, point 9)
 * ------------------------------------------------------------------ */

export type BrickReports = {
  from: string;
  to: string;
  productionByDay: { date: string; lots: number; produced: number; broken: number; cost: number }[];
  productionByType: {
    brickTypeId: number;
    brickTypeName: string;
    lots: number;
    produced: number;
    broken: number;
    cost: number;
    unitCost: number;
  }[];
  expensesByProduction: {
    batchNumber: string;
    date: string;
    brickTypeName: string;
    category: string;
    amount: number;
    count: number;
  }[];
  generalExpensesByCategory: { category: string; total: number; count: number }[];
  salesByPeriod: { date: string; count: number; revenue: number; collected: number; outstanding: number }[];
  salesByProduct: { productName: string; quantity: number; revenue: number }[];
  salesByCustomer: { customerName: string; count: number; revenue: number; outstanding: number }[];
  receivables: {
    customerName: string;
    phone: string | null;
    invoiceCount: number;
    balance: number;
    oldestDueDate: string | null;
  }[];
  paymentsByMethod: { paymentMethod: string; total: number; count: number }[];
  stock: BrickStockLine[];
  losses: {
    batchNumber: string;
    date: string;
    brickTypeName: string;
    brokenQuantity: number;
    reason: string | null;
  }[];
  profitabilityByProduct: {
    brickTypeId: number;
    brickTypeName: string;
    quantitySold: number;
    revenue: number;
    productionCost: number;
    margin: number;
    marginRate: number;
  }[];
  profitability: {
    revenue: number;
    productionCost: number;
    grossMargin: number;
    generalExpenses: number;
    estimatedResult: number;
    marginRate: number;
    producedQuantity: number;
    unitCost: number;
  };
};

export async function getBrickReports(from: string, to: string, scope: StoreScope): Promise<BrickReports> {
  const PS = scopeSql('p.store_id', scope);
  const VS = scopeSql('store_id', scope);
  const VVS = scopeSql('v.store_id', scope);
  const ES = scopeSql('e.store_id', scope);
  const EXS = scopeSql('store_id', scope);
  const PAYS = scopeSql('p.store_id', scope);
  const productionByDay = await rawAll<any>(
    `SELECT ${PRODUCTION_DATE} AS date,
            COUNT(*) AS lots,
            COALESCE(SUM(p.produced_quantity), 0) AS produced,
            COALESCE(SUM(p.broken_quantity), 0) AS broken,
            COALESCE(SUM(${TOTAL_COST_SQL}), 0) AS cost
       FROM brick_productions p
      WHERE p.status <> 'cancelled' AND ${PS} AND ${PRODUCTION_DATE} >= ? AND ${PRODUCTION_DATE} <= ?
      GROUP BY date
      ORDER BY date ASC`,
    [from, to],
  );

  const productionByType = await rawAll<any>(
    `SELECT bt.id AS brick_type_id, bt.name AS brick_type_name,
            COUNT(*) AS lots,
            COALESCE(SUM(p.produced_quantity), 0) AS produced,
            COALESCE(SUM(p.broken_quantity), 0) AS broken,
            COALESCE(SUM(${TOTAL_COST_SQL}), 0) AS cost
       FROM brick_productions p
       INNER JOIN brick_types bt ON bt.id = p.brick_type_id
      WHERE p.status <> 'cancelled' AND ${PS} AND ${PRODUCTION_DATE} >= ? AND ${PRODUCTION_DATE} <= ?
      GROUP BY bt.id, bt.name
      ORDER BY cost DESC`,
    [from, to],
  );

  const expensesByProduction = await rawAll<any>(
    `SELECT p.batch_number AS batch_number, ${PRODUCTION_DATE} AS date, bt.name AS brick_type_name,
            e.category AS category,
            COALESCE(SUM(e.amount), 0) AS amount,
            COUNT(*) AS count
       FROM expenses e
       INNER JOIN brick_productions p ON p.id = e.reference_id
       INNER JOIN brick_types bt ON bt.id = p.brick_type_id
      WHERE ${COUNTED_PRODUCTION_EXPENSE} AND ${ES} AND e.reference_type = ?
        AND p.status <> 'cancelled' AND ${PS} AND ${PRODUCTION_DATE} >= ? AND ${PRODUCTION_DATE} <= ?
      GROUP BY p.id, e.category
      ORDER BY date DESC, amount DESC`,
    [PRODUCTION_EXPENSE_REFERENCE, from, to],
  );

  const generalExpensesByCategory = await rawAll<any>(
    `SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM expenses
      WHERE ${COUNTED_EXPENSE} AND ${EXS} AND date >= ? AND date <= ?
        AND (reference_type IS NULL OR reference_type <> ?)
      GROUP BY category
      ORDER BY total DESC`,
    [from, to, PRODUCTION_EXPENSE_REFERENCE],
  );

  const salesByPeriod = await rawAll<any>(
    `SELECT date,
            COUNT(*) AS count,
            COALESCE(SUM(total), 0) AS revenue,
            COALESCE(SUM(amount_paid), 0) AS collected,
            COALESCE(SUM(remaining_amount), 0) AS outstanding
       FROM sales_invoices
      WHERE status = 'active' AND channel = 'brick' AND ${VS} AND date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC`,
    [from, to],
  );

  const salesByProduct = await rawAll<any>(
    `SELECT i.product_name AS product_name,
            COALESCE(SUM(i.quantity), 0) AS quantity,
            COALESCE(SUM(i.amount), 0) AS revenue
       FROM sales_invoice_items i
       INNER JOIN sales_invoices v ON v.id = i.invoice_id
      WHERE v.status = 'active' AND v.channel = 'brick' AND ${VVS} AND v.date >= ? AND v.date <= ?
      GROUP BY i.product_name
      ORDER BY revenue DESC`,
    [from, to],
  );

  const salesByCustomer = await rawAll<any>(
    `SELECT v.customer_name AS customer_name,
            COUNT(*) AS count,
            COALESCE(SUM(v.total), 0) AS revenue,
            COALESCE(SUM(v.remaining_amount), 0) AS outstanding
       FROM sales_invoices v
      WHERE v.status = 'active' AND v.channel = 'brick' AND ${VVS} AND v.date >= ? AND v.date <= ?
      GROUP BY v.customer_name
      ORDER BY revenue DESC`,
    [from, to],
  );

  // Créances : **toutes** les factures de briques impayées, sans borne de
  // période — un dû de l'an dernier reste un dû.
  const receivables = await rawAll<any>(
    `SELECT v.customer_name AS customer_name,
            (SELECT c.phone FROM customers c WHERE c.id = v.customer_id) AS phone,
            COUNT(*) AS invoice_count,
            COALESCE(SUM(v.remaining_amount), 0) AS balance,
            MIN(CASE WHEN v.remaining_amount > 0.001 THEN COALESCE(v.due_date, v.date) END) AS oldest_due_date
       FROM sales_invoices v
      WHERE v.status = 'active' AND v.channel = 'brick' AND ${VVS} AND v.remaining_amount > 0.001
      GROUP BY v.customer_id, v.customer_name
      HAVING balance > 0.001
      ORDER BY balance DESC`,
  );

  const paymentsByMethod = await rawAll<any>(
    `SELECT p.payment_method AS payment_method,
            COALESCE(SUM(p.amount), 0) AS total,
            COUNT(*) AS count
       FROM payments p
      WHERE p.date >= ? AND p.date <= ? AND ${PAYS}
        AND ((p.type = 'sale' AND p.reference_id IN (
                SELECT id FROM sales_invoices WHERE channel = 'brick' AND ${VS}))
             OR (p.type = 'brick_order' AND p.reference_id IN (
                SELECT id FROM brick_orders WHERE ${VS})))
      GROUP BY p.payment_method
      ORDER BY total DESC`,
    [from, to],
  );

  const losses = await rawAll<any>(
    `SELECT p.batch_number AS batch_number, ${PRODUCTION_DATE} AS date,
            bt.name AS brick_type_name,
            p.broken_quantity AS broken_quantity,
            p.notes AS notes
       FROM brick_productions p
       INNER JOIN brick_types bt ON bt.id = p.brick_type_id
      WHERE p.status <> 'cancelled' AND ${PS} AND p.broken_quantity > 0
        AND ${PRODUCTION_DATE} >= ? AND ${PRODUCTION_DATE} <= ?
      ORDER BY date DESC`,
    [from, to],
  );

  const stock = await listBrickStock(scope);

  const productionTotals = await rawGet<{ cost: number | null; produced: number | null; broken: number | null }>(
    `SELECT COALESCE(SUM(${TOTAL_COST_SQL}), 0) AS cost,
            COALESCE(SUM(p.produced_quantity), 0) AS produced,
            COALESCE(SUM(p.broken_quantity), 0) AS broken
       FROM brick_productions p
      WHERE p.status <> 'cancelled' AND ${PS} AND ${PRODUCTION_DATE} >= ? AND ${PRODUCTION_DATE} <= ?`,
    [from, to],
  );

  const revenueRow = await rawGet<{ revenue: number | null }>(
    `SELECT COALESCE(SUM(total), 0) AS revenue FROM sales_invoices
      WHERE status = 'active' AND channel = 'brick' AND ${VS} AND date >= ? AND date <= ?`,
    [from, to],
  );

  const generalRow = await rawGet<{ total: number | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
      WHERE ${COUNTED_EXPENSE} AND ${EXS} AND date >= ? AND date <= ?
        AND (reference_type IS NULL OR reference_type <> ?)`,
    [from, to, PRODUCTION_EXPENSE_REFERENCE],
  );

  const costByType = new Map(productionByType.map((row) => [Number(row.brick_type_id), row]));
  const soldByType = new Map<string, { quantity: number; revenue: number }>();
  for (const row of salesByProduct) {
    soldByType.set(row.product_name, {
      quantity: Number(row.quantity ?? 0),
      revenue: roundMoney(Number(row.revenue ?? 0)),
    });
  }

  const profitabilityByProduct = stock.map((line) => {
    const produced = costByType.get(line.brickTypeId);
    const sold = soldByType.get(line.productName) ?? { quantity: 0, revenue: 0 };
    const producedQuantity = Number(produced?.produced ?? 0);
    const brokenQuantity = Number(produced?.broken ?? 0);
    const good = Math.max(0, producedQuantity - brokenQuantity);
    const cost = roundMoney(Number(produced?.cost ?? 0));
    // Coût des briques vendues : coût unitaire du lot × quantité vendue.
    const unitCost = good > 0 ? cost / good : 0;
    const soldCost = roundMoney(unitCost * sold.quantity);
    const margin = roundMoney(sold.revenue - soldCost);

    return {
      brickTypeId: line.brickTypeId,
      brickTypeName: line.brickTypeName,
      quantitySold: sold.quantity,
      revenue: sold.revenue,
      productionCost: soldCost,
      margin,
      marginRate: sold.revenue > 0 ? Math.round((margin / sold.revenue) * 10000) / 100 : 0,
    };
  });

  const revenue = roundMoney(Number(revenueRow?.revenue ?? 0));
  const productionCost = roundMoney(Number(productionTotals?.cost ?? 0));
  const generalExpenses = roundMoney(Number(generalRow?.total ?? 0));
  const producedQuantity = roundMoney(Number(productionTotals?.produced ?? 0));
  const brokenQuantity = roundMoney(Number(productionTotals?.broken ?? 0));
  const good = Math.max(0, producedQuantity - brokenQuantity);

  return {
    from,
    to,
    productionByDay: productionByDay.map((row) => ({
      date: row.date,
      lots: Number(row.lots ?? 0),
      produced: roundMoney(Number(row.produced ?? 0)),
      broken: roundMoney(Number(row.broken ?? 0)),
      cost: roundMoney(Number(row.cost ?? 0)),
    })),
    productionByType: productionByType.map((row) => {
      const produced = Number(row.produced ?? 0);
      const broken = Number(row.broken ?? 0);
      const typeGood = Math.max(0, produced - broken);
      const cost = roundMoney(Number(row.cost ?? 0));
      return {
        brickTypeId: Number(row.brick_type_id),
        brickTypeName: row.brick_type_name,
        lots: Number(row.lots ?? 0),
        produced: roundMoney(produced),
        broken: roundMoney(broken),
        cost,
        unitCost: typeGood > 0 ? Math.round((cost / typeGood) * 100) / 100 : 0,
      };
    }),
    expensesByProduction: expensesByProduction.map((row) => ({
      batchNumber: row.batch_number,
      date: row.date,
      brickTypeName: row.brick_type_name,
      category: row.category,
      amount: roundMoney(Number(row.amount ?? 0)),
      count: Number(row.count ?? 0),
    })),
    generalExpensesByCategory: generalExpensesByCategory.map((row) => ({
      category: row.category,
      total: roundMoney(Number(row.total ?? 0)),
      count: Number(row.count ?? 0),
    })),
    salesByPeriod: salesByPeriod.map((row) => ({
      date: row.date,
      count: Number(row.count ?? 0),
      revenue: roundMoney(Number(row.revenue ?? 0)),
      collected: roundMoney(Number(row.collected ?? 0)),
      outstanding: roundMoney(Number(row.outstanding ?? 0)),
    })),
    salesByProduct: salesByProduct.map((row) => ({
      productName: row.product_name,
      quantity: Number(row.quantity ?? 0),
      revenue: roundMoney(Number(row.revenue ?? 0)),
    })),
    salesByCustomer: salesByCustomer.map((row) => ({
      customerName: row.customer_name,
      count: Number(row.count ?? 0),
      revenue: roundMoney(Number(row.revenue ?? 0)),
      outstanding: roundMoney(Number(row.outstanding ?? 0)),
    })),
    receivables: receivables.map((row) => ({
      customerName: row.customer_name,
      phone: row.phone ?? null,
      invoiceCount: Number(row.invoice_count ?? 0),
      balance: roundMoney(Number(row.balance ?? 0)),
      oldestDueDate: row.oldest_due_date ?? null,
    })),
    paymentsByMethod: paymentsByMethod.map((row) => ({
      paymentMethod: row.payment_method,
      total: roundMoney(Number(row.total ?? 0)),
      count: Number(row.count ?? 0),
    })),
    stock,
    losses: losses.map((row) => ({
      batchNumber: row.batch_number,
      date: row.date,
      brickTypeName: row.brick_type_name,
      brokenQuantity: Number(row.broken_quantity ?? 0),
      reason: row.notes ?? null,
    })),
    profitabilityByProduct,
    profitability: {
      revenue,
      productionCost,
      grossMargin: roundMoney(revenue - productionCost),
      generalExpenses,
      estimatedResult: roundMoney(revenue - productionCost - generalExpenses),
      marginRate: revenue > 0 ? Math.round(((revenue - productionCost) / revenue) * 10000) / 100 : 0,
      producedQuantity,
      unitCost: good > 0 ? Math.round((productionCost / good) * 100) / 100 : 0,
    },
  };
}
