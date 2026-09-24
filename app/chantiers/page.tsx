'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable } from '@/components/responsive-table';
import { DatePicker } from '@/components/date-picker';
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
import { useViewStateRehydration, writeViewState, clampPage } from '@/lib/view-state';
import {
  JOB_CATEGORY_OPTIONS,
  JOB_STATUS_OPTIONS,
  QUOTE_STATUS_OPTIONS,
  JobFormModal,
  JobWorkersManagerButton,
  jobCategoryLabel,
  jobColumns,
  jobStatusLabel,
  quoteStatusLabel,
  readApiError,
  useJobSelectOptions,
  type JobsSummary,
  type Paginated,
  type ServiceJobRow,
} from '@/components/chantiers/chantiers-modals';

/* ==================================================================
 * Page « Chantiers » (README §19 — prestations de services).
 *
 * La prestation est un **document facturable autonome** : son total compte
 * dans le chiffre d'affaires, ses encaissements dans la caisse, mais elle ne
 * génère aucune facture de vente (§15). Cette page ne modifie jamais un
 * montant à la main : les totaux sont recalculés par `lib/jobs.ts`.
 *
 * Les 5 états obligatoires sont présents (chargement, vide, erreur, nominal,
 * feedback) ainsi que la restauration d'état au retour arrière.
 * ================================================================== */

const LIMIT = 20;
const VIEW_NAME = 'chantiers';

type ChantiersViewState = {
  search: string;
  category: string;
  status: string;
  quoteStatus: string;
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
  const canCreate = usePermission('jobs.create');

  /* Filtres */
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [quoteStatus, setQuoteStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  /* Données */
  const [jobs, setJobs] = useState<ServiceJobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [summary, setSummary] = useState<JobsSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryToken, setSummaryToken] = useState(0);

  /* Un état booléen par modale (§8.3 règle 1). */
  const [isDevisOpen, setIsDevisOpen] = useState(false);
  const [isPrestationOpen, setIsPrestationOpen] = useState(false);

  const { customers, isLoading: isOptionsLoading } = useJobSelectOptions(canCreate);

  /* Débounce de la recherche (§5) */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* Synthèse */
  useEffect(() => {
    const controller = new AbortController();
    setSummaryLoading(true);
    setSummaryError(null);

    const query = buildQuery({ stats: 1, from, to });

    fetch(`/api/chantiers?${query}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Synthèse indisponible.'));
        }
        return (await response.json()) as { summary: JobsSummary };
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setSummary(payload.summary);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setSummaryError(caught instanceof Error ? caught.message : 'Synthèse indisponible.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSummaryLoading(false);
      });

    return () => controller.abort();
  }, [from, to, summaryToken]);

  /* Liste */
  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    const query = buildQuery({
      search: debouncedSearch,
      category,
      status,
      quoteStatus,
      from,
      to,
      page,
      limit: LIMIT,
    });

    fetch(`/api/chantiers?${query}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Chargement des chantiers impossible.'));
        }
        return (await response.json()) as Paginated<ServiceJobRow>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
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
  }, [debouncedSearch, category, status, quoteStatus, from, to, page, reloadToken]);

  /* Restauration d'état au retour arrière (§5) */
  const rehydrated = useViewStateRehydration<ChantiersViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.category !== undefined) setCategory(saved.category);
    if (saved.status !== undefined) setStatus(saved.status);
    if (saved.quoteStatus !== undefined) setQuoteStatus(saved.quoteStatus);
    if (saved.from !== undefined) setFrom(saved.from);
    if (saved.to !== undefined) setTo(saved.to);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, category, status, quoteStatus, from, to, page });
  }, [rehydrated, search, category, status, quoteStatus, from, to, page]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
    setSummaryToken((token) => token + 1);
  }, []);

  const activeFilters = useMemo(
    () =>
      [category, status, quoteStatus, from, to].filter((value) => value !== '').length,
    [category, status, quoteStatus, from, to],
  );

  function resetFilters() {
    setSearch('');
    setCategory('');
    setStatus('');
    setQuoteStatus('');
    setFrom('');
    setTo('');
    setPage(1);
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Production"
        title="Chantiers"
        description="Devis et suivi des prestations : Alucobond, Staff, Placo, Meuble et Peinture — matériaux déduits du stock, équipes, coûts de revient et encaissements."
        actions={
          <>
            <JobWorkersManagerButton onChanged={refresh} />
            {canCreate && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost min-h-11 border border-base-300"
                  onClick={() => setIsDevisOpen(true)}
                >
                  Nouveau devis
                </button>
                <button
                  type="button"
                  className="btn btn-primary min-h-11"
                  onClick={() => setIsPrestationOpen(true)}
                >
                  Nouvelle prestation
                </button>
              </>
            )}
          </>
        }
      />

      {/* 2 · Cartes de synthèse */}
      {summaryLoading ? (
        <SkeletonCards count={4} />
      ) : summaryError ? (
        <ErrorState
          title="Synthèse indisponible"
          description={summaryError}
          onRetry={() => setSummaryToken((token) => token + 1)}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <StatCardDelta
            label="Chantiers"
            tone="primary"
            value={summary?.totalJobs ?? 0}
            hint={`${summary?.byStatus.in_progress ?? 0} en cours · ${summary?.byStatus.quote ?? 0} devis`}
          />
          <StatCardDelta
            label="CA des prestations"
            tone="success"
            value={<MoneyText value={summary?.billed ?? 0} />}
            hint="Hors chantiers annulés"
          />
          <StatCardDelta
            label="Coût de revient"
            tone="warning"
            value={<MoneyText value={summary?.totalCost ?? 0} />}
            hint="Matériaux + main-d’œuvre"
          />
          <StatCardDelta
            label="Marge"
            tone={(summary?.margin ?? 0) >= 0 ? 'success' : 'error'}
            value={<MoneyText value={summary?.margin ?? 0} />}
            hint={summary ? `${summary.marginPercent.toLocaleString('fr-FR')} % du CA` : undefined}
          />
          <StatCardDelta
            label="Encaissé"
            tone="info"
            value={<MoneyText value={summary?.collected ?? 0} />}
            hint="Reçus de prestation"
          />
          <StatCardDelta
            label="Reste à encaisser"
            tone={(summary?.outstanding ?? 0) > 0 ? 'error' : 'success'}
            value={<MoneyText value={summary?.outstanding ?? 0} />}
            hint="Créances sur chantiers"
          />
        </div>
      )}

      {/* 3 · Barre d'outils */}
      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher une référence, un client, un site…"
        filters={
          <FilterSelect
            value={category}
            onChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
            options={JOB_CATEGORY_OPTIONS}
            placeholder="Toutes les catégories"
          />
        }
        secondaryFilters={
          <>
            <FilterSelect
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={JOB_STATUS_OPTIONS}
              placeholder="Tous les statuts"
            />
            <FilterSelect
              value={quoteStatus}
              onChange={(value) => {
                setQuoteStatus(value);
                setPage(1);
              }}
              options={QUOTE_STATUS_OPTIONS}
              placeholder="Tous les devis"
            />
            <div className="space-y-1">
              <DatePicker
                value={from}
                onChange={(value) => {
                  setFrom(value);
                  setPage(1);
                }}
                placeholder="Du"
              />
            </div>
            <div className="space-y-1">
              <DatePicker
                value={to}
                onChange={(value) => {
                  setTo(value);
                  setPage(1);
                }}
                placeholder="Au"
              />
            </div>
          </>
        }
        secondaryCount={activeFilters}
      />

      {activeFilters > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/60">
          <span>Filtres actifs :</span>
          {category && <Badge tone="primary">{jobCategoryLabel(category)}</Badge>}
          {status && <Badge tone="info">{jobStatusLabel(status)}</Badge>}
          {quoteStatus && <Badge tone="info">{quoteStatusLabel(quoteStatus)}</Badge>}
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

      {/* 4 · Liste */}
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
              : 'Créez un premier devis pour suivre une prestation, ses matériaux et son équipe.'
          }
          action={
            activeFilters > 0 || search ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                Réinitialiser les filtres
              </button>
            ) : canCreate ? (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => setIsDevisOpen(true)}
              >
                Créer le premier devis
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={jobColumns}
            data={jobs}
            getRowKey={(job) => job.id}
            emptyMessage="Aucun chantier."
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/50">
            {total} chantier{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

      {/* 6 · Modales — une par état booléen */}
      <JobFormModal
        isOpen={isDevisOpen}
        onClose={() => setIsDevisOpen(false)}
        onSaved={() => {
          toast.success('Devis enregistré.');
          refresh();
        }}
        job={null}
        customers={customers}
        isOptionsLoading={isOptionsLoading}
        initial={{ status: 'quote', quoteStatus: 'draft' }}
      />

      <JobFormModal
        isOpen={isPrestationOpen}
        onClose={() => setIsPrestationOpen(false)}
        onSaved={() => {
          toast.success('Prestation enregistrée.');
          refresh();
        }}
        job={null}
        customers={customers}
        isOptionsLoading={isOptionsLoading}
        initial={{ status: 'pending', quoteStatus: 'accepted' }}
      />
    </div>
  );
}
