'use client';

/**
 * Soldes, dettes et bénéfices (README §10, §15 ; CONVENTIONS §5).
 *
 * Ordre imposé : `PageHeader` → cartes de synthèse → `DataToolbar` →
 * `ResponsiveTable` → `Pagination` → états. L'onglet porte un **état booléen**
 * par onglet (`showReceivablesSection` / `showPayablesSection` /
 * `showProfitabilitySection`) : jamais une modale ni une section pilotée par une
 * chaîne de « mode » (§8.3 règle 1).
 *
 * **Aucun montant n'est stocké** : tout vient de `GET /api/soldes`, qui les
 * recalcule à la lecture depuis les factures, les paiements et les dépenses.
 *
 * ⚠️ Ce composant **client** n'importe aucun module serveur à l'exécution
 * (§11 bis) : `lib/balances.ts` n'est présent que par `import type`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  MiniStat,
  MoneyText,
  PageSection,
  Skeleton,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import {
  MonthlyTrendSection,
  PayablesSection,
  ProductMarginsSection,
  ProfitResultSection,
  ReceivablesSection,
} from '@/components/soldes/soldes-sections';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import {
  DEFAULT_CURRENCY,
  endOfMonth,
  formatNumber,
  startOfMonth,
  startOfWeek,
  today,
} from '@/lib/format';
import type {
  BalancesSummary,
  ClientBalanceRow,
  PaginatedBalances,
  ProductMarginRow,
  SupplierBalanceRow,
} from '@/lib/balances';

const PAGE_LIMIT = 20;
const VIEW_NAME = 'soldes';

/* ------------------------------------------------------------------ *
 * Période — mêmes bornes que le tableau de bord
 * ------------------------------------------------------------------ */

type PeriodKey = 'day' | 'week' | 'month' | 'year' | 'total';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'day', label: "Aujourd'hui" },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'year', label: 'Année' },
  { key: 'total', label: 'Total' },
];

function isPeriodKey(value: unknown): value is PeriodKey {
  return value === 'day' || value === 'week' || value === 'month' || value === 'year' || value === 'total';
}

/** Bornes inclusives d'une période nommée, en dates métier `YYYY-MM-DD`. */
function periodRange(key: PeriodKey, reference = today()): { from: string; to: string } {
  switch (key) {
    case 'day':
      return { from: reference, to: reference };
    case 'week':
      return { from: startOfWeek(reference), to: reference };
    case 'month':
      return { from: startOfMonth(reference), to: endOfMonth(reference) };
    case 'year':
      return { from: `${reference.slice(0, 4)}-01-01`, to: `${reference.slice(0, 4)}-12-31` };
    case 'total':
    default:
      return { from: '1900-01-01', to: '2999-12-31' };
  }
}

/* ------------------------------------------------------------------ *
 * Onglets
 * ------------------------------------------------------------------ */

type Section = 'receivables' | 'payables' | 'profitability';

const SECTION_OPTIONS: { value: Section; label: string }[] = [
  { value: 'receivables', label: 'Clients' },
  { value: 'payables', label: 'Fournisseurs' },
  { value: 'profitability', label: 'Rentabilité' },
];

function isSection(value: unknown): value is Section {
  return value === 'receivables' || value === 'payables' || value === 'profitability';
}

type ViewState = {
  search: string;
  period: PeriodKey;
  section: Section;
  page: number;
};

/** Réponse exacte de `GET /api/soldes`. */
type SoldesPayload = {
  summary: BalancesSummary;
  clients: PaginatedBalances<ClientBalanceRow>;
  suppliers: PaginatedBalances<SupplierBalanceRow>;
  margins: ProductMarginRow[];
};

/** Message d'erreur lisible : jamais un code HTTP montré à l'utilisateur. */
async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // Corps non JSON : message de repli.
  }
  return fallback;
}

export default function SoldesPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [showReceivablesSection, setShowReceivablesSection] = useState(true);
  const [showPayablesSection, setShowPayablesSection] = useState(false);
  const [showProfitabilitySection, setShowProfitabilitySection] = useState(false);
  const [page, setPage] = useState(1);

  const [summary, setSummary] = useState<BalancesSummary | null>(null);
  const [clients, setClients] = useState<ClientBalanceRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierBalanceRow[]>([]);
  const [margins, setMargins] = useState<ProductMarginRow[]>([]);
  const [clientsTotalPages, setClientsTotalPages] = useState(1);
  const [suppliersTotalPages, setSuppliersTotalPages] = useState(1);
  const [clientsTotal, setClientsTotal] = useState(0);
  const [suppliersTotal, setSuppliersTotal] = useState(0);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const section: Section = showProfitabilitySection
    ? 'profitability'
    : showPayablesSection
      ? 'payables'
      : 'receivables';

  const currency = DEFAULT_CURRENCY;

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  /* Restauration d'état au retour arrière : un seul onglet ouvert à la fois. */
  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
    if (typeof saved.search === 'string') setSearch(saved.search);
    if (isPeriodKey(saved.period)) setPeriod(saved.period);
    if (typeof saved.page === 'number' && saved.page > 0) setPage(saved.page);
    if (isSection(saved.section)) {
      setShowReceivablesSection(saved.section === 'receivables');
      setShowPayablesSection(saved.section === 'payables');
      setShowProfitabilitySection(saved.section === 'profitability');
    }
  });

  /* Recherche débouncée à 300 ms — pas une requête par touche. */
  useEffect(() => {
    if (!rehydrated) return;
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search, rehydrated]);

  /* Mémorisation : même maille que la restauration (entrée d'historique). */
  useEffect(() => {
    if (!rehydrated) return;
    writeViewState<ViewState>(VIEW_NAME, { search, period, section, page });
  }, [rehydrated, search, period, section, page]);

  /* Chargement. Le premier fetch est **gaté** sur `rehydrated` : sans ce
     verrou, la page chargerait la page 1 puis rechargerait la page 3. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const range = periodRange(period);
        const params = new URLSearchParams({
          from: range.from,
          to: range.to,
          period,
          page: String(page),
          limit: String(PAGE_LIMIT),
        });
        if (debouncedSearch) params.set('search', debouncedSearch);
        // Les onglets « Créances » et « Dettes » ne montrent que les soldes
        // ouverts ; l'onglet Rentabilité n'a pas besoin de filtrer les listes.
        if (section === 'receivables') params.set('debtors', 'true');
        if (section === 'payables') params.set('creditors', 'true');

        const response = await fetch(`/api/soldes?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'Les soldes n’ont pas pu être chargés.'));
        }

        const payload = (await response.json()) as Partial<SoldesPayload>;
        if (!active) return;

        setSummary(payload.summary ?? null);
        setClients(Array.isArray(payload.clients?.data) ? payload.clients!.data : []);
        setSuppliers(Array.isArray(payload.suppliers?.data) ? payload.suppliers!.data : []);
        setMargins(Array.isArray(payload.margins) ? payload.margins : []);

        const clientPages = Math.max(1, Number(payload.clients?.totalPages ?? 1));
        const supplierPages = Math.max(1, Number(payload.suppliers?.totalPages ?? 1));

        setClientsTotalPages(clientPages);
        setSuppliersTotalPages(supplierPages);
        setClientsTotal(Number(payload.clients?.total ?? 0));
        setSuppliersTotal(Number(payload.suppliers?.total ?? 0));

        // Une page restaurée devenue hors bornes est corrigée (§ vue).
        const activePages = section === 'payables' ? supplierPages : clientPages;
        const corrected = clampPage(page, activePages);
        if (corrected !== null) setPage(corrected);

        setIsLoading(false);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setSummary(null);
        setClients([]);
        setSuppliers([]);
        setMargins([]);
        setError(caught instanceof Error ? caught.message : 'Les soldes n’ont pas pu être chargés.');
        setIsLoading(false);
      }
    }

    void load();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, debouncedSearch, period, section, page, refreshToken]);

  /* ------------------------------------------------------------------ *
   * Dérivés d'affichage
   * ------------------------------------------------------------------ */

  const hasFilters = Boolean(debouncedSearch);

  const periodLabel = useMemo(
    () => PERIODS.find((item) => item.key === period)?.label ?? 'Ce mois',
    [period],
  );

  const isPageEmpty = useMemo(() => {
    if (!summary) return false;
    return (
      summary.revenue === 0 &&
      summary.expenses === 0 &&
      summary.totalReceivables === 0 &&
      summary.totalPayables === 0
    );
  }, [summary]);

  const resetFilters = () => {
    setSearch('');
    setPage(1);
  };

  const openSection = (next: Section) => {
    setShowReceivablesSection(next === 'receivables');
    setShowPayablesSection(next === 'payables');
    setShowProfitabilitySection(next === 'profitability');
    setPage(1);
  };

  const handleManualRefresh = useCallback(() => {
    refresh();
    toast.success('Soldes actualisés.');
  }, [refresh]);

  const summaryCards = isLoading && !summary ? (
    <SkeletonCards count={4} />
  ) : (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCardDelta
        label="Créances clients"
        tone="warning"
        value={<MoneyText value={summary?.totalReceivables ?? 0} currency={currency} bold />}
        hint={`${formatNumber(summary?.debtorsCount ?? 0)} client(s) débiteur(s)`}
      />
      <StatCardDelta
        label="Dettes fournisseurs"
        tone="error"
        value={<MoneyText value={summary?.totalPayables ?? 0} currency={currency} bold />}
        hint={`${formatNumber(summary?.creditorsCount ?? 0)} fournisseur(s) à régler`}
      />
      <StatCardDelta
        label="Chiffre d'affaires"
        tone="primary"
        value={<MoneyText value={summary?.revenue ?? 0} currency={currency} bold />}
        hint={`Période : ${periodLabel.toLowerCase()}`}
      />
      <StatCardDelta
        label="Bénéfice net"
        tone={(summary?.netProfit ?? 0) >= 0 ? 'success' : 'error'}
        value={<MoneyText value={summary?.netProfit ?? 0} currency={currency} bold colored />}
        hint={`Marge brute ${
          summary ? `${summary.grossMarginPercent.toLocaleString('fr-FR')} %` : '—'
        }`}
      />
    </div>
  );

  const activeTotalPages = section === 'payables' ? suppliersTotalPages : clientsTotalPages;
  const activeTotal = section === 'payables' ? suppliersTotal : clientsTotal;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Pilotage"
        title="Soldes, dettes et bénéfices"
        description="Ce que les clients doivent, ce que l'entreprise doit, et ce que l'activité a réellement rapporté. Aucun montant n'est stocké : tout est recalculé à la lecture."
        actions={
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-base-200 bg-base-200/40 p-1">
            {PERIODS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setPeriod(item.key);
                  setPage(1);
                }}
                aria-pressed={period === item.key}
                className={`btn btn-sm min-h-11 sm:min-h-0 ${
                  period === item.key ? 'btn-primary' : 'btn-ghost'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      />

      {summaryCards}

      {/* Bascule d'onglets — état booléen par section, jamais un « mode ». */}
      <div
        role="tablist"
        aria-label="Sections des soldes"
        className="flex flex-wrap items-center gap-1 rounded-xl border border-base-200 bg-base-200/40 p-1"
      >
        {SECTION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={section === option.value}
            onClick={() => openSection(option.value)}
            className={`btn btn-sm min-h-11 sm:min-h-0 ${
              section === option.value ? 'btn-primary' : 'btn-ghost'
            }`}
          >
            {option.label}
            {option.value === 'receivables' && (summary?.debtorsCount ?? 0) > 0 && (
              <Badge tone="warning" className="ml-1">
                {formatNumber(summary?.debtorsCount ?? 0)}
              </Badge>
            )}
            {option.value === 'payables' && (summary?.creditorsCount ?? 0) > 0 && (
              <Badge tone="error" className="ml-1">
                {formatNumber(summary?.creditorsCount ?? 0)}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {section !== 'profitability' && (
        <>
          <DataToolbar
            search={search}
            onSearchChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            searchPlaceholder={
              section === 'receivables'
                ? 'Rechercher un client (nom, téléphone)…'
                : 'Rechercher un fournisseur (nom, téléphone)…'
            }
            filters={
              <div className="w-full sm:w-48">
                <FilterSelect
                  value={section}
                  onChange={(value) => openSection(isSection(value) ? value : 'receivables')}
                  options={SECTION_OPTIONS.filter((option) => option.value !== 'profitability')}
                  placeholder="Clients"
                />
              </div>
            }
            actions={
              <>
                {hasFilters && (
                  <ToolbarButton onClick={resetFilters} title="Revenir à la liste complète">
                    Effacer la recherche
                  </ToolbarButton>
                )}
                <ToolbarButton onClick={handleManualRefresh} title="Recalculer les soldes">
                  Actualiser
                </ToolbarButton>
              </>
            }
          />

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-base-content/60">
            <span>
              {isLoading
                ? 'Chargement…'
                : `${formatNumber(activeTotal)} ${
                    section === 'receivables' ? 'client(s)' : 'fournisseur(s)'
                  } avec un solde ouvert`}
            </span>
            <span>
              {periodLabel}
              {hasFilters ? ` · recherche « ${debouncedSearch} »` : ''}
            </span>
          </div>
        </>
      )}

      {/* ------------------------------ Les 5 états ----------------------------- */}
      {isLoading ? (
        section === 'profitability' ? (
          <div className="space-y-4">
            <SkeletonCards count={6} />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <SkeletonTable rows={6} cols={6} />
        )
      ) : error ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Impossible de charger les soldes"
            description={error}
            onRetry={refresh}
          />
        </div>
      ) : isPageEmpty ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <EmptyState
            title="Aucune activité enregistrée"
            description="Les soldes, les dettes et les bénéfices se calculent à partir des ventes, des achats, des paiements et des dépenses. Enregistrez une première opération pour les voir apparaître ici."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <a href="/ventes/nouvelle" className="btn btn-primary min-h-11 sm:min-h-0">
                  Nouvelle vente
                </a>
                <a href="/depenses" className="btn btn-ghost min-h-11 sm:min-h-0">
                  Enregistrer une dépense
                </a>
              </div>
            }
          />
        </div>
      ) : (
        <>
          {showReceivablesSection && (
            <PageSection
              title="Créances clients"
              subtitle="Solde d'un client = Σ factures − Σ paiements encaissés."
              actions={
                <Link
                  href="/clients"
                  className="btn btn-ghost btn-sm min-h-11 sm:min-h-0"
                >
                  Voir les clients
                </Link>
              }
            >
              <ReceivablesSection clients={clients} currency={currency} />
            </PageSection>
          )}

          {showPayablesSection && (
            <PageSection
              title="Dettes fournisseurs"
              subtitle="Solde d'un fournisseur = Σ achats − Σ paiements."
              actions={
                <Link
                  href="/fournisseurs"
                  className="btn btn-ghost btn-sm min-h-11 sm:min-h-0"
                >
                  Voir les fournisseurs
                </Link>
              }
            >
              <PayablesSection suppliers={suppliers} currency={currency} />
            </PageSection>
          )}

          {showProfitabilitySection && summary && (
            <>
              <PageSection
                title="Résultat de la période"
                subtitle={`Chiffre d'affaires, coût des marchandises, dépenses et main-d'œuvre — ${periodLabel.toLowerCase()}.`}
              >
                <Card>
                  <ProfitResultSection summary={summary} currency={currency} />
                </Card>
              </PageSection>

              <PageSection
                title="Produits les plus rentables"
                subtitle="Triés par marge cumulée ou par marge unitaire."
              >
                {margins.length === 0 ? (
                  <Card>
                    <EmptyState
                      title="Aucune marge à calculer"
                      description="Aucune vente de marchandise sur la période : la marge par produit apparaîtra dès la première facture."
                    />
                  </Card>
                ) : (
                  <ProductMarginsSection margins={margins} currency={currency} />
                )}
              </PageSection>

              <PageSection
                title="Tendance sur douze mois"
                subtitle="Chiffre d'affaires et dépenses par mois ; le coût d'achat n'y est pas ventilé."
              >
                <Card>
                  <MonthlyTrendSection months={summary.byMonth} currency={currency} />
                </Card>
              </PageSection>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MiniStat
                  label="CA ventes (HT)"
                  value={<MoneyText value={summary.revenueHt} currency={currency} />}
                  tone="primary"
                />
                <MiniStat
                  label="CA chantiers"
                  value={<MoneyText value={summary.jobsRevenue} currency={currency} />}
                  tone="info"
                />
                <MiniStat
                  label="Dépenses"
                  value={<MoneyText value={summary.expenses} currency={currency} />}
                  tone="warning"
                />
                <MiniStat
                  label="Bénéfice brut"
                  value={<MoneyText value={summary.grossProfit} currency={currency} />}
                  tone={summary.grossProfit >= 0 ? 'success' : 'error'}
                />
              </div>
            </>
          )}
        </>
      )}

      {section !== 'profitability' && (
        <Pagination currentPage={page} totalPages={activeTotalPages} onPageChange={setPage} />
      )}
    </div>
  );
}
