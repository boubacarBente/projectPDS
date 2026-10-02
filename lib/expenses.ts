/**
 * Dépenses (§7.9, §9, §14 ; multi-magasins §12).
 *
 * Invariants :
 *
 *  1. **Une dépense approuvée sort de la caisse de son magasin.** Création,
 *     modification et annulation laissent une trace dans `cash_movements`
 *     (rapprochement caisse ↔ dépense, §13 ; bénéfice net, §15).
 *  2. **Une dépense ne touche JAMAIS le stock.**
 *  3. **Chaque dépense appartient à un magasin** (`store_id`). Les charges
 *     centrales sont saisies dans le magasin « siège » (`stores.kind =
 *     'headquarters'`) : elles restent distinctes des charges locales, et les
 *     rapports consolidés peuvent les répartir.
 *  4. **Circuit d'approbation** (§12) : au-delà du seuil
 *     `settings.expenseApprovalThreshold`, une dépense saisie par quelqu'un qui
 *     n'a pas `expenses.update` est créée `pending` — **sans** sortie de caisse.
 *     Une fois approuvée elle passe `to_pay` (à décaisser) ; le décaissement
 *     crée alors le mouvement de caisse et la dépense devient `approved`.
 *     Une dépense rejetée (`rejected`) n'est jamais comptée.
 *
 * Toutes les écritures s'exécutent dans une transaction : la dépense et son
 * mouvement de caisse sont enregistrés ensemble, ou pas du tout.
 *
 * Annulation : tombstone `deleted_at` (jamais de suppression physique) et
 * contre-passation de caisse si l'argent était sorti.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { expenses } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ValidationError, NotFoundError } from '@/lib/api';
import { addCashMovement } from '@/lib/caisse';
import { getSettings } from '@/lib/settings';
import { formatCurrency, roundMoney } from '@/lib/format';
import { scopeSql, type StoreScope } from '@/lib/stores';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type ExpenseApprovalStatus = 'approved' | 'pending' | 'to_pay' | 'rejected';

export const EXPENSE_APPROVAL_LABELS: Record<ExpenseApprovalStatus, string> = {
  approved: 'Décaissée',
  pending: 'En attente d’approbation',
  to_pay: 'Approuvée — à décaisser',
  rejected: 'Rejetée',
};

/** Conservé pour compatibilité de l'API : une seule portée depuis le retrait de la briqueterie. */
export type ExpenseScope = 'general';

export function isExpenseScope(value: unknown): value is ExpenseScope {
  return value === 'general';
}

export type ExpenseRow = {
  id: number;
  storeId: number | null;
  storeName: string | null;
  category: string;
  amount: number;
  description: string | null;
  paymentMethod: string;
  referenceType: string | null;
  referenceId: number | null;
  beneficiary: string | null;
  /** Date **métier** `YYYY-MM-DD`. */
  date: string;
  userId: number | null;
  userName: string | null;
  approvalStatus: ExpenseApprovalStatus;
  approvedBy: number | null;
  approvedByName: string | null;
  /** Annulée = tombstone `deleted_at` posé : plus comptée, jamais effacée. */
  cancelled: boolean;
  createdAt: Date | null;
};

export type ExpenseInput = {
  storeId: number;
  category: string;
  amount: number;
  description?: string | null;
  paymentMethod?: string;
  referenceType?: string | null;
  referenceId?: number | null;
  beneficiary?: string | null;
  date: string;
  userId?: number | null;
  /** L'auteur peut-il dépasser le seuil sans approbation ? */
  canSkipApproval?: boolean;
  scope?: ExpenseScope;
};

export type ExpensePatch = {
  category?: string;
  amount?: number;
  description?: string | null;
  paymentMethod?: string;
  referenceType?: string | null;
  referenceId?: number | null;
  beneficiary?: string | null;
  date?: string;
};

export type ExpenseListOptions = {
  scope: StoreScope;
  search?: string;
  category?: string;
  paymentMethod?: string;
  approvalStatus?: ExpenseApprovalStatus | 'all';
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  includeCancelled?: boolean;
};

export type ExpenseListResult = {
  data: ExpenseRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type ExpensesSummary = {
  totalAmount: number;
  expensesCount: number;
  averageAmount: number;
  pendingCount: number;
  pendingAmount: number;
  byCategory: { category: string; total: number; count: number }[];
  byMonth: { month: string; total: number }[];
  byStore: { storeId: number; storeName: string; total: number }[];
};

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/** Catégorie validée contre la liste fermée des paramètres (casse canonique). */
export async function validateExpenseCategory(value: unknown): Promise<string> {
  const category = String(value ?? '').trim();
  if (!category) throw new ValidationError('La catégorie est obligatoire');

  const settings = await getSettings();
  const allowed = settings.expenseCategories ?? [];
  const canonical = allowed.find(
    (item) => item.toLocaleLowerCase('fr-FR') === category.toLocaleLowerCase('fr-FR'),
  );
  if (!canonical) {
    const liste = allowed.length > 0 ? allowed.join(', ') : 'aucune catégorie définie';
    throw new ValidationError(
      `Catégorie « ${category} » inconnue. Choisissez une catégorie de la liste des paramètres (${liste}).`,
    );
  }
  return canonical;
}

function validateAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('Le montant doit être un nombre supérieur à 0');
  }
  return roundMoney(amount);
}

function validateBusinessDate(value: unknown): string {
  const text = String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError('La date doit être au format AAAA-MM-JJ');
  }
  return text;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeStatus(value: unknown): ExpenseApprovalStatus {
  return value === 'pending' || value === 'to_pay' || value === 'rejected' ? value : 'approved';
}

function mapExpenseRow(row: any): ExpenseRow {
  return {
    id: Number(row.id),
    storeId: row.store_id == null ? null : Number(row.store_id),
    storeName: row.store_name ?? null,
    category: row.category,
    amount: Number(row.amount ?? 0),
    description: row.description ?? null,
    paymentMethod: row.payment_method ?? 'Espèces',
    referenceType: row.reference_type ?? null,
    referenceId: row.reference_id == null ? null : Number(row.reference_id),
    beneficiary: row.beneficiary ?? null,
    date: row.date,
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name ?? null,
    approvalStatus: normalizeStatus(row.approval_status),
    approvedBy: row.approved_by == null ? null : Number(row.approved_by),
    approvedByName: row.approved_by_name ?? null,
    cancelled: row.deleted_at != null,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

const EXPENSE_SELECT = `
  SELECT e.*, u.name AS user_name, a.name AS approved_by_name, s.name AS store_name
    FROM expenses e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN users a ON a.id = e.approved_by
    LEFT JOIN stores s ON s.id = e.store_id`;

/** Une dépense **comptée** : approuvée et non annulée. */
export const COUNTED_EXPENSE_SQL = `deleted_at IS NULL AND approval_status = 'approved'`;

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

export async function listExpenses(options: ExpenseListOptions): Promise<ExpenseListResult> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [scopeSql('e.store_id', options.scope)];
  const args: (string | number)[] = [];

  if (!options.includeCancelled) where.push('e.deleted_at IS NULL');
  if (options.approvalStatus && options.approvalStatus !== 'all') {
    where.push('e.approval_status = ?');
    args.push(options.approvalStatus);
  }
  if (options.category) {
    where.push('e.category = ?');
    args.push(options.category);
  }
  if (options.paymentMethod) {
    where.push('e.payment_method = ?');
    args.push(options.paymentMethod);
  }
  if (options.from) {
    where.push('e.date >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('e.date <= ?');
    args.push(options.to);
  }
  if (options.search) {
    where.push(
      '(e.description LIKE ? OR e.beneficiary LIKE ? OR e.category LIKE ? OR e.payment_method LIKE ?)',
    );
    const like = `%${options.search}%`;
    args.push(like, like, like, like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = await rawAll<any>(
    `${EXPENSE_SELECT} ${whereSql} ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );
  const countRow = await rawGet<{ total: number }>(`SELECT COUNT(*) AS total FROM expenses e ${whereSql}`, args);
  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapExpenseRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function getExpense(id: number): Promise<ExpenseRow | null> {
  const row = await rawGet<any>(`${EXPENSE_SELECT} WHERE e.id = ?`, [id]);
  return row ? mapExpenseRow(row) : null;
}

function assertSameStore(expense: ExpenseRow, storeId: number | null | undefined) {
  if (!storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');
  if (expense.storeId !== Number(storeId)) {
    throw new ValidationError(
      'Cette dépense appartient à un autre magasin : elle ne peut être modifiée que depuis ce magasin.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Écriture — création
 * ------------------------------------------------------------------ */

export async function createExpense(input: ExpenseInput): Promise<ExpenseRow> {
  if (!input.storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');

  const category = await validateExpenseCategory(input.category);
  const amount = validateAmount(input.amount);
  const date = validateBusinessDate(input.date);
  const paymentMethod = optionalText(input.paymentMethod) ?? 'Espèces';
  const description = optionalText(input.description);
  const beneficiary = optionalText(input.beneficiary);

  const settings = await getSettings();
  const threshold = Number(settings.expenseApprovalThreshold ?? 0) || 0;
  const needsApproval = threshold > 0 && amount > threshold && !input.canSkipApproval;

  return withTransaction(async () => {
    const inserted = await db
      .insert(expenses)
      .values({
        storeId: input.storeId,
        category,
        amount,
        description,
        paymentMethod,
        referenceType: input.referenceType ?? 'expense',
        referenceId: input.referenceId ?? null,
        beneficiary,
        date,
        userId: input.userId ?? null,
        approvalStatus: needsApproval ? 'pending' : 'approved',
        approvedBy: needsApproval ? null : (input.userId ?? null),
        approvedAt: needsApproval ? null : new Date(),
      })
      .returning({ id: expenses.id });

    const id = inserted[0].id;

    if (!needsApproval) {
      await addCashMovement({
        storeId: input.storeId,
        type: 'expense',
        amount,
        paymentMethod,
        motif: `Dépense — ${category}`,
        referenceType: 'expense',
        referenceId: id,
        date,
        userId: input.userId ?? null,
      });
    }

    const created = await getExpense(id);
    if (!created) throw new Error('Dépense créée mais introuvable');
    return created;
  });
}

/* ------------------------------------------------------------------ *
 * Approbation (§12)
 * ------------------------------------------------------------------ */

/**
 * Décision d'approbation. `approve` → la dépense devient « à décaisser » ;
 * si l'approbateur travaille dans le magasin de la dépense (`payNow`), elle
 * est décaissée immédiatement.
 */
export async function decideExpense(
  id: number,
  decision: 'approve' | 'reject',
  options: { userId: number; payNow?: boolean; activeStoreId?: number | null; reason?: string | null },
): Promise<ExpenseRow> {
  return withTransaction(async () => {
    const expense = await getExpense(id);
    if (!expense) throw new NotFoundError('Dépense introuvable');
    if (expense.cancelled) throw new ValidationError('Cette dépense est annulée');
    if (expense.approvalStatus !== 'pending') {
      throw new ValidationError('Cette dépense n’est pas en attente d’approbation');
    }
    // Séparation des tâches : celui qui engage la dépense ne l'approuve pas.
    if (expense.userId !== null && expense.userId === options.userId) {
      throw new ValidationError(
        'Vous ne pouvez pas approuver ou rejeter votre propre dépense : un autre responsable doit le faire.',
      );
    }

    if (decision === 'reject') {
      await db
        .update(expenses)
        .set({
          approvalStatus: 'rejected',
          approvedBy: options.userId,
          approvedAt: new Date(),
          description: options.reason
            ? [expense.description, `Rejet : ${options.reason}`].filter(Boolean).join(' — ')
            : expense.description,
        })
        .where(eq(expenses.id, id));
      return (await getExpense(id))!;
    }

    await db
      .update(expenses)
      .set({ approvalStatus: 'to_pay', approvedBy: options.userId, approvedAt: new Date() })
      .where(eq(expenses.id, id));

    if (options.payNow && options.activeStoreId && options.activeStoreId === expense.storeId) {
      return payExpense(id, { userId: options.userId, storeId: options.activeStoreId });
    }
    return (await getExpense(id))!;
  });
}

/** Décaissement d'une dépense approuvée : sortie de caisse du magasin. */
export async function payExpense(id: number, options: { userId: number; storeId: number }): Promise<ExpenseRow> {
  return withTransaction(async () => {
    const expense = await getExpense(id);
    if (!expense) throw new NotFoundError('Dépense introuvable');
    assertSameStore(expense, options.storeId);
    if (expense.cancelled) throw new ValidationError('Cette dépense est annulée');
    if (expense.approvalStatus !== 'to_pay') {
      throw new ValidationError('Seule une dépense approuvée « à décaisser » peut être décaissée');
    }

    await addCashMovement({
      storeId: options.storeId,
      type: 'expense',
      amount: expense.amount,
      paymentMethod: expense.paymentMethod,
      motif: `Dépense — ${expense.category}`,
      referenceType: 'expense',
      referenceId: id,
      date: expense.date,
      userId: options.userId,
    });

    await db.update(expenses).set({ approvalStatus: 'approved' }).where(eq(expenses.id, id));
    return (await getExpense(id))!;
  });
}

/* ------------------------------------------------------------------ *
 * Écriture — modification
 * ------------------------------------------------------------------ */

function cashRelevantChanges(previous: ExpenseRow, next: ExpenseRow): boolean {
  return (
    next.amount !== previous.amount ||
    next.paymentMethod !== previous.paymentMethod ||
    next.date !== previous.date ||
    next.category !== previous.category
  );
}

/**
 * Modification d'une dépense. Une dépense déjà décaissée n'a jamais son
 * mouvement de caisse modifié : on le **contre-passe** puis on enregistre le
 * nouveau, dans la même transaction.
 */
export async function updateExpense(
  id: number,
  patch: ExpensePatch,
  options: { userId?: number | null; storeId?: number | null; canSkipApproval?: boolean } = {},
): Promise<ExpenseRow> {
  return withTransaction(async () => {
    const previous = await getExpense(id);
    if (!previous) throw new NotFoundError('Dépense introuvable');
    assertSameStore(previous, options.storeId);
    if (previous.cancelled) {
      throw new ValidationError('Cette dépense est annulée : elle ne peut plus être modifiée');
    }
    if (previous.approvalStatus === 'rejected') {
      throw new ValidationError('Une dépense rejetée ne peut plus être modifiée');
    }

    const next: ExpenseRow = {
      ...previous,
      category: patch.category !== undefined ? await validateExpenseCategory(patch.category) : previous.category,
      amount: patch.amount !== undefined ? validateAmount(patch.amount) : previous.amount,
      paymentMethod:
        patch.paymentMethod !== undefined ? optionalText(patch.paymentMethod) ?? 'Espèces' : previous.paymentMethod,
      date: patch.date !== undefined ? validateBusinessDate(patch.date) : previous.date,
      description: patch.description !== undefined ? optionalText(patch.description) : previous.description,
      beneficiary: patch.beneficiary !== undefined ? optionalText(patch.beneficiary) : previous.beneficiary,
      referenceType: patch.referenceType !== undefined ? patch.referenceType : previous.referenceType,
      referenceId: patch.referenceId !== undefined ? patch.referenceId : previous.referenceId,
    };

    /*
     * Une hausse de montant au-delà du seuil d'approbation ne doit pas
     * contourner le circuit (avant v2 : on pouvait saisir 100 000 GNF, puis
     * passer la dépense approuvée à 10 000 000 GNF). Pas encore décaissée →
     * elle repart « en attente » ; déjà décaissée → refus, il faut l'annuler et
     * la ressaisir.
     */
    const threshold = Number((await getSettings()).expenseApprovalThreshold ?? 0) || 0;
    const needsNewApproval =
      threshold > 0 && next.amount > threshold && next.amount > previous.amount + 0.001 && !options.canSkipApproval;
    let approvalReset = false;
    if (needsNewApproval && previous.approvalStatus === 'approved') {
      throw new ValidationError(
        `Cette dépense est déjà décaissée : porter son montant au-delà de ${formatCurrency(threshold)} exige une nouvelle approbation. Annulez-la puis ressaisissez-la.`,
      );
    }
    if (needsNewApproval && previous.approvalStatus === 'to_pay') approvalReset = true;

    await db
      .update(expenses)
      .set({
        ...(approvalReset ? { approvalStatus: 'pending', approvedBy: null, approvedAt: null } : {}),
        category: next.category,
        amount: next.amount,
        paymentMethod: next.paymentMethod,
        date: next.date,
        description: next.description,
        beneficiary: next.beneficiary,
        referenceType: next.referenceType,
        referenceId: next.referenceId,
      })
      .where(eq(expenses.id, id));

    if (previous.approvalStatus === 'approved' && cashRelevantChanges(previous, next)) {
      const userId = options.userId ?? previous.userId ?? null;
      const storeId = Number(previous.storeId);
      await addCashMovement({
        storeId,
        type: 'income',
        amount: previous.amount,
        paymentMethod: previous.paymentMethod,
        motif: `Contre-passation — Dépense ${previous.category} (modification)`,
        referenceType: 'expense',
        referenceId: id,
        date: previous.date,
        userId,
      });
      await addCashMovement({
        storeId,
        type: 'expense',
        amount: next.amount,
        paymentMethod: next.paymentMethod,
        motif: `Dépense — ${next.category}`,
        referenceType: 'expense',
        referenceId: id,
        date: next.date,
        userId,
      });
    }

    const result = await getExpense(id);
    if (!result) throw new Error('Dépense introuvable après modification');
    return result;
  });
}

/* ------------------------------------------------------------------ *
 * Écriture — annulation
 * ------------------------------------------------------------------ */

export async function cancelExpense(
  id: number,
  options: { reason: string; userId?: number | null; storeId?: number | null },
): Promise<{ id: number; reason: string }> {
  const reason = String(options.reason ?? '').trim();
  if (!reason) throw new ValidationError("Le motif d'annulation est obligatoire");

  return withTransaction(async () => {
    const previous = await getExpense(id);
    if (!previous) throw new NotFoundError('Dépense introuvable');
    assertSameStore(previous, options.storeId);
    if (previous.cancelled) throw new ValidationError('Cette dépense est déjà annulée');

    await db.update(expenses).set({ deletedAt: new Date() }).where(eq(expenses.id, id));

    // L'argent n'est rendu à la caisse que s'il en était sorti.
    if (previous.approvalStatus === 'approved') {
      await addCashMovement({
        storeId: Number(previous.storeId),
        type: 'income',
        amount: previous.amount,
        paymentMethod: previous.paymentMethod,
        motif: `Annulation dépense — ${previous.category} : ${reason}`,
        referenceType: 'expense',
        referenceId: id,
        date: previous.date,
        userId: options.userId ?? null,
      });
    }

    return { id, reason };
  });
}

/* ------------------------------------------------------------------ *
 * Synthèse — calculée à la lecture
 * ------------------------------------------------------------------ */

export async function getExpensesSummary(options: {
  scope: StoreScope;
  from?: string;
  to?: string;
}): Promise<ExpensesSummary> {
  const where: string[] = [COUNTED_EXPENSE_SQL, scopeSql('store_id', options.scope)];
  const args: (string | number)[] = [];

  if (options.from) {
    where.push('date >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('date <= ?');
    args.push(options.to);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [totals, byCategoryRows, byMonthRows, byStoreRows, pending] = await Promise.all([
    rawGet<{ count: number; total: number | null }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM expenses ${whereSql}`,
      args,
    ),
    rawAll<{ category: string; total: number | null; count: number }>(
      `SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM expenses ${whereSql}
       GROUP BY category
       ORDER BY total DESC, category COLLATE NOCASE`,
      args,
    ),
    rawAll<{ month: string; total: number | null }>(
      `SELECT substr(date, 1, 7) AS month, COALESCE(SUM(amount), 0) AS total
       FROM expenses ${whereSql}
       GROUP BY month
       ORDER BY month ASC`,
      args,
    ),
    rawAll<{ store_id: number; name: string; total: number | null }>(
      `SELECT e.store_id, s.name, COALESCE(SUM(e.amount), 0) AS total
         FROM expenses e JOIN stores s ON s.id = e.store_id
        ${whereSql.replace(/\b(deleted_at|approval_status|store_id|date)\b/g, 'e.$1')}
        GROUP BY e.store_id, s.name ORDER BY total DESC`,
      args,
    ),
    rawGet<{ count: number; total: number | null }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM expenses
        WHERE deleted_at IS NULL AND approval_status IN ('pending', 'to_pay') AND ${scopeSql('store_id', options.scope)}`,
    ),
  ]);

  const expensesCount = Number(totals?.count ?? 0);
  const totalAmount = Number(totals?.total ?? 0);

  return {
    totalAmount,
    expensesCount,
    averageAmount: expensesCount > 0 ? totalAmount / expensesCount : 0,
    pendingCount: Number(pending?.count ?? 0),
    pendingAmount: Number(pending?.total ?? 0),
    byCategory: byCategoryRows.map((row) => ({
      category: row.category,
      total: Number(row.total ?? 0),
      count: Number(row.count ?? 0),
    })),
    byMonth: byMonthRows.map((row) => ({ month: row.month, total: Number(row.total ?? 0) })),
    byStore: byStoreRows.map((row) => ({
      storeId: Number(row.store_id),
      storeName: String(row.name),
      total: Number(row.total ?? 0),
    })),
  };
}
