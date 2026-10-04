'use client';

/**
 * Utilisateurs (README §17) — refonte du 4 octobre 2026.
 *
 * Avant : quatre cartes, deux encarts d'explication, un tableau avec cinq
 * boutons-icônes par ligne et cinq fenêtres différentes. Jugé « moche et
 * difficile à utiliser » par le client.
 *
 * Maintenant :
 *  - en tête, l'essentiel en trois chiffres et la répartition par rôle, qui
 *    sert aussi de **filtre** (un clic sur « Vendeurs » filtre la liste) ;
 *  - une liste lisible : la personne, son rôle, ses magasins, sa dernière
 *    connexion — **une ligne = un clic** pour ouvrir sa fiche ;
 *  - la fiche — une page entière, `/utilisateurs/[id]` — réunit profil,
 *    magasins, droits et sécurité ;
 *  - la création passe par un assistant en quatre étapes (`UserWizard`).
 *
 * Masquer n'est pas protéger : les routes `/api/users*` vérifient
 * `users.manage`, le périmètre du gérant et la protection de l'administrateur.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Badge, Card, EmptyState, ErrorState, SkeletonCards, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { UserWizard } from '@/components/utilisateurs/user-wizard';
import { initials, type UserListItem } from '@/components/utilisateurs/user-detail';
import { useAssignableStores } from '@/components/utilisateurs/store-assignments';
import { formatDateTime } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';
import { ROLES, ROLE_LABELS, ROLE_LABELS_PLURAL, type Role } from '@/lib/permissions';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import type { UserStats } from '@/lib/users';

const VIEW_STATE_KEY = 'utilisateurs';
const PAGE_SIZE = 15;

type Status = 'active' | 'inactive';
type ListResponse = { data: UserListItem[]; total: number; totalPages: number };

export default function UtilisateursPage() {
  const allowed = usePermission('users.manage');
  if (!allowed) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Administration" title="Utilisateurs" description="Comptes, rôles, magasins et droits." />
        <Card>
          <EmptyState
            title="Accès réservé"
            description="La gestion des comptes est réservée à l’administrateur et aux gérants qui en ont reçu le droit."
          />
        </Card>
      </div>
    );
  }
  return <UtilisateursContent />;
}

function UtilisateursContent() {
  const { device, allStores } = useAuth();
  const router = useRouter();
  // Les comptes sont centraux : un poste de magasin les consulte seulement.
  const canEditCentral = device?.mode !== 'store';
  const { stores: storeOptions } = useAssignableStores(true);

  const [users, setUsers] = useState<UserListItem[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState<Status>('active');
  const [storeFilter, setStoreFilter] = useState('');
  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const openUser = (u: UserListItem) => router.push(`/utilisateurs/${u.id}`);

  const abortRef = useRef<AbortController | null>(null);
  const reload = useCallback(() => setRefreshToken((v) => v + 1), []);

  // Lien « Gérer les affectations » de la fiche magasin : `/utilisateurs?storeId=<id>`.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('storeId');
    if (fromUrl && /^\d+$/.test(fromUrl)) setStoreFilter(fromUrl);
  }, []);

  const rehydrated = useViewStateRehydration<{ search: string; role: string; status: Status; page: number }>(
    VIEW_STATE_KEY,
    (saved) => {
      if (saved.search !== undefined) setSearch(saved.search);
      if (saved.role !== undefined) setRole(saved.role);
      if (saved.status === 'active' || saved.status === 'inactive') setStatus(saved.status);
      if (saved.page) setPage(saved.page);
    },
  );

  useEffect(() => {
    if (!rehydrated) return;
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search.trim()) params.set('search', search.trim());
      if (role) params.set('role', role);
      if (status === 'inactive') params.set('inactive', 'true');
      if (storeFilter) params.set('storeId', storeFilter);
      setIsLoading(true);
      setLoadError(null);
      fetch(`/api/users?${params}`, { signal: controller.signal, cache: 'no-store' })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error ?? `Erreur ${response.status}`);
          return payload as ListResponse;
        })
        .then((payload) => {
          setUsers(payload.data);
          setTotal(payload.total);
          setTotalPages(payload.totalPages);
          const clamped = clampPage(page, payload.totalPages);
          if (clamped !== null) setPage(clamped);
          setIsLoading(false);
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'AbortError') return;
          setLoadError(error instanceof Error ? error.message : 'Chargement impossible');
          setIsLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [rehydrated, search, role, status, storeFilter, page, refreshToken]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!rehydrated) return;
    const controller = new AbortController();
    fetch('/api/users?stats=true', { signal: controller.signal, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => setStats(payload as UserStats | null))
      .catch(() => {});
    return () => controller.abort();
  }, [rehydrated, refreshToken]);

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_STATE_KEY, { search, role, status, page });
  }, [rehydrated, search, role, status, page]);

  /** Fiche en lecture seule : poste de magasin, ou compte administrateur vu par un gérant. */
  const readOnlyFor = (target: UserListItem) => !canEditCentral || (!allStores && target.role === 'admin');

  const roleCounts = useMemo(() => new Map((stats?.byRole ?? []).map((r) => [r.role, r.count])), [stats]);

  const columns: Column<UserListItem>[] = [
    {
      key: 'name',
      label: 'Personne',
      primary: true,
      render: (u) => (
        <span className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
              u.isActive ? 'bg-primary/15 text-primary' : 'bg-base-200 text-base-content/50'
            }`}
          >
            {initials(u.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold">{u.name}</span>
            <span className="block truncate font-mono text-xs text-base-content/55">{u.username}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'role',
      label: 'Rôle',
      render: (u) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={u.role === 'admin' ? 'primary' : 'neutral'}>{ROLE_LABELS[u.role]}</Badge>
          {u.customized && <Badge tone="info">droits ajustés</Badge>}
        </span>
      ),
    },
    {
      key: 'stores',
      label: 'Magasins',
      render: (u) =>
        u.role === 'admin' ? (
          <span className="text-sm text-base-content/60">Tous les magasins</span>
        ) : (u.stores ?? []).length === 0 ? (
          <span className="text-sm text-warning">Aucun magasin</span>
        ) : (
          <span
            className="block min-w-0 max-w-[15rem] text-sm"
            title={(u.stores ?? []).map((s) => `${s.name}${s.isManager ? ' (gérant)' : ''}`).join(', ')}
          >
            {/* Premier magasin + « N autres » : la liste complète élargissait le
                tableau au-delà de 1366 px (dernière colonne cachée, verify:ui). */}
            <span className="block truncate">
              {(() => {
                const [first, ...rest] = u.stores ?? [];
                return `${first.name}${first.isManager ? ' (gérant)' : ''}${rest.length ? ` + ${rest.length} autre${rest.length > 1 ? 's' : ''}` : ''}`;
              })()}
            </span>
            {(u.stores ?? []).length > 1 && (
              <span className="block text-xs text-base-content/55">
                {u.canSwitchStore ? '↔ peut changer de magasin' : 'reste dans son magasin principal'}
              </span>
            )}
          </span>
        ),
    },
    {
      key: 'lastLoginAt',
      label: 'Dernière connexion',
      hideOnMobile: true,
      render: (u) => <span className="text-sm text-base-content/70">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Jamais'}</span>,
    },
  ];

  const hasFilters = Boolean(search.trim() || role || storeFilter) || status === 'inactive';

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Administration"
        title="Utilisateurs"
        description="Qui peut se connecter, dans quels magasins, et ce que chacun peut faire."
        actions={
          <>
            <Link href="/utilisateurs/historique" className="btn btn-ghost min-h-11">
              Historique des actions
            </Link>
            {canEditCentral && (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsWizardOpen(true)}>
                + Nouvel utilisateur
              </button>
            )}
          </>
        }
      />

      {!canEditCentral && (
        <p className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
          <strong>Comptes gérés au siège.</strong> Ce poste de magasin les affiche en consultation.
        </p>
      )}

      {stats ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCardDelta
            label="Comptes actifs"
            value={formatNumber(stats.activeUsers)}
            hint={`${formatNumber(stats.totalUsers)} comptes au total`}
            tone="success"
            tooltip="Personnes qui peuvent se connecter aujourd’hui (parmi les comptes que vous gérez). Chacune ne voit que ses magasins."
          />
          <StatCardDelta
            label="Comptes désactivés"
            value={formatNumber(stats.inactiveUsers)}
            hint="Ne peuvent plus se connecter, réactivables"
            tone="neutral"
            tooltip="Comptes bloqués, par exemple après le départ d’un employé. Rien n’est supprimé : leurs ventes et opérations restent visibles."
          />
          <StatCardDelta
            label="Administrateurs"
            value={formatNumber(stats.administrators)}
            hint="Tous les droits, ne se désactivent pas"
            tone="primary"
            tooltip="Comptes qui ont tous les droits dans tous les magasins. Un administrateur ne peut pas être désactivé : l’application garde toujours quelqu’un capable de tout gérer."
          />
        </div>
      ) : (
        <SkeletonCards count={3} />
      )}

      {/* Répartition par rôle = filtre en un clic */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrer par rôle">
        {[{ value: '', label: 'Tous les rôles', count: stats?.totalUsers }, ...ROLES.map((r: Role) => ({ value: r, label: ROLE_LABELS_PLURAL[r], count: roleCounts.get(r) ?? 0 }))].map(
          (chip) => {
            const active = role === chip.value;
            return (
              <button
                key={chip.value || 'all'}
                type="button"
                aria-pressed={active}
                className={`btn btn-sm min-h-11 rounded-full sm:min-h-0 ${active ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                onClick={() => {
                  setRole(chip.value);
                  setPage(1);
                }}
              >
                {chip.label}
                {chip.count !== undefined && <span className={active ? 'opacity-80' : 'text-base-content/50'}>{formatNumber(chip.count)}</span>}
              </button>
            );
          },
        )}
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
            <div role="tablist" aria-label="Statut" className="join">
              {(['active', 'inactive'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={status === value}
                  className={`btn join-item min-h-11 sm:min-h-0 ${status === value ? 'btn-neutral' : 'btn-ghost border border-base-300'}`}
                  onClick={() => {
                    setStatus(value);
                    setPage(1);
                  }}
                >
                  {value === 'active' ? 'Actifs' : 'Désactivés'}
                </button>
              ))}
            </div>
            {(storeOptions ?? []).length > 1 && (
              <div className="w-full sm:w-56">
                <FilterSelect
                  value={storeFilter}
                  onChange={(value) => {
                    setStoreFilter(value);
                    setPage(1);
                  }}
                  options={(storeOptions ?? []).map((s) => ({ value: String(s.id), label: s.name }))}
                  placeholder="Tous les magasins"
                />
              </div>
            )}
          </>
        }
        actions={<span className="text-sm text-base-content/55">{formatNumber(total)} compte(s)</span>}
      />

      {isLoading ? (
        <SkeletonTable rows={6} cols={4} />
      ) : loadError ? (
        <Card>
          <ErrorState title="Impossible de charger les utilisateurs" description={loadError} onRetry={reload} />
        </Card>
      ) : users.length === 0 ? (
        <Card>
          <EmptyState
            title={hasFilters ? 'Aucun compte ne correspond' : 'Aucun utilisateur'}
            description={hasFilters ? 'Changez la recherche ou les filtres.' : 'Créez le premier compte pour qu’une personne puisse se connecter.'}
            action={
              hasFilters ? (
                <button
                  type="button"
                  className="btn btn-outline min-h-11"
                  onClick={() => {
                    setSearch('');
                    setRole('');
                    setStatus('active');
                    setStoreFilter('');
                    setPage(1);
                  }}
                >
                  Réinitialiser les filtres
                </button>
              ) : canEditCentral ? (
                <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsWizardOpen(true)}>
                  Créer le premier utilisateur
                </button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ResponsiveTable
          columns={columns}
          data={users}
          getRowKey={(u) => u.id}
          onRowClick={openUser}
          actions={(u) => (
            <Link
              href={`/utilisateurs/${u.id}`}
              className="btn btn-sm btn-ghost min-h-11 border border-base-300 sm:min-h-0"
              aria-label={`Ouvrir la fiche de ${u.name}`}
              onClick={(event) => event.stopPropagation()}
            >
              {readOnlyFor(u) ? 'Voir' : 'Gérer'}
            </Link>
          )}
          actionsClassName="w-24"
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      <UserWizard
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onCreated={(id) => {
          toast.success('Compte créé : donnez son identifiant et son mot de passe à la personne.');
          setIsWizardOpen(false);
          // On ouvre directement sa fiche : magasins et droits s'y ajustent.
          router.push(`/utilisateurs/${id}`);
        }}
      />
    </div>
  );
}
