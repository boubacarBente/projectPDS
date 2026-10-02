/**
 * Données de démonstration **multi-magasins** (outil de développement et de
 * recette — la carte « Préremplir » est masquée en production et en desktop).
 *
 * Contrairement à l'ancienne version, **toutes** les écritures passent par les
 * fonctions métier de `lib/` (ventes, achats, paiements, dépenses, transferts,
 * inventaires, chantiers). Le jeu de démonstration est donc un test
 * d'intégration grandeur nature : chaque stock, chaque caisse et chaque solde
 * qu'il produit suit exactement les règles de l'application.
 *
 * Contenu :
 *  - 3 établissements : le siège (charges centrales, entrepôt), Kaloum, Matoto ;
 *  - comptes : gérants et vendeurs par magasin (mot de passe `demo1234`) ;
 *  - catalogue commun, clients, fournisseurs, ouvriers ;
 *  - **13 mois d'activité** (l'année précédente comprise) pour que chaque
 *    filtre de période — jour, semaine, mois, année, mois ou année passés —
 *    ait quelque chose à montrer : activité dense sur les 60 derniers jours,
 *    plus clairsemée avant ; ventes (comptant, partiel, crédit), réassort
 *    mensuel, dépenses locales et centrales ;
 *  - des documents dans **chaque statut** filtrable : ventes en brouillon et
 *    annulées, achat annulé, dépenses en attente / à décaisser / rejetées ;
 *  - transferts à toutes les étapes (reçu, en transit, en attente, validé,
 *    en litige, refusé, annulé) ;
 *  - un inventaire validé avec écarts et un inventaire en cours ;
 *  - trois chantiers.
 *
 * Idempotent : ne fait rien si le catalogue contient déjà des produits.
 */

import { rawAll, rawGet } from '@/db';
import { createCategory, createProduct } from '@/lib/products';
import { createCustomer } from '@/lib/customers';
import { createSupplier } from '@/lib/suppliers';
import { createWorker } from '@/lib/workers';
import { createUser } from '@/lib/users';
import { createStore, listStores, setUserAssignments } from '@/lib/stores';
import { cancelPurchaseInvoice, createPurchaseInvoice } from '@/lib/purchases';
import { cancelSalesInvoice, createSalesInvoice } from '@/lib/sales';
import { createExpense, decideExpense } from '@/lib/expenses';
import { createPayment } from '@/lib/payments';
import { approveTransfer, cancelTransfer, createTransfer, receiveTransfer, shipTransfer } from '@/lib/transfers';
import { openInventory, recordCounts, validateInventory, getInventory } from '@/lib/inventories';
import { addJobMaterial, addJobWorker, createServiceJob, updateStatus } from '@/lib/jobs';
import { addCashMovement, closeSession, getOpenSession, getSessionTheoreticalByMethod } from '@/lib/caisse';
import { getStoreStock } from '@/lib/stock';
import { addDays, today } from '@/lib/format';
import { getSettings, updateSettings } from '@/lib/settings';

export type SeedReport = {
  stores: number;
  users: number;
  categories: number;
  products: number;
  customers: number;
  suppliers: number;
  workers: number;
  sales: number;
  purchases: number;
  expenses: number;
  transfers: number;
  inventories: number;
  serviceJobs: number;
  skipped: boolean;
  message: string;
};

/* ------------------------------------------------------------------ *
 * Référentiels
 * ------------------------------------------------------------------ */

const CATEGORIES: { name: string; kind: 'finished' | 'raw_material' | 'service'; description: string }[] = [
  { name: 'Meuble', kind: 'finished', description: 'Meubles finis vendus en magasin' },
  { name: 'Alucobond', kind: 'raw_material', description: 'Panneaux composites pour façades' },
  { name: 'Staff', kind: 'raw_material', description: 'Staff et plâtre décoratif' },
  { name: 'Placo', kind: 'raw_material', description: 'Plaques de plâtre et profilés' },
  { name: 'Peinture', kind: 'raw_material', description: 'Peintures, vernis et enduits' },
  { name: 'Bois', kind: 'raw_material', description: 'Planches, chevrons et panneaux' },
  { name: 'Quincaillerie', kind: 'raw_material', description: 'Clous, vis, colle, poignées, charnières' },
];

type ProductSeed = { name: string; category: string; unit: string; purchasePrice: number; salePrice: number; stock: number; stockMin: number };

const PRODUCTS: ProductSeed[] = [
  { name: 'Armoire 2 portes standard', category: 'Meuble', unit: 'pièce', purchasePrice: 1_450_000, salePrice: 2_100_000, stock: 6, stockMin: 2 },
  { name: 'Lit 2 places avec tête de lit', category: 'Meuble', unit: 'pièce', purchasePrice: 1_900_000, salePrice: 2_750_000, stock: 5, stockMin: 2 },
  { name: 'Table à manger 6 places', category: 'Meuble', unit: 'pièce', purchasePrice: 1_200_000, salePrice: 1_850_000, stock: 6, stockMin: 2 },
  { name: 'Buffet bas 4 portes', category: 'Meuble', unit: 'pièce', purchasePrice: 980_000, salePrice: 1_500_000, stock: 6, stockMin: 2 },
  { name: 'Ensemble salon complet', category: 'Meuble', unit: 'ensemble', purchasePrice: 4_200_000, salePrice: 6_300_000, stock: 3, stockMin: 1 },
  { name: 'Bureau de direction', category: 'Meuble', unit: 'pièce', purchasePrice: 1_650_000, salePrice: 2_450_000, stock: 4, stockMin: 1 },
  { name: 'Chaise bois massif', category: 'Meuble', unit: 'pièce', purchasePrice: 185_000, salePrice: 295_000, stock: 40, stockMin: 8 },
  { name: 'Panneau Alucobond 4 mm rouge', category: 'Alucobond', unit: 'm²', purchasePrice: 145_000, salePrice: 210_000, stock: 120, stockMin: 20 },
  { name: 'Panneau Alucobond 4 mm argent', category: 'Alucobond', unit: 'm²', purchasePrice: 148_000, salePrice: 215_000, stock: 90, stockMin: 20 },
  { name: 'Panneau Alucobond 3 mm bleu', category: 'Alucobond', unit: 'm²', purchasePrice: 125_000, salePrice: 185_000, stock: 30, stockMin: 20 },
  { name: 'Staff décoratif en poudre', category: 'Staff', unit: 'sac', purchasePrice: 78_000, salePrice: 115_000, stock: 60, stockMin: 10 },
  { name: 'Corniche staff 2 m', category: 'Staff', unit: 'pièce', purchasePrice: 42_000, salePrice: 68_000, stock: 80, stockMin: 15 },
  { name: 'Plaque BA13 1,20 x 2,60 m', category: 'Placo', unit: 'pièce', purchasePrice: 68_000, salePrice: 98_000, stock: 160, stockMin: 30 },
  { name: 'Rail R48', category: 'Placo', unit: 'pièce', purchasePrice: 22_000, salePrice: 34_000, stock: 220, stockMin: 40 },
  { name: 'Montant M48', category: 'Placo', unit: 'pièce', purchasePrice: 24_000, salePrice: 36_000, stock: 200, stockMin: 40 },
  { name: 'Peinture acrylique blanche 20 L', category: 'Peinture', unit: 'litre', purchasePrice: 8_500, salePrice: 13_500, stock: 300, stockMin: 60 },
  { name: 'Vernis bois brillant 5 L', category: 'Peinture', unit: 'litre', purchasePrice: 12_000, salePrice: 19_500, stock: 80, stockMin: 20 },
  { name: 'Enduit de lissage 25 kg', category: 'Peinture', unit: 'sac', purchasePrice: 65_000, salePrice: 92_000, stock: 40, stockMin: 10 },
  { name: 'Planche bois rouge 2,5 m', category: 'Bois', unit: 'pièce', purchasePrice: 95_000, salePrice: 140_000, stock: 110, stockMin: 25 },
  { name: 'Chevron 7 x 7 cm — 3 m', category: 'Bois', unit: 'pièce', purchasePrice: 55_000, salePrice: 82_000, stock: 150, stockMin: 30 },
  { name: 'Contreplaqué 15 mm — 2,44 x 1,22 m', category: 'Bois', unit: 'pièce', purchasePrice: 320_000, salePrice: 445_000, stock: 30, stockMin: 8 },
  { name: 'Charnière invisible', category: 'Quincaillerie', unit: 'pièce', purchasePrice: 3_500, salePrice: 6_000, stock: 600, stockMin: 100 },
  { name: 'Colle à bois 1 kg', category: 'Quincaillerie', unit: 'pièce', purchasePrice: 28_000, salePrice: 42_000, stock: 60, stockMin: 12 },
  { name: 'Vis à bois 5 x 60 mm (boîte de 200)', category: 'Quincaillerie', unit: 'carton', purchasePrice: 32_000, salePrice: 48_000, stock: 50, stockMin: 10 },
  { name: 'Poignée aluminium brossé', category: 'Quincaillerie', unit: 'pièce', purchasePrice: 9_500, salePrice: 16_000, stock: 200, stockMin: 40 },
  { name: 'Clous 50 mm (1 kg)', category: 'Quincaillerie', unit: 'kg', purchasePrice: 12_000, salePrice: 19_000, stock: 80, stockMin: 15 },
];

const CUSTOMERS = [
  { name: 'Résidence Les Palmiers', phone: '+224 622 11 22 33', address: 'Kipé, Conakry', creditLimit: 50_000_000 },
  { name: 'Hôtel Kaloum Plaza', phone: '+224 621 44 55 66', address: 'Kaloum, Conakry', creditLimit: 80_000_000 },
  { name: 'M. Ibrahima Camara', phone: '+224 664 77 88 99', address: 'Matam, Conakry', creditLimit: 5_000_000 },
  { name: 'Chantier Villa Nongo', phone: '+224 628 33 44 55', address: 'Nongo, Conakry', creditLimit: 25_000_000 },
  { name: 'Mme Fatoumata Diallo', phone: '+224 666 12 34 56', address: 'Ratoma, Conakry', creditLimit: 3_000_000 },
  { name: 'Bureaux Nimba Services', phone: '+224 620 98 76 54', address: 'Taouyah, Conakry', creditLimit: 15_000_000 },
];

const SUPPLIERS = [
  { name: 'Scierie Kindia Bois', phone: '+224 655 10 20 30', address: 'Kindia' },
  { name: 'Quincaillerie du Port', phone: '+224 622 40 50 60', address: 'Port de Conakry' },
  { name: 'Alucobond Afrique de l’Ouest', phone: '+224 628 11 33 55', address: 'Conakry' },
  { name: 'Meubles Import Dakar', phone: '+221 77 123 45 67', address: 'Dakar' },
];

const WORKERS = [
  { name: 'Sékou Touré', role: 'foreman' as const, dailyRate: 150_000, specialty: 'Chef d’équipe chantier' },
  { name: 'Alpha Condé', role: 'worker' as const, dailyRate: 85_000, specialty: 'Pose Alucobond' },
  { name: 'Aïssatou Barry', role: 'worker' as const, dailyRate: 80_000, specialty: 'Peinture et finition' },
  { name: 'Ousmane Sylla', role: 'worker' as const, dailyRate: 82_000, specialty: 'Placo et staff' },
  { name: 'Kadiatou Soumah', role: 'apprentice' as const, dailyRate: 45_000, specialty: 'Apprentie' },
];

/* ------------------------------------------------------------------ *
 * Hasard reproductible
 * ------------------------------------------------------------------ */

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Seed
 * ------------------------------------------------------------------ */

export async function seedDemoData(options: { days?: number } = {}): Promise<SeedReport> {
  const existing = await rawGet<{ n: number }>('SELECT COUNT(*) AS n FROM products');
  const report: SeedReport = {
    stores: 0,
    users: 0,
    categories: 0,
    products: 0,
    customers: 0,
    suppliers: 0,
    workers: 0,
    sales: 0,
    purchases: 0,
    expenses: 0,
    transfers: 0,
    inventories: 0,
    serviceJobs: 0,
    skipped: false,
    message: '',
  };
  if (Number(existing?.n ?? 0) > 0) {
    return {
      ...report,
      skipped: true,
      message: 'Le catalogue contient déjà des produits : rien n’a été ajouté. Réinitialisez d’abord pour repartir de la démonstration.',
    };
  }

  const admin = await rawGet<{ id: number; name: string }>(
    `SELECT id, name FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1`,
  );
  if (!admin) throw new Error('Créez d’abord le compte administrateur.');
  const adminRef = { id: Number(admin.id), name: String(admin.name) };

  const random = rng(20261001);
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
  // 400 jours : 13 mois, donc toujours le même mois de l'année précédente.
  const days = Math.max(7, options.days ?? 400);
  /** Au-delà de 60 jours, l'activité est clairsemée (le jeu reste rapide à créer). */
  const DENSE_DAYS = 60;
  const start = addDays(today(), -days);

  /* ----------------------------- Magasins ------------------------------ */
  let stores = await listStores();
  const ensureStore = async (code: string, name: string, kind: 'store' | 'headquarters', address: string, phone: string) => {
    let store = stores.find((s) => s.code === code);
    if (!store) {
      store = await createStore({ code, name, kind, address, phone, openingDate: addDays(start, -30) }, adminRef);
      report.stores += 1;
    }
    return store;
  };
  const hq = await ensureStore('SIEGE', 'Siège — Entrepôt central', 'headquarters', 'Yattaya, Conakry', '+224 620 00 00 01');
  const kaloum = await ensureStore('KAL', 'Magasin Kaloum', 'store', 'Avenue de la République, Kaloum', '+224 620 00 00 02');
  const matoto = await ensureStore('MAT', 'Magasin Matoto', 'store', 'Marché de Matoto', '+224 620 00 00 03');
  stores = await listStores();

  /* ----------------------------- Comptes ------------------------------- */
  const makeUser = async (name: string, username: string, role: 'manager' | 'seller' | 'storekeeper') => {
    const found = await rawGet<{ id: number }>(`SELECT id FROM users WHERE username = ?`, [username]);
    if (found) return Number(found.id);
    const created = await createUser({ name, username, password: 'demo1234', role, phone: null });
    report.users += 1;
    return created.id;
  };
  const gerantKal = await makeUser('Mariama Bangoura', 'gerant.kaloum', 'manager');
  const vendeurKal = await makeUser('Moussa Keïta', 'vendeur.kaloum', 'seller');
  const gerantMat = await makeUser('Thierno Diallo', 'gerant.matoto', 'manager');
  const vendeurMat = await makeUser('Hawa Camara', 'vendeur.matoto', 'seller');
  const magasinier = await makeUser('Abdoulaye Sow', 'magasinier.siege', 'storekeeper');
  await setUserAssignments(gerantKal, [{ storeId: kaloum.id, isManager: true }], adminRef);
  await setUserAssignments(vendeurKal, [{ storeId: kaloum.id }], adminRef);
  await setUserAssignments(gerantMat, [{ storeId: matoto.id, isManager: true }], adminRef);
  await setUserAssignments(vendeurMat, [{ storeId: matoto.id }], adminRef);
  await setUserAssignments(magasinier, [{ storeId: hq.id }, { storeId: kaloum.id }, { storeId: matoto.id }], adminRef);
  // L'administrateur est affecté à tous les magasins (il les voit de toute façon).
  await setUserAssignments(
    adminRef.id,
    stores.map((s) => ({ storeId: s.id, isManager: true })),
    adminRef,
  );

  /* --------------------------- Référentiels ---------------------------- */
  const categoryIds = new Map<string, number>();
  for (const category of CATEGORIES) {
    const created = await createCategory({ name: category.name, kind: category.kind, description: category.description });
    categoryIds.set(category.name, created.id);
    report.categories += 1;
  }
  const productIds = new Map<string, number>();
  for (const product of PRODUCTS) {
    const created = await createProduct({
      name: product.name,
      categoryId: categoryIds.get(product.category) ?? null,
      unit: product.unit,
      purchasePrice: product.purchasePrice,
      salePrice: product.salePrice,
      stockMin: product.stockMin,
    });
    productIds.set(product.name, created.id);
    report.products += 1;
  }
  const customerIds: number[] = [];
  for (const customer of CUSTOMERS) {
    customerIds.push((await createCustomer(customer)).id);
    report.customers += 1;
  }
  const supplierIds: number[] = [];
  for (const supplier of SUPPLIERS) {
    supplierIds.push((await createSupplier(supplier)).id);
    report.suppliers += 1;
  }
  for (const worker of WORKERS) {
    await createWorker(worker);
    report.workers += 1;
  }

  /*
   * Apport de trésorerie de départ (fonds de caisse et compte bancaire de
   * chaque établissement). Sans lui, les premiers achats payés en espèces
   * faisaient tomber la caisse du siège à −233 millions (constaté en recette) :
   * une démonstration doit partir d'une situation réaliste.
   */
  for (const [store, cash, bank] of [
    [hq, 400_000_000, 400_000_000],
    [kaloum, 120_000_000, 180_000_000],
    [matoto, 100_000_000, 160_000_000],
  ] as const) {
    await addCashMovement({ storeId: store.id, type: 'income', amount: cash, paymentMethod: 'Espèces', motif: 'Apport initial — fonds de caisse', date: start, userId: adminRef.id });
    await addCashMovement({ storeId: store.id, type: 'income', amount: bank, paymentMethod: 'Virement', motif: 'Apport initial — compte bancaire', date: start, userId: adminRef.id });
  }

  /* ----------------------- Approvisionnement initial ------------------- */
  const shares: [typeof hq, number][] = [
    [hq, 1],
    [kaloum, 0.8],
    [matoto, 0.6],
  ];
  for (const [store, share] of shares) {
    for (const [index, supplierId] of supplierIds.entries()) {
      const lines = PRODUCTS.filter((_, i) => i % supplierIds.length === index).map((product) => ({
        productId: productIds.get(product.name)!,
        quantity: Math.max(1, Math.round(product.stock * share)),
        unitPrice: product.purchasePrice,
      }));
      if (lines.length === 0) continue;
      const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
      await createPurchaseInvoice({
        storeId: store.id,
        supplierId,
        date: start,
        paymentMethod: index % 2 === 0 ? 'Virement' : 'Espèces',
        // Une partie des achats reste due au fournisseur.
        amountPaid: index === 0 ? total : Math.round(total * 0.6),
        lines,
        userId: adminRef.id,
      });
      report.purchases += 1;
    }
  }

  /* ------------------------------ Ventes ------------------------------- */
  const sellers: Record<number, number> = { [hq.id]: magasinier, [kaloum.id]: vendeurKal, [matoto.id]: vendeurMat };
  const sellable = PRODUCTS.filter((p) => p.salePrice > 0);
  for (let d = 0; d <= days; d += 1) {
    const date = addDays(start, d);
    const dense = days - d <= DENSE_DAYS;

    /*
     * Réassort mensuel (le 1er) : sans lui, 13 mois de ventes videraient le
     * stock et les ventes récentes n'auraient plus lieu. Il répartit aussi les
     * achats sur tous les mois (filtres de période de /achats) ; une partie
     * reste due au fournisseur.
     */
    if (d > 0 && date.endsWith('-01')) {
      for (const [store, share] of shares) {
        const lines: { productId: number; quantity: number; unitPrice: number }[] = [];
        for (const product of PRODUCTS) {
          const productId = productIds.get(product.name)!;
          const target = Math.max(1, Math.round(product.stock * share));
          const current = await getStoreStock(store.id, productId);
          if (current < target) lines.push({ productId, quantity: Math.ceil(target - current), unitPrice: product.purchasePrice });
        }
        if (lines.length === 0) continue;
        const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
        await createPurchaseInvoice({
          storeId: store.id,
          supplierId: pick(supplierIds),
          date,
          paymentMethod: random() < 0.5 ? 'Virement' : 'Espèces',
          amountPaid: random() < 0.7 ? total : Math.round(total * 0.5),
          lines,
          userId: adminRef.id,
        });
        report.purchases += 1;
      }
    }

    for (const store of [kaloum, matoto, hq]) {
      const salesToday = !dense
        ? random() < (store.kind === 'headquarters' ? 0.1 : 0.4)
          ? 1
          : 0
        : store.kind === 'headquarters'
          ? random() < 0.3
            ? 1
            : 0
          : 1 + Math.floor(random() * 3);
      for (let s = 0; s < salesToday; s += 1) {
        const lines: { productId: number; quantity: number; unitPrice: number }[] = [];
        const lineCount = 1 + Math.floor(random() * 3);
        for (let l = 0; l < lineCount; l += 1) {
          const product = pick(sellable);
          const productId = productIds.get(product.name)!;
          if (lines.some((line) => line.productId === productId)) continue;
          const available = await getStoreStock(store.id, productId);
          const unitScale = product.salePrice > 1_000_000 ? 1 : product.salePrice > 100_000 ? 2 : 8;
          const quantity = Math.min(available, 1 + Math.floor(random() * unitScale));
          if (quantity <= 0) continue;
          lines.push({ productId, quantity, unitPrice: product.salePrice });
        }
        if (lines.length === 0) continue;
        const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
        const mode = random();
        const customerId = mode < 0.5 ? null : pick(customerIds);
        const amountPaid = customerId === null || mode < 0.75 ? total : mode < 0.9 ? Math.round(total * 0.5) : 0;
        try {
          await createSalesInvoice({
            storeId: store.id,
            customerId,
            customerName: customerId ? undefined : 'Client comptoir',
            date,
            dueDate: amountPaid < total ? addDays(date, 30) : null,
            paymentMethod: random() < 0.7 ? 'Espèces' : 'Mobile Money',
            amountPaid,
            discount: 0,
            lines,
            userId: sellers[store.id] ?? adminRef.id,
          } as any);
          report.sales += 1;
        } catch {
          /* rupture : la vente n'a pas lieu, comme en magasin */
        }
      }
    }

    // Dépenses locales (hebdomadaires) et charges centrales (mensuelles).
    if (d % 7 === 3) {
      for (const store of [kaloum, matoto]) {
        await createExpense({
          storeId: store.id,
          category: pick(['Transport', 'Électricité', 'Carburant']),
          amount: 150_000 + Math.round(random() * 350_000),
          date,
          description: 'Frais de fonctionnement',
          userId: adminRef.id,
          canSkipApproval: true,
        });
        report.expenses += 1;
      }
    }
    if (date.endsWith('-28') || d === days) {
      await createExpense({
        storeId: hq.id,
        category: 'Salaire',
        amount: 6_500_000,
        date,
        description: 'Salaires du personnel (charge centrale)',
        userId: adminRef.id,
        canSkipApproval: true,
      });
      await createExpense({
        storeId: hq.id,
        category: 'Loyer',
        amount: 3_000_000,
        date,
        description: 'Loyer du siège (charge centrale)',
        userId: adminRef.id,
        canSkipApproval: true,
      });
      report.expenses += 2;
    }
  }

  // Quelques règlements tardifs de créances.
  const debts = await rawAll<{ id: number; store_id: number; remaining_amount: number }>(
    `SELECT id, store_id, remaining_amount FROM sales_invoices
      WHERE status = 'active' AND remaining_amount > 0 ORDER BY date LIMIT 6`,
  );
  for (const debt of debts) {
    await createPayment({
      storeId: Number(debt.store_id),
      type: 'sale',
      referenceId: Number(debt.id),
      amount: Math.round(Number(debt.remaining_amount) / 2),
      paymentMethod: 'Espèces',
      date: today(),
      userId: adminRef.id,
    });
  }

  /* ---------------------------- Transferts ----------------------------- */
  const asUser = (id: number, name: string, storeId: number) => ({
    id,
    name,
    storeId,
    storeIds: stores.map((s) => s.id),
    allStores: true,
  });
  const chairs = productIds.get('Chaise bois massif')!;
  const ba13 = productIds.get('Plaque BA13 1,20 x 2,60 m')!;
  const paint = productIds.get('Peinture acrylique blanche 20 L')!;

  // 1. Siège → Kaloum : validé, expédié, reçu.
  const t1 = await createTransfer(
    {
      sourceStoreId: hq.id,
      destinationStoreId: kaloum.id,
      reason: 'Réassort hebdomadaire',
      items: [
        { productId: chairs, quantity: 6 },
        { productId: ba13, quantity: 20 },
      ],
      submit: true,
    },
    asUser(gerantKal, 'Mariama Bangoura', kaloum.id),
  );
  await approveTransfer(t1.transfer.id, 'approve', asUser(adminRef.id, adminRef.name, hq.id));
  await shipTransfer(t1.transfer.id, asUser(magasinier, 'Abdoulaye Sow', hq.id));
  const t1Detail = (await import('@/lib/transfers')).getTransfer;
  const shipped = await t1Detail(t1.transfer.id);
  await receiveTransfer(
    t1.transfer.id,
    asUser(gerantKal, 'Mariama Bangoura', kaloum.id),
    { quantities: Object.fromEntries(shipped!.items.map((i) => [i.id, i.quantityShipped])), close: true },
  );
  report.transfers += 1;

  // 2. Siège → Matoto : en transit.
  const t2 = await createTransfer(
    {
      sourceStoreId: hq.id,
      destinationStoreId: matoto.id,
      reason: 'Commande client Matoto',
      items: [{ productId: paint, quantity: 40 }],
      submit: true,
    },
    asUser(gerantMat, 'Thierno Diallo', matoto.id),
  );
  await approveTransfer(t2.transfer.id, 'approve', asUser(adminRef.id, adminRef.name, hq.id));
  await shipTransfer(t2.transfer.id, asUser(magasinier, 'Abdoulaye Sow', hq.id));
  report.transfers += 1;

  // 3. Matoto → Kaloum : en attente de validation.
  await createTransfer(
    {
      sourceStoreId: matoto.id,
      destinationStoreId: kaloum.id,
      reason: 'Rupture de chaises à Kaloum',
      items: [{ productId: chairs, quantity: 4 }],
      submit: true,
    },
    asUser(gerantKal, 'Mariama Bangoura', kaloum.id),
  );
  report.transfers += 1;

  /* ---------------------------- Inventaire ----------------------------- */
  const inventoryId = await openInventory(
    { categoryId: categoryIds.get('Quincaillerie') ?? null, notes: 'Inventaire de démonstration' },
    { id: gerantKal, name: 'Mariama Bangoura', storeId: kaloum.id },
  );
  const inventory = await getInventory(inventoryId);
  await recordCounts(
    inventoryId,
    inventory!.items.map((item, index) => ({
      itemId: item.id,
      countedQuantity: Math.max(0, item.expectedQuantity - (index === 0 ? 3 : index === 1 ? -2 : 0)),
      justification: index === 0 ? 'Casse constatée' : index === 1 ? 'Retour client non saisi' : null,
    })),
    { id: gerantKal, name: 'Mariama Bangoura', storeId: kaloum.id },
  );
  await validateInventory(inventoryId, { id: gerantKal, name: 'Mariama Bangoura', storeId: kaloum.id });
  report.inventories += 1;

  /* ----------------------------- Chantiers ----------------------------- */
  const workerRows = await rawAll<{ id: number; name: string }>(`SELECT id, name FROM workers`);
  const workerId = (name: string) => workerRows.find((w) => w.name === name)?.id ?? null;
  const jobDefs = [
    {
      customer: customerIds[1],
      category: 'Alucobond / façade',
      title: 'Habillage façade Alucobond — aile nord',
      status: 'in_progress' as const,
      startDaysAgo: 12,
      materials: [['Panneau Alucobond 4 mm rouge', 20], ['Panneau Alucobond 4 mm argent', 15]] as [string, number][],
      team: [['Sékou Touré', 12], ['Alpha Condé', 12]] as [string, number][],
      paid: 0.4,
    },
    {
      customer: customerIds[0],
      category: 'Peinture',
      title: 'Peinture et finitions — six appartements',
      status: 'completed' as const,
      startDaysAgo: 25,
      materials: [['Peinture acrylique blanche 20 L', 60], ['Enduit de lissage 25 kg', 6]] as [string, number][],
      team: [['Aïssatou Barry', 14], ['Ousmane Sylla', 10]] as [string, number][],
      paid: 1,
    },
    {
      customer: customerIds[5],
      category: 'Placo / faux plafond',
      title: 'Cloisons et faux plafond — plateau 2',
      status: 'quote' as const,
      startDaysAgo: null,
      materials: [] as [string, number][],
      team: [] as [string, number][],
      paid: 0,
    },
  ];
  for (const def of jobDefs) {
    const job = await createServiceJob({
      storeId: kaloum.id,
      customerId: def.customer,
      category: def.category,
      title: def.title,
      siteAddress: 'Conakry',
      startDate: def.startDaysAgo === null ? null : addDays(today(), -def.startDaysAgo),
      status: def.status === 'quote' ? 'quote' : 'pending',
      quoteStatus: def.status === 'quote' ? 'sent' : 'accepted',
      quoteMaterials: def.status === 'quote' ? 8_500_000 : 0,
      quoteLabor: def.status === 'quote' ? 3_200_000 : 0,
      userId: gerantKal,
    } as any);
    for (const [name, quantity] of def.materials) {
      await addJobMaterial(job.id, { productId: productIds.get(name)!, quantity, userId: gerantKal, storeId: kaloum.id });
    }
    for (const [name, daysWorked] of def.team) {
      await addJobWorker(job.id, { workerId: workerId(name), days: daysWorked }, kaloum.id);
    }
    if (def.status !== 'quote') await updateStatus(job.id, def.status, kaloum.id);
    if (def.paid > 0) {
      const refreshed = await rawGet<{ total: number }>(`SELECT total FROM service_jobs WHERE id = ?`, [job.id]);
      const amount = Math.round(Number(refreshed?.total ?? 0) * def.paid);
      if (amount > 0) {
        await createPayment({
          storeId: kaloum.id,
          type: 'service_job',
          referenceId: job.id,
          amount,
          paymentMethod: 'Virement',
          userId: gerantKal,
        });
      }
    }
    report.serviceJobs += 1;
  }

  /* ------------- Un document dans chaque statut filtrable -------------- */

  // Transferts : validé (à expédier), en litige, refusé, annulé.
  const t4 = await createTransfer(
    { sourceStoreId: hq.id, destinationStoreId: kaloum.id, reason: 'Préparation de la saison', items: [{ productId: ba13, quantity: 10 }], submit: true },
    asUser(gerantKal, 'Mariama Bangoura', kaloum.id),
  );
  await approveTransfer(t4.transfer.id, 'approve', asUser(adminRef.id, adminRef.name, hq.id));
  const t5 = await createTransfer(
    { sourceStoreId: hq.id, destinationStoreId: matoto.id, reason: 'Réassort peinture', items: [{ productId: paint, quantity: 10 }], submit: true },
    asUser(gerantMat, 'Thierno Diallo', matoto.id),
  );
  await approveTransfer(t5.transfer.id, 'approve', asUser(adminRef.id, adminRef.name, hq.id));
  await shipTransfer(t5.transfer.id, asUser(magasinier, 'Abdoulaye Sow', hq.id));
  const t5Item = (await t1Detail(t5.transfer.id))!.items[0];
  await receiveTransfer(t5.transfer.id, asUser(gerantMat, 'Thierno Diallo', matoto.id), {
    quantities: { [t5Item.id]: 8 },
    discrepancies: { [t5Item.id]: '2 seaux percés à l’arrivée' },
    close: true,
  });
  const t6 = await createTransfer(
    { sourceStoreId: kaloum.id, destinationStoreId: matoto.id, reason: 'Demande exceptionnelle', items: [{ productId: chairs, quantity: 10 }], submit: true },
    asUser(gerantMat, 'Thierno Diallo', matoto.id),
  );
  await approveTransfer(t6.transfer.id, 'refuse', asUser(gerantKal, 'Mariama Bangoura', kaloum.id), 'Stock insuffisant à Kaloum');
  const t7 = await createTransfer(
    { sourceStoreId: hq.id, destinationStoreId: kaloum.id, reason: 'Erreur de saisie', items: [{ productId: paint, quantity: 5 }], submit: false },
    asUser(gerantKal, 'Mariama Bangoura', kaloum.id),
  );
  await cancelTransfer(t7.transfer.id, asUser(gerantKal, 'Mariama Bangoura', kaloum.id), 'Demande saisie en double');
  report.transfers += 4;

  // Inventaire en cours (comptage partiel) à Matoto.
  const openInv = await openInventory(
    { categoryId: categoryIds.get('Peinture') ?? null, notes: 'Comptage mensuel en cours' },
    { id: gerantMat, name: 'Thierno Diallo', storeId: matoto.id },
  );
  const openInvDetail = await getInventory(openInv);
  if (openInvDetail && openInvDetail.items.length > 0) {
    await recordCounts(
      openInv,
      [{ itemId: openInvDetail.items[0].id, countedQuantity: openInvDetail.items[0].expectedQuantity, justification: null }],
      { id: gerantMat, name: 'Thierno Diallo', storeId: matoto.id },
    );
  }
  report.inventories += 1;

  // Ventes : deux brouillons (ni stock ni caisse) et trois annulations.
  for (const [store, seller] of [[kaloum, vendeurKal], [matoto, vendeurMat]] as const) {
    const product = PRODUCTS[6];
    await createSalesInvoice({
      storeId: store.id,
      customerId: customerIds[2],
      date: today(),
      status: 'draft',
      paymentMethod: 'Espèces',
      amountPaid: 0,
      lines: [{ productId: productIds.get(product.name)!, quantity: 2, unitPrice: product.salePrice }],
      userId: seller,
      notes: 'Devis en attente de confirmation du client',
    } as any);
    report.sales += 1;
  }
  const toCancel = await rawAll<{ id: number; store_id: number }>(
    `SELECT id, store_id FROM sales_invoices WHERE status = 'active' AND store_id IN (?, ?)
      ORDER BY date DESC LIMIT 3 OFFSET 5`,
    [kaloum.id, matoto.id],
  );
  for (const sale of toCancel) {
    await cancelSalesInvoice(Number(sale.id), 'Erreur de caisse, vente ressaisie', {
      id: adminRef.id,
      name: adminRef.name,
      storeId: Number(sale.store_id),
    });
  }
  /*
   * Achat annulé : on en choisit un dont la marchandise est **encore en stock**.
   * Annuler un achat déjà revendu aboutit aussi (dérogation documentée dans
   * `cancelPurchaseInvoice`), mais laisserait un stock négatif dans la
   * démonstration — constaté en recette sur « Ensemble salon complet ».
   */
  const recentPurchases = await rawAll<{ id: number; store_id: number }>(
    `SELECT id, store_id FROM purchase_invoices WHERE status = 'active' AND store_id = ? ORDER BY date DESC LIMIT 10`,
    [matoto.id],
  );
  for (const purchase of recentPurchases) {
    const lines = await rawAll<{ product_id: number; quantity: number }>(
      `SELECT product_id, quantity FROM purchase_invoice_items WHERE invoice_id = ?`,
      [purchase.id],
    );
    let coverable = true;
    for (const line of lines) {
      if ((await getStoreStock(matoto.id, Number(line.product_id))) < Number(line.quantity)) coverable = false;
    }
    if (!coverable) continue;
    await cancelPurchaseInvoice(Number(purchase.id), 'Livraison refusée (marchandise non conforme)', {
      id: adminRef.id,
      name: adminRef.name,
      storeId: Number(purchase.store_id),
    });
    break;
  }

  /*
   * Dépenses soumises à approbation : un seuil de démonstration est posé s'il
   * n'y en a pas, puis trois dépenses au-dessus du seuil, saisies par des
   * vendeurs, finissent en attente, à décaisser et rejetée.
   */
  if (!(Number((await getSettings()).expenseApprovalThreshold) > 0)) {
    await updateSettings({ expenseApprovalThreshold: 2_000_000 });
  }
  const bigExpense = (storeId: number, userId: number, category: string, amount: number, description: string) =>
    createExpense({ storeId, category, amount, date: today(), description, userId, canSkipApproval: false });
  await bigExpense(kaloum.id, vendeurKal, 'Transport', 2_800_000, 'Location d’un camion pour une livraison');
  const toPay = await bigExpense(matoto.id, vendeurMat, 'Électricité', 3_400_000, 'Réparation du groupe électrogène');
  await decideExpense(toPay.id, 'approve', { userId: gerantMat, payNow: false, activeStoreId: matoto.id });
  const rejected = await bigExpense(kaloum.id, vendeurKal, 'Autre', 4_500_000, 'Achat d’un climatiseur');
  await decideExpense(rejected.id, 'reject', { userId: gerantKal, reason: 'Non prévu au budget', activeStoreId: kaloum.id });
  report.expenses += 3;

  /* ---------------- Clôture des caisses des magasins ------------------ */
  for (const store of [kaloum, matoto]) {
    const session = await getOpenSession(store.id);
    if (!session) continue;
    const theoretical = await getSessionTheoreticalByMethod(session.id);
    await closeSession({
      storeId: store.id,
      sessionId: session.id,
      countedByMethod: Object.fromEntries(theoretical.map((t) => [t.method, t.theoretical])),
      userId: adminRef.id,
      notes: 'Clôture de démonstration',
    });
  }

  report.message =
    `Démonstration créée : ${report.stores} magasin(s), ${report.users} compte(s) (mot de passe « demo1234 »), ` +
    `${report.products} produits, ${report.sales} ventes, ${report.purchases} achats, ${report.expenses} dépenses, ` +
    `${report.transfers} transferts, ${report.inventories} inventaire, ${report.serviceJobs} chantiers.`;
  return report;
}

/** Comptage rapide (tests). */
export async function countDemoRows(): Promise<Record<string, number>> {
  const row = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM stores)         AS stores,
       (SELECT COUNT(*) FROM products)       AS products,
       (SELECT COUNT(*) FROM customers)      AS customers,
       (SELECT COUNT(*) FROM sales_invoices) AS sales,
       (SELECT COUNT(*) FROM stock_transfers) AS transfers`,
  );
  return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v ?? 0)]));
}
