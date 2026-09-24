'use client';

/**
 * Liste des commandes d'atelier (README §21, page `/atelier`).
 *
 * Structure imposée par §5 des conventions :
 *   `PageHeader` → cartes de synthèse → `DataToolbar` → `ResponsiveTable` →
 *   `Pagination` → modales (une par état booléen).
 *
 * Les cinq états sont couverts : `SkeletonTable` / `SkeletonCards` au
 * chargement, `EmptyState` avec action, `ErrorState` avec « Réessayer », l'état
 * nominal, et les toasts de retour d'action.
 *
 * ⚠️ Aucun import runtime d'un module serveur : `lib/furniture.ts` est importé
 * en `import type` uniquement (§11 bis des conventions).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
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
import type {
  FurnitureOrderDetail,
  FurnitureOrderRow,
  FurnitureModelRow,
  FurnitureStage,
  WorkshopSummary,
} from '@/lib/furniture';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, today } from '@/lib/format';
import {
  FurnitureOrderFormModal,
  fetchCustomers,
  fetchFurnitureModels,
  fetchProducts,
  type CustomerOption,
  type ProductOption,
} from '@/components/atelier/atelier-modals';

/* ------------------------------------------------------------------ *
 * Aides
 * ------------------------------------------------------------------ */

const ORDERS_LIMIT = 20;
const VIEW_NAME = 'atelier-commandes';

type Paginated<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type OrdersPayload = Paginated<FurnitureOrderRow> & { summary?: WorkshopSummary };

type AtelierViewState = {
  search: string;
  stage: string;
  customerId: string;
  lateOnly: boolean;
  from: string;
  to: string;
  page: number;
};

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as any)?.error ?? 'Requête impossible');
  return payload as T;
}

function buildQuery(entries: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/**
 * Étapes de production, dans l'ordre — **recopiées volontairement** depuis
 * `lib/furniture.ts`.
 *
 * ⚠️ Ce fichier est un composant client : importer `FURNITURE_STAGES` de
 * `lib/furniture.ts` à l'exécution entraînerait `@/db`, `fs` et `next/headers`
 * dans le bundle navigateur, ce qui casse `npm run build` (§11 bis des
 * conventions). Les valeurs ci-dessous sont la **liste d'affichage** du filtre ;
 * la source de vérité reste `lib/furniture.ts` côté serveur, qui valide de
 * toute façon l'étape reçue.
 */
const STAGE_OPTIONS: { value: FurnitureStage; label: string }[] = [
  { value: 'cutting', label: 'Découpe' },
  { value: 'assembly', label: 'Assemblage' },
  { value: 'sanding', label: 'Ponçage' },
  { value: 'painting', label: 'Peinture / vernis' },
  { value: 'finishing', label: 'Finition' },
  { value: 'delivered', label: 'Livré' },
];

const STAGE_LABELS: Record<string, string> = Object.fromEntries(
  STAGE_OPTIONS.map((option) => [option.value, option.label]),
);

/** Teinte et libellé d'une étape — jamais la couleur seule. */
function stageTone(stage: string): 'success' | 'warning' | 'info' | 'primary' | 'neutral' {
  switch (stage) {
    case 'delivered':
      return 'success';
    case 'finishing':
    case 'painting':
      return 'primary';
    case 'sanding':
    case 'assembly':
      return 'info';
    case 'cutting':
      return 'warning';
    default:
      return 'neutral';
  }
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function AtelierPage() {
  const router = useRouter();
  const canCreate = usePermission('furniture.create');

  /* Filtres */
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [stage, setStage] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [lateOnly, setLateOnly] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  /* Données */
  const [orders, setOrders] = useState<FurnitureOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [summary, setSummary] = useState<WorkshopSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  /* Options des sélecteurs */
  const [models, setModels] = useState<FurnitureModelRow[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [isOptionsLoading, setIsOptionsLoading] = useState(true);

  /* Modales — un état booléen chacune (§8.3) */
  const [isFormOpen, setIsFormOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* Options : une seule passe, elles ne changent pas avec les filtres. */
  useEffect(() => {
    const controller = new AbortController();
    setIsOptionsLoading(true);

    void Promise.all([
      fetchFurnitureModels(controller.signal).catch(() => [] as FurnitureModelRow[]),
      fetchCustomers(controller.signal).catch(() => [] as CustomerOption[]),
      fetchProducts(controller.signal).catch(() => [] as ProductOption[]),
    ])
      .then(([modelList, customerList, productList]) => {
        if (controller.signal.aborted) return;
        setModels(modelList);
        setCustomers(customerList);
        setProducts(productList);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsOptionsLoading(false);
      });

    return () => controller.abort();
  }, []);

  /* Liste + synthèse de la période en un seul aller-retour. */
  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    const query = buildQuery({
      search: debouncedSearch,
      stage,
      customerId: customerId ? Number(customerId) : undefined,
      lateOnly,
      from,
      to,
      page,
      limit: ORDERS_LIMIT,
      summary: true,
    });

    fetch(`/api/atelier/commandes?${query}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then((response) => readJson<OrdersPayload>(response))
      .then((payload) => {
        if (controller.signal.aborted) return;
        setOrders(Array.isArray(payload.data) ? payload.data : []);
        setTotal(Number(payload.total ?? 0));
        setTotalPages(Number(payload.totalPages ?? 1) || 1);
        if (payload.summary) setSummary(payload.summary);
        const corrected = clampPage(page, Number(payload.totalPages ?? 1) || 1);
        if (corrected !== null) setPage(corrected);
      })
      .catch((caught: any) => {
        if (caught?.name === 'AbortError') return;
        setError(caught?.message ?? 'Chargement des commandes impossible');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [debouncedSearch, stage, customerId, lateOnly, from, to, page, reloadToken]);

  const rehydrated = useViewStateRehydration<AtelierViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.stage !== undefined) setStage(saved.stage);
    if (saved.customerId !== undefined) setCustomerId(saved.customerId);
    if (saved.lateOnly !== undefined) setLateOnly(saved.lateOnly);
    if (saved.from !== undefined) setFrom(saved.from);
    if (saved.to !== undefined) setTo(saved.to);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, stage, customerId, lateOnly, from, to, page });
  }, [rehydrated, search, stage, customerId, lateOnly, from, to, page]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const stageOptions = useMemo(
    () => STAGE_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    [],
  );

  const customerOptions = useMemo(
    () => customers.map((customer) => ({ value: String(customer.id), label: customer.name })),
    [customers],
  );

  const activeFilterCount =
    (stage ? 1 : 0) + (customerId ? 1 : 0) + (lateOnly ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0);

  const columns = useMemo<Column<FurnitureOrderRow>[]>(
    () => [
      {
        key: 'orderNumber',
        label: 'N° commande',
        primary: true,
        render: (order) => (
          <div className="min-w-0">
            <Link
              href={`/atelier/${order.id}`}
              className="font-semibold text-primary hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {order.orderNumber}
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {order.isCancelled && <Badge tone="error">Annulée</Badge>}
              {!order.isCancelled && order.isDelivered && order.isLate && (
                <Badge tone="error">En retard</Badge>
              )}
              {!order.isCancelled && order.isDelivered && order.isDeliveredOnTime && (
                <Badge tone="success">Livré à temps</Badge>
              )}
              {!order.isCancelled &&
                !order.isDelivered &&
                order.promisedDate &&
                order.promisedDate < today() && <Badge tone="warning">Délai dépassé</Badge>}
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
        key: 'modelName',
        label: 'Modèle',
        render: (order) => (
          <span className="text-sm">
            {order.modelName}
            {order.isCustom && (
              <span className="ml-1">
                <Badge tone="info">Sur mesure</Badge>
              </span>
            )}
          </span>
        ),
      },
      {
        key: 'isCustom',
        label: 'Sur mesure',
        hideOnMobile: true,
        render: (order) => (
          <span className="text-sm text-base-content/70">{order.isCustom ? 'Oui' : 'Non'}</span>
        ),
      },
      {
        key: 'dimensions',
        label: 'Dimensions',
        hideOnMobile: true,
        render: (order) => (
          <span className="text-sm text-base-content/70">{order.dimensions || '—'}</span>
        ),
      },
      {
        key: 'promisedDate',
        label: 'Promis',
        className: 'whitespace-nowrap',
        render: (order) => (
          <span className="tabular text-sm text-base-content/70">
            {formatDateShort(order.promisedDate)}
          </span>
        ),
      },
      {
        key: 'deliveryDate',
        label: 'Livré',
        className: 'whitespace-nowrap',
        render: (order) => (
          <span className="tabular text-sm text-base-content/70">
            {formatDateShort(order.deliveryDate)}
          </span>
        ),
      },
      {
        key: 'stage',
        label: 'Étape',
        render: (order) => <Badge tone={stageTone(order.stage)}>{order.stageLabel}</Badge>,
      },
      {
        key: 'totalCost',
        label: 'Coût',
        className: 'text-right whitespace-nowrap',
        render: (order) => <MoneyText value={order.totalCost} />,
      },
      {
        key: 'agreedPrice',
        label: 'Prix convenu',
        hideOnMobile: true,
        className: 'text-right whitespace-nowrap',
        render: (order) => <MoneyText value={order.agreedPrice} bold />,
      },
      {
        key: 'margin',
        label: 'Marge',
        className: 'text-right whitespace-nowrap',
        render: (order) => (
          <MoneyText value={order.margin} colored bold={order.margin < 0} />
        ),
      },
    ],
    [],
  );

  function resetFilters() {
    setSearch('');
    setDebouncedSearch('');
    setStage('');
    setCustomerId('');
    setLateOnly(false);
    setFrom('');
    setTo('');
    setPage(1);
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Production"
        title="Atelier de meubles"
        description="Commandes de meubles standard ou sur mesure : suivi des étapes, matières consommées et chutes, main-d'œuvre, coût de revient et respect du délai promis."
        actions={
          <>
            <Link href="/atelier/modeles" className="btn btn-ghost min-h-11 border border-base-300 sm:min-h-0">
              Modèles
            </Link>
            {canCreate && (
              <button
                type="button"
                className="btn btn-primary min-h-11 sm:min-h-0"
                onClick={() => setIsFormOpen(true)}
              >
                Nouvelle commande
              </button>
            )}
          </>
        }
      />

      {/* 2 · Cartes de synthèse */}
      {isLoading && !summary ? (
        <SkeletonCards count={6} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <StatCardDelta
            label="En cours"
            tone="info"
            value={summary?.inProgress ?? 0}
            hint="Découpe à finition"
          />
          <StatCardDelta
            label="Livrés"
            tone="success"
            value={summary?.delivered ?? 0}
            hint="Sur la période"
          />
          <StatCardDelta
            label="Livrés à temps"
            tone="success"
            value={summary?.deliveredOnTime ?? 0}
            hint="Livraison ≤ date promise"
          />
          <StatCardDelta
            label="En retard"
            tone="error"
            value={summary?.late ?? 0}
            hint="Livrés après la date promise"
          />
          <StatCardDelta
            label="Chiffre d’affaires"
            tone="primary"
            value={<MoneyText value={summary?.revenue ?? 0} />}
            hint="Prix convenu des commandes actives"
          />
          <StatCardDelta
            label="Marge"
            tone={(summary?.margin ?? 0) < 0 ? 'error' : 'success'}
            value={<MoneyText value={summary?.margin ?? 0} colored />}
            hint={
              summary
                ? `Coût ${formatNumber(summary.totalCost)} GNF · ${formatNumber(summary.totalWastage, 2)} de chutes`
                : 'Coût de revient déduit'
            }
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
        searchPlaceholder="Rechercher un n° de commande, un client, un modèle…"
        filters={
          <>
            <FilterSelect
              value={stage}
              onChange={(value) => {
                setStage(value);
                setPage(1);
              }}
              options={stageOptions}
              placeholder="Toutes les étapes"
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
            <button
              type="button"
              onClick={() => {
                setLateOnly((current) => !current);
                setPage(1);
              }}
              aria-pressed={lateOnly}
              className={`btn min-h-11 ${lateOnly ? 'btn-error' : 'btn-ghost border border-base-300'}`}
            >
              En retard uniquement
            </button>
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
            {activeFilterCount > 0 && (
              <button type="button" className="btn btn-ghost min-h-11 border border-base-300" onClick={resetFilters}>
                Réinitialiser
              </button>
            )}
          </>
        }
        secondaryCount={activeFilterCount}
      />

      {(stage || customerId || lateOnly || from || to) && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/60">
          <span>Filtres actifs :</span>
          {stage && <Badge tone="primary">{STAGE_LABELS[stage] ?? stage}</Badge>}
          {customerId && (
            <Badge tone="info">
              {customers.find((customer) => String(customer.id) === customerId)?.name ?? 'Client'}
            </Badge>
          )}
          {lateOnly && <Badge tone="error">En retard uniquement</Badge>}
          {from && <Badge tone="neutral">Du {formatDateShort(from)}</Badge>}
          {to && <Badge tone="neutral">Au {formatDateShort(to)}</Badge>}
        </div>
      )}

      {/* 4 · Liste */}
      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <ErrorState title="Chargement des commandes impossible" description={error} onRetry={refresh} />
      ) : orders.length === 0 ? (
        <EmptyState
          title="Aucune commande d’atelier"
          description={
            activeFilterCount > 0 || debouncedSearch
              ? 'Aucune commande ne correspond à ces filtres.'
              : 'Créez la première commande : un modèle standard préremplit automatiquement ses matières depuis la nomenclature.'
          }
          action={
            activeFilterCount > 0 || debouncedSearch ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                Réinitialiser les filtres
              </button>
            ) : canCreate ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsFormOpen(true)}>
                Créer la première commande
              </button>
            ) : (
              <Link href="/atelier/modeles" className="btn btn-primary min-h-11">
                Voir les modèles
              </Link>
            )
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={columns}
            data={orders}
            getRowKey={(order) => order.id}
            tableClassName="table-sm"
            actions={(order) => (
              <ToolbarButton variant="primary" onClick={() => router.push(`/atelier/${order.id}`)}>
                Ouvrir
              </ToolbarButton>
            )}
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/50">
            {total} commande{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

      {/* 6 · Modales */}
      <FurnitureOrderFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSaved={(detail: FurnitureOrderDetail) => {
          toast.success(
            `Commande ${detail.order.orderNumber} créée — ${detail.materials.length} matière(s) préremplie(s).`,
          );
          setIsFormOpen(false);
          refresh();
        }}
        models={models.filter((model) => model.isActive)}
        customers={customers}
        products={products}
        isOptionsLoading={isOptionsLoading}
      />
    </div>
  );
}
