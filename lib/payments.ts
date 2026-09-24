/**
 * Paiements polymorphes (§7, §15).
 *
 * Une **seule** table `payments` porte les acomptes, les soldes et les reçus des
 * ventes, des achats et des prestations (§6.1). `reference_id` n'est **pas** une
 * clé étrangère : l'intégrité est garantie ici, jamais par la base. Un paiement
 * orphelin est un bug applicatif, pas une impossibilité de la base.
 *
 * Après chaque écriture, le document référencé est recalculé **depuis ses
 * paiements** : `amount_paid`, `remaining_amount` et `payment_status` ne
 * peuvent donc jamais diverger de la somme réelle des encaissements.
 */

import { db, rawAll, rawGet } from '@/db';
import { payments, salesInvoices, purchaseInvoices, serviceJobs } from '@/db/schema';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { enqueueSyncWrite } from '@/lib/sync';
import { renderDocumentNumber, getSettings, nextSequence } from '@/lib/settings';
import { addCashMovement } from '@/lib/caisse';
import { today } from '@/lib/format';

export type PaymentType = 'sale' | 'purchase' | 'service_job';
export type PaymentLabel = 'deposit' | 'balance' | 'full';

export class PaymentError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PaymentError';
  }
}

export type PaymentRow = {
  id: number;
  receiptNumber: string;
  type: PaymentType;
  referenceId: number;
  amount: number;
  paymentMethod: string;
  paymentLabel: PaymentLabel;
  date: string;
  notes: string | null;
  userId: number | null;
  userName: string | null;
  createdAt: Date | null;
};

const DOCUMENT_CONFIG: Record<
  PaymentType,
  { table: any; label: string; cashType: 'income' | 'expense' }
> = {
  sale: { table: salesInvoices, label: 'Facture de vente', cashType: 'income' },
  purchase: { table: purchaseInvoices, label: "Facture d'achat", cashType: 'expense' },
  service_job: { table: serviceJobs, label: 'Chantier', cashType: 'income' },
};

/** Le document référencé, quel que soit son type. */
async function loadDocument(type: PaymentType, referenceId: number) {
  const config = DOCUMENT_CONFIG[type];
  if (!config) throw new PaymentError(`Type de paiement inconnu : ${type}`);

  const rows = await db.select().from(config.table).where(eq(config.table.id, referenceId)).limit(1);
  if (!rows[0]) throw new PaymentError(`${config.label} introuvable (id ${referenceId})`);
  return rows[0] as any;
}

/**
 * Recalcule `amount_paid` / `remaining_amount` / `payment_status` d'un document
 * depuis la **somme de ses paiements**. Source de vérité unique : les lignes de
 * `payments`, jamais un compteur incrémenté à la main.
 */
export async function recomputeDocumentPayments(
  type: PaymentType,
  referenceId: number,
): Promise<{ amountPaid: number; remainingAmount: number; paymentStatus: string; total: number }> {
  const config = DOCUMENT_CONFIG[type];
  const document = await loadDocument(type, referenceId);

  const sumRow = await rawGet<{ total: number | null }>(
    `SELECT SUM(amount) AS total FROM payments WHERE type = ? AND reference_id = ?`,
    [type, referenceId],
  );

  const amountPaid = Math.round(Number(sumRow?.total ?? 0) * 100) / 100;
  const total = Number(document.total ?? 0);
  const remainingAmount = Math.round(Math.max(total - amountPaid, 0) * 100) / 100;

  const paymentStatus =
    amountPaid <= 0 ? 'unpaid' : remainingAmount <= 0.001 ? 'paid' : 'partial';

  await db
    .update(config.table)
    .set({ amountPaid, remainingAmount, paymentStatus, updatedAt: new Date() })
    .where(eq(config.table.id, referenceId));

  await enqueueSyncWrite(
    type === 'sale' ? 'sales_invoices' : type === 'purchase' ? 'purchase_invoices' : 'service_jobs',
    null,
    'update',
    { amount_paid: amountPaid, remaining_amount: remainingAmount, payment_status: paymentStatus },
  );

  return { amountPaid, remainingAmount, paymentStatus, total };
}

/**
 * Enregistre un paiement.
 *
 * Étapes : validation du document → numéro de reçu unique → insertion →
 * recalcul du document → mouvement de caisse (sauf paiement « Crédit »).
 */
export async function createPayment(input: {
  type: PaymentType;
  referenceId: number;
  amount: number;
  paymentMethod?: string;
  paymentLabel?: PaymentLabel;
  date?: string;
  notes?: string | null;
  userId?: number | null;
  /** Évite le mouvement de caisse pour un règlement hors caisse. */
  skipCash?: boolean;
}): Promise<PaymentRow> {
  const amount = Math.round((Number(input.amount) || 0) * 100) / 100;
  if (amount <= 0) throw new PaymentError('Le montant du paiement doit être supérieur à zéro');

  const document = await loadDocument(input.type, input.referenceId);

  if (document.status === 'cancelled') {
    throw new PaymentError('Impossible d’encaisser un document annulé');
  }

  const existing = await rawGet<{ total: number | null }>(
    `SELECT SUM(amount) AS total FROM payments WHERE type = ? AND reference_id = ?`,
    [input.type, input.referenceId],
  );
  const alreadyPaid = Number(existing?.total ?? 0);
  const total = Number(document.total ?? 0);
  const remaining = Math.round((total - alreadyPaid) * 100) / 100;

  if (remaining <= 0.001) {
    throw new PaymentError('Ce document est déjà entièrement réglé');
  }
  if (amount > remaining + 0.01) {
    throw new PaymentError(
      `Le montant dépasse le reste à payer (reste : ${remaining.toLocaleString('fr-FR')} GNF)`,
    );
  }

  const settings = await getSettings();
  const prefix = settings.receiptPrefix || 'REC';
  const sequence = await nextSequence('receipt');
  const receiptNumber = renderDocumentNumber(prefix, sequence, '{PREFIX}-{YYYY}-{NNNNNN}');

  const paymentLabel: PaymentLabel =
    input.paymentLabel ?? (alreadyPaid > 0 ? (amount >= remaining - 0.01 ? 'balance' : 'deposit') : amount >= remaining - 0.01 ? 'full' : 'deposit');

  const paymentMethod = input.paymentMethod || 'Espèces';
  const date = input.date ?? today();

  const inserted = await db
    .insert(payments)
    .values({
      receiptNumber,
      type: input.type,
      referenceId: input.referenceId,
      amount,
      paymentMethod,
      paymentLabel,
      date,
      notes: input.notes?.trim() || null,
      userId: input.userId ?? null,
    })
    .returning();

  const config = DOCUMENT_CONFIG[input.type];

  await enqueueSyncWrite('payments', inserted[0].syncId, 'insert', {
    receipt_number: receiptNumber,
    type: input.type,
    reference_id: input.referenceId,
    amount,
  });

  // Recalcul du document depuis les paiements réels.
  await recomputeDocumentPayments(input.type, input.referenceId);

  // Mouvement de caisse : un règlement « Crédit » ne fait pas entrer d'argent.
  if (!input.skipCash && paymentMethod.toLowerCase() !== 'crédit' && paymentMethod.toLowerCase() !== 'credit') {
    const referenceNumber =
      input.type === 'sale'
        ? document.invoiceNumber
        : input.type === 'purchase'
          ? document.reference
          : document.reference;

    await addCashMovement({
      type: config.cashType,
      amount,
      paymentMethod,
      motif: `${config.cashType === 'income' ? 'Encaissement' : 'Règlement'} ${referenceNumber ?? ''} — reçu ${receiptNumber}`.trim(),
      referenceType: input.type === 'sale' ? 'payment' : input.type === 'purchase' ? 'purchase' : 'payment',
      referenceId: input.referenceId,
      date,
      userId: input.userId ?? null,
    });
  }

  return mapPaymentRow({ ...inserted[0], userName: null });
}

/**
 * Normalise une ligne de `payments` en objet applicatif.
 *
 * ⚠️ **Cette fonction reçoit deux formes différentes**, et c'est la cause d'un
 * bug constaté en vérification :
 *  - un objet **Drizzle** (`insert().returning()`), en camelCase ;
 *  - une ligne de **SQL brut** (`rawGet` / `rawAll`), en **snake_case**.
 *
 * En ne lisant que le camelCase, les colonnes `receipt_number`,
 * `payment_method`, `reference_id`… ressortaient `undefined` : la liste des
 * paiements affichait des numéros de reçu vides, et `reference_id` devenait
 * `NaN`, ce qui faisait échouer `/api/paiements/[id]` avec
 * « Only finite numbers … can be passed as arguments ». On lit donc les deux.
 */
function mapPaymentRow(row: any): PaymentRow {
  const pick = <T>(camel: string, snake: string): T => (row[camel] ?? row[snake]) as T;

  return {
    id: Number(pick('id', 'id')),
    receiptNumber: String(pick('receiptNumber', 'receipt_number') ?? ''),
    type: pick('type', 'type') as PaymentType,
    // `Number(undefined)` vaut NaN, et NaN passé à libSQL fait échouer la
    // requête suivante : on garantit un entier.
    referenceId: Number(pick('referenceId', 'reference_id') ?? 0) || 0,
    amount: Number(pick('amount', 'amount') ?? 0),
    paymentMethod: String(pick('paymentMethod', 'payment_method') ?? 'Espèces'),
    paymentLabel: (pick('paymentLabel', 'payment_label') ?? 'full') as PaymentLabel,
    date: String(pick('date', 'date') ?? ''),
    notes: (pick('notes', 'notes') ?? null) as string | null,
    userId: pick('userId', 'user_id') == null ? null : Number(pick('userId', 'user_id')),
    userName: (pick('userName', 'user_name') ?? null) as string | null,
    createdAt: (pick('createdAt', 'created_at') ?? null) as Date | null,
  };
}

export async function getPayment(id: number): Promise<PaymentRow | null> {
  const row = await rawGet<any>(
    `SELECT p.*, u.name AS user_name FROM payments p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.id = ?`,
    [id],
  );
  return row ? mapPaymentRow(row) : null;
}

/** Détail complet d'un reçu : paiement + document + entreprise (pour l'impression). */
export async function getReceiptData(id: number) {
  const payment = await getPayment(id);
  if (!payment) return null;

  const document = await loadDocument(payment.type, payment.referenceId);
  const config = DOCUMENT_CONFIG[payment.type];

  const customerName =
    payment.type === 'sale' || payment.type === 'service_job'
      ? (document.customerName ?? (await customerNameOf(document.customerId)))
      : (document.supplierId ? await supplierNameOf(document.supplierId) : 'Fournisseur');

  const documentNumber =
    payment.type === 'sale'
      ? document.invoiceNumber
      : payment.type === 'purchase'
        ? document.reference
        : document.reference;

  // Historique des paiements du même document : un reçu doit pouvoir montrer
  // où en est l'échéancier (§7).
  const allPayments = await listPayments({ type: payment.type, referenceId: payment.referenceId, limit: 200 });

  return {
    payment,
    documentLabel: config.label,
    documentNumber,
    customerName,
    total: Number(document.total ?? 0),
    amountPaid: Number(document.amountPaid ?? 0),
    remainingAmount: Number(document.remainingAmount ?? 0),
    documentDate: document.date ?? null,
    dueDate: document.dueDate ?? null,
    payments: allPayments.data,
  };
}

async function customerNameOf(id: number | null): Promise<string> {
  if (!id) return 'Client comptoir';
  const row = await rawGet<{ name: string }>(`SELECT name FROM customers WHERE id = ?`, [id]);
  return row?.name ?? 'Client comptoir';
}

async function supplierNameOf(id: number | null): Promise<string> {
  if (!id) return 'Fournisseur';
  const row = await rawGet<{ name: string }>(`SELECT name FROM suppliers WHERE id = ?`, [id]);
  return row?.name ?? 'Fournisseur';
}

export async function listPayments(options: {
  type?: PaymentType;
  referenceId?: number;
  customerId?: number;
  supplierId?: number;
  paymentMethod?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
} = {}): Promise<{ data: PaymentRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (options.type) {
    conditions.push('p.type = ?');
    args.push(options.type);
  }
  if (options.referenceId) {
    conditions.push('p.reference_id = ?');
    args.push(options.referenceId);
  }
  if (options.paymentMethod) {
    conditions.push('p.payment_method = ?');
    args.push(options.paymentMethod);
  }
  if (options.from) {
    conditions.push('p.date >= ?');
    args.push(options.from);
  }
  if (options.to) {
    conditions.push('p.date <= ?');
    args.push(options.to);
  }
  if (options.customerId) {
    conditions.push(
      `(p.type = 'sale' AND p.reference_id IN (SELECT id FROM sales_invoices WHERE customer_id = ?))`,
    );
    args.push(options.customerId);
  }
  if (options.supplierId) {
    conditions.push(
      `(p.type = 'purchase' AND p.reference_id IN (SELECT id FROM purchase_invoices WHERE supplier_id = ?))`,
    );
    args.push(options.supplierId);
  }
  if (options.search) {
    conditions.push('(p.receipt_number LIKE ? OR p.notes LIKE ?)');
    const like = `%${options.search}%`;
    args.push(like, like);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await rawAll<any>(
    `SELECT p.*, u.name AS user_name FROM payments p
     LEFT JOIN users u ON u.id = p.user_id
     ${whereSql}
     ORDER BY p.date DESC, p.id DESC
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM payments p ${whereSql}`,
    args,
  );

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapPaymentRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export const PAYMENT_LABELS: Record<PaymentLabel, string> = {
  deposit: 'Acompte',
  balance: 'Solde',
  full: 'Intégral',
};

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  sale: 'Vente',
  purchase: 'Achat',
  service_job: 'Prestation',
};

/**
 * Échéancier d'un document : ce qui est payé, ce qui reste, quand c'est dû.
 * Alimente la modale « Enregistrer un paiement » et le détail de facture (§7).
 */
export async function getPaymentSchedule(type: PaymentType, referenceId: number) {
  const document = await loadDocument(type, referenceId);
  const history = await listPayments({ type, referenceId, limit: 200 });

  const total = Number(document.total ?? 0);
  const paid = Number(document.amountPaid ?? 0);
  const remaining = Number(document.remainingAmount ?? 0);

  return {
    total,
    paid,
    remaining,
    paymentStatus: document.paymentStatus,
    dueDate: document.dueDate ?? null,
    documentDate: document.date ?? null,
    isOverdue:
      Boolean(document.dueDate) && remaining > 0.001 && String(document.dueDate) < today(),
    payments: history.data,
  };
}

/** Total encaissé sur une période, par moyen de paiement (§16). */
export async function getPaymentsSummary(options: { from: string; to: string }) {
  const rows = await rawAll<{ payment_method: string; type: string; total: number; count: number }>(
    `SELECT payment_method, type, SUM(amount) AS total, COUNT(*) AS count
     FROM payments
     WHERE date >= ? AND date <= ?
     GROUP BY payment_method, type`,
    [options.from, options.to],
  );

  return rows.map((r) => ({
    paymentMethod: r.payment_method,
    type: r.type as PaymentType,
    total: Number(r.total ?? 0),
    count: Number(r.count ?? 0),
  }));
}
