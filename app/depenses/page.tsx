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
  }, [rehydrated, debouncedSearch, category, paymentMethod, from, to, page, refreshToken]);

  /* Cartes de synthèse : total, nombre, moyenne, catégorie la plus lourde. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    async function loadSummary() {
      setIsSummaryLoading(true);
      try {
        const params = new URLSearchParams();
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
  }, [rehydrated, from, to, refreshToken]);

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
        render: (expense) => <span className="font-medium">{expense.category}</span>,
      },
      {
        key: 'description',
        label: 'Description',
        hideOnMobile: true,
        render: (expense) => (
          <span className="text-sm text-base-content/70">{expense.description || '—'}</span>
        ),
      },
      {
        key: 'beneficiary',
        label: 'Bénéficiaire',
        render: (expense) => <span className="text-sm">{expense.beneficiary || '—'}</span>,
      },
      {
        key: 'paymentMethod',
        label: 'Moyen',
        render: (expense) => <Badge tone="neutral">{expense.paymentMethod}</Badge>,
      },
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
    [currency],
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
      />
      <StatCardDelta
        label="Nombre de dépenses"
        value={<span className="tabular">{formatNumber(summary?.expensesCount ?? 0)}</span>}
        hint="Dépenses non annulées"
      />
      <StatCardDelta
        label="Montant moyen"
        value={<MoneyText value={summary?.averageAmount ?? 0} currency={currency} />}
        hint="Par dépense"
      />
      <StatCardDelta
        label="Catégorie la plus lourde"
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
            <Link
              href="/parametres"
              title="Les catégories de dépenses sont une liste fermée, gérée dans les paramètres"
              className="btn btn-ghost min-h-11 text-xs font-normal text-base-content/60 sm:min-h-0"
            >
              Gérer les catégories
            </Link>
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
        secondaryCount={activePeriodCount}
        actions={
          <>
            {hasFilters && (
              <ToolbarButton onClick={resetFilters} title="Revenir à la liste complète">
                Effacer les filtres
              </ToolbarButton>
            )}
            <ToolbarButton onClick={handleManualRefresh} title="Recharger la liste">
              Actualiser
            </ToolbarButton>
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
              canUpdate || canCancel
                ? (expense) => (
                    <RowActions>
                      {canUpdate && (
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
