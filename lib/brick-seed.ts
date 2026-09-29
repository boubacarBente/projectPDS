/**
 * Jeu de données de démonstration **de la briqueterie** (README §20.5).
 *
 * Pourquoi un module séparé du grand `lib/seed-data.ts` : celui-ci date du
 * schéma d'avant la révision §20 et fabrique ses lots avec
 * `brick_production_materials` (des matières premières sorties du stock). La
 * briqueterie fonctionne désormais par **dépenses rattachées** ; un jeu de
 * données qui ne refléterait pas ce modèle donnerait des écrans vides (aucune
 * dépense, coût de revient nul) — exactement ce qu'un jeu de démonstration ne
 * doit pas faire.
 *
 * Ce que ce module produit, **réparti sur l'année** pour que les filtres, les
 * rapports et les graphiques aient quelque chose à montrer :
 *  - **l'année** : un lot par mois environ, du plus ancien au plus récent, avec
 *    leurs dépenses (ciment, sable, argile, carburant, électricité…) ;
 *  - **le mois en cours** : plusieurs lots terminés, les ventes du mois et des
 *    commandes à différents stades du cycle ;
 *  - **la semaine en cours** : des lots encore en fabrication (moulage →
 *    séchage → cuisson) et des ventes récentes, pour que « production du jour /
 *    de la semaine » affiche autre chose que zéro.
 *
 * Aucun tirage aléatoire : tout est **déterministe**. Un jeu de démonstration qui
 * change à chaque exécution rend impossible la comparaison de deux recettes.
 *
 * ## Écriture par les moteurs, jamais en direct
 *
 * Les lots passent par `createBrickProduction` / `addProductionExpense` /
 * `addProductionWorker` / `advanceStage`, les ventes par `createSalesInvoice`,
 * les commandes par `createBrickOrder`. Conséquence voulue : le jeu de données
 * respecte les invariants de l'application (stock = somme des mouvements, crédit
 * unique à la mise en stock, caisse alimentée par les dépenses, reçus numérotés)
 * au lieu de fabriquer des lignes que l'application n'aurait jamais produites.
 */

import { db, rawAll, rawGet, withRawTransaction } from '@/db';
import { products } from '@/db/schema';
import { NotFoundError } from '@/lib/api';
import { addDays, roundMoney, today } from '@/lib/format';
import { createBackup } from '@/lib/backup';
import { recalculateCashBalances } from '@/lib/caisse';
import {
  addProductionExpense,
  addProductionWorker,
  advanceStage,
  createBrickProduction,
  createBrickType,
  listBrickTypes,
  updateBrickProduction,
  type BrickTypeRow,
} from '@/lib/brick';
import { addBrickOrderPayment, createBrickOrder, updateBrickOrderStatus } from '@/lib/brick-orders';
import { createSalesInvoice } from '@/lib/sales';
import { adjustStock, updateProductStock } from '@/lib/stock';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type BrickSeedCounts = {
  brickTypes: number;
  productions: number;
  /** Dépenses rattachées créées (ciment, sable, carburant, main-d'œuvre…). */
  expenses: number;
  workers: number;
  /** Ventes du canal `brick`. */
  sales: number;
  orders: number;
  /** Lots mis en stock (entrée de stock réelle). */
  lotsStored: number;
  /** Somme des dépenses de production créées, en GNF. */
  expenseAmount: number;
  /** Chiffre d'affaires de démonstration facturé, en GNF. */
  salesAmount: number;
};

export type BrickDataSummary = {
  brickTypes: number;
  productions: number;
  productionsStored: number;
  expenses: number;
  sales: number;
  orders: number;
  /** Reste à encaisser sur les ventes de briques. */
  outstanding: number;
  hasData: boolean;
  oldestProduction: string | null;
  newestProduction: string | null;
};

export type BrickResetReport = {
  productions: number;
  expenses: number;
  sales: number;
  orders: number;
  stockMovements: number;
  cashMovements: number;
  productsRecomputed: number;
  /** Produits de briqueterie dont le stock a été ramené à zéro. */
  productsZeroed: number;
  /** Quantité de briques retirée par ces remises à zéro. */
  quantityZeroed: number;
  safetyBackup: string;
};

/* ------------------------------------------------------------------ *
 * Référentiel : les produits finis de la briqueterie
 * ------------------------------------------------------------------ */

/**
 * Trois produits, trois usages : un bloc (murs), une brique pleine (structure),
 * une brique creuse (cloisons). Prix du marché local, en GNF.
 */
const BRICK_PRODUCTS = [
  {
    brickType: 'Brique pleine 15 trous',
    productName: 'Brique pleine 15 trous',
    shape: 'solid' as const,
    dimensions: '30 x 15 x 10 cm',
    unit: 'pièce',
    salePrice: 2_000,
    purchasePrice: 650,
    stockMin: 1_000,
  },
  {
    brickType: 'Brique creuse 12 trous',
    productName: 'Brique creuse 12 trous',
    shape: 'hollow' as const,
    dimensions: '40 x 20 x 15 cm',
    unit: 'pièce',
    salePrice: 3_000,
    purchasePrice: 950,
    stockMin: 800,
  },
  {
    brickType: 'Bloc béton 20x20x40',
    productName: 'Bloc béton 20x20x40',
    shape: 'block' as const,
    dimensions: '40 x 20 x 20 cm',
    unit: 'pièce',
    salePrice: 7_500,
    purchasePrice: 2_400,
    stockMin: 500,
  },
];

/** Clients de démonstration — rattachés aux vraies fiches quand il y en a. */
const CUSTOMERS = [
  'Chantier Kaloum — Immeuble R+3',
  'Entreprise Bâtir Guinée',
  'Particulier — Mamadou Bah',
  'Société Civile Immobilière Kipé',
];

/* ------------------------------------------------------------------ *
 * Plan de production
 * ------------------------------------------------------------------ */

type LotPlan = {
  /** Décalage en jours par rapport à aujourd'hui (0 = aujourd'hui). */
  startDaysAgo: number;
  /** Durée de fabrication, en jours (ignorée si le lot n'est pas terminé). */
  durationDays: number;
  productIndex: number;
  planned: number;
  produced: number;
  broken: number;
  /** `false` = le lot reste en cours (moulage, séchage ou cuisson). */
  finish: boolean;
  stage: 'molding' | 'drying' | 'firing';
  team: 'A' | 'B' | 'C';
};

/**
 * Le planning est **écrit à la main** plutôt que généré par une boucle : un jeu
 * de démonstration doit raconter une histoire crédible — un lot moulé cette
 * semaine, des lots terminés tout au long de l'année, des volumes qui varient.
 *
 * ⚠️ L'ordre chronologique des lots est **indispensable** au seed : les ventes
 * sont enregistrées après, du plus ancien au plus récent, et le contrôle de
 * stock les refuserait si les briques n'étaient pas déjà produites.
 */
const LOT_PLAN: LotPlan[] = [
  // ── Cette semaine : le travail en cours ────────────────────────────────
  /*
   * Un lot **du jour** avec une quantité déjà produite : sans lui, « Production
   * du jour » et « Production de la semaine » affichent 0 en début de semaine
   * (un lot au moulage a `produced_quantity = 0`, et un lot daté de 4 jours
   * tombe dans la semaine précédente si l'on est lundi ou mardi) — constaté en
   * recette : le tableau de bord semblait vide alors que le seed venait de
   * tourner.
   */
  { startDaysAgo: 0, durationDays: 0, productIndex: 1, planned: 4_500, produced: 2_000, broken: 60, finish: false, stage: 'firing', team: 'B' },
  { startDaysAgo: 1, durationDays: 0, productIndex: 0, planned: 6_000, produced: 3_400, broken: 90, finish: false, stage: 'drying', team: 'A' },
  { startDaysAgo: 2, durationDays: 0, productIndex: 2, planned: 2_500, produced: 1_200, broken: 0, finish: false, stage: 'molding', team: 'C' },

  // ── Ce mois : des lots terminés, du plus récent au plus ancien ─────────
  { startDaysAgo: 12, durationDays: 6, productIndex: 0, planned: 8_000, produced: 7_900, broken: 210, finish: true, stage: 'molding', team: 'A' },
  { startDaysAgo: 18, durationDays: 7, productIndex: 2, planned: 3_000, produced: 2_950, broken: 120, finish: true, stage: 'molding', team: 'C' },
  { startDaysAgo: 24, durationDays: 6, productIndex: 1, planned: 5_000, produced: 4_900, broken: 160, finish: true, stage: 'molding', team: 'B' },

  // ── L'année : un à deux lots par mois ─────────────────────────────────
  { startDaysAgo: 33, durationDays: 7, productIndex: 0, planned: 9_000, produced: 8_850, broken: 260, finish: true, stage: 'molding', team: 'A' },
  { startDaysAgo: 41, durationDays: 6, productIndex: 2, planned: 3_200, produced: 3_150, broken: 110, finish: true, stage: 'molding', team: 'C' },
  { startDaysAgo: 52, durationDays: 8, productIndex: 1, planned: 5_500, produced: 5_400, broken: 190, finish: true, stage: 'molding', team: 'B' },
  { startDaysAgo: 63, durationDays: 6, productIndex: 0, planned: 7_500, produced: 7_400, broken: 230, finish: true, stage: 'molding', team: 'A' },
  { startDaysAgo: 74, durationDays: 7, productIndex: 2, planned: 2_800, produced: 2_760, broken: 95, finish: true, stage: 'molding', team: 'C' },
  { startDaysAgo: 88, durationDays: 6, productIndex: 1, planned: 4_800, produced: 4_720, broken: 150, finish: true, stage: 'molding', team: 'B' },
  { startDaysAgo: 96, durationDays: 7, productIndex: 0, planned: 8_500, produced: 8_350, broken: 245, finish: true, stage: 'molding', team: 'A' },
  { startDaysAgo: 110, durationDays: 8, productIndex: 2, planned: 3_100, produced: 3_040, broken: 130, finish: true, stage: 'molding', team: 'C' },
  { startDaysAgo: 124, durationDays: 6, productIndex: 1, planned: 5_200, produced: 5_100, broken: 170, finish: true, stage: 'molding', team: 'B' },
  { startDaysAgo: 138, durationDays: 7, productIndex: 0, planned: 7_800, produced: 7_700, broken: 225, finish: true, stage: 'molding', team: 'A' },
  { startDaysAgo: 152, durationDays: 6, productIndex: 2, planned: 2_900, produced: 2_850, broken: 100, finish: true, stage: 'molding', team: 'C' },
  { startDaysAgo: 166, durationDays: 7, productIndex: 1, planned: 4_600, produced: 4_520, broken: 155, finish: true, stage: 'molding', team: 'B' },
  { startDaysAgo: 180, durationDays: 8, productIndex: 0, planned: 8_200, produced: 8_080, broken: 240, finish: true, stage: 'molding', team: 'A' },
  { startDaysAgo: 196, durationDays: 6, productIndex: 2, planned: 3_050, produced: 3_000, broken: 115, finish: true, stage: 'molding', team: 'C' },
  { startDaysAgo: 210, durationDays: 7, productIndex: 1, planned: 5_100, produced: 5_000, broken: 165, finish: true, stage: 'molding', team: 'B' },
  { startDaysAgo: 226, durationDays: 7, productIndex: 0, planned: 7_600, produced: 7_500, broken: 220, finish: true, stage: 'molding', team: 'A' },
  { startDaysAgo: 243, durationDays: 6, productIndex: 2, planned: 2_750, produced: 2_700, broken: 90, finish: true, stage: 'molding', team: 'C' },
  { startDaysAgo: 258, durationDays: 7, productIndex: 1, planned: 4_400, produced: 4_330, broken: 145, finish: true, stage: 'molding', team: 'B' },
  { startDaysAgo: 274, durationDays: 8, productIndex: 0, planned: 7_900, produced: 7_790, broken: 235, finish: true, stage: 'molding', team: 'A' },
  { startDaysAgo: 291, durationDays: 6, productIndex: 2, planned: 2_850, produced: 2_800, broken: 105, finish: true, stage: 'molding', team: 'C' },
  { startDaysAgo: 308, durationDays: 7, productIndex: 1, planned: 4_700, produced: 4_620, broken: 150, finish: true, stage: 'molding', team: 'B' },
  { startDaysAgo: 326, durationDays: 7, productIndex: 0, planned: 7_400, produced: 7_300, broken: 215, finish: true, stage: 'molding', team: 'A' },
  { startDaysAgo: 344, durationDays: 6, productIndex: 2, planned: 2_700, produced: 2_650, broken: 85, finish: true, stage: 'molding', team: 'C' },
];

/** Équipes : un chef nommé, comme sur une fiche réelle. */
const TEAMS: Record<
  'A' | 'B' | 'C',
  { label: string; members: { name: string; role: string; days: number; rate: number }[] }
> = {
  A: {
    label: 'Équipe A — Mamadou Camara',
    members: [
      { name: 'Mamadou Camara', role: "Chef d'équipe", days: 6, rate: 120_000 },
      { name: 'Alpha Soumah', role: 'Ouvrier', days: 6, rate: 80_000 },
      { name: 'Ibrahima Kourouma', role: 'Ouvrier', days: 5, rate: 80_000 },
    ],
  },
  B: {
    label: 'Équipe B — Sékou Touré',
    members: [
      { name: 'Sékou Touré', role: "Chef d'équipe", days: 6, rate: 120_000 },
      { name: 'Lamine Diallo', role: 'Ouvrier', days: 6, rate: 80_000 },
      { name: 'Fatoumata Barry', role: 'Apprentie', days: 4, rate: 50_000 },
    ],
  },
  C: {
    label: 'Équipe C — Abdoulaye Keita',
    members: [
      { name: 'Abdoulaye Keita', role: "Chef d'équipe", days: 5, rate: 120_000 },
      { name: 'Moussa Sylla', role: 'Ouvrier', days: 5, rate: 80_000 },
    ],
  },
};

/**
 * Dépenses d'un lot, **proportionnelles à la quantité produite**.
 *
 * La répartition est la même d'un lot à l'autre (le ciment domine) ; seuls les
 * montants suivent le volume, ce qui donne un coût de revient crédible : environ
 * 650 GNF la brique pleine, 950 la creuse, 2 400 le bloc — les prix d'achat du
 * catalogue. La **main-d'œuvre ne figure pas ici** : elle vient des affectations
 * d'équipe (`addProductionWorker`), sans quoi elle serait comptée deux fois.
 */
const EXPENSE_PLAN: { category: string; ratio: number; description: string }[] = [
  { category: 'Ciment', ratio: 0.28, description: 'Ciment CEM II — sacs de 50 kg' },
  { category: 'Sable', ratio: 0.14, description: 'Sable de rivière — camions' },
  { category: 'Argile / terre', ratio: 0.12, description: 'Argile du site de Dubréka' },
  { category: 'Bois de chauffe', ratio: 0.09, description: 'Bois de cuisson — stères' },
  { category: 'Carburant', ratio: 0.07, description: 'Gasoil — groupe et camions' },
  { category: 'Transport', ratio: 0.05, description: 'Transport des matières' },
  { category: 'Électricité', ratio: 0.04, description: 'Électricité — moulage' },
  { category: 'Entretien', ratio: 0.03, description: 'Entretien du matériel' },
];

/** Montant d'une dépense : volume × coût unitaire de référence × part. */
function expenseAmount(productIndex: number, producedQuantity: number, ratio: number): number {
  const unitCost = [650, 950, 2_400][productIndex] ?? 1_000;
  const quantity = producedQuantity > 0 ? producedQuantity : 1_000;
  // Arrondi à la centaine de GNF : des montants ronds, comme une facture.
  return Math.max(50_000, Math.round((quantity * unitCost * ratio) / 100) * 100);
}

/**
 * Ventes : écrites à la main elles aussi, du plus ancien au plus récent.
 *
 * ⚠️ La plus ancienne vente est **postérieure** au premier lot de son produit :
 * sans cela, le contrôle de stock refuserait la vente sur une base neuve (les
 * produits de briques y démarrent à zéro).
 */
type SalePlan = {
  daysAgo: number;
  productIndex: number;
  quantity: number;
  customerIndex: number;
  /** Part du total encaissée immédiatement : 1 = payée, 0 = à crédit. */
  paidRatio: number;
  paymentMethod: string;
};

const SALE_PLAN: SalePlan[] = [
  // ── Cette semaine ──────────────────────────────────────────────────────
  { daysAgo: 0, productIndex: 2, quantity: 300, customerIndex: 0, paidRatio: 1, paymentMethod: 'Espèces' },
  { daysAgo: 0, productIndex: 0, quantity: 1_200, customerIndex: 3, paidRatio: 0.7, paymentMethod: 'Mobile Money' },
  { daysAgo: 1, productIndex: 2, quantity: 500, customerIndex: 1, paidRatio: 1, paymentMethod: 'Mobile Money' },
  { daysAgo: 2, productIndex: 1, quantity: 1_500, customerIndex: 2, paidRatio: 0.5, paymentMethod: 'Espèces' },

  // ── Ce mois ────────────────────────────────────────────────────────────
  { daysAgo: 4, productIndex: 0, quantity: 3_000, customerIndex: 3, paidRatio: 0, paymentMethod: 'Crédit' },
  { daysAgo: 7, productIndex: 2, quantity: 700, customerIndex: 0, paidRatio: 1, paymentMethod: 'Virement' },
  { daysAgo: 10, productIndex: 1, quantity: 2_000, customerIndex: 1, paidRatio: 0.6, paymentMethod: 'Mobile Money' },
  { daysAgo: 14, productIndex: 0, quantity: 5_000, customerIndex: 3, paidRatio: 1, paymentMethod: 'Espèces' },
  { daysAgo: 19, productIndex: 2, quantity: 400, customerIndex: 2, paidRatio: 0, paymentMethod: 'Crédit' },
  { daysAgo: 23, productIndex: 1, quantity: 2_500, customerIndex: 0, paidRatio: 0.4, paymentMethod: 'Virement' },
  { daysAgo: 27, productIndex: 0, quantity: 6_000, customerIndex: 1, paidRatio: 1, paymentMethod: 'Espèces' },

  // ── L'année ────────────────────────────────────────────────────────────
  { daysAgo: 35, productIndex: 2, quantity: 650, customerIndex: 0, paidRatio: 1, paymentMethod: 'Espèces' },
  { daysAgo: 44, productIndex: 0, quantity: 4_400, customerIndex: 3, paidRatio: 0.5, paymentMethod: 'Mobile Money' },
  { daysAgo: 55, productIndex: 1, quantity: 3_600, customerIndex: 1, paidRatio: 1, paymentMethod: 'Virement' },
  { daysAgo: 66, productIndex: 2, quantity: 800, customerIndex: 2, paidRatio: 0, paymentMethod: 'Crédit' },
  { daysAgo: 78, productIndex: 0, quantity: 5_600, customerIndex: 0, paidRatio: 1, paymentMethod: 'Espèces' },
  { daysAgo: 92, productIndex: 1, quantity: 3_000, customerIndex: 3, paidRatio: 0.7, paymentMethod: 'Mobile Money' },
  { daysAgo: 105, productIndex: 2, quantity: 600, customerIndex: 1, paidRatio: 1, paymentMethod: 'Espèces' },
  { daysAgo: 120, productIndex: 0, quantity: 6_400, customerIndex: 2, paidRatio: 1, paymentMethod: 'Virement' },
  { daysAgo: 135, productIndex: 1, quantity: 4_000, customerIndex: 0, paidRatio: 0.3, paymentMethod: 'Espèces' },
  { daysAgo: 150, productIndex: 2, quantity: 450, customerIndex: 3, paidRatio: 1, paymentMethod: 'Mobile Money' },
  { daysAgo: 168, productIndex: 0, quantity: 5_200, customerIndex: 1, paidRatio: 1, paymentMethod: 'Espèces' },
  { daysAgo: 185, productIndex: 1, quantity: 2_800, customerIndex: 2, paidRatio: 0.5, paymentMethod: 'Virement' },
  { daysAgo: 205, productIndex: 2, quantity: 550, customerIndex: 0, paidRatio: 1, paymentMethod: 'Espèces' },
  { daysAgo: 222, productIndex: 0, quantity: 6_800, customerIndex: 3, paidRatio: 0, paymentMethod: 'Crédit' },
  { daysAgo: 245, productIndex: 1, quantity: 3_400, customerIndex: 1, paidRatio: 1, paymentMethod: 'Mobile Money' },
  { daysAgo: 265, productIndex: 2, quantity: 700, customerIndex: 2, paidRatio: 1, paymentMethod: 'Espèces' },
  { daysAgo: 285, productIndex: 0, quantity: 5_800, customerIndex: 0, paidRatio: 0.6, paymentMethod: 'Virement' },
  { daysAgo: 300, productIndex: 1, quantity: 3_200, customerIndex: 3, paidRatio: 1, paymentMethod: 'Espèces' },
  { daysAgo: 330, productIndex: 2, quantity: 500, customerIndex: 1, paidRatio: 1, paymentMethod: 'Mobile Money' },
];

/** Commandes : un état par étape du cycle, à des dates différentes. */
type OrderPlan = {
  daysAgo: number;
  productIndex: number;
  quantity: number;
  customerIndex: number;
  status: 'draft' | 'confirmed' | 'in_production' | 'ready';
  /** Acompte encaissé, en GNF (0 = aucun). */
  deposit: number;
};

const ORDER_PLAN: OrderPlan[] = [
  { daysAgo: 0, productIndex: 2, quantity: 400, customerIndex: 1, status: 'draft', deposit: 0 },
  { daysAgo: 2, productIndex: 0, quantity: 5_000, customerIndex: 0, status: 'confirmed', deposit: 2_000_000 },
  { daysAgo: 6, productIndex: 1, quantity: 3_000, customerIndex: 3, status: 'in_production', deposit: 3_000_000 },
  { daysAgo: 11, productIndex: 2, quantity: 600, customerIndex: 1, status: 'ready', deposit: 1_500_000 },
  { daysAgo: 21, productIndex: 0, quantity: 4_000, customerIndex: 2, status: 'confirmed', deposit: 0 },
  { daysAgo: 46, productIndex: 1, quantity: 2_500, customerIndex: 0, status: 'ready', deposit: 2_500_000 },
];

/* ------------------------------------------------------------------ *
 * Mise en place du référentiel
 * ------------------------------------------------------------------ */

/** Catégorie « Brique » si elle existe, sinon la première catégorie de produits finis. */
async function findBrickCategoryId(): Promise<number | null> {
  const row = await rawGet<{ id: number }>(
    `SELECT id FROM categories WHERE lower(trim(name)) = 'brique' ORDER BY id LIMIT 1`,
  );
  if (row) return Number(row.id);

  const fallback = await rawGet<{ id: number }>(
    `SELECT id FROM categories WHERE kind = 'finished' ORDER BY id LIMIT 1`,
  );
  return fallback ? Number(fallback.id) : null;
}

/**
 * Crée (ou retrouve) le **produit lié** d'un type de brique.
 *
 * Le produit porte le stock, le seuil et le prix de vente (§20) : sans lui, aucun
 * type de brique ne peut exister. Un produit du même nom déjà présent est
 * réutilisé **tel quel** — le seed ne doit pas écraser les prix saisis par le
 * client.
 */
async function ensureBrickProduct(definition: (typeof BRICK_PRODUCTS)[number]): Promise<number> {
  const existing = await rawGet<{ id: number }>(
    'SELECT id FROM products WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1',
    [definition.productName],
  );
  if (existing) return Number(existing.id);

  const categoryId = await findBrickCategoryId();

  const inserted = await db
    .insert(products)
    .values({
      name: definition.productName,
      categoryId,
      unit: definition.unit,
      purchasePrice: definition.purchasePrice,
      salePrice: definition.salePrice,
      stock: 0,
      stockMin: definition.stockMin,
      description: `Produit fini de la briqueterie (${definition.dimensions}).`,
      isActive: true,
    })
    .returning({ id: products.id });

  return Number(inserted[0].id);
}

/** Les trois types de briques du référentiel, créés seulement s'ils manquent. */
async function ensureBrickTypes(): Promise<BrickTypeRow[]> {
  const existing = await listBrickTypes({ includeInactive: true });
  const byName = new Map(existing.map((type) => [type.name.toLowerCase(), type]));
  const result: BrickTypeRow[] = [];

  for (const definition of BRICK_PRODUCTS) {
    const found = byName.get(definition.brickType.toLowerCase());
    if (found) {
      result.push(found);
      continue;
    }

    const productId = await ensureBrickProduct(definition);
    const type = await createBrickType({
      productId,
      name: definition.brickType,
      shape: definition.shape,
      dimensions: definition.dimensions,
    });
    result.push(type);
  }

  return result;
}

/** Clients existants : les ventes se rattachent aux vraies fiches si possible. */
async function resolveCustomerIds(): Promise<(number | null)[]> {
  const rows = await rawAll<{ id: number; name: string }>(
    'SELECT id, name FROM customers WHERE deleted_at IS NULL ORDER BY id LIMIT 4',
  );
  return CUSTOMERS.map((_, index) => (rows[index] ? Number(rows[index].id) : null));
}

/* ------------------------------------------------------------------ *
 * Seed
 * ------------------------------------------------------------------ */

export async function seedBrickDemoData(
  options: { userId?: number | null } = {},
): Promise<BrickSeedCounts> {
  const userId = options.userId ?? null;
  const counts: BrickSeedCounts = {
    brickTypes: 0,
    productions: 0,
    expenses: 0,
    workers: 0,
    sales: 0,
    orders: 0,
    lotsStored: 0,
    expenseAmount: 0,
    salesAmount: 0,
  };

  const types = await ensureBrickTypes();
  counts.brickTypes = types.length;

  const typeByProductIndex = BRICK_PRODUCTS.map((definition) => {
    const type = types.find((candidate) => candidate.name === definition.brickType);
    if (!type) {
      throw new NotFoundError(
        `Type de brique introuvable après préparation : ${definition.brickType}`,
      );
    }
    return type;
  });

  const customerIds = await resolveCustomerIds();
  const todayDate = today();

  /* ── 1. Les lots, du plus ancien au plus récent ────────────────────── */
  const lots = [...LOT_PLAN].sort((a, b) => b.startDaysAgo - a.startDaysAgo);

  for (const plan of lots) {
    const type = typeByProductIndex[plan.productIndex];
    const startDate = addDays(todayDate, -plan.startDaysAgo);
    const endDate = plan.finish ? addDays(todayDate, -(plan.startDaysAgo - plan.durationDays)) : null;
    const team = TEAMS[plan.team];
    const good = plan.produced - plan.broken;

    const production = await createBrickProduction({
      brickTypeId: type.id,
      plannedQuantity: plan.planned,
      producedQuantity: plan.produced,
      brokenQuantity: plan.broken,
      startDate,
      endDate,
      team: team.label,
      notes: plan.finish
        ? `Lot terminé et mis en stock : ${good} briques bonnes, ${plan.broken} cassées.`
        : `Fabrication en cours — ${
            plan.stage === 'molding'
              ? 'moulage'
              : plan.stage === 'drying'
                ? 'séchage au soleil'
                : 'cuisson au four'
          }.`,
      userId,
    });
    counts.productions += 1;

    // Dépenses rattachées : le cœur du modèle §20 (aucune matière première).
    for (const line of EXPENSE_PLAN) {
      const amount = expenseAmount(plan.productIndex, plan.produced, line.ratio);
      await addProductionExpense(production.id, {
        category: line.category,
        amount,
        description: line.description,
        paymentMethod: plan.startDaysAgo % 3 === 0 ? 'Mobile Money' : 'Espèces',
        date: startDate,
        userId,
      });
      counts.expenses += 1;
      counts.expenseAmount = roundMoney(counts.expenseAmount + amount);
    }

    // Équipe affectée : la main-d'œuvre s'ajoute au coût du lot.
    for (const member of team.members) {
      await addProductionWorker(production.id, {
        workerName: member.name,
        role: member.role,
        days: member.days,
        dailyRate: member.rate,
      });
      counts.workers += 1;
    }

    if (plan.finish) {
      // Mise en stock : crédite les briques finies et sort les cassées, **une
      // seule fois** (les deux verrous de `advanceStage`).
      await advanceStage(production.id, 'stored');
      counts.lotsStored += 1;

      // `advanceStage` ne pose la date de fin que si elle est vide : elle est
      // déjà renseignée, on la réaffirme pour que la fiche reste juste.
      if (endDate) await updateBrickProduction(production.id, { endDate });
    }
  }

  /* ── 2. Les ventes du canal « brick », de la plus ancienne à la plus récente ── */
  const sales = [...SALE_PLAN].sort((a, b) => b.daysAgo - a.daysAgo);

  for (const plan of sales) {
    const type = typeByProductIndex[plan.productIndex];
    const definition = BRICK_PRODUCTS[plan.productIndex];
    const date = addDays(todayDate, -plan.daysAgo);
    const total = roundMoney(plan.quantity * definition.salePrice);
    const amountPaid = roundMoney(total * plan.paidRatio);

    const invoice = await createSalesInvoice({
      customerId: customerIds[plan.customerIndex] ?? null,
      customerName: CUSTOMERS[plan.customerIndex],
      date,
      dueDate: plan.paidRatio < 1 ? addDays(date, 30) : null,
      paymentMethod: plan.paymentMethod,
      amountPaid,
      channel: 'brick',
      notes: `Livraison — ${CUSTOMERS[plan.customerIndex]}`,
      status: 'active',
      userId,
      lines: [
        {
          productId: type.productId,
          quantity: plan.quantity,
          unitPrice: definition.salePrice,
          discount: 0,
        },
      ],
    });

    counts.sales += 1;
    counts.salesAmount = roundMoney(counts.salesAmount + Number(invoice.total ?? total));
  }

  /* ── 3. Les commandes, à différents stades du cycle ───────────────────── */
  for (const plan of ORDER_PLAN) {
    const type = typeByProductIndex[plan.productIndex];
    const definition = BRICK_PRODUCTS[plan.productIndex];
    const date = addDays(todayDate, -plan.daysAgo);
    const gross = plan.quantity * definition.salePrice;

    const detail = await createBrickOrder({
      customerId: customerIds[plan.customerIndex] ?? null,
      customerName: CUSTOMERS[plan.customerIndex],
      date,
      promisedDate: addDays(date, 15),
      notes: 'Commande de démonstration',
      status: 'draft',
      userId,
      items: [
        {
          brickTypeId: type.id,
          quantity: plan.quantity,
          unitPrice: definition.salePrice,
          // Remise négociée de 2 % : la commande reste réaliste.
          discount: Math.round(gross * 0.02),
        },
      ],
    });

    if (plan.status !== 'draft') {
      // Un brouillon refuse l'encaissement : on confirme d'abord.
      await updateBrickOrderStatus(detail.order.id, 'confirmed');

      if (plan.deposit > 0) {
        await addBrickOrderPayment(detail.order.id, {
          amount: plan.deposit,
          paymentMethod: 'Espèces',
          date,
          userId,
          notes: 'Acompte de démonstration',
        });
      }
    }

    const chain: Record<OrderPlan['status'], ('in_production' | 'ready')[]> = {
      draft: [],
      confirmed: [],
      in_production: ['in_production'],
      ready: ['in_production', 'ready'],
    };

    for (const step of chain[plan.status]) {
      await updateBrickOrderStatus(detail.order.id, step);
    }

    counts.orders += 1;
  }

  return counts;
}

/* ------------------------------------------------------------------ *
 * Résumé
 * ------------------------------------------------------------------ */

export async function getBrickDataSummary(): Promise<BrickDataSummary> {
  const [productions, stored, expenses, sales, orders, outstanding, brickTypes] = await Promise.all([
    rawGet<{ n: number; oldest: string | null; newest: string | null }>(
      `SELECT COUNT(*) AS n,
              MIN(COALESCE(start_date, date(created_at, 'unixepoch'))) AS oldest,
              MAX(COALESCE(start_date, date(created_at, 'unixepoch'))) AS newest
         FROM brick_productions`,
    ),
    rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM brick_productions WHERE status = 'finished'`),
    rawGet<{ n: number }>(
      `SELECT COUNT(*) AS n FROM expenses
        WHERE reference_type = 'brick_production' AND deleted_at IS NULL`,
    ),
    rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM sales_invoices WHERE channel = 'brick'`),
    rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM brick_orders WHERE deleted_at IS NULL`),
    rawGet<{ total: number | null }>(
      `SELECT COALESCE(SUM(remaining_amount), 0) AS total FROM sales_invoices
        WHERE channel = 'brick' AND status = 'active'`,
    ),
    rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM brick_types'),
  ]);

  return {
    brickTypes: Number(brickTypes?.n ?? 0),
    productions: Number(productions?.n ?? 0),
    productionsStored: Number(stored?.n ?? 0),
    expenses: Number(expenses?.n ?? 0),
    sales: Number(sales?.n ?? 0),
    orders: Number(orders?.n ?? 0),
    outstanding: roundMoney(Number(outstanding?.total ?? 0)),
    hasData: Number(productions?.n ?? 0) > 0 || Number(sales?.n ?? 0) > 0,
    oldestProduction: productions?.oldest ?? null,
    newestProduction: productions?.newest ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Réinitialisation
 * ------------------------------------------------------------------ */

/**
 * **Réinitialise la briqueterie** : efface son activité, jamais son référentiel.
 *
 * Ce qui part :
 *  - les lots de fabrication (+ leurs matières historiques et leurs affectations) ;
 *  - les dépenses rattachées à ces lots (+ leur mouvement de caisse) ;
 *  - les ventes du canal `brick` (+ lignes, paiements, reçus, caisse) ;
 *  - les commandes de briques (+ lignes et acomptes encaissés) ;
 *  - les mouvements de stock nés de ces lots et de ces ventes.
 *
 * Ce qui reste : les **types de briques** et les **produits** du catalogue (le
 * référentiel n'est pas de l'activité, et une fiche produit peut servir ailleurs),
 * les clients, les paramètres, les utilisateurs et le **journal d'actions** —
 * une réinitialisation efface des données, pas l'histoire de qui a fait quoi.
 *
 * ⚠️ **Suppression physique** : c'est, avec la réinitialisation générale des
 * paramètres, la seule opération de l'application qui en fasse. Elle est réservée
 * à `settings.critical`, confirmée dans l'interface, et **une copie de sécurité
 * de la base est créée avant** — sans elle, un clic de trop serait irréparable.
 *
 * Deux réparations obligatoires après coup :
 *  - le **stock** est recalculé depuis les mouvements restants
 *    (`products.stock` = somme des mouvements, §12) ;
 *  - les **soldes de caisse** sont reconstruits : `balance_after` est un solde
 *    courant, et le solde affiché est celui du dernier mouvement. Supprimer des
 *    mouvements au milieu de l'historique afficherait sinon un montant trop élevé.
 *
 * ## Pourquoi le stock des produits de briques est **remis à zéro** ensuite
 *
 * Recalculer le stock ne suffit pas à donner à l'utilisateur ce qu'il attend d'un
 * bouton « réinitialiser la briqueterie ». Constaté en recette : après un reset,
 * `/briqueterie/stock` affichait encore 8 850 briques. Elles ne venaient pas des
 * lots — ceux-ci étaient bien effacés — mais de **trois autres modules** :
 * des entrées d'**achats** (11 048), des entrées d'**inventaire** (14 902) et des
 * sorties de **ventes du commerce général** (17 100), net 8 850. Ces mouvements
 * appartiennent à des documents qui existent toujours (factures d'achat,
 * factures de vente du canal `general`) : les supprimer corromprait ces modules.
 *
 * On remet donc le stock à zéro **par un ajustement motivé** (`adjustStock`),
 * c'est-à-dire par un mouvement signé — la seule façon autorisée de changer un
 * stock (§12) : l'invariant `products.stock` = somme des mouvements tient
 * toujours, et l'opération laisse une trace datée et motivée dans l'historique
 * des mouvements. Les documents d'achat et de vente, eux, restent intacts.
 *
 * Les **compteurs de numérotation** ne sont pas remis à zéro : un numéro de
 * facture ou de lot ne se réutilise jamais, même après un effacement.
 */
export async function resetBrickData(
  options: { userId?: number | null } = {},
): Promise<BrickResetReport> {
  const userId = options.userId ?? null;
  const { path: safetyBackup } = await createBackup();

  const productionIds = (await rawAll<{ id: number }>('SELECT id FROM brick_productions')).map((r) =>
    Number(r.id),
  );
  const orderIds = (await rawAll<{ id: number }>('SELECT id FROM brick_orders')).map((r) =>
    Number(r.id),
  );
  const invoiceIds = (
    await rawAll<{ id: number }>(`SELECT id FROM sales_invoices WHERE channel = 'brick'`)
  ).map((r) => Number(r.id));
  const expenseIds = (
    await rawAll<{ id: number }>(`SELECT id FROM expenses WHERE reference_type = 'brick_production'`)
  ).map((r) => Number(r.id));

  const inList = (values: number[]) => values.map(() => '?').join(', ');

  /*
   * Numéros de reçu : c'est le **seul lien fiable** entre un paiement et son
   * mouvement de caisse. `cash_movements.reference_id` est polymorphe et ne dit
   * pas de quel type de document il s'agit : effacer par identifiant risquerait
   * d'emporter le mouvement d'un chantier portant le même numéro.
   */
  const receiptRows = [
    ...(invoiceIds.length > 0
      ? await rawAll<{ receipt_number: string }>(
          `SELECT receipt_number FROM payments WHERE type = 'sale' AND reference_id IN (${inList(invoiceIds)})`,
          invoiceIds,
        )
      : []),
    ...(orderIds.length > 0
      ? await rawAll<{ receipt_number: string }>(
          `SELECT receipt_number FROM payments WHERE type = 'brick_order' AND reference_id IN (${inList(orderIds)})`,
          orderIds,
        )
      : []),
  ];
  const receipts = receiptRows.map((row) => row.receipt_number).filter(Boolean);

  // Produits dont le stock devra être recalculé, relevés **avant** suppression.
  const touchedProducts = new Set<number>();
  const stockFilter = [
    `reference_type = 'brick_production'`,
    invoiceIds.length > 0
      ? `(reference_type = 'sale' AND reference_id IN (${inList(invoiceIds)}))`
      : '0',
  ].join(' OR ');
  for (const row of await rawAll<{ product_id: number }>(
    `SELECT DISTINCT product_id FROM stock_movements WHERE ${stockFilter}`,
    invoiceIds,
  )) {
    touchedProducts.add(Number(row.product_id));
  }

  let stockMovements = 0;
  let cashMovements = 0;

  await withRawTransaction(async (tx) => {
    // 1. Caisse : les dépenses de production, puis les encaissements de briques.
    if (expenseIds.length > 0) {
      const result = await tx.execute({
        sql: `DELETE FROM cash_movements WHERE reference_type = 'expense' AND reference_id IN (${inList(expenseIds)})`,
        args: expenseIds,
      });
      cashMovements += Number(result.rowsAffected ?? 0);
    }
    for (const receipt of receipts) {
      const result = await tx.execute({
        sql: `DELETE FROM cash_movements WHERE motif LIKE ?`,
        args: [`%${receipt}%`],
      });
      cashMovements += Number(result.rowsAffected ?? 0);
    }

    // 2. Stock : mouvements des lots et des ventes de briques.
    if (productionIds.length > 0) {
      const result = await tx.execute({
        sql: `DELETE FROM stock_movements WHERE reference_type = 'brick_production' AND reference_id IN (${inList(productionIds)})`,
        args: productionIds,
      });
      stockMovements += Number(result.rowsAffected ?? 0);
    }
    if (invoiceIds.length > 0) {
      const result = await tx.execute({
        sql: `DELETE FROM stock_movements WHERE reference_type = 'sale' AND reference_id IN (${inList(invoiceIds)})`,
        args: invoiceIds,
      });
      stockMovements += Number(result.rowsAffected ?? 0);
    }

    // 3. Documents : paiements, lignes, puis en-têtes.
    if (invoiceIds.length > 0) {
      await tx.execute({
        sql: `DELETE FROM payments WHERE type = 'sale' AND reference_id IN (${inList(invoiceIds)})`,
        args: invoiceIds,
      });
      await tx.execute({
        sql: `DELETE FROM sales_invoice_items WHERE invoice_id IN (${inList(invoiceIds)})`,
        args: invoiceIds,
      });
      await tx.execute({
        sql: `DELETE FROM sales_invoices WHERE id IN (${inList(invoiceIds)})`,
        args: invoiceIds,
      });
    }
    if (orderIds.length > 0) {
      await tx.execute({
        sql: `DELETE FROM payments WHERE type = 'brick_order' AND reference_id IN (${inList(orderIds)})`,
        args: orderIds,
      });
      await tx.execute({
        sql: `DELETE FROM brick_order_items WHERE order_id IN (${inList(orderIds)})`,
        args: orderIds,
      });
      await tx.execute({
        sql: `DELETE FROM brick_orders WHERE id IN (${inList(orderIds)})`,
        args: orderIds,
      });
    }

    // 4. Dépenses rattachées, puis les lots et leurs enfants.
    if (expenseIds.length > 0) {
      await tx.execute({
        sql: `DELETE FROM expenses WHERE id IN (${inList(expenseIds)})`,
        args: expenseIds,
      });
    }
    if (productionIds.length > 0) {
      await tx.execute({
        sql: `DELETE FROM brick_production_materials WHERE production_id IN (${inList(productionIds)})`,
        args: productionIds,
      });
      await tx.execute({
        sql: `DELETE FROM brick_production_workers WHERE production_id IN (${inList(productionIds)})`,
        args: productionIds,
      });
      await tx.execute({
        sql: `DELETE FROM brick_productions WHERE id IN (${inList(productionIds)})`,
        args: productionIds,
      });
    }
  });

  // 5. Le stock est recalculé depuis les mouvements restants (§12).
  for (const productId of touchedProducts) {
    await updateProductStock(productId);
  }

  // 6. Les **produits de briqueterie** repartent de zéro.
  //
  // Le recalcul ci-dessus ne suffit pas : des achats, des inventaires et des
  // ventes du commerce général ont pu bouger ces produits, et le stock resterait
  // positif — constaté en recette (8 850 briques après un reset, dont aucun lot).
  // On annule donc le solde restant par un **ajustement motivé**, seul chemin
  // autorisé pour changer un stock : l'invariant tient, et la trace reste.
  const brickProducts = await rawAll<{ id: number; name: string; stock: number }>(
    `SELECT p.id, p.name, p.stock FROM products p
      WHERE p.id IN (SELECT product_id FROM brick_types)`,
  );

  let productsZeroed = 0;
  let quantityZeroed = 0;

  for (const product of brickProducts) {
    const stock = Number(product.stock ?? 0);
    if (Math.abs(stock) < 0.001) continue;

    await adjustStock(
      Number(product.id),
      -stock,
      `Réinitialisation de la briqueterie — remise à zéro du stock de « ${product.name} »`,
      { userId },
    );

    productsZeroed += 1;
    quantityZeroed = roundMoney(quantityZeroed + stock);
  }

  // 7. Les soldes de caisse sont reconstruits sur l'historique restant.
  await recalculateCashBalances();

  return {
    productions: productionIds.length,
    expenses: expenseIds.length,
    sales: invoiceIds.length,
    orders: orderIds.length,
    stockMovements,
    cashMovements,
    productsRecomputed: touchedProducts.size,
    productsZeroed,
    quantityZeroed,
    safetyBackup,
  };
}
