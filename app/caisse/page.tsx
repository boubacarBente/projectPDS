'use client';

/**
 * Caisse (README §8, §13 ; CONVENTIONS §5).
 *
 * Ordre imposé : `PageHeader` → bandeau d'état → cartes de synthèse →
 * `DataToolbar` → `ResponsiveTable` → `Pagination` → historique → modales.
 *
 * Deux invariants non négociables :
 *  1. **une seule session `open` à la fois** ; le solde disponible est le
 *     dernier `balance_after` de la session ouverte ;
 *  2. la **clôture journalière** compare un montant *théorique* calculé à un
 *     montant *compté* saisi et enregistre l'**écart** — il est affiché
 *     explicitement, jamais masqué.
 *
 * Tant qu'aucune session n'est ouverte, la page propose d'abord
 * « Ouvrir la caisse ».
 *
 * ⚠️ Ce composant **client** n'importe aucun module serveur à l'exécution
 * (§11 bis) : `lib/caisse.ts` n'apparaît que par `import type`, les données
 * passent par l'API.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  MiniStat,
  MoneyText,
  PageSection,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useSettings } from '@/app/parametres/page';
import {
  CashMovementModal,
  CloseCashSessionModal,
  OpenCashSessionModal,
  readApiError,
} from '@/components/caisse/caisse-modals';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { DEFAULT_CURRENCY, formatNumber } from '@/lib/format';
import { formatDateShort, formatDateTime } from '@/lib/date-format';
import type { CashMovementRow, CashSessionHistoryRow, CashSummary } from '@/lib/caisse';

const PAGE_LIMIT = 20;
const VIEW_NAME = 'caisse';

/* ------------------------------------------------------------------ *
 * Libellés d'origine — dupliqués volontairement côté client
 * ------------------------------------------------------------------ */

/**
 * `CASH_REFERENCE_LABELS` vit dans `lib/caisse.ts`, module **serveur** : un
 * composant client ne peut pas l'importer à l'exécution (§11 bis). Les libellés
 * sont donc réécrits ici, en français, à côté du lien vers la pièce d'origine.
 */
const REFERENCE_LABELS: Record<string, string> = {
  sale: 'Vente',
  payment: 'Encaissement',
  purchase: 'Achat',
  expense: 'Dépense',
  manual: 'Manuel',
};

type PaymentMethodSummary = CashSummary['byMethod'][number];

type ViewState = {
  search: string;
  type: string;
  paymentMethod: string;
  sessionId: string;
  from: string;
  to: string;
  page: number;
};

const TYPE_OPTIONS = [
  { value: '', label: 'Tous les mouvements' },
  { value: 'income', label: 'Entrées seulement' },
  { value: 'expense', label: 'Sorties seulement' },
];

/** Lien vers la pièce d'origine du mouvement (rapprochement caisse ↔ document). */
function referenceHref(referenceType: string | null, referenceId: number | null): string | null {
  if (!referenceId) return null;
  switch (referenceType) {
    case 'sale':
      return `/ventes/${referenceId}`;
    case 'purchase':
      return `/achats/${referenceId}`;
    case 'expense':
      return `/depenses`;
    case 'payment':
      return `/recus/${referenceId}`;
    default:
      return null;
  }
}

export default function CaissePage() {
  const { settings } = useSettings();
  const canOpen = usePermission('cash.open');
  const canClose = usePermission('cash.close');
  const canManual = usePermission('cash.manual');

  const currency = DEFAULT_CURRENCY;
  const paymentMethods = useMemo(
    () => settings.paymentMethods ?? ['Espèces', 'Mobile Money'],
    [settings.paymentMethods],
  );

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [type, setType] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const [movements, setMovements] = useState<CashMovementRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [summary, setSummary] = useState<CashSummary | null>(null);

  const [session, setSession] = useState<CashSessionHistoryRow | null>(null);
  const [history, setHistory] = useState<CashSessionHistoryRow[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  /* Un état booléen par modale (§8.3 règle 1) — jamais un « mode » en chaîne. */
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showMovementModal, setShowMovementModal] = useState(false);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
    if (typeof saved.search === 'string') setSearch(saved.search);
    if (typeof saved.type === 'string') setType(saved.type);
    if (typeof saved.paymentMethod === 'string') setPaymentMethod(saved.paymentMethod);
    if (typeof saved.sessionId === 'string') setSessionId(saved.sessionId);
    if (typeof saved.from === 'string') setFrom(saved.from);
    if (typeof saved.to === 'string') setTo(saved.to);
    if (typeof saved.page === 'number' && saved.page > 0) setPage(saved.page);
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
    writeViewState<ViewState>(VIEW_NAME, { search, type, paymentMethod, sessionId, from, to, page });
  }, [rehydrated, search, type, paymentMethod, sessionId, from, to, page]);

  /* Mouvements paginés + résumé de la session ouverte. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    async function loadMovements() {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(PAGE_LIMIT),
        });
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (type) params.set('type', type);
        if (paymentMethod) params.set('paymentMethod', paymentMethod);
        if (sessionId) params.set('sessionId', sessionId);
        if (from) params.set('from', from);
        if (to) params.set('to', to);

        const response = await fetch(`/api/caisse?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'Les mouvements de caisse n’ont pas pu être chargés.'));
        }

        const payload = (await response.json()) as {
          data?: CashMovementRow[];
          total?: number;
          totalPages?: number;
          summary?: CashSummary;
        };

        if (!active) return;

        const rows = Array.isArray(payload.data) ? payload.data : [];
        const pages = Math.max(1, Number(payload.totalPages ?? 1));

        setMovements(rows);
        setTotal(Number(payload.total ?? rows.length));
        setTotalPages(pages);
        if (payload.summary) setSummary(payload.summary);

        // Une page restaurée devenue hors bornes (clôture, filtres) est corrigée.
        const corrected = clampPage(page, pages);
        if (corrected !== null) setPage(corrected);

        setIsLoading(false);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setMovements([]);
        setTotal(0);
        setTotalPages(1);
        setError(
          caught instanceof Error
            ? caught.message
            : 'Les mouvements de caisse n’ont pas pu être chargés.',
        );
        setIsLoading(false);
      }
    }

    void loadMovements();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, debouncedSearch, type, paymentMethod, sessionId, from, to, page, refreshToken]);

  /* Session ouverte + historique des sessions. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    async function loadSessions() {
      try {
        const response = await fetch('/api/caisse/sessions', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'La session de caisse n’a pas pu être chargée.'));
        }

        const payload = (await response.json()) as {
          session?: CashSessionHistoryRow | null;
          history?: CashSessionHistoryRow[];
          summary?: CashSummary;
        };

        if (!active) return;

        setSession(payload.session ?? null);
        setHistory(Array.isArray(payload.history) ? payload.history : []);
        if (payload.summary) setSummary(payload.summary);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        // Les mouvements restent affichables : on ne remplace pas l'erreur de
        // liste par celle de la session.
        setSession(null);
        setHistory([]);
      }
    }

    void loadSessions();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, refreshToken]);

  /* ------------------------------------------------------------------ *
   * Dérivés
   * ------------------------------------------------------------------ */

  const hasFilters = Boolean(
    debouncedSearch || type || paymentMethod || sessionId || from || to,
  );

  const resetFilters = () => {
    setSearch('');
    setType('');
    setPaymentMethod('');
    setSessionId('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  const sessionOptions = useMemo(
    () =>
      history.map((row) => ({
        value: String(row.id),
        label: `Session #${row.id} — ${row.openedAt ? formatDateShort(row.openedAt) : '—'}${
          row.status === 'open' ? ' (ouverte)' : ''
        }`,
      })),
    [history],
  );

  const paymentOptions = useMemo(
    () => paymentMethods.map((item) => ({ value: item, label: item })),
    [paymentMethods],
  );

  const columns = useMemo<Column<CashMovementRow>[]>(
    () => [
      {
        key: 'date',
        label: 'Date',
        render: (movement) => (
          <span className="whitespace-nowrap text-sm">{formatDateShort(movement.date)}</span>
        ),
      },
      {
        key: 'type',
        label: 'Type',
        render: (movement) =>
          movement.type === 'income' ? (
            <Badge tone="success">Entrée</Badge>
          ) : (
            <Badge tone="error">Sortie</Badge>
          ),
      },
      {
        key: 'motif',
        label: 'Motif',
        primary: true,
        render: (movement) => <span className="font-medium">{movement.motif}</span>,
      },
      {
        key: 'paymentMethod',
        label: 'Moyen',
        render: (movement) => <Badge tone="neutral">{movement.paymentMethod}</Badge>,
      },
      {
        key: 'amount',
        label: 'Montant',
        className: 'text-right',
        render: (movement) => {
          const signed = movement.type === 'income' ? movement.amount : -movement.amount;
          return (
            <span className="whitespace-nowrap">
              <span className={`tabular font-semibold ${movement.type === 'income' ? 'text-success' : 'text-error'}`}>
                {movement.type === 'income' ? '+' : '−'}
              </span>{' '}
              <MoneyText value={Math.abs(signed)} currency={currency} bold />
            </span>
          );
        },
      },
      {
        key: 'origin',
        label: 'Origine',
        render: (movement) => {
          const label = movement.referenceType
            ? REFERENCE_LABELS[movement.referenceType] ?? movement.referenceType
            : '—';
          const href = referenceHref(movement.referenceType, movement.referenceId);

          if (!href) return <span className="text-sm text-base-content/70">{label}</span>;

          return (
            <Link href={href} className="text-sm text-primary hover:underline">
              {label} #{movement.referenceId}
            </Link>
          );
        },
      },
      {
        key: 'balanceAfter',
        label: 'Solde après',
        className: 'text-right',
        hideOnMobile: true,
        render: (movement) => <MoneyText value={movement.balanceAfter} currency={currency} />,
      },
      {
        key: 'userName',
        label: 'Utilisateur',
        hideOnMobile: true,
        render: (movement) => (
          <span className="text-sm text-base-content/70">{movement.userName || '—'}</span>
        ),
      },
    ],
    [currency],
  );

  const sessionColumns = useMemo<Column<CashSessionHistoryRow>[]>(
    () => [
      {
        key: 'openedAt',
        label: 'Ouverture',
        primary: true,
        render: (row) => (
          <span className="whitespace-nowrap text-sm">
            {row.openedAt ? formatDateTime(row.openedAt) : '—'}
          </span>
        ),
      },
      {
        key: 'closedAt',
        label: 'Clôture',
        render: (row) => (
          <span className="whitespace-nowrap text-sm">
            {row.closedAt ? formatDateTime(row.closedAt) : '—'}
          </span>
        ),
      },
      {
        key: 'openingAmount',
        label: 'Ouverture (GNF)',
        className: 'text-right',
        render: (row) => <MoneyText value={row.openingAmount} currency={currency} />,
      },
      {
        key: 'theoreticalAmount',
        label: 'Théorique',
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => <MoneyText value={row.theoreticalAmount ?? 0} currency={currency} />,
      },
      {
        key: 'countedAmount',
        label: 'Compté',
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => <MoneyText value={row.countedAmount ?? 0} currency={currency} />,
      },
      {
        key: 'difference',
        label: 'Écart',
        className: 'text-right',
        render: (row) => {
          if (row.difference == null) return <span className="text-sm">—</span>;
          const rounded = Math.round(row.difference * 100) / 100;
          return (
            <span className="inline-flex flex-col items-end gap-0.5">
              <MoneyText value={rounded} currency={currency} colored bold />
              <Badge tone={rounded === 0 ? 'success' : 'warning'}>
                {rounded === 0 ? 'Écart nul' : rounded > 0 ? 'Excédent' : 'Manquant'}
              </Badge>
            </span>
          );
        },
      },
      {
        key: 'movementsCount',
        label: 'Mouvements',
        className: 'text-right',
        render: (row) => <span className="tabular">{formatNumber(row.movementsCount)}</span>,
      },
      {
        key: 'users',
        label: 'Utilisateurs',
        hideOnMobile: true,
        render: (row) => (
          <span className="text-sm text-base-content/70">
            {row.openedByName || '—'}
            {row.closedByName ? ` → ${row.closedByName}` : ''}
          </span>
        ),
      },
    ],
    [currency],
  );

  const sessionOpen = Boolean(session && session.status === 'open');

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Finances"
        title="Caisse"
        description="Ouverture, entrées et sorties, répartition Espèces / Mobile Money et clôture journalière avec écart."
        actions={
          <>
            {sessionOpen && canClose && (
              <button
                type="button"
                className="btn btn-ghost min-h-11 sm:min-h-0"
                onClick={() => setShowCloseModal(true)}
              >
                Clôturer la caisse
              </button>
            )}
            {!sessionOpen && canOpen && (
              <button
                type="button"
                className="btn btn-primary min-h-11 sm:min-h-0"
                onClick={() => setShowOpenModal(true)}
              >
                Ouvrir la caisse
              </button>
            )}
            {canManual && (
              <button
                type="button"
                className="btn btn-outline min-h-11 sm:min-h-0"
                onClick={() => setShowMovementModal(true)}
              >
                Mouvement manuel
              </button>
            )}
          </>
        }
      />

      {/* ------------------------------ Bandeau d'état ------------------------- */}
      <div
        className={`rounded-2xl border p-4 shadow-sm sm:p-5 ${
          sessionOpen
            ? 'border-success/30 bg-success/10'
            : 'border-warning/30 bg-warning/10'
        }`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                sessionOpen ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                />
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold">
                {sessionOpen
                  ? `Caisse ouverte — session #${session?.id}`
                  : 'Aucune session de caisse ouverte'}
              </p>
              <p className="mt-0.5 text-xs text-base-content/60">
                {sessionOpen
                  ? `Depuis le ${session?.openedAt ? formatDateTime(session.openedAt) : '—'} par ${
                      session?.openedByName || '—'
                    } · montant d'ouverture ${formatNumber(session?.openingAmount ?? 0)} ${currency}`
                  : 'Tant qu’aucune session n’est ouverte, les encaissements restent hors du suivi de caisse : ouvrez-la pour commencer la journée.'}
              </p>
            </div>
          </div>

          {!sessionOpen && canOpen && (
            <button
              type="button"
              className="btn btn-primary min-h-11"
              onClick={() => setShowOpenModal(true)}
            >
              Ouvrir la caisse
            </button>
          )}
        </div>
      </div>

      {/* ----------------------------- Synthèse -------------------------------- */}
      {isLoading && !summary ? (
        <SkeletonCards count={4} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardDelta
            label="Solde disponible"
            tone={sessionOpen ? 'success' : 'neutral'}
            value={<MoneyText value={summary?.balance ?? 0} currency={currency} bold />}
            hint={sessionOpen ? 'Dernier solde de la session ouverte' : 'Dernier solde connu'}
          />
          <StatCardDelta
            label="Entrées de la session"
            tone="success"
            value={<MoneyText value={summary?.incomeTotal ?? 0} currency={currency} />}
            hint={`${formatNumber(summary?.movementsCount ?? 0)} mouvement(s)`}
          />
          <StatCardDelta
            label="Sorties de la session"
            tone="error"
            value={<MoneyText value={summary?.expenseTotal ?? 0} currency={currency} />}
            hint="Dépenses, achats et retraits"
          />
          <StatCardDelta
            label="Résultat de la session"
            tone={(summary?.incomeTotal ?? 0) - (summary?.expenseTotal ?? 0) >= 0 ? 'success' : 'error'}
            value={
              <MoneyText
                value={(summary?.incomeTotal ?? 0) - (summary?.expenseTotal ?? 0)}
                currency={currency}
                colored
                bold
              />
            }
            hint="Entrées − sorties"
          />
        </div>
      )}

      {/* ------------------------ Espèces / Mobile Money ----------------------- */}
      <PageSection
        title="Répartition par moyen de paiement"
        subtitle="Chaque mouvement porte son moyen : la répartition est calculée, jamais saisie."
      >
        {isLoading && !summary ? (
          <SkeletonCards count={2} />
        ) : (
          <Card>
            {(summary?.byMethod?.length ?? 0) === 0 ? (
              <p className="py-2 text-sm text-base-content/60">
                Aucun mouvement sur la session en cours.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {(summary?.byMethod ?? []).map((method: PaymentMethodSummary) => (
                  <div key={method.method} className="rounded-xl border border-base-200 bg-base-200/30 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone="neutral">{method.method}</Badge>
                      <MoneyText value={method.net} currency={currency} colored bold />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <MiniStat
                        label="Entrées"
                        value={<MoneyText value={method.income} currency={currency} />}
                        tone="success"
                      />
                      <MiniStat
                        label="Sorties"
                        value={<MoneyText value={method.expense} currency={currency} />}
                        tone="error"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </PageSection>

      {/* ------------------------------ Mouvements ----------------------------- */}
      <PageSection
        title="Mouvements de caisse"
        subtitle="Chaque mouvement porte son origine : le rapprochement caisse ↔ vente ↔ dépense reste possible."
      >
        <DataToolbar
          search={search}
          onSearchChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          searchPlaceholder="Rechercher un motif…"
          filters={
            <>
              <div className="w-full sm:w-44">
                <FilterSelect
                  value={type}
                  onChange={(value) => {
                    setType(value);
                    setPage(1);
                  }}
                  options={TYPE_OPTIONS}
                  placeholder="Tous les mouvements"
                />
              </div>
              <div className="w-full sm:w-44">
                <FilterSelect
                  value={paymentMethod}
                  onChange={(value) => {
                    setPaymentMethod(value);
                    setPage(1);
                  }}
                  options={paymentOptions}
                  placeholder="Tous les moyens"
                />
              </div>
            </>
          }
          secondaryFilters={
            <div className="w-full space-y-3">
              <div className="w-full sm:w-72">
                <span className="mb-1 block text-xs text-base-content/60">Session</span>
                <FilterSelect
                  value={sessionId}
                  onChange={(value) => {
                    setSessionId(value);
                    setPage(1);
                  }}
                  options={sessionOptions}
                  placeholder="Toutes les sessions"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:w-96 sm:grid-cols-2">
                <div>
                  <span className="mb-1 block text-xs text-base-content/60">Du</span>
                  <DatePicker
                    value={from}
                    onChange={(value) => {
                      setFrom(value);
                      setPage(1);
                    }}
                    placeholder="jj/mm/aaaa"
                  />
                </div>
                <div>
                  <span className="mb-1 block text-xs text-base-content/60">Au</span>
                  <DatePicker
                    value={to}
                    onChange={(value) => {
                      setTo(value);
                      setPage(1);
                    }}
                    placeholder="jj/mm/aaaa"
                  />
                </div>
              </div>
            </div>
          }
          secondaryCount={(sessionId ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0)}
          actions={
            <>
              {hasFilters && (
                <ToolbarButton onClick={resetFilters} title="Revenir à tous les mouvements">
                  Effacer les filtres
                </ToolbarButton>
              )}
              <ToolbarButton onClick={refresh} title="Recharger la caisse">
                Actualiser
              </ToolbarButton>
            </>
          }
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-base-content/60">
          <span>
            {isLoading
              ? 'Chargement…'
              : `${formatNumber(total)} mouvement${total > 1 ? 's' : ''} ${
                  total > 1 ? 'trouvés' : 'trouvé'
                }`}
          </span>
          {(from || to) && (
            <span>
              Période : {from ? formatDateShort(from) : 'origine'} →{' '}
              {to ? formatDateShort(to) : 'aujourd’hui'}
            </span>
          )}
        </div>

        <div className="mt-4">
          {isLoading ? (
            <SkeletonTable rows={6} cols={6} />
          ) : error ? (
            <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
              <ErrorState
                title="Impossible de charger les mouvements"
                description={error}
                onRetry={refresh}
              />
            </div>
          ) : movements.length === 0 ? (
            <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
              <EmptyState
                title={hasFilters ? 'Aucun mouvement ne correspond' : 'Aucun mouvement de caisse'}
                description={
                  hasFilters
                    ? 'Élargissez la période ou retirez un filtre pour retrouver les mouvements.'
                    : sessionOpen
                      ? 'La session est ouverte : enregistrez un mouvement manuel ou encaissez une vente.'
                      : 'Ouvrez la caisse pour commencer la journée, puis enregistrez les entrées et les sorties.'
                }
                action={
                  hasFilters ? (
                    <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                      Réinitialiser les filtres
                    </button>
                  ) : !sessionOpen && canOpen ? (
                    <button
                      type="button"
                      className="btn btn-primary min-h-11"
                      onClick={() => setShowOpenModal(true)}
                    >
                      Ouvrir la caisse
                    </button>
                  ) : canManual ? (
                    <button
                      type="button"
                      className="btn btn-primary min-h-11"
                      onClick={() => setShowMovementModal(true)}
                    >
                      Enregistrer un mouvement
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="surface-card overflow-hidden border border-base-200 bg-base-100 shadow-sm">
              <ResponsiveTable
                columns={columns}
                data={movements}
                getRowKey={(movement) => movement.id}
              />
            </div>
          )}
        </div>

        <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
      </PageSection>

      {/* -------------------------- Historique des sessions -------------------- */}
      <PageSection
        title="Historique des sessions"
        subtitle="Ouverture, montants théorique et compté, écart de clôture."
      >
        <details className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <summary className="cursor-pointer list-none px-5 py-4 text-sm font-medium">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {history.length === 0
                  ? 'Aucune session enregistrée'
                  : `${formatNumber(history.length)} session${history.length > 1 ? 's' : ''} — afficher le détail`}
              </span>
              <span className="text-xs text-base-content/50">Cliquer pour replier / déplier</span>
            </span>
          </summary>

          <div className="border-t border-base-200">
            {history.length === 0 ? (
              <EmptyState
                title="Aucune session de caisse"
                description="L’historique se remplira à la première ouverture de caisse."
              />
            ) : (
              <ResponsiveTable
                columns={sessionColumns}
                data={history}
                getRowKey={(row) => row.id}
                emptyMessage="Aucune session enregistrée."
              />
            )}
          </div>
        </details>
      </PageSection>

      {/* -------------------------------- Modales ------------------------------ */}
      <OpenCashSessionModal
        isOpen={showOpenModal}
        onClose={() => setShowOpenModal(false)}
        onSaved={refresh}
      />

      <CloseCashSessionModal
        isOpen={showCloseModal}
        onClose={() => setShowCloseModal(false)}
        session={
          session
            ? {
                id: session.id,
                status: session.status,
                openedAt: session.openedAt,
                openedBy: session.openedBy,
                openingAmount: session.openingAmount,
                closedAt: session.closedAt,
                closedBy: session.closedBy,
                /**
                 * Montant **théorique** d'une session ouverte = dernier
                 * `balance_after` de la session, donc `summary.balance`.
                 * `session.theoreticalAmount` ne porte, tant que la session est
                 * ouverte, que le montant d'ouverture : la valeur définitive
                 * n'est écrite qu'à la clôture (`closeSession`). Il ne sert donc
                 * que de repli si le résumé n'a pas pu être chargé.
                 */
                theoreticalAmount: summary?.balance ?? session.theoreticalAmount ?? 0,
                countedAmount: session.countedAmount,
                difference: session.difference,
                notes: session.notes,
              }
            : null
        }
        onSaved={refresh}
      />

      <CashMovementModal
        isOpen={showMovementModal}
        onClose={() => setShowMovementModal(false)}
        paymentMethods={paymentMethods}
        onSaved={refresh}
      />
    </div>
  );
}
