'use client';

/**
 * Page Dépenses (README §7.9, §9, §14 ; CONVENTIONS §5).
 *
 * Ordre imposé : `PageHeader` → cartes de synthèse → `DataToolbar` →
 * `ResponsiveTable` → `Pagination` → modales (une par état booléen).
 *
 * Rappel de la distinction qui structure tout l'écran (§14) : une **dépense**
 * est un frais de fonctionnement (transport, loyer, salaire, carburant,
 * électricité…). Elle **sort de la caisse** et **ne touche jamais le stock** —
 * contrairement à un achat, qui fait entrer de la marchandise et suit une dette
 * fournisseur. Aucun écran de ce module ne parle de stock.
 *
 * La **catégorie** est une liste fermée (`settings.expenseCategories`, §6.6) :
 * la page renvoie donc vers `/parametres` pour la gérer, et n'offre aucune
 * saisie libre.
 *
 * **Circuit d'approbation** (cahier multi-magasins §12) : au-delà du seuil
 * `expenseApprovalThreshold`, une dépense saisie par un autre que
 * l'administrateur général est « en attente » ; un responsable (jamais son
 * auteur) l'approuve — elle devient « à décaisser » — ou la rejette. Seules les
 * dépenses décaissées sortent de la caisse et comptent dans les résultats.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { IconAction, RowActions } from '@/components/row-actions';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { DatePicker } from '@/components/date-picker';
import { Tooltip } from '@/components/tooltip';
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
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/design-system';
import { StoreScopeSelect, useStoreScope } from '@/components/store-scope';
import { useSettings } from '@/app/parametres/page';
import {
  CancelExpenseModal,
  ExpenseFormModal,
  readApiError,
} from '@/components/depenses/depenses-modals';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatCurrency, formatNumber, startOfMonth, startOfWeek, today } from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';
import type { ExpenseRow, ExpensesSummary } from '@/lib/expenses';

const PAGE_LIMIT = 20;
const VIEW_NAME = 'depenses';

/** Raccourcis de période : bornes inclusives, jusqu'à aujourd'hui (§6.5 règle 2). */
type PeriodKey = 'day' | 'week' | 'month' | 'year';

const PERIOD_SHORTCUTS: { key: PeriodKey; label: string }[] = [
  { key: 'day', label: "Aujourd'hui" },
  { key: 'week', label: 'Cette semaine' },
  { key: 'month', label: 'Ce mois' },
  { key: 'year', label: 'Cette année' },
];

function periodRange(key: PeriodKey, reference = today()): { from: string; to: string } {
  switch (key) {
    case 'day':
      return { from: reference, to: reference };
    case 'week':
      return { from: startOfWeek(reference), to: reference };
    case 'month':
      return { from: startOfMonth(reference), to: reference };
    case 'year':
      return { from: `${reference.slice(0, 4)}-01-01`, to: reference };
  }
}

type ApprovalFilter = '' | 'pending' | 'to_pay' | 'approved' | 'rejected';

/** Onglets du circuit d'approbation ; « Toutes » montre aussi les rejetées, avec leur badge. */
const APPROVAL_TABS: { key: ApprovalFilter; label: string }[] = [
  { key: '', label: 'Toutes' },
  { key: 'pending', label: 'En attente' },
  { key: 'to_pay', label: 'À décaisser' },
  { key: 'approved', label: 'Décaissées' },
  { key: 'rejected', label: 'Rejetées' },
];

const APPROVAL_BADGES: Record<string, { label: string; tone: 'warning' | 'info' | 'success' | 'error' }> = {
  pending: { label: 'En attente', tone: 'warning' },
  to_pay: { label: 'À décaisser', tone: 'info' },
  approved: { label: 'Décaissée', tone: 'success' },
  rejected: { label: 'Rejetée', tone: 'error' },
};

type ViewState = {
  search: string;
  category: string;
  paymentMethod: string;
  from: string;
  to: string;
  page: number;
};

export default function DepensesPage() {
  const { settings } = useSettings();
  const canCreate = usePermission('expenses.create');
  const canUpdate = usePermission('expenses.update');
  const canCancel = usePermission('expenses.delete');
  const canApprove = usePermission('expenses.approve');
  const { user, activeStoreId } = useAuth();
  const { scope, setScope, apply, isConsolidated } = useStoreScope('depenses');
  const threshold = Number(settings.expenseApprovalThreshold ?? 0) || 0;

  const [approval, setApproval] = useState<ApprovalFilter>('');
  /** Décision en cours : approbation (avec « décaisser tout de suite ») ou rejet (motif). */
  const [decision, setDecision] = useState<{ expense: ExpenseRow; kind: 'approve' | 'reject' } | null>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const [payNow, setPayNow] = useState(true);
  const [isDeciding, setIsDeciding] = useState(false);

  const currency = settings.currency;
  const expenseCategories = useMemo(() => settings.expenseCategories ?? [], [settings.expenseCategories]);
  const paymentMethods = useMemo(() => settings.paymentMethods ?? [], [settings.paymentMethods]);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [category, setCategory] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<ExpensesSummary | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  /* Un état booléen par modale (§8.3 règle 1) — jamais un « mode » en chaîne. */
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [activeExpense, setActiveExpense] = useState<ExpenseRow | null>(null);
  const [expenseToCancel, setExpenseToCancel] = useState<ExpenseRow | null>(null);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
    if (typeof saved.search === 'string') setSearch(saved.search);
    if (typeof saved.category === 'string') setCategory(saved.category);
    if (typeof saved.paymentMethod === 'string') setPaymentMethod(saved.paymentMethod);
    if (typeof saved.from === 'string') setFrom(saved.from);
    if (typeof saved.to === 'string') setTo(saved.to);
    if (typeof saved.page === 'number' && saved.page > 0) setPage(saved.page);
  });

  /* Recherche débouncée à 300 ms : la frappe ne déclenche pas une requête par touche. */
  useEffect(() => {
    if (!rehydrated) return;
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search, rehydrated]);

  /* Mémorisation de l'état de vue (recherche, filtres, période, page). */
  useEffect(() => {
    if (!rehydrated) return;
    writeViewState<ViewState>(VIEW_NAME, { search, category, paymentMethod, from, to, page });
  }, [rehydrated, search, category, paymentMethod, from, to, page]);

  /* Liste paginée. Le premier fetch est **gaté** sur `rehydrated` : sans ce
     verrou, la page chargerait la page 1 puis rechargerait la page 3. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(PAGE_LIMIT),
        });
        apply(params);
        if (approval) params.set('approvalStatus', approval);
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (category) params.set('category', category);
        if (paymentMethod) params.set('paymentMethod', paymentMethod);
        if (from) params.set('from', from);
        if (to) params.set('to', to);

        const response = await fetch(`/api/depenses?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, "Les dépenses n'ont pas pu être chargées."));
        }

        const payload = (await response.json()) as {
          data?: ExpenseRow[];
          total?: number;
          totalPages?: number;
        };

        if (!active) return;

        const data = Array.isArray(payload.data) ? payload.data : [];
        const pages = Math.max(1, Number(payload.totalPages ?? 1));

        setRows(data);
        setTotal(Number(payload.total ?? data.length));
        setTotalPages(pages);

        // Une page restaurée devenue hors bornes (annulations, filtres) est corrigée.
        const corrected = clampPage(page, pages);
        if (corrected !== null) setPage(corrected);

        setIsLoading(false);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setRows([]);
        setTotal(0);
        setTotalPages(1);
        setError(caught instanceof Error ? caught.message : "Les dépenses n'ont pas pu être chargées.");
        setIsLoading(false);
      }
    }

    void load();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, debouncedSearch, category, paymentMethod, from, to, page, refreshToken, apply, approval]);

  /* Cartes de synthèse : total, nombre, moyenne, catégorie la plus lourde. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    async function loadSummary() {
      setIsSummaryLoading(true);
      try {
        const params = apply(new URLSearchParams());
        if (from) params.set('from', from);
        if (to) params.set('to', to);

        const response = await fetch(`/api/depenses/stats?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, "La synthèse n'a pas pu être chargée."));
        }

        const payload = (await response.json()) as Partial<ExpensesSummary>;
        if (!active) return;

        setSummary({
          totalAmount: Number(payload.totalAmount ?? 0),
          expensesCount: Number(payload.expensesCount ?? 0),
          averageAmount: Number(payload.averageAmount ?? 0),
          byCategory: Array.isArray(payload.byCategory) ? payload.byCategory : [],
          byMonth: Array.isArray(payload.byMonth) ? payload.byMonth : [],
          pendingCount: Number(payload.pendingCount ?? 0),
          pendingAmount: Number(payload.pendingAmount ?? 0),
          byStore: Array.isArray(payload.byStore) ? payload.byStore : [],
        });
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        // Les cartes affichent « — » : la liste reste utilisable sans la synthèse.
        setSummary(null);
      } finally {
        if (active) setIsSummaryLoading(false);
      }
    }

    void loadSummary();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, from, to, refreshToken, apply]);

  const hasFilters = Boolean(debouncedSearch || category || paymentMethod || from || to);
  const activePeriodCount = (from ? 1 : 0) + (to ? 1 : 0);

  const resetFilters = () => {
    setSearch('');
    setCategory('');
    setPaymentMethod('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  const applyPeriod = (key: PeriodKey) => {
    const range = periodRange(key);
    setFrom(range.from);
    setTo(range.to);
    setPage(1);
  };

  const openCreateModal = () => {
    setActiveExpense(null);
    setIsFormOpen(true);
  };

  const openEditModal = (expense: ExpenseRow) => {
    setActiveExpense(expense);
    setIsFormOpen(true);
  };

  const openCancelModal = (expense: ExpenseRow) => {
    setExpenseToCancel(expense);
    setIsCancelOpen(true);
  };

  /**
   * Rechargement manuel : un seul toast par action (§26.3). Toute écriture
   * passe par l'API puis recharge liste **et** synthèse via `refresh`.
   */
  /** Approuver / rejeter (`POST /api/depenses/[id]/approbation`). */
  const submitDecision = async () => {
    if (!decision) return;
    if (decision.kind === 'reject' && !decisionReason.trim()) {
      toast.error('Le motif du rejet est obligatoire.');
      return;
    }
    setIsDeciding(true);
    try {
      const response = await fetch(`/api/depenses/${decision.expense.id}/approbation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          decision: decision.kind,
          reason: decisionReason.trim() || null,
          payNow: decision.kind === 'approve' && payNow && decision.expense.storeId === activeStoreId,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'La décision n’a pas pu être enregistrée.'));
      const saved = (await response.json()) as ExpenseRow;
      toast.success(
        decision.kind === 'reject'
          ? 'Dépense rejetée.'
          : saved.approvalStatus === 'approved'
            ? 'Dépense approuvée et décaissée.'
            : 'Dépense approuvée : elle est maintenant à décaisser.',
      );
      setDecision(null);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'La décision n’a pas pu être enregistrée.', { autoClose: 9000 });
    } finally {
      setIsDeciding(false);
    }
  };

  /** Décaisser une dépense approuvée (`POST /api/depenses/[id]/decaisser`) : sortie de caisse. */
  const payExpense = async (expense: ExpenseRow) => {
    try {
      const response = await fetch(`/api/depenses/${expense.id}/decaisser`, { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error(await readApiError(response, 'Le décaissement a échoué.'));
      toast.success(`Dépense décaissée : ${formatCurrency(expense.amount, currency)} sortis de la caisse.`);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Le décaissement a échoué.', { autoClose: 9000 });
    }
  };

  const handleManualRefresh = useCallback(() => {
    refresh();
    toast.success('Liste actualisée.');
  }, [refresh]);

  const categoryOptions = useMemo(
    () => expenseCategories.map((item) => ({ value: item, label: item })),
    [expenseCategories],
  );

  const paymentOptions = useMemo(
    () => paymentMethods.map((item) => ({ value: item, label: item })),
    [paymentMethods],
  );

  const columns = useMemo<Column<ExpenseRow>[]>(
    () => [
      {
        key: 'date',
        label: 'Date',
        render: (expense) => (
          <span className="whitespace-nowrap text-sm">{formatDateShort(expense.date)}</span>
        ),
      },
      {
        key: 'category',
        label: 'Catégorie',
        primary: true,
        // Description et bénéficiaire sous la catégorie : deux colonnes de moins,
        // le tableau tient en largeur ordinateur même avec la colonne « Magasin ».
        render: (expense) => (
          <span className="block min-w-0 max-w-xs">
            <span className="block font-medium">{expense.category}</span>
            {expense.description && (
              <span className="block truncate text-xs text-base-content/60" title={expense.description}>
                {expense.description}
              </span>
            )}
            {expense.beneficiary && (
              <span className="block text-xs text-base-content/60">Bénéficiaire : {expense.beneficiary}</span>
            )}
          </span>
        ),
      },
      {
        key: 'approval',
        label: 'Statut',
        render: (expense) => {
          const badge = APPROVAL_BADGES[expense.approvalStatus] ?? APPROVAL_BADGES.approved;
          return <Badge tone={badge.tone}>{badge.label}</Badge>;
        },
      },
      ...(isConsolidated || typeof scope === 'number'
        ? [
            {
              key: 'store',
              label: 'Magasin',
              hideOnMobile: true,
              render: (expense: ExpenseRow) => <span className="text-sm">{expense.storeName ?? '—'}</span>,
            },
          ]
        : []),
      {
        key: 'amount',
        label: 'Montant',
        className: 'text-right',
        render: (expense) => <MoneyText value={expense.amount} currency={currency} bold />,
      },
      {
        key: 'userName',
        label: 'Utilisateur',
        hideOnMobile: true,
        render: (expense) => (
          <span className="text-sm text-base-content/70">{expense.userName || '—'}</span>
        ),
      },
    ],
    [currency, isConsolidated, scope],
  );

  const topCategory = summary?.byCategory?.[0] ?? null;

  const summaryCards = isSummaryLoading ? (
    <SkeletonCards count={4} />
  ) : (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCardDelta
        label="Total de la période"
        tone="error"
        value={<MoneyText value={summary?.totalAmount ?? 0} currency={currency} />}
        hint={from || to ? 'Dépenses de la période sélectionnée' : 'Toutes les dépenses'}
        tooltip="Argent réellement sorti pour les frais (loyer, transport, salaires…) sur la période. Les dépenses en attente d’approbation, rejetées ou annulées ne sont pas comptées."
      />
      <StatCardDelta
        label="Nombre de dépenses"
        value={<span className="tabular">{formatNumber(summary?.expensesCount ?? 0)}</span>}
        hint={`Moyenne : ${formatCurrency(summary?.averageAmount ?? 0, currency)}`}
        tooltip="Nombre de dépenses décaissées sur la période, et leur montant moyen."
      />
      <button
        type="button"
        className="rounded-2xl text-left focus-visible:outline-2 focus-visible:outline-primary"
        onClick={() => {
          setApproval('pending');
          setPage(1);
        }}
        aria-label="Afficher les dépenses en attente d’approbation"
      >
        <StatCardDelta
          label="En attente d’approbation"
          tone={(summary?.pendingCount ?? 0) > 0 ? 'warning' : 'neutral'}
          value={<span className="tabular">{formatNumber(summary?.pendingCount ?? 0)}</span>}
          hint={(summary?.pendingCount ?? 0) > 0 ? `${formatCurrency(summary?.pendingAmount ?? 0, currency)} — cliquez pour voir` : 'Rien à approuver'}
          tooltip={
            threshold > 0
              ? `Dépenses de plus de ${formatCurrency(threshold, currency)} qui attendent l’accord d’un responsable avant de sortir de la caisse. Celui qui a saisi la dépense ne peut pas l’approuver lui-même.`
              : 'Le seuil d’approbation est à 0 dans les paramètres : aucune dépense n’a besoin d’être approuvée.'
          }
        />
      </button>
      <StatCardDelta
        label="Catégorie la plus lourde"
        tooltip="Le poste de dépense qui a coûté le plus cher sur la période."
        tone="warning"
        value={
          <span className="text-base font-semibold">{topCategory ? topCategory.category : '—'}</span>
        }
        hint={
          topCategory
            ? `${formatCurrency(topCategory.total, currency)} — ${formatNumber(topCategory.count)} dépense${topCategory.count > 1 ? 's' : ''}`
            : 'Aucune dépense enregistrée'
        }
      />
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Finances"
        title="Dépenses"
        description="Transport, loyer, salaire, carburant, électricité… Une dépense sort de la caisse et ne modifie jamais le stock."
        actions={
          <>
            <Tooltip label="Les catégories de dépenses sont une liste fermée, gérée dans les paramètres">
              <Link
                href="/parametres"
                className="btn btn-ghost min-h-11 text-xs font-normal text-base-content/60 sm:min-h-0"
              >
                Gérer les catégories
              </Link>
            </Tooltip>
            {canCreate && (
              <button
                type="button"
                className="btn btn-primary min-h-11 sm:min-h-0"
                onClick={openCreateModal}
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
                Nouvelle dépense
              </button>
            )}
          </>
        }
      />

      {summaryCards}

      {threshold > 0 && (
        <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">
          Au-delà de <strong>{formatCurrency(threshold, currency)}</strong>, une dépense doit être approuvée par
          un responsable avant d’être payée (réglage dans les paramètres).
        </p>
      )}

      <div role="tablist" className="tabs tabs-border overflow-x-auto">
        {APPROVAL_TABS.map((tab) => (
          <button
            key={tab.key || 'all'}
            type="button"
            role="tab"
            aria-selected={approval === tab.key}
            className={`tab min-h-11 whitespace-nowrap ${approval === tab.key ? 'tab-active' : ''}`}
            onClick={() => {
              setApproval(tab.key);
              setPage(1);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher une description, un bénéficiaire…"
        filters={
          <>
            <div className="w-full sm:w-48">
              <FilterSelect
                value={category}
                onChange={(value) => {
                  setCategory(value);
                  setPage(1);
                }}
                options={categoryOptions}
                placeholder="Toutes les catégories"
              />
            </div>
            <StoreScopeSelect
              value={scope}
              onChange={(value) => {
                setScope(value);
                setPage(1);
              }}
              className="min-h-11 w-full sm:w-52"
            />
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
            <div className="flex flex-wrap gap-2">
              {PERIOD_SHORTCUTS.map((shortcut) => {
                const range = periodRange(shortcut.key);
                const isActive = from === range.from && to === range.to;

                return (
                  <button
                    key={shortcut.key}
                    type="button"
                    onClick={() => applyPeriod(shortcut.key)}
                    className={`btn btn-sm min-h-11 sm:min-h-0 ${
                      isActive ? 'btn-primary' : 'btn-ghost border border-base-300'
                    }`}
                  >
                    {shortcut.label}
                  </button>
                );
              })}
              {(from || to) && (
                <button
                  type="button"
                  onClick={() => {
                    setFrom('');
                    setTo('');
                    setPage(1);
                  }}
                  className="btn btn-sm btn-ghost min-h-11 sm:min-h-0"
                >
                  Effacer la période
                </button>
              )}
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
                  placeholder="jj mois aaaa"
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
                  placeholder="jj mois aaaa"
                />
              </div>
            </div>
          </div>
        }
        secondaryCount={activePeriodCount}
        actions={
          <>
            {hasFilters && (
              <Tooltip label="Revenir à la liste complète">
                <ToolbarButton onClick={resetFilters}>
                  Effacer les filtres
                </ToolbarButton>
              </Tooltip>
            )}
            <Tooltip label="Recharger la liste">
              <ToolbarButton onClick={handleManualRefresh}>
                Actualiser
              </ToolbarButton>
            </Tooltip>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-base-content/60">
        <span>
          {isLoading
            ? 'Chargement…'
            : `${formatNumber(total)} dépense${total > 1 ? 's' : ''} ${
                total > 1 ? 'trouvées' : 'trouvée'
              }`}
        </span>
        {(from || to) && (
          <span>
            Période : {from ? formatDateShort(from) : 'origine'} →{' '}
            {to ? formatDateShort(to) : 'aujourd’hui'}
          </span>
        )}
      </div>

      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Impossible de charger les dépenses"
            description={error}
            onRetry={refresh}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <EmptyState
            title={hasFilters ? 'Aucune dépense ne correspond' : 'Aucune dépense enregistrée'}
            description={
              hasFilters
                ? 'Élargissez la période ou retirez un filtre pour retrouver vos dépenses.'
                : 'Transport, loyer, salaire, carburant, électricité : enregistrez ici les frais de fonctionnement. Une dépense sort de la caisse et ne touche jamais le stock.'
            }
            action={
              hasFilters ? (
                <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                  Réinitialiser les filtres
                </button>
              ) : canCreate ? (
                <button
                  type="button"
                  className="btn btn-primary min-h-11"
                  onClick={openCreateModal}
                >
                  Enregistrer la première dépense
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="surface-card overflow-hidden border border-base-200 bg-base-100 shadow-sm">
          <ResponsiveTable
            columns={columns}
            data={rows}
            getRowKey={(expense) => expense.id}
            actions={
              canUpdate || canCancel || canApprove || canCreate
                ? (expense) => (
                    <RowActions>
                      {canApprove && expense.approvalStatus === 'pending' && expense.userId !== user?.id && (
                        <IconAction
                          icon="activate"
                          tone="success"
                          label="Approuver cette dépense"
                          onClick={() => {
                            setDecisionReason('');
                            setPayNow(expense.storeId === activeStoreId);
                            setDecision({ expense, kind: 'approve' });
                          }}
                        />
                      )}
                      {canApprove && expense.approvalStatus === 'pending' && expense.userId !== user?.id && (
                        <IconAction
                          icon="deactivate"
                          tone="danger"
                          label="Rejeter cette dépense"
                          onClick={() => {
                            setDecisionReason('');
                            setDecision({ expense, kind: 'reject' });
                          }}
                        />
                      )}
                      {canCreate && expense.approvalStatus === 'to_pay' && expense.storeId === activeStoreId && (
                        <IconAction
                          icon="pay"
                          tone="success"
                          label="Décaisser cette dépense (sortie de caisse)"
                          onClick={() => void payExpense(expense)}
                        />
                      )}
                      {canUpdate && expense.approvalStatus !== 'rejected' && (
                        <IconAction
                          icon="edit"
                          label="Modifier cette dépense"
                          onClick={() => openEditModal(expense)}
                        />
                      )}
                      {canCancel && (
                        <IconAction
                          icon="cancel"
                          tone="danger"
                          label="Annuler cette dépense (aucune suppression)"
                          onClick={() => openCancelModal(expense)}
                        />
                      )}
                    </RowActions>
                  )
                : undefined
            }
          />
        </div>
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      <ExpenseFormModal
        isOpen={isFormOpen}
        onClose={() => {
          setIsFormOpen(false);
          setActiveExpense(null);
        }}
        expense={activeExpense}
        expenseCategories={expenseCategories}
        paymentMethods={paymentMethods}
        onSaved={refresh}
      />

      <ConfirmDialog
        isOpen={decision !== null}
        onClose={() => {
          if (!isDeciding) setDecision(null);
        }}
        onConfirm={() => void submitDecision()}
        title={decision?.kind === 'reject' ? 'Rejeter la dépense' : 'Approuver la dépense'}
        tone={decision?.kind === 'reject' ? 'error' : 'success'}
        confirmLabel={decision?.kind === 'reject' ? 'Rejeter' : 'Approuver'}
        isSubmitting={isDeciding}
        message={
          decision ? (
            <>
              {decision.expense.category} — <strong>{formatCurrency(decision.expense.amount, currency)}</strong>
              {decision.expense.description ? ` — ${decision.expense.description}` : ''}, saisie par{' '}
              {decision.expense.userName ?? '—'}
              {decision.expense.storeName ? ` (${decision.expense.storeName})` : ''}.
              <span className="mt-2 block text-sm text-base-content/70">
                {decision.kind === 'reject'
                  ? 'La dépense ne sera pas payée. Le motif est conservé.'
                  : 'Une fois approuvée, la dépense peut sortir de la caisse du magasin.'}
              </span>
            </>
          ) : (
            ''
          )
        }
      >
        {decision?.kind === 'reject' ? (
          <FormField label="Motif du rejet" required className="mb-4">
            <textarea
              className="textarea textarea-bordered w-full"
              rows={2}
              value={decisionReason}
              onChange={(event) => setDecisionReason(event.target.value)}
            />
          </FormField>
        ) : decision && decision.expense.storeId === activeStoreId ? (
          <label className="mb-4 flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox checkbox-sm mt-0.5"
              checked={payNow}
              onChange={(event) => setPayNow(event.target.checked)}
            />
            <span>Décaisser tout de suite (sortie de la caisse de ce magasin)</span>
          </label>
        ) : decision ? (
          <p className="mb-4 text-sm text-base-content/70">
            Elle sera décaissée depuis {decision.expense.storeName ?? 'son magasin'}, par une personne qui y travaille.
          </p>
        ) : null}
      </ConfirmDialog>

      <CancelExpenseModal
        isOpen={isCancelOpen}
        onClose={() => {
          setIsCancelOpen(false);
          setExpenseToCancel(null);
        }}
        expense={expenseToCancel}
        currency={currency}
        onCancelled={refresh}
      />
    </div>
  );
}
