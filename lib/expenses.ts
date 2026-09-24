/**
 * Dépenses (§7.9, §9, §14).
 *
 * Deux invariants portent tout le module :
 *
 *  1. **Une dépense sort de la caisse — systématiquement.** Chaque écriture
 *     (création, modification, annulation) laisse une trace dans
 *     `cash_movements` via `addCashMovement()` ; c'est ce qui permet le
 *     rapprochement caisse ↔ dépense (§13) et le calcul du **bénéfice net**
 *     (§15 : bénéfice brut − dépenses de la période).
 *
 *  2. **Une dépense ne touche JAMAIS le stock.** Ce fichier n'importe pas
 *     `lib/stock.ts` et n'écrit pas une seule ligne dans `stock_movements` :
 *     c'est exactement la différence de fond avec un achat (§5, §14), qui, lui,
 *     fait entrer des marchandises et suit une dette fournisseur.
 *
 * La **catégorie** est une liste fermée issue de `settings.expenseCategories`
 * (§6.6 : pas de table `expense_categories`) : jamais de saisie libre, sinon
 * les rapports par catégorie deviennent faux — « Transport » ≠ « transport ».
 * La valeur enregistrée est toujours celle des paramètres (casse canonique).
 *
 * **Annulation, jamais de suppression physique** (§6.5 règle 4, §26.13) : un
 * `DELETE` ferait ressusciter la ligne au prochain pull de synchronisation.
 * La table `expenses` ne porte pas de colonnes `status` / `cancel_reason` /
 * `cancelled_at` (schéma figé — hors périmètre de ce module), l'annulation
 * s'appuie donc sur le **tombstone** `deleted_at` prévu au §6.7 : la dépense
 * n'est plus comptée, rien n'est effacé, la caisse est contre-passée, et le
 * motif obligatoire est journalisé par `writeAudit` côté Route Handler.
 */

import { db, rawAll, rawGet } from '@/db';
import { expenses } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ValidationError, NotFoundError } from '@/lib/api';
import { addCashMovement } from '@/lib/caisse';
import { getSettings } from '@/lib/settings';
import { roundMoney } from '@/lib/format';
import { enqueueSyncWrite } from '@/lib/sync';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type ExpenseRow = {
  id: number;
  category: string;
  amount: number;
  description: string | null;
  paymentMethod: string;
  /** `expense` pour un mouvement né d'une dépense ; colonne polymorphe (§6.3). */
  referenceType: string | null;
  referenceId: number | null;
  beneficiary: string | null;
  /** Date **métier** `YYYY-MM-DD` — le seul champ filtré (§6.5 règle 2). */
  date: string;
  userId: number | null;
  userName: string | null;
  /** Annulée = tombstone `deleted_at` posé : plus comptée, jamais effacée. */
  cancelled: boolean;
  createdAt: Date | null;
};

export type ExpenseInput = {
  category: string;
  amount: number;
  description?: string | null;
  paymentMethod?: string;
  referenceType?: string | null;
  referenceId?: number | null;
  beneficiary?: string | null;
  date: string;
  /** Auteur de l'opération — reporté sur la dépense et sur le mouvement de caisse. */
  userId?: number | null;
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
  search?: string;
  category?: string;
  paymentMethod?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  /** Réservé aux rapports d'audit : par défaut, une dépense annulée disparaît. */
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
  byCategory: { category: string; total: number; count: number }[];
  byMonth: { month: string; total: number }[];
};

/* ------------------------------------------------------------------ *
 * Validation — tout est vérifié AVANT la moindre écriture
 * ------------------------------------------------------------------ */

/**
 * Vérifie la catégorie contre la **liste fermée** `settings.expenseCategories`
 * et renvoie la casse canonique des paramètres (jamais la saisie brute).
 * Refus explicite en français si elle n'y figure pas.
 */
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

function mapExpenseRow(row: any): ExpenseRow {
  return {
    id: Number(row.id),
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
    cancelled: row.deleted_at != null,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

/**
 * Liste paginée, filtrée, avec le nom de l'utilisateur (README §27.2).
 *
 * Le filtre de période porte sur `date` (date métier), **jamais** sur
 * `created_at` : `BETWEEN '2026-01-15' AND '2026-01-15'` sur un horodatage
 * renverrait zéro ligne (§6.5 règle 2).
 */
export async function listExpenses(options: ExpenseListOptions = {}): Promise<ExpenseListResult> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  // Une dépense annulée n'est plus comptée : elle sort de la liste par défaut.
  if (!options.includeCancelled) where.push('e.deleted_at IS NULL');
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

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await rawAll<any>(
    `SELECT e.id, e.category, e.amount, e.description, e.payment_method, e.reference_type,
            e.reference_id, e.beneficiary, e.date, e.user_id, e.created_at, e.deleted_at,
            u.name AS user_name
     FROM expenses e
     LEFT JOIN users u ON u.id = e.user_id
     ${whereSql}
     ORDER BY e.date DESC, e.id DESC
     LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const countRow = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM expenses e ${whereSql}`,
    args,
  );

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
  const row = await rawGet<any>(
    `SELECT e.id, e.category, e.amount, e.description, e.payment_method, e.reference_type,
            e.reference_id, e.beneficiary, e.date, e.user_id, e.created_at, e.deleted_at,
            u.name AS user_name
     FROM expenses e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ?`,
    [id],
  );

  return row ? mapExpenseRow(row) : null;
}

/* ------------------------------------------------------------------ *
 * Écriture — création
 * ------------------------------------------------------------------ */

/**
 * Création d'une dépense. Ordre imposé (§14) :
 *  1. valider la catégorie contre la liste fermée des paramètres ;
 *  2. insérer la dépense ;
 *  3. **sortir l'argent de la caisse** (`cash_movements`, type `expense`) ;
 *  4. mettre l'écriture en file de synchronisation.
 *
 * Aucune ligne de stock n'est écrite — ni ici, ni nulle part dans ce module.
 */
export async function createExpense(input: ExpenseInput): Promise<ExpenseRow> {
  const category = await validateExpenseCategory(input.category);
  const amount = validateAmount(input.amount);
  const date = validateBusinessDate(input.date);
  const paymentMethod = optionalText(input.paymentMethod) ?? 'Espèces';
  const description = optionalText(input.description);
  const beneficiary = optionalText(input.beneficiary);

  const inserted = await db
    .insert(expenses)
    .values({
      category,
      amount,
      description,
      paymentMethod,
      referenceType: input.referenceType ?? 'expense',
      referenceId: input.referenceId ?? null,
      beneficiary,
      date,
      userId: input.userId ?? null,
    })
    .returning({ id: expenses.id, syncId: expenses.syncId });

  const id = inserted[0].id;

  try {
    // Sortie de caisse **systématique** (§14) : c'est le cœur du module.
    await addCashMovement({
      type: 'expense',
      amount,
      paymentMethod,
      motif: `Dépense — ${category}`,
      referenceType: 'expense',
      referenceId: id,
      date,
      userId: input.userId ?? null,
    });
  } catch (error) {
    // Compensation : sans mouvement de caisse, la dépense ne doit pas compter,
    // sinon la caisse et les dépenses divergent (le solde serait trop haut).
    // Rien n'est effacé : la ligne est marquée annulée (tombstone, §6.7).
    const now = new Date();
    await db
      .update(expenses)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(expenses.id, id));

    await enqueueSyncWrite('expenses', inserted[0]?.syncId, 'delete', {
      deleted_at: now.toISOString(),
      reason: "Échec de l'écriture en caisse",
    });

    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(
      `La dépense n'a pas été enregistrée : la sortie de caisse a échoué (${message}). Aucune dépense n'a été conservée.`,
    );
  }

  await enqueueSyncWrite('expenses', inserted[0]?.syncId, 'insert', {
    category,
    amount,
    description,
    payment_method: paymentMethod,
    beneficiary,
    date,
  });

  const created = await getExpense(id);
  if (!created) throw new Error('Dépense créée mais introuvable');
  return created;
}

/* ------------------------------------------------------------------ *
 * Écriture — modification
 * ------------------------------------------------------------------ */

/**
 * Champs qui apparaissent **sur le mouvement de caisse** : s'ils changent, la
 * caisse doit être réécrite, sinon elle raconte une autre histoire que la
 * dépense (montant, moyen de paiement, date du mouvement, catégorie du motif).
 */
function cashRelevantChanges(previous: ExpenseRow, next: ExpenseRow): boolean {
  return (
    next.amount !== previous.amount ||
    next.paymentMethod !== previous.paymentMethod ||
    next.date !== previous.date ||
    next.category !== previous.category
  );
}

/**
 * Modification d'une dépense déjà sortie de caisse.
 *
 * **Décision assumée** : on ne modifie jamais le mouvement de caisse existant
 * (il est immuable, comme toute pièce comptable) ; on **contre-passe** l'ancien
 * par un mouvement inverse motivé, puis on enregistre le nouveau. La caisse
 * porte donc l'historique complet de la correction, et son solde reste juste :
 *
 *   dépense initiale   : sortie de 500 000 GNF
 *   modification à 700 000 : entrée de 500 000 (contre-passation) puis sortie de 700 000
 *
 * Le contre-passé d'une dépense est une **entrée** (`income`) : l'argent
 * revient en caisse avant que le nouveau montant n'en sorte.
 *
 * Si rien de « caisse » ne change (description, bénéficiaire), aucun mouvement
 * n'est créé : ce serait du bruit dans l'historique de caisse.
 *
 * ⚠️ Limite connue : l'idéal serait une transaction unique (ligne + caisse).
 * `addCashMovement()` ouvre sa propre écriture et vit dans `lib/caisse.ts`, qui
 * est **hors périmètre** de ce module : les écritures sont donc séquentielles.
 * Toutes les validations sont faites **avant** la première écriture, ce qui
 * élimine tout échec métier en cours de route ; seul un échec brut de la base
 * pourrait laisser la caisse en retard, et le message le dit explicitement.
 */
export async function updateExpense(
  id: number,
  patch: ExpensePatch,
  options: { userId?: number | null } = {},
): Promise<ExpenseRow> {
  const previous = await getExpense(id);
  if (!previous) throw new NotFoundError('Dépense introuvable');
  if (previous.cancelled) {
    throw new ValidationError('Cette dépense est annulée : elle ne peut plus être modifiée');
  }

  // 1. Tout valider d'abord (aucune écriture partielle possible).
  const next: ExpenseRow = {
    ...previous,
    category:
      patch.category !== undefined ? await validateExpenseCategory(patch.category) : previous.category,
    amount: patch.amount !== undefined ? validateAmount(patch.amount) : previous.amount,
    paymentMethod:
      patch.paymentMethod !== undefined
        ? optionalText(patch.paymentMethod) ?? 'Espèces'
        : previous.paymentMethod,
    date: patch.date !== undefined ? validateBusinessDate(patch.date) : previous.date,
    description: patch.description !== undefined ? optionalText(patch.description) : previous.description,
    beneficiary: patch.beneficiary !== undefined ? optionalText(patch.beneficiary) : previous.beneficiary,
    referenceType:
      patch.referenceType !== undefined ? patch.referenceType : previous.referenceType,
    referenceId: patch.referenceId !== undefined ? patch.referenceId : previous.referenceId,
  };

  // 2. Mettre à jour la dépense (source de vérité de l'intention).
  const dbPatch: Record<string, unknown> = {
    category: next.category,
    amount: next.amount,
    paymentMethod: next.paymentMethod,
    date: next.date,
    description: next.description,
    beneficiary: next.beneficiary,
    referenceType: next.referenceType,
    referenceId: next.referenceId,
    updatedAt: new Date(),
  };

  const updated = await db
    .update(expenses)
    .set(dbPatch as any)
    .where(eq(expenses.id, id))
    .returning({ id: expenses.id, syncId: expenses.syncId });

  if (updated.length === 0) throw new NotFoundError('Dépense introuvable');

  await enqueueSyncWrite('expenses', updated[0].syncId, 'update', {
    category: next.category,
    amount: next.amount,
    description: next.description,
    payment_method: next.paymentMethod,
    beneficiary: next.beneficiary,
    date: next.date,
  });

  // 3. Réécrire la caisse uniquement si un champ monétaire a bougé.
  if (cashRelevantChanges(previous, next)) {
    const userId = options.userId ?? previous.userId ?? null;

    try {
      await addCashMovement({
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
        type: 'expense',
        amount: next.amount,
        paymentMethod: next.paymentMethod,
        motif: `Dépense — ${next.category}`,
        referenceType: 'expense',
        referenceId: id,
        date: next.date,
        userId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(
        `La dépense a été modifiée, mais la caisse n'a pas pu être réécrite (${message}). Vérifiez la caisse : elle doit être corrigée manuellement.`,
      );
    }
  }

  const result = await getExpense(id);
  if (!result) throw new Error('Dépense introuvable après modification');
  return result;
}

/* ------------------------------------------------------------------ *
 * Écriture — annulation (jamais de suppression physique)
 * ------------------------------------------------------------------ */

/**
 * Annulation d'une dépense (§6.5 règle 4, §26.13).
 *
 *  - la dépense n'est **plus comptée** (tombstone `deleted_at`) ;
 *  - l'argent **revient en caisse** par un mouvement inverse motivé ;
 *  - **rien n'est effacé** : la ligne reste, le motif obligatoire et l'auteur
 *    sont tracés (audit + payload de synchronisation).
 */
export async function cancelExpense(
  id: number,
  options: { reason: string; userId?: number | null },
): Promise<{ id: number; reason: string }> {
  const reason = String(options.reason ?? '').trim();
  if (!reason) throw new ValidationError("Le motif d'annulation est obligatoire");

  const previous = await getExpense(id);
  if (!previous) throw new NotFoundError('Dépense introuvable');
  if (previous.cancelled) throw new ValidationError('Cette dépense est déjà annulée');

  const now = new Date();

  const updated = await db
    .update(expenses)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(expenses.id, id))
    .returning({ syncId: expenses.syncId });

  try {
    // Mouvement inverse : la sortie de caisse d'origine est contre-passée par
    // une entrée du même montant, au même moyen de paiement et à la même date.
    await addCashMovement({
      type: 'income',
      amount: previous.amount,
      paymentMethod: previous.paymentMethod,
      motif: `Annulation dépense — ${previous.category} : ${reason}`,
      referenceType: 'expense',
      referenceId: id,
      date: previous.date,
      userId: options.userId ?? null,
    });
  } catch (error) {
    // Compensation : sans retour en caisse, l'annulation ne doit pas être
    // conservée, sinon la caisse resterait débitée d'une dépense non comptée.
    const restored = new Date();
    await db
      .update(expenses)
      .set({ deletedAt: null, updatedAt: restored })
      .where(eq(expenses.id, id));

    await enqueueSyncWrite('expenses', updated[0]?.syncId, 'update', {
      deleted_at: null,
      restored_at: restored.toISOString(),
    });

    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(
      `L'annulation a échoué : le retour en caisse n'a pas pu être enregistré (${message}). La dépense reste valide.`,
    );
  }

  await enqueueSyncWrite('expenses', updated[0]?.syncId, 'delete', {
    deleted_at: now.toISOString(),
    cancel_reason: reason,
    cancelled_by: options.userId ?? null,
  });

  return { id, reason };
}

/* ------------------------------------------------------------------ *
 * Synthèse — toujours calculée à la lecture, jamais stockée (§6.5 règle 6)
 * ------------------------------------------------------------------ */

/**
 * Synthèse d'une période : total, nombre, moyenne, répartition par catégorie
 * et par mois (`YYYY-MM`). Les dépenses annulées sont exclues.
 */
export async function getExpensesSummary(
  options: { from?: string; to?: string } = {},
): Promise<ExpensesSummary> {
  const where: string[] = ['deleted_at IS NULL'];
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

  const [totals, byCategoryRows, byMonthRows] = await Promise.all([
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
  ]);

  const expensesCount = Number(totals?.count ?? 0);
  const totalAmount = Number(totals?.total ?? 0);

  return {
    totalAmount,
    expensesCount,
    averageAmount: expensesCount > 0 ? totalAmount / expensesCount : 0,
    byCategory: byCategoryRows.map((row) => ({
      category: row.category,
      total: Number(row.total ?? 0),
      count: Number(row.count ?? 0),
    })),
    byMonth: byMonthRows.map((row) => ({
      month: row.month,
      total: Number(row.total ?? 0),
    })),
  };
}
