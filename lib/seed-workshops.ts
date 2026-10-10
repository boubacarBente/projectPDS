/**
 * Démonstration des **filiales de production** (README §30, §31) — la
 * briqueterie reprise et une **vitrerie** créée par l'administrateur — et de
 * l'**atelier de meubles** (README §29) pour chaque magasin du réseau.
 *
 * Appelé par `seedDemoData()` (`lib/seed-data.ts`) une fois le commerce créé :
 * comme le reste de la démonstration, tout passe par les fonctions métier
 * (lots, dépenses de production, ventes du canal `brick`, commandes, matières,
 * paiements). Les dates s'étalent sur 13 mois pour que les filtres de période
 * aient de quoi montrer, et chaque statut filtrable a au moins un document.
 *
 * Les magasins n'ont pas le même volume (coefficient `scale`) ni le même
 * calendrier (décalage de quelques jours) : les vues consolidées et les
 * comparaisons entre magasins ne montrent pas quatre copies identiques.
 */

import { rawGet } from '@/db';
import { createCategory, createProduct } from '@/lib/products';
import { createPurchaseInvoice } from '@/lib/purchases';
import { createSalesInvoice } from '@/lib/sales';
import { createPayment } from '@/lib/payments';
import { createWorker } from '@/lib/workers';
import { getStoreStock } from '@/lib/stock';
import { addDays, today } from '@/lib/format';
import {
  addProductionExpense,
  addProductionWorker,
  advanceStage,
  cancelBrickProduction,
  createBrickProduction,
  createBrickType,
} from '@/lib/brick';
import { createBranch, getDefaultBrickBranch, getFurnitureBranch, type ProductionBranch } from '@/lib/branches';
import { BRANCH_EXPENSE_REFERENCE } from '@/lib/branches-shared';
import { createExpense } from '@/lib/expenses';
import { importFurnitureModels, addProductionMaterial, consumePlannedMaterials as consumePlannedProductionMaterials } from '@/lib/production-materials';
import { openInventory, recordCounts, validateInventory, getInventory } from '@/lib/inventories';
import type { SessionUser } from '@/lib/api';
import {
  cancelBrickOrder,
  createBrickOrder,
  invoiceBrickOrder,
  registerBrickOrderDelivery,
  updateBrickOrderStatus,
} from '@/lib/brick-orders';
import {
  addOrderMaterial,
  addOrderWorker,
  advanceFurnitureStage,
  cancelFurnitureOrder,
  consumePlannedMaterials,
  createFurnitureModel,
  createFurnitureOrder,
  setModelMaterials,
} from '@/lib/furniture';
import { nextFurnitureStage, type FurnitureStage } from '@/lib/furniture-shared';

type StoreRef = { id: number; name: string; code: string };
type UserRef = { id: number; name: string };

export type WorkshopSeedContext = {
  stores: { store: StoreRef; manager: UserRef; seller: UserRef; scale: number; offset: number }[];
  admin: UserRef;
  customersByStore: Record<number, number[]>;
  suppliersByStore: Record<number, number[]>;
  /** Produits du catalogue commun, par nom (`lib/seed-data.ts`). */
  productIds: Map<string, number>;
  random: () => number;
};

export type WorkshopSeedReport = {
  branches: number;
  brickTypes: number;
  brickProductions: number;
  brickSales: number;
  brickOrders: number;
  furnitureModels: number;
  furnitureOrders: number;
  /** Productions de la filiale Meuble (README §31.9). */
  meubleProductions?: number;
};

/* ------------------------------------------------------------------ *
 * Référentiels
 * ------------------------------------------------------------------ */

const BRICKS = [
  { product: 'Brique pleine 15 cm', type: 'Brique pleine 15', shape: 'solid' as const, dimensions: '40 x 20 x 15 cm', price: 4_500 },
  { product: 'Brique creuse 12 cm', type: 'Brique creuse 12', shape: 'hollow' as const, dimensions: '40 x 20 x 12 cm', price: 3_800 },
  { product: 'Parpaing 20 cm', type: 'Parpaing 20', shape: 'block' as const, dimensions: '50 x 20 x 20 cm', price: 6_000 },
];

/** Vitrerie de démonstration : une deuxième filiale, aux étapes et à l'unité différentes. */
const GLASSES = [
  { product: 'Vitre claire 6 mm (m²)', model: 'Vitre claire 6 mm', category: 'Vitre', thickness: 0.6, price: 180_000, unit: 'm²' },
  { product: 'Miroir 80 x 120 cm', model: 'Miroir 80 x 120', category: 'Miroir', thickness: 0.4, price: 450_000, unit: 'pièce' },
  { product: 'Vitre teintée 8 mm (m²)', model: 'Vitre teintée 8 mm', category: 'Vitre', thickness: 0.8, price: 240_000, unit: 'm²' },
];

/** Matières de l'atelier : achetées pour lui, en plus du réassort du commerce. */
const WORKSHOP_SUPPLY: [string, number][] = [
  ['Planche bois rouge 2,5 m', 90],
  ['Contreplaqué 15 mm — 2,44 x 1,22 m', 30],
  ['Chevron 7 x 7 cm — 3 m', 30],
  ['Charnière invisible', 160],
  ['Poignée aluminium brossé', 80],
  ['Vis à bois 5 x 60 mm (boîte de 200)', 20],
  ['Colle à bois 1 kg', 20],
  ['Vernis bois brillant 5 L', 40],
];

const MODELS: { name: string; dimensions: string; hours: number; price: number; materials: [string, number][] }[] = [
  {
    name: 'Armoire 3 portes',
    dimensions: '180 x 60 x 220 cm',
    hours: 40,
    price: 3_200_000,
    materials: [
      ['Planche bois rouge 2,5 m', 8],
      ['Contreplaqué 15 mm — 2,44 x 1,22 m', 3],
      ['Charnière invisible', 6],
      ['Poignée aluminium brossé', 3],
      ['Vis à bois 5 x 60 mm (boîte de 200)', 1],
      ['Vernis bois brillant 5 L', 4],
    ],
  },
  {
    name: 'Table basse plateau massif',
    dimensions: '110 x 60 x 45 cm',
    hours: 14,
    price: 950_000,
    materials: [
      ['Planche bois rouge 2,5 m', 3],
      ['Chevron 7 x 7 cm — 3 m', 1],
      ['Colle à bois 1 kg', 1],
      ['Vernis bois brillant 5 L', 1],
    ],
  },
  {
    name: 'Chaise bois massif',
    dimensions: '45 x 50 x 95 cm',
    hours: 6,
    price: 320_000,
    materials: [
      ['Planche bois rouge 2,5 m', 1],
      ['Chevron 7 x 7 cm — 3 m', 1],
      ['Colle à bois 1 kg', 1],
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Seed
 * ------------------------------------------------------------------ */

export async function seedWorkshops(ctx: WorkshopSeedContext): Promise<WorkshopSeedReport> {
  const report: WorkshopSeedReport = {
    branches: 0,
    brickTypes: 0,
    brickProductions: 0,
    brickSales: 0,
    brickOrders: 0,
    furnitureModels: 0,
    furnitureOrders: 0,
  };
  const { random, productIds } = ctx;
  const d = (days: number) => addDays(today(), days);
  const between = (min: number, max: number) => min + Math.round(random() * (max - min));
  const product = (name: string) => {
    const id = productIds.get(name);
    if (!id) throw new Error(`Produit de démonstration introuvable : ${name}`);
    return id;
  };

  /*
   * Filiales : la Briqueterie vient de la migration 0015 (reprise de la v2) ;
   * la Vitrerie est créée comme le ferait l'administrateur depuis /filiales.
   */
  const actor = { ...ctx.admin, role: 'admin', permissions: [], storeIds: [], storeId: null } as unknown as SessionUser;
  const brickBranch: ProductionBranch =
    (await getDefaultBrickBranch()) ??
    (await createBranch(
      { name: 'Briqueterie', activity: 'bricks', stages: ['Moulage', 'Séchage', 'Cuisson'], lossLabel: 'Cassées', batchPrefix: 'BRI', orderPrefix: 'BCM', color: 'warning' },
      actor,
    ));
  const glassBranch = await createBranch(
    {
      name: 'Vitrerie',
      activity: 'glass',
      description: 'Découpe et pose de vitres et miroirs.',
      unit: 'm²',
      stages: ['Découpe', 'Façonnage', 'Contrôle'],
      lossLabel: 'Casse',
      batchPrefix: 'VIT',
      orderPrefix: 'VCM',
      color: 'info',
      customerMode: 'all',
    },
    actor,
  );
  report.branches += 1;
  // Filiale « Meuble » : créée par la migration 0016 ; recréée après une réinitialisation.
  const meubleBranch: ProductionBranch =
    (await getFurnitureBranch()) ??
    (await createBranch(
      {
        name: 'Meuble',
        activity: 'furniture',
        description: 'Fabrication et vente de meubles (reprise de l’atelier de meubles).',
        stages: ['Découpe', 'Assemblage', 'Ponçage', 'Peinture / vernis', 'Finition'],
        lossLabel: 'Rebuts',
        batchPrefix: 'MBL',
        orderPrefix: 'MCM',
        color: 'secondary',
        icon: 'furniture',
      },
      actor,
    ));
  const glassCategory = await createCategory({ name: 'Vitrerie', kind: 'finished', description: 'Vitres et miroirs de la vitrerie' });
  const glassProducts = new Map<string, number>();
  for (const glass of GLASSES) {
    const created = await createProduct({
      name: glass.product,
      categoryId: glassCategory.id,
      unit: glass.unit,
      purchasePrice: 0,
      salePrice: glass.price,
      stockMin: 20,
    });
    glassProducts.set(glass.product, created.id);
  }

  // Les briques sont des produits du catalogue commun : chaque magasin en porte
  // son propre type (un type = un produit dans un magasin, il en porte le stock).
  const brickCategory = await createCategory({ name: 'Briques', kind: 'finished', description: 'Briques et parpaings de la briqueterie' });
  const brickProducts = new Map<string, number>();
  for (const brick of BRICKS) {
    const created = await createProduct({
      name: brick.product,
      categoryId: brickCategory.id,
      unit: 'pièce',
      purchasePrice: 0,
      salePrice: brick.price,
      stockMin: 2_000,
    });
    brickProducts.set(brick.product, created.id);
  }

  for (const { store, manager, seller, scale, offset } of ctx.stores) {
    const customers = ctx.customersByStore[store.id] ?? [];
    const customer = (i: number) => customers[i % Math.max(1, customers.length)] ?? null;

    /* ----------------------------- Équipes ----------------------------- */
    // Noms propres à chaque magasin : `lib/seed-jobs.ts` retrouve ses ouvriers par leur nom.
    const briquetier = await createWorker({
      name: `Chef briquetier ${store.code}`,
      role: 'foreman',
      dailyRate: 110_000,
      specialty: 'Moulage et cuisson des briques',
      storeId: store.id,
      team: 'Équipe briqueterie',
    });
    const mouleur = await createWorker({
      name: `Mouleur ${store.code}`,
      role: 'worker',
      dailyRate: 65_000,
      specialty: 'Moulage',
      storeId: store.id,
      team: 'Équipe briqueterie',
    });
    const menuisier = await createWorker({
      name: `Menuisier ${store.code}`,
      role: 'foreman',
      dailyRate: 120_000,
      specialty: 'Menuiserie et assemblage',
      storeId: store.id,
      team: 'Atelier',
    });
    const finisseur = await createWorker({
      name: `Finisseur ${store.code}`,
      role: 'worker',
      dailyRate: 75_000,
      specialty: 'Ponçage et vernis',
      storeId: store.id,
      team: 'Atelier',
    });

    /* --------------------------- Briqueterie --------------------------- */
    const types: { id: number; productId: number; price: number }[] = [];
    for (const brick of BRICKS) {
      const created = await createBrickType({
        storeId: store.id,
        branchId: brickBranch.id,
        category: brick.shape === 'hollow' ? 'Creuse' : brick.shape === 'block' ? 'Parpaing' : 'Pleine',
        productId: brickProducts.get(brick.product)!,
        name: brick.type,
        shape: brick.shape,
        dimensions: brick.dimensions,
        userId: manager.id,
      });
      types.push({ id: created.id, productId: created.productId, price: brick.price });
      report.brickTypes += 1;
    }

    /*
     * Lots du plus ancien au plus récent : les anciens sont **en stock**
     * (terminés), les derniers à chaque étape de fabrication, un est annulé.
     * Après chaque lot terminé, quelques ventes de briques à des dates qui
     * suivent sa sortie de four.
     */
    const lotAges = [385, 340, 300, 255, 210, 170, 130, 95, 65, 40, 22, 12, 5];
    for (const [index, rawAge] of lotAges.entries()) {
      const age = rawAge + offset;
      const type = types[index % types.length];
      const startDate = d(-age);
      const planned = Math.round(between(6_000, 12_000) * scale);
      const stage = age >= 35 ? 'stored' : age >= 20 ? 'firing' : age >= 10 ? 'drying' : 'molding';
      const produced = stage === 'stored' ? Math.round(planned * (0.92 + random() * 0.06)) : 0;
      const broken = stage === 'stored' ? Math.round(produced * (0.01 + random() * 0.04)) : 0;
      const endDate = stage === 'stored' ? addDays(startDate, 18 + between(0, 6)) : null;

      const lot = await createBrickProduction({
        storeId: store.id,
        branch: brickBranch,
        brickTypeId: type.id,
        plannedQuantity: planned,
        producedQuantity: produced,
        brokenQuantity: broken,
        startDate,
        endDate,
        team: 'Équipe briqueterie',
        userId: manager.id,
      });
      report.brickProductions += 1;

      await addProductionWorker(lot.id, { workerId: briquetier.id, days: between(8, 14) }, store.id, brickBranch.id);
      await addProductionWorker(lot.id, { workerId: mouleur.id, days: between(10, 18) }, store.id, brickBranch.id);
      if (index % 3 === 0) {
        await addProductionWorker(
          lot.id,
          { workerName: 'Journalier', role: 'Manœuvre', days: between(4, 8), dailyRate: 45_000 },
          store.id,
          brickBranch.id,
        );
      }
      const expenses: [string, number][] = [
        ['Ciment', between(900_000, 1_800_000)],
        ['Sable', between(400_000, 900_000)],
        ['Bois de chauffe', between(300_000, 700_000)],
      ];
      if (index % 2 === 0) expenses.push(['Transport', between(150_000, 400_000)]);
      for (const [category, amount] of expenses) {
        await addProductionExpense(
          lot.id,
          {
            category,
            amount: Math.round(amount * scale),
            date: startDate,
            description: `${category} — lot ${lot.batchNumber}`,
            paymentMethod: 'Espèces',
            userId: manager.id,
            canSkipApproval: true,
          },
          store.id,
          brickBranch.id,
        );
      }

      if (stage !== 'molding') {
        for (const step of ['drying', 'firing', 'stored']) {
          await advanceStage(lot.id, step, store.id, manager.id, brickBranch);
          if (step === stage) break;
        }
      }

      // Ventes au comptoir de la briqueterie, après la sortie du lot.
      if (stage === 'stored' && endDate) {
        const salesCount = between(2, 4);
        for (let s = 0; s < salesCount; s += 1) {
          const date = addDays(endDate, between(1, 30));
          if (date > today()) break;
          const available = await getStoreStock(store.id, type.productId);
          const quantity = Math.min(available, Math.round(between(400, 2_500) * scale));
          if (quantity <= 0) break;
          const total = quantity * type.price;
          const mode = random();
          const customerId = mode < 0.4 ? null : customer(s + index);
          await createSalesInvoice({
            storeId: store.id,
            channel: 'brick',
            productionBranchId: brickBranch.id,
            customerId,
            customerName: customerId ? undefined : 'Client briqueterie',
            date,
            dueDate: customerId && mode > 0.8 ? addDays(date, 30) : null,
            paymentMethod: mode < 0.7 ? 'Espèces' : 'Mobile Money',
            // Un client connu peut repartir avec un reste à payer (dû en rouge).
            amountPaid: customerId && mode > 0.8 ? Math.round(total * 0.5) : total,
            discount: 0,
            lines: [{ productId: type.productId, quantity, unitPrice: type.price }],
            userId: seller.id,
          });
          report.brickSales += 1;
        }
      }
    }

    // Lot annulé (ordre de fabrication saisi en double).
    const cancelledLot = await createBrickProduction({
      storeId: store.id,
      branch: brickBranch,
      brickTypeId: types[1].id,
      plannedQuantity: Math.round(5_000 * scale),
      startDate: d(-(15 + offset)),
      team: 'Équipe briqueterie',
      userId: manager.id,
    });
    await cancelBrickProduction(cancelledLot.id, 'Ordre de fabrication saisi en double', { id: manager.id, storeId: store.id }, brickBranch.id);
    report.brickProductions += 1;

    /* Commandes de briques : une par statut, à des dates différentes. */
    const order = async (age: number, typeIndex: number, quantity: number, customerIndex: number, confirmed: boolean) => {
      const type = types[typeIndex];
      const date = d(-(age + offset));
      const created = await createBrickOrder({
        storeId: store.id,
        branch: brickBranch,
        customerId: customer(customerIndex),
        date,
        promisedDate: addDays(date, 21),
        status: confirmed ? 'confirmed' : 'draft',
        items: [{ brickTypeId: type.id, quantity: Math.round(quantity * scale), unitPrice: type.price }],
        notes: 'Commande de démonstration',
        userId: manager.id,
      });
      report.brickOrders += 1;
      return { ...created, date };
    };
    const deposit = async (orderId: number, total: number, share: number, date: string) => {
      await createPayment({
        storeId: store.id,
        type: 'brick_order',
        referenceId: orderId,
        amount: Math.round(total * share),
        paymentMethod: 'Espèces',
        date,
        userId: seller.id,
      });
    };

    await order(3, 0, 3_000, 0, false); // brouillon
    const confirmed = await order(14, 1, 4_000, 1, true);
    await deposit(confirmed.order.id, confirmed.order.total, 0.3, addDays(confirmed.date, 1));
    const inProduction = await order(28, 2, 2_500, 2, true);
    await deposit(inProduction.order.id, inProduction.order.total, 0.5, addDays(inProduction.date, 2));
    const B = brickBranch.id;
    await updateBrickOrderStatus(inProduction.order.id, 'in_production', store.id, B);
    const ready = await order(45, 0, 2_000, 3, true);
    await updateBrickOrderStatus(ready.order.id, 'in_production', store.id, B);
    await updateBrickOrderStatus(ready.order.id, 'ready', store.id, B);
    const partial = await order(70, 1, 3_000, 4, true);
    await deposit(partial.order.id, partial.order.total, 0.4, addDays(partial.date, 1));
    await updateBrickOrderStatus(partial.order.id, 'in_production', store.id, B);
    await updateBrickOrderStatus(partial.order.id, 'ready', store.id, B);
    await registerBrickOrderDelivery(
      partial.order.id,
      partial.items.map((item) => ({ itemId: item.id, quantity: Math.floor(item.quantity / 2) })),
      store.id,
      B,
    );
    // Commande facturée : la facture sort le stock et reprend l'acompte.
    const invoiced = await order(110, 0, 1_500, 5, true);
    await deposit(invoiced.order.id, invoiced.order.total, 0.5, addDays(invoiced.date, 1));
    await updateBrickOrderStatus(invoiced.order.id, 'in_production', store.id, B);
    await updateBrickOrderStatus(invoiced.order.id, 'ready', store.id, B);
    const brickStock = await getStoreStock(store.id, types[0].productId);
    if (brickStock >= invoiced.items[0].quantity) {
      await invoiceBrickOrder(invoiced.order.id, { id: manager.id, storeId: store.id }, B);
    }
    const cancelled = await order(160, 2, 5_000, 0, true);
    await cancelBrickOrder(cancelled.order.id, 'Le client a reporté son chantier', { id: manager.id, storeId: store.id }, B);

    /* ---------------------------- Vitrerie ----------------------------- */
    // Plus petite que la briqueterie : quelques productions, ventes et une commande.
    const glassTypes: { id: number; productId: number; price: number }[] = [];
    for (const glass of GLASSES) {
      const created = await createBrickType({
        storeId: store.id,
        branchId: glassBranch.id,
        productId: glassProducts.get(glass.product)!,
        name: glass.model,
        category: glass.category,
        thickness: glass.thickness,
        productionUnit: glass.unit,
        userId: manager.id,
      });
      glassTypes.push({ id: created.id, productId: created.productId, price: glass.price });
      report.brickTypes += 1;
    }
    const glassFlow = glassBranch.flow.map((s) => s.key);
    for (const [index, rawAge] of [120, 75, 40, 18, 6].entries()) {
      const age = rawAge + offset;
      const type = glassTypes[index % glassTypes.length];
      const startDate = d(-age);
      const done = age >= 15;
      const planned = Math.round(between(40, 90) * scale);
      const produced = done ? planned - between(0, 3) : 0;
      const lot = await createBrickProduction({
        storeId: store.id,
        branch: glassBranch,
        brickTypeId: type.id,
        plannedQuantity: planned,
        producedQuantity: produced,
        brokenQuantity: done ? between(0, 2) : 0,
        startDate,
        endDate: done ? addDays(startDate, 4) : null,
        team: 'Atelier vitrerie',
        userId: manager.id,
      });
      report.brickProductions += 1;
      await addProductionExpense(
        lot.id,
        {
          category: 'Transport',
          amount: Math.round(between(300_000, 900_000) * scale),
          date: startDate,
          description: `Verre brut — production ${lot.batchNumber}`,
          paymentMethod: 'Espèces',
          userId: manager.id,
          canSkipApproval: true,
        },
        store.id,
        glassBranch.id,
      );
      // Productions anciennes : en stock ; la dernière reste à sa première étape.
      const target = done ? 'stored' : glassFlow[1];
      for (const step of glassFlow.slice(1)) {
        await advanceStage(lot.id, step, store.id, manager.id, glassBranch);
        if (step === target) break;
      }
      if (done) {
        const date = addDays(startDate, between(6, 12));
        const available = await getStoreStock(store.id, type.productId);
        const quantity = Math.min(available, between(5, 20));
        if (date <= today() && quantity > 0) {
          const customerId = customer(index + 2);
          await createSalesInvoice({
            storeId: store.id,
            channel: 'brick',
            productionBranchId: glassBranch.id,
            customerId,
            customerName: customerId ? undefined : 'Client vitrerie',
            date,
            paymentMethod: 'Espèces',
            amountPaid: quantity * type.price,
            discount: 0,
            lines: [{ productId: type.productId, quantity, unitPrice: type.price }],
            userId: seller.id,
          });
          report.brickSales += 1;
        }
      }
    }
    // Une commande de vitres confirmée avec acompte (le même client peut acheter à la briqueterie).
    const glassOrder = await createBrickOrder({
      storeId: store.id,
      branch: glassBranch,
      customerId: customer(1),
      date: d(-(9 + offset)),
      promisedDate: d(-(9 + offset) + 10),
      status: 'confirmed',
      items: [{ brickTypeId: glassTypes[0].id, quantity: 12, unitPrice: glassTypes[0].price }],
      notes: 'Vitrage des fenêtres — démonstration',
      userId: manager.id,
    });
    report.brickOrders += 1;
    await deposit(glassOrder.order.id, glassOrder.order.total, 0.4, d(-(8 + offset)));

    /* ----------------------------- Atelier ----------------------------- */
    // Approvisionnement de l'atelier, daté du début de son activité.
    const suppliers = ctx.suppliersByStore[store.id] ?? [];
    if (suppliers.length > 0) {
      const lines = [];
      for (const [name, quantity] of WORKSHOP_SUPPLY) {
        const productId = product(name);
        const row = await rawGet<{ purchase_price: number | null }>('SELECT purchase_price FROM products WHERE id = ?', [productId]);
        lines.push({ productId, quantity: Math.ceil(quantity * scale), unitPrice: Number(row?.purchase_price ?? 0) });
      }
      await createPurchaseInvoice({
        storeId: store.id,
        supplierId: suppliers[0],
        date: d(-(370 + offset)),
        paymentMethod: 'Virement',
        amountPaid: lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
        lines,
        notes: 'Approvisionnement de l’atelier de meubles',
        userId: ctx.admin.id,
      });
    }

    const models: { id: number; name: string; price: number }[] = [];
    for (const model of MODELS) {
      const created = await createFurnitureModel({
        storeId: store.id,
        name: model.name,
        standardDimensions: model.dimensions,
        laborHours: model.hours,
        salePrice: model.price,
        userId: manager.id,
      });
      await setModelMaterials(
        created.id,
        model.materials.map(([name, quantity]) => ({ productId: product(name), quantity })),
        store.id,
      );
      models.push({ id: created.id, name: model.name, price: model.price });
      report.furnitureModels += 1;
    }

    /*
     * Commandes de l'atelier, de la plus ancienne à la plus récente. Les
     * anciennes sont livrées (soldées ou non), les récentes à chaque étape ;
     * une sur trois est une fabrication **pour le stock** (le meuble fini entre
     * en stock à la fin), une est sur mesure, une est annulée.
     */
    const orderAges = [360, 310, 255, 200, 150, 105, 70, 45, 30, 18, 9, 3];
    for (const [index, rawAge] of orderAges.entries()) {
      const age = rawAge + offset;
      const startDate = d(-age);
      const forStock = index % 3 === 2;
      const isCustom = index === 4;
      const model = models[index % models.length];
      const quantity = forStock ? (model.name.startsWith('Chaise') ? 6 : 2) : 1;
      const target: FurnitureStage =
        age >= 40 ? 'delivered' : age >= 25 ? 'finishing' : age >= 15 ? 'painting' : age >= 7 ? 'assembly' : 'cutting';

      const created = await createFurnitureOrder({
        storeId: store.id,
        purpose: forStock ? 'stock' : 'customer',
        customerId: forStock ? null : customer(index),
        modelId: isCustom ? null : model.id,
        isCustom,
        modelName: isCustom ? 'Dressing sur mesure' : undefined,
        dimensions: isCustom ? '240 x 60 x 230 cm' : null,
        finish: index % 2 === 0 ? 'Vernis brillant' : 'Teinte noyer',
        quantity,
        startDate,
        promisedDate: addDays(startDate, 30),
        agreedPrice: forStock ? undefined : isCustom ? 4_800_000 : Math.round(model.price * (0.95 + random() * 0.1)),
        productId: forStock
          ? product(model.name.startsWith('Chaise') ? 'Chaise bois massif' : model.name.startsWith('Table') ? 'Table à manger 6 places' : 'Armoire 2 portes standard')
          : null,
        notes: forStock ? 'Fabrication pour le stock du magasin' : null,
        userId: manager.id,
      });
      report.furnitureOrders += 1;

      // Matières : la nomenclature pour un modèle, ligne à ligne (avec chutes) sur mesure.
      try {
        if (isCustom) {
          await addOrderMaterial(created.id, { productId: product('Contreplaqué 15 mm — 2,44 x 1,22 m'), quantity: 6, wastageQuantity: 1, userId: manager.id }, store.id);
          await addOrderMaterial(created.id, { productId: product('Planche bois rouge 2,5 m'), quantity: 10, wastageQuantity: 2, userId: manager.id }, store.id);
          await addOrderMaterial(created.id, { productId: product('Charnière invisible'), quantity: 12, userId: manager.id }, store.id);
        } else {
          await consumePlannedMaterials(created.id, store.id, manager.id);
          if (index % 4 === 0) {
            await addOrderMaterial(created.id, { productId: product('Planche bois rouge 2,5 m'), quantity: 1, wastageQuantity: 1, userId: manager.id }, store.id);
          }
        }
      } catch {
        /* rupture de matière : la commande attend son réassort, comme en atelier */
      }
      await addOrderWorker(created.id, { workerId: menuisier.id, days: between(3, 10) * quantity }, store.id);
      if (target !== 'cutting' && target !== 'assembly') {
        await addOrderWorker(created.id, { workerId: finisseur.id, days: between(2, 5) }, store.id);
      }

      // Acompte à la commande.
      if (!forStock && created.total > 0) {
        await createPayment({
          storeId: store.id,
          type: 'furniture_order',
          referenceId: created.id,
          amount: Math.round(created.total * 0.4),
          paymentMethod: 'Espèces',
          date: startDate,
          userId: seller.id,
        });
      }

      // Annulée : le client a renoncé, les matières reviennent au stock.
      if (index === 9) {
        await cancelFurnitureOrder(created.id, 'Le client a renoncé à sa commande', { id: manager.id, storeId: store.id });
        continue;
      }

      let stage: FurnitureStage | null = 'cutting';
      const deliveryDate = addDays(startDate, between(20, 35));
      while (stage !== target) {
        stage = nextFurnitureStage(stage);
        if (!stage) break;
        await advanceFurnitureStage(created.id, stage, store.id, {
          userId: manager.id,
          deliveryDate: stage === 'delivered' ? (deliveryDate > today() ? today() : deliveryDate) : null,
        });
      }

      // Solde à la livraison pour la plupart ; un reste dû sur une commande sur trois.
      if (!forStock && target === 'delivered' && created.total > 0 && index % 3 !== 1) {
        await createPayment({
          storeId: store.id,
          type: 'furniture_order',
          referenceId: created.id,
          amount: created.total - Math.round(created.total * 0.4),
          paymentMethod: index % 2 === 0 ? 'Espèces' : 'Mobile Money',
          date: deliveryDate > today() ? today() : deliveryDate,
          userId: seller.id,
        });
      }
    }

    /*
     * Filiale Meuble (README §31.9) : les modèles de l'atelier sont repris
     * (produit lié + nomenclature), puis fabriqués en productions — une mise en
     * stock, une en cours avec ses matières sorties.
     */
    await importFurnitureModels(meubleBranch, store.id, manager.id);
    const meubleModels = await rawGet<{ ids: string | null }>(
      `SELECT group_concat(id) AS ids FROM brick_types WHERE branch_id = ? AND store_id = ? AND is_active = 1`,
      [meubleBranch.id, store.id],
    );
    const meubleModelIds = String(meubleModels?.ids ?? '').split(',').map(Number).filter(Boolean);
    for (const [index, modelId] of meubleModelIds.slice(0, 2).entries()) {
      const age = (index === 0 ? 40 : 6) + offset;
      const production = await createBrickProduction({
        storeId: store.id,
        branch: meubleBranch,
        brickTypeId: modelId,
        plannedQuantity: 2,
        producedQuantity: index === 0 ? 2 : 0,
        startDate: d(-age),
        team: 'Équipe atelier',
        userId: manager.id,
      });
      report.meubleProductions = (report.meubleProductions ?? 0) + 1;
      try {
        await consumePlannedProductionMaterials(production.id, store.id, meubleBranch, manager.id);
        await addProductionMaterial(
          production.id,
          { productId: product('Planche bois rouge 2,5 m'), quantity: 1, wastageQuantity: 1, userId: manager.id },
          store.id,
          meubleBranch,
        );
      } catch {
        /* rupture de matière : la production attend son réassort */
      }
      await addProductionWorker(production.id, { workerId: menuisier.id, days: between(3, 6) }, store.id, meubleBranch.id);
      if (index === 0) {
        for (const stage of meubleBranch.flow.slice(1)) {
          await advanceStage(production.id, stage.key, store.id, manager.id, meubleBranch);
        }
      }
    }

    /* Dépenses globales des filiales : loyer de l'atelier, entretien du four… */
    for (const [branch, category, amount, label] of [
      [meubleBranch, 'Loyer et charges', 1_500_000, 'Loyer mensuel de l’atelier'],
      [brickBranch, 'Entretien des machines', 650_000, 'Entretien du four'],
      [glassBranch, 'Outillage', 400_000, 'Coupe-verre et ventouses'],
    ] as const) {
      await createExpense({
        storeId: store.id,
        category,
        amount: Math.round(amount * scale),
        description: label,
        paymentMethod: 'Espèces',
        referenceType: BRANCH_EXPENSE_REFERENCE,
        productionBranchId: branch.id,
        date: d(-(12 + offset)),
        userId: manager.id,
        canSkipApproval: true,
      });
    }

    /* Un inventaire validé de la briqueterie, avec un écart justifié (README §31.6). */
    try {
      const inventoryUser = { id: manager.id, name: manager.name, storeId: store.id };
      const inventoryId = await openInventory({ branchId: brickBranch.id, notes: 'Inventaire mensuel de la briqueterie' }, inventoryUser);
      const detail = await getInventory(inventoryId);
      if (detail) {
        await recordCounts(
          inventoryId,
          detail.items.map((item, i) => ({
            itemId: item.id,
            countedQuantity: i === 0 && item.expectedQuantity >= 10 ? item.expectedQuantity - 10 : item.expectedQuantity,
            justification: i === 0 && item.expectedQuantity >= 10 ? 'Casse au déchargement' : null,
          })),
          inventoryUser,
        );
        await validateInventory(inventoryId, inventoryUser);
      }
    } catch {
      /* inventaire déjà ouvert dans le magasin : la démonstration continue */
    }
  }

  return report;
}
