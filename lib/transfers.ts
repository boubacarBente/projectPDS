/**
 * Transferts intermagasins (cahier des charges multi-magasins §8).
 *
 * Un transfert est une opération **formelle**, distincte d'une vente ou d'un
 * ajustement. Chaque étape est historisée dans `stock_transfer_events`.
 *
 * Cycle de vie :
 *
 *   draft ──soumettre──▶ pending ──valider──▶ approved ──préparer──▶ preparing
 *     │                    │  └──refuser──▶ refused          │
 *     └──────annuler───────┴──────────annuler─────────────────┤
 *                                                             ▼
 *                       expédier (sortie du stock source) ─▶ in_transit
 *                                                             │
 *          réception partielle ◀──────── recevoir ────────────┤
 *          (partially_received)                               │
 *                 │                                           ▼
 *                 └────────────── recevoir ───────────▶ received
 *                                                    ou disputed (écart / litige)
 *                                                             │
 *                                       clôturer le litige ───▶ received
 *
 * Règles de cloisonnement :
 *  - l'**expédition** se fait depuis le magasin **source** (sortie de stock) ;
 *  - la **réception** se fait depuis le magasin **destinataire** (entrée de
 *    stock) ;
 *  - la validation demande `transfers.approve` et un magasin source ou
 *    destinataire dans le périmètre de l'utilisateur.
 *
 * Les quantités expédiées quittent le stock disponible de la source et sont
 * suivies **en transit** (calculé : expédié − reçu) jusqu'à la réception.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { stockTransferEvents, stockTransferItems, stockTransfers } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError, ValidationError } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getSettings, nextDocumentNumber } from '@/lib/settings';
import { addStockMovement } from '@/lib/stock';
import { assertStoreWritable, scopeSql, type StoreScope } from '@/lib/stores';

export type TransferStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'preparing'
  | 'in_transit'
  | 'partially_received'
  | 'received'
  | 'disputed'
  | 'refused'
  | 'cancelled';

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  draft: 'Brouillon',
  pending: 'En attente de validation',
  approved: 'Validé',
  preparing: 'En préparation',
  in_transit: 'En transit',
  partially_received: 'Partiellement reçu',
  received: 'Reçu',
  disputed: 'En litige',
  refused: 'Refusé',
  cancelled: 'Annulé',
};

export const TRANSFER_EVENT_LABELS: Record<string, string> = {
  created: 'Création',
  submitted: 'Soumission',
  approved: 'Validation',
  refused: 'Refus',
  preparing: 'Préparation',
  shipped: 'Expédition',
  received: 'Réception',
  partially_received: 'Réception partielle',
  disputed: 'Litige signalé',
  resolved: 'Litige clôturé',
  cancelled: 'Annulation',
  updated: 'Modification',
};

export type TransferUser = {
  id: number;
  name: string;
  storeId: number | null;
  storeIds: number[];
  allStores?: boolean;
};

export type TransferItemRow = {
  id: number;
  productId: number;
  productName: string;
  unit: string;
  quantityRequested: number;
  quantityShipped: number;
  quantityReceived: number;
  inTransit: number;
  discrepancyNote: string | null;
};

export type TransferEventRow = {
  id: number;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  storeName: string | null;
  userName: string | null;
  note: string | null;
  createdAt: Date | null;
};

export type TransferRow = {
  id: number;
  reference: string;
  sourceStoreId: number;
  sourceStoreName: string;
  destinationStoreId: number;
  destinationStoreName: string;
  status: TransferStatus;
  reason: string | null;
  requestedDate: string | null;
  requestedByName: string | null;
  approvedByName: string | null;
  shippedAt: Date | null;
  receivedAt: Date | null;
  notes: string | null;
  itemCount: number;
  totalRequested: number;
  totalShipped: number;
  totalReceived: number;
  createdAt: Date | null;
};

export type TransferDetail = {
  transfer: TransferRow;
  items: TransferItemRow[];
  events: TransferEventRow[];
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const ts = (value: unknown) => (value ? new Date(Number(value) * 1000) : null);

const TRANSFER_SELECT = `
  SELECT t.*,
         src.name AS source_name, dst.name AS destination_name,
         ur.name AS requested_by_name, ua.name AS approved_by_name,
         (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS item_count,
         (SELECT COALESCE(SUM(i.quantity_requested), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_requested,
         (SELECT COALESCE(SUM(i.quantity_shipped), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_shipped,
         (SELECT COALESCE(SUM(i.quantity_received), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_received
    FROM stock_transfers t
    JOIN stores src ON src.id = t.source_store_id
    JOIN stores dst ON dst.id = t.destination_store_id
    LEFT JOIN users ur ON ur.id = t.requested_by
    LEFT JOIN users ua ON ua.id = t.approved_by`;

function mapTransfer(row: any): TransferRow {
  return {
    id: Number(row.id),
    reference: String(row.reference),
    sourceStoreId: Number(row.source_store_id),
    sourceStoreName: String(row.source_name),
    destinationStoreId: Number(row.destination_store_id),
    destinationStoreName: String(row.destination_name),
    status: row.status as TransferStatus,
    reason: row.reason ?? null,
    requestedDate: row.requested_date ?? null,
    requestedByName: row.requested_by_name ?? null,
    approvedByName: row.approved_by_name ?? null,
    shippedAt: ts(row.shipped_at),
    receivedAt: ts(row.received_at),
    notes: row.notes ?? null,
    itemCount: Number(row.item_count ?? 0),
    totalRequested: round3(Number(row.total_requested ?? 0)),
    totalShipped: round3(Number(row.total_shipped ?? 0)),
    totalReceived: round3(Number(row.total_received ?? 0)),
    createdAt: ts(row.created_at),
  };
}

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

export async function listTransfers(options: {
  scope: StoreScope;
  status?: string;
  direction?: 'incoming' | 'outgoing' | 'all';
  search?: string;
  page?: number;
  limit?: number;
}): Promise<{ data: TransferRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const src = scopeSql('t.source_store_id', options.scope);
  const dst = scopeSql('t.destination_store_id', options.scope);
  const where: string[] = [
    options.direction === 'incoming' ? dst : options.direction === 'outgoing' ? src : `(${src} OR ${dst})`,
  ];
  const args: unknown[] = [];

  if (options.status && options.status !== 'all') {
    if (options.status === 'open') {
      where.push(`t.status IN ('draft', 'pending', 'approved', 'preparing', 'in_transit', 'partially_received', 'disputed')`);
    } else {
      where.push('t.status = ?');
      args.push(options.status);
    }
  }
  if (options.search) {
    where.push('(t.reference LIKE ? OR t.reason LIKE ?)');
    args.push(`%${options.search}%`, `%${options.search}%`);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [rows, count] = await Promise.all([
    rawAll<any>(`${TRANSFER_SELECT} ${whereSql} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`, [
      ...args,
      limit,
      offset,
    ] as any),
    rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_transfers t ${whereSql}`, args as any),
  ]);

  const total = Number(count?.n ?? 0);
  return { data: rows.map(mapTransfer), total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

export async function getTransfer(id: number): Promise<TransferDetail | null> {
  const row = await rawGet<any>(`${TRANSFER_SELECT} WHERE t.id = ?`, [id]);
  if (!row) return null;

  const [items, events] = await Promise.all([
    rawAll<any>(`SELECT * FROM stock_transfer_items WHERE transfer_id = ? ORDER BY id`, [id]),
    rawAll<any>(
      `SELECT e.*, s.name AS store_name FROM stock_transfer_events e
         LEFT JOIN stores s ON s.id = e.store_id
        WHERE e.transfer_id = ? ORDER BY e.created_at, e.id`,
      [id],
    ),
  ]);

  return {
    transfer: mapTransfer(row),
    items: items.map((i) => ({
      id: Number(i.id),
      productId: Number(i.product_id),
      productName: String(i.product_name),
      unit: String(i.unit),
      quantityRequested: round3(Number(i.quantity_requested)),
      quantityShipped: round3(Number(i.quantity_shipped)),
      quantityReceived: round3(Number(i.quantity_received)),
      inTransit: round3(Number(i.quantity_shipped) - Number(i.quantity_received)),
      discrepancyNote: i.discrepancy_note ?? null,
    })),
    events: events.map((e) => ({
      id: Number(e.id),
      event: String(e.event),
      fromStatus: e.from_status ?? null,
      toStatus: e.to_status ?? null,
      storeName: e.store_name ?? null,
      userName: e.user_name ?? null,
      note: e.note ?? null,
      createdAt: ts(e.created_at),
    })),
  };
}

/** Le transfert est-il visible par l'utilisateur ? (source ou destination dans son périmètre) */
export function canSeeTransfer(user: TransferUser, transfer: { sourceStoreId: number; destinationStoreId: number }) {
  return user.storeIds.includes(transfer.sourceStoreId) || user.storeIds.includes(transfer.destinationStoreId);
}

/* ------------------------------------------------------------------ *
 * Écriture
 * ------------------------------------------------------------------ */

async function logEvent(
  transferId: number,
  event: string,
  fromStatus: string | null,
  toStatus: string | null,
  user: TransferUser,
  note?: string | null,
) {
  await db.insert(stockTransferEvents).values({
    transferId,
    event,
    fromStatus,
    toStatus,
    storeId: user.storeId ?? null,
    userId: user.id,
    userName: user.name,
    note: note?.trim() || null,
  });
}

async function loadForUpdate(id: number, user: TransferUser): Promise<TransferDetail> {
  const detail = await getTransfer(id);
  if (!detail) throw new NotFoundError('Transfert introuvable');
  if (!canSeeTransfer(user, detail.transfer)) {
    throw new ValidationError('Ce transfert ne concerne aucun de vos magasins.');
  }
  return detail;
}

function expectStatus(detail: TransferDetail, allowed: TransferStatus[], action: string) {
  if (!allowed.includes(detail.transfer.status)) {
    throw new ValidationError(
      `Impossible de ${action} un transfert « ${TRANSFER_STATUS_LABELS[detail.transfer.status]} ».`,
    );
  }
}

async function setStatus(id: number, status: TransferStatus, extra: Record<string, unknown> = {}) {
  await db.update(stockTransfers).set({ status, ...extra }).where(eq(stockTransfers.id, id));
}

export type TransferInput = {
  sourceStoreId: number;
  destinationStoreId: number;
  reason?: string | null;
  requestedDate?: string | null;
  notes?: string | null;
  items: { productId: number; quantity: number }[];
  /** `true` = soumettre immédiatement (sinon brouillon). */
  submit?: boolean;
};

async function buildItems(items: TransferInput['items']) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('Un transfert doit contenir au moins un produit');
  }
  const merged = new Map<number, number>();
  for (const [index, item] of items.entries()) {
    const productId = Number(item.productId);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new ValidationError(`Ligne ${index + 1} : le produit est obligatoire`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ValidationError(`Ligne ${index + 1} : la quantité doit être supérieure à zéro`);
    }
    merged.set(productId, round3((merged.get(productId) ?? 0) + quantity));
  }
  const result: { productId: number; productName: string; unit: string; quantity: number }[] = [];
  for (const [productId, quantity] of merged) {
    const product = await rawGet<{ name: string; unit: string; is_active: number }>(
      `SELECT name, unit, is_active FROM products WHERE id = ?`,
      [productId],
    );
    if (!product) throw new ValidationError(`Produit introuvable (id ${productId})`);
    result.push({ productId, productName: product.name, unit: product.unit, quantity });
  }
  return result;
}

export async function createTransfer(input: TransferInput, user: TransferUser): Promise<TransferDetail> {
  const sourceStoreId = Number(input.sourceStoreId);
  const destinationStoreId = Number(input.destinationStoreId);

  if (!sourceStoreId || !destinationStoreId) {
    throw new ValidationError('Choisissez le magasin source et le magasin destinataire');
  }
  if (sourceStoreId === destinationStoreId) {
    throw new ValidationError('Le magasin source et le magasin destinataire doivent être différents');
  }
  // L'auteur doit appartenir à l'un des deux magasins (§5 : jamais de demande
  // au nom d'un magasin hors périmètre).
  if (!user.storeIds.includes(sourceStoreId) && !user.storeIds.includes(destinationStoreId)) {
    throw new ValidationError('Vous devez être affecté au magasin source ou au magasin destinataire');
  }

  const stores = await rawAll<{ id: number; status: string; name: string }>(
    `SELECT id, status, name FROM stores WHERE id IN (?, ?)`,
    [sourceStoreId, destinationStoreId],
  );
  if (stores.length !== 2) throw new ValidationError('Magasin introuvable');
  for (const store of stores) {
    if (store.status !== 'active') {
      throw new ValidationError(`Le magasin « ${store.name} » n’accepte pas de nouvelles opérations.`);
    }
  }

  const items = await buildItems(input.items);
  const settings = await getSettings();

  return withTransaction(async () => {
    const reference = await nextDocumentNumber('transfer', user.storeId ?? sourceStoreId);
    const initialStatus: TransferStatus = input.submit
      ? settings.transferApprovalRequired
        ? 'pending'
        : 'approved'
      : 'draft';

    const [created] = await db
      .insert(stockTransfers)
      .values({
        reference,
        sourceStoreId,
        destinationStoreId,
        status: initialStatus,
        reason: input.reason?.trim() || null,
        requestedDate: input.requestedDate || null,
        requestedBy: user.id,
        notes: input.notes?.trim() || null,
        ...(initialStatus === 'approved' ? { approvedBy: user.id, approvedAt: new Date() } : {}),
      })
      .returning({ id: stockTransfers.id });

    const transferId = Number(created.id);
    for (const item of items) {
      await db.insert(stockTransferItems).values({
        transferId,
        productId: item.productId,
        productName: item.productName,
        unit: item.unit,
        quantityRequested: item.quantity,
      });
    }

    await logEvent(transferId, 'created', null, 'draft', user, input.reason);
    if (initialStatus !== 'draft') {
      await logEvent(
        transferId,
        initialStatus === 'approved' ? 'approved' : 'submitted',
        'draft',
        initialStatus,
        user,
        initialStatus === 'approved' ? 'Validation non requise (paramètres)' : null,
      );
    }

    await writeAudit({
      user,
      storeId: sourceStoreId,
      action: 'create',
      entity: 'stock_transfer',
      entityId: transferId,
      details: { reference, sourceStoreId, destinationStoreId, lignes: items.length, statut: initialStatus },
    });

    return (await getTransfer(transferId))!;
  });
}

/** Modification d'un brouillon (lignes, motif). */
export async function updateDraftTransfer(
  id: number,
  input: Partial<TransferInput>,
  user: TransferUser,
): Promise<TransferDetail> {
  return withTransaction(async () => {
    const detail = await loadForUpdate(id, user);
    expectStatus(detail, ['draft', 'pending'], 'modifier');

    const updates: Record<string, unknown> = {};
    if (input.reason !== undefined) updates.reason = input.reason?.trim() || null;
    if (input.requestedDate !== undefined) updates.requestedDate = input.requestedDate || null;
    if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;
    if (Object.keys(updates).length > 0) {
      await db.update(stockTransfers).set(updates).where(eq(stockTransfers.id, id));
    }

    if (input.items) {
      const items = await buildItems(input.items);
      await db.delete(stockTransferItems).where(eq(stockTransferItems.transferId, id));
      for (const item of items) {
        await db.insert(stockTransferItems).values({
          transferId: id,
          productId: item.productId,
          productName: item.productName,
          unit: item.unit,
          quantityRequested: item.quantity,
        });
      }
    }

    await logEvent(id, 'updated', detail.transfer.status, detail.transfer.status, user);
    return (await getTransfer(id))!;
  });
}

export async function submitTransfer(id: number, user: TransferUser): Promise<TransferDetail> {
  const settings = await getSettings();
  return withTransaction(async () => {
    const detail = await loadForUpdate(id, user);
    expectStatus(detail, ['draft'], 'soumettre');
    const next: TransferStatus = settings.transferApprovalRequired ? 'pending' : 'approved';
    await setStatus(id, next, next === 'approved' ? { approvedBy: user.id, approvedAt: new Date() } : {});
    await logEvent(id, next === 'approved' ? 'approved' : 'submitted', 'draft', next, user);
    return (await getTransfer(id))!;
  });
}

export async function approveTransfer(
  id: number,
  decision: 'approve' | 'refuse',
  user: TransferUser,
  note?: string | null,
): Promise<TransferDetail> {
  return withTransaction(async () => {
    const detail = await loadForUpdate(id, user);
    expectStatus(detail, ['pending'], decision === 'approve' ? 'valider' : 'refuser');
    if (decision === 'refuse' && !note?.trim()) {
      throw new ValidationError('Le motif du refus est obligatoire');
    }
    const next: TransferStatus = decision === 'approve' ? 'approved' : 'refused';
    await setStatus(id, next, { approvedBy: user.id, approvedAt: new Date() });
    await logEvent(id, next === 'approved' ? 'approved' : 'refused', 'pending', next, user, note);
    await writeAudit({
      user,
      storeId: detail.transfer.sourceStoreId,
      action: decision === 'approve' ? 'validate' : 'cancel',
      entity: 'stock_transfer',
      entityId: id,
      details: { reference: detail.transfer.reference, décision: next, motif: note ?? null },
    });
    return (await getTransfer(id))!;
  });
}

export async function prepareTransfer(id: number, user: TransferUser): Promise<TransferDetail> {
  return withTransaction(async () => {
    const detail = await loadForUpdate(id, user);
    expectStatus(detail, ['approved'], 'préparer');
    if (user.storeId !== detail.transfer.sourceStoreId) {
      throw new ValidationError('La préparation se fait depuis le magasin source.');
    }
    await setStatus(id, 'preparing');
    await logEvent(id, 'preparing', 'approved', 'preparing', user);
    return (await getTransfer(id))!;
  });
}

/**
 * Expédition : les quantités quittent le stock **disponible** du magasin
 * source (mouvement `exit` de référence `transfer`) et passent en transit.
 */
export async function shipTransfer(
  id: number,
  user: TransferUser,
  input: { quantities?: Record<number, number>; note?: string | null } = {},
): Promise<TransferDetail> {
  return withTransaction(async () => {
    const detail = await loadForUpdate(id, user);
    expectStatus(detail, ['approved', 'preparing'], 'expédier');
    const sourceStoreId = detail.transfer.sourceStoreId;
    if (user.storeId !== sourceStoreId) {
      throw new ValidationError('L’expédition se fait depuis le magasin source (changez de magasin actif).');
    }
    await assertStoreWritable(sourceStoreId);

    let shippedLines = 0;
    for (const item of detail.items) {
      const requested = input.quantities?.[item.id];
      const quantity = round3(requested === undefined ? item.quantityRequested : Number(requested));
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw new ValidationError(`Quantité expédiée invalide pour ${item.productName}`);
      }
      if (quantity > item.quantityRequested + 0.0001) {
        throw new ValidationError(
          `${item.productName} : on ne peut pas expédier plus que la quantité demandée (${item.quantityRequested}).`,
        );
      }
      if (quantity > 0) {
        await addStockMovement(item.productId, 'exit', quantity, {
          storeId: sourceStoreId,
          referenceType: 'transfer',
          referenceId: id,
          motif: `transfert ${detail.transfer.reference} vers ${detail.transfer.destinationStoreName}`,
          userId: user.id,
        });
        shippedLines += 1;
      }
      await db.update(stockTransferItems).set({ quantityShipped: quantity }).where(eq(stockTransferItems.id, item.id));
    }
    if (shippedLines === 0) throw new ValidationError('Aucune quantité à expédier');

    await setStatus(id, 'in_transit', { shippedBy: user.id, shippedAt: new Date() });
    await logEvent(id, 'shipped', detail.transfer.status, 'in_transit', user, input.note);
    await writeAudit({
      user,
      storeId: sourceStoreId,
      action: 'update',
      entity: 'stock_transfer',
      entityId: id,
      details: { reference: detail.transfer.reference, étape: 'expédition', lignes: shippedLines },
    });
    return (await getTransfer(id))!;
  });
}

/**
 * Réception (totale ou partielle) par le magasin destinataire : entrée en
 * stock des quantités reçues. Un écart ou un dommage se signale par ligne ;
 * `close` termine la réception — s'il reste un écart, le transfert passe en
 * **litige**, sinon il est **reçu**.
 */
export async function receiveTransfer(
  id: number,
  user: TransferUser,
  input: {
    quantities: Record<number, number>;
    discrepancies?: Record<number, string>;
    close?: boolean;
    note?: string | null;
  },
): Promise<TransferDetail> {
  return withTransaction(async () => {
    const detail = await loadForUpdate(id, user);
    expectStatus(detail, ['in_transit', 'partially_received'], 'réceptionner');
    const destinationStoreId = detail.transfer.destinationStoreId;
    if (user.storeId !== destinationStoreId) {
      throw new ValidationError('La réception se fait depuis le magasin destinataire (changez de magasin actif).');
    }
    await assertStoreWritable(destinationStoreId);

    let received = 0;
    for (const item of detail.items) {
      const raw = input.quantities?.[item.id];
      const quantity = round3(raw === undefined ? 0 : Number(raw));
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw new ValidationError(`Quantité reçue invalide pour ${item.productName}`);
      }
      const remaining = round3(item.quantityShipped - item.quantityReceived);
      if (quantity > remaining + 0.0001) {
        throw new ValidationError(
          `${item.productName} : ${quantity} reçu(s) pour ${remaining} encore en transit.`,
        );
      }
      const note = input.discrepancies?.[item.id]?.trim();
      if (quantity > 0) {
        await addStockMovement(item.productId, 'entry', quantity, {
          storeId: destinationStoreId,
          referenceType: 'transfer',
          referenceId: id,
          motif: `réception transfert ${detail.transfer.reference} de ${detail.transfer.sourceStoreName}`,
          userId: user.id,
        });
        received += quantity;
      }
      if (quantity > 0 || note) {
        await db
          .update(stockTransferItems)
          .set({
            quantityReceived: round3(item.quantityReceived + quantity),
            ...(note ? { discrepancyNote: note } : {}),
          })
          .where(eq(stockTransferItems.id, item.id));
      }
    }

    const after = (await getTransfer(id))!;
    const outstanding = after.items.reduce((sum, i) => sum + Math.max(0, i.inTransit), 0);
    const hasDiscrepancy = after.items.some((i) => i.discrepancyNote);

    let next: TransferStatus;
    if (outstanding <= 0.0001 && !hasDiscrepancy) next = 'received';
    else if (input.close) next = 'disputed';
    else next = 'partially_received';

    if (received <= 0 && !input.close && !hasDiscrepancy) {
      throw new ValidationError('Saisissez au moins une quantité reçue');
    }

    await setStatus(id, next, {
      receivedBy: user.id,
      receivedAt: new Date(),
      ...(next === 'received' ? { closedAt: new Date() } : {}),
    });
    await logEvent(
      id,
      next === 'disputed' ? 'disputed' : next === 'received' ? 'received' : 'partially_received',
      detail.transfer.status,
      next,
      user,
      input.note,
    );
    await writeAudit({
      user,
      storeId: destinationStoreId,
      action: 'update',
      entity: 'stock_transfer',
      entityId: id,
      details: { reference: detail.transfer.reference, étape: 'réception', reçu: received, statut: next },
    });
    return (await getTransfer(id))!;
  });
}

/** Clôture d'un litige : l'écart est constaté (perte / casse), le transfert est clos. */
export async function resolveTransferDispute(id: number, user: TransferUser, note: string): Promise<TransferDetail> {
  if (!note?.trim()) throw new ValidationError('Décrivez la résolution du litige');
  return withTransaction(async () => {
    const detail = await loadForUpdate(id, user);
    expectStatus(detail, ['disputed', 'partially_received'], 'clôturer');
    await setStatus(id, 'received', { closedAt: new Date() });
    await logEvent(id, 'resolved', detail.transfer.status, 'received', user, note);
    await writeAudit({
      user,
      storeId: detail.transfer.destinationStoreId,
      action: 'validate',
      entity: 'stock_transfer',
      entityId: id,
      details: {
        reference: detail.transfer.reference,
        écart: detail.items.reduce((sum, i) => sum + i.inTransit, 0),
        résolution: note,
      },
    });
    return (await getTransfer(id))!;
  });
}

export async function cancelTransfer(id: number, user: TransferUser, reason: string): Promise<TransferDetail> {
  if (!reason?.trim()) throw new ValidationError("Le motif d'annulation est obligatoire");
  return withTransaction(async () => {
    const detail = await loadForUpdate(id, user);
    expectStatus(detail, ['draft', 'pending', 'approved', 'preparing'], 'annuler');
    await setStatus(id, 'cancelled', { closedAt: new Date() });
    await logEvent(id, 'cancelled', detail.transfer.status, 'cancelled', user, reason);
    await writeAudit({
      user,
      storeId: detail.transfer.sourceStoreId,
      action: 'cancel',
      entity: 'stock_transfer',
      entityId: id,
      details: { reference: detail.transfer.reference, motif: reason },
    });
    return (await getTransfer(id))!;
  });
}

/** Compteurs pour les badges et le tableau de bord. */
export async function getTransferCounters(scope: StoreScope) {
  const src = scopeSql('source_store_id', scope);
  const dst = scopeSql('destination_store_id', scope);
  const row = await rawGet<any>(
    `SELECT
       (SELECT COUNT(*) FROM stock_transfers WHERE status = 'pending' AND (${src} OR ${dst})) AS to_approve,
       (SELECT COUNT(*) FROM stock_transfers WHERE status IN ('approved', 'preparing') AND ${src}) AS to_ship,
       (SELECT COUNT(*) FROM stock_transfers WHERE status IN ('in_transit', 'partially_received') AND ${dst}) AS to_receive,
       (SELECT COUNT(*) FROM stock_transfers WHERE status = 'disputed' AND (${src} OR ${dst})) AS disputed`,
  );
  return {
    toApprove: Number(row?.to_approve ?? 0),
    toShip: Number(row?.to_ship ?? 0),
    toReceive: Number(row?.to_receive ?? 0),
    disputed: Number(row?.disputed ?? 0),
  };
}
