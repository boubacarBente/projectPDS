'use client';

/**
 * Liste des achats (README §7.5, §14, §27.2).
 *
 * Ordre imposé (§5) : `PageHeader` → cartes de synthèse → `DataToolbar` →
 * `ResponsiveTable` → `Pagination` → modales (une par état booléen).
 *
 * ## Achats ≠ Dépenses (§14)
 *
 * Cette page ne liste **que** les marchandises revendues : un achat a un
 * fournisseur **obligatoire**, des lignes produits, il **augmente le stock** et
 * il alimente la **dette fournisseur**. Les frais de fonctionnement
 * (transport, loyer, carburant…) vivent dans `/depenses` et ne touchent jamais
 * le stock.
 *
 * Les cinq états obligatoires (§5) sont rendus ici : chargement
 * (`SkeletonTable`), vide (`EmptyState` avec action), erreur (`ErrorState` +
 * « Réessayer »), nominal (`AchatsTable` → `ResponsiveTable`) et retour
 * utilisateur (`toast`).
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { DatePicker } from '@/components/date-picker';
import {
  Card,
  EmptyState,
  ErrorState,
  MiniStat,
  MoneyText,
  SkeletonCards,
  SkeletonTable,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { AchatsTable } from '@/components/achats/achats-table';
import {
  CancelPurchaseDialog,
  PurchaseDetailModal,
  PurchasePaymentModal,
  normalizePurchaseRow,
  readApiError,
  usePurchaseDetailLazy,
  type PurchaseInvoiceRow,
} from '@/components/achats/achats-modals';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency, formatNumber } from '@/lib/format';

const PAGE_LIMIT = 10;
const VIEW_NAME = 'achats';
const SUPPLIERS_LIMIT = 500;

type PaymentStatusFilter = 'all' | 'paid' | 'partial' | 'unpaid' | 'cancelled';
type StatsPeriod = 'day' | 'week' | 'month' | 'year' | 'total';

type ViewState = {
  search: string;
  page: number;
  paymentStatus: PaymentStatusFilter;
  supplierId: string;
  from: string;
  to: string;
  period: StatsPeriod;
};

type SupplierOption = { id: number; name: string };

type PurchaseStats = {
  /** `resolvePeriod` de `lib/dashboard.ts` : bornes + libellé lisible. */
  period: { from: string; to: string; label: string; key: string };
  count: number;
  totalAmount: number;
  paid: number;
  outstanding: number;
  averageBasket: number;
  cancelledCount: number;
  bySupplier: { supplierName: string; count: number; total: number }[];
};

const PAYMENT_STATUS_OPTIONS = [
  { value: 'all', label: 'Tous les achats' },
  { value: 'paid', label: 'Payés' },
  { value: 'partial', label: 'Partiels' },
  { value: 'unpaid', label: 'À payer' },
  { value: 'cancelled', label: 'Annulés' },
];

const PERIODS: { key: StatsPeriod; label: string }[] = [
  { key: 'day', label: "Aujourd'hui" },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'year', label: 'Année' },
  { key: 'total', label: 'Total' },
];

function isPaymentStatusFilter(value: unknown): value is PaymentStatusFilter {
  return (
    value === 'all' ||
    value === 'paid' ||
    value === 'partial' ||
    value === 'unpaid' ||
    value === 'cancelled'
  );
}

function isStatsPeriod(value: unknown): value is StatsPeriod {
  return (
    value === 'day' || value === 'week' || value === 'month' || value === 'year' || value === 'total'
  );
}

export default function AchatsPage() {
  const router = useRouter();
  const canCreate = usePermission('purchases.create');
  const canUpdate = usePermission('purchases.update');
  const canCancel = usePermission('purchases.delete');
  const canPay = usePermission('payments.create');

  /* ------------------------------- État liste ------------------------------ */
  const [invoices, setInvoices] = useState<PurchaseInvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatusFilter>('all');
  const [supplierId, setSupplierId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);

  /* ---------------------------- Statistiques ------------------------------ */
  const [stats, setStats] = useState<PurchaseStats | null>(null);
  const [isStatsLoading, setIsStatsLoading] = useState(true);
  const [period, setPeriod] = useState<StatsPeriod>('month');

  /* ----------------------------- Fournisseurs ----------------------------- */
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);

  /* ------------------------------- Modales -------------------------------- */
  // Un état booléen par modale (§8.3 règle 1) : aucune modale « mode ».
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);

  const [activeInvoice, setActiveInvoice] = useState<PurchaseInvoiceRow | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const detail = usePurchaseDetailLazy(activeInvoice, showDetailModal, refreshToken);

  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
    if (typeof saved.search === 'string') setSearch(saved.search);
    if (isPaymentStatusFilter(saved.paymentStatus)) setPaymentStatus(saved.paymentStatus);
    if (typeof saved.supplierId === 'string') setSupplierId(saved.supplierId);
    if (typeof saved.from === 'string') setFrom(saved.from);
    if (typeof saved.to === 'string') setTo(saved.to);
    if (isStatsPeriod(saved.period)) setPeriod(saved.period);
    if (typeof saved.page === 'number' && saved.page > 0) setPage(saved.page);
  });

  /* Recherche débouncée à 300 ms — la frappe ne déclenche pas une requête par touche. */
  useEffect(() => {
    if (!rehydrated) return;
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search, rehydrated]);

  /* Chargement de la liste. Le premier fetch est **gaté** sur `rehydrated` :
     sans ce verrou, la page chargerait la page 1 puis rechargerait la page 3. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    void (async () => {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(PAGE_LIMIT),
        });
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (paymentStatus === 'cancelled') {
          params.set('status', 'cancelled');
        } else if (paymentStatus !== 'all') {
          params.set('paymentStatus', paymentStatus);
        }
        if (supplierId) params.set('supplierId', supplierId);
        if (from) params.set('from', from);
        if (to) params.set('to', to);

        const response = await fetch(`/api/achats?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'Les achats n’ont pas pu être chargés.'));
        }

        const payload = (await response.json()) as {
          data?: unknown[];
          total?: number;
          totalPages?: number;
        };

        if (!active) return;

        const rows = Array.isArray(payload.data) ? payload.data.map(normalizePurchaseRow) : [];
        const pages = Math.max(1, Number(payload.totalPages ?? 1));

        setInvoices(rows);
        setTotal(Number(payload.total ?? rows.length));
        setTotalPages(pages);

        // Une page restaurée devenue hors bornes (liste rétrécie) est corrigée.
        const clamped = clampPage(page, pages);
        if (clamped !== null) setPage(clamped);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setInvoices([]);
        setError(
          caught instanceof Error ? caught.message : 'Les achats n’ont pas pu être chargés.',
        );
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, debouncedSearch, paymentStatus, supplierId, from, to, page, refreshToken]);

  /* Cartes de synthèse : un agrégat indisponible ne casse pas la liste. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    void (async () => {
      setIsStatsLoading(true);
      try {
        const response = await fetch(`/api/achats/stats?period=${period}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            await readApiError(response, 'Les statistiques n’ont pas pu être chargées.'),
          );
        }
        const payload = (await response.json()) as Partial<PurchaseStats>;
        if (!active) return;
        setStats({
          period: {
            from: String(payload.period?.from ?? ''),
            to: String(payload.period?.to ?? ''),
            label: String(payload.period?.label ?? ''),
            key: String(payload.period?.key ?? period),
          },
          count: Number(payload.count ?? 0),
          totalAmount: Number(payload.totalAmount ?? 0),
          paid: Number(payload.paid ?? 0),
          outstanding: Number(payload.outstanding ?? 0),
          averageBasket: Number(payload.averageBasket ?? 0),
          cancelledCount: Number(payload.cancelledCount ?? 0),
          bySupplier: Array.isArray(payload.bySupplier) ? payload.bySupplier : [],
        });
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setStats(null);
      } finally {
        if (active) setIsStatsLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, period, refreshToken]);

  /* Liste des fournisseurs pour le filtre (et pour l'en-tête). */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    void (async () => {
      try {
        const response = await fetch(`/api/fournisseurs?limit=${SUPPLIERS_LIMIT}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: unknown[] };
        if (!active) return;
        setSuppliers(
          (Array.isArray(payload.data) ? payload.data : [])
            .map((raw) => {
              const row = (raw ?? {}) as Record<string, unknown>;
              return { id: Number(row.id ?? 0), name: String(row.name ?? '') };
            })
            .filter((supplier) => supplier.id > 0),
        );
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setSuppliers([]);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, refreshToken]);

  /* Mémorisation de l'état de vue, sur la même maille que le retour arrière. */
  useEffect(() => {
    if (!rehydrated) return;
    writeViewState<ViewState>(VIEW_NAME, { search, page, paymentStatus, supplierId, from, to, period });
  }, [rehydrated, search, page, paymentStatus, supplierId, from, to, period]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  /* --------------------------- Ouverture des modales ---------------------- */

  const openDetailModal = (invoice: PurchaseInvoiceRow) => {
    setActiveInvoice(invoice);
    setShowDetailModal(true);
  };

  const openDocumentPage = (invoice: PurchaseInvoiceRow) => {
    router.push(`/achats/${invoice.id}`);
  };

  const openEditPage = (invoice: PurchaseInvoiceRow) => {
    router.push(`/achats/nouvelle?edit=${invoice.id}`);
  };

  const openPaymentModal = (invoice: PurchaseInvoiceRow) => {
    setActiveInvoice(invoice);
    setShowDetailModal(false);
    setShowPaymentModal(true);
  };

  const openCancelModal = (invoice: PurchaseInvoiceRow) => {
    setActiveInvoice(invoice);
    setShowDetailModal(false);
    setShowCancelModal(true);
  };

  /**
   * Annulation motivée — **jamais** une suppression physique (§14).
   *
   * `DELETE /api/achats/[id]` avec `{ reason }` : le serveur passe le document
   * en `cancelled`, inverse les entrées de stock et contre-passe le
   * décaissement. Aucun `DELETE` SQL n'est exécuté.
   */
  const handleCancel = async (reason: string) => {
    if (!activeInvoice) return;
    setIsCancelling(true);

    try {
      const response = await fetch(`/api/achats/${activeInvoice.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "L'achat n'a pas pu être annulé."));
      }

      toast.success(`Achat ${activeInvoice.reference} annulé.`);
      setShowCancelModal(false);
      setActiveInvoice(null);
      refresh();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "L'achat n'a pas pu être annulé.",
        { autoClose: 8000 },
      );
    } finally {
      setIsCancelling(false);
    }
  };

  const hasFilters =
    Boolean(debouncedSearch) ||
    paymentStatus !== 'all' ||
    Boolean(supplierId) ||
    Boolean(from) ||
    Boolean(to);

  const resetFilters = () => {
    setSearch('');
    setPaymentStatus('all');
    setSupplierId('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  const periodLabel = PERIODS.find((entry) => entry.key === period)?.label ?? 'Total';

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Commercial"
        title="Achats"
        description="Marchandises achetées, entrées de stock, règlements fournisseurs et dettes restantes."
        actions={
          canCreate ? (
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              onClick={() => router.push('/achats/nouvelle')}
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
              Nouvel achat
            </button>
          ) : null
        }
      />

      {/* ── Cartes de synthèse (§5, §15) : tout est calculé à la lecture ──── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Période des statistiques">
          {PERIODS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setPeriod(entry.key)}
              aria-pressed={period === entry.key}
              className={`btn btn-sm min-h-11 sm:min-h-0 ${
                period === entry.key ? 'btn-primary' : 'btn-ghost border border-base-300'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {isStatsLoading || !stats ? (
          <SkeletonCards count={4} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MiniStat
                label={`Achats — ${periodLabel.toLowerCase()}`}
                tone="primary"
                value={<MoneyText value={stats.totalAmount} className="text-base" />}
              />
              <MiniStat
                label="Réglé aux fournisseurs"
                tone="success"
                value={<MoneyText value={stats.paid} className="text-base" />}
              />
              <MiniStat
                label="Dette fournisseur"
                tone={stats.outstanding > 0.001 ? 'error' : 'success'}
                value={<MoneyText value={stats.outstanding} className="text-base" />}
              />
              <MiniStat
                label="Panier moyen"
                value={<MoneyText value={stats.averageBasket} className="text-base" />}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/50">
              <span>
                {formatNumber(stats.count)} achat{stats.count > 1 ? 's' : ''} sur la période
                {stats.cancelledCount > 0
                  ? ` · ${formatNumber(stats.cancelledCount)} annulé${stats.cancelledCount > 1 ? 's' : ''}`
                  : ''}
              </span>
              {stats.period.label ? (
                <span className="tabular">Période : {stats.period.label}</span>
              ) : null}
            </div>

            {stats.bySupplier.length > 0 && (
              <Card padded={false} className="overflow-hidden">
                <div className="border-b border-base-200 bg-base-200/60 px-4 py-2.5">
                  <h2 className="text-sm font-semibold">Achats par fournisseur</h2>
                </div>
                <ul className="divide-y divide-base-200">
                  {stats.bySupplier.slice(0, 5).map((entry) => (
                    <li
                      key={entry.supplierName}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm"
                    >
                      <span className="min-w-0 truncate">{entry.supplierName}</span>
                      <span className="flex shrink-0 items-center gap-3">
                        <span className="tabular text-base-content/60">
                          {formatNumber(entry.count)} achat{entry.count > 1 ? 's' : ''}
                        </span>
                        <span className="tabular font-medium">
                          {formatCurrency(entry.total)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher une référence d’achat, une réf. fournisseur ou un fournisseur…"
        filters={
          <div className="w-full sm:w-52">
            <FilterSelect
              value={paymentStatus}
              onChange={(value) => {
                setPaymentStatus(isPaymentStatusFilter(value) ? value : 'all');
                setPage(1);
              }}
              options={PAYMENT_STATUS_OPTIONS}
              placeholder="Tous les achats"
            />
          </div>
        }
        secondaryFilters={
          <>
            <label className="flex w-full flex-col gap-1 sm:w-56">
              <span className="text-xs text-base-content/60">Fournisseur</span>
              <select
                className="select select-bordered min-h-11 w-full sm:min-h-0"
                value={supplierId}
                onChange={(event) => {
                  setSupplierId(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">Tous les fournisseurs</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex w-full flex-col gap-1 sm:w-40">
              <span className="text-xs text-base-content/60">Du</span>
              <DatePicker
                value={from}
                onChange={(value) => {
                  setFrom(value);
                  setPage(1);
                }}
                placeholder="jj/mm/aaaa"
              />
            </div>

            <div className="flex w-full flex-col gap-1 sm:w-40">
              <span className="text-xs text-base-content/60">Au</span>
              <DatePicker
                value={to}
                onChange={(value) => {
                  setTo(value);
                  setPage(1);
                }}
                placeholder="jj/mm/aaaa"
              />
            </div>
          </>
        }
        secondaryCount={(supplierId ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0)}
        actions={
          <>
            {hasFilters && (
              <ToolbarButton onClick={resetFilters} title="Réinitialiser les filtres">
                Réinitialiser
              </ToolbarButton>
            )}
            <ToolbarButton onClick={refresh} title="Recharger la liste">
              Actualiser
            </ToolbarButton>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-base-content/60">
        <span>
          {isLoading
            ? 'Chargement…'
            : `${formatNumber(total)} achat${total > 1 ? 's' : ''} ${
                total > 1 ? 'trouvés' : 'trouvé'
              }`}
        </span>
        {(from || to) && (
          <span className="tabular">
            Période : {from ? formatDateShort(from) : '—'} → {to ? formatDateShort(to) : '—'}
          </span>
        )}
      </div>

      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Impossible de charger les achats"
            description={error}
            onRetry={refresh}
          />
        </div>
      ) : (
        <AchatsTable
          data={invoices}
          isLoading={isLoading}
          canPay={canPay}
          canUpdate={canUpdate}
          canCancel={canCancel}
          onOpenDetail={openDetailModal}
          onOpenDocument={openDocumentPage}
          onOpenEdit={openEditPage}
          onOpenPayment={openPaymentModal}
          onOpenCancel={openCancelModal}
          emptyState={
            <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
              <EmptyState
                title={hasFilters ? 'Aucun achat ne correspond' : 'Aucun achat enregistré'}
                description={
                  hasFilters
                    ? 'Modifiez la recherche, le statut de paiement, le fournisseur ou la période pour élargir les résultats.'
                    : 'Enregistrez le premier achat : le stock est augmenté et la dette fournisseur suivie automatiquement.'
                }
                action={
                  canCreate ? (
                    <button
                      type="button"
                      className="btn btn-primary min-h-11 sm:min-h-0"
                      onClick={() => router.push('/achats/nouvelle')}
                    >
                      Créer le premier achat
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost min-h-11 sm:min-h-0"
                      onClick={resetFilters}
                    >
                      Réinitialiser les filtres
                    </button>
                  )
                }
              />
            </div>
          }
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Modales — une par état booléen (§8.3 règle 1). */}
      <PurchaseDetailModal
        isOpen={showDetailModal}
        onClose={() => setShowDetailModal(false)}
        invoice={activeInvoice}
        detail={detail}
        onOpenPayment={activeInvoice ? () => openPaymentModal(activeInvoice) : undefined}
      />

      {activeInvoice && (
        <PurchasePaymentModal
          isOpen={showPaymentModal}
          onClose={() => setShowPaymentModal(false)}
          invoiceId={activeInvoice.id}
          documentNumber={activeInvoice.reference}
          supplierName={activeInvoice.supplierName}
          remainingAmount={activeInvoice.remainingAmount}
          onRecorded={(payment) => {
            toast.success(`Règlement enregistré — reçu ${payment.receiptNumber}.`);
            refresh();
          }}
        />
      )}

      <CancelPurchaseDialog
        isOpen={showCancelModal}
        onClose={() => {
          if (!isCancelling) setShowCancelModal(false);
        }}
        onConfirm={handleCancel}
        invoice={activeInvoice}
        isSubmitting={isCancelling}
      />
    </div>
  );
}
