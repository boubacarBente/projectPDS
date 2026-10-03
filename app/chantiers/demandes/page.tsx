'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { EmptyState, ErrorState, SkeletonCards, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { StoreScopeSelect, StoreTag, scopeShowsStore, useStoreScope } from '@/components/store-scope';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';
import {
  REQUEST_STATUS_LABELS,
  RequestStatusBadge,
  readApiError,
  type Paginated,
  type RequestStatus,
  type RequestsSummary,
  type ServiceRequestRow,
} from '@/components/prestations/shared';
import { RequestFormModal } from '@/components/prestations/request-modal';

/* ==================================================================
 * Demandes de prestation (cahier « Prestations » §8) : le besoin du client,
 * avant tout chiffrage. Une demande avance jusqu'au devis puis au chantier.
 * ================================================================== */

const LIMIT = 20;
const VIEW_NAME = 'demandes';
type ViewState = { search: string; status: string; page: number };

const STATUS_OPTIONS = [
  { value: 'pending', label: 'En attente (non closes)' },
  ...(Object.keys(REQUEST_STATUS_LABELS) as RequestStatus[]).map((value) => ({ value, label: REQUEST_STATUS_LABELS[value] })),
];

export default function DemandesPage() {
  const router = useRouter();
  const canCreate = usePermission('jobs.create');
  const { scope, setScope, apply } = useStoreScope('demandes');
  const storeParam = apply(new URLSearchParams()).get('store') ?? '';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ServiceRequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RequestsSummary | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.status !== undefined) setStatus(saved.status);
    if (saved.page) setPage(saved.page);
  });
  useEffect(() => {
    if (rehydrated) writeViewState(VIEW_NAME, { search, status, page });
  }, [rehydrated, search, status, page]);

  useEffect(() => {
    if (!rehydrated) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (status) params.set('status', status);
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/demandes?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Les demandes n’ont pas pu être chargées.'));
        return (await response.json()) as Paginated<ServiceRequestRow>;
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
        setError(caught instanceof Error ? caught.message : 'Les demandes n’ont pas pu être chargées.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [rehydrated, debouncedSearch, status, page, storeParam, reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ stats: '1' });
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/demandes?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { summary: RequestsSummary }) : null))
      .then((payload) => setSummary(payload?.summary ?? null))
      .catch(() => {});
    return () => controller.abort();
  }, [storeParam, reloadToken]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const showStore = scopeShowsStore(scope);

  const columns: Column<ServiceRequestRow>[] = useMemo(
    () => [
      {
        key: 'date',
        label: 'Date',
        render: (request) => <span className="tabular text-base-content/70">{formatDateShort(request.date)}</span>,
      },
      {
        key: 'reference',
        label: 'Demande',
        primary: true,
        render: (request) => (
          <div className="min-w-0 max-w-[22rem]">
            <Link
              href={`/chantiers/demandes/${request.id}`}
              className="font-semibold text-primary hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {request.reference}
            </Link>
            <span className="block truncate text-xs text-base-content/60" title={request.need}>
              {request.need}
            </span>
            <StoreTag name={request.storeName} show={showStore} />
          </div>
        ),
      },
      {
        key: 'customer',
        label: 'Client',
        render: (request) => (
          <div className="min-w-0 max-w-[13rem]">
            <span className="block truncate text-sm">{request.customerName}</span>
            {request.desiredDate && (
              <span className="block text-xs text-base-content/55">souhaité le {formatDateShort(request.desiredDate).split(' ').pop()}</span>
            )}
          </div>
        ),
      },
      {
        key: 'status',
        label: 'Statut',
        render: (request) => (
          <div className="flex flex-col items-start gap-1">
            <RequestStatusBadge status={request.status} />
            {request.jobReference ? (
              <span className="text-xs text-base-content/55">→ {request.jobReference}</span>
            ) : request.quoteReference ? (
              <span className="text-xs text-base-content/55">devis {request.quoteReference}</span>
            ) : null}
          </div>
        ),
      },
    ],
    [showStore],
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Chantiers"
        title="Demandes"
        description="Les besoins exprimés par les clients (appel, visite au magasin), suivis jusqu’au devis puis au chantier."
        actions={
          canCreate ? (
            <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsCreateOpen(true)}>
              Nouvelle demande
            </button>
          ) : undefined
        }
      />

      {!summary ? (
        <SkeletonCards count={4} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardDelta
            label="En attente"
            tooltip="Demandes pas encore closes : nouvelles, à l’étude, en visite, devis à préparer ou envoyé."
            tone="warning"
            value={formatNumber(summary.pending)}
            hint={`${formatNumber(summary.byStatus.new)} nouvelle(s)`}
          />
          <StatCardDelta
            label="Devis à préparer"
            tooltip="Demandes pour lesquelles le client attend un chiffrage."
            tone="primary"
            value={formatNumber(summary.byStatus.quote_to_prepare)}
            hint={`${formatNumber(summary.byStatus.quote_sent)} devis envoyé(s)`}
          />
          <StatCardDelta
            label="Converties en chantier"
            tooltip="Demandes dont le devis a été accepté puis transformé en chantier."
            tone="success"
            value={formatNumber(summary.byStatus.converted)}
            hint={`${formatNumber(summary.byStatus.accepted)} acceptée(s) en attente d’ouverture`}
          />
          <StatCardDelta
            label="Refusées"
            tooltip="Demandes abandonnées (client non intéressé, budget, hors de nos métiers…)."
            tone="neutral"
            value={formatNumber(summary.byStatus.refused)}
            hint={`${formatNumber(summary.total)} demande(s) au total`}
          />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un n°, un client, un besoin…"
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
            <div className="w-full sm:w-56">
              <FilterSelect
                value={status}
                onChange={(value) => {
                  setStatus(value);
                  setPage(1);
                }}
                options={STATUS_OPTIONS}
                placeholder="Toutes les demandes"
              />
            </div>
          </>
        }
      />

      {isLoading ? (
        <SkeletonTable rows={6} cols={4} />
      ) : error ? (
        <ErrorState title="Demandes indisponibles" description={error} onRetry={refresh} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={search || status ? 'Aucune demande trouvée' : 'Aucune demande'}
          description={search || status ? 'Aucune demande ne correspond à ces critères.' : 'Enregistrez ici chaque besoin exprimé par un client.'}
          action={
            canCreate && !search && !status ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsCreateOpen(true)}>
                Enregistrer une demande
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={columns}
            data={rows}
            getRowKey={(request) => request.id}
            onRowClick={(request) => router.push(`/chantiers/demandes/${request.id}`)}
            emptyMessage="Aucune demande."
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/50">
            {total} demande{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

      <RequestFormModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        request={null}
        onSaved={(saved) => router.push(`/chantiers/demandes/${saved.id}`)}
      />
    </div>
  );
}
