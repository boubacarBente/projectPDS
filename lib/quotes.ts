/**
 * Devis de prestation — document **distinct** du chantier (cahier
 * « Prestations de chantier » §9, README §19.3).
 *
 * Avant la v2, le devis vivait dans la ligne du chantier (`quote_status`) : un
 * devis refusé restait dans la liste des chantiers, et le document envoyé au
 * client affichait les **prix d'achat** des matériaux et le tarif journalier
 * des ouvriers — nos coûts internes. Désormais :
 *
 *  - un devis a son numéro (`DEV-KAL-2026-000001`), son client, sa date de
 *    validité et ses **lignes de prestations du catalogue du magasin**, avec
 *    prix et remise **figés** (critère de recette n° 11) ;
 *  - cycle : brouillon → envoyé → accepté / refusé ; annulé avec motif ;
 *    « expiré » se **calcule** (date de validité dépassée) ;
 *  - un devis accepté se **convertit** en chantier : les lignes sont recopiées
 *    telles quelles (mêmes prix, même si le catalogue a changé depuis) ;
 *  - il peut découler d'une demande, dont il fait avancer le statut.
 *
 * Le total n'est pas stocké : c'est la somme des lignes (invariant n° 2).
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { eq } from 'drizzle-orm';
import { quoteItems, quotes, serviceRequests } from '@/db/schema';
import { scopeSql, type StoreScope } from '@/lib/stores';
import { getSettings, nextDocumentNumber } from '@/lib/settings';
import { matchJobCategory, jobCategoryLabel } from '@/lib/job-categories';
import { createServiceJob, prepareServiceLine, type JobItemInput, type ServiceJobRow } from '@/lib/jobs';
import { syncRequestStatusFromQuote } from '@/lib/service-requests';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api';
import { assertCustomerInStore } from '@/lib/customers';
import { roundMoney, today } from '@/lib/format';

export const QUOTE_STATUS_VALUES = ['draft', 'sent', 'accepted', 'refused', 'cancelled'] as const;
export type QuoteDocStatus = (typeof QUOTE_STATUS_VALUES)[number];
/** Statut affiché : `expired` se calcule, il n'est jamais enregistré. */
export type QuoteDisplayStatus = QuoteDocStatus | 'expired';

export function isQuoteDocStatus(value: unknown): value is QuoteDocStatus {
  return typeof value === 'string' && (QUOTE_STATUS_VALUES as readonly string[]).includes(value);
}

export type QuoteRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  reference: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  requestId: number | null;
  requestReference: string | null;
  date: string;
  validUntil: string | null;
  category: string | null;
  title: string | null;
  siteAddress: string | null;
  description: string | null;
  status: QuoteDocStatus;
  /** Statut à afficher : `expired` si un brouillon ou un devis envoyé a dépassé sa validité. */
  displayStatus: QuoteDisplayStatus;
  total: number;
  itemsCount: number;
  /** Chantier issu de ce devis (calculé). */
  jobId: number | null;
  jobReference: string | null;
  cancelReason: string | null;
  userName: string | null;
  notes: string | null;
  createdAt: Date | null;
};

export type QuoteItemRow = {
  id: number;
  serviceId: number | null;
  serviceCode: string | null;
  serviceName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  /** Montant avant remise, pour afficher la remise en clair. */
  grossAmount: number;
  amount: number;
  position: number;
};

export type QuoteDetail = { quote: QuoteRow; items: QuoteItemRow[] };

export type QuotesSummary = {
  total: number;
  byStatus: Record<QuoteDisplayStatus, number>;
  /** Devis en attente de réponse (brouillon ou envoyé, non expiré) et leur montant. */
  pendingCount: number;
  pendingAmount: number;
  acceptedAmount: number;
  /** Devis acceptés / devis ayant reçu une réponse (acceptés + refusés). */
  acceptanceRate: number;
};

const QUOTE_SELECT = `
  SELECT q.id, q.store_id, st.name AS store_name, q.reference, q.customer_id, c.name AS customer_name,
         c.phone AS customer_phone, q.request_id, r.reference AS request_reference, q.date, q.valid_until,
         q.category, q.title, q.site_address, q.description, q.status, q.cancel_reason, q.notes, q.created_at,
         u.name AS user_name,
         COALESCE((SELECT SUM(i.amount) FROM quote_items i WHERE i.quote_id = q.id), 0) AS total,
         (SELECT COUNT(*) FROM quote_items i WHERE i.quote_id = q.id) AS items_count,
         (SELECT j.id FROM service_jobs j WHERE j.quote_id = q.id ORDER BY j.id DESC LIMIT 1) AS job_id,
         (SELECT j.reference FROM service_jobs j WHERE j.quote_id = q.id ORDER BY j.id DESC LIMIT 1) AS job_reference
  FROM quotes q
  LEFT JOIN customers c ON c.id = q.customer_id
  LEFT JOIN users u ON u.id = q.user_id
  LEFT JOIN stores st ON st.id = q.store_id
  LEFT JOIN service_requests r ON r.id = q.request_id
`;

/** Un devis expire s'il attend encore une réponse après sa date de validité. */
const EXPIRED_SQL = `(q.status IN ('draft', 'sent') AND q.valid_until IS NOT NULL AND q.valid_until < ?)`;

function mapQuote(row: any): QuoteRow {
  const status: QuoteDocStatus = isQuoteDocStatus(row.status) ? row.status : 'draft';
  const expired = (status === 'draft' || status === 'sent') && Boolean(row.valid_until) && String(row.valid_until) < today();
  return {
    id: Number(row.id),
    storeId: Number(row.store_id),
    storeName: row.store_name ?? null,
    reference: row.reference,
    customerId: Number(row.customer_id),
    customerName: row.customer_name ?? 'Client supprimé',
    customerPhone: row.customer_phone ?? null,
    requestId: row.request_id == null ? null : Number(row.request_id),
    requestReference: row.request_reference ?? null,
    date: row.date,
    validUntil: row.valid_until ?? null,
    category: row.category ? jobCategoryLabel(row.category) : null,
    title: row.title ?? null,
    siteAddress: row.site_address ?? null,
    description: row.description ?? null,
    status,
    displayStatus: expired ? 'expired' : status,
    total: roundMoney(Number(row.total ?? 0)),
    itemsCount: Number(row.items_count ?? 0),
    jobId: row.job_id == null ? null : Number(row.job_id),
    jobReference: row.job_reference ?? null,
    cancelReason: row.cancel_reason ?? null,
    userName: row.user_name ?? null,
    notes: row.notes ?? null,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

export async function listQuotes(options: {
  scope: StoreScope;
  search?: string;
  /** Un statut, `expired`, ou `pending` (brouillon + envoyé non expirés). */
  status?: string;
  customerId?: number;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}): Promise<{ data: QuoteRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const where: string[] = [scopeSql('q.store_id', options.scope)];
  const args: (string | number)[] = [];

  if (options.search?.trim()) {
    const like = `%${options.search.trim()}%`;
    where.push('(q.reference LIKE ? OR c.name LIKE ? OR q.title LIKE ? OR q.site_address LIKE ?)');
    args.push(like, like, like, like);
  }
  if (options.status === 'expired') {
    where.push(EXPIRED_SQL);
    args.push(today());
  } else if (options.status === 'pending') {
    where.push(`q.status IN ('draft', 'sent') AND NOT ${EXPIRED_SQL}`);
    args.push(today());
  } else if (isQuoteDocStatus(options.status)) {
    where.push('q.status = ?');
    args.push(options.status);
    if (options.status === 'draft' || options.status === 'sent') {
      where.push(`NOT ${EXPIRED_SQL}`);
      args.push(today());
    }
  }
  if (options.customerId) {
    where.push('q.customer_id = ?');
    args.push(options.customerId);
  }
  if (options.from) {
    where.push('q.date >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('q.date <= ?');
    args.push(options.to);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = await rawAll<any>(`${QUOTE_SELECT} ${whereSql} ORDER BY q.date DESC, q.id DESC LIMIT ? OFFSET ?`, [
    ...args,
    limit,
    (page - 1) * limit,
  ]);
  const count = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id ${whereSql}`,
    args,
  );
  const total = Number(count?.total ?? 0);
  return { data: rows.map(mapQuote), total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

export async function getQuoteRow(id: number): Promise<QuoteRow | null> {
  const row = await rawGet<any>(`${QUOTE_SELECT} WHERE q.id = ?`, [id]);
  return row ? mapQuote(row) : null;
}

export async function listQuoteItems(quoteId: number): Promise<QuoteItemRow[]> {
  const rows = await rawAll<any>(
    `SELECT i.*, s.code AS service_code FROM quote_items i LEFT JOIN services s ON s.id = i.service_id
     WHERE i.quote_id = ? ORDER BY i.position, i.id`,
    [quoteId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    serviceId: row.service_id == null ? null : Number(row.service_id),
    serviceCode: row.service_code ?? null,
    serviceName: row.service_name,
    unit: row.unit,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    discountPercent: Number(row.discount_percent ?? 0),
    grossAmount: roundMoney(Number(row.quantity) * Number(row.unit_price)),
    amount: Number(row.amount),
    position: Number(row.position ?? 0),
  }));
}

export async function getQuote(id: number): Promise<QuoteDetail | null> {
  const quote = await getQuoteRow(id);
  if (!quote) return null;
  return { quote, items: await listQuoteItems(id) };
}

export async function getQuotesSummary(scope: StoreScope, from?: string, to?: string): Promise<QuotesSummary> {
  const where = [scopeSql('q.store_id', scope)];
  const args: string[] = [];
  if (from) {
    where.push('q.date >= ?');
    args.push(from);
  }
  if (to) {
    where.push('q.date <= ?');
    args.push(to);
  }
  const rows = await rawAll<{ status: string; valid_until: string | null; total: number }>(
    `SELECT q.status, q.valid_until, COALESCE((SELECT SUM(i.amount) FROM quote_items i WHERE i.quote_id = q.id), 0) AS total
     FROM quotes q WHERE ${where.join(' AND ')}`,
    args,
  );
  const byStatus: Record<QuoteDisplayStatus, number> = {
    draft: 0,
    sent: 0,
    accepted: 0,
    refused: 0,
    cancelled: 0,
    expired: 0,
  };
  const day = today();
  let pendingAmount = 0;
  let acceptedAmount = 0;
  for (const row of rows) {
    const status = isQuoteDocStatus(row.status) ? row.status : 'draft';
    const expired = (status === 'draft' || status === 'sent') && Boolean(row.valid_until) && String(row.valid_until) < day;
    const display: QuoteDisplayStatus = expired ? 'expired' : status;
    byStatus[display] += 1;
    if (display === 'draft' || display === 'sent') pendingAmount += Number(row.total);
    if (display === 'accepted') acceptedAmount += Number(row.total);
  }
  const answered = byStatus.accepted + byStatus.refused;
  return {
    total: rows.length,
    byStatus,
    pendingCount: byStatus.draft + byStatus.sent,
    pendingAmount: roundMoney(pendingAmount),
    acceptedAmount: roundMoney(acceptedAmount),
    acceptanceRate: answered > 0 ? Math.round((byStatus.accepted / answered) * 1000) / 10 : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Écriture
 * ------------------------------------------------------------------ */

export type QuoteInput = {
  customerId: number;
  requestId?: number | null;
  date?: string | null;
  validUntil?: string | null;
  category?: string | null;
  title?: string | null;
  siteAddress?: string | null;
  description?: string | null;
  notes?: string | null;
  items: JobItemInput[];
};

function cleanDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ValidationError(`${label} : date au format AAAA-MM-JJ attendue`);
  return text;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Le client doit exister **et** appartenir au magasin du devis (README §28.5). */
async function assertCustomer(customerId: unknown, storeId: number): Promise<number> {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Le client du devis est obligatoire.');
  return (await assertCustomerInStore(id, storeId)).id;
}

async function validCategory(value: unknown): Promise<string | null> {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const list = (await getSettings()).jobCategories;
  const match = matchJobCategory(value, list);
  if (!match) throw new ValidationError(`Type de prestation inconnu. Choisissez l’un des types : ${list.join(', ')}.`);
  return match;
}

/** La demande d'origine doit être du même magasin et encore ouverte. */
async function validRequest(requestId: unknown, storeId: number): Promise<number | null> {
  if (requestId === null || requestId === undefined || requestId === '' || Number(requestId) === 0) return null;
  const row = await rawGet<{ store_id: number; status: string }>('SELECT store_id, status FROM service_requests WHERE id = ?', [
    Number(requestId),
  ]);
  if (!row) throw new NotFoundError('Demande introuvable');
  if (Number(row.store_id) !== Number(storeId)) throw new ValidationError('Cette demande appartient à un autre magasin.');
  if (row.status === 'converted' || row.status === 'refused') {
    throw new ConflictError('Cette demande est close (refusée ou déjà convertie en chantier).');
  }
  return Number(requestId);
}

async function writeItems(quoteId: number, items: JobItemInput[], storeId: number) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('Ajoutez au moins une prestation au devis.');
  }
  let position = 1;
  for (const item of items) {
    // Prestation du catalogue **de ce magasin** et active (critère n° 5).
    const line = await prepareServiceLine(item, storeId);
    await db.insert(quoteItems).values({ quoteId, ...line, position: position++ });
  }
}

export async function createQuote(input: QuoteInput & { storeId: number; userId?: number | null }): Promise<QuoteRow> {
  return withTransaction(async () => {
    if (!input.storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');
    const customerId = await assertCustomer(input.customerId, input.storeId);
    const requestId = await validRequest(input.requestId, input.storeId);
    const date = cleanDate(input.date, 'Date du devis') ?? today();
    const validity = Number((await getSettings()).quoteValidityDays ?? 30) || 30;
    const validUntil = cleanDate(input.validUntil, 'Validité') ?? addDays(date, validity);
    if (validUntil < date) throw new ValidationError('La date de validité ne peut pas précéder la date du devis.');

    const inserted = await db
      .insert(quotes)
      .values({
        storeId: input.storeId,
        reference: await nextDocumentNumber('quote', input.storeId),
        customerId,
        requestId,
        date,
        validUntil,
        category: await validCategory(input.category),
        title: input.title?.trim() || null,
        siteAddress: input.siteAddress?.trim() || null,
        description: input.description?.trim() || null,
        status: 'draft',
        notes: input.notes?.trim() || null,
        userId: input.userId ?? null,
      })
      .returning({ id: quotes.id });

    await writeItems(inserted[0].id, input.items, input.storeId);
    // La demande passe en « devis à préparer » tant que le devis n'est pas envoyé.
    if (requestId) {
      const req = await rawGet<{ status: string }>('SELECT status FROM service_requests WHERE id = ?', [requestId]);
      if (req && ['new', 'study', 'visit'].includes(req.status)) {
        await db.update(serviceRequests).set({ status: 'quote_to_prepare', updatedAt: new Date() }).where(eq(serviceRequests.id, requestId));
      }
    }

    const created = await getQuoteRow(inserted[0].id);
    if (!created) throw new NotFoundError('Devis créé mais introuvable');
    return created;
  });
}

async function assertOwnQuote(id: number, storeId: number): Promise<QuoteRow> {
  const quote = await getQuoteRow(id);
  if (!quote) throw new NotFoundError('Devis introuvable');
  if (!storeId || quote.storeId !== Number(storeId)) {
    throw new ValidationError('Ce devis appartient à un autre magasin : il ne peut être modifié que depuis ce magasin.');
  }
  return quote;
}

/**
 * Modification d'un devis **en attente** (brouillon ou envoyé). Un devis
 * accepté, refusé ou annulé est un engagement passé : il ne se réécrit plus.
 */
export async function updateQuote(id: number, patch: Partial<QuoteInput>, storeId: number): Promise<QuoteRow> {
  return withTransaction(async () => {
    const current = await assertOwnQuote(id, storeId);
    if (current.status !== 'draft' && current.status !== 'sent') {
      throw new ConflictError('Seul un devis en brouillon ou envoyé peut être modifié.');
    }
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.customerId !== undefined && Number(patch.customerId) !== current.customerId) {
      values.customerId = await assertCustomer(patch.customerId, storeId);
    }
    if (patch.date !== undefined) values.date = cleanDate(patch.date, 'Date du devis') ?? current.date;
    if (patch.validUntil !== undefined) values.validUntil = cleanDate(patch.validUntil, 'Validité');
    if (patch.category !== undefined) values.category = await validCategory(patch.category);
    if (patch.title !== undefined) values.title = patch.title?.trim() || null;
    if (patch.siteAddress !== undefined) values.siteAddress = patch.siteAddress?.trim() || null;
    if (patch.description !== undefined) values.description = patch.description?.trim() || null;
    if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;
    const date = (values.date as string | undefined) ?? current.date;
    const validUntil = (values.validUntil as string | null | undefined) ?? current.validUntil;
    if (validUntil && validUntil < date) throw new ValidationError('La date de validité ne peut pas précéder la date du devis.');

    await db.update(quotes).set(values as any).where(eq(quotes.id, id));
    if (patch.items !== undefined) {
      // Lignes d'un devis encore en négociation : remplacées d'un bloc.
      await db.delete(quoteItems).where(eq(quoteItems.quoteId, id));
      await writeItems(id, patch.items, storeId);
    }
    const updated = await getQuoteRow(id);
    if (!updated) throw new NotFoundError('Devis introuvable');
    return updated;
  });
}

/**
 * Envoi, acceptation, refus. Un devis expiré ne peut être accepté qu'après
 * avoir prolongé sa validité (le client accepte un prix qui n'est plus garanti).
 */
export async function setQuoteStatus(id: number, status: 'sent' | 'accepted' | 'refused', storeId: number): Promise<QuoteRow> {
  return withTransaction(async () => {
    const current = await assertOwnQuote(id, storeId);
    if (current.status === 'cancelled') throw new ConflictError('Ce devis est annulé.');
    if (current.jobId) throw new ConflictError('Ce devis a déjà été converti en chantier.');
    const allowed: Record<QuoteDocStatus, string[]> = {
      draft: ['sent', 'accepted', 'refused'],
      sent: ['accepted', 'refused'],
      accepted: ['refused'],
      refused: ['accepted'],
      cancelled: [],
    };
    if (!allowed[current.status].includes(status)) {
      throw new ConflictError('Ce changement de statut n’est pas possible pour ce devis.');
    }
    if (status === 'accepted' && current.displayStatus === 'expired') {
      throw new ConflictError('Ce devis a expiré : prolongez sa date de validité avant de l’accepter.');
    }
    if (current.itemsCount === 0) throw new ValidationError('Ce devis n’a aucune prestation.');

    await db.update(quotes).set({ status, updatedAt: new Date() }).where(eq(quotes.id, id));
    await syncRequestStatusFromQuote(
      current.requestId,
      status === 'sent' ? 'quote_sent' : status === 'accepted' ? 'accepted' : 'refused',
    );
    const updated = await getQuoteRow(id);
    if (!updated) throw new NotFoundError('Devis introuvable');
    return updated;
  });
}

export async function cancelQuote(id: number, reason: string, user: { id: number; storeId: number | null }): Promise<QuoteRow> {
  const motif = String(reason ?? '').trim();
  if (!motif) throw new ValidationError('Le motif d’annulation est obligatoire.');
  return withTransaction(async () => {
    const current = await assertOwnQuote(id, Number(user.storeId));
    if (current.status === 'cancelled') throw new ConflictError('Ce devis est déjà annulé.');
    if (current.jobId) {
      throw new ConflictError(`Ce devis a donné le chantier ${current.jobReference} : annulez le chantier, pas le devis.`);
    }
    await db
      .update(quotes)
      .set({ status: 'cancelled', cancelReason: motif, cancelledAt: new Date(), cancelledBy: user.id, updatedAt: new Date() })
      .where(eq(quotes.id, id));
    const updated = await getQuoteRow(id);
    if (!updated) throw new NotFoundError('Devis introuvable');
    return updated;
  });
}

/**
 * Convertit un devis **accepté** en chantier. Les lignes sont recopiées avec
 * leurs prix figés : le chantier facture exactement ce que le client a accepté,
 * même si le catalogue a changé depuis. La demande d'origine passe « convertie ».
 */
export async function convertQuoteToJob(
  id: number,
  options: {
    storeId: number;
    userId?: number | null;
    startDate?: string | null;
    endDate?: string | null;
    responsibleUserId?: number | null;
    category?: string | null;
  },
): Promise<{ quote: QuoteRow; job: ServiceJobRow }> {
  return withTransaction(async () => {
    const quote = await assertOwnQuote(id, options.storeId);
    if (quote.jobId) throw new ConflictError(`Ce devis a déjà donné le chantier ${quote.jobReference}.`);
    if (quote.status !== 'accepted') throw new ConflictError('Seul un devis accepté se convertit en chantier.');

    const items = await listQuoteItems(id);
    if (items.length === 0) throw new ValidationError('Ce devis n’a aucune prestation.');

    const settings = await getSettings();
    const category =
      (await validCategory(options.category ?? quote.category)) ??
      (settings.jobCategories.includes('Autre') ? 'Autre' : settings.jobCategories[0]);

    const job = await createServiceJob({
      storeId: options.storeId,
      customerId: quote.customerId,
      category,
      title: quote.title,
      siteAddress: quote.siteAddress,
      description: quote.description,
      startDate: options.startDate ?? null,
      endDate: options.endDate ?? null,
      responsibleUserId: options.responsibleUserId ?? null,
      status: options.startDate ? 'planned' : 'pending',
      userId: options.userId ?? null,
      notes: quote.notes,
      quoteId: quote.id,
      requestId: quote.requestId,
      frozenItems: items.map((item) => ({
        serviceId: item.serviceId,
        serviceName: item.serviceName,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent,
        amount: item.amount,
      })),
    });

    await syncRequestStatusFromQuote(quote.requestId, 'converted');
    const updated = await getQuoteRow(id);
    if (!updated) throw new NotFoundError('Devis introuvable');
    return { quote: updated, job };
  });
}

/** Nouvelle version d'un devis (même client, mêmes lignes, prix du **jour** du catalogue). */
export async function duplicateQuote(id: number, storeId: number, userId?: number | null): Promise<QuoteRow> {
  const quote = await assertOwnQuote(id, storeId);
  const active = new Set(
    (await rawAll<{ id: number }>(`SELECT id FROM services WHERE store_id = ? AND status = 'active'`, [storeId])).map((r) =>
      Number(r.id),
    ),
  );
  const items = (await listQuoteItems(id)).filter((item) => item.serviceId && active.has(item.serviceId));
  if (items.length === 0) throw new ValidationError('Aucune prestation de ce devis n’est encore proposée au catalogue.');
  return createQuote({
    storeId,
    userId,
    customerId: quote.customerId,
    requestId: null,
    category: quote.category,
    title: quote.title,
    siteAddress: quote.siteAddress,
    description: quote.description,
    notes: quote.notes,
    // Les prestations désactivées ou archivées depuis sont écartées ci-dessus.
    items: items.map((item) => ({ serviceId: Number(item.serviceId), quantity: item.quantity, discountPercent: item.discountPercent })),
  });
}

/** Lignes reçues du navigateur → entrées validées ensuite par `prepareServiceLine`. */
export function parseQuoteItems(raw: unknown): JobItemInput[] {
  if (!Array.isArray(raw)) return [];
  const num = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return raw.map((item: any) => ({
    serviceId: num(item?.serviceId),
    quantity: num(item?.quantity),
    unitPrice: item?.unitPrice === undefined || item?.unitPrice === '' || item?.unitPrice === null ? null : num(item.unitPrice),
    discountPercent: num(item?.discountPercent),
  }));
}
