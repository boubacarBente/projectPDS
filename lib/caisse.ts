/**
 * Caisse et solde (§8, §13 ; multi-magasins §11).
 *
 * Chaque magasin a sa caisse : sessions et mouvements portent `store_id`.
 *
 * Deux invariants :
 *  1. **une seule session `open` à la fois par magasin** ;
 *  2. `balance_after` est recalculé à **chaque** mouvement — le solde
 *     disponible est le dernier `balance_after` de la session ouverte.
 *
 * Chaque mouvement porte son **origine** (`reference_type` / `reference_id`)
 * pour permettre le rapprochement caisse ↔ vente ↔ dépense (§13).
 */

import { db, rawAll, rawGet, rawRun, withTransaction } from '@/db';
import { cashMovements, cashSessions } from '@/db/schema';
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { scopeSql, type StoreScope } from '@/lib/stores';
import { roundMoney, today } from '@/lib/format';

export type CashMovementType = 'income' | 'expense';
export type CashReferenceType = 'sale' | 'payment' | 'purchase' | 'expense' | 'manual' | 'service_job';

export class CashSessionError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CashSessionError';
  }
}

export type CashSessionRow = {
  id: number;
  storeId: number | null;
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

/** La session ouverte du magasin, ou `null`. */
export async function getOpenSession(storeId: number): Promise<CashSessionRow | null> {
  const row = await db
    .select()
    .from(cashSessions)
    .where(and(eq(cashSessions.status, 'open'), eq(cashSessions.storeId, storeId)))
    .orderBy(desc(cashSessions.id))
    .limit(1);

  if (!row[0]) return null;
  return mapSession(row[0]);
}

function mapSession(row: any): CashSessionRow {
  return {
    id: row.id,
    storeId: row.storeId ?? row.store_id ?? null,
    status: row.status,
    openedAt: row.openedAt ?? (row.opened_at ? new Date(Number(row.opened_at) * 1000) : null),
    openedBy: row.openedBy ?? row.opened_by ?? null,
    openingAmount: Number(row.openingAmount ?? row.opening_amount ?? 0),
    closedAt: row.closedAt ?? (row.closed_at ? new Date(Number(row.closed_at) * 1000) : null),
    closedBy: row.closedBy ?? row.closed_by ?? null,
    theoreticalAmount:
      (row.theoreticalAmount ?? row.theoretical_amount) == null ? null : Number(row.theoreticalAmount ?? row.theoretical_amount),
    countedAmount: (row.countedAmount ?? row.counted_amount) == null ? null : Number(row.countedAmount ?? row.counted_amount),
    difference: row.difference == null ? null : Number(row.difference),
    notes: row.notes,
  };
}

/** Ouvre une session de caisse. Refuse s'il en existe déjà une ouverte. */
export async function openSession(input: {
  storeId: number;
  openingAmount: number;
  userId?: number | null;
  notes?: string | null;
}): Promise<CashSessionRow> {
  return withTransaction(() => openSessionInTx(input));
}

async function openSessionInTx(input: {
  storeId: number;
  openingAmount: number;
  userId?: number | null;
  notes?: string | null;
}): Promise<CashSessionRow> {
  const existing = await getOpenSession(input.storeId);
  if (existing) {
    throw new CashSessionError(
      `Une session de caisse est déjà ouverte (depuis le ${existing.openedAt ? existing.openedAt.toLocaleString('fr-FR') : '—'}). Clôturez-la d'abord.`,
    );
  }

  const openingAmount = Number(input.openingAmount) || 0;

  const inserted = await db
    .insert(cashSessions)
    .values({
      storeId: input.storeId,
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
      storeId: input.storeId,
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

  const session = await getSessionById(inserted[0].id);
  if (!session) throw new Error('Session créée mais introuvable');
  return session;
}

export async function getSessionById(id: number): Promise<CashSessionRow | null> {
  const row = await db.select().from(cashSessions).where(eq(cashSessions.id, id)).limit(1);
  return row[0] ? mapSession(row[0]) : null;
}

/** Solde théorique d'une session : somme algébrique de ses mouvements. */
export async function getSessionTheoreticalAmount(sessionId: number): Promise<number> {
  const row = await rawGet<{ balance: number | null }>(
    `SELECT SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END) AS balance
       FROM cash_movements
      WHERE session_id = ? AND deleted_at IS NULL`,
    [sessionId],
  );
  return roundMoney(Number(row?.balance ?? 0));
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
  /** Magasin de l'utilisateur : la session doit lui appartenir. */
  storeId: number;
  sessionId: number;
  /** Comptage par moyen (`{ Espèces: 23000000, 'Mobile Money': … }`). */
  countedByMethod?: Record<string, number> | null;
  /** Comptage global, quand l'appelant n'a pas le détail (compatibilité). */
  countedAmount?: number;
  userId?: number | null;
  notes?: string | null;
}): Promise<CashSessionRow & { counts: CashCountByMethod[] }> {
  return withTransaction(async () => {
  const session = await getSessionById(input.sessionId);
  if (!session || session.storeId !== input.storeId) throw new CashSessionError('Session de caisse introuvable');
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

  return { ...updated, counts };
  });
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
  /** Magasin dont la caisse est mouvementée — obligatoire. */
  storeId: number;
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

  if (!input.storeId) throw new CashSessionError('Magasin obligatoire pour un mouvement de caisse');

  return withTransaction(async () => {
  let sessionId = input.sessionId ?? null;

  if (!sessionId) {
    let session = await getOpenSession(input.storeId);
    if (!session) {
      session = await openSessionInTx({
        storeId: input.storeId,
        openingAmount: 0,
        userId: input.userId ?? null,
        notes: 'Session ouverte automatiquement par une opération de caisse',
      });
    }
    sessionId = session.id;
  }

  // Solde = somme de la session (et non « dernier balance_after ») : des
  // mouvements reçus par synchronisation peuvent avoir un identifiant local
  // qui ne suit pas l'ordre chronologique.
  const previousBalance = await getSessionTheoreticalAmount(sessionId);
  const balanceAfter =
    input.type === 'income' ? previousBalance + amount : previousBalance - amount;

  const inserted = await db
    .insert(cashMovements)
    .values({
      storeId: input.storeId,
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

  return { id: inserted[0].id, balanceAfter, sessionId };
  });
}

export type CashMovementRow = {
  id: number;
  storeId: number | null;
  storeName: string | null;
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
  scope: StoreScope;
  type?: CashMovementType;
  paymentMethod?: string;
  sessionId?: number;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<{ data: CashMovementRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [
    options.scope.length > 0 ? inArray(cashMovements.storeId, options.scope) : sql`0 = 1`,
  ];
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
      with: { user: { columns: { name: true } }, store: { columns: { name: true } } },
      limit,
      offset,
    }),
    db.select({ count: sql<number>`count(*)` }).from(cashMovements).where(where),
  ]);

  const total = Number(totalResult[0]?.count ?? 0);

  return {
    data: rows.map((m) => ({
      id: m.id,
      storeId: m.storeId ?? null,
      storeName: m.store?.name ?? null,
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

/**
 * Solde de caisse disponible d'un ou plusieurs magasins : pour chaque magasin,
 * le solde de sa session la plus récente (ouverte ou dernière clôturée).
 */
export async function getCashBalance(scope: StoreScope): Promise<number> {
  const rows = await rawAll<{ balance: number | null }>(
    `SELECT (SELECT SUM(CASE WHEN m.type = 'income' THEN m.amount ELSE -m.amount END)
               FROM cash_movements m WHERE m.session_id = cs.id AND m.deleted_at IS NULL) AS balance
       FROM cash_sessions cs
      WHERE ${scopeSql('cs.store_id', scope)}
        AND cs.id = (SELECT c2.id FROM cash_sessions c2 WHERE c2.store_id = cs.store_id
                      ORDER BY c2.opened_at DESC, c2.id DESC LIMIT 1)`,
  );
  return roundMoney(rows.reduce((sum, r) => sum + Number(r.balance ?? 0), 0));
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
    `SELECT id, session_id, type, amount FROM cash_movements ORDER BY session_id, created_at, id`,
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

/** Dernière session clôturée du magasin : référence quand aucune session n'est ouverte. */
export async function getLastClosedSession(storeId: number): Promise<CashSessionRow | null> {
  const row = await db
    .select()
    .from(cashSessions)
    .where(and(eq(cashSessions.status, 'closed'), eq(cashSessions.storeId, storeId)))
    .orderBy(desc(cashSessions.id))
    .limit(1);

  return row[0] ? mapSession(row[0]) : null;
}

/** Résumé de caisse sur une période, avec répartition Espèces / Mobile Money (§8). */
export async function getCashSummary(options: { scope: StoreScope; from?: string; to?: string }): Promise<CashSummary> {
  const storeScope = options.scope;
  // Une session n'a de sens que pour **un** magasin ; en consolidé, les totaux
  // portent sur la période demandée (aujourd'hui par défaut).
  const single = storeScope.length === 1 ? storeScope[0] : null;
  const session = single ? await getOpenSession(single) : null;
  const balance = await getCashBalance(storeScope);

  /*
   * Sur quoi portent les totaux ? La session ouverte si elle existe ; sinon la
   * **dernière session clôturée** — jamais « tout l'historique » en silence.
   */
  let scope: CashSummary['scope'] = 'all';
  let scopeSessionId: number | null = null;
  let scopeClosedAt: Date | null = null;

  const conditions: string[] = [scopeSql('store_id', storeScope), 'deleted_at IS NULL'];
  const args: (string | number)[] = [];

  if (!single) {
    const from = options.from ?? today();
    const to = options.to ?? today();
    conditions.push('date >= ? AND date <= ?');
    args.push(from, to);
  } else if (session) {
    scope = 'session';
    scopeSessionId = session.id;
    conditions.push('session_id = ?');
    args.push(session.id);
  } else if (options.from && options.to) {
    conditions.push('date >= ? AND date <= ?');
    args.push(options.from, options.to);
  } else {
    const lastClosed = await getLastClosedSession(single);
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
  storeName: string | null;
  openedByName: string | null;
  closedByName: string | null;
  movementsCount: number;
};

export async function listCashSessions(options: { scope: StoreScope; limit?: number }): Promise<CashSessionHistoryRow[]> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 30));

  const rows = await rawAll<any>(
    `SELECT s.*,
            (SELECT name FROM users WHERE id = s.opened_by) AS opened_by_name,
            (SELECT name FROM users WHERE id = s.closed_by) AS closed_by_name,
            (SELECT name FROM stores WHERE id = s.store_id) AS store_name,
            (SELECT COUNT(*) FROM cash_movements WHERE session_id = s.id) AS movements_count
     FROM cash_sessions s
     WHERE ${scopeSql('s.store_id', options.scope)}
     ORDER BY s.opened_at DESC, s.id DESC
     LIMIT ?`,
    [limit],
  );

  return rows.map((row) => ({
    ...mapSession(row),
    storeName: row.store_name ?? null,
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
  service_job: 'Chantier',
};
