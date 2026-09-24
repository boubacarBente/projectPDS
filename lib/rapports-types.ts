/**
 * Types partagés du module **Rapports** (README §11, §15, §16 ; §27.2).
 *
 * ⚠️ Module **client-safe** : il n'importe **rien** — ni `@/db`, ni `fs`, ni
 * `next/headers`. `app/rapports/page.tsx` est un composant client : il importe
 * ces types (`import type`, effacé à la compilation) et `lib/rapports.ts`
 * (serveur) les réutilise. C'est la règle du §11 bis des CONVENTIONS : aucun
 * import **runtime** d'un module serveur dans un composant client.
 *
 * La structure de référence vient du projet Gaz (README §15) :
 * `summary`, `comparison`, `monthlyData`, `soldByProduct`, `productMargins`,
 * `topCustomers`, `receivables`, `payables`, `stockInsights`,
 * `decisionSummary` — complétés par `expenses`, `netProfit` et `jobCosts`.
 */

/* ------------------------------------------------------------------ *
 * Périodes
 * ------------------------------------------------------------------ */

/** Période du rapport, avec son libellé lisible (« Aujourd'hui », « Ce mois »…). */
export type RapportPeriod = {
  /** Date métier `YYYY-MM-DD`. */
  from: string;
  /** Date métier `YYYY-MM-DD`. */
  to: string;
  label: string;
};

/** Bornes brutes de la période de comparaison. */
export type RapportPeriodBounds = {
  from: string;
  to: string;
};

/* ------------------------------------------------------------------ *
 * Synthèse
 * ------------------------------------------------------------------ */

/** Répartition de la caisse par moyen de paiement (Espèces / Mobile Money). */
export type RapportCashMethod = {
  method: string;
  income: number;
  expense: number;
  net: number;
};

/** Encaissement réel de la période, par moyen de paiement. */
export type RapportCollectedMethod = {
  method: string;
  total: number;
  count: number;
};

export type RapportSummary = {
  /** Chiffre d'affaires **TTC** : ventes actives + prestations (§15). */
  revenueTtc: number;
  /** Chiffre d'affaires **HT** : ventes actives + prestations. */
  revenueHt: number;
  /** Nombre de ventes (factures actives) de la période. */
  salesCount: number;
  /** Panier moyen des ventes facturées (hors prestations). */
  averageBasket: number;
  /**
   * Encaissé sur la période : les `payments` réellement reçus (ventes et
   * prestations), jamais le `amount_paid` figé sur la facture — un règlement
   * d'une vente antérieure est bien un encaissement de la période.
   */
  collected: number;
  collectedByMethod: RapportCollectedMethod[];
  /** Restant dû **des documents émis sur la période** (ventes + prestations). */
  outstanding: number;
  /** Dépenses de fonctionnement de la période (annulées exclues). */
  expenses: number;
  /** Bénéfice net = bénéfice brut − dépenses − main-d'œuvre (§15). */
  netProfit: number;
  /** Situation de caisse (solde global + mouvements du résumé de caisse). */
  cash: {
    balance: number;
    income: number;
    expense: number;
    net: number;
    byMethod: RapportCashMethod[];
    /**
     * Quand une session est ouverte, `lib/caisse.ts` résume **la session en
     * cours** et non la période : `income` / `expense` doivent alors être lus
     * comme « mouvements de la session », ce que `sessionStatus` permet
     * d'afficher honnêtement. Le **solde**, lui, est toujours global.
     */
    sessionStatus: 'open' | 'closed';
  };
};

/* ------------------------------------------------------------------ *
 * Comparaison avec la période précédente
 * ------------------------------------------------------------------ */

export type RapportComparisonMetric = {
  current: number;
  previous: number;
  /** Variation en %, `null` quand la période précédente vaut 0 (pas de base). */
  deltaPercent: number | null;
};

export type RapportComparison = {
  revenue: RapportComparisonMetric;
  /** Marge brute = CA des lignes − coût des marchandises vendues. */
  margin: RapportComparisonMetric;
  salesCount: RapportComparisonMetric;
};

/* ------------------------------------------------------------------ *
 * Séries et listes
 * ------------------------------------------------------------------ */

/** Un point mensuel — les 12 points portent **toujours** les mêmes abscisses. */
export type RapportMonthlyPoint = {
  /** `YYYY-MM`. */
  month: string;
  revenue: number;
  purchases: number;
  expenses: number;
};

export type RapportSoldProduct = {
  productId: number | null;
  productCode: string;
  productName: string;
  unit: string;
  quantity: number;
  revenue: number;
  /** Part du chiffre d'affaires des produits vendus, en %. */
  sharePercent: number;
};

export type RapportProductMargin = {
  productId: number | null;
  productName: string;
  quantity: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPercent: number;
  unitMargin: number;
};

export type RapportTopCustomer = {
  customerId: number;
  customerName: string;
  salesCount: number;
  revenue: number;
  collected: number;
  outstanding: number;
};

/* ------------------------------------------------------------------ *
 * Créances et dettes (situation à date, indépendante de la période)
 * ------------------------------------------------------------------ */

export type RapportReceivable = {
  customerId: number;
  customerName: string;
  phone: string | null;
  balance: number;
  invoiceCount: number;
  /** Échéance la plus ancienne non soldée, `null` si aucune échéance. */
  oldestDueDate: string | null;
  overdue: boolean;
};

export type RapportReceivables = {
  total: number;
  debtorsCount: number;
  items: RapportReceivable[];
};

export type RapportPayable = {
  supplierId: number;
  supplierName: string;
  phone: string | null;
  balance: number;
  invoiceCount: number;
  oldestDueDate: string | null;
  overdue: boolean;
};

export type RapportPayables = {
  total: number;
  creditorsCount: number;
  items: RapportPayable[];
};

/* ------------------------------------------------------------------ *
 * Stock
 * ------------------------------------------------------------------ */

export type RapportStockAlert = {
  productId: number;
  code: string;
  name: string;
  unit: string;
  stock: number;
  stockMin: number;
  stockValue: number;
};

export type RapportStockInsights = {
  totalProducts: number;
  /** Valeur du stock au prix d'achat. */
  purchaseValue: number;
  /** Valeur du stock au prix de vente. */
  saleValue: number;
  /** Marge potentielle encore en stock (vente − achat). */
  potentialMargin: number;
  lowStockCount: number;
  outOfStockCount: number;
  /** Produits sous le seuil d'alerte (`stock ≤ stock_min`), ruptures exclues. */
  alerts: RapportStockAlert[];
  /** Produits en rupture (`stock ≤ 0`). */
  outOfStock: RapportStockAlert[];
};

/* ------------------------------------------------------------------ *
 * Dépenses, bénéfice, main-d'œuvre
 * ------------------------------------------------------------------ */

export type RapportExpenseCategory = {
  category: string;
  total: number;
  count: number;
};

export type RapportExpenses = {
  total: number;
  count: number;
  average: number;
  byCategory: RapportExpenseCategory[];
};

export type RapportNetProfit = {
  /** CA des lignes de vente (base du calcul de marge). */
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPercent: number;
  expenses: number;
  laborCost: number;
  netProfit: number;
};

export type RapportJobCosts = {
  serviceJobs: {
    count: number;
    revenue: number;
    outstanding: number;
    materialCost: number;
    laborCost: number;
  };
  brickProductions: {
    count: number;
    materialCost: number;
    laborCost: number;
  };
  furnitureOrders: {
    count: number;
    materialCost: number;
    laborCost: number;
  };
  totalMaterialCost: number;
  totalLaborCost: number;
};

/* ------------------------------------------------------------------ *
 * Rapport complet
 * ------------------------------------------------------------------ */

export type RapportData = {
  period: RapportPeriod;
  previousPeriod: RapportPeriodBounds;
  summary: RapportSummary;
  comparison: RapportComparison;
  monthlyData: RapportMonthlyPoint[];
  soldByProduct: RapportSoldProduct[];
  productMargins: RapportProductMargin[];
  topCustomers: RapportTopCustomer[];
  receivables: RapportReceivables;
  payables: RapportPayables;
  stockInsights: RapportStockInsights;
  /** 3 à 5 phrases factuelles, chacune adossée à un chiffre. */
  decisionSummary: string[];
  expenses: RapportExpenses;
  netProfit: RapportNetProfit;
  jobCosts: RapportJobCosts;
};

/** Filtres acceptés par `getRapportData()` et par `GET /api/rapports`. */
export type RapportFilters = {
  from: string;
  to: string;
  /** Bornes de comparaison explicites ; sinon `previousPeriod(from, to)`. */
  previousFrom?: string | null;
  previousTo?: string | null;
  productId?: number | null;
  customerId?: number | null;
  supplierId?: number | null;
  paymentStatus?: string | null;
};

/* ------------------------------------------------------------------ *
 * Envoi et historique (table `report_deliveries`, README §6.3, §16)
 * ------------------------------------------------------------------ */

export type RapportPeriodKey = 'day' | 'week' | 'month';
export type RapportDeliveryChannel = 'sms' | 'whatsapp';
export type RapportDeliveryStatus = 'sent' | 'failed';
export type RapportDeliveryTrigger = 'auto' | 'manual';

export type RapportDeliveryRow = {
  id: number;
  period: RapportPeriodKey;
  fromDate: string;
  toDate: string;
  channel: RapportDeliveryChannel;
  recipients: string[];
  content: string;
  status: RapportDeliveryStatus;
  /** Message d'erreur **conservé** : un échec d'envoi ne disparaît jamais. */
  error: string | null;
  triggeredBy: RapportDeliveryTrigger;
  userId: number | null;
  userName: string | null;
  /** Horodatage ISO 8601, ou `null` si la colonne est vide. */
  sentAt: string | null;
};

/** Corps de `POST /api/rapports/envoyer`. */
export type RapportSendRequest = {
  period?: RapportPeriodKey;
  from?: string;
  to?: string;
  channel?: RapportDeliveryChannel;
  recipients?: string[];
  /** Un test prépare le message sans rien envoyer ni rien enregistrer. */
  test?: boolean;
};

/**
 * Réponse de `POST /api/rapports/envoyer`.
 *
 * `mode` dit la **vérité** de ce qui s'est passé : `manual` (message préparé,
 * l'utilisateur valide dans WhatsApp/SMS — fonctionne hors ligne), `automatic`
 * (tentative vers la passerelle : `delivery.status` vaut `sent` ou `failed`),
 * `test` (rien n'a été envoyé ni enregistré).
 */
export type RapportSendResult = {
  delivery: RapportDeliveryRow | null;
  message: string;
  /** URL `wa.me` / `sms:` pré-remplie à ouvrir en mode manuel. */
  shareUrl: string | null;
  requiresManualSend: boolean;
  mode: 'manual' | 'automatic' | 'test';
  /**
   * Raison d'un échec d'envoi automatique — renseignée même quand aucune
   * livraison n'est enregistrée (rapport de test), pour ne jamais masquer
   * un échec.
   */
  error?: string | null;
  /** `true` quand la période a été ramenée à aujourd'hui (rôle sans `reports.viewAll`). */
  forcedPeriod?: boolean;
};
