/**
 * Catalogue des prestations de chantier — **local à chaque magasin**
 * (cahier « Prestations de chantier » §3 à §5, README §19).
 *
 * Contrairement au catalogue de produits (central, modifiable au siège), chaque
 * magasin crée, tarife, désactive et archive **ses** prestations : Kaloum peut
 * vendre « Pose de carrelage » à 25 000 GNF le m² pendant que Matoto la vend
 * 30 000 GNF. Le code est unique **dans** le magasin.
 *
 * Les catégories, elles, restent la liste commune `settings.jobCategories` :
 * sans cela, « Électricité » à Kaloum et « Elec » à Matoto rendraient la
 * comparaison des magasins impossible (cahier §18).
 *
 * Règles :
 *  - aucune suppression : une prestation se **désactive** (plus proposée) ou
 *    s'**archive** (masquée des listes) ; l'historique reste ;
 *  - chaque changement de prix est historisé (`service_price_history`) ;
 *  - un devis ou un chantier ne peut utiliser qu'une prestation **active** de
 *    **son** magasin (`assertServiceUsable`, critère de recette n° 5) ;
 *  - les lignes de documents **figent** nom, unité et prix : modifier le
 *    catalogue ne change jamais un devis ou un chantier déjà établi.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { eq } from 'drizzle-orm';
import { services, servicePriceHistory } from '@/db/schema';
import { scopeSql, type StoreScope } from '@/lib/stores';
import { getSettings, nextSequence } from '@/lib/settings';
import { matchJobCategory, jobCategoryLabel } from '@/lib/job-categories';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api';
import { roundMoney, today } from '@/lib/format';

export const SERVICE_STATUS_VALUES = ['active', 'inactive', 'archived'] as const;
export type ServiceStatus = (typeof SERVICE_STATUS_VALUES)[number];

export function isServiceStatus(value: unknown): value is ServiceStatus {
  return typeof value === 'string' && (SERVICE_STATUS_VALUES as readonly string[]).includes(value);
}

export type ServiceRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  code: string;
  name: string;
  category: string;
  description: string | null;
  unit: string;
  unitPrice: number;
  status: ServiceStatus;
  /** Chantiers (non annulés) qui facturent cette prestation. */
  jobsCount: number;
  /** Chiffre d'affaires généré : somme des lignes de chantiers non annulés. */
  revenue: number;
  /** Quantité totale réalisée (toutes unités confondues pour une même prestation). */
  quantity: number;
  createdAt: Date | null;
};

export type ServicePriceChange = {
  id: number;
  oldPrice: number;
  newPrice: number;
  userName: string | null;
  date: string;
};

export type ServiceJobUse = {
  jobId: number;
  reference: string;
  customerName: string;
  status: string;
  startDate: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
};

export type ServiceDetail = {
  service: ServiceRow;
  priceHistory: ServicePriceChange[];
  jobs: ServiceJobUse[];
  quotesCount: number;
};

export type ServicesSummary = {
  active: number;
  inactive: number;
  archived: number;
  revenue: number;
  top: { id: number; name: string; revenue: number } | null;
};

export type ServiceInput = {
  code?: string | null;
  name: string;
  category: string;
  description?: string | null;
  unit?: string | null;
  unitPrice?: number;
};

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

/**
 * Agrégats d'usage : seuls les chantiers **actifs ou terminés** comptent
 * (un chantier annulé ne génère aucun chiffre d'affaires, un ancien chantier
 * resté au stade « devis » non plus).
 */
const SERVICE_SELECT = `
  SELECT s.id, s.store_id, st.name AS store_name, s.code, s.name, s.category, s.description,
         s.unit, s.unit_price, s.status, s.created_at,
         COALESCE(u.jobs_count, 0) AS jobs_count,
         COALESCE(u.revenue, 0) AS revenue,
         COALESCE(u.quantity, 0) AS quantity
  FROM services s
  LEFT JOIN stores st ON st.id = s.store_id
  LEFT JOIN (
    SELECT i.service_id,
           COUNT(DISTINCT i.job_id) AS jobs_count,
           SUM(i.amount) AS revenue,
           SUM(i.quantity) AS quantity
    FROM service_job_items i
    JOIN service_jobs j ON j.id = i.job_id
    WHERE j.status NOT IN ('cancelled', 'quote')
    GROUP BY i.service_id
  ) u ON u.service_id = s.id
`;

type ServiceSqlRow = {
  id: number;
  store_id: number;
  store_name: string | null;
  code: string;
  name: string;
  category: string;
  description: string | null;
  unit: string;
  unit_price: number;
  status: string;
  created_at: number | null;
  jobs_count: number;
  revenue: number;
  quantity: number;
};

function mapService(row: ServiceSqlRow): ServiceRow {
  return {
    id: Number(row.id),
    storeId: Number(row.store_id),
    storeName: row.store_name ?? null,
    code: row.code,
    name: row.name,
    category: jobCategoryLabel(row.category),
    description: row.description,
    unit: row.unit,
    unitPrice: Number(row.unit_price ?? 0),
    status: isServiceStatus(row.status) ? row.status : 'active',
    jobsCount: Number(row.jobs_count ?? 0),
    revenue: roundMoney(Number(row.revenue ?? 0)),
    quantity: Number(row.quantity ?? 0),
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

export type ServiceListOptions = {
  scope: StoreScope;
  search?: string;
  category?: string;
  /** `active`, `inactive`, `archived`, ou vide = actives + inactives (archives masquées). */
  status?: string;
  /** Tri : `name` (défaut), `revenue`, `usage`, `price`. */
  sort?: string;
  page?: number;
  limit?: number;
};

export async function listServices(
  options: ServiceListOptions,
): Promise<{ data: ServiceRow[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(500, options.limit ?? 20));
  const where: string[] = [scopeSql('s.store_id', options.scope)];
  const args: (string | number)[] = [];

  if (options.search?.trim()) {
    const like = `%${options.search.trim()}%`;
    where.push('(s.name LIKE ? OR s.code LIKE ? OR s.category LIKE ? OR s.description LIKE ?)');
    args.push(like, like, like, like);
  }
  if (options.category?.trim()) {
    where.push('LOWER(s.category) = LOWER(?)');
    args.push(options.category.trim());
  }
  if (isServiceStatus(options.status)) {
    where.push('s.status = ?');
    args.push(options.status);
  } else {
    // Par défaut, une prestation archivée ne pollue plus la liste.
    where.push("s.status <> 'archived'");
  }

  const order =
    options.sort === 'revenue'
      ? 'revenue DESC, s.name'
      : options.sort === 'usage'
        ? 'jobs_count DESC, s.name'
        : options.sort === 'price'
          ? 's.unit_price DESC, s.name'
          : options.sort === 'name'
            ? 's.name COLLATE NOCASE, s.id'
            : // Par défaut : la dernière prestation créée en tête (règle lib/list-sort.ts).
              's.created_at DESC, s.id DESC';

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = await rawAll<ServiceSqlRow>(
    `${SERVICE_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...args, limit, (page - 1) * limit],
  );
  const count = await rawGet<{ total: number }>(`SELECT COUNT(*) AS total FROM services s ${whereSql}`, args);
  const total = Number(count?.total ?? 0);

  return { data: rows.map(mapService), total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

export async function getServiceRow(id: number): Promise<ServiceRow | null> {
  const row = await rawGet<ServiceSqlRow>(`${SERVICE_SELECT} WHERE s.id = ?`, [id]);
  return row ? mapService(row) : null;
}

/** Fiche : historique des prix, chantiers qui l'utilisent, nombre de devis. */
export async function getServiceDetail(id: number): Promise<ServiceDetail | null> {
  const service = await getServiceRow(id);
  if (!service) return null;

  const [history, jobs, quotesRow] = await Promise.all([
    rawAll<{ id: number; old_price: number; new_price: number; user_name: string | null; date: string }>(
      `SELECT id, old_price, new_price, user_name, date FROM service_price_history
       WHERE service_id = ? ORDER BY id DESC`,
      [id],
    ),
    rawAll<{
      job_id: number;
      reference: string;
      customer_name: string | null;
      status: string;
      start_date: string | null;
      quantity: number;
      unit: string;
      unit_price: number;
      amount: number;
    }>(
      `SELECT j.id AS job_id, j.reference, c.name AS customer_name, j.status, j.start_date,
              SUM(i.quantity) AS quantity, i.unit, AVG(i.unit_price) AS unit_price, SUM(i.amount) AS amount
       FROM service_job_items i
       JOIN service_jobs j ON j.id = i.job_id
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE i.service_id = ?
       GROUP BY j.id
       ORDER BY COALESCE(j.start_date, date(j.created_at, 'unixepoch')) DESC, j.id DESC
       LIMIT 100`,
      [id],
    ),
    rawGet<{ count: number }>(
      `SELECT COUNT(DISTINCT q.id) AS count FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
       WHERE qi.service_id = ? AND q.status <> 'cancelled'`,
      [id],
    ),
  ]);

  return {
    service,
    priceHistory: history.map((h) => ({
      id: Number(h.id),
      oldPrice: Number(h.old_price),
      newPrice: Number(h.new_price),
      userName: h.user_name,
      date: h.date,
    })),
    jobs: jobs.map((j) => ({
      jobId: Number(j.job_id),
      reference: j.reference,
      customerName: j.customer_name ?? 'Client supprimé',
      status: j.status,
      startDate: j.start_date,
      quantity: Number(j.quantity ?? 0),
      unit: j.unit,
      unitPrice: roundMoney(Number(j.unit_price ?? 0)),
      amount: roundMoney(Number(j.amount ?? 0)),
    })),
    quotesCount: Number(quotesRow?.count ?? 0),
  };
}

export async function getServicesSummary(scope: StoreScope): Promise<ServicesSummary> {
  const counts = await rawAll<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM services s WHERE ${scopeSql('s.store_id', scope)} GROUP BY status`,
  );
  const top = await rawGet<{ id: number; name: string; revenue: number }>(
    `SELECT s.id, s.name, SUM(i.amount) AS revenue
     FROM service_job_items i
     JOIN service_jobs j ON j.id = i.job_id
     JOIN services s ON s.id = i.service_id
     WHERE j.status NOT IN ('cancelled', 'quote') AND ${scopeSql('s.store_id', scope)}
     GROUP BY s.id ORDER BY revenue DESC LIMIT 1`,
  );
  const revenue = await rawGet<{ total: number }>(
    `SELECT COALESCE(SUM(i.amount), 0) AS total
     FROM service_job_items i
     JOIN service_jobs j ON j.id = i.job_id
     JOIN services s ON s.id = i.service_id
     WHERE j.status NOT IN ('cancelled', 'quote') AND ${scopeSql('s.store_id', scope)}`,
  );
  const by = (status: string) => Number(counts.find((c) => c.status === status)?.count ?? 0);
  return {
    active: by('active'),
    inactive: by('inactive'),
    archived: by('archived'),
    revenue: roundMoney(Number(revenue?.total ?? 0)),
    top: top ? { id: Number(top.id), name: top.name, revenue: roundMoney(Number(top.revenue)) } : null,
  };
}

/**
 * Prestation utilisable dans un devis, une demande ou un chantier du magasin
 * `storeId`. Le serveur refuse une prestation d'un autre magasin même si
 * l'identifiant a été forgé à la main (critère de recette n° 5) — et une
 * prestation inactive ou archivée, qui n'est plus proposée.
 */
export async function assertServiceUsable(serviceId: number, storeId: number): Promise<ServiceRow> {
  const service = await getServiceRow(serviceId);
  if (!service) throw new NotFoundError('Prestation introuvable');
  if (service.storeId !== Number(storeId)) {
    throw new ValidationError(
      `La prestation « ${service.name} » appartient à un autre magasin : choisissez une prestation du catalogue de ce magasin.`,
    );
  }
  if (service.status !== 'active') {
    throw new ValidationError(
      `La prestation « ${service.name} » est ${service.status === 'archived' ? 'archivée' : 'désactivée'} : elle n’est plus proposée.`,
    );
  }
  return service;
}

/* ------------------------------------------------------------------ *
 * Écriture
 * ------------------------------------------------------------------ */

async function validateCategory(value: unknown): Promise<string> {
  const list = (await getSettings()).jobCategories;
  const match = matchJobCategory(value, list);
  if (!match) {
    throw new ValidationError(`Catégorie inconnue. Choisissez l’une des catégories des paramètres : ${list.join(', ')}.`);
  }
  return match;
}

function cleanPrice(value: unknown): number {
  const price = roundMoney(Number(value ?? 0));
  if (!Number.isFinite(price) || price < 0) throw new ValidationError('Le prix estimatif doit être positif ou nul.');
  return price;
}

function cleanCode(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .slice(0, 30);
}

async function codeTaken(storeId: number, code: string, exceptId?: number): Promise<boolean> {
  const row = await rawGet<{ id: number }>(
    'SELECT id FROM services WHERE store_id = ? AND UPPER(code) = UPPER(?) LIMIT 1',
    [storeId, code],
  );
  return Boolean(row && Number(row.id) !== exceptId);
}

/** Code automatique `PRE-001`, `PRE-002`… propre au magasin. */
async function nextServiceCode(storeId: number): Promise<string> {
  const prefix = (await getSettings()).servicePrefix || 'PRE';
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    // Année 0 : la série ne repart pas à zéro chaque année (un code est permanent).
    const sequence = await nextSequence(`service:${storeId}`, 0);
    const code = `${prefix}-${String(sequence).padStart(3, '0')}`;
    if (!(await codeTaken(storeId, code))) return code;
  }
  throw new Error('Code de prestation impossible à attribuer');
}

export async function createService(
  input: ServiceInput & { storeId: number; userId?: number | null },
): Promise<ServiceRow> {
  return withTransaction(async () => {
    if (!input.storeId) throw new ValidationError('Aucun magasin actif : choisissez un magasin.');
    const name = String(input.name ?? '').trim();
    if (!name) throw new ValidationError('Le nom de la prestation est obligatoire.');

    // Code toujours attribué par le logiciel (PRE-001, PRE-002… du magasin) : un
    // code envoyé par le client est ignoré, la numérotation reste continue.
    const code = await nextServiceCode(input.storeId);

    const inserted = await db
      .insert(services)
      .values({
        storeId: input.storeId,
        code,
        name,
        category: await validateCategory(input.category),
        description: input.description?.trim() || null,
        unit: input.unit?.trim() || 'forfait',
        unitPrice: cleanPrice(input.unitPrice),
        status: 'active',
        userId: input.userId ?? null,
      })
      .returning({ id: services.id });

    const created = await getServiceRow(inserted[0].id);
    if (!created) throw new NotFoundError('Prestation créée mais introuvable');
    return created;
  });
}

/** Une prestation ne se modifie que depuis **son** magasin. */
async function assertOwnService(id: number, storeId: number): Promise<ServiceRow> {
  const service = await getServiceRow(id);
  if (!service) throw new NotFoundError('Prestation introuvable');
  if (!storeId || service.storeId !== Number(storeId)) {
    throw new ValidationError(
      'Cette prestation appartient à un autre magasin : elle ne peut être modifiée que depuis ce magasin.',
    );
  }
  return service;
}

export async function updateService(
  id: number,
  patch: Partial<ServiceInput>,
  ctx: { storeId: number; userId?: number | null; userName?: string | null },
): Promise<{ service: ServiceRow; changes: Record<string, { from: unknown; to: unknown }> }> {
  return withTransaction(async () => {
    const current = await assertOwnService(id, ctx.storeId);
    const values: Record<string, unknown> = { updatedAt: new Date() };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const track = (key: string, from: unknown, to: unknown) => {
      if (from !== to) changes[key] = { from, to };
    };

    if (patch.name !== undefined) {
      const name = String(patch.name ?? '').trim();
      if (!name) throw new ValidationError('Le nom de la prestation est obligatoire.');
      values.name = name;
      track('name', current.name, name);
    }
    if (patch.code !== undefined) {
      const code = cleanCode(patch.code);
      if (!code) throw new ValidationError('Le code ne peut pas être vide.');
      if (await codeTaken(ctx.storeId, code, id)) {
        throw new ConflictError(`Le code « ${code} » est déjà utilisé dans ce magasin.`);
      }
      values.code = code;
      track('code', current.code, code);
    }
    if (patch.category !== undefined) {
      // La catégorie actuelle reste acceptée même si elle a été retirée de la liste.
      const category =
        String(patch.category).trim().toLowerCase() === current.category.toLowerCase()
          ? current.category
          : await validateCategory(patch.category);
      values.category = category;
      track('category', current.category, category);
    }
    if (patch.description !== undefined) {
      values.description = patch.description?.trim() || null;
      track('description', current.description, values.description);
    }
    if (patch.unit !== undefined) {
      values.unit = patch.unit?.trim() || 'forfait';
      track('unit', current.unit, values.unit);
    }
    if (patch.unitPrice !== undefined) {
      const price = cleanPrice(patch.unitPrice);
      values.unitPrice = price;
      if (price !== current.unitPrice) {
        track('unitPrice', current.unitPrice, price);
        await db.insert(servicePriceHistory).values({
          serviceId: id,
          oldPrice: current.unitPrice,
          newPrice: price,
          userId: ctx.userId ?? null,
          userName: ctx.userName ?? null,
          date: today(),
        });
      }
    }

    await db.update(services).set(values as any).where(eq(services.id, id));
    const service = await getServiceRow(id);
    if (!service) throw new NotFoundError('Prestation introuvable');
    return { service, changes };
  });
}

/** Activer, désactiver ou archiver — jamais supprimer. */
export async function setServiceStatus(id: number, status: ServiceStatus, storeId: number): Promise<ServiceRow> {
  if (!isServiceStatus(status)) throw new ValidationError('Statut de prestation invalide');
  const current = await assertOwnService(id, storeId);
  if (current.status === status) return current;
  await db.update(services).set({ status, updatedAt: new Date() }).where(eq(services.id, id));
  const service = await getServiceRow(id);
  if (!service) throw new NotFoundError('Prestation introuvable');
  return service;
}

/** Montant d'une ligne : quantité × prix, moins la remise en pourcentage. */
export function lineAmount(quantity: number, unitPrice: number, discountPercent: number): number {
  const discount = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  return roundMoney(quantity * unitPrice * (1 - discount / 100));
}
