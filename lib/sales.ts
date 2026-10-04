/**
 * Ventes (§6, §10).
 *
 * Chaîne d'enregistrement imposée par le README §10.5 :
 *   1. validation des lignes + **vérification du stock AVANT toute écriture** ;
 *   2. numérotation sans trou (`FAC-2026-000001`) ;
 *   3. insertion de la facture puis de ses lignes (**instantanés** figés) ;
 *   4. rattachement du client (nom saisi → fiche existante) ;
 *   5. mouvements de stock (`exit` par ligne, via `lib/stock.ts`) ;
 *   6. encaissement initial via `createPayment` (caisse **et** reçu numéroté) ;
 *   7. journal d'actions.
 *
 * Invariants :
 *  - **aucune suppression physique** d'une facture : l'annulation est un statut
 *    (`cancelled`) avec motif, auteur et date ;
 *  - le stock n'est **jamais** écrit ici : tout passe par `addStockMovement()`,
 *    dans le magasin de la vente ;
 *  - **toute la chaîne s'exécute dans une transaction** : une erreur à la
 *    ligne 3 annule aussi la facture, les lignes 1-2 et l'encaissement ;
 *  - une vente appartient à **un** magasin (`store_id`) : elle ne peut être
 *    modifiée, validée, encaissée ou annulée que depuis ce magasin.
 *  - `amount_paid` / `remaining_amount` / `payment_status` sont recalculés
 *    depuis la somme réelle des `payments` (`recomputeDocumentPayments`) ;
 *  - aucun total n'est inventé en plus de ce que prévoit le schéma (§15).
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { salesInvoices, salesInvoiceItems } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError, ValidationError, businessDate, toInt, toNumber } from '@/lib/api';
import { assertCustomerInStore } from '@/lib/customers';
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
import { type Role, can } from '@/lib/permissions';
import { getSettings, nextDocumentNumber } from '@/lib/settings';
import { addStockMovement, getStoreStock } from '@/lib/stock';
import { getEffectivePermissions } from '@/lib/user-permissions';
import { scopeSql, type StoreScope } from '@/lib/stores';

/* ------------------------------------------------------------------ *
 * Types exposés (contrat d'API — ne pas renommer les champs)
 * ------------------------------------------------------------------ */

/**
 * Canal de vente — un seul canal depuis le retrait de la briqueterie. Le champ
 * est conservé pour la compatibilité des données et de l'API.
 */
export type SalesChannel = 'general';

export const SALES_CHANNELS: SalesChannel[] = ['general'];

export function isSalesChannel(value: unknown): value is SalesChannel {
  return value === 'general';
}

export const SALES_CHANNEL_LABELS: Record<SalesChannel, string> = {
  general: 'Commerce général',
};

export type SalesInvoiceRow = {
  id: number;
  storeId: number | null;
  storeName: string | null;
  invoiceNumber: string;
  customerId: number | null;
  customerName: string;
  userId: number | null;
  userName: string | null;
  date: string;
  dueDate: string | null;
  subTotal: number;
  discount: number;
  totalHt: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  status: 'draft' | 'active' | 'cancelled';
  channel: SalesChannel;
  cancelReason: string | null;
  notes: string | null;
  itemCount: number;
  /**
   * Coût des marchandises vendues, **calculé à la lecture** (somme des
   * quantité × prix d'achat des lignes). `null` hors vente validée.
   *
   * Donnée **financière sensible** : renseignée uniquement pour un rôle qui
   * détient `balances.view` — voir `canViewSalesProfit()`.
   */
  cost: number | null;
  /**
   * Bénéfice de la vente : `totalHt − cost`. `null` hors vente validée (un
   * brouillon n'est pas une vente, une annulation ne laisse aucun bénéfice).
   *
   * Base **HT et après remise globale** : c'est ce qui garantit que la somme
   * des bénéfices par vente retombe exactement sur la marge du §15 affichée
   * dans `/soldes`.
   */
  profit: number | null;
  createdAt: Date | null;
};

export type SalesInvoiceItemRow = {
  id: number;
  invoiceId: number;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  amount: number;
};

export type SalesLineInput = {
  productId: number;
  quantity: number;
  unitPrice: number;
  discount?: number;
};

export type SalesInvoiceInput = {
  customerId?: number | null;
  customerName?: string;
  date: string;
  dueDate?: string | null;
  paymentMethod?: string;
  amountPaid?: number;
  discount?: number;
  taxRate?: number;
  notes?: string | null;
  status?: 'draft' | 'active';
  channel?: SalesChannel;
  lines: SalesLineInput[];
  userId?: number | null;
  /** Magasin actif de l'utilisateur (obligatoire pour écrire). */
  storeId?: number | null;
};

/** Ligne validée par `buildSalesItems` : instantanés + montant calculé. */
export type SalesItemDraft = {
  productId: number;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  amount: number;
};

export type PaymentSchedule = Awaited<ReturnType<typeof getPaymentSchedule>>;

export type SalesInvoiceDetail = {
  invoice: SalesInvoiceRow;
  items: SalesInvoiceItemRow[];
  payments: PaymentRow[];
  schedule: PaymentSchedule;
};

export type SalesStats = {
  period: SnapshotPeriod;
  count: number;
  revenue: number;
  totalHt: number;
  taxAmount: number;
  collected: number;
  outstanding: number;
  averageBasket: number;
  cancelledCount: number;
  topProducts: { productName: string; quantity: number; amount: number }[];
  byDay: { date: string; revenue: number; count: number }[];
};

/** Référence utilisateur minimale (audit + mouvements). */
export type SalesUserRef = { id: number; name?: string; storeId?: number | null } | null;

const STATUSES: SalesInvoiceRow['status'][] = ['draft', 'active', 'cancelled'];
const PERIOD_KEYS: PeriodKey[] = ['day', 'week', 'month', 'year', 'total'];
const MAX_BY_DAY = 366;
const MAX_TOP_PRODUCTS = 10;
/** Tolérance de comparaison des quantités (real en base). */
const EPSILON = 0.0001;

/* ------------------------------------------------------------------ *
 * Utilitaires internes
 * ------------------------------------------------------------------ */

const INVOICE_COLUMNS = `
  v.id, v.store_id, st.name AS store_name, v.invoice_number, v.customer_id, v.customer_name, v.user_id, v.date, v.due_date,
  v.sub_total, v.discount, v.total_ht, v.tax_rate, v.tax_amount, v.total,
  v.amount_paid, v.remaining_amount, v.payment_status, v.payment_method, v.status,
  v.channel, v.cancel_reason, v.cancelled_by, v.cancelled_at, v.notes, v.created_at, v.sync_id,
  u.name AS user_name,
  (SELECT COUNT(*) FROM sales_invoice_items i WHERE i.invoice_id = v.id) AS item_count,
  /*
   * Coût des marchandises vendues, par sous-requête corrélée.
   *
   * Le README §15 fixe la règle : le prix d'achat de la marge est lu sur la
   * colonne purchase_price de products — compromis V1 documenté en Q20,
   * l'instantané du coût sur la ligne étant l'évolution prévue. C'est
   * exactement la source utilisée par computeCogs() de lib/profit.ts, donc
   * le bénéfice par vente est réconcilié avec /soldes, /rapports et le
   * tableau de bord — tous issus de ce même module.
   *
   * Conséquence à connaître : modifier le prix d'achat d'un produit déplace la
   * marge des ventes passées. Ce n'est pas une marge historique figée.
   * (Pas d'accent grave dans ce commentaire : il fermerait le gabarit.)
   */
  (SELECT COALESCE(SUM(i.quantity * COALESCE(p.purchase_price, 0)), 0)
     FROM sales_invoice_items i
     LEFT JOIN products p ON p.id = i.product_id
    WHERE i.invoice_id = v.id) AS cost
`;

const INVOICE_FROM = `
  FROM sales_invoices v
  LEFT JOIN users u ON u.id = v.user_id
  LEFT JOIN stores st ON st.id = v.store_id
`;

function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Nombre lisible dans un message d'erreur (pas de séparateur de milliers). */
function plainNumber(value: number): string {
  return String(roundQty(value));
}

function mapInvoiceRow(row: any): SalesInvoiceRow {
  const totalHt = Number(row.total_ht ?? 0);
  const cost = roundMoney(Number(row.cost ?? 0));
  const status = row.status as SalesInvoiceRow['status'];
  /*
   * Le bénéfice n'a de sens que pour une vente **validée** : un brouillon n'est
   * pas encore une vente, une annulation ne laisse ni chiffre d'affaires ni
   * coût. On renvoie donc `null` plutôt qu'un montant que personne ne devrait
   * additionner.
   */
  const isSale = status === 'active';

  return {
    id: Number(row.id),
    storeId: row.store_id == null ? null : Number(row.store_id),
    storeName: row.store_name ?? null,
    invoiceNumber: row.invoice_number,
    customerId: row.customer_id == null ? null : Number(row.customer_id),
    customerName: row.customer_name,
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name ?? null,
    date: row.date,
    dueDate: row.due_date ?? null,
    subTotal: Number(row.sub_total ?? 0),
    discount: Number(row.discount ?? 0),
    totalHt,
    taxRate: Number(row.tax_rate ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    total: Number(row.total ?? 0),
    amountPaid: Number(row.amount_paid ?? 0),
    remainingAmount: Number(row.remaining_amount ?? 0),
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    status: row.status as SalesInvoiceRow['status'],
    channel: 'general',
    cancelReason: row.cancel_reason ?? null,
    notes: row.notes ?? null,
    itemCount: Number(row.item_count ?? 0),
    cost: isSale ? cost : null,
    profit: isSale ? roundMoney(totalHt - cost) : null,
    // `created_at` est stocké en secondes (mode timestamp Drizzle), comme dans
    // `lib/customers.ts`.
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

function mapItemRow(row: any): SalesInvoiceItemRow {
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    productId: row.product_id == null ? null : Number(row.product_id),
    productName: row.product_name,
    unit: row.unit,
    quantity: Number(row.quantity ?? 0),
    unitPrice: Number(row.unit_price ?? 0),
    discount: Number(row.discount ?? 0),
    amount: Number(row.amount ?? 0),
  };
}

function normalizeStatus(value: unknown, fallback: SalesInvoiceRow['status']): SalesInvoiceRow['status'] {
  if (value === undefined || value === null || value === '') return fallback;
  const status = String(value) as SalesInvoiceRow['status'];
  if (!STATUSES.includes(status)) {
    throw new ValidationError('Statut invalide : attendu « draft » ou « active »');
  }
  return status;
}

/** Nom de l'auteur, pour le journal d'actions (jamais d'« id » affiché). */
async function auditUser(userId?: number | null): Promise<{ id: number; name: string } | null> {
  if (!userId) return null;
  const row = await rawGet<{ name: string }>('SELECT name FROM users WHERE id = ?', [userId]);
  return { id: userId, name: row?.name ?? 'Système' };
}

/**
 * Rattachement du client (§10.5 étape 4).
 * La vente comptoir (`customerId = null`, « Client comptoir ») est valide.
 *
 * Le client doit être **du magasin de la vente** (README §28.5). `keepId` : le
 * client déjà rattaché à la facture modifiée reste accepté tel quel (une
 * facture reprise d'avant le cloisonnement peut viser un client d'un autre
 * magasin).
 */
async function resolveCustomer(input: {
  customerId?: number | null;
  customerName?: string;
  storeId: number;
  keepId?: number | null;
}): Promise<{ customerId: number | null; customerName: string }> {
  const typedName = (input.customerName ?? '').trim();
  const customerId = input.customerId == null ? null : Number(input.customerId);

  if (customerId && Number.isInteger(customerId) && customerId > 0) {
    if (customerId === input.keepId) {
      const row = await rawGet<{ id: number; name: string }>('SELECT id, name FROM customers WHERE id = ?', [customerId]);
      if (!row) throw new ValidationError('Client introuvable');
      return { customerId: row.id, customerName: typedName || row.name };
    }
    const row = await assertCustomerInStore(customerId, input.storeId);
    return { customerId: row.id, customerName: typedName || row.name };
  }

  if (typedName) {
    // Comparaison insensible à la casse et aux espaces superflus, parmi les
    // clients **de ce magasin** seulement.
    const row = await rawGet<{ id: number; name: string }>(
      'SELECT id, name FROM customers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND (store_id = ? OR store_id IS NULL) ORDER BY id LIMIT 1',
      [typedName, input.storeId],
    );
    if (row) return { customerId: row.id, customerName: typedName };
  }

  return { customerId: null, customerName: typedName || 'Client comptoir' };
}

type InvoiceRecord = {
  id: number;
  storeId: number | null;
  syncId: string;
  invoiceNumber: string;
  status: SalesInvoiceRow['status'];
  customerId: number | null;
  customerName: string;
  amountPaid: number;
  taxRate: number;
  paymentMethod: string;
  date: string;
};

async function getInvoiceRecord(id: number): Promise<InvoiceRecord | null> {
  const row = await rawGet<any>(
    `SELECT id, store_id, sync_id, invoice_number, status, customer_id, customer_name,
            amount_paid, tax_rate, payment_method, date
     FROM sales_invoices WHERE id = ?`,
    [id],
  );
  if (!row) return null;

  return {
    id: Number(row.id),
    storeId: row.store_id == null ? null : Number(row.store_id),
    syncId: row.sync_id,
    invoiceNumber: row.invoice_number,
    status: row.status as SalesInvoiceRow['status'],
    customerId: row.customer_id == null ? null : Number(row.customer_id),
    customerName: row.customer_name,
    amountPaid: Number(row.amount_paid ?? 0),
    taxRate: Number(row.tax_rate ?? 0),
    paymentMethod: row.payment_method,
    date: row.date,
  };
}

/**
 * Cloisonnement (§5) : une facture ne se modifie que depuis **son** magasin.
 * Renvoie le magasin de la facture.
 */
function assertSameStore(record: { storeId: number | null }, storeId: number | null | undefined): number {
  if (!storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');
  if (record.storeId !== Number(storeId)) {
    throw new ValidationError(
      'Cette facture appartient à un autre magasin : elle ne peut être modifiée que depuis ce magasin.',
    );
  }
  return Number(storeId);
}

async function getItemRecords(invoiceId: number): Promise<any[]> {
  return rawAll<any>(
    `SELECT id, sync_id, invoice_id, product_id, product_name, unit,
            quantity, unit_price, discount, amount
     FROM sales_invoice_items
     WHERE invoice_id = ?
     ORDER BY id`,
    [invoiceId],
  );
}

/** Quantités demandées par produit, pour la comparaison « différence par différence ». */
function quantitiesByProduct(items: { productId: number | null; quantity: number }[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const item of items) {
    if (!item.productId) continue;
    map.set(item.productId, roundQty((map.get(item.productId) ?? 0) + Number(item.quantity ?? 0)));
  }
  return map;
}

/**
 * Égalité de deux cartes de quantités (équivalent de `areQuantityMapsEqual` du
 * projet Gaz) : si rien n'a changé, **aucun** mouvement de stock n'est écrit —
 * inutile de sortir 10 puis de rentrer 10.
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
 * buildSalesItems — validation + instantanés + contrôle de stock
 * ------------------------------------------------------------------ */

/**
 * Construit les lignes validées (instantanés `product_name` / `unit`) et
 * **vérifie le stock**.
 *
 * Le contrôle est volontairement **agrégé** : toutes les ruptures sont listées
 * dans une seule erreur, au format attendu par le front (§10.5 étape 1) :
 * `Stock insuffisant pour créer la vente : • Placo BA13 : stock insuffisant
 * (disponible: 10, demandé: 15)` — plusieurs produits séparés par ` • `.
 *
 * `options.allowances` sert à la **modification** : une facture déjà active a
 * déjà sorti ses quantités du stock, il faut donc les considérer comme encore
 * disponibles pour ne pas refuser une correction légitime.
 *
 * Fonction exportée : la page peut s'en servir pour un contrôle anticipé.
 */
export async function buildSalesItems(
  lines: SalesLineInput[],
  options: { storeId: number; allowances?: Record<number, number> },
): Promise<SalesItemDraft[]> {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('Une vente doit contenir au moins une ligne');
  }

  const drafts: SalesItemDraft[] = [];
  const requested = new Map<number, number>();
  const products = new Map<number, Awaited<ReturnType<typeof getProduct>>>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ({} as SalesLineInput);
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
      throw new ValidationError(`Ligne ${position} : le prix unitaire ne peut pas être négatif`);
    }

    const discount = Number(line.discount ?? 0);
    if (!Number.isFinite(discount) || discount < 0) {
      throw new ValidationError(`Ligne ${position} : la remise ne peut pas être négative`);
    }

    const gross = roundMoney(quantity * unitPrice);
    if (discount - gross > EPSILON) {
      throw new ValidationError(
        `Ligne ${position} : la remise (${formatCurrency(discount)}) ne peut pas dépasser le montant de la ligne (${formatCurrency(gross)})`,
      );
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
      discount: roundMoney(discount),
      amount: roundMoney(gross - discount),
    });

    requested.set(productId, roundQty((requested.get(productId) ?? 0) + quantity));
  }

  const shortages: string[] = [];
  for (const [productId, quantity] of requested) {
    const product = products.get(productId);
    if (!product) continue;
    const inStore = await getStoreStock(options.storeId, productId);
    const available = roundQty(inStore + Number(options.allowances?.[productId] ?? 0));
    if (quantity - available > EPSILON) {
      shortages.push(
        `• ${product.name} : stock insuffisant (disponible: ${plainNumber(available)}, demandé: ${plainNumber(quantity)})`,
      );
    }
  }

  if (shortages.length > 0) {
    throw new ValidationError(
      `Stock insuffisant pour créer la vente : ${shortages.join(' • ')}`,
    );
  }

  return drafts;
}

/* ------------------------------------------------------------------ *
 * Totaux (§10.3)
 * ------------------------------------------------------------------ */

export type SalesTotals = {
  subTotal: number;
  discount: number;
  totalHt: number;
  taxRate: number;
  taxAmount: number;
  total: number;
};

function computeTotals(
  items: SalesItemDraft[],
  input: { discount?: number; taxRate?: number },
): SalesTotals {
  const subTotal = roundMoney(items.reduce((sum, item) => sum + item.amount, 0));

  const discount = roundMoney(Number(input.discount ?? 0) || 0);
  if (discount < 0) throw new ValidationError('La remise globale ne peut pas être négative');
  if (discount - subTotal > EPSILON) {
    throw new ValidationError(
      `La remise globale (${formatCurrency(discount)}) ne peut pas dépasser le sous-total (${formatCurrency(subTotal)})`,
    );
  }

  const taxRate = Number(input.taxRate ?? 0) || 0;
  if (taxRate < 0 || taxRate > 100) {
    throw new ValidationError('Le taux de TVA doit être compris entre 0 et 100');
  }

  const totalHt = roundMoney(subTotal - discount);
  const taxAmount = roundMoney((totalHt * taxRate) / 100);
  const total = roundMoney(totalHt + taxAmount);

  return { subTotal, discount, totalHt, taxRate, taxAmount, total };
}

/* ------------------------------------------------------------------ *
 * Écriture des lignes (instantanés)
 * ------------------------------------------------------------------ */

async function insertInvoiceItems(
  invoiceId: number,
  invoiceNumber: string,
  items: SalesItemDraft[],
): Promise<void> {
  for (const item of items) {
    const inserted = await db
      .insert(salesInvoiceItems)
      .values({
        invoiceId,
        productId: item.productId,
        productName: item.productName,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        amount: item.amount,
      })
      .returning({ id: salesInvoiceItems.id, syncId: salesInvoiceItems.syncId });

  }
}

/**
 * Réconciliation des lignes lors d'une **modification**.
 *
 * Le contrat de modification reçoit un tableau de lignes **sans identifiant** :
 * on réconcilie donc position par position — les lignes conservées sont mises à
 * jour (leur `sync_id` ne change pas), les nouvelles sont insérées, et seules
 * les lignes surnuméraires sont retirées. Aucune facture n'est supprimée : ces
 * lignes ne sont que des enfants recréés, et leur retrait est mis en file de
 * synchronisation (`delete`) pour ne pas ressusciter au prochain pull.
 */
async function reconcileInvoiceItems(
  invoiceId: number,
  invoiceNumber: string,
  items: SalesItemDraft[],
): Promise<void> {
  const existing = await getItemRecords(invoiceId);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const previous = existing[index];

    if (previous) {
      await db
        .update(salesInvoiceItems)
        .set({
          productId: item.productId,
          productName: item.productName,
          unit: item.unit,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount,
          amount: item.amount,
          updatedAt: new Date(),
        })
        .where(eq(salesInvoiceItems.id, Number(previous.id)));
      continue;
    }

    const inserted = await db
      .insert(salesInvoiceItems)
      .values({
        invoiceId,
        productId: item.productId,
        productName: item.productName,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        amount: item.amount,
      })
      .returning({ id: salesInvoiceItems.id, syncId: salesInvoiceItems.syncId });

  }

  for (let index = items.length; index < existing.length; index += 1) {
    const surplus = existing[index];
    await db.delete(salesInvoiceItems).where(eq(salesInvoiceItems.id, Number(surplus.id)));
  }
}

/* ------------------------------------------------------------------ *
 * Stock — différence par différence
 * ------------------------------------------------------------------ */

/**
 * Applique l'**écart** entre les quantités sorties et les quantités voulues.
 * Aucun mouvement n'est écrit si les deux cartes sont identiques.
 */
async function applyStockDelta(
  invoiceId: number,
  from: Map<number, number>,
  to: Map<number, number>,
  options: { storeId: number; userId?: number | null; motifExit: string; motifEntry: string },
): Promise<void> {
  if (areQuantityMapsEqual(from, to)) return;

  const productIds = new Set<number>([...from.keys(), ...to.keys()]);

  for (const productId of productIds) {
    const delta = roundQty((to.get(productId) ?? 0) - (from.get(productId) ?? 0));
    if (Math.abs(delta) < EPSILON) continue;

    if (delta > 0) {
      await addStockMovement(productId, 'exit', delta, {
        storeId: options.storeId,
        referenceType: 'sale',
        referenceId: invoiceId,
        motif: options.motifExit,
        userId: options.userId ?? null,
      });
    } else {
      await addStockMovement(productId, 'entry', Math.abs(delta), {
        storeId: options.storeId,
        referenceType: 'sale',
        referenceId: invoiceId,
        motif: options.motifEntry,
        userId: options.userId ?? null,
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Liste / détail
 * ------------------------------------------------------------------ */

/** Liste paginée et filtrable (§27.2) : recherche sur numéro **et** nom client. */
export async function listSalesInvoices(options: {
  search?: string;
  customerId?: number;
  from?: string;
  to?: string;
  paymentStatus?: string;
  status?: string;
  /** Magasins visibles (obligatoire). */
  scope: StoreScope;
  channel?: SalesChannel | 'all';
  page?: number;
  limit?: number;
}): Promise<{
  data: SalesInvoiceRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [scopeSql('v.store_id', options.scope)];
  const args: (string | number)[] = [];

  if (options.search) {
    where.push('(v.invoice_number LIKE ? OR v.customer_name LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like);
  }
  if (options.customerId) {
    where.push('v.customer_id = ?');
    args.push(Number(options.customerId));
  }
  if (options.from) {
    where.push('v.date >= ?');
    args.push(businessDate(options.from, 'date de début'));
  }
  if (options.to) {
    where.push('v.date <= ?');
    args.push(businessDate(options.to, 'date de fin'));
  }
  if (options.paymentStatus && options.paymentStatus !== 'all') {
    where.push('v.payment_status = ?');
    args.push(options.paymentStatus);
  }
  if (options.status && options.status !== 'all') {
    where.push('v.status = ?');
    args.push(options.status);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await rawAll<any>(
    `SELECT ${INVOICE_COLUMNS}
     ${INVOICE_FROM}
     ${whereSql}
     ORDER BY v.date DESC, v.id DESC
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM sales_invoices v ${whereSql}`,
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
 * Détail complet d'une facture : en-tête, lignes figées, encaissements et
 * échéancier (§7.7 — une facture reste consultable et réimprimable).
 */
export async function getSalesInvoice(id: number): Promise<SalesInvoiceDetail | null> {
  const row = await rawGet<any>(`SELECT ${INVOICE_COLUMNS} ${INVOICE_FROM} WHERE v.id = ?`, [id]);
  if (!row) return null;

  const invoice = mapInvoiceRow(row);
  const items = (await getItemRecords(id)).map(mapItemRow);
  const payments = (
    await listPayments({ scope: invoice.storeId ? [invoice.storeId] : [], type: 'sale', referenceId: id, limit: 200 })
  ).data;
  const schedule = await getPaymentSchedule('sale', id);

  return { invoice, items, payments, schedule };
}

/* ------------------------------------------------------------------ *
 * Lecture des entrées d'API
 * ------------------------------------------------------------------ */

/**
 * Normalise le corps JSON d'un POST/PUT (parsing, pas de logique métier).
 *
 * `amountPaid` et `status` restent `undefined` quand la clé est absente : la
 * modification peut ainsi distinguer « ne pas toucher aux encaissements » de
 * « ramener l'encaissement à zéro ».
 */
export function parseSalesInput(body: any): SalesInvoiceInput {
  const rawLines = Array.isArray(body?.lines) ? body.lines : [];
  if (rawLines.length === 0) {
    throw new ValidationError('Une vente doit contenir au moins une ligne');
  }

  let status: SalesInvoiceInput['status'];
  if (body?.status !== undefined && body?.status !== null && body?.status !== '') {
    const normalized = normalizeStatus(body.status, 'active');
    if (normalized === 'cancelled') {
      throw new ValidationError(
        'Statut invalide : une vente se crée ou se modifie en « draft » ou « active » (l’annulation passe par /annuler)',
      );
    }
    // Réduction explicite : `normalizeStatus` n'est pas une garde de type, donc
    // TypeScript ne peut pas déduire que « cancelled » est écarté ici.
    status = normalized === 'draft' ? 'draft' : 'active';
  }

  return {
    customerId:
      body?.customerId === undefined || body?.customerId === null || body?.customerId === ''
        ? null
        : toInt(body.customerId, 0),
    customerName: body?.customerName ?? '',
    date: businessDate(body?.date, 'date'),
    dueDate: body?.dueDate ? businessDate(body.dueDate, 'échéance') : null,
    paymentMethod: body?.paymentMethod ? String(body.paymentMethod) : 'Espèces',
    amountPaid:
      body?.amountPaid === undefined || body?.amountPaid === null || body?.amountPaid === ''
        ? undefined
        : toNumber(body.amountPaid, 0),
    discount:
      body?.discount === undefined || body?.discount === null || body?.discount === ''
        ? 0
        : toNumber(body.discount, 0),
    taxRate:
      body?.taxRate === undefined || body?.taxRate === null || body?.taxRate === ''
        ? undefined
        : toNumber(body.taxRate, 0),
    notes: body?.notes ?? null,
    status,
    channel: 'general',
    lines: rawLines.map((line: any) => ({
      productId: toInt(line?.productId, 0),
      quantity: toNumber(line?.quantity, 0),
      unitPrice: toNumber(line?.unitPrice, 0),
      discount: toNumber(line?.discount ?? 0, 0),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Création (§10.5)
 * ------------------------------------------------------------------ */

export async function createSalesInvoice(input: SalesInvoiceInput): Promise<SalesInvoiceRow> {
  return withTransaction(() => createSalesInvoiceInTx(input));
}

async function createSalesInvoiceInTx(input: SalesInvoiceInput): Promise<SalesInvoiceRow> {
  const settings = await getSettings();
  const storeId = Number(input.storeId);
  if (!storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');

  // 1 + 2. Validation des lignes et contrôle de stock AVANT toute écriture.
  const items = await buildSalesItems(input.lines, { storeId });

  const date = businessDate(input.date, 'date');
  const status = normalizeStatus(input.status, 'active');
  const channel: SalesChannel = 'general';
  const paymentMethod = String(input.paymentMethod ?? '').trim() || 'Espèces';
  const taxRate = input.taxRate === undefined ? Number(settings.defaultTaxRate ?? 0) : Number(input.taxRate);

  const totals = computeTotals(items, { discount: input.discount, taxRate });

  // L'encaissement est validé **avant** toute écriture : une vente ne doit pas
  // rester à moitié enregistrée parce que le montant reçu était incohérent.
  const amountPaid = roundMoney(Math.max(0, Number(input.amountPaid ?? 0) || 0));
  if (amountPaid > totals.total + 0.01) {
    throw new ValidationError(
      `Le montant encaissé (${formatCurrency(amountPaid)}) ne peut pas dépasser le total à payer (${formatCurrency(totals.total)})`,
    );
  }
  if (status === 'draft' && amountPaid > 0.001) {
    throw new ValidationError(
      'Un brouillon ne peut pas porter d’encaissement : validez la vente ou remettez le montant reçu à zéro',
    );
  }

  const customer = await resolveCustomer({
    customerId: input.customerId,
    customerName: input.customerName,
    storeId,
  });

  // 3. Numérotation (compteur `settings`, sans trou).
  const invoiceNumber = await nextDocumentNumber('invoice', storeId);

  // 4. Facture, puis lignes avec instantanés.
  const inserted = await db
    .insert(salesInvoices)
    .values({
      storeId,
      invoiceNumber,
      customerId: customer.customerId,
      customerName: customer.customerName,
      userId: input.userId ?? null,
      date,
      dueDate: input.dueDate ? businessDate(input.dueDate, 'échéance') : null,
      subTotal: totals.subTotal,
      discount: totals.discount,
      totalHt: totals.totalHt,
      taxRate: totals.taxRate,
      taxAmount: totals.taxAmount,
      total: totals.total,
      amountPaid: 0,
      remainingAmount: totals.total,
      paymentStatus: 'unpaid',
      paymentMethod,
      status,
      channel,
      notes: input.notes?.trim() || null,
    })
    .returning({ id: salesInvoices.id, syncId: salesInvoices.syncId });

  const invoiceId = Number(inserted[0].id);


  await insertInvoiceItems(invoiceId, invoiceNumber, items);

  // Un brouillon ne touche ni le stock ni la caisse (§10.6).
  if (status === 'active') {
    // 5. Sorties de stock, un `exit` par ligne.
    for (const item of items) {
      await addStockMovement(item.productId, 'exit', item.quantity, {
        storeId,
        referenceType: 'sale',
        referenceId: invoiceId,
        motif: `vente ${invoiceNumber}`,
        userId: input.userId ?? null,
      });
    }

    // 6. Encaissement initial : `createPayment` gère la caisse **et** le reçu.
    if (amountPaid > 0) {
      await createPayment({
        storeId,
        type: 'sale',
        referenceId: invoiceId,
        amount: amountPaid,
        paymentMethod,
        date,
        notes: `Encaissement initial — vente ${invoiceNumber}`,
        userId: input.userId ?? null,
      });
    }
  }

  // 7. Journal d'actions — **les deux** statuts sont tracés. Un brouillon
  // consomme un numéro de facture et engage son auteur : le rendre invisible au
  // journal rendrait l'historique menteur (§12).
  await writeAudit({
    user: await auditUser(input.userId),
    storeId,
    action: 'create',
    entity: 'sales_invoice',
    entityId: invoiceId,
    details: {
      invoiceNumber,
      customerName: customer.customerName,
      total: totals.total,
      amountPaid,
      paymentStatus: amountPaid > 0 ? (amountPaid >= totals.total - 0.01 ? 'paid' : 'partial') : 'unpaid',
      status,
      channel,
      lines: items.length,
    },
  });

  const created = await getSalesInvoice(invoiceId);
  if (!created) throw new Error('Facture créée mais introuvable');
  return created.invoice;
}

/* ------------------------------------------------------------------ *
 * Modification (§10.6)
 * ------------------------------------------------------------------ */

/**
 * Modification d'une vente.
 *
 * Les totaux sont recalculés, les mouvements de stock sont ajustés **par
 * différence** (aucun mouvement inutile si une quantité n'a pas changé), et les
 * encaissements ne sont jamais supprimés : on n'ajoute que le complément.
 */
export async function updateSalesInvoice(
  id: number,
  input: SalesInvoiceInput,
): Promise<SalesInvoiceRow> {
  return withTransaction(() => updateSalesInvoiceInTx(id, input));
}

async function updateSalesInvoiceInTx(id: number, input: SalesInvoiceInput): Promise<SalesInvoiceRow> {
  const existing = await getInvoiceRecord(id);
  if (!existing) throw new NotFoundError('Facture introuvable');
  const storeId = assertSameStore(existing, input.storeId);
  if (existing.status === 'cancelled') {
    throw new ValidationError('Une facture annulée ne peut pas être modifiée');
  }

  const previousItems = await getItemRecords(id);
  const wasActive = existing.status === 'active';
  const willBeActive = normalizeStatus(input.status, existing.status) === 'active';

  // Ce qu'une facture active a déjà sorti du stock reste « à elle » : on le
  // rend disponible pour le contrôle, sinon toute correction serait refusée.
  const allowances: Record<number, number> = {};
  if (wasActive) {
    for (const item of previousItems) {
      const productId = item.product_id == null ? null : Number(item.product_id);
      if (!productId) continue;
      allowances[productId] = roundQty((allowances[productId] ?? 0) + Number(item.quantity ?? 0));
    }
  }

  const items = await buildSalesItems(input.lines, { storeId, allowances });
  const date = businessDate(input.date, 'date');
  const paymentMethod = String(input.paymentMethod ?? '').trim() || existing.paymentMethod;
  const totals = computeTotals(items, {
    discount: input.discount ?? 0,
    taxRate: input.taxRate ?? existing.taxRate,
  });
  const customer = await resolveCustomer({
    customerId: input.customerId,
    customerName: input.customerName ?? existing.customerName,
    storeId,
    keepId: existing.customerId,
  });

  // --- Validations d'encaissement AVANT toute écriture (pas d'état partiel).
  const currentPaid = roundMoney(existing.amountPaid);
  const targetPaid =
    input.amountPaid === undefined ? null : roundMoney(Math.max(0, Number(input.amountPaid) || 0));

  if (targetPaid !== null && targetPaid > totals.total + 0.01) {
    throw new ValidationError(
      `Le montant encaissé (${formatCurrency(targetPaid)}) ne peut pas dépasser le total à payer (${formatCurrency(totals.total)})`,
    );
  }
  if (targetPaid !== null && !willBeActive && targetPaid > 0.001) {
    throw new ValidationError('Un brouillon ne peut pas porter d’encaissement');
  }
  if (targetPaid !== null && targetPaid < currentPaid - 0.01) {
    throw new ValidationError(
      `Le montant encaissé ne peut pas être réduit (déjà encaissé : ${formatCurrency(currentPaid)}). Annulez la vente pour contre-passer la caisse.`,
    );
  }
  if (!willBeActive && wasActive && currentPaid > 0.001) {
    throw new ValidationError(
      `Impossible de repasser en brouillon une vente déjà encaissée (${formatCurrency(currentPaid)}) : annulez-la plutôt.`,
    );
  }

  // --- Écritures.
  await db
    .update(salesInvoices)
    .set({
      customerId: customer.customerId,
      customerName: customer.customerName,
      date,
      dueDate: input.dueDate ? businessDate(input.dueDate, 'échéance') : null,
      subTotal: totals.subTotal,
      discount: totals.discount,
      totalHt: totals.totalHt,
      taxRate: totals.taxRate,
      taxAmount: totals.taxAmount,
      total: totals.total,
      paymentMethod,
      status: willBeActive ? 'active' : 'draft',
      notes: input.notes?.trim() ?? null,
      updatedAt: new Date(),
    })
    .where(eq(salesInvoices.id, id));


  await reconcileInvoiceItems(id, existing.invoiceNumber, items);

  await applyStockDelta(
    id,
    wasActive ? quantitiesByProduct(previousItems.map((row) => ({
      productId: row.product_id == null ? null : Number(row.product_id),
      quantity: Number(row.quantity ?? 0),
    }))) : new Map(),
    willBeActive ? quantitiesByProduct(items) : new Map(),
    {
      storeId,
      userId: input.userId ?? null,
      motifExit: `vente ${existing.invoiceNumber}`,
      motifEntry: `correction vente ${existing.invoiceNumber}`,
    },
  );

  if (willBeActive && targetPaid !== null && targetPaid > currentPaid + 0.01) {
    await createPayment({
      storeId,
      type: 'sale',
      referenceId: id,
      amount: roundMoney(targetPaid - currentPaid),
      paymentMethod,
      date,
      notes: `Complément d'encaissement — vente ${existing.invoiceNumber}`,
      userId: input.userId ?? null,
    });
  }

  // Les montants encaissés font toujours foi depuis `payments`.
  await recomputeDocumentPayments('sale', id);

  await writeAudit({
    user: await auditUser(input.userId),
    action: 'update',
    entity: 'sales_invoice',
    entityId: id,
    details: {
      invoiceNumber: existing.invoiceNumber,
      total: totals.total,
      lines: items.length,
      amountPaid: targetPaid,
      status: willBeActive ? 'active' : 'draft',
    },
  });

  const updated = await getSalesInvoice(id);
  if (!updated) throw new Error('Facture introuvable après modification');
  return updated.invoice;
}

/* ------------------------------------------------------------------ *
 * Validation d'un brouillon (§10.6)
 * ------------------------------------------------------------------ */

/**
 * Valide un brouillon : c'est **le** passage `draft` → `active`.
 *
 * Le brouillon a déjà tout ce qu'il faut en base (en-tête, lignes et
 * **instantanés** figés) : la validation ne redemande donc **aucune ressaisie**
 * au poste — elle rejoue la fin de la chaîne d'enregistrement de §10.5 :
 *
 *   1. contrôle de stock **avant toute écriture** (le brouillon n'a rien sorti,
 *      il n'y a donc aucune tolérance à accorder) ;
 *   2. passage du statut à `active` ;
 *   3. un mouvement `exit` par ligne ;
 *   4. recalcul de `amount_paid` / `remaining_amount` / `payment_status` depuis
 *      les `payments` réels (un brouillon ne peut pas en porter, mais le
 *      recalcul garantit qu'aucun montant hérité ne subsiste) ;
 *   5. journal d'actions (`action = validate`).
 *
 * Aucun encaissement n'est créé ici : le brouillon est validé « à crédit »
 * (statut de paiement recalculé), et l'encaissement se fait ensuite par
 * `POST /api/paiements` — désormais refusé tant que la vente est un brouillon.
 *
 * Le numéro de facture ne change pas : on valide la pièce existante.
 */
export async function validateSalesInvoice(
  id: number,
  user: SalesUserRef = null,
): Promise<SalesInvoiceRow> {
  return withTransaction(() => validateSalesInvoiceInTx(id, user));
}

async function validateSalesInvoiceInTx(id: number, user: SalesUserRef): Promise<SalesInvoiceRow> {
  const existing = await getInvoiceRecord(id);
  if (!existing) throw new NotFoundError('Facture introuvable');
  const storeId = assertSameStore(existing, user?.storeId);
  if (existing.status === 'cancelled') {
    throw new ValidationError('Une facture annulée ne peut pas être validée');
  }
  if (existing.status === 'active') {
    throw new ValidationError('Cette vente est déjà validée');
  }

  const previousItems = await getItemRecords(id);
  if (previousItems.length === 0) {
    throw new ValidationError(
      'Ce brouillon ne contient aucune ligne : il ne peut pas être validé',
    );
  }

  const missingProduct = previousItems.find((row) => Number(row.product_id) <= 0);
  if (missingProduct) {
    throw new ValidationError(
      'Ce brouillon contient une ligne sans produit : corrigez la vente avant de la valider',
    );
  }

  // Les lignes sont relues depuis les instantanés figés : aucune confiance
  // accordée à un corps de requête, et aucune ressaisie au poste.
  const lines: SalesLineInput[] = previousItems.map((row) => ({
    productId: Number(row.product_id),
    quantity: Number(row.quantity ?? 0),
    unitPrice: Number(row.unit_price ?? 0),
    discount: Number(row.discount ?? 0),
  }));

  // 1. Contrôle de stock AVANT toute écriture (mêmes règles et même message
  // agrégé que la création). Une rupture entre-temps refuse la validation :
  // c'est précisément à cet instant que la marchandise sort réellement.
  const items = await buildSalesItems(lines, { storeId });

  // 2. Statut : le brouillon devient définitif.
  await db
    .update(salesInvoices)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(salesInvoices.id, id));


  // 3. Sorties de stock : le brouillon n'en avait aucune.
  for (const item of items) {
    await addStockMovement(item.productId, 'exit', item.quantity, {
      storeId,
      referenceType: 'sale',
      referenceId: id,
      motif: `vente ${existing.invoiceNumber}`,
      userId: user?.id ?? null,
    });
  }

  // 4. Les montants encaissés font toujours foi depuis `payments`.
  await recomputeDocumentPayments('sale', id);

  const validated = await getSalesInvoice(id);
  if (!validated) throw new Error('Facture introuvable après validation');

  await writeAudit({
    user: user ? { id: user.id, name: user.name ?? 'Système' } : null,
    action: 'validate',
    entity: 'sales_invoice',
    entityId: id,
    details: {
      invoiceNumber: existing.invoiceNumber,
      customerName: existing.customerName,
      total: validated.invoice.total,
      lines: items.length,
      previousStatus: 'draft',
    },
  });

  return validated.invoice;
}

/* ------------------------------------------------------------------ *
 * Annulation (§10.6) — jamais de suppression physique
 * ------------------------------------------------------------------ */

/**
 * Annule une vente : statut `cancelled` + motif + auteur + date, mouvements de
 * stock **inversés** (un `entry` par ligne vendue), encaissement **contre-passé**
 * en caisse. La facture reste consultable et réimprimable.
 *
 * Un brouillon n'ayant ni mouvement de stock ni mouvement de caisse, sa
 * « suppression » est une annulation sans contrepartie — jamais un `DELETE`.
 */
export async function cancelSalesInvoice(
  id: number,
  reason: string,
  user: SalesUserRef = null,
): Promise<SalesInvoiceRow> {
  const cleanReason = String(reason ?? '').trim();
  if (!cleanReason) {
    throw new ValidationError("Le motif d'annulation est obligatoire");
  }

  return withTransaction(async () => {
  const existing = await getInvoiceRecord(id);
  if (!existing) throw new NotFoundError('Facture introuvable');
  const storeId = assertSameStore(existing, user?.storeId);
  if (existing.status === 'cancelled') {
    throw new ValidationError('Cette facture est déjà annulée');
  }

  const wasActive = existing.status === 'active';
  const items = await getItemRecords(id);

  await db
    .update(salesInvoices)
    .set({
      status: 'cancelled',
      cancelReason: cleanReason,
      cancelledBy: user?.id ?? null,
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(salesInvoices.id, id));


  let reversedStock = false;
  let refundedAmount = 0;

  // Le stock n'est rendu que par une vente **validée** : un brouillon n'a jamais
  // rien sorti.
  if (wasActive) {
    for (const item of items) {
      const productId = item.product_id == null ? null : Number(item.product_id);
      const quantity = Number(item.quantity ?? 0);
      if (!productId || quantity <= 0) continue;

      await addStockMovement(productId, 'entry', quantity, {
        storeId,
        referenceType: 'sale',
        referenceId: id,
        motif: `annulation vente ${existing.invoiceNumber}`,
        userId: user?.id ?? null,
      });
      reversedStock = true;
    }
  }

  /*
   * La caisse, elle, est contre-passée dès qu'un encaissement **existe
   * réellement** — y compris sur un brouillon. Un brouillon ne devrait jamais
   * porter d'argent (`createPayment` le refuse, §10.6), mais des brouillons
   * encaissés avant la mise en place de cette garde subsistent : sans cette
   * contre-passation, l'argent resterait en caisse pour une facture annulée.
   */
  refundedAmount = roundMoney(Number(existing.amountPaid ?? 0));
  if (refundedAmount > 0) {
    await addCashMovement({
      storeId,
      type: 'expense',
      amount: refundedAmount,
      paymentMethod: existing.paymentMethod,
      motif: `Contre-passation annulation vente ${existing.invoiceNumber}`,
      referenceType: 'sale',
      referenceId: id,
      userId: user?.id ?? null,
    });
  }

  await writeAudit({
    user: user ? { id: user.id, name: user.name ?? 'Système' } : null,
    action: 'cancel',
    entity: 'sales_invoice',
    entityId: id,
    details: {
      invoiceNumber: existing.invoiceNumber,
      reason: cleanReason,
      previousStatus: existing.status,
      reversedStock,
      refundedAmount,
    },
  });

  const cancelled = await getSalesInvoice(id);
  if (!cancelled) throw new Error('Facture introuvable après annulation');
  return cancelled.invoice;
  });
}

/* ------------------------------------------------------------------ *
 * Statistiques (§15 : tout est calculé à la lecture)
 * ------------------------------------------------------------------ */

/** Statistiques de ventes sur une période nommée (`resolvePeriod` de `lib/dashboard.ts`). */
export async function getSalesStats(
  period: PeriodKey = 'month',
  options: { scope: StoreScope },
): Promise<SalesStats> {
  const key: PeriodKey = PERIOD_KEYS.includes(period) ? period : 'month';
  const bounds = resolvePeriod(key);

  // Périmètre : les magasins demandés (filtre identique à la liste).
  const channelSql = ` AND ${scopeSql('store_id', options.scope)}`;
  const channelArgs: string[] = [];

  const totals = await rawGet<any>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(total), 0)           AS revenue,
            COALESCE(SUM(total_ht), 0)        AS total_ht,
            COALESCE(SUM(tax_amount), 0)      AS tax_amount,
            COALESCE(SUM(amount_paid), 0)     AS collected,
            COALESCE(SUM(remaining_amount), 0) AS outstanding
     FROM sales_invoices
     WHERE status = 'active' AND date >= ? AND date <= ?${channelSql}`,
    [bounds.from, bounds.to, ...channelArgs],
  );

  const cancelled = await rawGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sales_invoices
     WHERE status = 'cancelled' AND date >= ? AND date <= ?${channelSql}`,
    [bounds.from, bounds.to, ...channelArgs],
  );

  const topProducts = await rawAll<{ product_name: string; quantity: number; amount: number }>(
    `SELECT i.product_name,
            SUM(i.quantity) AS quantity,
            SUM(i.amount)   AS amount
     FROM sales_invoice_items i
     JOIN sales_invoices v ON v.id = i.invoice_id
     WHERE v.status = 'active' AND v.date >= ? AND v.date <= ? AND ${scopeSql('v.store_id', options.scope)}
     GROUP BY i.product_name
     ORDER BY amount DESC
     LIMIT ?`,
    [bounds.from, bounds.to, MAX_TOP_PRODUCTS],
  );

  const byDayRows = await rawAll<{ date: string; revenue: number; count: number }>(
    `SELECT date,
            COALESCE(SUM(total), 0) AS revenue,
            COUNT(*)                AS count
     FROM sales_invoices
     WHERE status = 'active' AND date >= ? AND date <= ?${channelSql}
     GROUP BY date
     ORDER BY date ASC`,
    [bounds.from, bounds.to, ...channelArgs],
  );

  const count = Number(totals?.count ?? 0);
  const revenue = roundMoney(Number(totals?.revenue ?? 0));

  return {
    period: bounds,
    count,
    revenue,
    totalHt: roundMoney(Number(totals?.total_ht ?? 0)),
    taxAmount: roundMoney(Number(totals?.tax_amount ?? 0)),
    collected: roundMoney(Number(totals?.collected ?? 0)),
    outstanding: roundMoney(Number(totals?.outstanding ?? 0)),
    averageBasket: count > 0 ? roundMoney(revenue / count) : 0,
    cancelledCount: Number(cancelled?.count ?? 0),
    topProducts: topProducts.map((row) => ({
      productName: row.product_name,
      quantity: roundQty(Number(row.quantity ?? 0)),
      amount: roundMoney(Number(row.amount ?? 0)),
    })),
    // Une période « depuis le début » peut couvrir dix ans : on borne le
    // graphique aux 366 derniers jours de la période.
    byDay: byDayRows.slice(-MAX_BY_DAY).map((row) => ({
      date: row.date,
      revenue: roundMoney(Number(row.revenue ?? 0)),
      count: Number(row.count ?? 0),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Bénéfice — donnée financière sensible
 * ------------------------------------------------------------------ */

/**
 * Le bénéfice d'une vente ne quitte le serveur que pour un utilisateur qui
 * détient réellement `balances.view` : matrice du rôle **puis** surcharges par
 * utilisateur, exactement comme `requireAction()` de `lib/api.ts`.
 *
 * Masquer la colonne dans l'interface ne suffirait pas — la règle du projet est
 * que le serveur reste seul juge (§9). Un vendeur lit donc ses ventes sans
 * jamais recevoir le coût ni la marge.
 */
export async function canViewSalesProfit(user: { id: number; role: Role; permissions?: string[] }): Promise<boolean> {
  const permissions = user.permissions ?? (await getEffectivePermissions({ id: user.id, role: user.role }));
  return can(user, 'balances.view', permissions as any);
}

/**
 * Retire coût et bénéfice d'une ligne de vente avant de la renvoyer à un
 * utilisateur qui n'a pas `balances.view`. On **conserve les clés** (`null`) :
 * le contrat d'API ne change pas de forme, il cesse simplement de porter la
 * donnée.
 */
export function withoutSalesProfit<T extends { cost: number | null; profit: number | null }>(
  row: T,
): T {
  return { ...row, cost: null, profit: null };
}

/* ------------------------------------------------------------------ *
 * Libellés (affichage)
 * ------------------------------------------------------------------ */

export const SALES_STATUS_LABELS: Record<SalesInvoiceRow['status'], string> = {
  draft: 'Brouillon',
  active: 'Validée',
  cancelled: 'Annulée',
};

/** Statut de paiement (§10.4) — repris du projet Gaz. */
export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: 'En attente',
  partial: 'Partiel',
  paid: 'Payée',
};
