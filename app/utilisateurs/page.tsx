'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { IconAction, RowActions } from '@/components/row-actions';
import { FilterSelect } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Pagination } from '@/components/search-filter';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { UserModals, type UserFormValues } from '@/components/utilisateurs/utilisateurs-modals';
import { PermissionsEditorModal } from '@/components/utilisateurs/permissions-editor';
import { StoreAssignmentsModal, useAssignableStores } from '@/components/utilisateurs/store-assignments';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { formatDateTime } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';
import { ROLES, ROLE_LABELS, permissionsOf, type Action, type Role } from '@/lib/permissions';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import type { UserRow, UserStats } from '@/lib/users';

/** Clé de restauration d'état de cette liste (§5, obligatoire). */
const VIEW_STATE_KEY = 'utilisateurs';
const PAGE_SIZE = 10;

/**
 * Libellés français des permissions, pour matérialiser le tableau §17.2.
 * Purement présentationnel : la source de vérité reste `lib/permissions.ts`.
 */
const ACTION_LABELS: Record<Action, string> = {
  'dashboard.view': 'Tableau de bord',
  'reports.view': 'Rapports',
  'reports.viewAll': 'Rapports — toutes périodes',
  'balances.view': 'Soldes et créances',
  'sales.view': 'Ventes — consulter',
  'sales.create': 'Ventes — créer',
  'sales.update': 'Ventes — modifier',
  'sales.cancel': 'Ventes — annuler',
  'sales.delete': 'Ventes — supprimer',
  'customers.view': 'Clients — consulter',
  'customers.create': 'Clients — créer',
  'customers.update': 'Clients — modifier',
  'customers.delete': 'Clients — désactiver',
  'suppliers.view': 'Fournisseurs — consulter',
  'suppliers.create': 'Fournisseurs — créer',
  'suppliers.update': 'Fournisseurs — modifier',
  'suppliers.delete': 'Fournisseurs — désactiver',
  'products.view': 'Produits — consulter',
  'products.create': 'Produits — créer',
  'products.update': 'Produits — modifier',
  'products.delete': 'Produits — désactiver',
  'purchases.view': 'Achats — consulter',
  'purchases.create': 'Achats — créer',
  'purchases.update': 'Achats — modifier',
  'purchases.delete': 'Achats — annuler',
  'stock.view': 'Stock — consulter',
  'stock.adjust': 'Stock — ajuster',
  'cash.view': 'Caisse — consulter',
  'cash.open': 'Caisse — ouvrir',
  'cash.close': 'Caisse — clôturer',
  'cash.manual': 'Caisse — mouvement manuel',
  'expenses.view': 'Dépenses — consulter',
  'expenses.create': 'Dépenses — saisir',
  'expenses.update': 'Dépenses — modifier',
  'expenses.delete': 'Dépenses — annuler',
  'expenses.approve': 'Dépenses — approuver',
  'payments.view': 'Paiements — consulter',
  'payments.create': 'Paiements — encaisser',
  'workers.manage': 'Ouvriers — gérer',
  'jobs.view': 'Chantiers — consulter',
  'jobs.create': 'Chantiers — créer',
  'jobs.update': 'Chantiers — modifier',
  'jobs.delete': 'Chantiers — annuler',
  'stores.view': 'Magasins — consulter',
  'stores.manage': 'Magasins — gérer',
  'stores.viewAll': 'Magasins — vue consolidée',
  'transfers.view': 'Transferts — consulter',
  'transfers.create': 'Transferts — demander',
  'transfers.approve': 'Transferts — valider',
  'transfers.ship': 'Transferts — expédier',
  'transfers.receive': 'Transferts — réceptionner',
  'inventory.view': 'Inventaires — consulter',
  'inventory.manage': 'Inventaires — compter',
  'inventory.validate': 'Inventaires — valider',
  'users.manage': 'Utilisateurs — gérer',
  'audit.view': 'Historique des actions',
  'settings.view': 'Paramètres — consulter',
  'settings.update': 'Paramètres — modifier',
  'settings.critical': 'Paramètres critiques',
  'backup.manage': 'Sauvegarde / restauration',
  'sync.manage': 'Synchronisation',
};

type ListResponse = {
  data: UserRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    return payload?.error ?? `Erreur ${response.status}`;
  } catch {
    return `Erreur ${response.status}`;
  }
}

/**
 * Gestion des utilisateurs (README §17) — réservée à l'administrateur.
 *
 * La page est enveloppée dans `RoleGate` : un rôle non autorisé voit un message
 * explicite plutôt qu'un écran blanc. **Masquer n'est pas protéger** : les API
 * `/api/users*` vérifient `users.manage` de leur côté.
 */
export default function UtilisateursPage() {
  const allowed = usePermission('users.manage');

  if (!allowed) {
    return (
      <div className="space-y-5">
        <PageHeader
          eyebrow="Administration"
          title="Utilisateurs"
          description="Gestion des comptes, des rôles et du journal des actions."
        />
        <Card>
          <EmptyState
            title="Accès réservé"
            description="La gestion des comptes est réservée à l’administrateur et aux gérants qui en ont reçu le droit. Demandez-le à votre administrateur si vous en avez besoin."
          />
        </Card>
      </div>
    );
  }

  return <UtilisateursContent />;
}

function UtilisateursContent() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [inactiveOnly, setInactiveOnly] = useState(false);
  /** Filtre magasin (`?storeId=`) : chaîne vide = tous les magasins visibles. */
  const [storeFilter, setStoreFilter] = useState('');
  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);

  const [isLoading, setIsLoading] = useState(true);
  const [isStatsLoading, setIsStatsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Un état booléen par modale (§7) — jamais un « mode » sous forme de chaîne.
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [passwordUser, setPasswordUser] = useState<UserRow | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [statusUser, setStatusUser] = useState<UserRow | null>(null);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  /**
   * Modale des permissions par utilisateur : l'administrateur choisit, action
   * par action, entre « hérité du rôle », « autorisé » et « refusé ».
   */
  const [permissionsUser, setPermissionsUser] = useState<UserRow | null>(null);
  const [storesUser, setStoresUser] = useState<UserRow | null>(null);

  const { device, allStores } = useAuth();
  /*
   * Les comptes sont des données centrales : sur un poste de magasin, ils
   * arrivent du siège par la synchronisation et ne se modifient pas ici (le
   * serveur renvoie 403). On garde la consultation.
   */
  const canEditCentral = device?.mode !== 'store';
  const { stores: storeOptions } = useAssignableStores(true);
  /** Un gérant ne modifie pas un compte administrateur (le serveur le refuse aussi). */
  const canManageRow = (target: UserRow) => canEditCentral && (allStores || target.role !== 'admin');

  // Lien « Gérer les affectations » de la fiche magasin : `/utilisateurs?storeId=<id>`.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('storeId');
    if (fromUrl && /^\d+$/.test(fromUrl)) setStoreFilter(fromUrl);
  }, []);

  const abortRef = useRef<AbortController | null>(null);

  const rehydrated = useViewStateRehydration<{
    search: string;
    role: string;
    inactiveOnly: boolean;
    page: number;
  }>(VIEW_STATE_KEY, (saved) => {
    if (saved.search !== undefined) setSearch(saved.search);
    if (saved.role !== undefined) setRole(saved.role);
    if (saved.inactiveOnly !== undefined) setInactiveOnly(saved.inactiveOnly);
    if (saved.page) setPage(saved.page);
  });

  const reload = useCallback(() => setRefreshToken((value) => value + 1), []);

  /** Liste : recherche débouncée + `AbortController` (pas de « réponse du passé »). */
  useEffect(() => {
    if (!rehydrated) return; // ⚠️ gate : sinon page 1 puis page 3

    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search.trim()) params.set('search', search.trim());
      if (role) params.set('role', role);
      if (inactiveOnly) params.set('inactive', 'true');
      if (storeFilter) params.set('storeId', storeFilter);

      setIsLoading(true);
      setLoadError(null);

      fetch(`/api/users?${params.toString()}`, { signal: controller.signal, cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(await readError(response));
          return (await response.json()) as ListResponse;
        })
        .then((payload) => {
          setUsers(payload.data);
          setTotal(payload.total);
          setTotalPages(payload.totalPages);

          // Une page restaurée devenue hors bornes est ramenée dans les bornes.
          const clamped = clampPage(page, payload.totalPages);
          if (clamped !== null) setPage(clamped);

          setIsLoading(false);
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'AbortError') return;
          setLoadError(error instanceof Error ? error.message : 'Chargement impossible');
          setIsLoading(false);
        });
    }, 300);

    return () => clearTimeout(timer);
  }, [rehydrated, search, role, inactiveOnly, storeFilter, page, refreshToken]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** Cartes de synthèse : `GET /api/users?stats=true` (voir `app/api/users/route.ts`). */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    setIsStatsLoading(true);

    fetch('/api/users?stats=true', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        return (await response.json()) as UserStats;
      })
      .then((payload) => {
        setStats(payload);
        setIsStatsLoading(false);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setStats(null);
        setIsStatsLoading(false);
      });

    return () => controller.abort();
  }, [rehydrated, refreshToken]);

  /** Mémorise l'état de vue : sans lui, le retour arrière repart à la page 1. */
  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_STATE_KEY, { search, role, inactiveOnly, page });
  }, [rehydrated, search, role, inactiveOnly, page]);

  const selectedRolePermissions = useMemo(() => {
    if (!role) return null;
    const actions = permissionsOf({ role: role as Role });
    return actions.map((action) => ACTION_LABELS[action] ?? action).sort((a, b) => a.localeCompare(b, 'fr'));
  }, [role]);

  const roleOptions = useMemo(
    () => ROLES.map((value) => ({ value, label: ROLE_LABELS[value] })),
    [],
  );

  /* --------------------------- Écritures --------------------------- */

  const handleCreate = async (values: UserFormValues) => {
    setIsCreating(true);
    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success(`Utilisateur « ${values.name} » créé`);
      setIsCreateOpen(false);
      reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Création impossible', { autoClose: 8000 });
    } finally {
      setIsCreating(false);
    }
  };

  const handleEdit = async (id: number, values: Omit<UserFormValues, 'password' | 'stores'>) => {
    setIsEditing(true);
    try {
      const response = await fetch(`/api/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success('Utilisateur mis à jour');
      setEditingUser(null);
      reload();
    } catch (error) {
      // Le refus du dernier administrateur actif arrive ici, en 409, avec un
      // message qui dit quoi faire plutôt qu'un code d'erreur.
      toast.error(error instanceof Error ? error.message : 'Modification impossible', { autoClose: 10000 });
    } finally {
      setIsEditing(false);
    }
  };

  const handleChangePassword = async (id: number, password: string) => {
    setIsChangingPassword(true);
    try {
      const response = await fetch(`/api/users/${id}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success('Mot de passe réinitialisé');
      setPasswordUser(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Réinitialisation impossible', { autoClose: 8000 });
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleStatusChange = async () => {
    if (!statusUser) return;
    const reactivate = !statusUser.isActive;
    setIsUpdatingStatus(true);
    try {
      const response = await fetch(`/api/users/${statusUser.id}?reactivate=${reactivate}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success(reactivate ? 'Utilisateur réactivé' : 'Utilisateur désactivé');
      setStatusUser(null);
      reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Opération impossible', { autoClose: 10000 });
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  /* ----------------------------- Colonnes ----------------------------- */

  const columns: Column<UserRow>[] = [
    {
      key: 'name',
      label: 'Nom',
      primary: true,
      // L'identifiant est sous le nom : une colonne de moins, les actions restent visibles.
      render: (user) => (
        <span className="block min-w-0">
          <span className="block font-semibold">{user.name}</span>
          <span className="block font-mono text-xs text-base-content/60">{user.username}</span>
        </span>
      ),
    },
    {
      key: 'role',
      label: 'Rôle',
      render: (user) => (
        <Badge tone={user.role === 'admin' ? 'primary' : 'neutral'}>{ROLE_LABELS[user.role]}</Badge>
      ),
    },
    {
      key: 'stores',
      label: 'Magasins',
      render: (user) =>
        (user.stores ?? []).length === 0 ? (
          <span className="text-base-content/50">{user.role === 'admin' ? 'Tous (administrateur)' : 'Aucun'}</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {(user.stores ?? []).map((store) => (
              <Badge key={store.id} tone={store.isManager ? 'primary' : 'neutral'}>
                {store.code}
                {store.isManager ? ' · gérant' : ''}
              </Badge>
            ))}
          </span>
        ),
    },
    {
      key: 'lastLoginAt',
      label: 'Dernière connexion',
      hideOnMobile: true,
      render: (user) => (
        <span className="text-base-content/70">{formatDateTime(user.lastLoginAt)}</span>
      ),
    },
    {
      key: 'isActive',
      label: 'Statut',
      render: (user) => (
        <Badge tone={user.isActive ? 'success' : 'neutral'}>
          {user.isActive ? 'Actif' : 'Inactif'}
        </Badge>
      ),
    },
  ];

  const isEmpty = !isLoading && !loadError && users.length === 0;
  const hasFilters = Boolean(search.trim()) || Boolean(role) || inactiveOnly || Boolean(storeFilter);

  return (
    <div className="space-y-5">
      {!canEditCentral && (
        <div className="alert border border-info/30 bg-info/10 text-sm">
          <span>
            <strong>Comptes gérés au siège.</strong> Ce poste de magasin affiche les comptes en
            consultation ; les créations et modifications se font sur le poste du siège.
          </span>
        </div>
      )}
      <PageHeader
        eyebrow="Administration"
        title="Utilisateurs"
        description="Comptes, rôles, magasins affectés et droits d’accès. Les mots de passe sont chiffrés : personne, pas même l’administrateur, ne peut les lire."
        actions={
          <>
            <Link href="/utilisateurs/historique" className="btn btn-ghost min-h-11">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Historique des actions
            </Link>
            {canEditCentral && (
            <button
              type="button"
              className="btn btn-primary min-h-11"
              onClick={() => setIsCreateOpen(true)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Nouvel utilisateur
            </button>
            )}
          </>
        }
      />

      {/* Cartes de synthèse — `GET /api/users?stats=true` */}
      {isStatsLoading ? (
        <SkeletonCards count={4} />
      ) : stats ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardDelta
            label="Utilisateurs"
            value={formatNumber(stats.totalUsers)}
            hint="Comptes enregistrés, actifs et inactifs"
            tooltip="Nombre total de comptes créés dans l’application (ceux que vous pouvez gérer), y compris les comptes désactivés. Un compte n’est jamais supprimé, pour garder l’historique de ce qu’il a fait."
          />
          <StatCardDelta
            label="Comptes actifs"
            value={formatNumber(stats.activeUsers)}
            hint="Autorisés à se connecter"
            tone="success"
            tooltip="Comptes qui peuvent se connecter aujourd’hui. Chacun ne voit que les magasins qui lui sont affectés."
          />
          <StatCardDelta
            label="Comptes désactivés"
            value={formatNumber(stats.inactiveUsers)}
            hint="Conservés pour l’historique, réactivables"
            tone="neutral"
            tooltip="Comptes bloqués : ils ne peuvent plus se connecter (départ d’un employé, par exemple). Leurs ventes et opérations restent visibles et on peut les réactiver à tout moment."
          />
          <StatCardDelta
            label="Administrateurs actifs"
            value={formatNumber(stats.administrators)}
            hint="Au moins un doit rester actif à tout moment"
            tone="warning"
            tooltip="Comptes qui ont tous les droits sur tous les magasins. L’application refuse de désactiver le dernier administrateur, pour qu’il reste toujours quelqu’un capable de tout gérer."
          />
          <div className="sm:col-span-2 lg:col-span-4">
            <Card>
              <p className="text-sm font-medium text-base-content/70">Répartition par rôle</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {stats.byRole.length === 0 ? (
                  <span className="text-sm text-base-content/50">Aucun compte pour le moment.</span>
                ) : (
                  stats.byRole.map((entry) => (
                    <Badge key={entry.role} tone={entry.role === 'admin' ? 'primary' : 'neutral'}>
                      {ROLE_LABELS[entry.role]} · {formatNumber(entry.count)}
                    </Badge>
                  ))
                )}
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {/* Encart pédagogique : masquer n'est pas protéger (README §5.4) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-info/30 bg-info/5">
          <h2 className="text-base font-semibold">Rôles, magasins et droits</h2>
          <p className="mt-2 text-sm leading-6 text-base-content/70">
            Chaque compte a un <strong>rôle</strong> (ce qu’il peut faire) et des <strong>magasins</strong>{' '}
            (où il peut le faire). Un vendeur de Kaloum ne voit ni les ventes ni la caisse de Matoto. Le
            menu n’affiche que ce que le compte a le droit d’utiliser, et l’application revérifie chaque
            droit à chaque opération : changer l’adresse d’une page ne donne aucun accès supplémentaire.
          </p>
          <p className="mt-2 text-sm leading-6 text-base-content/70">
            L’historique des actions garde la trace de la création, de la modification, de la
            désactivation, des changements de magasins et des mots de passe réinitialisés.
          </p>
        </Card>

        <Card>
          <h2 className="text-base font-semibold">
            Droits accordés au rôle sélectionné
            {role ? ` — ${ROLE_LABELS[role as Role]}` : ''}
          </h2>
          {!role ? (
            <p className="mt-2 text-sm text-base-content/60">
              Choisissez un rôle dans le filtre « Rôle » pour afficher la liste exacte de ce
              qu’il autorise.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-base-content/60">
                {selectedRolePermissions?.length ?? 0} droit(s) accordé(s) à ce rôle :
              </p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {(selectedRolePermissions ?? []).map((label) => (
                  <li key={label}>
                    <Badge tone="success">{label}</Badge>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un nom, un identifiant, un téléphone…"
        filters={
          <>
            <div className="w-full sm:w-52">
              <FilterSelect
                value={role}
                onChange={(value) => {
                  setRole(value);
                  setPage(1);
                }}
                options={roleOptions}
                placeholder="Tous les rôles"
              />
            </div>
            {(storeOptions ?? []).length > 1 && (
              <div className="w-full sm:w-56">
                <FilterSelect
                  value={storeFilter}
                  onChange={(value) => {
                    setStoreFilter(value);
                    setPage(1);
                  }}
                  options={(storeOptions ?? []).map((store) => ({ value: String(store.id), label: store.name }))}
                  placeholder="Tous les magasins"
                />
              </div>
            )}
            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 border-base-300 bg-base-200/50 px-3 text-sm">
              <input
                type="checkbox"
                className="toggle toggle-sm"
                checked={inactiveOnly}
                onChange={(event) => {
                  setInactiveOnly(event.target.checked);
                  setPage(1);
                }}
              />
              Comptes inactifs
            </label>
          </>
        }
        actions={
          <span className="text-sm text-base-content/50">
            {formatNumber(total)} utilisateur(s)
          </span>
        }
      />

      {isLoading ? (
        <SkeletonTable rows={6} cols={5} />
      ) : loadError ? (
        <Card>
          <ErrorState
            title="Impossible de charger les utilisateurs"
            description={loadError}
            onRetry={reload}
          />
        </Card>
      ) : isEmpty ? (
        <Card>
          <EmptyState
            title={hasFilters ? 'Aucun utilisateur ne correspond' : 'Aucun utilisateur enregistré'}
            description={
              hasFilters
                ? 'Élargissez la recherche ou choisissez un autre rôle.'
                : 'Créez le premier compte pour permettre la connexion à l’application.'
            }
            action={
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => {
                  if (hasFilters) {
                    setSearch('');
                    setRole('');
                    setInactiveOnly(false);
                    setStoreFilter('');
                    setPage(1);
                  } else {
                    setIsCreateOpen(true);
                  }
                }}
              >
                {hasFilters ? 'Réinitialiser les filtres' : 'Créer le premier utilisateur'}
              </button>
            }
          />
        </Card>
      ) : (
        <ResponsiveTable
          columns={columns}
          data={users}
          getRowKey={(user) => user.id}
          actions={(user) => (
            <RowActions>
              {canManageRow(user) && (
                <IconAction
                  icon="edit"
                  label={`Modifier ${user.name}`}
                  onClick={() => setEditingUser(user)}
                />
              )}
              {canManageRow(user) && (
                <IconAction
                  icon="store"
                  label={`Magasins de ${user.name}`}
                  onClick={() => setStoresUser(user)}
                />
              )}
              {canManageRow(user) && (
                <IconAction
                  icon="key"
                  label={`Changer le mot de passe de ${user.name}`}
                  onClick={() => setPasswordUser(user)}
                />
              )}
              <IconAction
                icon="shield"
                label={
                  user.role === 'admin'
                    ? "L'administrateur détient toutes les permissions"
                    : `Définir les permissions de ${user.name}`
                }
                onClick={() => setPermissionsUser(user)}
              />
              {canManageRow(user) && (
              <IconAction
                icon={user.isActive ? 'deactivate' : 'activate'}
                tone={user.isActive ? 'danger' : 'success'}
                label={user.isActive ? `Désactiver ${user.name}` : `Réactiver ${user.name}`}
                onClick={() => setStatusUser(user)}
              />
              )}
            </RowActions>
          )}
          actionsClassName="w-56"
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      <StoreAssignmentsModal user={storesUser} onClose={() => setStoresUser(null)} onSaved={reload} />

      <PermissionsEditorModal
        isOpen={permissionsUser !== null}
        userId={permissionsUser?.id ?? null}
        onClose={() => setPermissionsUser(null)}
        onSaved={() => setRefreshToken((value) => value + 1)}
      />

      <UserModals
        isCreateOpen={isCreateOpen}
        onCreateClose={() => setIsCreateOpen(false)}
        onCreateSubmit={handleCreate}
        isCreating={isCreating}
        editingUser={editingUser}
        onEditClose={() => setEditingUser(null)}
        onEditSubmit={handleEdit}
        isEditing={isEditing}
        passwordUser={passwordUser}
        onPasswordClose={() => setPasswordUser(null)}
        onPasswordSubmit={handleChangePassword}
        isChangingPassword={isChangingPassword}
        statusUser={statusUser}
        onStatusClose={() => setStatusUser(null)}
        onStatusConfirm={handleStatusChange}
        isUpdatingStatus={isUpdatingStatus}
      />
    </div>
  );
}
