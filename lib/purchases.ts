/**
 * Achats (§5, §7.5, §14).
 *
 * Chaîne d'enregistrement (README §7.5 et §14) :
 *   1. validation : **fournisseur obligatoire**, au moins une ligne, quantités > 0,
 *      prix d'achat ≥ 0 ;
 *   2. numérotation sans trou (`ACH-2026-000001`, compteur `settings`) ;
 *   3. insertion de la facture puis de ses lignes (**instantanés** `product_name`,
 *      `unit` figés : une facture d'achat ancienne doit rester
 *      imprimable même si le produit est renommé ou désactivé) ;
 *   4. mouvements de stock : un `entry` par ligne, via `lib/stock.ts` ;
 *   5. décaissement initial via `createPayment` (caisse **et** reçu numéroté) ;
 *   6. journal d'actions (`writeAudit`) — **une seule fois**, ici.
 *
 * ## Achats ≠ Dépenses (§14) — la distinction structurante
 *
 * | | Achats (ce module) | Dépenses (`lib/expenses.ts`) |
 * |---|---|---|
 * | Nature | Marchandises revendues | Frais de fonctionnement |
 * | Fournisseur | **Obligatoire** | Optionnel |
 * | Lignes produits | Oui (quantités, prix d'achat) | Non |
 * | **Stock** | **Mis à jour (entrées)** | Jamais touché |
 * | **Caisse** | Sortie si payé ou acompte | Sortie systématique |
 * | Dettes | Dette fournisseur suivie | — |
 *
 * ## Invariants
 *
 *  - **aucune suppression physique** : l'annulation est un statut (`cancelled`)
 *    avec motif, auteur et date (§14, §26.13) ;
 *  - `products.stock` n'est **jamais** écrit ici : tout passe par
 *    `addStockMovement()` (§6.5 règle 4) ;
 *  - `amount_paid` / `remaining_amount` / `payment_status` sont recalculés depuis
 *    la somme réelle des `payments` (`recomputeDocumentPayments`) ;
 *  - **contrairement à une vente, on ne refuse pas l'entrée pour cause de
 *    stock** : un achat *augmente* le stock. Le contrôle de rupture ne concerne
 *    que les sorties (`buildPurchaseItems` ne fait donc aucun contrôle de stock) ;
 *  - les agrégats de dettes de `lib/suppliers.ts` lisent `purchase_invoices`
 *    (`SUM(total)`, `SUM(amount_paid)`, `SUM(remaining_amount)` sur
 *    `status = 'active'`) : ce module produit exactement ces colonnes.
 */

import { db, rawAll, rawGet } from '@/db';
import { purchaseInvoices, purchaseInvoiceItems } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError, ValidationError, businessDate, toInt, toNumber } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { addCashMovement } from '@/lib/caisse';
import { resolvePeriod, type PeriodKey, type SnapshotPeriod } from '@/lib/dashboard';
import { formatCurrency, roundMoney } from '@/lib/format';
import {
  createPayment,
  getPaymentSchedule,
  listPayments,
  recomputeDocumentPayments,
  type PaymentRow,
} from '@/lib/payments';
import { getProduct } from '@/lib/products';
import { nextDocumentNumber } from '@/lib/settings';
import { addStockMovement } from '@/lib/stock';
import { enqueueSyncWrite } from '@/lib/sync';

/* ------------------------------------------------------------------ *
 * Types exposés (contrat d'API — ne pas renommer les champs)
 * ------------------------------------------------------------------ */

export type PurchaseInvoiceRow = {
  id: number;
  reference: string;
  supplierReference: string | null;
  supplierId: number | null;
  supplierName: string;
  userId: number | null;
  userName: string | null;
  date: string;
  dueDate: string | null;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  status: 'active' | 'cancelled';
  cancelReason: string | null;
  notes: string | null;
  itemCount: number;
  createdAt: Date | null;
};

export type PurchaseInvoiceItemRow = {
  id: number;
  invoiceId: number;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type PurchaseLineInput = {
  productId: number;
  quantity: number;
  unitPrice: number;
};

export type PurchaseInvoiceInput = {
  supplierId: number;
  supplierReference?: string | null;
  date: string;
  dueDate?: string | null;
  paymentMethod?: string;
  amountPaid?: number;
  notes?: string | null;
  lines: PurchaseLineInput[];
  userId?: number | null;
};

/** Ligne validée : instantanés + montant calculé (pas de remise : §6.3). */
export type PurchaseItemDraft = {
  productId: number;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type PaymentSchedule = Awaited<ReturnType<typeof getPaymentSchedule>>;

export type PurchaseInvoiceDetail = {
  invoice: PurchaseInvoiceRow;
  items: PurchaseInvoiceItemRow[];
  payments: PaymentRow[];
  schedule: PaymentSchedule;
};

export type PurchaseStats = {
  period: SnapshotPeriod;
  count: number;
  totalAmount: number;
  paid: number;
  outstanding: number;
  averageBasket: number;
  cancelledCount: number;
  bySupplier: { supplierName: string; count: number; total: number }[];
};

export type PurchasesSummary = {
  totalPurchases: number;
  activeCount: number;
  cancelledCount: number;
  totalAmount: number;
  totalPaid: number;
  totalOutstanding: number;
};

/** Référence utilisateur minimale (audit + mouvements). */
export type PurchaseUserRef = { id: number; name?: string } | null;

const STATUSES: PurchaseInvoiceRow['status'][] = ['active', 'cancelled'];
const PERIOD_KEYS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];
const MAX_BY_SUPPLIER = 20;
/** Tolérance de comparaison des quantités (real en base). */
const EPSILON = 0.0001;
/** Libellé de repli quand le fournisseur n'a pas de fiche rattachée. */
const SUPPLIER_FALLBACK = 'Fournisseur';

/* ------------------------------------------------------------------ *
 * Utilitaires internes
 * ------------------------------------------------------------------ */

const INVOICE_COLUMNS = `
  a.id, a.reference, a.supplier_reference, a.supplier_id, a.user_id, a.date, a.due_date,
  a.total, a.amount_paid, a.remaining_amount, a.payment_status, a.payment_method, a.status,
  a.cancel_reason, a.cancelled_by, a.cancelled_at, a.notes, a.created_at, a.sync_id,
  COALESCE(f.name, ?) AS supplier_name,
  u.name AS user_name,
  (SELECT COUNT(*) FROM purchase_invoice_items i WHERE i.invoice_id = a.id) AS item_count
`;

const INVOICE_FROM = `
  FROM purchase_invoices a
  LEFT JOIN suppliers f ON f.id = a.supplier_id
  LEFT JOIN users u ON u.id = a.user_id
`;

function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Nombre lisible dans un message d'erreur (pas de séparateur de milliers). */
function plainNumber(value: number): string {
  return String(roundQty(value));
}

function mapInvoiceRow(row: any): PurchaseInvoiceRow {
  return {
    id: Number(row.id),
    reference: row.reference,
    supplierReference: row.supplier_reference ?? null,
    supplierId: row.supplier_id == null ? null : Number(row.supplier_id),
    // Le nom du fournisseur est joint à la lecture (pas d'instantané : la fiche
    // fournisseur n'est jamais supprimée, seulement désactivée — §7.3).
    supplierName: String(row.supplier_name ?? SUPPLIER_FALLBACK),
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name ?? null,
    date: row.date,
    dueDate: row.due_date ?? null,
    total: Number(row.total ?? 0),
    amountPaid: Number(row.amount_paid ?? 0),
    remainingAmount: Number(row.remaining_amount ?? 0),
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    status: row.status as PurchaseInvoiceRow['status'],
    cancelReason: row.cancel_reason ?? null,
    notes: row.notes ?? null,
    itemCount: Number(row.item_count ?? 0),
    // `created_at` est stocké en secondes (mode timestamp Drizzle), comme dans
    // `lib/sales.ts` et `lib/customers.ts`.
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

function mapItemRow(row: any): PurchaseInvoiceItemRow {
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    productId: row.product_id == null ? null : Number(row.product_id),
    productName: row.product_name,
    unit: row.unit,
    quantity: Number(row.quantity ?? 0),
    unitPrice: Number(row.unit_price ?? 0),
    amount: Number(row.amount ?? 0),
  };
}

function normalizeStatus(
  value: unknown,
  fallback: PurchaseInvoiceRow['status'],
): PurchaseInvoiceRow['status'] {
  if (value === undefined || value === null || value === '') return fallback;
  const status = String(value) as PurchaseInvoiceRow['status'];
  if (!STATUSES.includes(status)) {
    throw new ValidationError('Statut invalide : attendu « active »');
  }
  // `purchase_invoices.status` n'a que deux valeurs : un achat *est* un
  // document validé (pas de brouillon, contrairement aux ventes — §6.3).
  if (status === 'cancelled') {
    throw new ValidationError(
      'Statut invalide : un achat se crée ou se modifie en « active » (l’annulation passe par DELETE /api/achats/[id])',
    );
  }
  return 'active';
}

/** Nom de l'auteur, pour le journal d'actions (jamais d'« id » affiché). */
async function auditUser(userId?: number | null): Promise<{ id: number; name: string } | null> {
  if (!userId) return null;
  const row = await rawGet<{ name: string }>('SELECT name FROM users WHERE id = ?', [userId]);
  return { id: userId, name: row?.name ?? 'Système' };
}

/** Fournisseur **obligatoire** (§14) : contrairement à une dépense. */
async function resolveSupplier(
  supplierId: unknown,
): Promise<{ supplierId: number; supplierName: string }> {
  const id = toInt(supplierId, 0);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError('Le fournisseur est obligatoire pour un achat');
  }

  const row = await rawGet<{ id: number; name: string }>('SELECT id, name FROM suppliers WHERE id = ?', [
    id,
  ]);
  if (!row) throw new ValidationError('Fournisseur introuvable');

  return { supplierId: Number(row.id), supplierName: String(row.name ?? SUPPLIER_FALLBACK) };
}

type InvoiceRecord = {
  id: number;
  syncId: string;
  reference: string;
  status: PurchaseInvoiceRow['status'];
  supplierId: number | null;
  supplierName: string;
  amountPaid: number;
  paymentMethod: string;
  date: string;
  total: number;
};

async function getInvoiceRecord(id: number): Promise<InvoiceRecord | null> {
  const row = await rawGet<any>(
    `SELECT a.id, a.sync_id, a.reference, a.status, a.supplier_id, a.amount_paid,
            a.payment_method, a.date, a.total, COALESCE(f.name, ?) AS supplier_name
     FROM purchase_invoices a
     LEFT JOIN suppliers f ON f.id = a.supplier_id
     WHERE a.id = ?`,
    [SUPPLIER_FALLBACK, id],
  );
  if (!row) return null;

  return {
    id: Number(row.id),
    syncId: row.sync_id,
    reference: row.reference,
    status: row.status as PurchaseInvoiceRow['status'],
    supplierId: row.supplier_id == null ? null : Number(row.supplier_id),
    supplierName: String(row.supplier_name ?? SUPPLIER_FALLBACK),
    amountPaid: Number(row.amount_paid ?? 0),
    paymentMethod: row.payment_method,
    date: row.date,
    total: Number(row.total ?? 0),
  };
}

async function getItemRecords(invoiceId: number): Promise<any[]> {
  return rawAll<any>(
    `SELECT id, sync_id, invoice_id, product_id, product_name, unit,
            quantity, unit_price, amount
     FROM purchase_invoice_items
     WHERE invoice_id = ?
     ORDER BY id`,
    [invoiceId],
  );
}

/** Quantités par produit, pour la comparaison « différence par différence ». */
function quantitiesByProduct(
  items: { productId: number | null; quantity: number }[],
): Map<number, number> {
  const map = new Map<number, number>();
  for (const item of items) {
    if (!item.productId) continue;
    map.set(item.productId, roundQty((map.get(item.productId) ?? 0) + Number(item.quantity ?? 0)));
  }
  return map;
}

/**
 * Égalité de deux cartes de quantités : si rien n'a changé, **aucun** mouvement
 * de stock n'est écrit — inutile de rentrer 10 puis de ressortir 10.
 */
export function areQuantityMapsEqual(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [productId, quantity] of a) {
    const other = b.get(productId);
    if (other === undefined || Math.abs(other - quantity) > EPSILON) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * buildPurchaseItems — validation + instantanés (AUCUN contrôle de stock)
 * ------------------------------------------------------------------ */

/**
 * Construit les lignes validées (instantanés `product_name` / `unit`) et calcule
 * le montant de chacune.
 *
 * ⚠️ **Aucun contrôle de stock ici** : un achat *fait entrer* de la marchandise.
 * Le contrôle de rupture de `lib/sales.ts` n'a de sens que pour une sortie ;
 * le reproduire ici refuserait un achat de rupture, ce qui est exactement le
 * contraire de ce qu'on veut.
 *
 * Fonction exportée : la page peut s'en servir pour un contrôle anticipé.
 */
export async function buildPurchaseItems(lines: PurchaseLineInput[]): Promise<PurchaseItemDraft[]> {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('Un achat doit contenir au moins une ligne');
  }

  const drafts: PurchaseItemDraft[] = [];
  const products = new Map<number, Awaited<ReturnType<typeof getProduct>>>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ({} as PurchaseLineInput);
    const position = index + 1;

    const productId = Number(line.productId);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new ValidationError(`Ligne ${position} : le produit est obligatoire`);
    }

    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ValidationError(`Ligne ${position} : la quantité doit être supérieure à zéro`);
    }

    const unitPrice = Number(line.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new ValidationError(`Ligne ${position} : le prix d’achat ne peut pas être négatif`);
    }

    let product = products.get(productId);
    if (!product) {
      product = await getProduct(productId);
      if (!product) {
        throw new ValidationError(`Ligne ${position} : produit introuvable (id ${productId})`);
      }
      products.set(productId, product);
    }

    drafts.push({
      productId,
      productName: product.name,
      unit: product.unit,
      quantity: roundQty(quantity),
      unitPrice: roundMoney(unitPrice),
      amount: roundMoney(quantity * unitPrice),
    });
  }

  return drafts;
}

/** Somme des lignes — `purchase_invoices` ne porte qu'un total (§6.3). */
export function computePurchaseTotal(items: PurchaseItemDraft[]): number {
  return roundMoney(items.reduce((sum, item) => sum + item.amount, 0));
}

/* ------------------------------------------------------------------ *
 * Écriture des lignes (instantanés)
 * ------------------------------------------------------------------ */

function itemPayload(reference: string, item: PurchaseItemDraft): Record<string, unknown> {
  // Règle §11.3 : jamais de référence par `id` local dans un payload de synchro.
  return {
    reference,
    product_name: item.productName,
    unit: item.unit,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    amount: item.amount,
  };
}

async function insertInvoiceItems(
  invoiceId: number,
  reference: string,
  items: PurchaseItemDraft[],
): Promise<void> {
  for (const item of items) {
    const inserted = await db
      .insert(purchaseInvoiceItems)
      .values({
        invoiceId,
        productId: item.productId,
        productName: item.productName,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
      })
      .returning({ id: purchaseInvoiceItems.id, syncId: purchaseInvoiceItems.syncId });

    await enqueueSyncWrite(
      'purchase_invoice_items',
      inserted[0]?.syncId,
      'insert',
      itemPayload(reference, item),
    );
  }
}

/**
 * Réconciliation des lignes lors d'une **modification**.
 *
 * Le contrat de modification reçoit un tableau de lignes **sans identifiant** :
 * on réconcilie donc position par position — les lignes conservées sont mises à
 * jour (leur `sync_id` ne change pas), les nouvelles sont insérées, et seules
 * les lignes surnuméraires sont retirées. Aucune facture d'achat n'est
 * supprimée : ces lignes ne sont que des enfants recréés, et leur retrait part
 * en file de synchronisation (`delete`) pour ne pas ressusciter au prochain pull.
 */
async function reconcileInvoiceItems(
  invoiceId: number,
  reference: string,
  items: PurchaseItemDraft[],
): Promise<void> {
  const existing = await getItemRecords(invoiceId);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const previous = existing[index];

    if (previous) {
      await db
        .update(purchaseInvoiceItems)
        .set({
          productId: item.productId,
          productName: item.productName,
          unit: item.unit,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: item.amount,
          updatedAt: new Date(),
        })
        .where(eq(purchaseInvoiceItems.id, Number(previous.id)));

      await enqueueSyncWrite(
        'purchase_invoice_items',
        previous.sync_id,
        'update',
        itemPayload(reference, item),
      );
      continue;
    }

    const inserted = await db
      .insert(purchaseInvoiceItems)
      .values({
        invoiceId,
        productId: item.productId,
        productName: item.productName,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
      })
      .returning({ id: purchaseInvoiceItems.id, syncId: purchaseInvoiceItems.syncId });

    await enqueueSyncWrite(
      'purchase_invoice_items',
      inserted[0]?.syncId,
      'insert',
      itemPayload(reference, item),
    );
  }

  for (let index = items.length; index < existing.length; index += 1) {
    const surplus = existing[index];
    await db.delete(purchaseInvoiceItems).where(eq(purchaseInvoiceItems.id, Number(surplus.id)));
    await enqueueSyncWrite('purchase_invoice_items', surplus.sync_id, 'delete', {
      reference,
      product_name: surplus.product_name,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Stock — différence par différence (symétrique de `lib/sales.ts`)
 * ------------------------------------------------------------------ */

/**
 * Applique l'**écart** entre les quantités rentrées et les quantités voulues.
 *
 * Un achat se comporte en **miroir** d'une vente : là où une vente sort
 * (`exit`) quand la quantité augmente, un achat **entre** (`entry`). Et là où
 * une vente peut rentrer (`entry`) une correction sans risque, un achat qui
 * diminue doit **sortir** de la marchandise déjà en stock — ce qui peut être
 * impossible si elle est déjà vendue : `InsufficientStockError` remonte alors et
 * `fail()` la traduit en **400** (§4).
 *
 * Aucun mouvement n'est écrit si les deux cartes sont identiques.
 */
async function applyStockDelta(
  invoiceId: number,
  reference: string,
  from: Map<number, number>,
  to: Map<number, number>,
  options: { userId?: number | null },
): Promise<void> {
  if (areQuantityMapsEqual(from, to)) return;

  const productIds = new Set<number>([...from.keys(), ...to.keys()]);

  // Les sorties passent **en premier** : si la correction est impossible faute
  // de stock, on échoue avant d'avoir fait entrer le reste — l'état du stock
  // reste ainsi le plus proche possible de la réalité.
  const ordered = [...productIds].sort((a, b) => {
    const deltaA = roundQty((to.get(a) ?? 0) - (from.get(a) ?? 0));
    const deltaB = roundQty((to.get(b) ?? 0) - (from.get(b) ?? 0));
    return deltaA - deltaB;
  });

  for (const productId of ordered) {
    const delta = roundQty((to.get(productId) ?? 0) - (from.get(productId) ?? 0));
    if (Math.abs(delta) < EPSILON) continue;

    if (delta > 0) {
      await addStockMovement(productId, 'entry', delta, {
        referenceType: 'purchase',
        referenceId: invoiceId,
        motif: `achat ${reference}`,
        userId: options.userId ?? null,
      });
    } else {
      await addStockMovement(productId, 'exit', Math.abs(delta), {
        referenceType: 'purchase',
        referenceId: invoiceId,
        motif: `correction achat ${reference}`,
        userId: options.userId ?? null,
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Liste / détail
 * ------------------------------------------------------------------ */

/**
 * Liste paginée et filtrable (§27.2).
 *
 * Recherche sur la **référence**, la **référence fournisseur** et le **nom du
 * fournisseur**. Chaque ligne expose `itemCount`, `userName` et `supplierName`.
 *
 * Contrat consommé par la modale « Payer une dette » de
 * `components/fournisseurs/fournisseurs-modals.tsx` : `GET /api/achats?supplierId=<id>`
 * doit renvoyer `data[]` avec `id`, `reference`, `remainingAmount`, `status`.
 */
export async function listPurchaseInvoices(
  options: {
    search?: string;
    supplierId?: number;
    from?: string;
    to?: string;
    paymentStatus?: string;
    status?: string;
    page?: number;
    limit?: number;
  } = {},
): Promise<{
  data: PurchaseInvoiceRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (options.search) {
    where.push('(a.reference LIKE ? OR a.supplier_reference LIKE ? OR f.name LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like, like);
  }
  if (options.supplierId) {
    where.push('a.supplier_id = ?');
    args.push(Number(options.supplierId));
  }
  if (options.from) {
    where.push('a.date >= ?');
    args.push(businessDate(options.from, 'date de début'));
  }
  if (options.to) {
    where.push('a.date <= ?');
    args.push(businessDate(options.to, 'date de fin'));
  }
  if (options.paymentStatus && options.paymentStatus !== 'all') {
    where.push('a.payment_status = ?');
    args.push(options.paymentStatus);
  }
  if (options.status && options.status !== 'all') {
    where.push('a.status = ?');
    args.push(options.status);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await rawAll<any>(
    `SELECT ${INVOICE_COLUMNS}
     ${INVOICE_FROM}
     ${whereSql}
     ORDER BY a.date DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [SUPPLIER_FALLBACK, ...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM purchase_invoices a
     LEFT JOIN suppliers f ON f.id = a.supplier_id
     ${whereSql}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapInvoiceRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/**
 * Détail complet d'un achat : en-tête, lignes figées, décaissements et
 * échéancier — un bon d'achat reste consultable et réimprimable (§7.5).
 */
export async function getPurchaseInvoice(id: number): Promise<PurchaseInvoiceDetail | null> {
  const row = await rawGet<any>(
    `SELECT ${INVOICE_COLUMNS} ${INVOICE_FROM} WHERE a.id = ?`,
    [SUPPLIER_FALLBACK, id],
  );
  if (!row) return null;

  const invoice = mapInvoiceRow(row);
  const items = (await getItemRecords(id)).map(mapItemRow);
  const payments = (await listPayments({ type: 'purchase', referenceId: id, limit: 200 })).data;
  const schedule = await getPaymentSchedule('purchase', id);

  return { invoice, items, payments, schedule };
}

/* ------------------------------------------------------------------ *
 * Lecture des entrées d'API
 * ------------------------------------------------------------------ */

/**
 * Normalise le corps JSON d'un POST/PUT (parsing, pas de logique métier).
 *
 * `amountPaid` reste `undefined` quand la clé est absente : la modification peut
 * ainsi distinguer « ne pas toucher aux règlements » de « ramener le règlement à
 * zéro » — exactement comme `lib/sales.ts`.
 */
export function parsePurchaseInput(body: any): PurchaseInvoiceInput {
  const rawLines = Array.isArray(body?.lines) ? body.lines : [];
  if (rawLines.length === 0) {
    throw new ValidationError('Un achat doit contenir au moins une ligne');
  }

  // `purchase_invoices` n'a que deux statuts : un achat est un document validé
  // (pas de brouillon, contrairement aux ventes). Le statut reçu est donc
  // **validé** puis ignoré — `normalizeStatus` lève si la valeur est
  // inacceptable, ce qui évite d'accepter « cancelled » par un PUT.
  if (body?.status !== undefined && body?.status !== null && body?.status !== '') {
    normalizeStatus(body.status, 'active');
  }

  const supplierId = toInt(body?.supplierId, 0);
  if (supplierId <= 0) {
    throw new ValidationError('Le fournisseur est obligatoire pour un achat');
  }

  const supplierReference =
    body?.supplierReference === undefined || body?.supplierReference === null
      ? null
      : String(body.supplierReference).trim() || null;

  return {
    supplierId,
    supplierReference,
    date: businessDate(body?.date, 'date'),
    dueDate: body?.dueDate ? businessDate(body.dueDate, 'échéance') : null,
    paymentMethod: body?.paymentMethod ? String(body.paymentMethod) : 'Espèces',
    amountPaid:
      body?.amountPaid === undefined || body?.amountPaid === null || body?.amountPaid === ''
        ? undefined
        : toNumber(body.amountPaid, 0),
    notes: body?.notes ?? null,
    lines: rawLines.map((line: any) => ({
      productId: toInt(line?.productId, 0),
      quantity: toNumber(line?.quantity, 0),
      unitPrice: toNumber(line?.unitPrice, 0),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Création (§7.5)
 * ------------------------------------------------------------------ */

export async function createPurchaseInvoice(input: PurchaseInvoiceInput): Promise<PurchaseInvoiceRow> {
  // 1. Validation : fournisseur obligatoire (existence vérifiée), lignes
  //    valides, quantités > 0, prix ≥ 0. **Aucun contrôle de stock** : un achat
  //    augmente le stock.
  const supplier = await resolveSupplier(input.supplierId);
  const items = await buildPurchaseItems(input.lines);

  const date = businessDate(input.date, 'date');
  const dueDate = input.dueDate ? businessDate(input.dueDate, 'échéance') : null;
  const paymentMethod = String(input.paymentMethod ?? '').trim() || 'Espèces';
  const total = computePurchaseTotal(items);

  // Le décaissement initial est validé **avant** toute écriture : un achat ne
  // doit pas rester à moitié enregistré parce que le montant avancé était
  // incohérent (`createPayment` refuserait un montant supérieur au reste à payer).
  const amountPaid = roundMoney(Math.max(0, Number(input.amountPaid ?? 0) || 0));
  if (amountPaid > total + 0.01) {
    throw new ValidationError(
      `Le montant payé (${formatCurrency(amountPaid)}) ne peut pas dépasser le total de l’achat (${formatCurrency(total)})`,
    );
  }

  // 2. Numérotation (compteur `settings`, sans trou) → ACH-2026-000001.
  const reference = await nextDocumentNumber('purchase');

  // 3. Facture, puis lignes avec instantanés.
  const inserted = await db
    .insert(purchaseInvoices)
    .values({
      reference,
      supplierReference: input.supplierReference?.trim() || null,
      supplierId: supplier.supplierId,
      userId: input.userId ?? null,
      date,
      dueDate,
      total,
      amountPaid: 0,
      remainingAmount: total,
      paymentStatus: 'unpaid',
      paymentMethod,
      status: 'active',
      notes: input.notes?.trim() || null,
    })
    .returning({ id: purchaseInvoices.id, syncId: purchaseInvoices.syncId });

  const invoiceId = Number(inserted[0].id);

  await enqueueSyncWrite('purchase_invoices', inserted[0].syncId, 'insert', {
    reference,
    supplier_reference: input.supplierReference?.trim() || null,
    supplier_id: supplier.supplierId,
    date,
    due_date: dueDate,
    total,
    payment_method: paymentMethod,
    status: 'active',
    notes: input.notes ?? null,
  });

  await insertInvoiceItems(invoiceId, reference, items);

  // 4. Entrées de stock, un `entry` par ligne (motif explicite).
  for (const item of items) {
    await addStockMovement(item.productId, 'entry', item.quantity, {
      referenceType: 'purchase',
      referenceId: invoiceId,
      motif: `achat ${reference} : ${item.productName}`,
      userId: input.userId ?? null,
    });
  }

  // 5. Décaissement initial : `createPayment` gère la **sortie de caisse** et le
  //    **reçu** (§13, §15). La facture doit exister avant (il lui faut son id).
  if (amountPaid > 0) {
    await createPayment({
      type: 'purchase',
      referenceId: invoiceId,
      amount: amountPaid,
      paymentMethod,
      date,
      notes: `Règlement initial — achat ${reference}`,
      userId: input.userId ?? null,
    });
  }

  // 6. Journal d'actions — une seule fois, ici comme dans `lib/sales.ts`.
  await writeAudit({
    user: await auditUser(input.userId),
    action: 'create',
    entity: 'purchase_invoice',
    entityId: invoiceId,
    details: {
      reference,
      supplierName: supplier.supplierName,
      total,
      amountPaid,
      paymentStatus: amountPaid > 0 ? (amountPaid >= total - 0.01 ? 'paid' : 'partial') : 'unpaid',
      lines: items.length,
    },
  });

  const created = await getPurchaseInvoice(invoiceId);
  if (!created) throw new Error('Achat créé mais introuvable');
  return created.invoice;
}

/* ------------------------------------------------------------------ *
 * Modification (§7.5)
 * ------------------------------------------------------------------ */

/**
 * Modification d'un achat.
 *
 * Le total est recalculé, le stock est ajusté **par différence** (aucun
 * mouvement inutile si une quantité n'a pas changé), et les règlements ne sont
 * jamais supprimés : on n'ajoute que le complément.
 *
 * `amountPaid` (règle identique à `lib/sales.ts`) :
 *  - **absent** (`undefined`) → on ne touche pas aux paiements ;
 *  - **supérieur** au déjà-payé → complément via `createPayment` ;
 *  - **inférieur** → 400 : un décaissement enregistré ne se supprime pas, il se
 *    contre-passe en annulant l'achat (jamais de `DELETE`).
 */
export async function updatePurchaseInvoice(
  id: number,
  input: PurchaseInvoiceInput,
): Promise<PurchaseInvoiceRow> {
  const existing = await getInvoiceRecord(id);
  if (!existing) throw new NotFoundError('Achat introuvable');
  if (existing.status === 'cancelled') {
    throw new ValidationError('Un achat annulé ne peut pas être modifié');
  }

  const previousItems = await getItemRecords(id);
  const supplier = await resolveSupplier(input.supplierId ?? existing.supplierId);
  const items = await buildPurchaseItems(input.lines);

  const date = businessDate(input.date, 'date');
  const dueDate = input.dueDate ? businessDate(input.dueDate, 'échéance') : null;
  const paymentMethod = String(input.paymentMethod ?? '').trim() || existing.paymentMethod;
  const total = computePurchaseTotal(items);

  // --- Validations de règlement AVANT toute écriture (pas d'état partiel).
  const currentPaid = roundMoney(existing.amountPaid);
  const targetPaid =
    input.amountPaid === undefined ? null : roundMoney(Math.max(0, Number(input.amountPaid) || 0));

  if (targetPaid !== null && targetPaid > total + 0.01) {
    throw new ValidationError(
      `Le montant payé (${formatCurrency(targetPaid)}) ne peut pas dépasser le total de l’achat (${formatCurrency(total)})`,
    );
  }
  if (targetPaid !== null && targetPaid < currentPaid - 0.01) {
    throw new ValidationError(
      `Le montant payé ne peut pas être réduit (déjà réglé : ${formatCurrency(currentPaid)}). Annulez l’achat pour contre-passer la caisse.`,
    );
  }

  // --- Écritures.
  await db
    .update(purchaseInvoices)
    .set({
      supplierReference: input.supplierReference?.trim() || null,
      supplierId: supplier.supplierId,
      date,
      dueDate,
      total,
      paymentMethod,
      notes: input.notes?.trim() ?? null,
      updatedAt: new Date(),
    })
    .where(eq(purchaseInvoices.id, id));

  await enqueueSyncWrite('purchase_invoices', existing.syncId, 'update', {
    reference: existing.reference,
    supplier_reference: input.supplierReference?.trim() || null,
    supplier_id: supplier.supplierId,
    date,
    due_date: dueDate,
    total,
    payment_method: paymentMethod,
    notes: input.notes ?? null,
  });

  await reconcileInvoiceItems(id, existing.reference, items);

  await applyStockDelta(
    id,
    existing.reference,
    quantitiesByProduct(
      previousItems.map((row) => ({
        productId: row.product_id == null ? null : Number(row.product_id),
        quantity: Number(row.quantity ?? 0),
      })),
    ),
    quantitiesByProduct(items),
    { userId: input.userId ?? null },
  );

  if (targetPaid !== null && targetPaid > currentPaid + 0.01) {
    await createPayment({
      type: 'purchase',
      referenceId: id,
      amount: roundMoney(targetPaid - currentPaid),
      paymentMethod,
      date,
      notes: `Complément de règlement — achat ${existing.reference}`,
      userId: input.userId ?? null,
    });
  }

  // Les montants réglés font toujours foi depuis `payments`.
  await recomputeDocumentPayments('purchase', id);

  await writeAudit({
    user: await auditUser(input.userId),
    action: 'update',
    entity: 'purchase_invoice',
    entityId: id,
    details: {
      reference: existing.reference,
      total,
      lines: items.length,
      amountPaid: targetPaid,
    },
  });

  const updated = await getPurchaseInvoice(id);
  if (!updated) throw new Error('Achat introuvable après modification');
  return updated.invoice;
}

/* ------------------------------------------------------------------ *
 * Annulation — jamais une suppression physique
 * ------------------------------------------------------------------ */

/**
 * Annule un achat : statut `cancelled` + motif + auteur + date, entrées de stock
 * **inversées** (un `exit` par ligne achetée) et décaissements **contre-passés**
 * en caisse (le règlement d'un achat était une sortie → une **entrée** de
 * contre-passation). L'achat reste consultable et réimprimable.
 *
 * ## Décision documentée : achat annulé dont la marchandise est déjà vendue
 *
 * Une annulation peut être demandée alors que la marchandise est déjà sortie
 * (revendue, consommée sur un chantier…). Sortir ces quantités ferait passer le
 * stock en négatif.
 *
 * **Choix retenu : `allowNegative: true`** — l'annulation aboutit toujours.
 *
 * Pourquoi : un `InsufficientStockError` ici laisserait la facture d'achat
 * *active* alors que le fournisseur a bien été remboursé et que l'opération est
 * juridiquement annulée. On obtiendrait un document comptablement faux, un stock
 * faux, et **aucun moyen de sortir de l'état** — l'annulation resterait bloquée
 * pour toujours. Un stock négatif est au contraire un signal **visible et
 * réparable** : il déclenche l'alerte de rupture (§4, §12), il est expliqué par
 * le motif du mouvement (`annulation achat ACH-…`), et l'écran d'inventaire
 * (`adjustStock`, écart signé) permet de le corriger (§6.5 règle 4).
 *
 * La contre-passation de caisse n'est pas conditionnée au stock : elle porte sur
 * les règlements réellement enregistrés, relus depuis `payments`, et sort
 * toujours **après** les mouvements de stock (elle ne peut donc pas réussir en
 * laissant le stock à moitié inversé).
 */
export async function cancelPurchaseInvoice(
  id: number,
  reason: string,
  user: PurchaseUserRef = null,
): Promise<PurchaseInvoiceRow> {
  const cleanReason = String(reason ?? '').trim();
  if (!cleanReason) {
    throw new ValidationError("Le motif d'annulation est obligatoire");
  }

  const existing = await getInvoiceRecord(id);
  if (!existing) throw new NotFoundError('Achat introuvable');
  if (existing.status === 'cancelled') {
    throw new ValidationError('Cet achat est déjà annulé');
  }

  const items = await getItemRecords(id);
  const today = new Date().toISOString().slice(0, 10);

  // Statut `cancelled` d'abord : l'achat ne peut plus être ni modifié ni réglé
  // (`createPayment` refuse un document annulé), donc aucune écriture
  // concurrente ne peut s'intercaler dans l'inversion qui suit.
  await db
    .update(purchaseInvoices)
    .set({
      status: 'cancelled',
      cancelReason: cleanReason,
      cancelledBy: user?.id ?? null,
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(purchaseInvoices.id, id));

  await enqueueSyncWrite('purchase_invoices', existing.syncId, 'update', {
    reference: existing.reference,
    status: 'cancelled',
    cancel_reason: cleanReason,
    cancelled_at: new Date().toISOString(),
  });

  // 1. Inversion du stock : un `exit` par ligne achetée, `allowNegative` assumé
  //    (voir la décision documentée ci-dessus).
  let reversedItems = 0;
  let negativeStockItems: string[] = [];

  for (const item of items) {
    const productId = item.product_id == null ? null : Number(item.product_id);
    const quantity = Number(item.quantity ?? 0);
    if (!productId || quantity <= 0) continue;

    const result = await addStockMovement(productId, 'exit', quantity, {
      referenceType: 'purchase',
      referenceId: id,
      motif: `annulation achat ${existing.reference}`,
      userId: user?.id ?? null,
      allowNegative: true,
    });
    reversedItems += 1;
    if (result.stockAfter < 0) negativeStockItems.push(String(item.product_name ?? productId));
  }

  // 2. Contre-passation de caisse : le règlement d'un achat était une **sortie**,
  //    l'annulation produit donc une **entrée** du montant réellement décaissé.
  const refundedAmount = roundMoney(Number(existing.amountPaid ?? 0));
  if (refundedAmount > 0) {
    await addCashMovement({
      type: 'income',
      amount: refundedAmount,
      paymentMethod: existing.paymentMethod,
      motif: `Contre-passation annulation achat ${existing.reference}`,
      referenceType: 'purchase',
      referenceId: id,
      date: today,
      userId: user?.id ?? null,
    });
  }

  await writeAudit({
    user: user ? { id: user.id, name: user.name ?? 'Système' } : null,
    action: 'cancel',
    entity: 'purchase_invoice',
    entityId: id,
    details: {
      reference: existing.reference,
      reason: cleanReason,
      previousStatus: existing.status,
      reversedItems,
      refundedAmount,
      negativeStock: negativeStockItems,
    },
  });

  const cancelled = await getPurchaseInvoice(id);
  if (!cancelled) throw new Error('Achat introuvable après annulation');
  return cancelled.invoice;
}

/* ------------------------------------------------------------------ *
 * Statistiques (§15 : tout est calculé à la lecture)
 * ------------------------------------------------------------------ */

/** Statistiques d'achats sur une période nommée (`resolvePeriod` de `lib/dashboard.ts`). */
export async function getPurchaseStats(period: PeriodKey = 'month'): Promise<PurchaseStats> {
  const key: PeriodKey = PERIOD_KEYS.includes(period) ? period : 'month';
  const bounds = resolvePeriod(key);

  const totals = await rawGet<any>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(total), 0)            AS total_amount,
            COALESCE(SUM(amount_paid), 0)      AS paid,
            COALESCE(SUM(remaining_amount), 0) AS outstanding
     FROM purchase_invoices
     WHERE status = 'active' AND date >= ? AND date <= ?`,
    [bounds.from, bounds.to],
  );

  const cancelled = await rawGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM purchase_invoices
     WHERE status = 'cancelled' AND date >= ? AND date <= ?`,
    [bounds.from, bounds.to],
  );

  const bySupplierRows = await rawAll<{ supplier_name: string; count: number; total: number }>(
    `SELECT COALESCE(f.name, ?) AS supplier_name,
            COUNT(*)           AS count,
            COALESCE(SUM(a.total), 0) AS total
     FROM purchase_invoices a
     LEFT JOIN suppliers f ON f.id = a.supplier_id
     WHERE a.status = 'active' AND a.date >= ? AND a.date <= ?
     GROUP BY COALESCE(f.name, ?)
     ORDER BY total DESC
     LIMIT ?`,
    [SUPPLIER_FALLBACK, bounds.from, bounds.to, SUPPLIER_FALLBACK, MAX_BY_SUPPLIER],
  );

  const count = Number(totals?.count ?? 0);
  const totalAmount = roundMoney(Number(totals?.total_amount ?? 0));

  return {
    period: bounds,
    count,
    totalAmount,
    paid: roundMoney(Number(totals?.paid ?? 0)),
    outstanding: roundMoney(Number(totals?.outstanding ?? 0)),
    averageBasket: count > 0 ? roundMoney(totalAmount / count) : 0,
    cancelledCount: Number(cancelled?.count ?? 0),
    bySupplier: bySupplierRows.map((row) => ({
      supplierName: String(row.supplier_name ?? SUPPLIER_FALLBACK),
      count: Number(row.count ?? 0),
      total: roundMoney(Number(row.total ?? 0)),
    })),
  };
}

/** Synthèse globale de l'en-tête de page (tous états, toutes périodes). */
export async function getPurchasesSummary(): Promise<PurchasesSummary> {
  const row = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM purchase_invoices) AS total_purchases,
       (SELECT COUNT(*) FROM purchase_invoices WHERE status = 'active')    AS active_count,
       (SELECT COUNT(*) FROM purchase_invoices WHERE status = 'cancelled') AS cancelled_count,
       (SELECT COALESCE(SUM(total), 0) FROM purchase_invoices WHERE status = 'active')            AS total_amount,
       (SELECT COALESCE(SUM(amount_paid), 0) FROM purchase_invoices WHERE status = 'active')      AS total_paid,
       (SELECT COALESCE(SUM(remaining_amount), 0) FROM purchase_invoices WHERE status = 'active') AS total_outstanding`,
  );

  return {
    totalPurchases: Number(row?.total_purchases ?? 0),
    activeCount: Number(row?.active_count ?? 0),
    cancelledCount: Number(row?.cancelled_count ?? 0),
    totalAmount: roundMoney(Number(row?.total_amount ?? 0)),
    totalPaid: roundMoney(Number(row?.total_paid ?? 0)),
    totalOutstanding: roundMoney(Number(row?.total_outstanding ?? 0)),
  };
}

/* ------------------------------------------------------------------ *
 * Libellés (affichage)
 * ------------------------------------------------------------------ */

export const PURCHASE_STATUS_LABELS: Record<PurchaseInvoiceRow['status'], string> = {
  active: 'Actif',
  cancelled: 'Annulé',
};

/** Statut de paiement (§10.4) — repris du projet Gaz et de `lib/sales.ts`. */
export const PURCHASE_PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: 'À payer',
  partial: 'Partiel',
  paid: 'Payé',
};
