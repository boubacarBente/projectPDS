'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { DatePicker } from '@/components/date-picker';
import {
  EmptyState,
  ErrorState,
  MoneyText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { StoreScopeSelect, StoreTag, scopeShowsStore, useStoreScope } from '@/components/store-scope';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';
import {
  QuoteStatusBadge,
  readApiError,
  type Paginated,
  type QuoteRow,
  type QuotesSummary,
} from '@/components/prestations/shared';

/* ==================================================================
 * Devis de prestation (README §19.3, cahier « Prestations » §9).
 *
 * Le devis est un document **distinct** du chantier : il se prépare, s'envoie,
 * s'accepte ou se refuse, puis se convertit en chantier. « Expiré » n'est pas
 * un statut enregistré : un devis en attente dont la validité est dépassée.
 * ================================================================== */

const LIMIT = 20;
const VIEW_NAME = 'devis';

type ViewState = { search: string; status: string; from: string; to: string; page: number };

const STATUS_OPTIONS = [
  { value: 'pending', label: 'En attente de réponse' },
  { value: 'draft', label: 'Brouillons' },
  { value: 'sent', label: 'Envoyés' },
  { value: 'accepted', label: 'Acceptés' },
  { value: 'refused', label: 'Refusés' },
  { value: 'expired', label: 'Expirés' },
  { value: 'cancelled', label: 'Annulés' },
];

export default function DevisPage() {
  const router = useRouter();
  const canCreate = usePermission('jobs.create');
  const { scope, setScope, apply } = useStoreScope('devis');
  const storeParam = apply(new URLSearchParams()).get('store') ?? '';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<QuotesSummary | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

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
    if (saved.from !== undefined) setFrom(saved.from);
    if (saved.to !== undefined) setTo(saved.to);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, status, from, to, page });
  }, [rehydrated, search, status, from, to, page]);

  useEffect(() => {
    if (!rehydrated) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (status) params.set('status', status);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/devis?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Les devis n’ont pas pu être chargés.'));
        return (await response.json()) as Paginated<QuoteRow>;
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
        setError(caught instanceof Error ? caught.message : 'Les devis n’ont pas pu être chargés.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [rehydrated, debouncedSearch, status, from, to, page, storeParam, reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ stats: '1' });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/devis?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { summary: QuotesSummary }) : null))
      .then((payload) => setSummary(payload?.summary ?? null))
      .catch(() => {});
    return () => controller.abort();
  }, [from, to, storeParam, reloadToken]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const showStore = scopeShowsStore(scope);
  const activeFilters = [status, from, to].filter(Boolean).length;

  const columns: Column<QuoteRow>[] = useMemo(
    () => [
      {
        key: 'date',
        label: 'Date',
        render: (quote) => {
          const [day, date] = formatDateShort(quote.date).split(' ');
          return (
            <span className="block tabular text-base-content/70">
              <span className="block text-xs text-base-content/50">{day}</span>
              {date ?? day}
            </span>
          );
        },
      },
      {
        key: 'reference',
        label: 'Devis',
        primary: true,
        render: (quote) => (
          <div className="min-w-0 max-w-[18rem]">
            <Link
              href={`/chantiers/devis/${quote.id}`}
              className="font-semibold text-primary hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {quote.reference}
            </Link>
            {quote.title && <span className="block truncate text-xs text-base-content/60">{quote.title}</span>}
            <StoreTag name={quote.storeName} show={showStore} />
          </div>
        ),
      },
      {
        key: 'customer',
        label: 'Client',
        render: (quote) => (
          <div className="min-w-0 max-w-[13rem]">
            <span className="block truncate text-sm">{quote.customerName}</span>
            {quote.siteAddress && <span className="block truncate text-xs text-base-content/55">{quote.siteAddress}</span>}
          </div>
        ),
      },
      {
        key: 'status',
        label: 'Statut',
        render: (quote) => (
          <div className="flex flex-col items-start gap-1">
            <QuoteStatusBadge status={quote.displayStatus} />
            {quote.jobReference ? (
              <span className="text-xs text-base-content/55">→ {quote.jobReference}</span>
            ) : quote.validUntil && (quote.status === 'draft' || quote.status === 'sent') ? (
              <span className="text-xs text-base-content/55">valable jusqu’au {formatDateShort(quote.validUntil).split(' ').pop()}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'total',
        label: 'Montant',
        className: 'text-right whitespace-nowrap',
        render: (quote) => (
          <span className="block">
            <MoneyText value={quote.total} bold />
            <span className="block text-xs text-base-content/55">
              {quote.itemsCount} prestation{quote.itemsCount > 1 ? 's' : ''}
            </span>
          </span>
        ),
      },
    ],
    [showStore],
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Chantiers"
        title="Devis"
        description="Les propositions chiffrées envoyées aux clients, à partir du catalogue de prestations du magasin. Un devis accepté devient un chantier en un clic."
        actions={
          canCreate ? (
            <Link href="/chantiers/devis/nouveau" className="btn btn-primary min-h-11">
              Nouveau devis
            </Link>
          ) : undefined
        }
      />

      {!summary ? (
        <SkeletonCards count={4} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardDelta
            label="En attente de réponse"
            tooltip="Devis en brouillon ou envoyés, encore valables : le client n’a pas encore répondu. Le montant est ce qu’ils représentent au total."
            tone="info"
            value={<MoneyText value={summary.pendingAmount} />}
            hint={`${formatNumber(summary.pendingCount)} devis`}
          />
          <StatCardDelta
            label="Acceptés"
            tooltip="Montant total des devis acceptés par les clients sur la période."
            tone="success"
            value={<MoneyText value={summary.acceptedAmount} />}
            hint={`${formatNumber(summary.byStatus.accepted)} devis`}
          />
          <StatCardDelta
            label="Taux d’acceptation"
            tooltip="Sur les devis qui ont reçu une réponse (acceptés + refusés), la part acceptée."
            tone="primary"
            value={`${summary.acceptanceRate.toLocaleString('fr-FR')} %`}
            hint={`${formatNumber(summary.byStatus.refused)} refusé(s)`}
          />
          <StatCardDelta
            label="Expirés"
            tooltip="Devis restés sans réponse après leur date de validité. Relancez le client ou faites une nouvelle version au prix du jour."
            tone={summary.byStatus.expired > 0 ? 'warning' : 'neutral'}
            value={formatNumber(summary.byStatus.expired)}
            hint="À relancer"
          />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un n°, un client, un chantier…"
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
                placeholder="Tous les devis"
              />
            </div>
          </>
        }
        secondaryFilters={
          <>
            <DatePicker
              value={from}
              onChange={(value) => {
                setFrom(value);
                setPage(1);
              }}
              placeholder="Du"
            />
            <DatePicker
              value={to}
              onChange={(value) => {
                setTo(value);
                setPage(1);
              }}
              placeholder="Au"
            />
          </>
        }
        secondaryCount={[from, to].filter(Boolean).length}
      />

      {isLoading ? (
        <SkeletonTable rows={6} cols={5} />
      ) : error ? (
        <ErrorState title="Devis indisponibles" description={error} onRetry={refresh} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={search || activeFilters ? 'Aucun devis trouvé' : 'Aucun devis'}
          description={
            search || activeFilters
              ? 'Aucun devis ne correspond à ces critères.'
              : 'Établissez un premier devis à partir des prestations de votre catalogue.'
          }
          action={
            canCreate && !search && !activeFilters ? (
              <Link href="/chantiers/devis/nouveau" className="btn btn-primary min-h-11">
                Établir un devis
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={columns}
            data={rows}
            getRowKey={(quote) => quote.id}
            onRowClick={(quote) => router.push(`/chantiers/devis/${quote.id}`)}
            emptyMessage="Aucun devis."
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/50">
            {total} devis — page {page} sur {totalPages}
          </p>
        </>
      )}
    </div>
  );
}
