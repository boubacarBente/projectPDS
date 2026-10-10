'use client';

/**
 * Historique de l'ancien atelier de meubles, dans la filiale Meuble
 * (README §29, §31.9 ; ancienne page `/atelier`).
 *
 * Le module `/atelier` est supprimé : ses commandes restent consultables ici
 * et celles en cours s'achèvent (étapes, matières, équipe, encaissements) sur
 * leur fiche. Aucune nouvelle commande d'atelier : le nouveau travail passe par
 * les productions et commandes de la filiale. Portée de magasins commune aux
 * onglets de la filiale.
 *
 * ⚠️ Aucun import runtime de `lib/furniture.ts` (serveur) : types en
 * `import type`, constantes depuis `lib/furniture-shared.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BrickTabs, useBrickScope } from '@/components/briqueterie/brick-tabs';
import { useBranch } from '@/components/filiales/branch-context';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { IconAction } from '@/components/row-actions';
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
import { StoreTag } from '@/components/store-scope';
import { useViewStateRehydration, writeViewState, clampPage } from '@/lib/view-state';
import type { FurnitureOrderRow, WorkshopSummary } from '@/lib/furniture';
import { FURNITURE_STAGES, FURNITURE_STAGE_LABELS, type FurnitureStage } from '@/lib/furniture-shared';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, formatQuantity } from '@/lib/format';

const ORDERS_LIMIT = 20;
const VIEW_NAME = 'atelier-commandes';

type Paginated<T> = { data: T[]; total: number; page: number; limit: number; totalPages: number };

type AtelierViewState = {
  search: string;
  stage: string;
  purpose: string;
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

const STAGE_OPTIONS = FURNITURE_STAGES.map((value) => ({ value, label: FURNITURE_STAGE_LABELS[value] }));

const PURPOSE_OPTIONS = [
  { value: 'customer', label: 'Commandes clients' },
  { value: 'stock', label: 'Fabrication pour le stock' },
];

/** Teinte d'une étape — toujours accompagnée de son libellé (jamais la couleur seule). */
function stageTone(order: FurnitureOrderRow): 'success' | 'warning' | 'info' | 'primary' | 'neutral' | 'error' {
  if (order.isCancelled) return 'error';
  const tones: Record<FurnitureStage, 'success' | 'warning' | 'info' | 'primary'> = {
    cutting: 'warning',
    assembly: 'info',
    sanding: 'info',
    painting: 'primary',
    finishing: 'primary',
    delivered: 'success',
  };
  return tones[order.stage] ?? 'neutral';
}

export default function AtelierHistoryPage() {
  const router = useRouter();
  const { href, branch } = useBranch();
  const { scope, setScope, storeParam, showStore } = useBrickScope();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [stage, setStage] = useState('');
  const [purpose, setPurpose] = useState('');
  const [lateOnly, setLateOnly] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const [orders, setOrders] = useState<FurnitureOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [summary, setSummary] = useState<WorkshopSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* Synthèse de la période (indépendante de la pagination). */
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/atelier/commandes?${buildQuery({ stats: 1, from, to, store: storeParam })}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then((response) => readJson<{ summary: WorkshopSummary }>(response))
      .then((payload) => {
        if (!controller.signal.aborted) setSummary(payload.summary);
      })
      .catch(() => {
        /* la liste affiche déjà l'erreur éventuelle */
      });
    return () => controller.abort();
  }, [from, to, storeParam, reloadToken]);

  const rehydrated = useViewStateRehydration<AtelierViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.stage !== undefined) setStage(saved.stage);
    if (saved.purpose !== undefined) setPurpose(saved.purpose);
    if (saved.lateOnly !== undefined) setLateOnly(saved.lateOnly);
    if (saved.from !== undefined) setFrom(saved.from);
    if (saved.to !== undefined) setTo(saved.to);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const query = buildQuery({
      search: debouncedSearch,
      stage,
      purpose,
      late: lateOnly ? 1 : undefined,
      from,
      to,
      page,
      limit: ORDERS_LIMIT,
      includeCancelled: 1,
      store: storeParam,
    });
    fetch(`/api/atelier/commandes?${query}`, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      .then((response) => readJson<Paginated<FurnitureOrderRow>>(response))
      .then((payload) => {
        if (controller.signal.aborted) return;
        setOrders(Array.isArray(payload.data) ? payload.data : []);
        setTotal(Number(payload.total ?? 0));
        setTotalPages(Number(payload.totalPages ?? 1) || 1);
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
  }, [rehydrated, debouncedSearch, stage, purpose, lateOnly, from, to, page, storeParam, reloadToken]);

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, stage, purpose, lateOnly, from, to, page });
  }, [rehydrated, search, stage, purpose, lateOnly, from, to, page]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const withCosts = orders.some((order) => order.margin !== null) || (summary?.margin ?? null) !== null;
  const activeFilterCount = (stage ? 1 : 0) + (purpose ? 1 : 0) + (lateOnly ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0);

  const columns = useMemo<Column<FurnitureOrderRow>[]>(() => {
    const list: Column<FurnitureOrderRow>[] = [
      {
        // Invariant 8 : la date propre de la ligne en premier.
        key: 'startDate',
        label: 'Début',
        className: 'whitespace-nowrap',
        render: (order) => <span className="tabular text-sm">{formatDateShort(order.startDate)}</span>,
      },
      {
        key: 'orderNumber',
        label: 'N° commande',
        primary: true,
        render: (order) => (
          <div className="min-w-0">
            <Link
              href={href(`/atelier/${order.id}`)}
              className="font-semibold text-primary hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {order.orderNumber}
            </Link>
            <StoreTag name={order.storeName} show={showStore} />
            {order.isLate && !order.isCancelled && (
              <div className="mt-1">
                <Badge tone="error">En retard</Badge>
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'customerName',
        label: 'Pour',
        render: (order) =>
          order.purpose === 'stock' ? (
            <Badge tone="neutral">Stock du magasin</Badge>
          ) : (
            <span className="text-sm">{order.customerName}</span>
          ),
      },
      {
        key: 'modelName',
        minScreen: '2xl',
        label: 'Meuble',
        render: (order) => (
          <div className="min-w-0 text-sm">
            <span className="block truncate">
              {formatQuantity(order.quantity)} × {order.modelName}
            </span>
            {order.isCustom && <span className="text-xs text-base-content/60">Sur mesure{order.dimensions ? ` · ${order.dimensions}` : ''}</span>}
          </div>
        ),
      },
      {
        key: 'promisedDate',
        minScreen: '2xl',
        label: 'Promis',
        hideOnMobile: true,
        className: 'whitespace-nowrap',
        render: (order) => <span className="tabular text-sm text-base-content/70">{formatDateShort(order.promisedDate)}</span>,
      },
      {
        key: 'stage',
        label: 'Étape',
        render: (order) => <Badge tone={stageTone(order)}>{order.stageLabel}</Badge>,
      },
      {
        key: 'total',
        minScreen: '2xl',
        label: 'Prix convenu',
        className: 'text-right whitespace-nowrap',
        render: (order) => (order.purpose === 'stock' ? <span className="text-sm text-base-content/50">—</span> : <MoneyText value={order.total} bold />),
      },
      {
        key: 'remainingAmount',
        label: 'Reste',
        className: 'text-right whitespace-nowrap',
        render: (order) =>
          order.purpose === 'stock' ? (
            <span className="text-sm text-base-content/50">—</span>
          ) : (
            <MoneyText value={order.remainingAmount} remaining={order.status === 'active'} />
          ),
      },
    ];
    if (withCosts) {
      list.push({
        key: 'margin',
        minScreen: '2xl',
        label: 'Marge',
        hideOnMobile: true,
        className: 'text-right whitespace-nowrap',
        render: (order) =>
          order.margin === null ? <span className="text-sm text-base-content/50">—</span> : <MoneyText value={order.margin} colored />,
      });
    }
    return list;
  }, [showStore, withCosts]);

  function resetFilters() {
    setSearch('');
    setDebouncedSearch('');
    setStage('');
    setPurpose('');
    setLateOnly(false);
    setFrom('');
    setTo('');
    setPage(1);
  }

  return (
    <div className="mx-auto w-full max-w-7xl 2xl:max-w-[100rem] space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow={branch.name}
        title="Atelier — historique"
        description="Commandes de l’ancien module « Atelier de meubles », reprises par cette filiale. Les commandes en cours s’achèvent depuis leur fiche (étapes, matières, équipe, encaissements) ; tout nouveau travail se saisit dans Productions et Commandes."
      />
      <BrickTabs
        scope={scope}
        onScopeChange={(value) => {
          setScope(value);
          setPage(1);
        }}
      />

      {!summary ? (
        <SkeletonCards count={6} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <StatCardDelta
            label="En fabrication"
            tooltip="Commandes non annulées qui ne sont pas encore livrées ni mises en stock (de la découpe à la finition)."
            tone="info"
            value={formatNumber(summary.inProgress)}
            hint={`${formatNumber(summary.cancelled)} annulée(s)`}
          />
          <StatCardDelta
            label="Terminées"
            tooltip="Commandes livrées au client ou meubles mis en stock, parmi les commandes commencées sur la période."
            tone="success"
            value={formatNumber(summary.delivered)}
            hint={`${formatNumber(summary.deliveredOnTime)} dans le délai promis`}
          />
          <StatCardDelta
            label="En retard"
            tooltip="Commandes livrées après la date promise, ou pas encore livrées alors que la date promise est passée."
            tone={summary.late > 0 ? 'error' : 'success'}
            value={formatNumber(summary.late)}
            hint={summary.late > 0 ? 'À relancer' : 'Aucun retard'}
          />
          <StatCardDelta
            label="Prix convenus"
            tooltip="Total des prix convenus avec les clients pour les commandes non annulées. Les fabrications pour le stock n’y sont pas : elles ne sont pas vendues."
            tone="primary"
            value={<MoneyText value={summary.revenue} />}
            hint="Commandes clients"
          />
          <StatCardDelta
            label="Reste à encaisser"
            tooltip="Ce que les clients doivent encore sur ces commandes : prix convenu moins les acomptes et paiements reçus."
            tone={summary.outstanding > 0 ? 'error' : 'success'}
            value={<MoneyText value={summary.outstanding} remaining bold />}
            hint="Acomptes déduits"
          />
          {summary.margin !== null ? (
            <StatCardDelta
              label="Marge"
              tooltip="Prix convenus moins le coût de revient des commandes clients : matières au coût d’achat (chutes comprises) et journées de l’équipe."
              tone={summary.margin >= 0 ? 'success' : 'error'}
              value={<MoneyText value={summary.margin} colored />}
              hint={`${formatNumber(summary.totalWastage, 2)} de chutes sur la période`}
            />
          ) : (
            <StatCardDelta
              label="Chutes"
              tooltip="Quantité de matière perdue en chutes et pertes sur les commandes de la période, toutes unités confondues."
              tone="warning"
              value={formatNumber(summary.totalWastage, 2)}
              hint="Bois et matières perdus"
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
        searchPlaceholder="Rechercher un n° de commande, un client, un modèle…"
        filters={
          <>
            <div className="w-full sm:w-48">
              <FilterSelect
                value={stage}
                onChange={(value) => {
                  setStage(value);
                  setPage(1);
                }}
                options={STAGE_OPTIONS}
                placeholder="Toutes les étapes"
              />
            </div>
          </>
        }
        secondaryFilters={
          <>
            <div className="w-full sm:w-56">
              <FilterSelect
                value={purpose}
                onChange={(value) => {
                  setPurpose(value);
                  setPage(1);
                }}
                options={PURPOSE_OPTIONS}
                placeholder="Clients et stock"
              />
            </div>
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
            <DatePicker
              value={from}
              onChange={(value) => {
                setFrom(value);
                setPage(1);
              }}
              placeholder="Commencées du"
            />
            <DatePicker
              value={to}
              onChange={(value) => {
                setTo(value);
                setPage(1);
              }}
              placeholder="au"
            />
            {activeFilterCount > 0 && (
              <button type="button" className="btn btn-ghost min-h-11 border border-base-300" onClick={resetFilters}>
                Réinitialiser
              </button>
            )}
          </>
        }
        secondaryCount={activeFilterCount}
      />

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
              : 'L’ancien atelier n’avait aucune commande dans cette portée de magasins.'
          }
          action={
            activeFilterCount > 0 || debouncedSearch ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                Réinitialiser les filtres
              </button>
            ) : (
              <Link href={href('/productions')} className="btn btn-primary min-h-11">
                Voir les productions
              </Link>
            )
          }
        />
      ) : (
        <>
          <ResponsiveTable cardsBelow="xl"
            columns={columns}
            data={orders}
            getRowKey={(order) => order.id}
            onRowClick={(order) => router.push(href(`/atelier/${order.id}`))}
            actions={(order) => (
              <IconAction
                icon="view"
                tone="primary"
                label={`Ouvrir la commande ${order.orderNumber}`}
                onClick={() => router.push(href(`/atelier/${order.id}`))}
              />
            )}
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/60">
            {formatNumber(total)} commande{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

    </div>
  );
}
