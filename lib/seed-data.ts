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

import { db, rawGet, rawRun } from '@/db';
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
import { today, addDays } from '@/lib/format';
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
      skipped: true,
      message:
        'Des produits existent déjà : le préremplissage est ignoré pour ne rien dupliquer. Réinitialisez d’abord si vous voulez repartir du catalogue de démonstration.',
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
  // Une session de caisse ouverte, pour que l'écran Caisse soit exploitable.
  const session = await db
    .insert(cashSessions)
    .values({
      status: 'open',
      openingAmount: 2_000_000,
      notes: 'Session de démonstration',
      ...syncDefaults,
    })
    .returning({ id: cashSessions.id });

  const sessionId = session[0].id;
  let cashBalance = 2_000_000;

  await db.insert(cashMovements).values({
    type: 'income',
    amount: 2_000_000,
    paymentMethod: 'Espèces',
    motif: "Montant d'ouverture de caisse",
    referenceType: 'manual',
    sessionId,
    balanceAfter: cashBalance,
    date: addDays(todayDate, -20),
    ...syncDefaults,
  });

  // Achats fournisseurs (entrées de stock).
  const purchases: { supplierIndex: number; daysAgo: number; lines: [string, number][]; paidRatio: number }[] = [
    { supplierIndex: 0, daysAgo: 24, lines: [['Planche bois rouge 2,5 m', 40], ['Chevron 7 x 7 cm — 3 m', 60], ['Contreplaqué 15 mm — 2,44 x 1,22 m', 12]], paidRatio: 1 },
    { supplierIndex: 2, daysAgo: 18, lines: [['Ciment CEM II 50 kg', 40]], paidRatio: 1 },
    { supplierIndex: 3, daysAgo: 12, lines: [['Panneau Alucobond 4 mm rouge', 60], ['Panneau Alucobond 4 mm argent', 40]], paidRatio: 0.5 },
    { supplierIndex: 1, daysAgo: 7, lines: [['Charnière invisible', 200], ['Poignée aluminium brossé', 80]], paidRatio: 0 },
  ];

  /**
   * Compteurs de numérotation à remettre à niveau APRÈS le préremplissage.
   *
   * ⚠️ **Indispensable.** Les documents de démonstration reçoivent des numéros
   * (`FAC-2026-000001`, `ACH-2026-000001`, `REC-…`), mais `nextSequence()`
   * ignore leur existence : il repart de 1. Sans cette remise à niveau, la
   * **première vraie vente** tenterait `FAC-2026-000001` à nouveau et la base
   * refuserait l'insertion, puisque le numéro de facture est **unique**.
   *
   * Le bug a été constaté en vérification : « Failed query: insert into
   * sales_invoices … ». On enregistre donc le plus grand numéro utilisé, par
   * type de document et par année.
   */
  const sequenceUsage = {
    invoice: new Map<number, number>(),
    purchase: new Map<number, number>(),
    receipt: new Map<number, number>(),
  };

  const recordSequence = (
    kind: 'invoice' | 'purchase' | 'receipt',
    year: number,
    value: number,
  ) => {
    const map = sequenceUsage[kind];
    map.set(year, Math.max(map.get(year) ?? 0, value));
  };

  let purchaseSequence = 0;
  for (const purchase of purchases) {
    purchaseSequence += 1;
    const date = addDays(todayDate, -purchase.daysAgo);
    const purchaseYear = Number(date.slice(0, 4));
    recordSequence('purchase', purchaseYear, purchaseSequence);

    const lines = purchase.lines.map(([name, quantity]) => {
      const seed = PRODUCTS.find((p) => p.name === name)!;
      return { name, quantity, unitPrice: seed.purchasePrice, amount: seed.purchasePrice * quantity };
    });

    const total = lines.reduce((sum, l) => sum + l.amount, 0);
    const amountPaid = Math.round(total * purchase.paidRatio);
    const remaining = total - amountPaid;

    const invoice = await db
      .insert(purchaseInvoices)
      .values({
        reference: renderDocumentNumber(settings.purchasePrefix, purchaseSequence, settings.invoiceNumberFormat, purchaseYear),
        supplierId: supplierIds[purchase.supplierIndex],
        date,
        dueDate: addDays(date, 30),
        total,
        amountPaid,
        remainingAmount: remaining,
        paymentStatus: amountPaid <= 0 ? 'unpaid' : remaining <= 0 ? 'paid' : 'partial',
        paymentMethod: amountPaid > 0 ? 'Espèces' : 'Crédit',
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
        motif: `Achat fournisseur — démonstration`,
        stockBefore,
        stockAfter,
        referenceType: 'purchase',
        referenceId: invoice[0].id,
        ...syncDefaults,
      });

      await db.update(products).set({ stock: stockAfter }).where(eq(products.id, productId));
    }

    if (amountPaid > 0) {
      await db.insert(payments).values({
        receiptNumber: renderDocumentNumber(settings.receiptPrefix, purchaseSequence, settings.invoiceNumberFormat, purchaseYear),
        type: 'purchase',
        referenceId: invoice[0].id,
        amount: amountPaid,
        paymentMethod: 'Espèces',
        paymentLabel: remaining <= 0 ? 'full' : 'deposit',
        date,
        notes: 'Règlement de démonstration',
        ...syncDefaults,
      });

      cashBalance -= amountPaid;
      await db.insert(cashMovements).values({
        type: 'expense',
        amount: amountPaid,
        paymentMethod: 'Espèces',
        motif: `Règlement achat (démonstration)`,
        referenceType: 'purchase',
        referenceId: invoice[0].id,
        sessionId,
        balanceAfter: cashBalance,
        date,
        ...syncDefaults,
      });
    }

    purchaseCount += 1;
  }

  // Ventes clients.
  const sales: {
    customerIndex: number | null;
    daysAgo: number;
    lines: [string, number][];
    paidRatio: number;
    method: string;
  }[] = [
    { customerIndex: 0, daysAgo: 21, lines: [['Ensemble salon complet', 1], ['Chaise bois massif', 6]], paidRatio: 1, method: 'Virement' },
    { customerIndex: 2, daysAgo: 17, lines: [['Lit 2 places avec tête de lit', 1]], paidRatio: 0.5, method: 'Mobile Money' },
    { customerIndex: 3, daysAgo: 14, lines: [['Panneau Alucobond 4 mm rouge', 24.5], ['Plaque BA13 1,20 x 2,60 m', 40], ['Peinture acrylique blanche 20 L', 60]], paidRatio: 0.3, method: 'Espèces' },
    { customerIndex: 1, daysAgo: 10, lines: [['Armoire 2 portes standard', 4], ['Table à manger 6 places', 2]], paidRatio: 1, method: 'Virement' },
    { customerIndex: 4, daysAgo: 6, lines: [['Buffet bas 4 portes', 1]], paidRatio: 1, method: 'Espèces' },
    { customerIndex: null, daysAgo: 5, lines: [['Brique pleine 15 trous', 500], ['Brique creuse 12 trous', 300]], paidRatio: 1, method: 'Espèces' },
    { customerIndex: 5, daysAgo: 3, lines: [['Plaque BA13 1,20 x 2,60 m', 30], ['Rail R48', 40], ['Vernis bois brillant 5 L', 8]], paidRatio: 0.6, method: 'Mobile Money' },
    { customerIndex: 0, daysAgo: 2, lines: [['Chaise bois massif', 12], ['Bureau de direction', 1]], paidRatio: 0.25, method: 'Espèces' },
    { customerIndex: null, daysAgo: 1, lines: [['Peinture acrylique blanche 20 L', 20], ['Clous 50 mm (1 kg)', 5.5]], paidRatio: 1, method: 'Espèces' },
    { customerIndex: 3, daysAgo: 0, lines: [['Bloc béton 20x20x40', 150], ['Ciment CEM II 50 kg', 10]], paidRatio: 1, method: 'Mobile Money' },
  ];

  const taxRate = settings.defaultTaxRate;
  let saleSequence = 0;
  let receiptSequence = 100;

  for (const sale of sales) {
    saleSequence += 1;
    const date = addDays(todayDate, -sale.daysAgo);
    const year = Number(date.slice(0, 4));
    recordSequence('invoice', year, saleSequence);

    const lines = sale.lines.map(([name, quantity]) => {
      const seed = PRODUCTS.find((p) => p.name === name)!;
      return {
        name,
        seed,
        quantity,
        unitPrice: seed.salePrice,
        amount: seed.salePrice * quantity,
      };
    });

    const subTotal = lines.reduce((sum, l) => sum + l.amount, 0);
    const discount = 0;
    const totalHt = subTotal - discount;
    const taxAmount = Math.round((totalHt * taxRate) / 100);
    const total = totalHt + taxAmount;
    const amountPaid = Math.round(total * sale.paidRatio);
    const remaining = total - amountPaid;

    const customerName =
      sale.customerIndex === null ? 'Client comptoir' : CUSTOMERS[sale.customerIndex].name;

    const invoice = await db
      .insert(salesInvoices)
      .values({
        invoiceNumber: renderDocumentNumber(settings.invoicePrefix, saleSequence, settings.invoiceNumberFormat, year),
        customerId: sale.customerIndex === null ? null : customerIds[sale.customerIndex],
        customerName,
        date,
        dueDate: remaining > 0 ? addDays(date, 30) : null,
        subTotal,
        discount,
        totalHt,
        taxRate,
        taxAmount,
        total,
        amountPaid,
        remainingAmount: remaining,
        paymentStatus: amountPaid <= 0 ? 'unpaid' : remaining <= 0 ? 'paid' : 'partial',
        paymentMethod: sale.method,
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
      recordSequence('receipt', year, receiptSequence);
      await db.insert(payments).values({
        receiptNumber: renderDocumentNumber(settings.receiptPrefix, receiptSequence, settings.invoiceNumberFormat, year),
        type: 'sale',
        referenceId: invoice[0].id,
        amount: amountPaid,
        paymentMethod: sale.method,
        paymentLabel: remaining <= 0 ? 'full' : 'deposit',
        date,
        notes: 'Encaissement de démonstration',
        ...syncDefaults,
      });

      cashBalance += amountPaid;
      await db.insert(cashMovements).values({
        type: 'income',
        amount: amountPaid,
        paymentMethod: sale.method,
        motif: `Encaissement vente (démonstration)`,
        referenceType: 'sale',
        referenceId: invoice[0].id,
        sessionId,
        balanceAfter: cashBalance,
        date,
        ...syncDefaults,
      });
    }

    salesCount += 1;
  }

  // Dépenses de fonctionnement.
  const expenseSeeds: { category: string; amount: number; description: string; daysAgo: number; method: string }[] = [
    { category: 'Loyer', amount: 3_500_000, description: 'Loyer du magasin — mois en cours', daysAgo: 20, method: 'Espèces' },
    { category: 'Carburant', amount: 850_000, description: 'Carburant camion de livraison', daysAgo: 15, method: 'Espèces' },
    { category: 'Électricité', amount: 1_250_000, description: 'Facture EDG', daysAgo: 12, method: 'Mobile Money' },
    { category: 'Transport', amount: 620_000, description: 'Transport de marchandises Dubréka → Conakry', daysAgo: 8, method: 'Espèces' },
    { category: 'Salaire', amount: 4_800_000, description: 'Salaires des journaliers', daysAgo: 5, method: 'Espèces' },
    { category: 'Autre', amount: 320_000, description: 'Fournitures de bureau', daysAgo: 2, method: 'Espèces' },
  ];

  for (const expense of expenseSeeds) {
    const date = addDays(todayDate, -expense.daysAgo);

    const inserted = await db
      .insert(expenses)
      .values({
        category: expense.category,
        amount: expense.amount,
        description: expense.description,
        paymentMethod: expense.method,
        date,
        ...syncDefaults,
      })
      .returning({ id: expenses.id });

    cashBalance -= expense.amount;
    await db.insert(cashMovements).values({
      type: 'expense',
      amount: expense.amount,
      paymentMethod: expense.method,
      motif: `Dépense — ${expense.category}`,
      referenceType: 'expense',
      referenceId: inserted[0].id,
      sessionId,
      balanceAfter: cashBalance,
      date,
      ...syncDefaults,
    });

    expenseCount += 1;
  }

  // La session doit refléter le solde réel après toutes ces opérations.
  await db
    .update(cashSessions)
    .set({ theoreticalAmount: cashBalance })
    .where(eq(cashSessions.id, sessionId));

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
    skipped: false,
    message: `Catalogue de démonstration créé : ${productCount} produits, ${customerCount} clients, ${supplierCount} fournisseurs, ${salesCount} ventes, ${purchaseCount} achats, ${expenseCount} dépenses.`,
  };
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
