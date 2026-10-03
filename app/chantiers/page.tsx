'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable } from '@/components/responsive-table';
import { DatePicker } from '@/components/date-picker';
import { Badge, EmptyState, ErrorState, MoneyText, SkeletonCards, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useSettings } from '@/app/parametres/page';
import { StoreScopeSelect, scopeShowsStore, useStoreScope } from '@/components/store-scope';
import { useViewStateRehydration, writeViewState, clampPage } from '@/lib/view-state';
import { formatNumber } from '@/lib/format';
import {
  jobCategoryOptions,
  JOB_STATUS_OPTIONS,
  JobFormModal,
  jobCategoryLabel,
  buildJobColumns,
  jobStatusLabel,
  readApiError,
  type JobsSummary,
  type Paginated,
  type ServiceJobRow,
} from '@/components/chantiers/chantiers-modals';

/* ==================================================================
 * Page « Chantiers » (README §19, cahier « Prestations » §6).
 *
 * Les travaux réellement réalisés pour un client : ouverts depuis un devis
 * accepté (cas normal) ou directement. Le devis vit désormais à part
 * (/chantiers/devis) ; cette liste ne montre que des chantiers.
 *
 * Le montant facturé vient des prestations ; coûts et marge sont calculés par
 * le serveur et ne sont renvoyés qu'à qui détient `balances.view`.
 * ================================================================== */

const LIMIT = 20;
const VIEW_NAME = 'chantiers';

type ChantiersViewState = {
  search: string;
  category: string;
  status: string;
  late: boolean;
  from: string;
  to: string;
  page: number;
};

function buildQuery(entries: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export default function ChantiersPage() {
  const router = useRouter();
  const canCreate = usePermission('jobs.create');
  const { settings } = useSettings();
  const { scope, setScope, apply } = useStoreScope('chantiers');
  const storeParam = apply(new URLSearchParams()).get('store') ?? undefined;

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [late, setLate] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const [jobs, setJobs] = useState<ServiceJobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [summary, setSummary] = useState<JobsSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const rehydrated = useViewStateRehydration<ChantiersViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.category !== undefined) setCategory(saved.category);
    if (saved.status !== undefined) setStatus(saved.status);
    if (saved.late !== undefined) setLate(Boolean(saved.late));
    if (saved.from !== undefined) setFrom(saved.from);
    if (saved.to !== undefined) setTo(saved.to);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, category, status, late, from, to, page });
  }, [rehydrated, search, category, status, late, from, to, page]);

  /* Synthèse */
  useEffect(() => {
    const controller = new AbortController();
    setSummaryError(null);
    fetch(`/api/chantiers?${buildQuery({ stats: 1, from, to, category, store: storeParam })}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Synthèse indisponible.'));
        return (await response.json()) as { summary: JobsSummary };
      })
      .then((payload) => setSummary(payload.summary))
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setSummaryError(caught instanceof Error ? caught.message : 'Synthèse indisponible.');
      });
    return () => controller.abort();
  }, [from, to, category, storeParam, reloadToken]);

  /* Liste */
  useEffect(() => {
    if (!rehydrated) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const query = buildQuery({
      search: debouncedSearch,
      category,
      status,
      late: late ? 1 : undefined,
      from,
      to,
      page,
      limit: LIMIT,
      store: storeParam,
    });
    fetch(`/api/chantiers?${query}`, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Chargement des chantiers impossible.'));
        return (await response.json()) as Paginated<ServiceJobRow>;
      })
      .then((payload) => {
        setJobs(Array.isArray(payload.data) ? payload.data : []);
        setTotal(Number(payload.total ?? 0));
        const pages = Number(payload.totalPages ?? 1) || 1;
        setTotalPages(pages);
        const corrected = clampPage(page, pages);
        if (corrected !== null) setPage(corrected);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Chargement des chantiers impossible.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [rehydrated, debouncedSearch, category, status, late, from, to, page, reloadToken, storeParam]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const activeFilters = useMemo(
    () => [category, status, from, to].filter((value) => value !== '').length + (late ? 1 : 0),
    [category, status, late, from, to],
  );

  function resetFilters() {
    setSearch('');
    setCategory('');
    setStatus('');
    setLate(false);
    setFrom('');
    setTo('');
    setPage(1);
  }

  const open = summary ? summary.byStatus.pending + summary.byStatus.planned + summary.byStatus.in_progress + summary.byStatus.suspended : 0;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Chantiers"
        title="Chantiers"
        description="Les travaux réalisés pour les clients : prestations facturées, avancement, équipe, dépenses et encaissements. Un devis accepté ouvre son chantier."
        actions={
          canCreate ? (
            <>
              <Link href="/chantiers/devis/nouveau" className="btn btn-ghost min-h-11 border border-base-300">
                Nouveau devis
              </Link>
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsCreateOpen(true)}>
                Nouveau chantier
              </button>
            </>
          ) : undefined
        }
      />

      {summaryError ? (
        <ErrorState title="Synthèse indisponible" description={summaryError} onRetry={refresh} />
      ) : !summary ? (
        <SkeletonCards count={4} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <StatCardDelta
            label="Chantiers ouverts"
            tooltip="Chantiers en préparation, planifiés, en cours ou suspendus, sur la période et les magasins choisis."
            tone="primary"
            value={formatNumber(open)}
            hint={`${formatNumber(summary.byStatus.in_progress)} en cours · ${formatNumber(summary.byStatus.completed)} terminé(s)`}
          />
          <StatCardDelta
            label="En retard"
            tooltip="Chantiers non terminés dont la date de fin prévue est dépassée. Cliquez sur le filtre « En retard » pour les voir."
            tone={summary.late > 0 ? 'error' : 'success'}
            value={formatNumber(summary.late)}
            hint={summary.late > 0 ? 'À relancer ou replanifier' : 'Aucun retard'}
          />
          <StatCardDelta
            label="Montant des chantiers"
            tooltip="Total facturé aux clients pour les chantiers (prestations), hors chantiers annulés."
            tone="success"
            value={<MoneyText value={summary.billed} />}
            hint="Hors annulés"
          />
          <StatCardDelta
            label="Encaissé"
            tooltip="Argent réellement reçu des clients pour ces chantiers (acomptes et paiements)."
            tone="info"
            value={<MoneyText value={summary.collected} />}
            hint="Reçus de chantier"
          />
          <StatCardDelta
            label="Reste à encaisser"
            tooltip="Ce que les clients doivent encore : montant des chantiers moins ce qui a été encaissé."
            tone={summary.outstanding > 0 ? 'error' : 'success'}
            value={<MoneyText value={summary.outstanding} remaining bold />}
            hint="Créances sur chantiers"
          />
          {summary.margin !== null ? (
            <StatCardDelta
              label="Bénéfice estimatif"
              tooltip="Montant des chantiers moins leurs coûts : matériaux au prix d’achat, main-d’œuvre, sous-traitance convenue et dépenses rattachées."
              tone={summary.margin >= 0 ? 'success' : 'error'}
              value={<MoneyText value={summary.margin} colored />}
              hint={summary.marginPercent !== null ? `${summary.marginPercent.toLocaleString('fr-FR')} % du montant` : undefined}
            />
          ) : (
            <StatCardDelta
              label="Terminés"
              tooltip="Chantiers terminés sur la période."
              tone="success"
              value={formatNumber(summary.byStatus.completed)}
              hint={`${formatNumber(summary.byStatus.cancelled)} annulé(s)`}
            />
          )}
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher une référence, un client, un site…"
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
                value={status}
                onChange={(value) => {
                  setStatus(value);
                  setPage(1);
                }}
                options={JOB_STATUS_OPTIONS}
                placeholder="Tous les statuts"
              />
            </div>
            <button
              type="button"
              aria-pressed={late}
              className={`btn min-h-11 w-full sm:w-auto ${late ? 'btn-error' : 'btn-ghost border border-base-300'}`}
              onClick={() => {
                setLate((value) => !value);
                setPage(1);
              }}
            >
              En retard{summary && summary.late > 0 ? ` (${summary.late})` : ''}
            </button>
          </>
        }
        secondaryFilters={
          <>
            <FilterSelect
              value={category}
              onChange={(value) => {
                setCategory(value);
                setPage(1);
              }}
              options={jobCategoryOptions(settings.jobCategories ?? [])}
              placeholder="Tous les types"
            />
            <DatePicker
              value={from}
              onChange={(value) => {
                setFrom(value);
                setPage(1);
              }}
              placeholder="Début à partir du"
            />
            <DatePicker
              value={to}
              onChange={(value) => {
                setTo(value);
                setPage(1);
              }}
              placeholder="Jusqu’au"
            />
          </>
        }
        secondaryCount={[category, from, to].filter(Boolean).length}
      />

      {activeFilters > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/60">
          <span>Filtres actifs :</span>
          {status && <Badge tone="info">{status === 'open' ? 'Ouverts' : jobStatusLabel(status)}</Badge>}
          {late && <Badge tone="error">En retard</Badge>}
          {category && <Badge tone="primary">{jobCategoryLabel(category)}</Badge>}
          {(from || to) && (
            <Badge tone="neutral">
              {from || '…'} → {to || '…'}
            </Badge>
          )}
          <button type="button" className="btn btn-ghost btn-xs min-h-11" onClick={resetFilters}>
            Réinitialiser
          </button>
        </div>
      )}

      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <ErrorState title="Chantiers indisponibles" description={error} onRetry={refresh} />
      ) : jobs.length === 0 ? (
        <EmptyState
          title="Aucun chantier"
          description={
            activeFilters > 0 || search
              ? 'Aucun chantier ne correspond à ces filtres.'
              : 'Un chantier s’ouvre depuis un devis accepté, ou directement pour des travaux sans devis.'
          }
          action={
            activeFilters > 0 || search ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                Réinitialiser les filtres
              </button>
            ) : canCreate ? (
              <Link href="/chantiers/devis/nouveau" className="btn btn-primary min-h-11">
                Établir un devis
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={buildJobColumns({ showStore: scopeShowsStore(scope) })}
            data={jobs}
            getRowKey={(job) => job.id}
            onRowClick={(job) => router.push(`/chantiers/${job.id}`)}
            emptyMessage="Aucun chantier."
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/50">
            {total} chantier{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

      <JobFormModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} job={null} onSaved={(job) => router.push(`/chantiers/${job.id}`)} />
    </div>
  );
}
