'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  EmptyState,
  ErrorState,
  MoneyText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { useSettings } from '@/app/parametres/page';
import { StoreScopeSelect, StoreTag, scopeShowsStore, useStoreScope } from '@/components/store-scope';
import { jobCategoryOptions } from '@/components/chantiers/chantiers-modals';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatNumber, formatQuantity } from '@/lib/format';
import {
  ServiceStatusBadge,
  readApiError,
  type Paginated,
  type ServiceRow,
} from '@/components/prestations/shared';
import { ServiceFormModal, changeServiceStatus } from '@/components/prestations/service-modals';

/* ==================================================================
 * Catalogue des prestations (README §19.1, cahier « Prestations » §3–§5).
 *
 * Le catalogue est **propre à chaque magasin** : on y voit les prestations du
 * magasin actif (ou d'un autre magasin du périmètre, en lecture). Créer,
 * modifier, désactiver ou archiver ne se fait que dans le magasin actif, sur
 * ses propres prestations — le serveur le revérifie.
 * ================================================================== */

const LIMIT = 20;
const VIEW_NAME = 'prestations';

type ViewState = { search: string; category: string; status: string; sort: string; page: number };

type Summary = {
  active: number;
  inactive: number;
  archived: number;
  revenue: number;
  top: { id: number; name: string; revenue: number } | null;
};

const STATUS_OPTIONS = [
  { value: 'active', label: 'Actives' },
  { value: 'inactive', label: 'Désactivées' },
  { value: 'archived', label: 'Archivées' },
];
const SORT_OPTIONS = [
  { value: 'revenue', label: 'Les plus rentables' },
  { value: 'usage', label: 'Les plus utilisées' },
  { value: 'price', label: 'Prix décroissant' },
];

export default function PrestationsPage() {
  const router = useRouter();
  const canManage = usePermission('services.manage');
  const { activeStoreId } = useAuth();
  const { settings } = useSettings();
  const { scope, setScope, apply } = useStoreScope('prestations');
  const storeParam = apply(new URLSearchParams()).get('store') ?? '';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const [isEditOpen, setIsEditOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.category !== undefined) setCategory(saved.category);
    if (saved.status !== undefined) setStatus(saved.status);
    if (saved.sort !== undefined) setSort(saved.sort);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, category, status, sort, page });
  }, [rehydrated, search, category, status, sort, page]);

  useEffect(() => {
    if (!rehydrated) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (category) params.set('category', category);
    if (status) params.set('status', status);
    if (sort) params.set('sort', sort);
    if (storeParam) params.set('store', storeParam);

    fetch(`/api/prestations?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Le catalogue n’a pas pu être chargé.'));
        return (await response.json()) as Paginated<ServiceRow>;
      })
      .then((payload) => {
        setRows(payload.data ?? []);
        setTotal(payload.total ?? 0);
        setTotalPages(payload.totalPages ?? 1);
        const corrected = clampPage(page, payload.totalPages ?? 1);
        if (corrected !== null) setPage(corrected);
      })
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Le catalogue n’a pas pu être chargé.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [rehydrated, debouncedSearch, category, status, sort, page, storeParam, reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ stats: '1' });
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/prestations?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { summary: Summary }) : null))
      .then((payload) => setSummary(payload?.summary ?? null))
      .catch(() => {});
    return () => controller.abort();
  }, [storeParam, reloadToken]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const showStore = scopeShowsStore(scope);
  const activeFilters = [category, status, sort].filter(Boolean).length;

  const columns: Column<ServiceRow>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Prestation',
        primary: true,
        render: (service) => (
          <div className="min-w-0 max-w-[22rem]">
            <Link
              href={`/prestations/${service.id}`}
              className="font-semibold text-primary hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {service.name}
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-base-content/55">
              <span className="tabular">{service.code}</span>
              <Badge tone="primary">{service.category}</Badge>
            </div>
            <StoreTag name={service.storeName} show={showStore} />
          </div>
        ),
      },
      {
        key: 'price',
        label: 'Prix indicatif',
        className: 'text-right whitespace-nowrap',
        render: (service) => (
          <span className="block">
            <MoneyText value={service.unitPrice} bold />
            <span className="block text-xs text-base-content/55">par {service.unit}</span>
          </span>
        ),
      },
      {
        key: 'usage',
        label: 'Utilisation',
        hideOnMobile: true,
        render: (service) => (
          <span className="block text-sm">
            <span className="tabular font-medium">{formatNumber(service.jobsCount)}</span> chantier
            {service.jobsCount > 1 ? 's' : ''}
            {service.quantity > 0 && (
              <span className="block text-xs text-base-content/55">{formatQuantity(service.quantity, service.unit)} réalisés</span>
            )}
          </span>
        ),
      },
      {
        key: 'revenue',
        label: 'CA généré',
        className: 'text-right whitespace-nowrap',
        render: (service) => <MoneyText value={service.revenue} />,
      },
      {
        key: 'status',
        label: 'Statut',
        render: (service) => <ServiceStatusBadge status={service.status} />,
      },
    ],
    [showStore],
  );

  async function setServiceStatus(service: ServiceRow, next: ServiceRow['status']) {
    const updated = await changeServiceStatus(service, next);
    if (updated) refresh();
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Chantiers"
        title="Prestations"
        description="Le catalogue des services que votre magasin propose (pose, installation, rénovation…), avec ses propres prix. Chaque magasin a le sien."
        actions={
          canManage ? (
            <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsCreateOpen(true)}>
              Nouvelle prestation
            </button>
          ) : undefined
        }
      />

      {!summary ? (
        <SkeletonCards count={4} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardDelta
            label="Prestations proposées"
            tooltip="Nombre de prestations actives du catalogue : ce sont les seules qu’on peut mettre dans un nouveau devis ou chantier."
            tone="primary"
            value={formatNumber(summary.active)}
            hint={`${formatNumber(summary.inactive)} désactivée(s), ${formatNumber(summary.archived)} archivée(s)`}
          />
          <StatCardDelta
            label="CA des prestations"
            tooltip="Total facturé aux clients pour ces prestations, dans les chantiers en cours ou terminés (chantiers annulés exclus)."
            tone="success"
            value={<MoneyText value={summary.revenue} />}
            hint="Chantiers non annulés"
          />
          <StatCardDelta
            label="La plus vendue"
            tooltip="La prestation qui a rapporté le plus de chiffre d’affaires sur les chantiers."
            tone="info"
            value={<span className="block truncate text-lg">{summary.top?.name ?? '—'}</span>}
            hint={summary.top ? `${new Intl.NumberFormat('fr-FR').format(summary.top.revenue)} GNF facturés` : 'Aucune vente encore'}
          />
          <StatCardDelta
            label="Catalogue"
            tooltip="Le catalogue appartient au magasin : les autres magasins ont leurs propres prestations et leurs propres prix."
            tone="neutral"
            value={formatNumber(summary.active + summary.inactive + summary.archived)}
            hint="Fiches au total"
          />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un nom, un code, une catégorie…"
        filters={
          <>
            <StoreScopeSelect
              value={scope}
              onChange={(value) => {
                setScope(value);
                setPage(1);
              }}
              className="min-h-11 w-full sm:w-52"
            />
            <div className="w-full sm:w-52">
              <FilterSelect
                value={category}
                onChange={(value) => {
                  setCategory(value);
                  setPage(1);
                }}
                options={jobCategoryOptions(settings.jobCategories ?? [])}
                placeholder="Toutes les catégories"
              />
            </div>
          </>
        }
        secondaryFilters={
          <>
            <FilterSelect
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={STATUS_OPTIONS}
              placeholder="Actives et désactivées"
            />
            <FilterSelect value={sort} onChange={setSort} options={SORT_OPTIONS} placeholder="Ordre alphabétique" />
          </>
        }
        secondaryCount={activeFilters}
      />

      {isLoading ? (
        <SkeletonTable rows={6} cols={5} />
      ) : error ? (
        <ErrorState title="Catalogue indisponible" description={error} onRetry={refresh} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={search || activeFilters ? 'Aucune prestation trouvée' : 'Catalogue vide'}
          description={
            search || activeFilters
              ? 'Aucune prestation ne correspond à ces critères.'
              : 'Ajoutez les services que votre magasin réalise : chacun aura son prix et son unité (forfait, m², jour…).'
          }
          action={
            canManage && !search && !activeFilters ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsCreateOpen(true)}>
                Créer la première prestation
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={columns}
            data={rows}
            getRowKey={(service) => service.id}
            onRowClick={(service) => router.push(`/prestations/${service.id}`)}
            emptyMessage="Aucune prestation."
            actions={
              canManage
                ? (service) =>
                    service.storeId === activeStoreId ? (
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm min-h-11"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditing(service);
                            setIsEditOpen(true);
                          }}
                        >
                          Modifier
                        </button>
                        {service.status === 'active' ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm min-h-11 text-warning"
                            onClick={(event) => {
                              event.stopPropagation();
                              void setServiceStatus(service, 'inactive');
                            }}
                          >
                            Désactiver
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm min-h-11 text-success"
                            onClick={(event) => {
                              event.stopPropagation();
                              void setServiceStatus(service, 'active');
                            }}
                          >
                            Réactiver
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-base-content/50">Autre magasin</span>
                    )
                : undefined
            }
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/50">
            {total} prestation{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

      <ServiceFormModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} onSaved={refresh} service={null} />
      <ServiceFormModal isOpen={isEditOpen} onClose={() => setIsEditOpen(false)} onSaved={refresh} service={editing} />
    </div>
  );
}
