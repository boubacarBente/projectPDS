/**
 * Magasins, affectations et **contexte de magasin** (cahier des charges
 * multi-magasins §4, §5).
 *
 * Règle de sécurité centrale (§5, §19.3) : le serveur ne croit **jamais** le
 * magasin envoyé par le navigateur. Le magasin actif est lu dans la session,
 * puis revérifié à chaque requête contre :
 *  1. les affectations de l'utilisateur (`user_stores`) — l'administrateur
 *     général et les détenteurs de `stores.viewAll` voient tous les magasins ;
 *  2. le périmètre du poste (un poste de magasin ne connaît que son magasin) ;
 *  3. le statut du magasin (un magasin archivé n'est plus sélectionnable, un
 *     magasin suspendu reste consultable mais refuse les nouvelles opérations).
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { stores, userStores } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getDeviceConfig } from '@/lib/device';
import { writeAudit } from '@/lib/audit';
import { normalizeDocumentPhones } from '@/lib/settings-schema';

export type StoreStatus = 'active' | 'suspended' | 'archived';
export type StoreKind = 'store' | 'headquarters';

export type StoreRow = {
  id: number;
  syncId: string;
  code: string;
  name: string;
  kind: StoreKind;
  address: string | null;
  phone: string | null;
  email: string | null;
  managerUserId: number | null;
  managerName: string | null;
  openingDate: string | null;
  status: StoreStatus;
  openingHours: string | null;
  receiptFooter: string | null;
  /** Numéros de l'en-tête des documents (format stocké), 3 au plus. */
  documentPhones: string[];
  settings: Record<string, unknown>;
  notes: string | null;
  createdAt: Date | null;
};

export class StoreError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

function parseSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function mapStore(row: any): StoreRow {
  return {
    id: Number(row.id),
    syncId: String(row.sync_id),
    code: String(row.code),
    name: String(row.name),
    kind: row.kind === 'headquarters' ? 'headquarters' : 'store',
    address: row.address ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    managerUserId: row.manager_user_id === null || row.manager_user_id === undefined ? null : Number(row.manager_user_id),
    managerName: row.manager_name ?? null,
    openingDate: row.opening_date ?? null,
    status: (['active', 'suspended', 'archived'].includes(row.status) ? row.status : 'active') as StoreStatus,
    openingHours: row.opening_hours ?? null,
    receiptFooter: row.receipt_footer ?? null,
    documentPhones: String(row.document_phones ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    settings: parseSettings(row.settings),
    notes: row.notes ?? null,
    createdAt: row.created_at ? new Date(Number(row.created_at) * 1000) : null,
  };
}

const STORE_SELECT = `SELECT s.*, u.name AS manager_name
  FROM stores s
  LEFT JOIN users u ON u.id = s.manager_user_id`;

export async function listStores(options: { includeArchived?: boolean; ids?: number[] } = {}): Promise<StoreRow[]> {
  const conditions: string[] = ['s.deleted_at IS NULL'];
  if (!options.includeArchived) conditions.push(`s.status <> 'archived'`);
  if (options.ids) {
    if (options.ids.length === 0) return [];
    conditions.push(`s.id IN (${options.ids.map((id) => Number(id)).join(',')})`);
  }
  const rows = await rawAll(
    `${STORE_SELECT} WHERE ${conditions.join(' AND ')}
     ORDER BY CASE s.kind WHEN 'headquarters' THEN 0 ELSE 1 END, s.name`,
  );
  return rows.map(mapStore);
}

export async function getStore(id: number): Promise<StoreRow | null> {
  const row = await rawGet(`${STORE_SELECT} WHERE s.id = ?`, [id]);
  return row ? mapStore(row) : null;
}

export async function getStoreBySyncId(syncId: string): Promise<StoreRow | null> {
  const row = await rawGet(`${STORE_SELECT} WHERE s.sync_id = ?`, [syncId]);
  return row ? mapStore(row) : null;
}

export async function countStores(): Promise<number> {
  try {
    const row = await rawGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stores WHERE deleted_at IS NULL`);
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Contexte de magasin d'un utilisateur
 * ------------------------------------------------------------------ */

export type StoreContext = {
  /** Magasins que l'utilisateur peut consulter **sur ce poste** (archivés exclus). */
  storeIds: number[];
  /** Magasin actif (opérations), ou `null` si aucun n'est disponible. */
  activeStoreId: number | null;
  /** Accès à tous les magasins (administrateur général ou `stores.viewAll`). */
  allStores: boolean;
};

/**
 * Magasins accessibles à un utilisateur, en tenant compte du poste.
 *
 * @param viewAll l'utilisateur a-t-il la permission `stores.viewAll` (l'admin
 *   l'a toujours) ?
 */
export async function getAccessibleStoreIds(
  user: { id: number; role: string },
  viewAll: boolean,
): Promise<{ ids: number[]; allStores: boolean }> {
  let ids: number[];
  const allStores = user.role === 'admin' || viewAll;

  try {
    if (allStores) {
      const rows = await rawAll<{ id: number }>(
        `SELECT id FROM stores WHERE deleted_at IS NULL AND status <> 'archived' ORDER BY id`,
      );
      ids = rows.map((r) => Number(r.id));
    } else {
      const rows = await rawAll<{ id: number }>(
        `SELECT s.id FROM user_stores us
           JOIN stores s ON s.id = us.store_id
          WHERE us.user_id = ? AND us.is_active = 1 AND us.deleted_at IS NULL
            AND s.deleted_at IS NULL AND s.status <> 'archived'
            AND (us.ends_at IS NULL OR us.ends_at >= date('now'))
            -- « À partir du » était enregistré mais jamais lu : un remplaçant
            -- affecté pour plus tard avait accès dès le jour de la saisie.
            AND (us.starts_at IS NULL OR us.starts_at = '' OR us.starts_at <= date('now'))
          ORDER BY s.id`,
        [user.id],
      );
      ids = rows.map((r) => Number(r.id));
    }
  } catch (error: any) {
    if (/no such table/i.test(error?.message ?? '')) return { ids: [], allStores };
    throw error;
  }

  // Périmètre du poste : un poste de magasin ne connaît que son magasin.
  const device = await getDeviceConfig();
  if (device.mode === 'store') {
    ids = device.storeId ? ids.filter((id) => id === device.storeId) : [];
  }

  return { ids, allStores };
}

export async function resolveStoreContext(
  user: { id: number; role: string },
  sessionStoreId: number | null,
  viewAll: boolean,
  /** Permission `stores.switch` (l'administrateur l'a toujours). */
  canSwitch = true,
): Promise<StoreContext> {
  const { ids, allStores } = await getAccessibleStoreIds(user, viewAll);
  // Sans le droit de changer de magasin, le magasin actif est **toujours** le
  // magasin principal, quoi que contienne la session (README §28.6).
  if (!canSwitch && user.role !== 'admin') {
    return { storeIds: ids, activeStoreId: await getHomeStoreId(user.id, ids), allStores };
  }
  const activeStoreId =
    sessionStoreId !== null && ids.includes(sessionStoreId) ? sessionStoreId : (ids[0] ?? null);
  return { storeIds: ids, activeStoreId, allStores };
}

/**
 * Magasin **principal** d'un compte, parmi ses magasins accessibles : celui
 * dont il est gérant, sinon sa plus ancienne affectation active, sinon le
 * premier magasin accessible. C'est là que travaille un compte qui n'a pas
 * le droit de changer de magasin.
 */
export async function getHomeStoreId(userId: number, accessible: number[]): Promise<number | null> {
  if (accessible.length === 0) return null;
  const row = await rawGet<{ store_id: number }>(
    `SELECT us.store_id FROM user_stores us
      WHERE us.user_id = ? AND us.is_active = 1 AND us.deleted_at IS NULL
        AND us.store_id IN (${accessible.map((id) => Number(id)).join(',')})
      ORDER BY us.is_manager DESC, us.id ASC LIMIT 1`,
    [userId],
  );
  return row ? Number(row.store_id) : accessible[0];
}

/**
 * Le magasin accepte-t-il de nouvelles opérations **sur ce poste** ?
 *
 *  - un magasin suspendu ou archivé n'accepte plus rien (§4) ;
 *  - sur le poste du **siège** (mode `hq`), les autres magasins sont en
 *    **lecture seule** : leurs ventes, caisses et stocks se saisissent sur leur
 *    propre poste. Sinon deux postes hors ligne ouvriraient chacun une caisse
 *    pour le même magasin. Le siège reste libre d'opérer dans son propre
 *    établissement (`kind = 'headquarters'`).
 */
export async function assertStoreWritable(storeId: number): Promise<void> {
  const row = await rawGet<{ status: string; name: string; kind: string }>(
    `SELECT status, name, kind FROM stores WHERE id = ?`,
    [storeId],
  );
  if (!row) throw new StoreError('Magasin introuvable', 404);
  const device = await getDeviceConfig();
  if (device.mode === 'hq' && row.kind !== 'headquarters') {
    throw new StoreError(
      `Le poste du siège consulte « ${row.name} » en lecture seule : les opérations de ce magasin se saisissent sur son propre poste.`,
      403,
    );
  }
  if (row.status !== 'active') {
    throw new StoreError(
      row.status === 'suspended'
        ? `Le magasin « ${row.name} » est suspendu : aucune nouvelle opération n’est acceptée. Son historique reste consultable.`
        : `Le magasin « ${row.name} » est archivé.`,
      403,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Création et modification
 * ------------------------------------------------------------------ */

export type StoreInput = {
  code?: string;
  name?: string;
  kind?: StoreKind;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  managerUserId?: number | null;
  openingDate?: string | null;
  openingHours?: string | null;
  receiptFooter?: string | null;
  documentPhones?: unknown;
  settings?: Record<string, unknown> | null;
  notes?: string | null;
  /**
   * Création seulement : magasin dont on recopie l'**assortiment** (la liste
   * des produits proposés, sans stock ni prix local). Absent = assortiment vide,
   * le magasin ajoute ses produits lui-même.
   */
  copyAssortmentFrom?: number | null;
};

function cleanCode(value: unknown): string {
  const code = String(value ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (!/^[A-Z0-9]{2,8}$/.test(code)) {
    throw new StoreError('Le code du magasin doit faire 2 à 8 caractères (lettres et chiffres, ex. KAL, MATOTO).');
  }
  return code;
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

async function assertCodeAvailable(code: string, excludeId?: number) {
  const row = await rawGet<{ id: number }>(`SELECT id FROM stores WHERE code = ?`, [code]);
  if (row && Number(row.id) !== excludeId) {
    throw new StoreError(`Le code « ${code} » est déjà utilisé par un autre magasin.`, 409);
  }
}

async function assertManager(userId: number | null | undefined) {
  if (!userId) return;
  const row = await rawGet<{ is_active: number }>(`SELECT is_active FROM users WHERE id = ?`, [userId]);
  if (!row || !row.is_active) throw new StoreError('Le gérant désigné est introuvable ou désactivé.');
}

/** Affecte le gérant à son magasin (création de l'affectation si besoin). */
async function ensureManagerAssignment(storeId: number, userId: number) {
  const existing = await rawGet<{ id: number }>(
    `SELECT id FROM user_stores WHERE user_id = ? AND store_id = ?`,
    [userId, storeId],
  );
  if (existing) {
    await db
      .update(userStores)
      .set({ isManager: true, isActive: true, deletedAt: null })
      .where(eq(userStores.id, Number(existing.id)));
  } else {
    await db.insert(userStores).values({
      userId,
      storeId,
      isManager: true,
      isActive: true,
      syncId: await userStoreSyncId(userId, storeId),
    });
  }
}

/** Identité déterministe d'une affectation (`us-<utilisateur>-<magasin>`) : pas de doublon entre postes. */
export async function userStoreSyncId(userId: number, storeId: number): Promise<string> {
  const row = await rawGet<{ id: string }>(
    `SELECT 'us-' || u.sync_id || '-' || s.sync_id AS id FROM users u, stores s WHERE u.id = ? AND s.id = ?`,
    [userId, storeId],
  );
  return row?.id ?? crypto.randomUUID();
}

export async function createStore(
  input: StoreInput,
  actor?: { id: number; name: string } | null,
): Promise<StoreRow> {
  const code = cleanCode(input.code);
  const name = cleanText(input.name);
  if (!name) throw new StoreError('Le nom du magasin est obligatoire.');

  return withTransaction(async () => {
    await assertCodeAvailable(code);
    await assertManager(input.managerUserId);

    const [created] = await db
      .insert(stores)
      .values({
        code,
        name,
        kind: input.kind === 'headquarters' ? 'headquarters' : 'store',
        address: cleanText(input.address),
        phone: cleanText(input.phone),
        email: cleanText(input.email),
        managerUserId: input.managerUserId ?? null,
        openingDate: cleanText(input.openingDate),
        openingHours: cleanText(input.openingHours),
        receiptFooter: cleanText(input.receiptFooter),
        documentPhones: normalizeDocumentPhones(input.documentPhones).join(',') || null,
        settings: input.settings ? JSON.stringify(input.settings) : null,
        notes: cleanText(input.notes),
        status: 'active',
      })
      .returning({ id: stores.id });

    const storeId = Number(created.id);

    /*
     * Assortiment de départ (README §28.5) : chaque magasin a ses propres
     * produits. Avant, le nouveau magasin recevait tout le catalogue ; il part
     * désormais vide, ou de la liste d'un magasin existant.
     */
    const sourceId = Number(input.copyAssortmentFrom ?? 0);
    if (sourceId > 0) {
      await rawAll(
        `INSERT INTO product_stocks (store_id, product_id, quantity, is_listed, created_at, sync_id, updated_at)
         SELECT s.id, src.product_id, 0, 1, unixepoch(), 'ps-' || s.sync_id || '-' || p.sync_id, unixepoch()
           FROM product_stocks src
           JOIN products p ON p.id = src.product_id AND p.is_active = 1
           JOIN stores s ON s.id = ?
          WHERE src.store_id = ? AND src.is_listed = 1
            AND NOT EXISTS (SELECT 1 FROM product_stocks ps WHERE ps.store_id = s.id AND ps.product_id = p.id)`,
        [storeId, sourceId],
      );
    }

    if (input.managerUserId) await ensureManagerAssignment(storeId, input.managerUserId);

    await writeAudit({
      user: actor ?? null,
      storeId,
      action: 'create',
      entity: 'store',
      entityId: storeId,
      details: { code, name, kind: input.kind ?? 'store', managerUserId: input.managerUserId ?? null },
    });

    return (await getStore(storeId))!;
  });
}

export async function updateStore(
  id: number,
  input: StoreInput,
  actor?: { id: number; name: string } | null,
): Promise<StoreRow> {
  return withTransaction(async () => {
    const existing = await getStore(id);
    if (!existing) throw new StoreError('Magasin introuvable', 404);

    const updates: Record<string, unknown> = {};
    if (input.code !== undefined) {
      const code = cleanCode(input.code);
      if (code !== existing.code) {
        await assertCodeAvailable(code, id);
        updates.code = code;
      }
    }
    if (input.name !== undefined) {
      const name = cleanText(input.name);
      if (!name) throw new StoreError('Le nom du magasin est obligatoire.');
      updates.name = name;
    }
    if (input.kind !== undefined) updates.kind = input.kind === 'headquarters' ? 'headquarters' : 'store';
    for (const field of ['address', 'phone', 'email', 'openingDate', 'openingHours', 'receiptFooter', 'notes'] as const) {
      if (input[field] !== undefined) updates[field] = cleanText(input[field]);
    }
    if (input.settings !== undefined) {
      updates.settings = input.settings ? JSON.stringify(input.settings) : null;
    }
    if (input.documentPhones !== undefined) {
      updates.documentPhones = normalizeDocumentPhones(input.documentPhones).join(',') || null;
    }
    if (input.managerUserId !== undefined) {
      await assertManager(input.managerUserId);
      updates.managerUserId = input.managerUserId ?? null;
    }

    if (Object.keys(updates).length > 0) {
      await db.update(stores).set(updates).where(eq(stores.id, id));
    }
    if (input.managerUserId) await ensureManagerAssignment(id, input.managerUserId);

    await writeAudit({
      user: actor ?? null,
      storeId: id,
      action: 'update',
      entity: 'store',
      entityId: id,
      details: { avant: { code: existing.code, name: existing.name, managerUserId: existing.managerUserId }, après: updates },
    });

    return (await getStore(id))!;
  });
}

export async function setStoreStatus(
  id: number,
  status: StoreStatus,
  actor?: { id: number; name: string } | null,
  reason?: string | null,
): Promise<StoreRow> {
  if (!['active', 'suspended', 'archived'].includes(status)) throw new StoreError('Statut invalide');

  return withTransaction(async () => {
    const existing = await getStore(id);
    if (!existing) throw new StoreError('Magasin introuvable', 404);

    if (status === 'archived') {
      const open = await rawGet<{ n: number }>(
        `SELECT COUNT(*) AS n FROM cash_sessions WHERE store_id = ? AND status = 'open'`,
        [id],
      );
      if (Number(open?.n ?? 0) > 0) {
        throw new StoreError('Clôturez la caisse du magasin avant de l’archiver.');
      }
      const transfers = await rawGet<{ n: number }>(
        `SELECT COUNT(*) AS n FROM stock_transfers
          WHERE (source_store_id = ? OR destination_store_id = ?)
            AND status IN ('pending', 'approved', 'preparing', 'in_transit', 'partially_received', 'disputed')`,
        [id, id],
      );
      if (Number(transfers?.n ?? 0) > 0) {
        throw new StoreError('Des transferts sont en cours avec ce magasin : clôturez-les avant de l’archiver.');
      }
    }

    await db.update(stores).set({ status }).where(eq(stores.id, id));
    await writeAudit({
      user: actor ?? null,
      storeId: id,
      action: 'update',
      entity: 'store',
      entityId: id,
      details: { statut: { avant: existing.status, après: status }, motif: reason ?? null },
    });
    return (await getStore(id))!;
  });
}

/* ------------------------------------------------------------------ *
 * Affectations
 * ------------------------------------------------------------------ */

export type UserStoreAssignment = {
  storeId: number;
  storeCode: string;
  storeName: string;
  isManager: boolean;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

export async function listUserAssignments(userId: number): Promise<UserStoreAssignment[]> {
  const rows = await rawAll<any>(
    `SELECT us.*, s.code, s.name FROM user_stores us
       JOIN stores s ON s.id = us.store_id
      WHERE us.user_id = ? AND us.deleted_at IS NULL
      ORDER BY s.name`,
    [userId],
  );
  return rows.map((r) => ({
    storeId: Number(r.store_id),
    storeCode: String(r.code),
    storeName: String(r.name),
    isManager: Boolean(r.is_manager),
    isActive: Boolean(r.is_active),
    startsAt: r.starts_at ?? null,
    endsAt: r.ends_at ?? null,
  }));
}

export async function listStoreUsers(storeId: number) {
  return rawAll<any>(
    `SELECT u.id, u.name, u.username, u.role, u.is_active, us.is_manager, us.is_active AS assignment_active,
            us.starts_at, us.ends_at
       FROM user_stores us JOIN users u ON u.id = us.user_id
      WHERE us.store_id = ? AND us.deleted_at IS NULL AND u.deleted_at IS NULL
      ORDER BY us.is_manager DESC, u.name`,
    [storeId],
  );
}

/**
 * Remplace les affectations d'un utilisateur (liste complète).
 * Une affectation retirée est désactivée, jamais supprimée (traçabilité).
 */
export async function setUserAssignments(
  userId: number,
  assignments: { storeId: number; isManager?: boolean; startsAt?: string | null; endsAt?: string | null }[],
  actor?: { id: number; name: string } | null,
): Promise<UserStoreAssignment[]> {
  return withTransaction(async () => {
    const wanted = new Map<number, (typeof assignments)[number]>();
    for (const a of assignments) {
      const storeId = Number(a.storeId);
      if (!Number.isInteger(storeId) || storeId <= 0) continue;
      const store = await rawGet(`SELECT id FROM stores WHERE id = ?`, [storeId]);
      if (!store) throw new StoreError(`Magasin introuvable (id ${storeId})`);
      wanted.set(storeId, a);
    }

    const existing = await rawAll<any>(`SELECT * FROM user_stores WHERE user_id = ?`, [userId]);
    const before = existing
      .filter((r) => r.is_active && !r.deleted_at)
      .map((r) => ({ storeId: Number(r.store_id), isManager: Boolean(r.is_manager) }));

    for (const row of existing) {
      const storeId = Number(row.store_id);
      const target = wanted.get(storeId);
      if (target) {
        await db
          .update(userStores)
          .set({
            isActive: true,
            deletedAt: null,
            isManager: Boolean(target.isManager),
            startsAt: target.startsAt ?? null,
            endsAt: target.endsAt ?? null,
          })
          .where(eq(userStores.id, Number(row.id)));
        wanted.delete(storeId);
      } else if (row.is_active) {
        await db.update(userStores).set({ isActive: false, isManager: false }).where(eq(userStores.id, Number(row.id)));
      }
    }

    for (const [storeId, target] of wanted) {
      await db.insert(userStores).values({
        syncId: await userStoreSyncId(userId, storeId),
        userId,
        storeId,
        isManager: Boolean(target.isManager),
        isActive: true,
        startsAt: target.startsAt ?? null,
        endsAt: target.endsAt ?? null,
      });
    }

    const after = await listUserAssignments(userId);
    await writeAudit({
      user: actor ?? null,
      action: 'update',
      entity: 'user_stores',
      entityId: userId,
      details: {
        avant: before,
        après: after.filter((a) => a.isActive).map((a) => ({ storeId: a.storeId, isManager: a.isManager })),
      },
    });
    return after;
  });
}

/* ------------------------------------------------------------------ *
 * Portée de lecture (§6 : vues locales et consolidées)
 * ------------------------------------------------------------------ */

/**
 * Liste de magasins à lire. Toujours une liste explicite d'identifiants
 * **déjà autorisés** — jamais « pas de filtre ».
 */
export type StoreScope = number[];

/** Fragment SQL `colonne IN (…)` pour une portée (identifiants entiers, donc sûrs). */
export function scopeSql(column: string, scope: StoreScope): string {
  const ids = scope.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return '0 = 1';
  if (ids.length === 1) return `${column} = ${ids[0]}`;
  return `${column} IN (${ids.join(',')})`;
}

/** Indicateurs rapides d'un magasin (fiche magasin, comparaison). */
export async function getStoreIndicators(storeId: number, from: string, to: string) {
  const row = await rawGet<any>(
    `SELECT
       (SELECT COALESCE(SUM(total), 0) FROM sales_invoices WHERE store_id = ? AND status = 'active' AND date BETWEEN ? AND ?) AS revenue,
       (SELECT COUNT(*) FROM sales_invoices WHERE store_id = ? AND status = 'active' AND date BETWEEN ? AND ?) AS sales_count,
       (SELECT COALESCE(SUM(total), 0) FROM purchase_invoices WHERE store_id = ? AND status = 'active' AND date BETWEEN ? AND ?) AS purchases,
       (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE store_id = ? AND deleted_at IS NULL AND approval_status = 'approved' AND date BETWEEN ? AND ?) AS expenses,
       (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE store_id = ? AND type IN ('sale', 'service_job') AND date BETWEEN ? AND ?) AS collected,
       (SELECT COALESCE(SUM(remaining_amount), 0) FROM sales_invoices WHERE store_id = ? AND status = 'active') AS receivables,
       (SELECT COALESCE(SUM(remaining_amount), 0) FROM purchase_invoices WHERE store_id = ? AND status = 'active') AS payables,
       (SELECT COALESCE(SUM(ps.quantity * p.purchase_price), 0) FROM product_stocks ps JOIN products p ON p.id = ps.product_id WHERE ps.store_id = ? AND p.is_active = 1) AS stock_value,
       (SELECT COUNT(*) FROM product_stocks ps JOIN products p ON p.id = ps.product_id
          WHERE ps.store_id = ? AND p.is_active = 1 AND ps.is_listed = 1 AND ps.quantity <= COALESCE(ps.stock_min, p.stock_min) AND COALESCE(ps.stock_min, p.stock_min) > 0) AS low_stock,
       (SELECT COUNT(*) FROM users u JOIN user_stores us ON us.user_id = u.id WHERE us.store_id = ? AND us.is_active = 1 AND u.is_active = 1) AS users`,
    [
      storeId, from, to,
      storeId, from, to,
      storeId, from, to,
      storeId, from, to,
      storeId, from, to,
      storeId,
      storeId,
      storeId,
      storeId,
      storeId,
    ],
  );
  const revenue = Number(row?.revenue ?? 0);
  const salesCount = Number(row?.sales_count ?? 0);
  return {
    revenue,
    salesCount,
    averageBasket: salesCount > 0 ? Math.round(revenue / salesCount) : 0,
    purchases: Number(row?.purchases ?? 0),
    expenses: Number(row?.expenses ?? 0),
    collected: Number(row?.collected ?? 0),
    receivables: Number(row?.receivables ?? 0),
    payables: Number(row?.payables ?? 0),
    stockValue: Number(row?.stock_value ?? 0),
    lowStock: Number(row?.low_stock ?? 0),
    users: Number(row?.users ?? 0),
  };
}

/**
 * En-tête de document d'un magasin (facture, reçu, bon d'achat, devis) :
 * coordonnées **publiques** du magasin émetteur (cahier des charges §9 : « les
 * modèles de facture doivent afficher les coordonnées de l'établissement
 * émetteur »). Renvoyé avec chaque document par les routes de détail, pour
 * qu'un vendeur n'ait pas besoin du droit de lire la fiche du magasin.
 */
export type StoreLetterhead = {
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  receiptFooter: string | null;
  documentPhones: string[];
};

export async function getStoreLetterhead(storeId: number | null | undefined): Promise<StoreLetterhead | null> {
  if (!storeId) return null;
  const store = await getStore(storeId);
  if (!store) return null;
  return {
    code: store.code,
    name: store.name,
    address: store.address,
    phone: store.phone,
    email: store.email,
    receiptFooter: store.receiptFooter,
    documentPhones: store.documentPhones,
  };
}
