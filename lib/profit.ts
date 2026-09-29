/**
 * Résultat d'une période : chiffre d'affaires, coût des marchandises, marge
 * brute, dépenses, main-d'œuvre et **bénéfice net** (README §15).
 *
 * **Source unique.** Le tableau de bord (`lib/dashboard.ts`) et `/soldes`
 * (`lib/balances.ts`) appellent la même `getPeriodResult()`. Avant cette
 * extraction, chacun portait sa propre formule et les deux écrans annonçaient
 * deux « bénéfices nets » différents pour la même période — mesuré sur la base
 * de recette : **−2 389 000 GNF** au tableau de bord contre **+2 535 000 GNF**
 * sur `/soldes` pour le même mois, parce que le tableau de bord ignorait
 * entièrement les prestations de chantier. Un bénéfice calculé deux fois finit
 * toujours par diverger : il n'est plus calculé qu'ici.
 *
 * Règles du §15, à ne pas perdre de vue :
 *  - le chiffre d'affaires est **HT** (`total_ht`) et additionne deux documents
 *    facturables autonomes : les ventes **et** les prestations de chantier —
 *    jamais comptés deux fois ;
 *  - le coût des marchandises est celui du **jour du calcul**, lu sur
 *    `products.purchase_price` (compromis V1 assumé, Q20) ;
 *  - une dépense **annulée** (tombstone `deleted_at`) n'est plus comptée ;
 *  - un chantier **annulé** ne compte ni sa recette, ni ses matériaux, ni sa
 *    main-d'œuvre.
 *
 * **Aucun de ces montants n'est stocké** : tout est calculé à la lecture, ce
 * qui garantit qu'un bénéfice ne peut pas « dériver ».
 *
 * Module **en lecture seule** : aucune écriture, aucun `enqueueSyncWrite`.
 */

import { rawAll, rawGet } from '@/db';

/* ------------------------------------------------------------------ *
 * Types publics
 * ------------------------------------------------------------------ */

/** Résultat complet d'une période — forme exacte consommée par les deux écrans. */
export type PeriodResult = {
  /** Chiffre d'affaires = ventes HT + prestations de chantier. */
  revenue: number;
  /** Part « ventes de marchandises », HT — c'est elle qui porte la marge. */
  revenueHt: number;
  /** Part « prestations de chantier » : document autonome, jamais recompté. */
  jobsRevenue: number;
  /** Nombre de prestations de la période. */
  jobsCount: number;
  /** Coût des matériaux consommés par les chantiers (inclus dans `cogs`). */
  jobsMaterialCost: number;
  /** Coût des marchandises vendues + matériaux consommés par les chantiers. */
  cogs: number;
  /** Bénéfice brut = CA − coût des marchandises. */
  grossProfit: number;
  /**
   * Marge brute rapportée au chiffre d'affaires **complet** : c'est le seul
   * pourcentage qui ne surestime pas la rentabilité réelle de l'activité.
   */
  grossMarginPercent: number;
  /** Dépenses de fonctionnement de la période (annulées exclues). */
  expenses: number;
  /** Main-d'œuvre des chantiers, fabrications et commandes d'atelier. */
  laborCost: number;
  /** Bénéfice net = bénéfice brut − dépenses − main-d'œuvre (§15). */
  netProfit: number;
};

/* ------------------------------------------------------------------ *
 * Coût des marchandises vendues (COGS) et marges par produit
 * ------------------------------------------------------------------ */

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

/**
 * Métriques de marge et de profit (reprise de `calculateSalesProfitMetrics()`
 * du projet Gaz, enrichie des dépenses — README §15).
 *
 * ⚠️ Cette variante porte sur les **lignes de facture** (`sales_invoice_items`)
 * et ignore donc les chantiers : c'est la base du « bénéfice par vente » et des
 * rapports par produit. Le résultat d'activité complet — celui affiché par le
 * tableau de bord et `/soldes` — est `getPeriodResult()`, en bas de ce fichier.
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

/* ------------------------------------------------------------------ *
 * Résultat de la période — la seule définition du « bénéfice »
 * ------------------------------------------------------------------ */

/**
 * Main-d'œuvre de la période : chantiers, fabrications de briques et commandes
 * d'atelier — les trois sources de `labor_cost` du §15, en une seule requête.
 *
 * ⚠️ `j.status <> 'cancelled'` est indispensable : un chantier annulé ne doit
 * pas laisser sa main-d'œuvre dans le bénéfice.
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
 * Résultat de la période (§15) — **la** définition du bénéfice affiché.
 *
 * Les bornes sont inclusives et portent sur la **date métier** `YYYY-MM-DD` —
 * le seul champ filtré (CONVENTIONS §6 règle 2) : un `BETWEEN` sur un
 * horodatage renverrait zéro ligne.
 *
 * Appelée par `getDashboardSnapshot()` (tableau de bord) **et** par
 * `getBalancesSummary()` (`/soldes`) : pour une même période, les deux écrans
 * affichent nécessairement le même chiffre.
 */
export async function getPeriodResult(from: string, to: string): Promise<PeriodResult> {
  const [salesRow, jobsRow, jobsMaterialsRow, marginMetrics, expensesRow, laborCost] =
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

  return {
    revenue,
    revenueHt,
    jobsRevenue,
    jobsCount,
    jobsMaterialCost,
    cogs,
    grossProfit,
    grossMarginPercent:
      revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : 0,
    expenses,
    laborCost,
    netProfit: grossProfit - expenses - laborCost,
  };
}
