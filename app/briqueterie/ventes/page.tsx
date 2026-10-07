'use client';

/**
 * Liste des ventes de la **briqueterie** (README §20).
 *
 * Ces ventes sont des factures de vente ordinaires, créées par
 * `/ventes/nouvelle?canal=briqueterie` : elles portent `channel = 'brick'` et
 * gagnent donc **toutes** les fonctionnalités d'une vente (stock, caisse, reçu,
 * paiements ultérieurs, brouillon/validation, export PDF, impression). La fiche
 * reste `/ventes/[id]` — il n'existe pas de fiche de briqueterie séparée.
 *
 * Structure calquée sur `app/ventes/page.tsx` : `PageHeader` → cartes de
 * synthèse → `DataToolbar` → `ResponsiveTable` → `Pagination` → modales (une
 * par état booléen). Aucun total n'est stocké : les cartes viennent de
 * `GET /api/ventes/stats` et la liste de `GET /api/ventes`, tout deux calculés à
 * la lecture.
 *
 * ⚠️ `channel=brick` est **indispensable** sur les deux appels : sans ce
 * paramètre, `GET /api/ventes` et `GET /api/ventes/stats` ne renvoient que le
 * **commerce général** — cette page afficherait donc les ventes de `/ventes` et
 * jamais les ventes de briques. Inversement, c'est ce même filtre qui garantit
 * qu'une vente de briqueterie n'apparaît jamais dans `/ventes`.
 *
 * Il n'existe **aucune suppression** de vente : l'action « Annuler » ouvre une
 * modale à motif obligatoire, et le serveur contre-passe le stock et
 * l'encaissement. Un **brouillon** n'a ni stock ni caisse : il se valide
 * définitivement (`POST /api/ventes/[id]/valider`) ou s'annule sans contrepartie,
 * et n'est jamais encaissable tant qu'il n'est pas validé.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { DatePicker } from '@/components/date-picker';
import { Tooltip } from '@/components/tooltip';
import { EmptyState, ErrorState, SkeletonTable } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { BrickTabs, useBrickScope } from '@/components/briqueterie/brick-tabs';
import { VentesTable } from '@/components/ventes/ventes-table';
import {
  VentesStatsCards,
  type VentesStats,
  type VentesStatsPeriod,
} from '@/components/ventes/ventes-stats-cards';
import {
  CancelSaleDialog,
  InvoiceDetailModal,
  SalePaymentModal,
  ValidateSaleDialog,
  normalizeInvoiceRow,
  readApiError,
  useInvoiceDetailLazy,
  type SalesInvoiceRow,
} from '@/components/ventes/ventes-modals';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';

const PAGE_LIMIT = 10;

/**
 * Clé d'état de vue **distincte** de celle de `/ventes` : les deux listes
 * partagent la même mécanique de restauration, mais pas les mêmes filtres. Avec
 * une clé commune, revenir de `/ventes` vers `/briqueterie/ventes` restaurerait
 * les filtres et la page de l'autre liste — et une période choisie ici
 * s'appliquerait là-bas.
 */
const VIEW_NAME = 'briqueterie-ventes';

const CUSTOMERS_LIMIT = 500;

/**
 * Canal de vente : filtre serveur sans lequel la liste et les statistiques
 * retomberaient sur le commerce général.
 */
const CHANNEL = 'brick';

type PaymentStatusFilter = 'all' | 'paid' | 'partial' | 'unpaid' | 'cancelled';

type ViewState = {
  search: string;
  page: number;
  paymentStatus: PaymentStatusFilter;
  customerId: string;
  from: string;
  to: string;
};

type CustomerOption = { id: number; name: string };

const PAYMENT_STATUS_OPTIONS = [
  { value: 'all', label: 'Toutes les ventes' },
  { value: 'paid', label: 'Payées' },
  { value: 'partial', label: 'Partielles' },
  { value: 'unpaid', label: 'Impayées' },
  { value: 'cancelled', label: 'Annulées' },
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

export default function VentesBriqueteriePage() {
  const router = useRouter();
  const canCreate = usePermission('sales.create');
  const canPay = usePermission('payments.create');
  const canCancel = usePermission('sales.cancel');
  /** `sales.update` : valider un brouillon sort le stock définitivement. */
  const canValidate = usePermission('sales.update');
  /**
   * `balances.view` : seul ce rôle reçoit et voit le **bénéfice** d'une vente.
   * Le serveur applique la même règle de son côté (`canViewSalesProfit`).
   */
  const canViewProfit = usePermission('balances.view');
  const { scope, setScope, storeParam, withStore, showStore } = useBrickScope();

  /* ------------------------------- État liste ------------------------------ */
  const [invoices, setInvoices] = useState<SalesInvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatusFilter>('all');
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);

  /* ---------------------------- Statistiques ------------------------------ */
  const [stats, setStats] = useState<VentesStats | null>(null);
  const [isStatsLoading, setIsStatsLoading] = useState(true);
  const [period, setPeriod] = useState<VentesStatsPeriod>('month');

  /* ------------------------------- Clients -------------------------------- */
  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  /* ------------------------------- Modales -------------------------------- */
  // Un état booléen par modale : aucune modale « mode ».
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showValidateModal, setShowValidateModal] = useState(false);

  const [activeInvoice, setActiveInvoice] = useState<SalesInvoiceRow | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isValidating, setIsValidating] = useState(false);

  const detail = useInvoiceDetailLazy(activeInvoice, showDetailModal, refreshToken);

  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
    if (typeof saved.search === 'string') setSearch(saved.search);
    if (isPaymentStatusFilter(saved.paymentStatus)) setPaymentStatus(saved.paymentStatus);
    if (typeof saved.customerId === 'string') setCustomerId(saved.customerId);
    if (typeof saved.from === 'string') setFrom(saved.from);
    if (typeof saved.to === 'string') setTo(saved.to);
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
          // Le canal est posé avant tout filtre : la page ne montre jamais le
          // commerce général, même si un filtre utilisateur l'écrasait.
          channel: CHANNEL,
          page: String(page),
          limit: String(PAGE_LIMIT),
        });
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (paymentStatus === 'cancelled') {
          params.set('status', 'cancelled');
        } else if (paymentStatus !== 'all') {
          params.set('paymentStatus', paymentStatus);
        }
        if (customerId) params.set('customerId', customerId);
        if (from) params.set('from', from);
        if (to) params.set('to', to);

        const response = await fetch(withStore(`/api/ventes?${params.toString()}`), {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, 'Les ventes de briques n’ont pas pu être chargées.'),
          );
        }

        const payload = (await response.json()) as {
          data?: unknown[];
          total?: number;
          totalPages?: number;
        };

        if (!active) return;

        const rows = Array.isArray(payload.data) ? payload.data.map(normalizeInvoiceRow) : [];
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
          caught instanceof Error
            ? caught.message
            : 'Les ventes de briques n’ont pas pu être chargées.',
        );
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, debouncedSearch, paymentStatus, customerId, from, to, page, refreshToken, storeParam, withStore]);

  /* Cartes de statistiques : un agrégat indisponible ne casse pas la liste. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    void (async () => {
      setIsStatsLoading(true);
      try {
        // `channel=brick` ici aussi : sinon les cartes compteraient le commerce
        // général et ne correspondraient plus du tout à la liste affichée.
        const response = await fetch(withStore(`/api/ventes/stats?period=${period}&channel=${CHANNEL}`), {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            await readApiError(response, 'Les statistiques n’ont pas pu être chargées.'),
          );
        }
        const payload = (await response.json()) as Partial<VentesStats>;
        if (!active) return;
        setStats({
          period: String(payload.period ?? period),
          count: Number(payload.count ?? 0),
          revenue: Number(payload.revenue ?? 0),
          totalHt: Number(payload.totalHt ?? 0),
          taxAmount: Number(payload.taxAmount ?? 0),
          collected: Number(payload.collected ?? 0),
          outstanding: Number(payload.outstanding ?? 0),
          averageBasket: Number(payload.averageBasket ?? 0),
          cancelledCount: Number(payload.cancelledCount ?? 0),
          topProducts: Array.isArray(payload.topProducts) ? payload.topProducts : [],
          byDay: Array.isArray(payload.byDay) ? payload.byDay : [],
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
  }, [rehydrated, period, refreshToken, storeParam, withStore]);

  /* Clients pour le filtre — liste tolérante : un échec laisse le filtre vide. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    void (async () => {
      try {
        const response = await fetch(`/api/clients?limit=${CUSTOMERS_LIMIT}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: { id: number; name: string }[] };
        if (!active) return;
        setCustomers(
          (Array.isArray(payload.data) ? payload.data : []).map((customer) => ({
            id: Number(customer.id),
            name: String(customer.name ?? ''),
          })),
        );
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setCustomers([]);
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
    writeViewState(VIEW_NAME, { search, page, paymentStatus, customerId, from, to });
  }, [rehydrated, search, page, paymentStatus, customerId, from, to]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  /* ------------------------------- Ouvertures ------------------------------ */

  const openDetailModal = (invoice: SalesInvoiceRow) => {
    setActiveInvoice(invoice);
    setShowDetailModal(true);
  };

  /* La fiche de vente est commune au commerce général et à la briqueterie :
     c'est elle qui porte les paiements, les reçus, l'impression et l'export. */
  const openInvoicePage = (invoice: SalesInvoiceRow) => {
    router.push(`/ventes/${invoice.id}`);
  };

  const openPaymentModal = (invoice: SalesInvoiceRow) => {
    setActiveInvoice(invoice);
    setShowDetailModal(false);
    setShowPaymentModal(true);
  };

  const openCancelModal = (invoice: SalesInvoiceRow) => {
    setActiveInvoice(invoice);
    setShowDetailModal(false);
    setShowCancelModal(true);
  };

  const openValidateModal = (invoice: SalesInvoiceRow) => {
    setActiveInvoice(invoice);
    setShowDetailModal(false);
    setShowValidateModal(true);
  };

  /**
   * Validation d'un brouillon : `POST /api/ventes/[id]/valider`.
   *
   * Le corps est vide : le serveur relit les lignes figées en base et contrôle
   * le stock au moment de la validation. Aucune ressaisie, donc, et aucun risque
   * qu'un brouillon validé diffère de ce qui avait été enregistré.
   */
  const handleValidate = async () => {
    if (!activeInvoice) return;
    setIsValidating(true);

    try {
      const response = await fetch(`/api/ventes/${activeInvoice.id}/valider`, {
        method: 'POST',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'La vente n’a pas pu être validée.'));
      }

      toast.success(`Vente ${activeInvoice.invoiceNumber} validée : le stock est à jour.`);
      setShowValidateModal(false);
      setActiveInvoice(null);
      refresh();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : 'La vente n’a pas pu être validée.',
        { autoClose: 8000 },
      );
    } finally {
      setIsValidating(false);
    }
  };

  /**
   * Annulation : `DELETE /api/ventes/[id]` (repli sur `POST …/annuler` si la
   * route imbriquée est la seule exposée) — **jamais** de suppression physique.
   *
   * Aucun contrôle de canal ici : le serveur vérifie que la vente visée est bien
   * accessible à l'utilisateur, et l'interface n'a pas à présumer du canal.
   */
  const handleCancel = async (reason: string) => {
    if (!activeInvoice) return;
    setIsCancelling(true);

    try {
      let response = await fetch(`/api/ventes/${activeInvoice.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason }),
      });

      if (response.status === 404 || response.status === 405) {
        response = await fetch(`/api/ventes/${activeInvoice.id}/annuler`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ reason }),
        });
      }

      if (!response.ok) {
        throw new Error(await readApiError(response, 'La vente n’a pas pu être annulée.'));
      }

      toast.success(`Vente ${activeInvoice.invoiceNumber} annulée.`);
      setShowCancelModal(false);
      setActiveInvoice(null);
      refresh();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : 'La vente n’a pas pu être annulée.',
        { autoClose: 8000 },
      );
    } finally {
      setIsCancelling(false);
    }
  };

  const hasFilters =
    Boolean(debouncedSearch) ||
    paymentStatus !== 'all' ||
    Boolean(customerId) ||
    Boolean(from) ||
    Boolean(to);

  const resetFilters = () => {
    setSearch('');
    setPaymentStatus('all');
    setCustomerId('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Briqueterie"
        title="Ventes de briques"
        description="Ventes de la briqueterie : encaissements, restes à payer, brouillons à valider et annulations motivées. Ces factures n’apparaissent pas dans la liste « Ventes » du commerce général."
        actions={
          canCreate ? (
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              // `canal=briqueterie` : c'est ce paramètre qui estampe la facture
              // en `channel = 'brick'` et la tient hors de la liste `/ventes`.
              onClick={() => router.push('/ventes/nouvelle?canal=briqueterie')}
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
              Nouvelle vente
            </button>
          ) : null
        }
      />

      <BrickTabs scope={scope} onScopeChange={setScope} />

      {/*
        Rappel discret : la confusion la plus coûteuse ici est de croire que ces
        ventes « manquent » dans `/ventes`. Jetons du thème uniquement, et aucun
        rôle fonctionnel — c'est un texte, pas un bouton.
      */}
      <p className="flex items-start gap-2 rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-xs leading-5 text-base-content/70 sm:text-sm">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="mt-0.5 h-4 w-4 shrink-0 text-info"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>
          Ces ventes appartiennent à la briqueterie ; elles n’apparaissent pas dans la liste
          <span className="mx-1 font-medium">/ventes</span>
          du commerce général.
        </span>
      </p>

      <VentesStatsCards
        stats={stats}
        isLoading={isStatsLoading}
        period={period}
        onPeriodChange={setPeriod}
      />

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        /*
         * « n° » et non « numéro » : la chaîne « numéro » fait classer ce champ
         * en CREDIT_CARD_NUMBER par la saisie automatique de Chrome, qui voit
         * alors un formulaire de carte bancaire dans la barre de filtres (et
         * affiche un avertissement sur une connexion non HTTPS). Vérifié dans
         * `chrome://autofill-internals`. Ne pas rétablir « numéro ».
         */
        searchPlaceholder="Rechercher un n° de facture ou un client…"
        filters={
          <div className="w-full sm:w-52">
            <FilterSelect
              value={paymentStatus}
              onChange={(value) => {
                setPaymentStatus(isPaymentStatusFilter(value) ? value : 'all');
                setPage(1);
              }}
              options={PAYMENT_STATUS_OPTIONS}
              placeholder="Toutes les ventes"
            />
          </div>
        }
        secondaryFilters={
          <>
            <label className="flex w-full flex-col gap-1 sm:w-56">
              <span className="text-xs text-base-content/60">Client</span>
              <select
                className="select select-bordered min-h-11 w-full sm:min-h-0"
                value={customerId}
                onChange={(event) => {
                  setCustomerId(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">Tous les clients</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex w-full flex-col gap-1 sm:w-40">
              <span className="text-xs text-base-content/60">Du</span>
              {/*
                « jj mois aaaa » et non « jj/mm/aaaa » : AGENTS.md invariant 10 —
                la chaîne « jj/mm/aaaa » fait classer le champ en
                CREDIT_CARD_EXP_* par Chrome, qui affiche alors l'avertissement
                « La saisie automatique des modes de paiement est désactivée… ».
              */}
              <DatePicker
                value={from}
                onChange={(value) => {
                  setFrom(value);
                  setPage(1);
                }}
                placeholder="jj mois aaaa"
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
                placeholder="jj mois aaaa"
              />
            </div>
          </>
        }
        secondaryCount={
          (customerId ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0)
        }
        actions={
          <>
            {hasFilters && (
              <Tooltip label="Réinitialiser les filtres">
                <ToolbarButton onClick={resetFilters}>
                  Réinitialiser
                </ToolbarButton>
              </Tooltip>
            )}
            <Tooltip label="Recharger la liste">
              <ToolbarButton onClick={refresh}>
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
            : `${formatNumber(total)} vente${total > 1 ? 's' : ''} ${
                total > 1 ? 'trouvées' : 'trouvée'
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
            title="Impossible de charger les ventes de briques"
            description={error}
            onRetry={refresh}
          />
        </div>
      ) : (
        <VentesTable
          data={invoices}
          isLoading={isLoading}
          canPay={canPay}
          canCancel={canCancel}
          canValidate={canValidate}
          canViewProfit={canViewProfit}
          showStore={showStore}
          onOpenDetail={openDetailModal}
          onOpenInvoice={openInvoicePage}
          onOpenPayment={openPaymentModal}
          onOpenCancel={openCancelModal}
          onOpenValidate={openValidateModal}
          emptyState={
            <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
              <EmptyState
                title={
                  hasFilters
                    ? 'Aucune vente de briques ne correspond'
                    : 'Aucune vente de briques enregistrée'
                }
                description={
                  hasFilters
                    ? 'Modifiez la recherche, le statut de paiement ou la période pour élargir les résultats.'
                    : 'Enregistrez la première vente de briques : le stock est déduit et l’encaissement enregistré automatiquement.'
                }
                action={
                  canCreate ? (
                    <button
                      type="button"
                      className="btn btn-primary min-h-11 sm:min-h-0"
                      onClick={() => router.push('/ventes/nouvelle?canal=briqueterie')}
                    >
                      Créer la première vente
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

      {/* Modales — une par état booléen. */}
      <InvoiceDetailModal
        isOpen={showDetailModal}
        onClose={() => setShowDetailModal(false)}
        invoice={activeInvoice}
        detail={detail}
        canValidate={canValidate}
        onOpenValidate={activeInvoice ? () => openValidateModal(activeInvoice) : undefined}
        onOpenPayment={
          activeInvoice ? () => openPaymentModal(activeInvoice) : undefined
        }
      />

      {activeInvoice && (
        <SalePaymentModal
          isOpen={showPaymentModal}
          onClose={() => setShowPaymentModal(false)}
          invoiceId={activeInvoice.id}
          documentNumber={activeInvoice.invoiceNumber}
          customerName={activeInvoice.customerName}
          remainingAmount={activeInvoice.remainingAmount}
          onRecorded={(payment) => {
            toast.success(`Paiement enregistré — reçu ${payment.receiptNumber}.`);
            refresh();
          }}
        />
      )}

      <CancelSaleDialog
        isOpen={showCancelModal}
        onClose={() => {
          if (!isCancelling) setShowCancelModal(false);
        }}
        onConfirm={handleCancel}
        invoice={activeInvoice}
        isSubmitting={isCancelling}
      />

      <ValidateSaleDialog
        isOpen={showValidateModal}
        onClose={() => {
          if (!isValidating) setShowValidateModal(false);
        }}
        onConfirm={handleValidate}
        invoice={activeInvoice}
        isSubmitting={isValidating}
      />
    </div>
  );
}
