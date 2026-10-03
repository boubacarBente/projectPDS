/**
 * Demandes de prestation (cahier « Prestations de chantier » §8).
 *
 * La demande est le **besoin exprimé** par un client, avant tout chiffrage :
 * « refaire l'électricité de la villa, visite souhaitée la semaine prochaine ».
 * Elle appartient au magasin qui la reçoit et suit un cycle :
 *
 *   nouvelle → étude → visite → devis à préparer → devis envoyé
 *            → acceptée / refusée → convertie en chantier
 *
 * Les trois dernières étapes sont **posées automatiquement** par le devis qui
 * en découle (`lib/quotes.ts`) : envoyer le devis passe la demande en « devis
 * envoyé », l'accepter en « acceptée », le convertir en « convertie ». Les
 * premières se changent à la main.
 *
 * Aucune suppression : une demande sans suite se **refuse** (motif en note).
 * Photos et documents joints : hors périmètre de cette version.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { eq } from 'drizzle-orm';
import { serviceRequestItems, serviceRequests } from '@/db/schema';
import { scopeSql, type StoreScope } from '@/lib/stores';
import { nextDocumentNumber } from '@/lib/settings';
import { assertServiceUsable } from '@/lib/services';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api';
import { today } from '@/lib/format';

export const REQUEST_STATUS_VALUES = [
  'new',
  'study',
  'visit',
  'quote_to_prepare',
  'quote_sent',
  'accepted',
  'refused',
  'converted',
] as const;
export type RequestStatus = (typeof REQUEST_STATUS_VALUES)[number];

/** Statuts où la demande attend encore une action du magasin. */
export const PENDING_REQUEST_STATUSES: RequestStatus[] = ['new', 'study', 'visit', 'quote_to_prepare', 'quote_sent'];

/** Statuts que l'on peut poser à la main (les autres découlent du devis). */
export const MANUAL_REQUEST_STATUSES: RequestStatus[] = ['new', 'study', 'visit', 'quote_to_prepare', 'refused'];

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === 'string' && (REQUEST_STATUS_VALUES as readonly string[]).includes(value);
}

export type ServiceRequestRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  reference: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  date: string;
  need: string;
  siteAddress: string | null;
  desiredDate: string | null;
  status: RequestStatus;
  services: { serviceId: number | null; serviceName: string }[];
  /** Dernier devis établi à partir de la demande (calculé). */
  quoteId: number | null;
  quoteReference: string | null;
  /** Chantier issu de la demande (calculé). */
  jobId: number | null;
  jobReference: string | null;
  userName: string | null;
  notes: string | null;
  createdAt: Date | null;
};

export type RequestsSummary = {
  total: number;
  pending: number;
  byStatus: Record<RequestStatus, number>;
};

const REQUEST_SELECT = `
  SELECT r.id, r.store_id, st.name AS store_name, r.reference, r.customer_id, c.name AS customer_name,
         c.phone AS customer_phone, r.date, r.need, r.site_address, r.desired_date, r.status,
         r.notes, r.created_at, u.name AS user_name,
         (SELECT q.id FROM quotes q WHERE q.request_id = r.id AND q.status <> 'cancelled' ORDER BY q.id DESC LIMIT 1) AS quote_id,
         (SELECT q.reference FROM quotes q WHERE q.request_id = r.id AND q.status <> 'cancelled' ORDER BY q.id DESC LIMIT 1) AS quote_reference,
         (SELECT j.id FROM service_jobs j WHERE j.request_id = r.id ORDER BY j.id DESC LIMIT 1) AS job_id,
         (SELECT j.reference FROM service_jobs j WHERE j.request_id = r.id ORDER BY j.id DESC LIMIT 1) AS job_reference
  FROM service_requests r
  LEFT JOIN customers c ON c.id = r.customer_id
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN stores st ON st.id = r.store_id
`;

async function itemsByRequest(ids: number[]): Promise<Map<number, { serviceId: number | null; serviceName: string }[]>> {
  const map = new Map<number, { serviceId: number | null; serviceName: string }[]>();
  if (ids.length === 0) return map;
  const rows = await rawAll<{ request_id: number; service_id: number | null; service_name: string }>(
    `SELECT request_id, service_id, service_name FROM service_request_items
     WHERE request_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids,
  );
  for (const row of rows) {
    const list = map.get(Number(row.request_id)) ?? [];
    list.push({ serviceId: row.service_id == null ? null : Number(row.service_id), serviceName: row.service_name });
    map.set(Number(row.request_id), list);
  }
  return map;
}

function mapRequest(row: any, services: { serviceId: number | null; serviceName: string }[]): ServiceRequestRow {
  return {
    id: Number(row.id),
    storeId: Number(row.store_id),
    storeName: row.store_name ?? null,
    reference: row.reference,
    customerId: Number(row.customer_id),
    customerName: row.customer_name ?? 'Client supprimé',
    customerPhone: row.customer_phone ?? null,
    date: row.date,
    need: row.need,
    siteAddress: row.site_address ?? null,
    desiredDate: row.desired_date ?? null,
    status: isRequestStatus(row.status) ? row.status : 'new',
    services,
    quoteId: row.quote_id == null ? null : Number(row.quote_id),
    quoteReference: row.quote_reference ?? null,
    jobId: row.job_id == null ? null : Number(row.job_id),
    jobReference: row.job_reference ?? null,
    userName: row.user_name ?? null,
    notes: row.notes ?? null,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

export async function listServiceRequests(options: {
  scope: StoreScope;
  search?: string;
  /** Un statut, ou `pending` pour toutes les demandes en attente. */
  status?: string;
  customerId?: number;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}): Promise<{ data: ServiceRequestRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const where: string[] = [scopeSql('r.store_id', options.scope)];
  const args: (string | number)[] = [];

  if (options.search?.trim()) {
    const like = `%${options.search.trim()}%`;
    where.push('(r.reference LIKE ? OR c.name LIKE ? OR r.need LIKE ? OR r.site_address LIKE ?)');
    args.push(like, like, like, like);
  }
  if (options.status === 'pending') {
    where.push(`r.status IN (${PENDING_REQUEST_STATUSES.map((s) => `'${s}'`).join(',')})`);
  } else if (isRequestStatus(options.status)) {
    where.push('r.status = ?');
    args.push(options.status);
  }
  if (options.customerId) {
    where.push('r.customer_id = ?');
    args.push(options.customerId);
  }
  if (options.from) {
    where.push('r.date >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('r.date <= ?');
    args.push(options.to);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = await rawAll<any>(`${REQUEST_SELECT} ${whereSql} ORDER BY r.date DESC, r.id DESC LIMIT ? OFFSET ?`, [
    ...args,
    limit,
    (page - 1) * limit,
  ]);
  const count = await rawGet<{ total: number }>(
    `SELECT COUNT(*) AS total FROM service_requests r LEFT JOIN customers c ON c.id = r.customer_id ${whereSql}`,
    args,
  );
  const items = await itemsByRequest(rows.map((r) => Number(r.id)));
  const total = Number(count?.total ?? 0);
  return {
    data: rows.map((row) => mapRequest(row, items.get(Number(row.id)) ?? [])),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function getServiceRequest(id: number): Promise<ServiceRequestRow | null> {
  const row = await rawGet<any>(`${REQUEST_SELECT} WHERE r.id = ?`, [id]);
  if (!row) return null;
  const items = await itemsByRequest([id]);
  return mapRequest(row, items.get(id) ?? []);
}

export async function getRequestsSummary(scope: StoreScope, from?: string, to?: string): Promise<RequestsSummary> {
  const where = [scopeSql('store_id', scope)];
  const args: string[] = [];
  if (from) {
    where.push('date >= ?');
    args.push(from);
  }
  if (to) {
    where.push('date <= ?');
    args.push(to);
  }
  const rows = await rawAll<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM service_requests WHERE ${where.join(' AND ')} GROUP BY status`,
    args,
  );
  const byStatus = Object.fromEntries(REQUEST_STATUS_VALUES.map((s) => [s, 0])) as Record<RequestStatus, number>;
  let total = 0;
  for (const row of rows) {
    if (isRequestStatus(row.status)) byStatus[row.status] = Number(row.count);
    total += Number(row.count);
  }
  return { total, pending: PENDING_REQUEST_STATUSES.reduce((sum, s) => sum + byStatus[s], 0), byStatus };
}

/* ------------------------------------------------------------------ *
 * Écriture
 * ------------------------------------------------------------------ */

function cleanDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ValidationError(`${label} : date au format AAAA-MM-JJ attendue`);
  return text;
}

async function assertCustomer(customerId: unknown): Promise<number> {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Le client est obligatoire.');
  const row = await rawGet<{ id: number }>('SELECT id FROM customers WHERE id = ?', [id]);
  if (!row) throw new ValidationError('Client introuvable');
  return id;
}

async function writeItems(requestId: number, serviceIds: unknown, storeId: number) {
  const ids = Array.from(new Set((Array.isArray(serviceIds) ? serviceIds : []).map(Number).filter((n) => n > 0)));
  for (const serviceId of ids) {
    const service = await assertServiceUsable(serviceId, storeId);
    await db.insert(serviceRequestItems).values({ requestId, serviceId: service.id, serviceName: service.name });
  }
}

export async function createServiceRequest(input: {
  storeId: number;
  customerId: number;
  need: string;
  date?: string | null;
  siteAddress?: string | null;
  desiredDate?: string | null;
  serviceIds?: number[];
  notes?: string | null;
  userId?: number | null;
}): Promise<ServiceRequestRow> {
  return withTransaction(async () => {
    if (!input.storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');
    const customerId = await assertCustomer(input.customerId);
    const need = String(input.need ?? '').trim();
    if (!need) throw new ValidationError('Décrivez le besoin du client.');

    const inserted = await db
      .insert(serviceRequests)
      .values({
        storeId: input.storeId,
        reference: await nextDocumentNumber('request', input.storeId),
        customerId,
        date: cleanDate(input.date, 'Date de la demande') ?? today(),
        need,
        siteAddress: input.siteAddress?.trim() || null,
        desiredDate: cleanDate(input.desiredDate, 'Date souhaitée'),
        status: 'new',
        notes: input.notes?.trim() || null,
        userId: input.userId ?? null,
      })
      .returning({ id: serviceRequests.id });

    await writeItems(inserted[0].id, input.serviceIds, input.storeId);
    const created = await getServiceRequest(inserted[0].id);
    if (!created) throw new NotFoundError('Demande créée mais introuvable');
    return created;
  });
}

/** Une demande ne se modifie que depuis son magasin, et tant qu'elle n'est pas close. */
async function assertRequestEditable(id: number, storeId: number): Promise<ServiceRequestRow> {
  const request = await getServiceRequest(id);
  if (!request) throw new NotFoundError('Demande introuvable');
  if (!storeId || request.storeId !== Number(storeId)) {
    throw new ValidationError('Cette demande appartient à un autre magasin : elle ne peut être modifiée que depuis ce magasin.');
  }
  return request;
}

export async function updateServiceRequest(
  id: number,
  patch: {
    customerId?: number;
    need?: string;
    date?: string | null;
    siteAddress?: string | null;
    desiredDate?: string | null;
    serviceIds?: number[];
    notes?: string | null;
  },
  storeId: number,
): Promise<ServiceRequestRow> {
  return withTransaction(async () => {
    const current = await assertRequestEditable(id, storeId);
    if (current.status === 'converted') {
      throw new ConflictError('Cette demande est déjà convertie en chantier : elle ne se modifie plus.');
    }
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.customerId !== undefined) values.customerId = await assertCustomer(patch.customerId);
    if (patch.need !== undefined) {
      const need = String(patch.need ?? '').trim();
      if (!need) throw new ValidationError('Décrivez le besoin du client.');
      values.need = need;
    }
    if (patch.date !== undefined) values.date = cleanDate(patch.date, 'Date de la demande') ?? current.date;
    if (patch.siteAddress !== undefined) values.siteAddress = patch.siteAddress?.trim() || null;
    if (patch.desiredDate !== undefined) values.desiredDate = cleanDate(patch.desiredDate, 'Date souhaitée');
    if (patch.notes !== undefined) values.notes = patch.notes?.trim() || null;
    await db.update(serviceRequests).set(values as any).where(eq(serviceRequests.id, id));

    if (patch.serviceIds !== undefined) {
      // Liste de souhaits (sans montant) : on la remplace telle quelle.
      await db.delete(serviceRequestItems).where(eq(serviceRequestItems.requestId, id));
      await writeItems(id, patch.serviceIds, storeId);
    }
    const updated = await getServiceRequest(id);
    if (!updated) throw new NotFoundError('Demande introuvable');
    return updated;
  });
}

/**
 * Changement de statut manuel. « Convertie » ne se pose jamais à la main : il
 * découle de la conversion du devis en chantier.
 */
export async function setServiceRequestStatus(
  id: number,
  status: RequestStatus,
  storeId: number,
  note?: string | null,
): Promise<ServiceRequestRow> {
  const current = await assertRequestEditable(id, storeId);
  if (!MANUAL_REQUEST_STATUSES.includes(status)) {
    throw new ValidationError('Ce statut découle du devis : il ne se choisit pas à la main.');
  }
  if (current.status === 'converted') throw new ConflictError('Cette demande est déjà convertie en chantier.');
  const values: Record<string, unknown> = { status, updatedAt: new Date() };
  if (status === 'refused' && note?.trim()) {
    values.notes = current.notes ? `${current.notes}\nRefus : ${note.trim()}` : `Refus : ${note.trim()}`;
  }
  await db.update(serviceRequests).set(values as any).where(eq(serviceRequests.id, id));
  const updated = await getServiceRequest(id);
  if (!updated) throw new NotFoundError('Demande introuvable');
  return updated;
}

/** Statut posé par le devis (envoi, acceptation, refus, conversion). */
export async function syncRequestStatusFromQuote(requestId: number | null, status: RequestStatus): Promise<void> {
  if (!requestId) return;
  const current = await rawGet<{ status: string }>('SELECT status FROM service_requests WHERE id = ?', [requestId]);
  if (!current || current.status === 'converted') return;
  await db.update(serviceRequests).set({ status, updatedAt: new Date() }).where(eq(serviceRequests.id, requestId));
}
