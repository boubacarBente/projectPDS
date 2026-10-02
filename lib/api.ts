import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ForbiddenError, requirePermission, type Action, type Role } from '@/lib/permissions';
import { getEffectivePermissions } from '@/lib/user-permissions';
import { loadSession, setSessionStore, SESSION_COOKIE } from '@/lib/session';
import { assertStoreWritable, resolveStoreContext, type StoreScope } from '@/lib/stores';
import { InsufficientStockError } from '@/lib/stock';
import { canEditCentralData } from '@/lib/device';

/**
 * Aides communes à tous les Route Handlers.
 *
 * Convention (README §26.5) : un Route Handler reste **mince** — parsing,
 * contrôle de permission, appel d'une fonction de `lib/`, réponse HTTP. Toute
 * logique métier vit dans `lib/`.
 */


export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super('Non authentifié');
    this.name = 'UnauthorizedError';
  }
}

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message = 'Ressource introuvable') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Utilisateur de session **avec son contexte de magasin** (§5).
 *
 * - `storeId` : magasin actif (opérations). `null` seulement si aucun magasin
 *   n'est accessible (première installation, compte sans affectation).
 * - `storeIds` : magasins consultables sur ce poste (déjà filtrés par les
 *   affectations, le statut et le périmètre du poste).
 * - `allStores` : administrateur général ou permission `stores.viewAll`.
 */
export type SessionUser = {
  id: number;
  name: string;
  username: string;
  role: Role;
  sessionId: string;
  storeId: number | null;
  storeIds: number[];
  allStores: boolean;
  permissions: Action[];
};

/** Lit la session (jeton du cookie → table `sessions` → utilisateur relu en base). */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    const session = await loadSession(token);
    if (!session) return null;

    const permissions = await getEffectivePermissions({ id: session.id, role: session.role });
    const viewAll = session.role === 'admin' || permissions.includes('stores.viewAll');
    const context = await resolveStoreContext({ id: session.id, role: session.role }, session.storeId, viewAll);

    if (context.activeStoreId !== session.storeId) {
      // Le magasin enregistré n'est plus accessible (affectation retirée,
      // magasin archivé…) : on bascule sur le premier magasin autorisé.
      await setSessionStore(session.sessionId, context.activeStoreId).catch(() => {});
    }

    return {
      id: session.id,
      name: session.name,
      username: session.username,
      role: session.role,
      sessionId: session.sessionId,
      storeId: context.activeStoreId,
      storeIds: context.storeIds,
      allStores: context.allStores,
      permissions,
    };
  } catch (error) {
    console.error('[auth] Lecture de session impossible :', error);
    return null;
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/**
 * Session **et** permission : la garde serveur de référence.
 *
 * La décision passe par les permissions effectives (matrice du rôle, puis
 * surcharges par utilisateur). Le rôle est relu en base à chaque requête :
 * modifier un cookie ne donne plus aucun droit.
 */
export async function requireAction(action: Action): Promise<SessionUser> {
  const user = await requireUser();
  requirePermission(user, action, user.permissions);
  return user;
}

/** Permissions effectives de la session courante (pour les écrans qui en ont besoin). */
export async function getSessionPermissions(): Promise<Action[]> {
  const user = await getSessionUser();
  return user?.permissions ?? [];
}

/**
 * Magasin actif, obligatoire pour toute écriture.
 * Vérifie aussi que le magasin accepte de nouvelles opérations (non suspendu).
 */
export async function requireActiveStore(user: SessionUser): Promise<number> {
  if (!user.storeId) {
    throw new ValidationError(
      'Aucun magasin actif : créez un magasin ou demandez à l’administrateur de vous affecter à un magasin.',
    );
  }
  await assertStoreWritable(user.storeId);
  return user.storeId;
}

/**
 * Portée de **lecture** demandée par l'écran (`?store=…`), toujours bornée aux
 * magasins autorisés :
 *  - absent       → magasin actif ;
 *  - `all`        → tous les magasins accessibles (vue consolidée) ;
 *  - un identifiant → ce magasin, s'il est autorisé (sinon 403).
 *
 * Le paramètre venant du navigateur n'est **jamais** cru tel quel (§5).
 */
export function resolveScope(user: SessionUser, requested?: string | null): StoreScope {
  const value = (requested ?? '').trim();
  if (value === 'all') return [...user.storeIds];
  if (value) {
    const id = Number(value);
    if (!Number.isInteger(id) || !user.storeIds.includes(id)) {
      throw new ForbiddenStoreError();
    }
    return [id];
  }
  return user.storeId ? [user.storeId] : [];
}

/** Portée lue depuis l'URL de la requête. */
export function scopeFromRequest(user: SessionUser, request: Request): StoreScope {
  const url = new URL(request.url);
  return resolveScope(user, url.searchParams.get('store'));
}

/** Vérifie qu'un document appartient à un magasin visible par l'utilisateur. */
export function assertStoreVisible(user: SessionUser, storeId: number | null | undefined): void {
  if (storeId === null || storeId === undefined) {
    if (!user.allStores) throw new ForbiddenStoreError();
    return;
  }
  if (!user.storeIds.includes(Number(storeId))) throw new ForbiddenStoreError();
}

/**
 * Données centrales (catalogue, catégories, comptes, magasins, paramètres) :
 * modifiables uniquement depuis le siège ou une installation autonome. Sur un
 * poste de magasin relié au serveur, ces tables ne sont jamais envoyées
 * (`hqOnly`) : une modification locale serait écrasée — on la refuse.
 */
export async function requireCentralEdit(): Promise<void> {
  if (!(await canEditCentralData())) {
    throw new CentralDataError();
  }
}

export class CentralDataError extends Error {
  readonly status = 403;
  constructor() {
    super(
      'Ces données sont gérées au siège : connectez-vous sur le poste du siège pour les modifier.',
    );
    this.name = 'CentralDataError';
  }
}

export class ForbiddenStoreError extends Error {
  readonly status = 403;
  constructor() {
    super('Accès refusé : ce magasin ne fait pas partie de votre périmètre.');
    this.name = 'ForbiddenStoreError';
  }
}

/** Enveloppe une réponse JSON de succès. */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data as any, { status });
}

/**
 * Traduit une erreur en réponse HTTP lisible.
 * Aucune erreur ne doit produire un écran blanc (§5.3) : le message remonte.
 *
 * ⚠️ Drizzle enveloppe les erreurs du pilote : `error.message` vaut alors
 * « Failed query: insert into "sales_invoices" (…) values (…) », ce qui
 * n'apprend **rien** à l'utilisateur, tandis que la vraie cause (« UNIQUE
 * constraint failed: sales_invoices.invoice_number ») se trouve dans
 * `error.cause`. On inspecte donc toute la chaîne des causes avant de traduire.
 * Constaté en vérification sur une collision de numéro de facture.
 */
export function fail(error: unknown): NextResponse {
  if (
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError ||
    error instanceof ValidationError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof InsufficientStockError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  /**
   * Erreurs métier portant déjà leur statut HTTP.
   *
   * Les modules de `lib/` définissent leurs propres erreurs avec un champ
   * `status` (`PaymentError` → 400, `CashSessionError` → 400, `BackupError` →
   * 400…). Les énumérer une à une est fragile : un module ajouté plus tard
   * verrait ses refus métier transformés en **500**, ce qui laisse croire à une
   * panne serveur alors que la demande était simplement invalide. On lit donc
   * le statut porté par l'erreur, quel que soit le module qui l'a levée.
   */
  const carriedStatus = (error as { status?: unknown })?.status;
  if (
    typeof carriedStatus === 'number' &&
    Number.isInteger(carriedStatus) &&
    carriedStatus >= 400 &&
    carriedStatus <= 599
  ) {
    const message = error instanceof Error ? error.message : String(error);
    // Un `code` métier (ex. `stock_already_sold`) permet à l'écran de proposer
    // la bonne suite (dérogation, inventaire…) sans analyser le texte.
    const code = (error as { code?: unknown })?.code;
    return NextResponse.json(
      typeof code === 'string' ? { error: message, code } : { error: message },
      { status: carriedStatus },
    );
  }

  const message = error instanceof Error ? error.message : String(error);

  // Chaîne complète des causes, pour retrouver le message du pilote SQLite.
  const causeChain: string[] = [];
  let current: unknown = (error as any)?.cause;
  let depth = 0;
  while (current && depth < 5) {
    causeChain.push(current instanceof Error ? current.message : String(current));
    current = (current as any)?.cause;
    depth += 1;
  }

  const haystack = [message, ...causeChain].join(' | ');
  console.error('[api] Erreur non gérée :', haystack);

  // Contraintes SQLite : on les traduit en message métier exploitable.
  const unique = haystack.match(/UNIQUE constraint failed:\s*([A-Za-z0-9_.]+)/i);
  if (unique) {
    const [, column] = unique;
    const labels: Record<string, string> = {
      'sales_invoices.invoice_number': 'Ce numéro de facture est déjà utilisé.',
      'purchase_invoices.reference': "Ce numéro d'achat est déjà utilisé.",
      'payments.receipt_number': 'Ce numéro de reçu est déjà utilisé.',
      // Le nom est l'identifiant du produit : l'index unique porte sur
      // `lower(trim(name))`, SQLite nomme donc l'index et non une colonne.
      'products_name_unique': 'Un produit porte déjà ce nom.',
      'users.username': 'Cet identifiant est déjà pris.',
      'categories.name': 'Cette catégorie existe déjà.',
      'stores.code': 'Ce code de magasin est déjà utilisé.',
      'stock_transfers.reference': 'Cette référence de transfert existe déjà.',
      'inventories.reference': 'Cette référence d’inventaire existe déjà.',
      'service_jobs.reference': 'Cette référence de chantier existe déjà.',
    };

    return NextResponse.json(
      {
        error:
          labels[column] ??
          'Cet enregistrement existe déjà : une valeur qui doit être unique est en doublon.',
      },
      { status: 409 },
    );
  }

  if (/FOREIGN KEY constraint failed/i.test(haystack)) {
    return NextResponse.json(
      { error: 'Impossible : cet enregistrement est référencé ailleurs.' },
      { status: 409 },
    );
  }

  if (/NOT NULL constraint failed:\s*([A-Za-z0-9_.]+)/i.test(haystack)) {
    return NextResponse.json(
      { error: 'Un champ obligatoire est manquant dans la demande.' },
      { status: 400 },
    );
  }

  // Message de premier niveau s'il est déjà lisible, sinon la cause la plus
  // profonde : « Failed query: insert into … » n'aide personne.
  const readable =
    message && !/^Failed query:/i.test(message) ? message : (causeChain[0] ?? message);

  return NextResponse.json({ error: readable || 'Erreur serveur' }, { status: 500 });
}

/** Pagination uniforme : `?page=1&limit=10&search=…` (README §27.2). */
export function parsePagination(searchParams: URLSearchParams): { page: number; limit: number } {
  const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1);
  const rawLimit = Number(searchParams.get('limit') ?? 20) || 20;
  const limit = Math.max(1, Math.min(500, rawLimit));
  return { page, limit };
}

/** Enveloppe paginée normalisée, reprise du projet Gaz. */
export function paginated<T>(data: T[], total: number, page: number, limit: number) {
  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/** Corps JSON validé minimalement — évite un crash sur un corps vide. */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const body = await request.json();
    if (body === null || typeof body !== 'object') {
      throw new ValidationError('Corps de requête invalide');
    }
    return body as T;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Corps de requête JSON invalide');
  }
}

/** Champ obligatoire, message explicite en français. */
export function required(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  if (!text) throw new ValidationError(`Le champ « ${label} » est obligatoire`);
  return text;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toInt(value: unknown, fallback = 0): number {
  return Math.trunc(toNumber(value, fallback));
}

export function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

/** Identifiant d'URL validé. */
export function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Identifiant invalide');
  return id;
}

/** Date métier `YYYY-MM-DD`, refusée si mal formée (§6.5 règle 2). */
export function businessDate(value: unknown, label = 'date', fallback?: string): string {
  if (value === null || value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`Le champ « ${label} » est obligatoire`);
  }
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError(`Le champ « ${label} » doit être au format AAAA-MM-JJ`);
  }
  return text;
}
