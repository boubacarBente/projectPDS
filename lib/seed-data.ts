/**
 * Catalogue et données de démonstration (README Q12).
 *
 * **Outil de développement** : la carte « Préremplir » n'est visible ni en
 * production ni dans l'application de bureau. La fonction est **idempotente** :
 * elle ne duplique rien si les données existent déjà.
 *
 * ⚠️ Les transactions de démonstration (ventes, achats, dépenses, paiements)
 * sont insérées **directement** ici, et non par les fonctions de `lib/`. C'est
 * volontaire et limité à ce fichier : une écriture métier normale passe
 * toujours par une fonction de `lib/` (README §26.5 et §26.13), mais le seed
 * doit pouvoir fonctionner avant que tous les modules ne soient livrés, et il
 * doit produire un volume cohérent en une seule transaction.
 */

import { db, rawAll, rawGet, rawRun } from '@/db';
import { eq, sql } from 'drizzle-orm';
import {
  categories,
  customers,
  products,
  suppliers,
  workers,
  furnitureModels,
  furnitureModelMaterials,
  brickTypes,
  brickProductions,
  brickProductionMaterials,
  brickProductionWorkers,
  furnitureOrders,
  furnitureOrderMaterials,
  furnitureOrderWorkers,
  serviceJobs,
  serviceJobMaterials,
  serviceJobWorkers,
  salesInvoices,
  salesInvoiceItems,
  purchaseInvoices,
  purchaseInvoiceItems,
  payments,
  expenses,
  cashSessions,
  cashMovements,
  stockMovements,
} from '@/db/schema';
import { getSettings } from '@/lib/settings';
import { renderDocumentNumber } from '@/lib/settings';
import { today, addDays, roundMoney } from '@/lib/format';
import { getDeviceId } from '@/lib/sync';

export type SeedReport = {
  categories: number;
  products: number;
  customers: number;
  suppliers: number;
  workers: number;
  furnitureModels: number;
  brickTypes: number;
  sales: number;
  purchases: number;
  expenses: number;
  /** Chantiers de démonstration créés (prestations, README §16). */
  serviceJobs: number;
  serviceJobMaterials: number;
  serviceJobWorkers: number;
  /** Lots de briqueterie créés (README §17). */
  brickProductions: number;
  brickProductionMaterials: number;
  brickProductionWorkers: number;
  /** Commandes d'atelier créées (README §18). */
  furnitureOrders: number;
  furnitureOrderMaterials: number;
  furnitureOrderWorkers: number;
  skipped: boolean;
  message: string;
};

/* ------------------------------------------------------------------ *
 * Référentiels
 * ------------------------------------------------------------------ */

const CATEGORIES: { name: string; kind: 'finished' | 'raw_material' | 'service'; description: string }[] = [
  { name: 'Meuble', kind: 'finished', description: 'Meubles finis vendus en magasin' },
  { name: 'Brique', kind: 'finished', description: 'Briques produites par la briqueterie' },
  { name: 'Alucobond', kind: 'raw_material', description: 'Panneaux composites pour façades' },
  { name: 'Staff', kind: 'raw_material', description: 'Staff et plâtre décoratif' },
  { name: 'Placo', kind: 'raw_material', description: 'Plaques de plâtre et profilés' },
  { name: 'Peinture', kind: 'raw_material', description: 'Peintures, vernis et enduits' },
  { name: 'Bois', kind: 'raw_material', description: 'Planches, chevrons et panneaux' },
  { name: 'Quincaillerie', kind: 'raw_material', description: 'Clous, vis, colle, poignées, charnières' },
  { name: 'Matière première', kind: 'raw_material', description: 'Argile, ciment, sable, eau, bois de chauffe' },
  { name: 'Prestation', kind: 'service', description: 'Prestations de pose et de finition' },
];

type ProductSeed = {
  name: string;
  category: string;
  unit: string;
  purchasePrice: number;
  salePrice: number;
  stock: number;
  stockMin: number;
};

const PRODUCTS: ProductSeed[] = [
  // Meubles finis
  { name: 'Armoire 2 portes standard', category: 'Meuble', unit: 'pièce', purchasePrice: 1_450_000, salePrice: 2_100_000, stock: 4, stockMin: 2 },
  { name: 'Lit 2 places avec tête de lit', category: 'Meuble', unit: 'pièce', purchasePrice: 1_900_000, salePrice: 2_750_000, stock: 3, stockMin: 2 },
  { name: 'Table à manger 6 places', category: 'Meuble', unit: 'pièce', purchasePrice: 1_200_000, salePrice: 1_850_000, stock: 5, stockMin: 2 },
  { name: 'Buffet bas 4 portes', category: 'Meuble', unit: 'pièce', purchasePrice: 980_000, salePrice: 1_500_000, stock: 6, stockMin: 2 },
  { name: 'Ensemble salon complet', category: 'Meuble', unit: 'ensemble', purchasePrice: 4_200_000, salePrice: 6_300_000, stock: 2, stockMin: 1 },
  { name: 'Bureau de direction', category: 'Meuble', unit: 'pièce', purchasePrice: 1_650_000, salePrice: 2_450_000, stock: 3, stockMin: 1 },
  { name: 'Chaise bois massif', category: 'Meuble', unit: 'pièce', purchasePrice: 185_000, salePrice: 295_000, stock: 24, stockMin: 8 },

  // Briques
  { name: 'Brique pleine 15 trous', category: 'Brique', unit: 'pièce', purchasePrice: 2_800, salePrice: 4_500, stock: 4_800, stockMin: 500 },
  { name: 'Brique creuse 12 trous', category: 'Brique', unit: 'pièce', purchasePrice: 2_400, salePrice: 3_900, stock: 3_200, stockMin: 500 },
  { name: 'Bloc béton 20x20x40', category: 'Brique', unit: 'pièce', purchasePrice: 5_200, salePrice: 7_500, stock: 850, stockMin: 200 },

  // Alucobond
  { name: 'Panneau Alucobond 4 mm rouge', category: 'Alucobond', unit: 'm²', purchasePrice: 145_000, salePrice: 210_000, stock: 96.5, stockMin: 20 },
  { name: 'Panneau Alucobond 4 mm argent', category: 'Alucobond', unit: 'm²', purchasePrice: 148_000, salePrice: 215_000, stock: 62.25, stockMin: 20 },
  { name: 'Panneau Alucobond 3 mm bleu', category: 'Alucobond', unit: 'm²', purchasePrice: 125_000, salePrice: 185_000, stock: 12, stockMin: 20 },

  // Staff
  { name: 'Staff décoratif en poudre', category: 'Staff', unit: 'sac', purchasePrice: 78_000, salePrice: 115_000, stock: 40, stockMin: 10 },
  { name: 'Corniche staff 2 m', category: 'Staff', unit: 'pièce', purchasePrice: 42_000, salePrice: 68_000, stock: 55, stockMin: 15 },

  // Placo
  { name: 'Plaque BA13 1,20 x 2,60 m', category: 'Placo', unit: 'pièce', purchasePrice: 68_000, salePrice: 98_000, stock: 120, stockMin: 30 },
  { name: 'Rail R48', category: 'Placo', unit: 'pièce', purchasePrice: 22_000, salePrice: 34_000, stock: 180, stockMin: 40 },
  { name: 'Montant M48', category: 'Placo', unit: 'pièce', purchasePrice: 24_000, salePrice: 36_000, stock: 8, stockMin: 40 },

  // Peinture
  { name: 'Peinture acrylique blanche 20 L', category: 'Peinture', unit: 'litre', purchasePrice: 8_500, salePrice: 13_500, stock: 240, stockMin: 60 },
  { name: 'Vernis bois brillant 5 L', category: 'Peinture', unit: 'litre', purchasePrice: 12_000, salePrice: 19_500, stock: 45, stockMin: 20 },
  { name: 'Enduit de lissage 25 kg', category: 'Peinture', unit: 'sac', purchasePrice: 65_000, salePrice: 92_000, stock: 18, stockMin: 10 },

  // Bois
  { name: 'Planche bois rouge 2,5 m', category: 'Bois', unit: 'pièce', purchasePrice: 95_000, salePrice: 140_000, stock: 85, stockMin: 25 },
  { name: 'Chevron 7 x 7 cm — 3 m', category: 'Bois', unit: 'pièce', purchasePrice: 55_000, salePrice: 82_000, stock: 130, stockMin: 30 },
  { name: 'Contreplaqué 15 mm — 2,44 x 1,22 m', category: 'Bois', unit: 'pièce', purchasePrice: 320_000, salePrice: 445_000, stock: 22, stockMin: 8 },
  { name: 'Mousse polyurethane haute densité', category: 'Bois', unit: 'm²', purchasePrice: 48_000, salePrice: 72_000, stock: 34.5, stockMin: 10 },
  { name: 'Tissu d’ameublement au mètre', category: 'Bois', unit: 'm²', purchasePrice: 35_000, salePrice: 58_000, stock: 62, stockMin: 15 },

  // Quincaillerie
  { name: 'Charnière invisible', category: 'Quincaillerie', unit: 'pièce', purchasePrice: 3_500, salePrice: 6_000, stock: 480, stockMin: 100 },
  { name: 'Colle à bois 1 kg', category: 'Quincaillerie', unit: 'pièce', purchasePrice: 28_000, salePrice: 42_000, stock: 36, stockMin: 12 },
  { name: 'Vis à bois 5 x 60 mm (boîte de 200)', category: 'Quincaillerie', unit: 'carton', purchasePrice: 32_000, salePrice: 48_000, stock: 28, stockMin: 10 },
  { name: 'Poignée aluminium brossé', category: 'Quincaillerie', unit: 'pièce', purchasePrice: 9_500, salePrice: 16_000, stock: 145, stockMin: 40 },
  { name: 'Clous 50 mm (1 kg)', category: 'Quincaillerie', unit: 'kg', purchasePrice: 12_000, salePrice: 19_000, stock: 42.5, stockMin: 15 },

  // Matières premières briqueterie
  { name: 'Argile / terre de briqueterie', category: 'Matière première', unit: 'kg', purchasePrice: 850, salePrice: 0, stock: 12_500, stockMin: 2_000 },
  { name: 'Ciment CEM II 50 kg', category: 'Matière première', unit: 'sac', purchasePrice: 88_000, salePrice: 0, stock: 64, stockMin: 20 },
  { name: 'Sable de rivière', category: 'Matière première', unit: 'kg', purchasePrice: 4_500, salePrice: 0, stock: 3_200, stockMin: 800 },
  { name: 'Eau de gâchage', category: 'Matière première', unit: 'litre', purchasePrice: 0, salePrice: 0, stock: 5_000, stockMin: 500 },
  { name: 'Bois de chauffe (stère)', category: 'Matière première', unit: 'kg', purchasePrice: 1_600, salePrice: 0, stock: 1_450, stockMin: 400 },
];

const CUSTOMERS: { name: string; phone: string; address: string; creditLimit: number }[] = [
  { name: 'Résidence Les Palmiers', phone: '+224 622 11 22 33', address: 'Kipé, Conakry', creditLimit: 50_000_000 },
  { name: 'Hôtel Kaloum Plaza', phone: '+224 621 44 55 66', address: 'Kaloum, Conakry', creditLimit: 80_000_000 },
  { name: 'M. Ibrahima Camara', phone: '+224 664 77 88 99', address: 'Matam, Conakry', creditLimit: 5_000_000 },
  { name: 'Chantier Villa Nongo', phone: '+224 628 33 44 55', address: 'Nongo, Conakry', creditLimit: 25_000_000 },
  { name: 'Mme Fatoumata Diallo', phone: '+224 666 12 34 56', address: 'Ratoma, Conakry', creditLimit: 3_000_000 },
  { name: 'Bureaux Nimba Services', phone: '+224 620 98 76 54', address: 'Taouyah, Conakry', creditLimit: 15_000_000 },
];

const SUPPLIERS: { name: string; phone: string; address: string }[] = [
  { name: 'Scierie Kindia Bois', phone: '+224 655 10 20 30', address: 'Kindia' },
  { name: 'Quincaillerie du Port', phone: '+224 622 40 50 60', address: 'Port de Conakry' },
  { name: 'Cimenterie Guinéenne SA', phone: '+224 664 70 80 90', address: 'Conakry' },
  { name: 'Alucobond Afrique de l’Ouest', phone: '+224 628 11 33 55', address: 'Conakry' },
  { name: 'Carrière de sable Dubréka', phone: '+224 621 22 44 66', address: 'Dubréka' },
];

const WORKERS: { name: string; role: 'foreman' | 'worker' | 'apprentice'; dailyRate: number; specialty: string }[] = [
  { name: 'Sékou Touré', role: 'foreman', dailyRate: 150_000, specialty: 'Chef d’équipe chantier' },
  { name: 'Mamadou Bah', role: 'foreman', dailyRate: 145_000, specialty: 'Chef menuisier' },
  { name: 'Alpha Condé', role: 'worker', dailyRate: 85_000, specialty: 'Pose Alucobond' },
  { name: 'Aïssatou Barry', role: 'worker', dailyRate: 80_000, specialty: 'Peinture et finition' },
  { name: 'Ousmane Sylla', role: 'worker', dailyRate: 82_000, specialty: 'Placo et staff' },
  { name: 'Lamine Diallo', role: 'worker', dailyRate: 78_000, specialty: 'Cuisson des briques' },
  { name: 'Kadiatou Soumah', role: 'apprentice', dailyRate: 45_000, specialty: 'Apprentie menuiserie' },
  { name: 'Ibrahima Kourouma', role: 'apprentice', dailyRate: 42_000, specialty: 'Apprenti briquetier' },
];

/* ------------------------------------------------------------------ *
 * Seed principal
 * ------------------------------------------------------------------ */

export async function seedDemoData(): Promise<SeedReport> {
  const existing = await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM products');
  if (Number(existing?.n ?? 0) > 0) {
    /*
     * Le catalogue est déjà là : on ne le recrée pas (garde d'idempotence),
     * mais on complète les **trois modules de fabrication**, qui peuvent être
     * restés vides sur une base de test déjà remplie — c'est le cas courant
     * chez le client : des produits, des ventes, et aucun chantier.
     */
    const fabrication = await seedFabricationDemoData();

    return {
      categories: 0,
      products: 0,
      customers: 0,
      suppliers: 0,
      workers: 0,
      furnitureModels: 0,
      brickTypes: 0,
      sales: 0,
      purchases: 0,
      expenses: 0,
      ...fabrication,
      skipped: !hasFabricationRows(fabrication),
      message: hasFabricationRows(fabrication)
        ? `Données de démonstration ajoutées aux modules : ${fabricationSummary(fabrication)}. Le catalogue existant n’a pas été touché.`
        : 'Des produits existent déjà et les trois modules de fabrication sont déjà remplis : rien n’a été dupliqué. Réinitialisez d’abord si vous voulez repartir du catalogue de démonstration.',
    };
  }

  const settings = await getSettings();
  const deviceId = await getDeviceId();
  const todayDate = today();

  const syncDefaults = { originDeviceId: deviceId };

  let categoryCount = 0;
  let productCount = 0;
  let customerCount = 0;
  let supplierCount = 0;
  let workerCount = 0;
  let modelCount = 0;
  let brickTypeCount = 0;
  let salesCount = 0;
  let purchaseCount = 0;
  let expenseCount = 0;

  /* ----------------------------- Catégories ------------------------------ */
  const categoryIds = new Map<string, number>();

  for (const category of CATEGORIES) {
    const inserted = await db
      .insert(categories)
      .values({
        name: category.name,
        kind: category.kind,
        description: category.description,
        ...syncDefaults,
      })
      .returning({ id: categories.id });
    categoryIds.set(category.name, inserted[0].id);
    categoryCount += 1;
  }

  /* ------------------------------- Produits ------------------------------ */
  // Le nom du produit est son identifiant : c’est la clé des correspondances ci-dessous.
  const productIds = new Map<string, number>();

  for (const product of PRODUCTS) {
    const categoryId = categoryIds.get(product.category) ?? null;
    const inserted = await db
      .insert(products)
      .values({
        name: product.name,
        categoryId,
        unit: product.unit,
        purchasePrice: product.purchasePrice,
        salePrice: product.salePrice,
        // Le stock est posé par les mouvements d'entrée ci-dessous : on part de 0
        // pour que l'invariant « stock = somme des mouvements » reste vrai.
        stock: 0,
        stockMin: product.stockMin,
        ...syncDefaults,
      })
      .returning({ id: products.id });
    productIds.set(product.name, inserted[0].id);
    productCount += 1;

    if (product.stock > 0) {
      await db.insert(stockMovements).values({
        productId: inserted[0].id,
        type: 'entry',
        quantity: product.stock,
        motif: 'Stock initial de démonstration',
        stockBefore: 0,
        stockAfter: product.stock,
        referenceType: 'inventory',
        referenceId: null,
        ...syncDefaults,
      });

      await db
        .update(products)
        .set({ stock: product.stock })
        .where(eq(products.id, inserted[0].id));
    }
  }

  /* ------------------------------ Partenaires ---------------------------- */
  const customerIds: number[] = [];
  for (const customer of CUSTOMERS) {
    const inserted = await db
      .insert(customers)
      .values({ ...customer, ...syncDefaults })
      .returning({ id: customers.id });
    customerIds.push(inserted[0].id);
    customerCount += 1;
  }

  const supplierIds: number[] = [];
  for (const supplier of SUPPLIERS) {
    const inserted = await db
      .insert(suppliers)
      .values({ ...supplier, ...syncDefaults })
      .returning({ id: suppliers.id });
    supplierIds.push(inserted[0].id);
    supplierCount += 1;
  }

  /* -------------------------------- Ouvriers ----------------------------- */
  for (const worker of WORKERS) {
    await db.insert(workers).values({ ...worker, ...syncDefaults });
    workerCount += 1;
  }

  /* --------------------------- Modèles de meubles ------------------------ */
  const models: { code: string; name: string; dimensions: string; hours: number; price: number; bom: [string, number][] }[] = [
    {
      code: 'MOD-ARM2',
      name: 'Armoire 2 portes',
      dimensions: '180 x 100 x 55 cm',
      hours: 16,
      price: 2_100_000,
      bom: [
        ['Contreplaqué 15 mm — 2,44 x 1,22 m', 2],
        ['Planche bois rouge 2,5 m', 4],
        ['Charnière invisible', 6],
        ['Poignée aluminium brossé', 2],
        ['Vernis bois brillant 5 L', 1],
      ],
    },
    {
      code: 'MOD-LIT2',
      name: 'Lit 2 places',
      dimensions: '190 x 160 x 90 cm',
      hours: 14,
      price: 2_750_000,
      bom: [
        ['Planche bois rouge 2,5 m', 6],
        ['Chevron 7 x 7 cm — 3 m', 4],
        ['Vis à bois 5 x 60 mm (boîte de 200)', 1],
        ['Vernis bois brillant 5 L', 1],
      ],
    },
    {
      code: 'MOD-TAB6',
      name: 'Table à manger 6 places',
      dimensions: '180 x 90 x 75 cm',
      hours: 12,
      price: 1_850_000,
      bom: [
        ['Planche bois rouge 2,5 m', 5],
        ['Contreplaqué 15 mm — 2,44 x 1,22 m', 1],
        ['Colle à bois 1 kg', 1],
        ['Vernis bois brillant 5 L', 1],
      ],
    },
    {
      code: 'MOD-SAL7',
      name: 'Ensemble salon 7 places',
      dimensions: '280 x 180 x 80 cm',
      hours: 32,
      price: 6_300_000,
      bom: [
        ['Planche bois rouge 2,5 m', 8],
        ['Mousse polyurethane haute densité', 6],
        ['Tissu d’ameublement au mètre', 9],
        ['Clous 50 mm (1 kg)', 2],
      ],
    },
  ];

  for (const model of models) {
    const inserted = await db
      .insert(furnitureModels)
      .values({
        code: model.code,
        name: model.name,
        standardDimensions: model.dimensions,
        laborHours: model.hours,
        salePrice: model.price,
        description: `Modèle standard — ${model.dimensions}`,
        ...syncDefaults,
      })
      .returning({ id: furnitureModels.id });
    modelCount += 1;

    for (const [productName, quantity] of model.bom) {
      const productId = productIds.get(productName);
      if (!productId) continue;
      const product = PRODUCTS.find((p) => p.name === productName);
      await db.insert(furnitureModelMaterials).values({
        modelId: inserted[0].id,
        productId,
        quantity,
        unit: product?.unit ?? 'pièce',
        ...syncDefaults,
      });
    }
  }

  /* ---------------------------- Types de briques ------------------------- */
  const bricks: { name: string; shape: 'solid' | 'hollow' | 'block'; dimensions: string }[] = [
    { name: 'Brique pleine 15 trous', shape: 'solid', dimensions: '22,5 x 10,5 x 6 cm' },
    { name: 'Brique creuse 12 trous', shape: 'hollow', dimensions: '30 x 20 x 15 cm' },
    { name: 'Bloc béton 20x20x40', shape: 'block', dimensions: '40 x 20 x 20 cm' },
  ];

  for (const brick of bricks) {
    const productId = productIds.get(brick.name);
    if (!productId) continue;
    await db.insert(brickTypes).values({
      productId,
      name: brick.name,
      shape: brick.shape,
      dimensions: brick.dimensions,
      ...syncDefaults,
    });
    brickTypeCount += 1;
  }

  /* ------------------- Transactions de démonstration -------------------- */
  /*
   * Historique de démonstration sur **24 mois** — deux années civiles — pour que
   * les filtres aient tous de quoi travailler : « Aujourd'hui » (des ventes du
   * jour), « Semaine », « Mois », « Année » (deux années distinctes) et « Total »
   * (tout l'historique). Les rapports comparatifs trouvent ainsi toujours un
   * « mois précédent ».
   *
   * Une **session de caisse par mois** : les mois passés sont **clôturés** (avec
   * un écart de comptage de temps en temps, sinon la colonne « Écart » resterait
   * vide), le mois courant reste **ouvert**. Une session = un mois, un montant
   * d'ouverture, un théorique, un compté, un écart.
   *
   * Les documents sont insérés **dans l'ordre chronologique**, mois par mois.
   * C'est indispensable : le stock (`stockBefore`/`stockAfter`) et le solde de
   * caisse (`balanceAfter`) doivent se lire dans le même ordre que les dates.
   */
  const HISTORY_MONTHS = 24;
  /** Fond de caisse du premier mois (espèces réellement présentes : réaliste). */
  const OPENING_FUND = 8_000_000;
  /** Plancher d'espèces : un tiroir ne passe jamais sous ce montant. */
  const CASH_FLOOR = 500_000;

  const monthOf = (date: string) => date.slice(0, 7);

  /** Premier jour du mois décalé de `delta` mois. */
  function shiftMonth(start: string, delta: number): string {
    const year = Number(start.slice(0, 4));
    const month = Number(start.slice(5, 7));
    const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  /** Jour `day` du mois, ramené au dernier jour réel (février, mois de 30 jours). */
  function dayOfMonth(start: string, day: number): string {
    const year = Number(start.slice(0, 4));
    const month = Number(start.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${start.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  }

  /* ------------------------------- Les plans ------------------------------ */

  type PlannedSale = {
    kind: 'sale';
    date: string;
    customerIndex: number | null;
    lines: [string, number][];
    paidRatio: number;
    method: string;
  };
  type PlannedPurchase = {
    kind: 'purchase';
    date: string;
    supplierIndex: number;
    lines: [string, number][];
    paidRatio: number;
    note: string;
  };
  type PlannedCharge = {
    kind: 'charge';
    date: string;
    category: string;
    amount: number;
    description: string;
    method: string;
  };
  type PlannedDoc = PlannedSale | PlannedPurchase | PlannedCharge;

  /** Fournisseur cohérent avec la catégorie du produit réapprovisionné. */
  function supplierForProduct(name: string): number {
    const product = PRODUCTS.find((p) => p.name === name);
    switch (product?.category) {
      case 'Meuble':
      case 'Bois':
        return 0; // Scierie Kindia Bois
      case 'Quincaillerie':
      case 'Peinture':
      case 'Placo':
      case 'Staff':
        return 1; // Quincaillerie du Port
      case 'Alucobond':
        return 3; // Alucobond Afrique de l'Ouest
      default:
        return 2; // Cimenterie Guinéenne SA (briques, ciment, sable)
    }
  }

  /** Paniers qui tournent d'un mois sur l'autre (les graphiques ne sont pas figés). */
  const SALE_BASKETS: [string, number][][] = [
    [
      ['Ensemble salon complet', 1],
      ['Chaise bois massif', 6],
    ],
    [
      ['Armoire 2 portes standard', 2],
      ['Table à manger 6 places', 1],
    ],
    [
      ['Panneau Alucobond 4 mm rouge', 24.5],
      ['Rail R48', 40],
      ['Plaque BA13 1,20 x 2,60 m', 30],
    ],
    [
      ['Bloc béton 20x20x40', 150],
      ['Brique pleine 15 trous', 400],
    ],
    [
      ['Lit 2 places avec tête de lit', 1],
      ['Buffet bas 4 portes', 2],
    ],
    [
      ['Peinture acrylique blanche 20 L', 60],
      ['Vernis bois brillant 5 L', 8],
      ['Enduit de lissage 25 kg', 6],
    ],
    [
      ['Bureau de direction', 1],
      ['Chaise bois massif', 12],
      ['Contreplaqué 15 mm — 2,44 x 1,22 m', 4],
    ],
    [
      ['Staff décoratif en poudre', 12],
      ['Corniche staff 2 m', 18],
    ],
  ];

  const SALE_METHODS = ['Espèces', 'Espèces', 'Mobile Money', 'Virement', 'Espèces', 'Mobile Money'];

  /** Charges de structure, chaque mois, à des jours fixes. */
  const MONTHLY_CHARGES: { day: number; category: string; amount: number; description: string; method: string }[] = [
    { day: 3, category: 'Loyer', amount: 3_500_000, description: 'Loyer du magasin', method: 'Virement' },
    { day: 8, category: 'Électricité', amount: 1_250_000, description: 'Facture EDG', method: 'Mobile Money' },
    { day: 12, category: 'Carburant', amount: 850_000, description: 'Carburant camion de livraison', method: 'Espèces' },
    { day: 18, category: 'Transport', amount: 620_000, description: 'Transport de marchandises Dubréka → Conakry', method: 'Espèces' },
    { day: 27, category: 'Salaire', amount: 4_800_000, description: 'Salaires des journaliers', method: 'Espèces' },
  ];

  /**
   * Ventes du **mois courant** : jeu écrit à la main, volontairement varié
   * (comptoir, crédit partiel, Mobile Money, virement) pour que « Aujourd'hui »
   * et « Semaine » soient parlants.
   */
  const CURRENT_MONTH_SALES: { customerIndex: number | null; daysAgo: number; lines: [string, number][]; paidRatio: number; method: string }[] = [
    { customerIndex: 0, daysAgo: 21, lines: [['Ensemble salon complet', 1], ['Chaise bois massif', 6]], paidRatio: 1, method: 'Virement' },
    { customerIndex: 2, daysAgo: 17, lines: [['Lit 2 places avec tête de lit', 1]], paidRatio: 0.5, method: 'Mobile Money' },
    { customerIndex: 3, daysAgo: 14, lines: [['Panneau Alucobond 4 mm rouge', 24.5], ['Plaque BA13 1,20 x 2,60 m', 40], ['Peinture acrylique blanche 20 L', 60]], paidRatio: 0.3, method: 'Espèces' },
    { customerIndex: 1, daysAgo: 10, lines: [['Armoire 2 portes standard', 4], ['Table à manger 6 places', 2]], paidRatio: 1, method: 'Virement' },
    { customerIndex: 4, daysAgo: 6, lines: [['Buffet bas 4 portes', 1]], paidRatio: 1, method: 'Espèces' },
    { customerIndex: null, daysAgo: 5, lines: [['Brique pleine 15 trous', 500], ['Brique creuse 12 trous', 300]], paidRatio: 1, method: 'Espèces' },
    { customerIndex: 5, daysAgo: 3, lines: [['Plaque BA13 1,20 x 2,60 m', 30], ['Rail R48', 40], ['Vernis bois brillant 5 L', 8]], paidRatio: 0.6, method: 'Mobile Money' },
    { customerIndex: 0, daysAgo: 2, lines: [['Chaise bois massif', 12], ['Bureau de direction', 1]], paidRatio: 0.25, method: 'Espèces' },
    { customerIndex: null, daysAgo: 1, lines: [['Peinture acrylique blanche 20 L', 20], ['Clous 50 mm (1 kg)', 5.5]], paidRatio: 1, method: 'Espèces' },
    { customerIndex: 3, daysAgo: 0, lines: [['Bloc béton 20x20x40', 150], ['Brique creuse 12 trous', 200]], paidRatio: 1, method: 'Mobile Money' },
  ];

  /** Charges du mois courant (dates réelles, comme les ventes ci-dessus). */
  const CURRENT_MONTH_CHARGES: { category: string; amount: number; description: string; daysAgo: number; method: string }[] = [
    { category: 'Loyer', amount: 3_500_000, description: 'Loyer du magasin — mois en cours', daysAgo: 20, method: 'Virement' },
    { category: 'Carburant', amount: 850_000, description: 'Carburant camion de livraison', daysAgo: 15, method: 'Espèces' },
    { category: 'Électricité', amount: 1_250_000, description: 'Facture EDG', daysAgo: 12, method: 'Mobile Money' },
    { category: 'Transport', amount: 620_000, description: 'Transport de marchandises Dubréka → Conakry', daysAgo: 8, method: 'Espèces' },
    { category: 'Salaire', amount: 4_800_000, description: 'Salaires des journaliers', daysAgo: 5, method: 'Espèces' },
    { category: 'Autre', amount: 320_000, description: 'Fournitures de bureau', daysAgo: 2, method: 'Espèces' },
  ];

  const currentMonthStart = `${monthOf(todayDate)}-01`;
  const taxRate = settings.defaultTaxRate;

  /**
   * Construction des plans, du mois le plus ancien au mois courant.
   *
   * Le volume varie d'un mois sur l'autre (facteur ci-dessous) : les graphiques
   * montrent une activité réelle, pas une ligne plate. L'objectif de calibrage
   * est que la boutique soit **rentable** (marge brute > charges), sinon les
   * écrans Soldes et Rapports afficheraient une entreprise qui perd de l'argent.
   */
  const VOLUME_FACTORS = [1.6, 1.9, 1.3, 2.1, 1.7, 1.4, 2, 1.5];
  const plansByMonth = new Map<string, PlannedDoc[]>();

  /*
   * Les documents sont rangés **par mois de leur date**, jamais par le mois
   * « courant » supposé : une vente d'il y a 21 jours peut tomber dans le mois
   * précédent (le 5 du mois, 21 jours en arrière = le mois d'avant). Le
   * classement par date évite une session qui mélange deux mois.
   */
  const bucketFor = (date: string): PlannedDoc[] => {
    const key = `${monthOf(date)}-01`;
    const list = plansByMonth.get(key) ?? [];
    plansByMonth.set(key, list);
    return list;
  };

  // Une entrée par mois, même sans document : chaque mois a sa session de caisse.
  for (let offset = HISTORY_MONTHS - 1; offset >= 0; offset -= 1) {
    bucketFor(shiftMonth(currentMonthStart, -offset));
  }

  for (let offset = HISTORY_MONTHS - 1; offset >= 0; offset -= 1) {
    const start = shiftMonth(currentMonthStart, -offset);

    if (offset === 0) {
      for (const sale of CURRENT_MONTH_SALES) {
        bucketFor(addDays(todayDate, -sale.daysAgo)).push({
          kind: 'sale',
          date: addDays(todayDate, -sale.daysAgo),
          customerIndex: sale.customerIndex,
          lines: sale.lines,
          paidRatio: sale.paidRatio,
          method: sale.method,
        });
      }
      for (const charge of CURRENT_MONTH_CHARGES) {
        bucketFor(addDays(todayDate, -charge.daysAgo)).push({
          kind: 'charge',
          date: addDays(todayDate, -charge.daysAgo),
          category: charge.category,
          amount: charge.amount,
          description: charge.description,
          method: charge.method,
        });
      }
    } else {
      const docs = bucketFor(start);
      const volume = VOLUME_FACTORS[offset % VOLUME_FACTORS.length];
      const saleCount = 5 + (offset % 3); // 5 à 7 ventes par mois
      const saleDays = [4, 9, 14, 19, 24, 28];
      for (let index = 0; index < saleCount; index += 1) {
        const basket = SALE_BASKETS[(offset + index) % SALE_BASKETS.length];
        docs.push({
          kind: 'sale',
          date: dayOfMonth(start, saleDays[index % saleDays.length]),
          // Un client sur trois est « de passage » (vente comptoir).
          customerIndex: (offset + index) % 3 === 0 ? null : (offset + index) % CUSTOMERS.length,
          lines: basket.map(([name, quantity]) => [name, Math.max(1, Math.round(quantity * volume))] as [string, number]),
          paidRatio: (offset + index) % 4 === 0 ? 0.5 : 1,
          method: SALE_METHODS[(offset + index) % SALE_METHODS.length],
        });
      }

      for (const charge of MONTHLY_CHARGES) {
        docs.push({
          kind: 'charge',
          date: dayOfMonth(start, charge.day),
          category: charge.category,
          amount: charge.amount,
          description: `${charge.description} — ${start.slice(0, 7)}`,
          method: charge.method,
        });
      }
    }
  }

  /*
   * Réapprovisionnement, **au plus juste** : on rachète ce qui manque pour
   * couvrir les ventes du mois, en suivant le **stock simulé mois après mois** —
   * et non le stock initial. C'est ce qui garantit qu'aucun produit ne part en
   * négatif : vendre 96 L de peinture alors qu'il n'y en a que 240 en stock
   * impose de racheter dès le troisième mois, pas au premier.
   *
   * Un réapprovisionnement « au plus juste » est aussi ce que fait un vrai
   * magasin, et il évite de vider la trésorerie au premier mois.
   */
  const plannedStock = new Map<string, number>(PRODUCTS.map((p) => [p.name, p.stock]));

  /*
   * Le **mois courant** est réapprovisionné comme les autres : ses ventes du mois
   * (et celles qui débordent sur le mois précédent) doivent être couvertes par du
   * stock réel, sinon la dernière vente de la période part en négatif.
   */
  for (let offset = HISTORY_MONTHS - 1; offset >= 0; offset -= 1) {
    const start = shiftMonth(currentMonthStart, -offset);
    const docs = plansByMonth.get(start) ?? [];

    const consumed = new Map<string, number>();
    for (const doc of docs) {
      if (doc.kind !== 'sale') continue;
      for (const [name, quantity] of doc.lines) {
        consumed.set(name, (consumed.get(name) ?? 0) + quantity);
      }
    }

    const bySupplier = new Map<number, [string, number][]>();
    for (const [name, quantity] of consumed) {
      const available = plannedStock.get(name) ?? 0;
      // On vise le mois suivant avec 15 % de marge de sécurité.
      const needed = Math.ceil(quantity * 1.15) - available;
      if (needed <= 0) {
        plannedStock.set(name, available - quantity);
        continue;
      }
      const supplierIndex = supplierForProduct(name);
      const lines = bySupplier.get(supplierIndex) ?? [];
      lines.push([name, needed]);
      bySupplier.set(supplierIndex, lines);
      plannedStock.set(name, available + needed - quantity);
    }

    let purchaseIndex = 0;
    for (const [supplierIndex, lines] of bySupplier) {
      purchaseIndex += 1;
      docs.push({
        kind: 'purchase',
        date: dayOfMonth(start, purchaseIndex),
        supplierIndex,
        lines,
        // Les deux premiers mois sont à moitié à crédit : la liste des
        // fournisseurs montre ainsi de vraies dettes, et le tiroir respire.
        paidRatio: offset >= HISTORY_MONTHS - 2 || offset % 5 === 0 ? 0.5 : 1,
        note: `Réapprovisionnement ${start.slice(0, 7)}`,
      });
    }
  }

  /* ----------------------------- Insertion ------------------------------- */

  const sequenceUsage = {
    invoice: new Map<number, number>(),
    purchase: new Map<number, number>(),
    receipt: new Map<number, number>(),
  };

  const recordSequence = (kind: 'invoice' | 'purchase' | 'receipt', year: number, value: number) => {
    const map = sequenceUsage[kind];
    map.set(year, Math.max(map.get(year) ?? 0, value));
  };

  /** Solde par moyen de paiement : sert à ne jamais assécher un moyen. */
  const balanceByMethod = new Map<string, number>();
  /** Écarts de comptage semés dans l'historique (le plus souvent : aucun écart). */
  const countingGaps = [-15_000, 0, 0, 0, 25_000, 0, -5_000];

  let cashBalance = 0;
  let saleSequence = 0;
  let purchaseSequence = 0;
  let receiptSequence = 100;
  let monthIndex = 0;

  /** Choisit le moyen de paiement d'une sortie sans jamais assécher la caisse. */
  function payoutMethod(amount: number, preferred: string): string {
    const floorFor = (method: string) => (method === 'Espèces' ? CASH_FLOOR : 0);
    const candidates = [preferred, 'Espèces', 'Mobile Money', 'Virement'];

    for (const method of candidates) {
      if ((balanceByMethod.get(method) ?? 0) - amount >= floorFor(method)) return method;
    }

    // Aucun moyen ne couvre seul : on prend celui qui a le plus de fonds.
    let best = preferred;
    let bestBalance = Number.NEGATIVE_INFINITY;
    for (const method of candidates) {
      const balance = balanceByMethod.get(method) ?? 0;
      if (balance > bestBalance) {
        best = method;
        bestBalance = balance;
      }
    }
    return best;
  }

  for (let offset = HISTORY_MONTHS - 1; offset >= 0; offset -= 1) {
    const start = shiftMonth(currentMonthStart, -offset);
    const docs = plansByMonth.get(start) ?? [];
    const isCurrentMonth = offset === 0;

    /*
     * Report du fond de caisse **par moyen de paiement**.
     *
     * Chaque session démarre par une entrée d'ouverture *par moyen* : ce qui
     * reste en espèces, en Mobile Money et en banque. Un seul mouvement
     * d'ouverture « Espèces » (comme avant) faussait toute la répartition par
     * moyen de l'écran Caisse : le report entier y apparaissait comme un
     * encaissement en espèces.
     */
    const openingAmount = cashBalance === 0 ? OPENING_FUND : cashBalance;
    if (cashBalance === 0) balanceByMethod.set('Espèces', OPENING_FUND);
    const closedAt = new Date(`${dayOfMonth(start, 28)}T18:00:00Z`);

    const session = await db
      .insert(cashSessions)
      .values({
        status: isCurrentMonth ? 'open' : 'closed',
        openedAt: new Date(`${start}T08:00:00Z`),
        openingAmount,
        closedAt: isCurrentMonth ? null : closedAt,
        notes: isCurrentMonth
          ? 'Session de démonstration — mois en cours'
          : `Session de démonstration — ${start.slice(0, 7)}`,
        ...syncDefaults,
      })
      .returning({ id: cashSessions.id });

    const sessionId = session[0].id;
    cashBalance = 0;

    for (const method of ['Espèces', 'Mobile Money', 'Virement']) {
      const carried = balanceByMethod.get(method) ?? 0;
      if (carried <= 0) continue;
      cashBalance += carried;
      await db.insert(cashMovements).values({
        type: 'income',
        amount: carried,
        paymentMethod: method,
        motif: `Montant d'ouverture de caisse — ${method}`,
        referenceType: 'manual',
        sessionId,
        balanceAfter: cashBalance,
        date: start,
        ...syncDefaults,
      });
    }

    docs.sort((a, b) => a.date.localeCompare(b.date));

    for (const doc of docs) {
      /* ------------------------------ Achat ------------------------------ */
      if (doc.kind === 'purchase') {
        purchaseSequence += 1;
        const purchaseYear = Number(doc.date.slice(0, 4));
        recordSequence('purchase', purchaseYear, purchaseSequence);

        const lines = doc.lines.map(([name, quantity]) => {
          const seed = PRODUCTS.find((p) => p.name === name)!;
          return { name, quantity, unitPrice: seed.purchasePrice, amount: seed.purchasePrice * quantity };
        });

        const total = lines.reduce((sum, line) => sum + line.amount, 0);
        const amountPaid = Math.round(total * doc.paidRatio);
        const remaining = total - amountPaid;
        const method = amountPaid > 0 ? payoutMethod(amountPaid, 'Virement') : 'Crédit';

        const invoice = await db
          .insert(purchaseInvoices)
          .values({
            reference: renderDocumentNumber(settings.purchasePrefix, purchaseSequence, settings.invoiceNumberFormat, purchaseYear),
            supplierId: supplierIds[doc.supplierIndex],
            date: doc.date,
            dueDate: addDays(doc.date, 30),
            total,
            amountPaid,
            remainingAmount: remaining,
            paymentStatus: amountPaid <= 0 ? 'unpaid' : remaining <= 0 ? 'paid' : 'partial',
            paymentMethod: amountPaid > 0 ? method : 'Crédit',
            ...syncDefaults,
          })
          .returning({ id: purchaseInvoices.id });

        for (const line of lines) {
          const productId = productIds.get(line.name)!;
          const seed = PRODUCTS.find((p) => p.name === line.name)!;

          await db.insert(purchaseInvoiceItems).values({
            invoiceId: invoice[0].id,
            productId,
            productName: seed.name,
            unit: seed.unit,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            amount: line.amount,
            ...syncDefaults,
          });

          const [current] = await db
            .select({ stock: products.stock })
            .from(products)
            .where(eq(products.id, productId));

          const stockBefore = Number(current?.stock ?? 0);
          const stockAfter = stockBefore + line.quantity;

          await db.insert(stockMovements).values({
            productId,
            type: 'entry',
            quantity: line.quantity,
            motif: doc.note,
            stockBefore,
            stockAfter,
            referenceType: 'purchase',
            referenceId: invoice[0].id,
            ...syncDefaults,
          });

          await db.update(products).set({ stock: stockAfter }).where(eq(products.id, productId));
        }

        if (amountPaid > 0) {
          receiptSequence += 1;
          recordSequence('receipt', purchaseYear, receiptSequence);
          await db.insert(payments).values({
            receiptNumber: renderDocumentNumber(settings.receiptPrefix, receiptSequence, settings.invoiceNumberFormat, purchaseYear),
            type: 'purchase',
            referenceId: invoice[0].id,
            amount: amountPaid,
            paymentMethod: method,
            paymentLabel: remaining <= 0 ? 'full' : 'deposit',
            date: doc.date,
            notes: 'Règlement de démonstration',
            ...syncDefaults,
          });

          cashBalance -= amountPaid;
          balanceByMethod.set(method, (balanceByMethod.get(method) ?? 0) - amountPaid);
          await db.insert(cashMovements).values({
            type: 'expense',
            amount: amountPaid,
            paymentMethod: method,
            motif: `Règlement achat (démonstration) — ${doc.note}`,
            referenceType: 'purchase',
            referenceId: invoice[0].id,
            sessionId,
            balanceAfter: cashBalance,
            date: doc.date,
            ...syncDefaults,
          });
        }

        purchaseCount += 1;
        continue;
      }

      /* ------------------------------ Vente ------------------------------ */
      if (doc.kind === 'sale') {
        saleSequence += 1;
        const saleYear = Number(doc.date.slice(0, 4));
        recordSequence('invoice', saleYear, saleSequence);

        const lines = doc.lines.map(([name, quantity]) => {
          const seed = PRODUCTS.find((p) => p.name === name)!;
          return { name, seed, quantity, unitPrice: seed.salePrice, amount: seed.salePrice * quantity };
        });

        const subTotal = lines.reduce((sum, line) => sum + line.amount, 0);
        const discount = 0;
        const totalHt = subTotal - discount;
        const taxAmount = Math.round((totalHt * taxRate) / 100);
        const total = totalHt + taxAmount;
        const amountPaid = Math.round(total * doc.paidRatio);
        const remaining = total - amountPaid;

        const customerName =
          doc.customerIndex === null ? 'Client comptoir' : CUSTOMERS[doc.customerIndex].name;

        const invoice = await db
          .insert(salesInvoices)
          .values({
            invoiceNumber: renderDocumentNumber(settings.invoicePrefix, saleSequence, settings.invoiceNumberFormat, saleYear),
            customerId: doc.customerIndex === null ? null : customerIds[doc.customerIndex],
            customerName,
            date: doc.date,
            dueDate: remaining > 0 ? addDays(doc.date, 30) : null,
            subTotal,
            discount,
            totalHt,
            taxRate,
            taxAmount,
            total,
            amountPaid,
            remainingAmount: remaining,
            paymentStatus: amountPaid <= 0 ? 'unpaid' : remaining <= 0 ? 'paid' : 'partial',
            paymentMethod: doc.method,
            status: 'active',
            ...syncDefaults,
          })
          .returning({ id: salesInvoices.id });

        for (const line of lines) {
          const productId = productIds.get(line.name)!;

          await db.insert(salesInvoiceItems).values({
            invoiceId: invoice[0].id,
            productId,
            productName: line.seed.name,
            unit: line.seed.unit,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discount: 0,
            amount: line.amount,
            ...syncDefaults,
          });

          const [current] = await db
            .select({ stock: products.stock })
            .from(products)
            .where(eq(products.id, productId));

          const stockBefore = Number(current?.stock ?? 0);
          const stockAfter = stockBefore - line.quantity;

          await db.insert(stockMovements).values({
            productId,
            type: 'exit',
            quantity: line.quantity,
            motif: `Vente (démonstration)`,
            stockBefore,
            stockAfter,
            referenceType: 'sale',
            referenceId: invoice[0].id,
            ...syncDefaults,
          });

          await db.update(products).set({ stock: stockAfter }).where(eq(products.id, productId));
        }

        if (amountPaid > 0) {
          receiptSequence += 1;
          recordSequence('receipt', saleYear, receiptSequence);
          await db.insert(payments).values({
            receiptNumber: renderDocumentNumber(settings.receiptPrefix, receiptSequence, settings.invoiceNumberFormat, saleYear),
            type: 'sale',
            referenceId: invoice[0].id,
            amount: amountPaid,
            paymentMethod: doc.method,
            paymentLabel: remaining <= 0 ? 'full' : 'deposit',
            date: doc.date,
            notes: 'Encaissement de démonstration',
            ...syncDefaults,
          });

          cashBalance += amountPaid;
          balanceByMethod.set(doc.method, (balanceByMethod.get(doc.method) ?? 0) + amountPaid);
          await db.insert(cashMovements).values({
            type: 'income',
            amount: amountPaid,
            paymentMethod: doc.method,
            motif: `Encaissement vente (démonstration)`,
            referenceType: 'sale',
            referenceId: invoice[0].id,
            sessionId,
            balanceAfter: cashBalance,
            date: doc.date,
            ...syncDefaults,
          });
        }

        salesCount += 1;
        continue;
      }

      /* ----------------------------- Dépense ----------------------------- */
      const method = payoutMethod(doc.amount, doc.method);

      const inserted = await db
        .insert(expenses)
        .values({
          category: doc.category,
          amount: doc.amount,
          description: doc.description,
          paymentMethod: method,
          date: doc.date,
          ...syncDefaults,
        })
        .returning({ id: expenses.id });

      cashBalance -= doc.amount;
      balanceByMethod.set(method, (balanceByMethod.get(method) ?? 0) - doc.amount);
      await db.insert(cashMovements).values({
        type: 'expense',
        amount: doc.amount,
        paymentMethod: method,
        motif: `Dépense — ${doc.category}`,
        referenceType: 'expense',
        referenceId: inserted[0].id,
        sessionId,
        balanceAfter: cashBalance,
        date: doc.date,
        ...syncDefaults,
      });

      expenseCount += 1;
    }

    /*
     * Clôture du mois : le théorique est le dernier solde de la session ; le
     * compté s'en écarte de temps en temps, et l'écart est **enregistré**, jamais
     * masqué — c'est le principe même de l'écran Caisse.
     */
    if (isCurrentMonth) {
      await db
        .update(cashSessions)
        .set({ theoreticalAmount: cashBalance })
        .where(eq(cashSessions.id, sessionId));
    } else {
      const gap = countingGaps[monthIndex % countingGaps.length];
      const countedAmount = cashBalance + gap;
      await db
        .update(cashSessions)
        .set({
          theoreticalAmount: cashBalance,
          countedAmount,
          difference: countedAmount - cashBalance,
        })
        .where(eq(cashSessions.id, sessionId));
    }

    monthIndex += 1;
  }

  /*
   * Filet de sécurité avant les **modules de fabrication** (chantiers,
   * briqueterie, atelier) : leurs matériaux sortent du stock, et l'historique de
   * vente ci-dessus l'a entamé. On remet chaque produit au moins à son niveau du
   * catalogue, par une **entrée d'inventaire** au motif explicite — sans quoi la
   * consommation suivante partirait en négatif et le préremplissage s'arrêterait
   * sur « Stock insuffisant » (constaté en vérification).
   */
  const productsAfterHistory = await db
    .select({ id: products.id, name: products.name, stock: products.stock })
    .from(products);

  for (const product of productsAfterHistory) {
    const catalogueProduct = PRODUCTS.find((p) => p.name === product.name);
    if (!catalogueProduct) continue;

    const current = Number(product.stock ?? 0);
    if (current >= catalogueProduct.stock) continue;

    await db.insert(stockMovements).values({
      productId: product.id,
      type: 'entry',
      quantity: catalogueProduct.stock - current,
      motif: 'Stock de démonstration — complément avant les chantiers, la briqueterie et l’atelier',
      stockBefore: current,
      stockAfter: catalogueProduct.stock,
      referenceType: 'inventory',
      referenceId: null,
      ...syncDefaults,
    });

    await db
      .update(products)
      .set({ stock: catalogueProduct.stock })
      .where(eq(products.id, product.id));
  }

  /*
   * Remise à niveau des compteurs de numérotation.
   *
   * Sans cette étape, `nextSequence('invoice')` repart de 1 et la première
   * vraie vente tente un numéro déjà pris par le jeu de démonstration : la base
   * refuse l'insertion (numéro unique) et l'utilisateur voit une erreur
   * incompréhensible. On aligne donc chaque compteur sur le plus grand numéro
   * réellement produit, par type et par année.
   */
  for (const [kind, byYear] of Object.entries(sequenceUsage)) {
    for (const [year, value] of byYear) {
      await rawRun(
        `INSERT INTO settings (key, value, updated_at, sync_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [`seq_${kind}_${year}`, String(value), Date.now(), crypto.randomUUID()],
      );
    }
  }

  /*
   * Trois modules de fabrication : chantiers, briqueterie, atelier.
   *
   * ⚠️ Appelés **après** la remise à niveau des compteurs ci-dessus : leurs
   * numéros (`CHA-…`, `BRI-…`, `MEU-…`) et leurs reçus prolongent donc ceux du
   * catalogue, sans jamais réutiliser un numéro déjà pris.
   */
  const fabrication = await seedFabricationDemoData();

  return {
    categories: categoryCount,
    products: productCount,
    customers: customerCount,
    suppliers: supplierCount,
    workers: workerCount,
    furnitureModels: modelCount,
    brickTypes: brickTypeCount,
    sales: salesCount,
    purchases: purchaseCount,
    expenses: expenseCount,
    ...fabrication,
    skipped: false,
    message: `Catalogue de démonstration créé : ${productCount} produits, ${customerCount} clients, ${supplierCount} fournisseurs, ${salesCount} ventes, ${purchaseCount} achats, ${expenseCount} dépenses, ${fabricationSummary(fabrication)}.`,
  };
}

/* ------------------------------------------------------------------ *
 * Modules de fabrication — chantiers, briqueterie, atelier (README §16-18)
 * ------------------------------------------------------------------ */

/**
 * Compteurs du volet « fabrication » du seed : trois modules, neuf tables.
 * Ils sont rendus tels quels dans `SeedReport` pour que la vérification
 * (et le client) puisse constater ce qui a réellement été créé.
 */
type FabricationSeedCounts = {
  serviceJobs: number;
  serviceJobMaterials: number;
  serviceJobWorkers: number;
  brickProductions: number;
  brickProductionMaterials: number;
  brickProductionWorkers: number;
  furnitureOrders: number;
  furnitureOrderMaterials: number;
  furnitureOrderWorkers: number;
};

const EMPTY_FABRICATION_COUNTS: FabricationSeedCounts = {
  serviceJobs: 0,
  serviceJobMaterials: 0,
  serviceJobWorkers: 0,
  brickProductions: 0,
  brickProductionMaterials: 0,
  brickProductionWorkers: 0,
  furnitureOrders: 0,
  furnitureOrderMaterials: 0,
  furnitureOrderWorkers: 0,
};

/** Une seule ligne créée suffit à dire que les modules ont été servis. */
function hasFabricationRows(counts: FabricationSeedCounts): boolean {
  return Object.values(counts).some((value) => value > 0);
}

function fabricationSummary(counts: FabricationSeedCounts): string {
  return `${counts.serviceJobs} chantiers, ${counts.brickProductions} lots de briques, ${counts.furnitureOrders} commandes d’atelier`;
}

/* ------------------------------ Chantiers ------------------------------ */

type JobSeedStatus = 'quote' | 'pending' | 'in_progress' | 'completed';

type JobSeed = {
  /** Nom du client — résolu en base, jamais recréé. */
  customer: string;
  category: 'alucobond' | 'staff' | 'placo' | 'furniture' | 'painting';
  title: string;
  siteAddress: string;
  description: string;
  status: JobSeedStatus;
  quoteStatus: 'draft' | 'sent' | 'accepted';
  /** `null` = chantier encore au devis, donc sans date de début (§19). */
  startDaysAgo: number | null;
  endDaysAgo: number | null;
  /** Matériaux réellement sortis du stock : [nom du produit, quantité]. */
  materials: [string, number][];
  /** Équipe affectée : [nom de l'ouvrier, jours]. */
  team: [string, number][];
  /**
   * Estimation du devis, saisie à la main — **utilisée seulement tant qu'aucune
   * ligne n'existe**. Dès qu'un matériau ou un ouvrier est ajouté, le devis est
   * réaligné sur le réalisé, exactement comme `recomputeJobTotals()`.
   */
  quoteMaterials: number;
  quoteLabor: number;
  /** Encaissements : part du total, libellé, moyen, ancienneté en jours. */
  payments: { ratio: number; label: 'deposit' | 'balance' | 'full'; method: string; daysAgo: number }[];
};

const JOBS: JobSeed[] = [
  {
    // 1. Devis envoyé, travaux non commencés : aucune ligne, aucun encaissement.
    customer: 'Bureaux Nimba Services',
    category: 'placo',
    title: 'Cloisons et faux plafond — plateau 2',
    siteAddress: 'Taouyah, Conakry',
    description:
      'Montage de cloisons placo et d’un faux plafond sur 180 m² de bureaux. Devis remis au maître d’ouvrage, travaux non commencés.',
    status: 'quote',
    quoteStatus: 'sent',
    startDaysAgo: null,
    endDaysAgo: null,
    materials: [],
    team: [],
    quoteMaterials: 8_500_000,
    quoteLabor: 3_200_000,
    payments: [],
  },
  {
    // 2. Chantier en cours : matériaux sortis du stock, équipe sur site, acompte.
    customer: 'Hôtel Kaloum Plaza',
    category: 'alucobond',
    title: 'Habillage façade Alucobond — aile nord',
    siteAddress: 'Kaloum, Conakry',
    description:
      'Pose de panneaux Alucobond 4 mm sur ossature de l’aile nord. Matériaux sortis du stock, équipe sur site depuis douze jours.',
    status: 'in_progress',
    quoteStatus: 'accepted',
    startDaysAgo: 12,
    endDaysAgo: null,
    materials: [
      ['Panneau Alucobond 4 mm rouge', 45],
      ['Panneau Alucobond 4 mm argent', 30],
      ['Vis à bois 5 x 60 mm (boîte de 200)', 4],
    ],
    team: [
      ['Sékou Touré', 12],
      ['Alpha Condé', 12],
    ],
    quoteMaterials: 0,
    quoteLabor: 0,
    payments: [{ ratio: 0.4, label: 'deposit', method: 'Virement', daysAgo: 11 }],
  },
  {
    // 3. Chantier terminé : facturé et intégralement encaissé (acompte + solde).
    customer: 'Résidence Les Palmiers',
    category: 'painting',
    title: 'Peinture et finitions — six appartements',
    siteAddress: 'Kipé, Conakry',
    description:
      'Enduit, peinture acrylique et finitions des parties communes et de six appartements. Chantier terminé, facturé et payé.',
    status: 'completed',
    quoteStatus: 'accepted',
    startDaysAgo: 25,
    endDaysAgo: 18,
    materials: [
      ['Peinture acrylique blanche 20 L', 80],
      ['Enduit de lissage 25 kg', 6],
      ['Plaque BA13 1,20 x 2,60 m', 18],
      ['Rail R48', 30],
    ],
    team: [
      ['Aïssatou Barry', 14],
      ['Ousmane Sylla', 12],
    ],
    quoteMaterials: 0,
    quoteLabor: 0,
    payments: [
      { ratio: 0.5, label: 'deposit', method: 'Virement', daysAgo: 24 },
      { ratio: 0.5, label: 'balance', method: 'Espèces', daysAgo: 17 },
    ],
  },
];

/* ----------------------------- Briqueterie ----------------------------- */

type BrickProductionSeed = {
  /** Nom du type de brique — le type porte le produit qui recevra le stock. */
  brickType: string;
  plannedQuantity: number;
  producedQuantity: number;
  brokenQuantity: number;
  stage: 'molding' | 'drying' | 'firing' | 'stored';
  startDaysAgo: number;
  endDaysAgo: number | null;
  notes: string;
  /** Matières premières sorties du stock : [nom du produit, quantité]. */
  materials: [string, number][];
  /** Équipe affectée : [nom de l'ouvrier, jours]. */
  team: [string, number][];
};

const BRICK_PRODUCTION_SEEDS: BrickProductionSeed[] = [
  {
    // 1. Moulage : les matières premières sont sorties, rien n’est encore cuit.
    brickType: 'Brique creuse 12 trous',
    plannedQuantity: 3_000,
    producedQuantity: 0,
    brokenQuantity: 0,
    stage: 'molding',
    startDaysAgo: 2,
    endDaysAgo: null,
    notes: 'Moulage en cours : argile, sable et eau sortis du stock. Séchage prévu cette semaine.',
    materials: [
      ['Argile / terre de briqueterie', 4_000],
      ['Sable de rivière', 550],
      ['Eau de gâchage', 400],
    ],
    team: [
      ['Lamine Diallo', 2],
      ['Ibrahima Kourouma', 2],
    ],
  },
  {
    // 2. Cuisson avec casse : les briques cassées ne sortiront du stock qu’à la
    //    mise en stock (avant, il n’y a rien à sortir — §17).
    brickType: 'Brique pleine 15 trous',
    plannedQuantity: 5_000,
    producedQuantity: 5_000,
    brokenQuantity: 320,
    stage: 'firing',
    startDaysAgo: 9,
    endDaysAgo: null,
    notes:
      'Cuisson au four en cours. 320 briques cassées au démoulage : la perte sortira du stock à la mise en stock.',
    materials: [
      ['Argile / terre de briqueterie', 5_500],
      ['Sable de rivière', 700],
      ['Eau de gâchage', 700],
      ['Bois de chauffe (stère)', 700],
    ],
    team: [
      ['Lamine Diallo', 9],
      ['Ibrahima Kourouma', 7],
    ],
  },
  {
    // 3. Lot terminé et mis en stock : 1 850 blocs vendables, 150 cassés.
    brickType: 'Bloc béton 20x20x40',
    plannedQuantity: 2_000,
    producedQuantity: 2_000,
    brokenQuantity: 150,
    stage: 'stored',
    startDaysAgo: 30,
    endDaysAgo: 16,
    notes: 'Lot terminé et mis en stock : 1 850 blocs vendables, 150 cassés au démoulage.',
    materials: [
      ['Ciment CEM II 50 kg', 40],
      ['Sable de rivière', 900],
      ['Eau de gâchage', 400],
    ],
    team: [
      ['Lamine Diallo', 6],
      ['Ibrahima Kourouma', 6],
      ['Sékou Touré', 2],
    ],
  },
];

/* -------------------------------- Atelier ------------------------------ */

type FurnitureOrderSeed = {
  /** Code du modèle — sa nomenclature fournit les matières à consommer. */
  modelCode: string;
  /** Produit fini crédité en stock à la livraison. */
  productName: string;
  customer: string;
  quantity: number;
  finish: string;
  dimensions: string;
  stage: 'cutting' | 'assembly' | 'sanding' | 'painting' | 'finishing' | 'delivered';
  startDaysAgo: number;
  /** Date promise, en jours par rapport à aujourd’hui (négatif = passée). */
  promisedInDays: number;
  deliveryDaysAgo: number | null;
  agreedPrice: number;
  amountPaid: number;
  notes: string;
  /** Chutes constatées : [nom du produit, quantité] — mouvement `exit` distinct. */
  wastage: [string, number][];
  /** Équipe affectée : [nom de l'ouvrier, jours]. */
  team: [string, number][];
};

const FURNITURE_ORDER_SEEDS: FurnitureOrderSeed[] = [
  {
    // 1. Découpe : matières sorties, aucune finition commencée.
    modelCode: 'MOD-TAB6',
    productName: 'Table à manger 6 places',
    customer: 'Mme Fatoumata Diallo',
    quantity: 2,
    finish: 'Vernis naturel',
    dimensions: '180 x 90 x 75 cm',
    stage: 'cutting',
    startDaysAgo: 3,
    promisedInDays: 12,
    deliveryDaysAgo: null,
    agreedPrice: 3_700_000,
    amountPaid: 1_000_000,
    notes: 'Découpe des panneaux en cours : deux tables identiques pour la même cliente.',
    wastage: [],
    team: [
      ['Mamadou Bah', 2],
      ['Kadiatou Soumah', 3],
    ],
  },
  {
    // 2. Peinture / vernis : assemblage et ponçage faits, chutes constatées.
    modelCode: 'MOD-ARM2',
    productName: 'Armoire 2 portes standard',
    customer: 'Bureaux Nimba Services',
    quantity: 3,
    finish: 'Vernis bois brillant',
    dimensions: '180 x 100 x 55 cm',
    stage: 'painting',
    startDaysAgo: 14,
    promisedInDays: 6,
    deliveryDaysAgo: null,
    agreedPrice: 6_300_000,
    amountPaid: 3_000_000,
    notes: 'Assemblage terminé, ponçage fait : les trois armoires passent au vernis.',
    wastage: [
      ['Planche bois rouge 2,5 m', 1],
      ['Contreplaqué 15 mm — 2,44 x 1,22 m', 1],
    ],
    team: [
      ['Mamadou Bah', 6],
      ['Kadiatou Soumah', 8],
    ],
  },
  {
    // 3. Livrée : le meuble fini est entré en stock à la livraison, une seule fois.
    modelCode: 'MOD-SAL7',
    productName: 'Ensemble salon complet',
    customer: 'Résidence Les Palmiers',
    quantity: 1,
    finish: 'Tissu beige, piètement verni',
    dimensions: '280 x 180 x 80 cm',
    stage: 'delivered',
    startDaysAgo: 40,
    promisedInDays: -20,
    deliveryDaysAgo: 22,
    agreedPrice: 6_300_000,
    amountPaid: 6_300_000,
    notes: 'Commande livrée et payée : le meuble fini est entré en stock à la livraison.',
    wastage: [
      ['Tissu d’ameublement au mètre', 1],
      ['Planche bois rouge 2,5 m', 1],
    ],
    team: [
      ['Mamadou Bah', 12],
      ['Kadiatou Soumah', 16],
      ['Aïssatou Barry', 4],
    ],
  },
];

/**
 * Erreur du seed lui-même : les données de démonstration sont déterministes,
 * donc un stock insuffisant est un défaut du jeu de données, pas une saisie
 * utilisateur. On échoue bruyamment plutôt que de laisser un stock négatif.
 */
class SeedDataError extends Error {}

/**
 * Données de démonstration des **trois modules de fabrication** (README §16-18).
 *
 * ⚠️ **Pourquoi une fonction séparée ?** `seedDemoData()` s'arrête dès que des
 * produits existent — garde d'idempotence du catalogue. Une base de test déjà
 * remplie (produits, ventes, achats) n'aurait donc jamais ses chantiers, ses
 * lots de briques ni ses commandes d'atelier. Cette fonction est appelée dans
 * les **deux** chemins : après le catalogue, et seule quand le catalogue est
 * déjà là.
 *
 * **Idempotence à trois verrous** : chaque module est ignoré si sa table
 * porte déjà la moindre ligne. Un second appel ne crée donc rien — ni ligne de
 * fabrication, ni mouvement de stock, ni paiement, ni numéro consommé.
 *
 * **Référentiels jamais dupliqués** : produits, clients, ouvriers, types de
 * briques, modèles et leur nomenclature sont **résolus en base par leur nom**.
 * Une ligne dont le produit n'existe pas est simplement ignorée.
 *
 * **Invariant du stock (§4)** : comme le reste de ce fichier, l'écriture est
 * directe, donc l'invariant est tenu à la main — chaque matière consommée
 * produit un mouvement `exit` motivé (`reference_type` = `service_job` |
 * `brick_production` | `furniture_order`) **et** décrémente `products.stock` du
 * même montant. Les briques mises en stock et le meuble livré produisent les
 * mouvements symétriques. Aucun stock ne peut devenir négatif : c'est vérifié
 * avant chaque sortie.
 */
async function seedFabricationDemoData(): Promise<FabricationSeedCounts> {
  const counts: FabricationSeedCounts = { ...EMPTY_FABRICATION_COUNTS };

  const settings = await getSettings();
  const syncDefaults = { originDeviceId: await getDeviceId() };
  const todayDate = today();

  /* ---------------- Résolution des référentiels existants -------------- */

  const findProduct = async (name: string) => {
    const row = await rawGet<{
      id: number;
      name: string;
      unit: string;
      purchase_price: number;
    }>(
      `SELECT id, name, unit, purchase_price FROM products
        WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1`,
      [name],
    );
    if (!row) return null;
    return {
      id: Number(row.id),
      name: row.name,
      unit: row.unit,
      purchasePrice: Number(row.purchase_price ?? 0),
    };
  };

  const findCustomerId = async (name: string) => {
    const row = await rawGet<{ id: number }>(
      'SELECT id FROM customers WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1',
      [name],
    );
    return row ? Number(row.id) : null;
  };

  const findWorker = async (name: string) => {
    const row = await rawGet<{
      id: number;
      name: string;
      role: string | null;
      daily_rate: number;
    }>(
      'SELECT id, name, role, daily_rate FROM workers WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1',
      [name],
    );
    if (!row) return null;
    return {
      id: Number(row.id),
      name: row.name,
      role: row.role ?? 'worker',
      dailyRate: Number(row.daily_rate ?? 0),
    };
  };

  const findBrickType = async (name: string) => {
    const row = await rawGet<{ id: number; product_id: number; name: string }>(
      'SELECT id, product_id, name FROM brick_types WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1',
      [name],
    );
    if (!row) return null;
    return { id: Number(row.id), productId: Number(row.product_id), name: row.name };
  };

  const findModel = async (code: string) => {
    const row = await rawGet<{ id: number; name: string }>(
      'SELECT id, name FROM furniture_models WHERE code = ? LIMIT 1',
      [code],
    );
    return row ? { id: Number(row.id), name: row.name } : null;
  };

  /** Nomenclature du modèle : c'est elle qui calcule les besoins (§21). */
  const listModelBom = (modelId: number) =>
    rawAll<{
      product_id: number;
      product_name: string;
      unit: string;
      quantity: number;
      purchase_price: number;
    }>(
      `SELECT b.product_id, p.name AS product_name, p.unit, b.quantity, p.purchase_price
         FROM furniture_model_materials b
         INNER JOIN products p ON p.id = b.product_id
        WHERE b.model_id = ? AND b.deleted_at IS NULL
        ORDER BY b.id`,
      [modelId],
    );

  /* --------------------- Stock : sortie / entrée ----------------------- */

  /**
   * Sortie de stock : mouvement `exit` **et** décrément de `products.stock`.
   * Même contrat que `addStockMovement()` de `lib/stock.ts`, écrit ici pour la
   * même raison que le reste du fichier : une insertion directe, cohérente en
   * une passe. Un stock négatif est refusé, comme dans l'application.
   */
  const stockExit = async (
    productId: number,
    quantity: number,
    motif: string,
    referenceType: 'service_job' | 'brick_production' | 'furniture_order',
    referenceId: number,
  ) => {
    const [current] = await db
      .select({ stock: products.stock })
      .from(products)
      .where(eq(products.id, productId));

    const stockBefore = Number(current?.stock ?? 0);
    const stockAfter = stockBefore - quantity;

    if (stockAfter < -0.0001) {
      throw new SeedDataError(
        `Stock insuffisant pour les données de démonstration : produit #${productId} (disponible ${stockBefore}, demandé ${quantity}).`,
      );
    }

    await db.insert(stockMovements).values({
      productId,
      type: 'exit',
      quantity,
      motif,
      stockBefore,
      stockAfter,
      referenceType,
      referenceId,
      ...syncDefaults,
    });

    await db.update(products).set({ stock: stockAfter }).where(eq(products.id, productId));
  };

  /** Entrée en stock : briques finies mises en stock, meuble livré. */
  const stockEntry = async (
    productId: number,
    quantity: number,
    motif: string,
    referenceType: 'brick_production' | 'furniture_order',
    referenceId: number,
  ) => {
    const [current] = await db
      .select({ stock: products.stock })
      .from(products)
      .where(eq(products.id, productId));

    const stockBefore = Number(current?.stock ?? 0);
    const stockAfter = stockBefore + quantity;

    await db.insert(stockMovements).values({
      productId,
      type: 'entry',
      quantity,
      motif,
      stockBefore,
      stockAfter,
      referenceType,
      referenceId,
      ...syncDefaults,
    });

    await db.update(products).set({ stock: stockAfter }).where(eq(products.id, productId));
  };

  /* ------------------------------ Caisse ------------------------------- */

  // Un encaissement de prestation doit laisser une trace de caisse, comme
  // `createPayment()` (§7). On encaisse donc dans la session ouverte si elle
  // existe — sur une base neuve sans session, le paiement reste enregistré
  // sans mouvement de caisse plutôt que d'inventer une session.
  const openSession = await rawGet<{ id: number; opening_amount: number }>(
    "SELECT id, opening_amount FROM cash_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1",
  );
  const sessionId = openSession ? Number(openSession.id) : null;
  let cashBalance = 0;
  let cashMoved = false;

  if (openSession) {
    const last = await rawGet<{ balance_after: number }>(
      'SELECT balance_after FROM cash_movements WHERE session_id = ? ORDER BY id DESC LIMIT 1',
      [sessionId],
    );
    cashBalance = Number(last?.balance_after ?? openSession.opening_amount ?? 0);
  }

  /* --------------------------- Numérotation ---------------------------- */

  // Mêmes clés que `nextSequence()` : `seq_<type>_<année>` dans `settings`.
  // On lit le compteur persisté (celui du catalogue, le cas échéant) et on le
  // prolonge — jamais de retour en arrière, sinon la première vraie pièce
  // tenterait un numéro déjà pris et la base refuserait l'insertion.
  const sequenceUsage = new Map<string, Map<number, number>>();

  const nextSeedNumber = async (kind: 'job' | 'brick' | 'furniture' | 'receipt', year: number) => {
    let byYear = sequenceUsage.get(kind);
    if (!byYear) {
      byYear = new Map<number, number>();
      sequenceUsage.set(kind, byYear);
    }
    if (!byYear.has(year)) {
      const row = await rawGet<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
        `seq_${kind}_${year}`,
      ]);
      byYear.set(year, Number(row?.value ?? 0) || 0);
    }
    const next = (byYear.get(year) ?? 0) + 1;
    byYear.set(year, next);
    return next;
  };

  /* ============================= 1. Chantiers ========================== */

  const jobRows = Number((await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM service_jobs'))?.n ?? 0);

  if (jobRows === 0) {
    for (const seed of JOBS) {
      const customerId = await findCustomerId(seed.customer);
      if (!customerId) continue;

      // Date métier du chantier ; le devis n'a pas encore de date de début.
      const date = seed.startDaysAgo === null ? todayDate : addDays(todayDate, -seed.startDaysAgo);
      const year = Number(date.slice(0, 4));
      const sequence = await nextSeedNumber('job', year);
      const reference = renderDocumentNumber(
        settings.jobPrefix,
        sequence,
        settings.invoiceNumberFormat,
        year,
      );

      const quoteTotal = roundMoney(seed.quoteMaterials + seed.quoteLabor);

      const inserted = await db
        .insert(serviceJobs)
        .values({
          reference,
          customerId,
          category: seed.category,
          title: seed.title,
          siteAddress: seed.siteAddress,
          description: seed.description,
          startDate: seed.startDaysAgo === null ? null : date,
          endDate: seed.endDaysAgo === null ? null : addDays(todayDate, -seed.endDaysAgo),
          status: seed.status,
          quoteStatus: seed.quoteStatus,
          quoteMaterials: seed.quoteMaterials,
          quoteLabor: seed.quoteLabor,
          quoteTotal,
          total: quoteTotal,
          amountPaid: 0,
          remainingAmount: quoteTotal,
          paymentStatus: 'unpaid',
          ...syncDefaults,
        })
        .returning({ id: serviceJobs.id });

      const jobId = inserted[0].id;
      counts.serviceJobs += 1;

      // Matériaux : la ligne **et** la sortie de stock, jamais l'un sans l'autre.
      let quoteMaterials = 0;
      let materialsAdded = 0;
      for (const [productName, quantity] of seed.materials) {
        const product = await findProduct(productName);
        if (!product) continue;

        const unitCost = product.purchasePrice;
        const amount = roundMoney(quantity * unitCost);

        await db.insert(serviceJobMaterials).values({
          jobId,
          productId: product.id,
          productName: product.name,
          unit: product.unit,
          quantity,
          unitCost,
          amount,
          ...syncDefaults,
        });

        await stockExit(
          product.id,
          quantity,
          `chantier ${reference} : ${product.name}`,
          'service_job',
          jobId,
        );

        quoteMaterials = roundMoney(quoteMaterials + amount);
        materialsAdded += 1;
        counts.serviceJobMaterials += 1;
      }

      // Équipe : `amount = jours × tarif journalier`, comme `addJobWorker()`.
      let quoteLabor = 0;
      let workersAdded = 0;
      for (const [workerName, days] of seed.team) {
        const worker = await findWorker(workerName);
        if (!worker) continue;

        const amount = roundMoney(days * worker.dailyRate);

        await db.insert(serviceJobWorkers).values({
          jobId,
          workerId: worker.id,
          workerName: worker.name,
          role: worker.role,
          days,
          dailyRate: worker.dailyRate,
          amount,
          ...syncDefaults,
        });

        quoteLabor = roundMoney(quoteLabor + amount);
        workersAdded += 1;
        counts.serviceJobWorkers += 1;
      }

      // Dès qu'une ligne existe, le devis est réaligné sur le réalisé (§19).
      const hasLines = materialsAdded + workersAdded > 0;
      const total = hasLines ? roundMoney(quoteMaterials + quoteLabor) : quoteTotal;

      let paid = 0;
      // Un encaissement unique à 40 % est un **acompte**, pas un solde : seule
      // une série dont les parts couvrent le total se termine par un solde
      // exact (c'est là, et là seulement, qu'on rattrape l'arrondi).
      const plannedRatio = seed.payments.reduce((sum, plan) => sum + plan.ratio, 0);

      for (let index = 0; index < seed.payments.length; index += 1) {
        const plan = seed.payments[index];
        const isFinalBalance = index === seed.payments.length - 1 && plannedRatio >= 0.999;
        const amount = isFinalBalance ? roundMoney(total - paid) : roundMoney(total * plan.ratio);
        if (amount <= 0) continue;

        const paymentDate = addDays(todayDate, -plan.daysAgo);
        const paymentYear = Number(paymentDate.slice(0, 4));
        const receiptSequence = await nextSeedNumber('receipt', paymentYear);
        const receiptNumber = renderDocumentNumber(
          settings.receiptPrefix,
          receiptSequence,
          settings.invoiceNumberFormat,
          paymentYear,
        );

        await db.insert(payments).values({
          receiptNumber,
          type: 'service_job',
          referenceId: jobId,
          amount,
          paymentMethod: plan.method,
          paymentLabel: plan.label,
          date: paymentDate,
          notes: 'Encaissement de démonstration',
          ...syncDefaults,
        });

        if (sessionId !== null) {
          cashBalance += amount;
          cashMoved = true;
          await db.insert(cashMovements).values({
            type: 'income',
            amount,
            paymentMethod: plan.method,
            motif: `Encaissement ${reference} — reçu ${receiptNumber}`,
            referenceType: 'payment',
            referenceId: jobId,
            sessionId,
            balanceAfter: cashBalance,
            date: paymentDate,
            ...syncDefaults,
          });
        }

        paid = roundMoney(paid + amount);
      }

      const remaining = roundMoney(Math.max(total - paid, 0));

      await db
        .update(serviceJobs)
        .set({
          quoteMaterials: hasLines ? quoteMaterials : seed.quoteMaterials,
          quoteLabor: hasLines ? quoteLabor : seed.quoteLabor,
          quoteTotal: total,
          total,
          amountPaid: paid,
          remainingAmount: remaining,
          paymentStatus: paid <= 0 ? 'unpaid' : remaining <= 0.001 ? 'paid' : 'partial',
          updatedAt: new Date(),
        })
        .where(eq(serviceJobs.id, jobId));
    }
  }

  /* ============================ 2. Briqueterie ========================= */

  const brickRows = Number(
    (await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM brick_productions'))?.n ?? 0,
  );

  if (brickRows === 0) {
    for (const seed of BRICK_PRODUCTION_SEEDS) {
      const brickType = await findBrickType(seed.brickType);
      if (!brickType) continue;

      const date = addDays(todayDate, -seed.startDaysAgo);
      const year = Number(date.slice(0, 4));
      const sequence = await nextSeedNumber('brick', year);
      const batchNumber = renderDocumentNumber(
        settings.brickPrefix,
        sequence,
        settings.invoiceNumberFormat,
        year,
      );

      const inserted = await db
        .insert(brickProductions)
        .values({
          batchNumber,
          brickTypeId: brickType.id,
          plannedQuantity: seed.plannedQuantity,
          producedQuantity: seed.producedQuantity,
          brokenQuantity: seed.brokenQuantity,
          startDate: date,
          endDate: seed.endDaysAgo === null ? null : addDays(todayDate, -seed.endDaysAgo),
          stage: seed.stage,
          notes: seed.notes,
          ...syncDefaults,
        })
        .returning({ id: brickProductions.id });

      const productionId = inserted[0].id;
      counts.brickProductions += 1;

      // Matières premières : le motif porte `(ligne #id)`, exactement comme
      // `addProductionMaterial()`, pour que le rattrapage d'étape reste
      // idempotent si l'utilisateur avance ensuite le lot.
      let materialCost = 0;
      for (const [productName, quantity] of seed.materials) {
        const product = await findProduct(productName);
        if (!product) continue;

        const unitCost = product.purchasePrice;
        const amount = roundMoney(quantity * unitCost);

        const line = await db
          .insert(brickProductionMaterials)
          .values({
            productionId,
            productId: product.id,
            productName: product.name,
            unit: product.unit,
            quantity,
            unitCost,
            amount,
            ...syncDefaults,
          })
          .returning({ id: brickProductionMaterials.id });

        await stockExit(
          product.id,
          quantity,
          `production ${batchNumber} : ${product.name} (ligne #${line[0].id})`,
          'brick_production',
          productionId,
        );

        materialCost = roundMoney(materialCost + amount);
        counts.brickProductionMaterials += 1;
      }

      let laborCost = 0;
      for (const [workerName, days] of seed.team) {
        const worker = await findWorker(workerName);
        if (!worker) continue;

        const amount = roundMoney(days * worker.dailyRate);

        await db.insert(brickProductionWorkers).values({
          productionId,
          workerId: worker.id,
          workerName: worker.name,
          role: worker.role,
          days,
          dailyRate: worker.dailyRate,
          amount,
          ...syncDefaults,
        });

        laborCost = roundMoney(laborCost + amount);
        counts.brickProductionWorkers += 1;
      }

      // Miroir des colonnes de coût, comme `syncProductionCosts()`.
      await db
        .update(brickProductions)
        .set({
          materialCost,
          laborCost,
          totalCost: roundMoney(materialCost + laborCost),
          updatedAt: new Date(),
        })
        .where(eq(brickProductions.id, productionId));

      /*
       * Étape « En stock » : les briques finies entrent en stock **une seule
       * fois** (`entry`), et les briques cassées en ressortent dans la foulée
       * (`exit` motivé, §17) — le stock net vaut donc exactement
       * `produit − cassé`. Avant cette étape, il n'y a rien à sortir : une
       * casse sur un lot en cuisson reste une quantité, pas un mouvement.
       */
      if (seed.stage === 'stored') {
        await stockEntry(
          brickType.productId,
          seed.producedQuantity,
          `production ${batchNumber} : mise en stock`,
          'brick_production',
          productionId,
        );

        if (seed.brokenQuantity > 0) {
          await stockExit(
            brickType.productId,
            seed.brokenQuantity,
            `briques cassées lot ${batchNumber}`,
            'brick_production',
            productionId,
          );
        }
      }
    }
  }

  /* ============================== 3. Atelier =========================== */

  const orderRows = Number(
    (await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM furniture_orders'))?.n ?? 0,
  );

  if (orderRows === 0) {
    for (const seed of FURNITURE_ORDER_SEEDS) {
      const model = await findModel(seed.modelCode);
      if (!model) continue;

      const customerId = await findCustomerId(seed.customer);
      const finishedProduct = await findProduct(seed.productName);

      const date = addDays(todayDate, -seed.startDaysAgo);
      const year = Number(date.slice(0, 4));
      const sequence = await nextSeedNumber('furniture', year);
      const orderNumber = renderDocumentNumber(
        settings.furniturePrefix,
        sequence,
        settings.invoiceNumberFormat,
        year,
      );

      const inserted = await db
        .insert(furnitureOrders)
        .values({
          orderNumber,
          customerId,
          customerName: seed.customer,
          modelId: model.id,
          modelName: model.name,
          isCustom: false,
          dimensions: seed.dimensions,
          finish: seed.finish,
          quantity: seed.quantity,
          startDate: date,
          promisedDate: addDays(todayDate, seed.promisedInDays),
          deliveryDate: seed.deliveryDaysAgo === null ? null : addDays(todayDate, -seed.deliveryDaysAgo),
          stage: seed.stage,
          agreedPrice: seed.agreedPrice,
          amountPaid: seed.amountPaid,
          productId: finishedProduct?.id ?? null,
          notes: seed.notes,
          ...syncDefaults,
        })
        .returning({ id: furnitureOrders.id });

      const orderId = inserted[0].id;
      counts.furnitureOrders += 1;

      // Chutes déclarées par produit : elles produisent un mouvement `exit`
      // **distinct** de la consommation (§21), donc lisible dans le journal.
      const wastageByProduct = new Map<number, number>();
      for (const [productName, quantity] of seed.wastage) {
        const product = await findProduct(productName);
        if (product) wastageByProduct.set(product.id, quantity);
      }

      // Matières = nomenclature du modèle × la quantité commandée : le besoin
      // est **calculé**, jamais ressaisi (§21).
      let materialCost = 0;
      for (const line of await listModelBom(model.id)) {
        const productId = Number(line.product_id);
        const quantity = roundMoney(Number(line.quantity) * seed.quantity);
        const wastage = wastageByProduct.get(productId) ?? 0;
        const unitCost = roundMoney(Number(line.purchase_price ?? 0));
        const amount = roundMoney(quantity * unitCost);

        await db.insert(furnitureOrderMaterials).values({
          orderId,
          productId,
          productName: line.product_name,
          unit: line.unit,
          quantity,
          wastageQuantity: wastage,
          unitCost,
          amount,
          ...syncDefaults,
        });

        await stockExit(
          productId,
          quantity,
          `matières atelier — commande ${orderNumber} (${line.product_name})`,
          'furniture_order',
          orderId,
        );

        if (wastage > 0) {
          await stockExit(
            productId,
            wastage,
            `chutes de bois — commande ${orderNumber} (${line.product_name})`,
            'furniture_order',
            orderId,
          );
        }

        materialCost = roundMoney(materialCost + amount);
        counts.furnitureOrderMaterials += 1;
      }

      let laborCost = 0;
      for (const [workerName, days] of seed.team) {
        const worker = await findWorker(workerName);
        if (!worker) continue;

        const amount = roundMoney(days * worker.dailyRate);

        await db.insert(furnitureOrderWorkers).values({
          orderId,
          workerId: worker.id,
          workerName: worker.name,
          role: worker.role,
          days,
          dailyRate: worker.dailyRate,
          amount,
          ...syncDefaults,
        });

        laborCost = roundMoney(laborCost + amount);
        counts.furnitureOrderWorkers += 1;
      }

      await db
        .update(furnitureOrders)
        .set({
          materialCost,
          laborCost,
          totalCost: roundMoney(materialCost + laborCost),
          updatedAt: new Date(),
        })
        .where(eq(furnitureOrders.id, orderId));

      // Le meuble fini entre en stock **à la livraison**, une seule fois (§21).
      if (seed.stage === 'delivered' && finishedProduct) {
        await stockEntry(
          finishedProduct.id,
          seed.quantity,
          `livraison meuble — commande ${orderNumber}`,
          'furniture_order',
          orderId,
        );
      }
    }
  }

  /* ------------------- Compteurs et caisse persistés ------------------- */

  // Sans cette remise à niveau, `nextDocumentNumber('job')` repartirait de 1 :
  // la première vraie pièce tenterait un numéro déjà pris (`reference` est
  // unique) et la base refuserait l'insertion — bug déjà constaté sur les
  // factures (voir le commentaire de `sequenceUsage` dans `seedDemoData`).
  for (const [kind, byYear] of sequenceUsage) {
    for (const [year, value] of byYear) {
      await rawRun(
        `INSERT INTO settings (key, value, updated_at, sync_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [`seq_${kind}_${year}`, String(value), Date.now(), crypto.randomUUID()],
      );
    }
  }

  // La session ouverte doit refléter les encaissements qui viennent d'y entrer.
  if (cashMoved && sessionId !== null) {
    await db
      .update(cashSessions)
      .set({ theoreticalAmount: cashBalance })
      .where(eq(cashSessions.id, sessionId));
  }

  return counts;
}

/** Vide un catalogue de démonstration (utilisé par les tests). */
export async function countDemoRows(): Promise<Record<string, number>> {
  const row = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM categories)   AS categories,
       (SELECT COUNT(*) FROM products)     AS products,
       (SELECT COUNT(*) FROM customers)    AS customers,
       (SELECT COUNT(*) FROM suppliers)    AS suppliers,
       (SELECT COUNT(*) FROM workers)      AS workers,
       (SELECT COUNT(*) FROM sales_invoices) AS sales`,
  );
  return Object.fromEntries(
    Object.entries(row ?? {}).map(([k, v]) => [k, Number(v ?? 0)]),
  );
}
