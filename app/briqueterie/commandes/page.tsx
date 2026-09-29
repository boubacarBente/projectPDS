'use client';

/**
 * Liste des commandes clients de briques (README §20, page `/briqueterie/commandes`).
 *
 * Structure imposée par §5 des conventions :
 *   `PageHeader` → cartes de synthèse → `DataToolbar` → `ResponsiveTable` →
 *   `Pagination` → modales (une par état booléen).
 *
 * Les cinq états sont couverts : `SkeletonTable` / `SkeletonCards` au
 * chargement, `EmptyState` avec action, `ErrorState` avec « Réessayer », l'état
 * nominal, et les toasts de retour d'action.
 *
 * ## Ce que cette liste ne fait pas
 *
 * Elle **n'écrit jamais le stock** : une commande est un engagement commercial.
 * Le seul geste qui touche le stock et le chiffre d'affaires est la
 * **facturation**, et il vit sur la fiche (`/briqueterie/commandes/[id]`), avec
 * sa confirmation explicite — pas sur une ligne de liste.
 *
 * ⚠️ Aucun import runtime d'un module serveur : `lib/brick-orders.ts` importe
 * `@/db`. Types, libellés et appels d'API viennent de
 * `components/briqueterie/commandes-modals.tsx`, qui redéclare le JSON de
 * l'API (§11 bis des conventions).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { IconAction, RowActions } from '@/components/row-actions';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  EmptyState,
  ErrorState,
  MoneyText,
  QuantityText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { BrickTabs } from '@/components/briqueterie/brick-tabs';
import { useViewStateRehydration, writeViewState, clampPage } from '@/lib/view-state';
import { formatDateShort } from '@/lib/date-format';
import {
  BRICK_ORDER_NEXT_STATUSES,
  BRICK_ORDER_STATUS_LABELS,
  BRICK_ORDER_STATUS_OPTIONS,
  BRICK_ORDER_STATUS_TONES,
  BrickOrderCancelDialog,
  BrickOrderFormModal,
  BrickOrderPaymentModal,
  BrickOrderStatusDialog,
  brickOrderStatusLabel,
  readApiError,
  useBrickOrderOptions,
  type BrickOrderRow,
  type BrickOrderStatus,
  type Paginated,
} from '@/components/briqueterie/commandes-modals';

/* ------------------------------------------------------------------ *
 * Aides
 * ------------------------------------------------------------------ */

const ORDERS_LIMIT = 20;

/** Clé d'état de vue — doit rester stable pour que le retour arrière restaure. */
const VIEW_NAME = 'briqueterie-commandes';

type OrdersViewState = {
  search: string;
  status: string;
  customerId: string;
  from: string;
  to: string;
  page: number;
};

/** Compteurs par statut : `GET /api/briqueterie/tableau-de-bord` (`orders`). */
type OrdersSummary = Record<BrickOrderStatus, number>;

function buildQuery(entries: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function BrickOrdersPage() {
  const router = useRouter();
  const canCreate = usePermission('brick.create');
  const canUpdate = usePermission('brick.update');
  const canDelete = usePermission('brick.delete');
  const canCollect = usePermission('brick.update');

  /* Filtres */
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  /* Données */
  const [orders, setOrders] = useState<BrickOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  /* Synthèse par statut (une seule requête : le tableau de bord) */
  const [summary, setSummary] = useState<OrdersSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryToken, setSummaryToken] = useState(0);

  /* Types de briques et clients : chargés une fois, partagés par les modales. */
  const {
    brickTypes,
    customers,
    isLoading: isOptionsLoading,
    refresh: refreshOptions,
  } = useBrickOrderOptions();

  /* Modales — un état booléen chacune (§8.3 règle 1) */
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [targetOrder, setTargetOrder] = useState<BrickOrderRow | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /* Débounce de la recherche (300 ms, §5) */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* Synthèse : le tableau de bord renvoie les compteurs de **tous** les
     statuts en un aller-retour, y compris les commandes annulées. */
  useEffect(() => {
    const controller = new AbortController();
    setSummaryLoading(true);
    setSummaryError(null);

    fetch('/api/briqueterie/tableau-de-bord', {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Synthèse indisponible.'));
        }
        return (await response.json()) as { orders?: Partial<OrdersSummary> };
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setSummary(payload.orders ? (payload.orders as OrdersSummary) : null);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setSummaryError(caught instanceof Error ? caught.message : 'Synthèse indisponible.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSummaryLoading(false);
      });

    return () => controller.abort();
  }, [summaryToken, reloadToken]);

  /* Liste paginée */
  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    const query = buildQuery({
      search: debouncedSearch,
      status,
      customerId: customerId ? Number(customerId) : undefined,
      from,
      to,
      page,
      limit: ORDERS_LIMIT,
    });

    fetch(`/api/briqueterie/commandes?${query}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Chargement des commandes impossible.'));
        }
        return (await response.json()) as Paginated<BrickOrderRow>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setOrders(Array.isArray(payload.data) ? payload.data : []);
        setTotal(Number(payload.total ?? 0));
        const pages = Number(payload.totalPages ?? 1) || 1;
        setTotalPages(pages);
        const corrected = clampPage(page, pages);
        if (corrected !== null) setPage(corrected);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Chargement des commandes impossible.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [debouncedSearch, status, customerId, from, to, page, reloadToken]);

  /* Restauration de l'état au retour arrière (§5) */
  const rehydrated = useViewStateRehydration<OrdersViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.status !== undefined) setStatus(saved.status);
    if (saved.customerId !== undefined) setCustomerId(saved.customerId);
    if (saved.from !== undefined) setFrom(saved.from);
    if (saved.to !== undefined) setTo(saved.to);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, status, customerId, from, to, page });
  }, [rehydrated, search, status, customerId, from, to, page]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
    setSummaryToken((token) => token + 1);
  }, []);

  /* ------------------------------------------------------------------ *
   * Actions de ligne
   * ------------------------------------------------------------------ */

  /** Change l'état par `PUT { action: 'set_status' }`. */
  const confirmStatusChange = useCallback(
    async (status: BrickOrderStatus) => {
      if (!targetOrder) return;

      setIsSubmitting(true);
      try {
        const response = await fetch(`/api/briqueterie/commandes/${targetOrder.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'set_status', status }),
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'Le changement d’état a échoué.'));
        }

        const updated = (await response.json()) as BrickOrderRow;
        toast.success(`Commande ${updated.orderNumber} — ${brickOrderStatusLabel(updated.status)}.`);
        setIsStatusOpen(false);
        setTargetOrder(null);
        refresh();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : 'Le changement d’état a échoué.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [targetOrder, refresh],
  );

  /** Annulation motivée : `DELETE` avec motif obligatoire (jamais de suppression). */
  const confirmCancel = useCallback(
    async (reason: string) => {
      if (!targetOrder) return;

      setIsSubmitting(true);
      try {
        const response = await fetch(`/api/briqueterie/commandes/${targetOrder.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ reason }),
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'L’annulation a échoué.'));
        }

        const cancelled = (await response.json()) as BrickOrderRow;
        toast.success(
          `Commande ${cancelled.orderNumber} annulée — elle reste consultable, rien n’est supprimé.`,
        );
        setIsCancelOpen(false);
        setTargetOrder(null);
        refresh();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : 'L’annulation a échoué.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [targetOrder, refresh],
  );

  /* ------------------------------------------------------------------ *
   * Colonnes
   * ------------------------------------------------------------------ */

  const customerOptions = useMemo(
    () => customers.map((customer) => ({ value: String(customer.id), label: customer.name })),
    [customers],
  );

  const columns = useMemo<Column<BrickOrderRow>[]>(
    () => [
      {
        // §5.5 règle 8 : la **date propre** de la ligne ouvre la liste. Les
        // dates dérivées (livraison promise, échéance) restent à leur place.
        key: 'date',
        label: 'Date',
        className: 'whitespace-nowrap',
        render: (order) => (
          <span className="tabular text-sm text-base-content/70">{formatDateShort(order.date)}</span>
        ),
      },
      {
        key: 'orderNumber',
        label: 'N° commande',
        primary: true,
        render: (order) => (
          <div className="min-w-0">
            <Link
              href={`/briqueterie/commandes/${order.id}`}
              className="font-mono text-sm font-semibold text-primary hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {order.orderNumber}
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Badge tone={BRICK_ORDER_STATUS_TONES[order.status]}>
                {brickOrderStatusLabel(order.status)}
              </Badge>
              {order.salesInvoiceNumber && (
                <Badge tone="success">Facturée {order.salesInvoiceNumber}</Badge>
              )}
              {order.isCancelled && order.cancelReason && (
                <span className="text-[11px] text-error">Motif : {order.cancelReason}</span>
              )}
            </div>
          </div>
        ),
      },
      {
        key: 'customerName',
        label: 'Client',
        render: (order) => <span className="text-sm">{order.customerName}</span>,
      },
      {
        key: 'promisedDate',
        label: 'Livraison promise',
        hideOnMobile: true,
        className: 'whitespace-nowrap',
        render: (order) => (
          <span className="tabular text-sm text-base-content/70">
            {formatDateShort(order.promisedDate)}
          </span>
        ),
      },
      {
        key: 'dueDate',
        label: 'Échéance',
        hideOnMobile: true,
        className: 'whitespace-nowrap',
        render: (order) => (
          <span className="tabular text-sm text-base-content/70">
            {formatDateShort(order.dueDate)}
          </span>
        ),
      },
      {
        key: 'quantityOrdered',
        label: 'Quantité',
        className: 'text-right whitespace-nowrap',
        render: (order) => (
          <div className="text-right">
            <QuantityText value={order.quantityOrdered} />
            <div className="text-[11px] text-base-content/50">
              Livré <QuantityText value={order.quantityDelivered} />
            </div>
          </div>
        ),
      },
      {
        key: 'total',
        label: 'Total',
        className: 'text-right whitespace-nowrap',
        render: (order) => <MoneyText value={order.total} bold />,
      },
      {
        key: 'amountPaid',
        label: 'Payé',
        hideOnMobile: true,
        className: 'text-right whitespace-nowrap',
        render: (order) => <MoneyText value={order.amountPaid} />,
      },
      {
        key: 'remainingAmount',
        label: 'Reste à payer',
        className: 'text-right whitespace-nowrap',
        render: (order) => {
          /* « Ce reste est-il payable ? » — la question que pose `MoneyText
             remaining`. Une commande annulée ou facturée n'est plus
             encaissable, un brouillon ne l'est pas encore : leur reste reste
             neutre même non nul, sinon le rouge serait un faux signal. */
          const payable =
            !order.isCancelled &&
            !order.salesInvoiceId &&
            order.status !== 'draft' &&
            order.remainingAmount > 0.001;

          return (
            <div className="text-right">
              <MoneyText
                value={order.remainingAmount}
                remaining={payable}
                bold={order.remainingAmount > 0.001}
              />
              {order.remainingAmount <= 0.001 && !order.isCancelled && !order.salesInvoiceId && (
                <div className="text-[11px] text-base-content/50">Soldée</div>
              )}
            </div>
          );
        },
      },
    ],
    [],
  );

  /* ------------------------------------------------------------------ *
   * Filtres
   * ------------------------------------------------------------------ */

  const activeFilterCount =
    (status ? 1 : 0) + (customerId ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0);

  const resetFilters = useCallback(() => {
    setSearch('');
    setDebouncedSearch('');
    setStatus('');
    setCustomerId('');
    setFrom('');
    setTo('');
    setPage(1);
  }, []);

  const summaryCards: { status: BrickOrderStatus; label: string; hint: string }[] = [
    { status: 'draft', label: 'Brouillons', hint: 'À confirmer avec le client' },
    { status: 'confirmed', label: 'Confirmées', hint: 'Engagées, pas encore lancées' },
    { status: 'in_production', label: 'En production', hint: 'Fabrication en cours' },
    { status: 'ready', label: 'Prêtes', hint: 'À livrer au client' },
    { status: 'partially_delivered', label: 'Partiellement livrées', hint: 'Livraison incomplète' },
    { status: 'delivered', label: 'Livrées', hint: 'Tout est parti chez le client' },
    { status: 'cancelled', label: 'Annulées', hint: 'Motif conservé, rien n’est supprimé' },
  ];

  /* ------------------------------------------------------------------ *
   * Rendu
   * ------------------------------------------------------------------ */

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Briqueterie"
        title="Commandes de briques"
        description="Engagements clients : quantités, prix négociés, remise, acomptes et livraisons. Une commande ne touche jamais le stock — c’est la facturation qui le sort et fait entrer le chiffre d’affaires."
        actions={
          <>
            <Link href="/briqueterie" className="btn btn-ghost min-h-11 border border-base-300">
              Lots de fabrication
            </Link>
            {canCreate && (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => setIsCreateOpen(true)}
              >
                Nouvelle commande
              </button>
            )}
          </>
        }
      />

      <BrickTabs />

      {/* 2 · Cartes de synthèse par statut */}
      {summaryLoading && !summary ? (
        <SkeletonCards count={7} />
      ) : summaryError ? (
        <ErrorState
          title="Synthèse indisponible"
          description={summaryError}
          onRetry={() => setSummaryToken((token) => token + 1)}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
          {summaryCards.map((card) => (
            <StatCardDelta
              key={card.status}
              label={card.label}
              tone={BRICK_ORDER_STATUS_TONES[card.status]}
              value={summary?.[card.status] ?? 0}
              hint={card.hint}
            />
          ))}
        </div>
      )}

      {/* 3 · Barre d'outils */}
      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        /* « n° » et non « numéro » : la chaîne « numéro » fait classer le champ
           en CREDIT_CARD_NUMBER par Chrome (AGENTS.md, invariant 10). */
        searchPlaceholder="Rechercher un n° de commande, un client, une note…"
        filters={
          <>
            <FilterSelect
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={BRICK_ORDER_STATUS_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              placeholder="Tous les états"
            />
            <FilterSelect
              value={customerId}
              onChange={(value) => {
                setCustomerId(value);
                setPage(1);
              }}
              options={customerOptions}
              placeholder="Tous les clients"
            />
          </>
        }
        secondaryFilters={
          <>
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
            {(from || to) && (
              <button
                type="button"
                className="btn btn-ghost min-h-11 border border-base-300"
                onClick={() => {
                  setFrom('');
                  setTo('');
                  setPage(1);
                }}
              >
                Effacer la période
              </button>
            )}
          </>
        }
        secondaryCount={(from ? 1 : 0) + (to ? 1 : 0)}
      />

      {(status || customerId || from || to || debouncedSearch) && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/60">
          <span>Filtres actifs :</span>
          {debouncedSearch && <Badge tone="info">Recherche : {debouncedSearch}</Badge>}
          {status && (
            <Badge tone={BRICK_ORDER_STATUS_TONES[status as BrickOrderStatus]}>
              {BRICK_ORDER_STATUS_LABELS[status as BrickOrderStatus] ?? status}
            </Badge>
          )}
          {customerId && (
            <Badge tone="primary">
              {customers.find((customer) => String(customer.id) === customerId)?.name ?? 'Client'}
            </Badge>
          )}
          {(from || to) && (
            <Badge tone="neutral">
              {from ? formatDateShort(from) : '…'} → {to ? formatDateShort(to) : '…'}
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
        <ErrorState
          title="Chargement des commandes impossible"
          description={error}
          onRetry={refresh}
        />
      ) : orders.length === 0 ? (
        <EmptyState
          title="Aucune commande de briques"
          description={
            activeFilterCount > 0 || debouncedSearch
              ? 'Aucune commande ne correspond à ces filtres. Élargissez la période ou réinitialisez la recherche.'
              : 'Créez la première commande : un client, plusieurs types de briques, un prix négocié. Elle ne sortira le stock qu’à sa facturation.'
          }
          action={
            activeFilterCount > 0 || debouncedSearch ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                Réinitialiser les filtres
              </button>
            ) : canCreate ? (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => setIsCreateOpen(true)}
              >
                Créer la première commande
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={columns}
            data={orders}
            getRowKey={(order) => order.id}
            tableClassName="table-sm"
            actions={(order) => {
              /* « Partiellement livrée » et « Livrée » ne s'obtiennent **pas**
                 par un saut d'état : c'est la livraison, saisie sur la fiche,
                 qui pose le statut d'après les quantités réellement parties. On
                 ne les propose donc pas ici. */
              const nextStates = (BRICK_ORDER_NEXT_STATUSES[order.status] ?? []).filter(
                (state) => state !== 'delivered' && state !== 'partially_delivered',
              );
              const payable =
                canCollect && !order.isCancelled && !order.salesInvoiceId && order.status !== 'draft';

              return (
                <RowActions>
                  <IconAction
                    icon="view"
                    tone="primary"
                    label="Ouvrir la fiche de la commande"
                    onClick={() => router.push(`/briqueterie/commandes/${order.id}`)}
                  />
                  {/* Changer d'état : ouvre une confirmation. Un seul bouton par
                      ligne — une icône par état atteignable noierait les
                      chiffres, et la fiche les nomme en toutes lettres. */}
                  {canUpdate && nextStates.length > 0 && !order.isCancelled && (
                    <IconAction
                      icon="advance"
                      label={`Changer l’état (${nextStates
                        .map((state) => BRICK_ORDER_STATUS_LABELS[state])
                        .join(' ou ')})`}
                      onClick={() => {
                        setTargetOrder(order);
                        setIsStatusOpen(true);
                      }}
                    />
                  )}
                  {payable && (
                    <IconAction
                      icon="pay"
                      label="Encaisser un acompte"
                      onClick={() => {
                        setTargetOrder(order);
                        setIsPaymentOpen(true);
                      }}
                    />
                  )}
                  {canDelete && !order.isCancelled && !order.salesInvoiceId && (
                    <IconAction
                      icon="cancel"
                      tone="danger"
                      label="Annuler la commande (motif obligatoire)"
                      onClick={() => {
                        setTargetOrder(order);
                        setIsCancelOpen(true);
                      }}
                    />
                  )}
                </RowActions>
              );
            }}
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/50">
            {total} commande{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

      {/* 6 · Modales — un état booléen chacune */}
      <BrickOrderFormModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSaved={() => {
          setIsCreateOpen(false);
          setPage(1);
          refresh();
        }}
        brickTypes={brickTypes}
        customers={customers}
        isOptionsLoading={isOptionsLoading}
        onCustomersChanged={refreshOptions}
      />

      <BrickOrderStatusDialog
        isOpen={isStatusOpen}
        onClose={() => {
          setIsStatusOpen(false);
          setTargetOrder(null);
        }}
        onConfirm={confirmStatusChange}
        order={targetOrder}
        isSubmitting={isSubmitting}
      />

      <BrickOrderPaymentModal
        isOpen={isPaymentOpen}
        onClose={() => {
          setIsPaymentOpen(false);
          setTargetOrder(null);
        }}
        order={targetOrder}
        onRecorded={() => refresh()}
      />

      <BrickOrderCancelDialog
        isOpen={isCancelOpen}
        onClose={() => {
          if (isSubmitting) return;
          setIsCancelOpen(false);
          setTargetOrder(null);
        }}
        onConfirm={confirmCancel}
        order={targetOrder}
        isSubmitting={isSubmitting}
      />
    </div>
  );
}
