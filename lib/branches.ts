/**
 * Filiales de production (README §31) — demande client du 9 octobre 2026.
 *
 * La briqueterie devient une filiale parmi d'autres : l'administrateur crée
 * « Briqueterie », « Vitrerie », « Meuble »… et chacune a son espace (tableau
 * de bord, modèles, productions, stock, commandes, ventes, rapports).
 *
 * Règles :
 * 1. Une filiale est une **donnée centrale** (créée au siège, `brick.branches`,
 *    réservé à l'administrateur) ; ses modèles, productions, commandes et
 *    ventes appartiennent toujours **à un magasin** et **à une filiale**.
 * 2. **Accès** = droits du domaine « Filiales de production » (`brick.*`),
 *    éventuellement **plafonnés** par filiale : une filiale `restricted`
 *    n'est ouverte qu'aux comptes listés, au niveau indiqué. L'administrateur
 *    et le gestionnaire des filiales voient tout.
 * 3. Une filiale **suspendue ou archivée** se consulte (historique) mais
 *    n'accepte plus aucune écriture et quitte le menu.
 * 4. Une filiale rattachée à un magasin n'est visible que des comptes de ce
 *    magasin, et n'écrit que depuis lui.
 * 5. **Clients partagés** : tous les clients du magasin (`customerMode = all`)
 *    ou seulement ceux partagés avec la filiale (`selected`). Le client reste
 *    celui de son magasin ; chaque document garde sa filiale.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { and, eq } from 'drizzle-orm';
import { productionBranchCustomers, productionBranchUsers, productionBranches } from '@/db/schema';
import {
  ConflictError,
  NotFoundError,
  requireAction,
  ValidationError,
  type SessionUser,
} from '@/lib/api';
import { ForbiddenError, type Action } from '@/lib/permissions';
import { writeAudit } from '@/lib/audit';
import {
  BRANCH_ACTIVITIES,
  BRANCH_COLORS,
  BRANCH_STATUSES,
  BRANCH_ICONS,
  DEFAULT_BRANCH_ICON,
  DEFAULT_LOSS_LABELS,
  branchIcon,
  DEFAULT_STAGES,
  STORED_STAGE,
  branchHref,
  type BranchAccessLevel,
  type BranchActivity,
  type BranchColor,
  type BranchNavLink,
  type BranchStage,
  type BranchStatus,
  type ProductionBranch,
} from '@/lib/branches-shared';

export * from '@/lib/branches-shared';

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function parseStages(raw: unknown): BranchStage[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [{ key: 'in_progress', label: 'En cours' }];
    const stages = parsed
      .filter((s) => s && typeof s.key === 'string' && typeof s.label === 'string' && s.key !== STORED_STAGE.key)
      .map((s) => ({ key: String(s.key), label: String(s.label) }));
    return stages.length > 0 ? stages : [{ key: 'in_progress', label: 'En cours' }];
  } catch {
    return [{ key: 'in_progress', label: 'En cours' }];
  }
}

const BRANCH_SELECT = `
  SELECT b.*, s.name AS store_name,
         (SELECT COUNT(*) FROM brick_types t WHERE t.branch_id = b.id AND t.is_active = 1) AS models_count,
         (SELECT COUNT(*) FROM brick_productions p WHERE p.branch_id = b.id AND p.status <> 'cancelled') AS productions_count,
         (SELECT COUNT(*) FROM brick_orders o WHERE o.branch_id = b.id AND o.status <> 'cancelled') AS orders_count,
         (SELECT COUNT(*) FROM production_branch_users bu WHERE bu.branch_id = b.id AND bu.deleted_at IS NULL) AS users_count,
         (SELECT COUNT(*) FROM production_branch_customers bc WHERE bc.branch_id = b.id AND bc.deleted_at IS NULL) AS customers_count
    FROM production_branches b
    LEFT JOIN stores s ON s.id = b.store_id`;

function mapBranch(row: any): ProductionBranch {
  const stages = parseStages(row.stages);
  return {
    id: num(row.id),
    name: row.name,
    activity: (BRANCH_ACTIVITIES as readonly string[]).includes(row.activity) ? row.activity : 'other',
    description: row.description ?? null,
    storeId: row.store_id == null ? null : num(row.store_id),
    storeName: row.store_name ?? null,
    status: (BRANCH_STATUSES as readonly string[]).includes(row.status) ? row.status : 'active',
    color: (BRANCH_COLORS as readonly string[]).includes(row.color) ? row.color : 'primary',
    icon: branchIcon(row.icon),
    sortOrder: num(row.sort_order),
    unit: row.unit || 'pièce',
    stages,
    flow: [...stages, STORED_STAGE],
    lossLabel: row.loss_label || 'Pertes',
    batchPrefix: row.batch_prefix || 'PRD',
    orderPrefix: row.order_prefix || 'CMD',
    accessMode: row.access_mode === 'restricted' ? 'restricted' : 'all',
    customerMode: row.customer_mode === 'selected' ? 'selected' : 'all',
    createdAt: row.created_at ? new Date(num(row.created_at) * 1000) : null,
    modelsCount: num(row.models_count),
    productionsCount: num(row.productions_count),
    ordersCount: num(row.orders_count),
    usersCount: num(row.users_count),
    customersCount: num(row.customers_count),
  };
}

export async function getBranch(id: number): Promise<ProductionBranch | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await rawGet<any>(`${BRANCH_SELECT} WHERE b.id = ? AND b.deleted_at IS NULL`, [id]);
  return row ? mapBranch(row) : null;
}

export async function listBranches(options: { includeArchived?: boolean } = {}): Promise<ProductionBranch[]> {
  const where = ['b.deleted_at IS NULL'];
  if (!options.includeArchived) where.push(`b.status <> 'archived'`);
  const rows = await rawAll<any>(
    `${BRANCH_SELECT} WHERE ${where.join(' AND ')} ORDER BY b.sort_order, b.name COLLATE NOCASE, b.id`,
  );
  return rows.map(mapBranch);
}

/** Filiale de démarrage de la briqueterie (reprise de la v2, migration 0015). */
export async function getDefaultBrickBranch(): Promise<ProductionBranch | null> {
  const row = await rawGet<{ id: number }>(
    `SELECT id FROM production_branches WHERE deleted_at IS NULL AND status = 'active'
      ORDER BY CASE WHEN activity = 'bricks' THEN 0 ELSE 1 END, sort_order, id LIMIT 1`,
  );
  return row ? getBranch(num(row.id)) : null;
}

/**
 * Filiale qui reprend l'ancien atelier de meubles (README §31.9, migration
 * 0016) : celle de ses commandes, sinon la première filiale « Meubles ».
 */
export async function getFurnitureBranch(): Promise<ProductionBranch | null> {
  const row = await rawGet<{ id: number }>(
    `SELECT COALESCE(
       (SELECT branch_id FROM furniture_orders WHERE branch_id IS NOT NULL LIMIT 1),
       (SELECT branch_id FROM furniture_models WHERE branch_id IS NOT NULL LIMIT 1),
       (SELECT id FROM production_branches WHERE activity = 'furniture' AND deleted_at IS NULL ORDER BY id LIMIT 1)) AS id`,
  );
  return row?.id ? getBranch(num(row.id)) : null;
}

/**
 * Garde des anciennes routes `/api/atelier/*` : l'historique de l'atelier
 * appartient à la filiale Meuble, il ne se lit qu'avec l'accès à cette filiale.
 */
export async function assertAtelierAccess(user: SessionUser, write = false): Promise<void> {
  const branch = await getFurnitureBranch();
  if (!branch) return;
  if ((await branchLevelFor(user, branch)) === 'none') throw new BranchAccessError();
  if (write && branch.status !== 'active') assertBranchWritable(branch, user);
}

/* ------------------------------------------------------------------ *
 * Accès
 * ------------------------------------------------------------------ */

const LEVEL_RANK: Record<BranchAccessLevel | 'none', number> = { none: 0, view: 1, edit: 2, manage: 3 };

/** Niveau requis par une action sur une filiale. */
export function levelForAction(action: Action): BranchAccessLevel {
  if (action === 'brick.types' || action === 'brick.delete') return 'manage';
  if (action === 'brick.view' || action.endsWith('.view')) return 'view';
  return 'edit';
}

/** Niveau que donnent les droits du compte sur le domaine « Filiales de production ». */
function roleLevel(user: SessionUser): BranchAccessLevel | 'none' {
  const has = (a: Action) => user.permissions.includes(a);
  if (!has('brick.view')) return 'none';
  if (has('brick.types') && has('brick.delete')) return 'manage';
  if (has('brick.create') || has('brick.update')) return 'edit';
  return 'view';
}

/** L'administrateur général et le gestionnaire des filiales ne sont jamais plafonnés. */
export function canManageBranches(user: SessionUser): boolean {
  return user.role === 'admin' || user.permissions.includes('brick.branches');
}

/**
 * Niveau effectif d'un compte sur une filiale : droits du domaine, plafonnés
 * par la liste des comptes autorisés si la filiale est `restricted`.
 */
export async function branchLevelFor(user: SessionUser, branch: ProductionBranch): Promise<BranchAccessLevel | 'none'> {
  const base = roleLevel(user);
  if (base === 'none') return 'none';
  if (canManageBranches(user)) return base;
  if (branch.storeId != null && !user.storeIds.includes(branch.storeId)) return 'none';
  if (branch.accessMode === 'all') return base;
  const row = await rawGet<{ level: string }>(
    `SELECT level FROM production_branch_users WHERE branch_id = ? AND user_id = ? AND deleted_at IS NULL`,
    [branch.id, user.id],
  );
  if (!row) return 'none';
  const cap = (['view', 'edit', 'manage'] as const).includes(row.level as BranchAccessLevel) ? (row.level as BranchAccessLevel) : 'view';
  return LEVEL_RANK[cap] < LEVEL_RANK[base] ? cap : base;
}

/** Filiales que le compte peut ouvrir, avec son niveau. */
export async function listAccessibleBranches(
  user: SessionUser,
  options: { includeInactive?: boolean } = {},
): Promise<ProductionBranch[]> {
  const all = await listBranches({ includeArchived: options.includeInactive });
  const result: ProductionBranch[] = [];
  for (const branch of all) {
    if (!options.includeInactive && branch.status !== 'active') continue;
    const level = await branchLevelFor(user, branch);
    if (level !== 'none') result.push({ ...branch, access: level });
  }
  return result;
}

/** Liens de la barre latérale : filiales **actives** et autorisées, dans l'ordre choisi. */
export async function listBranchNavLinks(user: SessionUser): Promise<BranchNavLink[]> {
  const branches = await listAccessibleBranches(user);
  return branches.map((b) => ({ id: b.id, name: b.name, color: b.color as BranchColor, icon: b.icon, href: branchHref(b.id) }));
}

export class BranchAccessError extends Error {
  readonly status = 403;
  constructor(message = 'Accès refusé : cette filiale ne fait pas partie de vos accès.') {
    super(message);
    this.name = 'BranchAccessError';
  }
}

/**
 * Garde des routes `/api/filiales/[branchId]/*` : session, permission du
 * domaine, **accès à cette filiale** au niveau requis. `write` refuse en plus
 * une filiale suspendue ou archivée, et une filiale rattachée à un autre
 * magasin que le magasin actif.
 */
export async function requireBranch(
  branchIdParam: string | number,
  action: Action,
  options: { write?: boolean } = {},
): Promise<{ user: SessionUser; branch: ProductionBranch }> {
  const user = await requireAction(action);
  const branchId = Number(branchIdParam);
  const branch = await getBranch(branchId);
  if (!branch) throw new NotFoundError('Filiale introuvable');
  const level = await branchLevelFor(user, branch);
  if (level === 'none') throw new BranchAccessError();
  const needed = levelForAction(action);
  if (LEVEL_RANK[level] < LEVEL_RANK[needed]) {
    throw new ForbiddenError(action);
  }
  if (options.write) assertBranchWritable(branch, user);
  return { user, branch: { ...branch, access: level } };
}

export function assertBranchWritable(branch: ProductionBranch, user: { storeId: number | null }): void {
  if (branch.status !== 'active') {
    throw new ConflictError(
      `La filiale « ${branch.name} » est ${branch.status === 'archived' ? 'archivée' : 'suspendue'} : elle se consulte mais n’accepte plus de nouvelle opération.`,
    );
  }
  if (branch.storeId != null && user.storeId !== branch.storeId) {
    throw new ValidationError(
      `La filiale « ${branch.name} » travaille dans le magasin ${branch.storeName ?? 'qui lui est rattaché'} : changez de magasin actif pour y saisir.`,
    );
  }
}

/**
 * Filiales que le compte **ne peut pas** ouvrir : leurs dépenses restent hors
 * des écrans généraux (`/depenses`), sans quoi le cloisonnement des filiales
 * s'arrêterait à leur propre espace (README §31.10).
 */
export async function hiddenBranchIds(user: SessionUser): Promise<number[]> {
  const all = await listBranches({ includeArchived: true });
  const hidden: number[] = [];
  for (const branch of all) {
    if ((await branchLevelFor(user, branch)) === 'none') hidden.push(branch.id);
  }
  return hidden;
}

/** Filtre SQL « appartient à ces filiales ». Liste vide = aucune ligne. */
export function branchSql(column: string, branchIds: number[]): string {
  const ids = branchIds.filter((id) => Number.isInteger(id) && id > 0);
  return ids.length === 0 ? '1 = 0' : `${column} IN (${ids.join(',')})`;
}

/* ------------------------------------------------------------------ *
 * Écriture (siège, `brick.branches`)
 * ------------------------------------------------------------------ */

export type BranchInput = {
  name?: string;
  activity?: string;
  description?: string | null;
  storeId?: number | null;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
  unit?: string;
  /** Libellés des étapes, dans l'ordre ; la mise en stock s'ajoute toujours. */
  stages?: string[];
  lossLabel?: string;
  batchPrefix?: string;
  orderPrefix?: string;
  accessMode?: string;
  customerMode?: string;
};

function cleanText(value: unknown, max = 200): string | null {
  const text = String(value ?? '').trim().slice(0, max);
  return text || null;
}

function cleanPrefix(value: unknown, label: string): string {
  const prefix = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,5}$/.test(prefix)) {
    throw new ValidationError(`${label} : 2 à 6 lettres ou chiffres, commençant par une lettre (ex. BRI, VIT).`);
  }
  return prefix;
}

function slug(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'etape';
}

/**
 * Libellés → étapes. Une étape déjà connue **garde sa clé** (les productions
 * en cours y sont rattachées) ; une nouvelle reçoit une clé lisible et unique.
 */
export function buildStages(labels: unknown, previous: BranchStage[] = []): BranchStage[] {
  if (!Array.isArray(labels)) throw new ValidationError('Les étapes doivent être une liste.');
  const clean = labels.map((l) => String(l ?? '').trim()).filter(Boolean);
  if (clean.length === 0) throw new ValidationError('Indiquez au moins une étape de fabrication avant la mise en stock.');
  if (clean.length > 8) throw new ValidationError('Huit étapes au plus avant la mise en stock.');
  const lower = clean.map((l) => l.toLocaleLowerCase('fr'));
  if (new Set(lower).size !== lower.length) throw new ValidationError('Deux étapes portent le même nom.');
  if (lower.includes('en stock')) throw new ValidationError('« En stock » est toujours la dernière étape : ne la saisissez pas.');
  const used = new Set<string>([STORED_STAGE.key]);
  return clean.map((label) => {
    const known = previous.find((s) => s.label.toLocaleLowerCase('fr') === label.toLocaleLowerCase('fr'));
    let key = known?.key ?? slug(label);
    let n = 2;
    while (used.has(key)) key = `${known?.key ?? slug(label)}_${n++}`;
    used.add(key);
    return { key, label: label.slice(0, 40) };
  });
}

async function assertNameAvailable(name: string, exceptId = 0) {
  const other = await rawGet<{ id: number }>(
    `SELECT id FROM production_branches WHERE name = ? COLLATE NOCASE AND id <> ? AND deleted_at IS NULL`,
    [name, exceptId],
  );
  if (other) throw new ConflictError(`Une filiale s’appelle déjà « ${name} ».`);
}

async function assertStoreExists(storeId: number | null) {
  if (storeId == null) return;
  const store = await rawGet<{ id: number }>(`SELECT id FROM stores WHERE id = ?`, [storeId]);
  if (!store) throw new NotFoundError('Magasin introuvable');
}

function normalizeInput(input: BranchInput, current?: ProductionBranch) {
  const activity = (BRANCH_ACTIVITIES as readonly string[]).includes(String(input.activity))
    ? (input.activity as BranchActivity)
    : current?.activity ?? 'other';
  const values: Record<string, unknown> = {};
  if (input.name !== undefined || !current) {
    const name = cleanText(input.name, 60);
    if (!name) throw new ValidationError('Le nom de la filiale est obligatoire (ex. Briqueterie, Vitrerie, Meuble).');
    values.name = name;
  }
  if (input.activity !== undefined || !current) values.activity = activity;
  if (input.description !== undefined) values.description = cleanText(input.description, 500);
  if (input.storeId !== undefined) values.storeId = input.storeId ? Number(input.storeId) : null;
  if (input.color !== undefined || !current) {
    values.color = (BRANCH_COLORS as readonly string[]).includes(String(input.color)) ? input.color : current?.color ?? 'primary';
  }
  if (input.icon !== undefined || !current) {
    values.icon = (BRANCH_ICONS as readonly string[]).includes(String(input.icon)) ? input.icon : current?.icon ?? DEFAULT_BRANCH_ICON[activity];
  }
  if (input.sortOrder !== undefined) values.sortOrder = Math.max(0, Math.min(999, Math.round(num(input.sortOrder))));
  if (input.unit !== undefined || !current) values.unit = cleanText(input.unit, 20) ?? 'pièce';
  if (input.stages !== undefined || !current) {
    const labels = input.stages ?? DEFAULT_STAGES[activity];
    values.stages = JSON.stringify(buildStages(labels, current?.stages ?? []));
  }
  if (input.lossLabel !== undefined || !current) values.lossLabel = cleanText(input.lossLabel, 30) ?? DEFAULT_LOSS_LABELS[activity];
  if (input.batchPrefix !== undefined || !current) values.batchPrefix = cleanPrefix(input.batchPrefix ?? 'PRD', 'Préfixe des productions');
  if (input.orderPrefix !== undefined || !current) values.orderPrefix = cleanPrefix(input.orderPrefix ?? 'CMD', 'Préfixe des commandes');
  if (values.batchPrefix && values.orderPrefix && values.batchPrefix === values.orderPrefix) {
    throw new ValidationError('Productions et commandes doivent avoir deux préfixes différents.');
  }
  if (input.accessMode !== undefined) values.accessMode = input.accessMode === 'restricted' ? 'restricted' : 'all';
  if (input.customerMode !== undefined) values.customerMode = input.customerMode === 'selected' ? 'selected' : 'all';
  return values;
}

export async function createBranch(input: BranchInput, actor: SessionUser): Promise<ProductionBranch> {
  return withTransaction(async () => {
    const values = normalizeInput(input);
    await assertNameAvailable(String(values.name));
    await assertStoreExists((values.storeId as number | null | undefined) ?? null);
    if (values.sortOrder === undefined) {
      const last = await rawGet<{ m: number | null }>(`SELECT MAX(sort_order) AS m FROM production_branches`);
      values.sortOrder = num(last?.m) + 1;
    }
    const [created] = await db
      .insert(productionBranches)
      .values({ ...(values as any), status: 'active', userId: actor.id })
      .returning({ id: productionBranches.id });
    const branch = (await getBranch(created.id))!;
    await writeAudit({
      user: actor,
      action: 'create',
      entity: 'production_branch',
      entityId: branch.id,
      details: { name: branch.name, activity: branch.activity, stages: branch.stages.map((s) => s.label) },
    });
    return branch;
  });
}

export async function updateBranch(id: number, input: BranchInput, actor: SessionUser): Promise<ProductionBranch> {
  return withTransaction(async () => {
    const current = await getBranch(id);
    if (!current) throw new NotFoundError('Filiale introuvable');
    const values = normalizeInput(input, current);
    if (values.name !== undefined) await assertNameAvailable(String(values.name), id);
    if (values.storeId !== undefined) await assertStoreExists(values.storeId as number | null);

    if (values.stages !== undefined) {
      // Une étape retirée ne doit pas laisser de production en cours « nulle part ».
      const keys = new Set(parseStages(values.stages).map((s) => s.key));
      const inProgress = await rawAll<{ stage: string; c: number }>(
        `SELECT stage, COUNT(*) AS c FROM brick_productions
          WHERE branch_id = ? AND status = 'registered' AND stage <> 'stored' GROUP BY stage`,
        [id],
      );
      const orphan = inProgress.find((row) => !keys.has(row.stage));
      if (orphan) {
        const label = current.stages.find((s) => s.key === orphan.stage)?.label ?? orphan.stage;
        throw new ConflictError(
          `${num(orphan.c)} production(s) en cours sont à l’étape « ${label} » : terminez-les avant de retirer cette étape (vous pouvez la renommer).`,
        );
      }
    }

    if (values.storeId !== undefined && values.storeId !== current.storeId && values.storeId != null) {
      const elsewhere = await rawGet<{ c: number }>(
        `SELECT (SELECT COUNT(*) FROM brick_types WHERE branch_id = ? AND store_id <> ?)
              + (SELECT COUNT(*) FROM brick_productions WHERE branch_id = ? AND store_id <> ?) AS c`,
        [id, values.storeId as number, id, values.storeId as number],
      );
      if (num(elsewhere?.c) > 0) {
        throw new ConflictError('Cette filiale a déjà travaillé dans d’autres magasins : elle ne peut plus être réservée à un seul.');
      }
    }

    await db.update(productionBranches).set({ ...(values as any), updatedAt: new Date() }).where(eq(productionBranches.id, id));
    const branch = (await getBranch(id))!;
    await writeAudit({ user: actor, action: 'update', entity: 'production_branch', entityId: id, details: { name: branch.name, changes: Object.keys(values) } });
    return branch;
  });
}

/** Activer, suspendre, archiver — jamais de suppression (invariant 1). */
export async function setBranchStatus(id: number, status: BranchStatus, reason: string | null, actor: SessionUser): Promise<ProductionBranch> {
  if (!(BRANCH_STATUSES as readonly string[]).includes(status)) throw new ValidationError('Statut de filiale invalide');
  const current = await getBranch(id);
  if (!current) throw new NotFoundError('Filiale introuvable');
  if (status !== 'active' && !(reason ?? '').trim()) {
    throw new ValidationError('Indiquez le motif de la suspension ou de l’archivage.');
  }
  if (status === 'archived') {
    const open = await rawGet<{ c: number }>(
      `SELECT (SELECT COUNT(*) FROM brick_productions WHERE branch_id = ? AND status = 'registered')
            + (SELECT COUNT(*) FROM brick_orders WHERE branch_id = ? AND status NOT IN ('delivered', 'cancelled')) AS c`,
      [id, id],
    );
    if (num(open?.c) > 0) {
      throw new ConflictError(
        `${num(open?.c)} production(s) ou commande(s) sont encore en cours : terminez-les ou annulez-les, ou suspendez la filiale en attendant.`,
      );
    }
  }
  await db.update(productionBranches).set({ status, updatedAt: new Date() }).where(eq(productionBranches.id, id));
  await writeAudit({
    user: actor,
    action: status === 'active' ? 'update' : 'cancel',
    entity: 'production_branch',
    entityId: id,
    details: { name: current.name, from: current.status, to: status, reason: reason?.trim() || null },
  });
  return (await getBranch(id))!;
}

/* ------------------------------------------------------------------ *
 * Comptes autorisés
 * ------------------------------------------------------------------ */

export type BranchUserRow = { userId: number; name: string; username: string; role: string; level: BranchAccessLevel };

export async function listBranchUsers(branchId: number): Promise<BranchUserRow[]> {
  const rows = await rawAll<any>(
    `SELECT bu.user_id, bu.level, u.name, u.username, u.role
       FROM production_branch_users bu INNER JOIN users u ON u.id = bu.user_id
      WHERE bu.branch_id = ? AND bu.deleted_at IS NULL
      ORDER BY u.name COLLATE NOCASE`,
    [branchId],
  );
  return rows.map((r) => ({ userId: num(r.user_id), name: r.name, username: r.username, role: r.role, level: r.level }));
}

/**
 * Remplace la liste des comptes autorisés. Une ligne retirée est **marquée**
 * supprimée (`deleted_at`, propagée par la synchronisation), puis réactivée si
 * le compte revient : l'index unique (filiale, compte) l'exige.
 */
export async function setBranchUsers(
  branchId: number,
  entries: { userId: number; level: string }[],
  actor: SessionUser,
): Promise<BranchUserRow[]> {
  const branch = await getBranch(branchId);
  if (!branch) throw new NotFoundError('Filiale introuvable');
  const wanted = new Map<number, BranchAccessLevel>();
  for (const entry of entries ?? []) {
    const userId = Number(entry.userId);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    const level = (['view', 'edit', 'manage'] as const).includes(entry.level as BranchAccessLevel) ? (entry.level as BranchAccessLevel) : 'edit';
    wanted.set(userId, level);
  }
  return withTransaction(async () => {
    if (wanted.size > 0) {
      const found = await rawAll<{ id: number }>(`SELECT id FROM users WHERE id IN (${[...wanted.keys()].join(',')})`);
      if (found.length !== wanted.size) throw new NotFoundError('Un des comptes choisis est introuvable');
    }
    const existing = await rawAll<{ id: number; user_id: number; level: string; deleted_at: number | null }>(
      `SELECT id, user_id, level, deleted_at FROM production_branch_users WHERE branch_id = ?`,
      [branchId],
    );
    const now = new Date();
    for (const row of existing) {
      const level = wanted.get(num(row.user_id));
      if (level === undefined) {
        if (row.deleted_at == null) {
          await db.update(productionBranchUsers).set({ deletedAt: now, updatedAt: now }).where(eq(productionBranchUsers.id, row.id));
        }
      } else if (row.deleted_at != null || row.level !== level) {
        await db.update(productionBranchUsers).set({ level, deletedAt: null, updatedAt: now }).where(eq(productionBranchUsers.id, row.id));
      }
    }
    const known = new Set(existing.map((r) => num(r.user_id)));
    for (const [userId, level] of wanted) {
      if (!known.has(userId)) await db.insert(productionBranchUsers).values({ branchId, userId, level });
    }
    await writeAudit({
      user: actor,
      action: 'update',
      entity: 'production_branch',
      entityId: branchId,
      details: { name: branch.name, users: [...wanted.entries()].map(([userId, level]) => ({ userId, level })) },
    });
    return listBranchUsers(branchId);
  });
}

/* ------------------------------------------------------------------ *
 * Clients partagés
 * ------------------------------------------------------------------ */

/**
 * Filtre SQL des clients utilisables par la filiale (`column` = colonne
 * d'identifiant client). Mode `all` : aucun filtre (les clients du magasin).
 */
export function branchCustomerSql(branch: Pick<ProductionBranch, 'id' | 'customerMode'>, column: string): string {
  if (branch.customerMode !== 'selected') return '1 = 1';
  return `${column} IN (SELECT bc.customer_id FROM production_branch_customers bc WHERE bc.branch_id = ${Number(branch.id)} AND bc.deleted_at IS NULL)`;
}

/** Un document de la filiale ne vise qu'un client partagé avec elle (mode `selected`). */
export async function assertCustomerInBranch(branch: ProductionBranch, customerId: number | null | undefined): Promise<void> {
  if (!customerId || branch.customerMode !== 'selected') return;
  const row = await rawGet<{ id: number }>(
    `SELECT id FROM production_branch_customers WHERE branch_id = ? AND customer_id = ? AND deleted_at IS NULL`,
    [branch.id, customerId],
  );
  if (!row) {
    throw new ValidationError(
      `Ce client n’est pas partagé avec la filiale « ${branch.name} » : partagez-le d’abord (onglet Clients de la filiale).`,
    );
  }
}

export type BranchCustomerRow = {
  customerId: number;
  name: string;
  phone: string | null;
  storeId: number | null;
  storeName: string | null;
  shared: boolean;
  ordersCount: number;
  salesCount: number;
};

/** Clients du périmètre avec leur état de partage et leur activité dans la filiale. */
export async function listBranchCustomers(
  branch: ProductionBranch,
  options: { scope: number[]; search?: string; onlyShared?: boolean },
): Promise<BranchCustomerRow[]> {
  const where = [`c.store_id IN (${options.scope.length ? options.scope.join(',') : '0'})`, 'c.is_active = 1'];
  const args: (string | number)[] = [branch.id, branch.id, branch.id];
  if (options.search) {
    where.push('(c.name LIKE ? OR c.phone LIKE ?)');
    args.push(`%${options.search}%`, `%${options.search}%`);
  }
  if (options.onlyShared) where.push('shared = 1');
  const rows = await rawAll<any>(
    `SELECT c.id, c.name, c.phone, c.store_id, s.name AS store_name,
            EXISTS (SELECT 1 FROM production_branch_customers bc WHERE bc.branch_id = ? AND bc.customer_id = c.id AND bc.deleted_at IS NULL) AS shared,
            (SELECT COUNT(*) FROM brick_orders o WHERE o.branch_id = ? AND o.customer_id = c.id AND o.status <> 'cancelled') AS orders_count,
            (SELECT COUNT(*) FROM sales_invoices v WHERE v.production_branch_id = ? AND v.customer_id = c.id AND v.status = 'active') AS sales_count
       FROM customers c LEFT JOIN stores s ON s.id = c.store_id
      WHERE ${where.join(' AND ')}
      ORDER BY shared DESC, c.name COLLATE NOCASE
      LIMIT 500`,
    args,
  );
  return rows.map((r) => ({
    customerId: num(r.id),
    name: r.name,
    phone: r.phone ?? null,
    storeId: r.store_id == null ? null : num(r.store_id),
    storeName: r.store_name ?? null,
    shared: Boolean(num(r.shared)),
    ordersCount: num(r.orders_count),
    salesCount: num(r.sales_count),
  }));
}

/** Partage (ou retire) un client du magasin actif avec la filiale. */
export async function setCustomerShared(
  branch: ProductionBranch,
  customerId: number,
  shared: boolean,
  actor: SessionUser,
): Promise<void> {
  const customer = await rawGet<{ id: number; name: string; store_id: number | null }>(
    `SELECT id, name, store_id FROM customers WHERE id = ?`,
    [customerId],
  );
  if (!customer) throw new NotFoundError('Client introuvable');
  if (customer.store_id != null && num(customer.store_id) !== actor.storeId) {
    throw new ValidationError('Ce client appartient à un autre magasin : on ne le partage que depuis son magasin.');
  }
  const existing = await db
    .select()
    .from(productionBranchCustomers)
    .where(and(eq(productionBranchCustomers.branchId, branch.id), eq(productionBranchCustomers.customerId, customerId)));
  const now = new Date();
  if (shared) {
    if (existing[0]) {
      if (existing[0].deletedAt) {
        await db.update(productionBranchCustomers).set({ deletedAt: null, updatedAt: now, userId: actor.id }).where(eq(productionBranchCustomers.id, existing[0].id));
      }
    } else {
      await db.insert(productionBranchCustomers).values({ branchId: branch.id, customerId, userId: actor.id });
    }
  } else if (existing[0] && !existing[0].deletedAt) {
    await db.update(productionBranchCustomers).set({ deletedAt: now, updatedAt: now }).where(eq(productionBranchCustomers.id, existing[0].id));
  }
  await writeAudit({
    user: actor,
    action: 'update',
    entity: 'production_branch',
    entityId: branch.id,
    details: { name: branch.name, customer: customer.name, shared },
  });
}

/* ------------------------------------------------------------------ *
 * Historique d'un client, filiale par filiale (fiche client)
 * ------------------------------------------------------------------ */

export type CustomerBranchActivity = {
  branchId: number;
  branchName: string;
  color: BranchColor;
  ordersCount: number;
  ordersTotal: number;
  salesCount: number;
  salesTotal: number;
  paid: number;
  remaining: number;
};

/**
 * Activité d'un client dans chaque filiale **accessible** : commandes, ventes,
 * encaissé et reste dû (recalculés depuis `payments`, invariant 2).
 */
export async function customerBranchActivity(user: SessionUser, customerId: number): Promise<CustomerBranchActivity[]> {
  const branches = await listAccessibleBranches(user, { includeInactive: true });
  if (branches.length === 0) return [];
  const ids = branches.map((b) => b.id);
  const orders = await rawAll<any>(
    `SELECT branch_id, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total
       FROM brick_orders WHERE customer_id = ? AND status <> 'cancelled' AND ${branchSql('branch_id', ids)}
      GROUP BY branch_id`,
    [customerId],
  );
  const sales = await rawAll<any>(
    `SELECT v.production_branch_id AS branch_id, COUNT(*) AS n, COALESCE(SUM(v.total), 0) AS total,
            COALESCE(SUM((SELECT COALESCE(SUM(p.amount), 0) FROM payments p
                            WHERE p.type = 'sale' AND p.reference_id = v.id)), 0) AS paid
       FROM sales_invoices v
      WHERE v.customer_id = ? AND v.channel = 'brick' AND v.status = 'active' AND ${branchSql('v.production_branch_id', ids)}
      GROUP BY v.production_branch_id`,
    [customerId],
  );
  return branches
    .map((branch) => {
      const o = orders.find((r) => num(r.branch_id) === branch.id);
      const s = sales.find((r) => num(r.branch_id) === branch.id);
      const salesTotal = num(s?.total);
      const paid = num(s?.paid);
      return {
        branchId: branch.id,
        branchName: branch.name,
        color: branch.color,
        ordersCount: num(o?.n),
        ordersTotal: num(o?.total),
        salesCount: num(s?.n),
        salesTotal,
        paid,
        remaining: Math.max(0, Math.round((salesTotal - paid) * 100) / 100),
      };
    })
    .filter((row) => row.ordersCount > 0 || row.salesCount > 0);
}

/**
 * Une vente du canal `brick` ne se lit que si sa filiale est accessible : la
 * liste est déjà bornée, mais une fiche s'ouvre aussi par son identifiant.
 */
export async function assertSaleBranchVisible(
  user: SessionUser,
  invoice: { channel?: string | null; productionBranchId?: number | null },
): Promise<void> {
  if (invoice.channel !== 'brick' || !invoice.productionBranchId) return;
  const branch = await getBranch(invoice.productionBranchId);
  if (!branch || (await branchLevelFor(user, branch)) === 'none') throw new BranchAccessError();
}
