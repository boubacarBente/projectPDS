/**
 * Caisse et solde (§8, §13).
 *
 * Deux invariants :
 *  1. **une seule session `open` à la fois** ;
 *  2. `balance_after` est recalculé à **chaque** mouvement — le solde
 *     disponible est le dernier `balance_after` de la session ouverte.
 *
 * Chaque mouvement porte son **origine** (`reference_type` / `reference_id`)
 * pour permettre le rapprochement caisse ↔ vente ↔ dépense (§13).
 */

import { db, rawAll, rawGet, rawRun } from '@/db';
import { cashMovements, cashSessions } from '@/db/schema';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { enqueueSyncWrite } from '@/lib/sync';
import { roundMoney, today } from '@/lib/format';

export type CashMovementType = 'income' | 'expense';
export type CashReferenceType = 'sale' | 'payment' | 'purchase' | 'expense' | 'manual';

export class CashSessionError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CashSessionError';
  }
}

export type CashSessionRow = {
  id: number;
  status: 'open' | 'closed';
  openedAt: Date | null;
  openedBy: number | null;
  openingAmount: number;
  closedAt: Date | null;
  closedBy: number | null;
  theoreticalAmount: number | null;
  countedAmount: number | null;
  difference: number | null;
  notes: string | null;
};

/** La session ouverte, ou `null`. */
export async function getOpenSession(): Promise<CashSessionRow | null> {
  const row = await db
    .select()
    .from(cashSessions)
    .where(eq(cashSessions.status, 'open'))
    .orderBy(desc(cashSessions.id))
    .limit(1);

  if (!row[0]) return null;
  return mapSession(row[0]);
}

function mapSession(row: any): CashSessionRow {
  return {
    id: row.id,
    status: row.status,
    openedAt: row.openedAt,
    openedBy: row.openedBy,
    openingAmount: Number(row.openingAmount ?? 0),
    closedAt: row.closedAt,
    closedBy: row.closedBy,
    theoreticalAmount: row.theoreticalAmount == null ? null : Number(row.theoreticalAmount),
    countedAmount: row.countedAmount == null ? null : Number(row.countedAmount),
    difference: row.difference == null ? null : Number(row.difference),
    notes: row.notes,
  };
}

/** Ouvre une session de caisse. Refuse s'il en existe déjà une ouverte. */
export async function openSession(input: {
  openingAmount: number;
  userId?: number | null;
  notes?: string | null;
}): Promise<CashSessionRow> {
  const existing = await getOpenSession();
  if (existing) {
    throw new CashSessionError(
      `Une session de caisse est déjà ouverte (depuis le ${existing.openedAt ? existing.openedAt.toLocaleString('fr-FR') : '—'}). Clôturez-la d'abord.`,
    );
  }

  const openingAmount = Number(input.openingAmount) || 0;

  const inserted = await db
    .insert(cashSessions)
    .values({
      status: 'open',
      openedBy: input.userId ?? null,
      openingAmount,
      theoreticalAmount: openingAmount,
      notes: input.notes?.trim() || null,
    })
    .returning({ id: cashSessions.id, syncId: cashSessions.syncId });

  // Le montant d'ouverture est le premier mouvement de la journée : sans lui,
  // `balance_after` du premier encaissement serait faux.
  if (openingAmount > 0) {
    await db.insert(cashMovements).values({
      type: 'income',
      amount: openingAmount,
      paymentMethod: 'Espèces',
      motif: "Montant d'ouverture de caisse",
      referenceType: 'manual',
      referenceId: null,
      sessionId: inserted[0].id,
      balanceAfter: openingAmount,
      date: today(),
      userId: input.userId ?? null,
    });
  }

  await enqueueSyncWrite('cash_sessions', inserted[0]?.syncId, 'insert', {
    status: 'open',
    opening_amount: openingAmount,
  });

  const session = await getSessionById(inserted[0].id);
  if (!session) throw new Error('Session créée mais introuvable');
  return session;
}

export async function getSessionById(id: number): Promise<CashSessionRow | null> {
  const row = await db.select().from(cashSessions).where(eq(cashSessions.id, id)).limit(1);
  return row[0] ? mapSession(row[0]) : null;
}

/** Solde théorique d'une session : `balance_after` du dernier mouvement. */
export async function getSessionTheoreticalAmount(sessionId: number): Promise<number> {
  const row = await rawGet<{ balance_after: number }>(
    `SELECT balance_after FROM cash_movements
     WHERE session_id = ?
     ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );
  return Number(row?.balance_after ?? 0);
}

/**
 * Montant **théorique par moyen de paiement** : ce que la session devrait
 * contenir en espèces, en Mobile Money, en banque…
 *
 * C'est la seule base honnête pour un comptage : on ne compte pas un tiroir avec
 * l'argent d'un téléphone. Chaque moyen repris à l'ouverture (report du fond de
 * caisse) est inclus, puisqu'il figure comme un mouvement de la session.
 */
export async function getSessionTheoreticalByMethod(
  sessionId: number,
): Promise<{ method: string; theoretical: number }[]> {
  const rows = await rawAll<{ payment_method: string; theoretical: number | null }>(
    `SELECT payment_method,
            SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END) AS theoretical
       FROM cash_movements
      WHERE session_id = ?
      GROUP BY payment_method
      ORDER BY payment_method`,
    [sessionId],
  );

  return rows.map((row) => ({
    method: row.payment_method,
    theoretical: Number(row.theoretical ?? 0),
  }));
}

/** Détail d'un comptage de clôture, par moyen de paiement. */
export type CashCountByMethod = {
  method: string;
  theoretical: number;
  counted: number;
  difference: number;
};

/**
 * Clôture de la session (§8) : le **théorique** est calculé par moyen, le
 * **compté** est saisi par moyen, et l'**écart** de chaque moyen est enregistré —
 * jamais masqué.
 *
 * Le détail par moyen est conservé dans la **note** de la session (lisible par
 * l'utilisateur) et dans le **journal d'actions** (structuré), en attendant une
 * table dédiée ; les colonnes de la session gardent les **totaux**, donc
 * l'historique, les rapports et les exports restent inchangés.
 */
export async function closeSession(input: {
  sessionId: number;
  /** Comptage par moyen (`{ Espèces: 23000000, 'Mobile Money': … }`). */
  countedByMethod?: Record<string, number> | null;
  /** Comptage global, quand l'appelant n'a pas le détail (compatibilité). */
  countedAmount?: number;
  userId?: number | null;
  notes?: string | null;
}): Promise<CashSessionRow & { counts: CashCountByMethod[] }> {
  const session = await getSessionById(input.sessionId);
  if (!session) throw new CashSessionError('Session de caisse introuvable');
  if (session.status === 'closed') throw new CashSessionError('Cette session est déjà clôturée');

  const theoreticals = await getSessionTheoreticalByMethod(input.sessionId);
  const unique = new Map<string, number>();
  for (const row of theoreticals) unique.set(row.method, row.theoretical);

  const counts: CashCountByMethod[] = [];
  for (const [method, theoretical] of unique) {
    const raw = input.countedByMethod?.[method];
    // Un moyen non saisi est réputé compté juste : c'est ce qu'on attend d'un
    // caissier qui n'a touché qu'au tiroir et a relevé le reste.
    const counted = raw === undefined ? theoretical : Math.round(Number(raw) * 100) / 100;
    counts.push({
      method,
      theoretical,
      counted,
      difference: Math.round((counted - theoretical) * 100) / 100,
    });
  }

  const theoretical =
    counts.length > 0
      ? counts.reduce((sum, row) => sum + row.theoretical, 0)
      : await getSessionTheoreticalAmount(input.sessionId);
  const counted =
    counts.length > 0
      ? counts.reduce((sum, row) => sum + row.counted, 0)
      : Number(input.countedAmount) || 0;
  const difference = Math.round((counted - theoretical) * 100) / 100;

  const detailLines = counts.map(
    (row) =>
      `${row.method} : ${row.counted.toLocaleString('fr-FR')} / ${row.theoretical.toLocaleString('fr-FR')}`,
  );
  const detail =
    detailLines.length > 0 ? `Comptage — ${detailLines.join(' · ')}` : null;

  await db
    .update(cashSessions)
    .set({
      status: 'closed',
      closedAt: new Date(),
      closedBy: input.userId ?? null,
      theoreticalAmount: theoretical,
      countedAmount: counted,
      difference,
      notes: [input.notes?.trim(), detail].filter(Boolean).join(' — ') || session.notes,
      updatedAt: new Date(),
    })
    .where(eq(cashSessions.id, input.sessionId));

  const updated = await getSessionById(input.sessionId);
  if (!updated) throw new Error('Session introuvable après clôture');

  await enqueueSyncWrite('cash_sessions', null, 'update', {
    status: 'closed',
    theoretical_amount: theoretical,
    counted_amount: counted,
    difference,
  });

  return { ...updated, counts };
}

/**
 * Enregistre un mouvement de caisse.
 *
 * Si aucune session n'est ouverte, une session est **ouverte automatiquement**
 * avec un montant initial nul : perdre un encaissement parce qu'on a oublié de
 * cliquer sur « Ouvrir la caisse » serait pire que la rigueur du rituel. Le
 * motif le signale explicitement dans l'historique.
 */
export async function addCashMovement(input: {
  type: CashMovementType;
  amount: number;
  paymentMethod?: string;
  motif: string;
  referenceType?: CashReferenceType | null;
  referenceId?: number | null;
  date?: string;
  userId?: number | null;
  /** Force une session précise (import, correction). */
  sessionId?: number | null;
}): Promise<{ id: number; balanceAfter: number; sessionId: number | null }> {
  const amount = Number(input.amount) || 0;
  if (amount < 0) throw new CashSessionError('Le montant d’un mouvement de caisse doit être positif');
  if (amount === 0) throw new CashSessionError('Le montant d’un mouvement de caisse ne peut pas être nul');

  let sessionId = input.sessionId ?? null;

  if (!sessionId) {
    let session = await getOpenSession();
    if (!session) {
      session = await openSession({
        openingAmount: 0,
        userId: input.userId ?? null,
        notes: 'Session ouverte automatiquement par une opération de caisse',
      });
    }
    sessionId = session.id;
  }

  const previous = await rawGet<{ balance_after: number }>(
    `SELECT balance_after FROM cash_movements WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );

  const previousBalance = Number(previous?.balance_after ?? 0);
  const balanceAfter =
    input.type === 'income' ? previousBalance + amount : previousBalance - amount;

  const inserted = await db
    .insert(cashMovements)
    .values({
      type: input.type,
      amount,
      paymentMethod: input.paymentMethod || 'Espèces',
      motif: input.motif,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      sessionId,
      balanceAfter,
      date: input.date ?? today(),
      userId: input.userId ?? null,
    })
    .returning({ id: cashMovements.id, syncId: cashMovements.syncId });

  await enqueueSyncWrite('cash_movements', inserted[0]?.syncId, 'insert', {
    type: input.type,
    amount,
    payment_method: input.paymentMethod || 'Espèces',
    motif: input.motif,
  });

  return { id: inserted[0].id, balanceAfter, sessionId };
}

export type CashMovementRow = {
  id: number;
  type: CashMovementType;
  amount: number;
  paymentMethod: string;
  motif: string;
  referenceType: string | null;
  referenceId: number | null;
  sessionId: number | null;
  balanceAfter: number;
  date: string;
  userId: number | null;
  userName: string | null;
  createdAt: Date | null;
};

export async function listCashMovements(options: {
  type?: CashMovementType;
  paymentMethod?: string;
  sessionId?: number;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
} = {}): Promise<{ data: CashMovementRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];
  if (options.type) conditions.push(eq(cashMovements.type, options.type));
  if (options.paymentMethod) conditions.push(eq(cashMovements.paymentMethod, options.paymentMethod));
  if (options.sessionId) conditions.push(eq(cashMovements.sessionId, options.sessionId));
  if (options.from) conditions.push(gte(cashMovements.date, options.from));
  if (options.to) conditions.push(lte(cashMovements.date, options.to));
  if (options.search) {
    conditions.push(sql`${cashMovements.motif} LIKE ${`%${options.search}%`}`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalResult] = await Promise.all([
    db.query.cashMovements.findMany({
      where,
      orderBy: [desc(cashMovements.date), desc(cashMovements.id)],
      with: { user: { columns: { name: true } } },
      limit,
      offset,
    }),
    db.select({ count: sql<number>`count(*)` }).from(cashMovements).where(where),
  ]);

  const total = Number(totalResult[0]?.count ?? 0);

  return {
    data: rows.map((m) => ({
      id: m.id,
      type: m.type as CashMovementType,
      amount: Number(m.amount),
      paymentMethod: m.paymentMethod,
      motif: m.motif,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      sessionId: m.sessionId,
      balanceAfter: Number(m.balanceAfter),
      date: m.date,
      userId: m.userId,
      userName: m.user?.name ?? null,
      createdAt: m.createdAt,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/** Solde de caisse disponible : dernier `balance_after` connu, toutes sessions. */
export async function getCashBalance(): Promise<number> {
  const row = await rawGet<{ balance_after: number }>(
    `SELECT balance_after FROM cash_movements ORDER BY id DESC LIMIT 1`,
  );
  return Number(row?.balance_after ?? 0);
}

/**
 * **Reconstruit `balance_after` de tous les mouvements**, dans l'ordre des
 * identifiants, en repartant de zéro à chaque session.
 *
 * Pourquoi cette fonction existe : `balance_after` est un **solde courant**, et
 * le solde de caisse affiché est celui du **dernier** mouvement
 * (`getCashBalance()`). Supprimer une partie des mouvements — ce que fait une
 * réinitialisation partielle, par exemple celle de la briqueterie — laisse donc
 * les soldes suivants faux : ils incluent encore l'argent d'opérations qui
 * n'existent plus, et la caisse annonce un montant trop élevé.
 *
 * La règle de reconstruction est exactement celle d'`addCashMovement()` :
 *  - chaque session repart de son solde d'ouverture (le mouvement
 *    « Montant d'ouverture de caisse » est un `income` ordinaire) ;
 *  - `income` ajoute, `expense` retire ;
 *  - les mouvements sans session (imports, corrections) forment une série à
 *    part, démarrant à zéro.
 *
 * Fonction de **réparation** : elle ne crée ni ne supprime aucune ligne, elle
 * réécrit uniquement `balance_after`, et ne déclenche donc aucune écriture de
 * synchronisation (le solde n'est pas une donnée à transmettre, il se recalcule).
 */
export async function recalculateCashBalances(): Promise<{ movements: number }> {
  const rows = await rawAll<{ id: number; session_id: number | null; type: string; amount: number }>(
    `SELECT id, session_id, type, amount FROM cash_movements ORDER BY id ASC`,
  );

  let currentSession: number | null | undefined = undefined;
  let running = 0;
  let updated = 0;

  for (const row of rows) {
    if (row.session_id !== currentSession) {
      currentSession = row.session_id;
      running = 0;
    }

    running = roundMoney(
      row.type === 'income' ? running + Number(row.amount ?? 0) : running - Number(row.amount ?? 0),
    );

    await rawRun('UPDATE cash_movements SET balance_after = ? WHERE id = ?', [running, row.id]);
    updated += 1;
  }

  return { movements: updated };
}

export type CashSummary = {
  balance: number;
  openingAmount: number;
  sessionStatus: 'open' | 'closed';
  sessionId: number | null;
  /**
   * Sur quoi portent les totaux (`incomeTotal`, `expenseTotal`, `byMethod`) :
   *  - `session` : la session **ouverte** ;
   *  - `lastClosed` : la **dernière session clôturée** — il n'y a plus de session
   *    ouverte, mais les chiffres gardent un sens et un libellé ;
   *  - `all` : tout l'historique (aucun filtre).
   *
   * Sans ce champ, l'écran affichait « Entrées de la session » au-dessus de
   * l'historique complet : de quoi croire que la clôture avait tout effacé.
   */
  scope: 'session' | 'lastClosed' | 'all';
  /** Session décrite par les totaux (ouverte ou dernière clôturée). */
  scopeSessionId: number | null;
  /** Date de clôture de la session décrite, quand elle est clôturée. */
  scopeClosedAt: Date | null;
  incomeTotal: number;
  expenseTotal: number;
  byMethod: { method: string; income: number; expense: number; net: number }[];
  movementsCount: number;
};

/** Dernière session clôturée : référence quand aucune session n'est ouverte. */
export async function getLastClosedSession(): Promise<CashSessionRow | null> {
  const row = await db
    .select()
    .from(cashSessions)
    .where(eq(cashSessions.status, 'closed'))
    .orderBy(desc(cashSessions.id))
    .limit(1);

  return row[0] ? mapSession(row[0]) : null;
}

/** Résumé de caisse sur une période, avec répartition Espèces / Mobile Money (§8). */
export async function getCashSummary(options: { from?: string; to?: string } = {}): Promise<CashSummary> {
  const session = await getOpenSession();
  const balance = await getCashBalance();

  /*
   * Sur quoi portent les totaux ? La session ouverte si elle existe ; sinon la
   * **dernière session clôturée** — jamais « tout l'historique » en silence.
   */
  let scope: CashSummary['scope'] = 'all';
  let scopeSessionId: number | null = null;
  let scopeClosedAt: Date | null = null;

  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (session) {
    scope = 'session';
    scopeSessionId = session.id;
    conditions.push('session_id = ?');
    args.push(session.id);
  } else if (options.from && options.to) {
    conditions.push('date >= ? AND date <= ?');
    args.push(options.from, options.to);
  } else {
    const lastClosed = await getLastClosedSession();
    if (lastClosed) {
      scope = 'lastClosed';
      scopeSessionId = lastClosed.id;
      scopeClosedAt = lastClosed.closedAt;
      conditions.push('session_id = ?');
      args.push(lastClosed.id);
    }
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totals = await rawGet<{ income: number | null; expense: number | null; count: number }>(
    `SELECT SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) AS income,
            SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense,
            COUNT(*) AS count
     FROM cash_movements ${whereSql}`,
    args,
  );

  const byMethod = await rawAll<{ payment_method: string; income: number; expense: number }>(
    `SELECT payment_method,
            SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END)  AS income,
            SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense
     FROM cash_movements ${whereSql}
     GROUP BY payment_method
     ORDER BY payment_method`,
    args,
  );

  return {
    balance,
    openingAmount: session?.openingAmount ?? 0,
    sessionStatus: session ? 'open' : 'closed',
    sessionId: session?.id ?? null,
    scope,
    scopeSessionId,
    scopeClosedAt,
    incomeTotal: Number(totals?.income ?? 0),
    expenseTotal: Number(totals?.expense ?? 0),
    byMethod: byMethod.map((m) => ({
      method: m.payment_method,
      income: Number(m.income ?? 0),
      expense: Number(m.expense ?? 0),
      net: Number(m.income ?? 0) - Number(m.expense ?? 0),
    })),
    movementsCount: Number(totals?.count ?? 0),
  };
}

export type CashSessionHistoryRow = CashSessionRow & {
  openedByName: string | null;
  closedByName: string | null;
  movementsCount: number;
};

export async function listCashSessions(options: { limit?: number } = {}): Promise<CashSessionHistoryRow[]> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 30));

  const rows = await rawAll<any>(
    `SELECT s.*,
            (SELECT name FROM users WHERE id = s.opened_by) AS opened_by_name,
            (SELECT name FROM users WHERE id = s.closed_by) AS closed_by_name,
            (SELECT COUNT(*) FROM cash_movements WHERE session_id = s.id) AS movements_count
     FROM cash_sessions s
     ORDER BY s.id DESC
     LIMIT ?`,
    [limit],
  );

  return rows.map((row) => ({
    ...mapSession(row),
    openedByName: row.opened_by_name ?? null,
    closedByName: row.closed_by_name ?? null,
    movementsCount: Number(row.movements_count ?? 0),
  }));
}

export const CASH_REFERENCE_LABELS: Record<string, string> = {
  sale: 'Vente',
  payment: 'Encaissement',
  purchase: 'Achat',
  expense: 'Dépense',
  manual: 'Manuel',
};
