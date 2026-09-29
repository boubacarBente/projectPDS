'use client';

/**
 * Tableau de bord de la **briqueterie** (README §20, point 1).
 *
 * Un seul appel : `GET /api/briqueterie/tableau-de-bord`. Douze indicateurs
 * issus des mêmes tables — six requêtes concurrentes sur SQLite local se
 * marcheraient dessus pour rien, et un seul aller-retour garantit que **tous les
 * chiffres affichés appartiennent au même instant**.
 *
 * Rappels de la révision §20 que cette page doit rendre lisibles :
 *  - **il n'y a pas de module de matières premières** : le ciment, le sable et le
 *    carburant sont des **dépenses rattachées à un lot**, qui sortent de la caisse ;
 *  - le **coût de production** ne contient que ces dépenses rattachées (plus la
 *    main-d'œuvre des affectations), **jamais** les dépenses générales — un loyer
 *    ne doit pas augmenter le prix de revient d'une brique ;
 *  - les **ventes de briques** sont celles du canal `brick` : elles n'apparaissent
 *    pas dans la liste `/ventes` du commerce général.
 *
 * Aucun import de valeur depuis `lib/brick*.ts` (ces modules touchent `@/db`) :
 * tout passe par l'API, et les types sont redéclarés ici (CONVENTIONS §11 bis).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { ToolbarButton } from '@/components/data-toolbar';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { ExportDropdown } from '@/components/export-dropdown';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  MoneyText,
  PageSection,
  QuantityText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useSettings } from '@/app/parametres/page';
import { BrickTabs } from '@/components/briqueterie/brick-tabs';
import {
  BRICK_PRODUCTION_STATUS_LABELS,
  BrickProductionModal,
  BrickTypesManagerModal,
  readApiError,
  type BrickProductionRow,
  type BrickTypeRow,
  type Paginated,
} from '@/components/briqueterie/briqueterie-modals';
import { RevenueTrendChart } from '@/components/dashboard/dashboard-charts';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency, formatNumber, formatPercent, formatQuantity } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types — miroir exact du JSON de /api/briqueterie/tableau-de-bord
 * ------------------------------------------------------------------ */

type BrickOrderStatus =
  | 'draft'
  | 'confirmed'
  | 'in_production'
  | 'ready'
  | 'partially_delivered'
  | 'delivered'
  | 'cancelled';

const ORDER_STATUS_LABELS: Record<BrickOrderStatus, string> = {
  draft: 'Brouillons',
  confirmed: 'Confirmées',
  in_production: 'En production',
  ready: 'Prêtes',
  partially_delivered: 'Partiellement livrées',
  delivered: 'Livrées',
  cancelled: 'Annulées',
};

/** Statuts mis en avant sur le tableau de bord : « en attente » au sens du client. */
const ORDER_STATUS_ORDER: BrickOrderStatus[] = [
  'draft',
  'confirmed',
  'in_production',
  'ready',
  'partially_delivered',
  'delivered',
];

type StockLine = {
  brickTypeId: number;
  brickTypeName: string;
  dimensions: string | null;
  productId: number;
  productName: string;
  unit: string;
  salePrice: number;
  stock: number;
  stockMin: number;
  averageUnitCost: number;
  isLow: boolean;
  isOut: boolean;
  saleValue: number;
};

type Dashboard = {
  period: { from: string; to: string; label: string };
  production: {
    today: number;
    week: number;
    month: number;
    monthCost: number;
    monthLots: number;
    monthBroken: number;
    monthUnitCost: number;
  };
  sales: {
    today: number;
    todayCount: number;
    month: number;
    monthCount: number;
    year: number;
    yearCount: number;
  };
  collected: number;
  outstanding: number;
  expenses: { productionMonth: number; generalMonth: number };
  profitability: {
    revenue: number;
    productionCost: number;
    grossMargin: number;
    generalExpenses: number;
    estimatedResult: number;
    marginRate: number;
  };
  stock: {
    lines: StockLine[];
    totalQuantity: number;
    totalPurchaseValue: number;
    totalSaleValue: number;
    lowCount: number;
    outCount: number;
  };
  orders: Record<BrickOrderStatus, number>;
  productionByType: {
    brickTypeId: number;
    brickTypeName: string;
    lots: number;
    produced: number;
    broken: number;
    cost: number;
    unitCost: number;
  }[];
  charts: {
    production: { date: string; produced: number; cost: number }[];
    sales: { date: string; revenue: number; quantity: number }[];
    expenses: { date: string; production: number; general: number }[];
  };
  topProducts: { productName: string; quantity: number; revenue: number }[];
  alerts: { brickTypeId: number; name: string; stock: number; stockMin: number; unit: string }[];
};

/** Format court d'une date de graphique : « 12/03 » plutôt que la date complète. */
function shortDay(value: string): string {
  return value.length === 10 ? `${value.slice(8, 10)}/${value.slice(5, 7)}` : value;
}

export default function BriqueterieDashboardPage() {
  const { settings } = useSettings();
  const currency = settings.currency || 'GNF';

  const canCreate = usePermission('brick.create');
  const canSell = usePermission('sales.create');
  const canOrder = usePermission('brick.create');

  const [data, setData] = useState<Dashboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const [types, setTypes] = useState<BrickTypeRow[]>([]);
  const [typesLoaded, setTypesLoaded] = useState(false);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isTypesOpen, setIsTypesOpen] = useState(false);

  const refresh = useCallback(() => setToken((value) => value + 1), []);

  /* ── Tableau de bord ─────────────────────────────────────────────── */
  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    fetch('/api/briqueterie/tableau-de-bord', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Le tableau de bord est indisponible.'));
        }
        return (await response.json()) as Dashboard;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setData(payload);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(
          caught instanceof Error ? caught.message : 'Le tableau de bord est indisponible.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [token]);

  /* ── Types de briques : sélecteur de la modale « Nouveau lot » ───── */
  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/briqueterie/types?limit=200', {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Types de briques indisponibles.'));
        }
        return (await response.json()) as Paginated<BrickTypeRow>;
      })
      .then((payload) => setTypes(Array.isArray(payload.data) ? payload.data : []))
      .catch(() => {
        // Liste d'appoint : son échec ne doit pas masquer le tableau de bord.
      })
      .finally(() => {
        if (!controller.signal.aborted) setTypesLoaded(true);
      });

    return () => controller.abort();
  }, [token]);

  const alertLines = data?.alerts ?? [];

  const stockColumns = useMemo<Column<StockLine>[]>(
    () => [
      {
        key: 'brickTypeName',
        label: 'Produit',
        primary: true,
        render: (line) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{line.brickTypeName}</div>
            <div className="truncate text-xs text-base-content/50">{line.productName}</div>
          </div>
        ),
      },
      {
        key: 'stock',
        label: 'Stock actuel',
        render: (line) => (
          <div className="flex items-center gap-2">
            <QuantityText value={line.stock} unit={line.unit} />
            {line.isOut ? (
              <Badge tone="error">Rupture</Badge>
            ) : line.isLow ? (
              <Badge tone="warning">Seuil atteint</Badge>
            ) : (
              <Badge tone="success">Disponible</Badge>
            )}
          </div>
        ),
      },
      {
        key: 'stockMin',
        label: 'Seuil minimum',
        hideOnMobile: true,
        render: (line) => <QuantityText value={line.stockMin} unit={line.unit} />,
      },
      {
        key: 'averageUnitCost',
        label: 'Coût de revient moyen',
        hideOnMobile: true,
        className: 'text-right whitespace-nowrap',
        render: (line) => <MoneyText value={line.averageUnitCost} currency={currency} />,
      },
      {
        key: 'salePrice',
        label: 'Prix de vente',
        className: 'text-right whitespace-nowrap',
        render: (line) => <MoneyText value={line.salePrice} currency={currency} />,
      },
      {
        key: 'saleValue',
        label: 'Valeur de vente',
        hideOnMobile: true,
        className: 'text-right whitespace-nowrap',
        render: (line) => <MoneyText value={line.saleValue} currency={currency} />,
      },
    ],
    [currency],
  );

  /* ── Rendu ────────────────────────────────────────────────────────── */

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Briqueterie"
        title="Briqueterie"
        description="Production du jour, ventes, stock des briques, dépenses et rentabilité — calculés en direct depuis les fiches de fabrication."
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost min-h-11 border border-base-300"
              onClick={() => setIsTypesOpen(true)}
            >
              Types de briques
            </button>
            {canOrder && (
              <Link href="/briqueterie/commandes" className="btn btn-ghost min-h-11 border border-base-300">
                Commandes
              </Link>
            )}
            {canSell && (
              <Link href="/ventes/nouvelle?canal=briqueterie" className="btn btn-primary min-h-11">
                Nouvelle vente
              </Link>
            )}
            {canCreate && (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => setIsCreateOpen(true)}
              >
                Nouveau lot
              </button>
            )}
          </>
        }
      />

      <BrickTabs />

      {isLoading && !data ? (
        <>
          <SkeletonCards count={8} />
          <SkeletonTable rows={4} cols={5} />
        </>
      ) : error || !data ? (
        <ErrorState
          title="Tableau de bord indisponible"
          description={error ?? 'Le tableau de bord est indisponible.'}
          onRetry={refresh}
        />
      ) : (
        <>
          {/* 1 · Production et ventes — les deux lectures du jour */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCardDelta
              label="Production du jour"
              tone="primary"
              value={<QuantityText value={data.production.today} />}
              hint={`Semaine ${formatQuantity(data.production.week)} · Mois ${formatQuantity(data.production.month)}`}
            />
            <StatCardDelta
              label="Production du mois"
              tone="success"
              value={<QuantityText value={data.production.month} />}
              hint={`${data.production.monthLots} lot(s) · cassées ${formatQuantity(data.production.monthBroken)}`}
            />
            <StatCardDelta
              label="Coût unitaire moyen"
              tone="info"
              value={<MoneyText value={data.production.monthUnitCost} currency={currency} />}
              hint={`Coût du mois ${formatCurrency(data.production.monthCost, currency)}`}
            />
            <StatCardDelta
              label="Stock total"
              tone={data.stock.outCount > 0 ? 'warning' : 'primary'}
              value={<QuantityText value={data.stock.totalQuantity} />}
              hint={`${formatNumber(data.stock.lines.length)} produit(s) · ${data.stock.outCount} rupture(s)`}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCardDelta
              label="Ventes du jour"
              tone="success"
              value={<MoneyText value={data.sales.today} currency={currency} />}
              hint={`${data.sales.todayCount} vente(s) de briques`}
            />
            <StatCardDelta
              label="Ventes du mois"
              tone="success"
              value={<MoneyText value={data.sales.month} currency={currency} />}
              hint={`${data.sales.monthCount} vente(s)`}
            />
            <StatCardDelta
              label="Ventes de l’année"
              tone="primary"
              value={<MoneyText value={data.sales.year} currency={currency} />}
              hint={`${data.sales.yearCount} vente(s)`}
            />
            <StatCardDelta
              label="Montant encaissé / reste à recevoir"
              tone={data.outstanding > 0 ? 'warning' : 'success'}
              value={<MoneyText value={data.collected} currency={currency} />}
              hint={`Reste à recevoir : ${formatCurrency(data.outstanding, currency)}`}
            />
          </div>

          {/* 2 · Dépenses et rentabilité du mois */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCardDelta
              label="Dépenses de production"
              tone="warning"
              value={<MoneyText value={data.expenses.productionMonth} currency={currency} />}
              hint="Ciment, sable, carburant, main-d’œuvre… rattachés aux lots du mois"
            />
            <StatCardDelta
              label="Dépenses générales"
              tone="neutral"
              value={<MoneyText value={data.expenses.generalMonth} currency={currency} />}
              hint="Transport, loyer, électricité… hors production"
            />
            <StatCardDelta
              label="Chiffre d’affaires du mois"
              tone="success"
              value={<MoneyText value={data.profitability.revenue} currency={currency} />}
              hint={`Marge brute estimée : ${formatCurrency(data.profitability.grossMargin, currency)}`}
            />
            <StatCardDelta
              label="Bénéfice estimé du mois"
              tone={data.profitability.estimatedResult >= 0 ? 'success' : 'error'}
              value={<MoneyText value={data.profitability.estimatedResult} currency={currency} />}
              hint={`CA − coûts de production − dépenses générales · marge ${formatPercent(data.profitability.marginRate)}`}
            />
          </div>

          {/* 3 · Alertes de stock faible — jamais la couleur seule */}
          {alertLines.length > 0 ? (
            <div className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-semibold text-warning">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                    />
                  </svg>
                  Alerte de stock faible — {alertLines.length} produit(s) sous le seuil minimum
                </p>
                <Link href="/briqueterie/stock" className="btn btn-ghost btn-sm min-h-11 border border-base-300">
                  Gérer le stock
                </Link>
              </div>
              <ul className="mt-2 flex flex-wrap gap-2">
                {alertLines.map((alert) => (
                  <li key={alert.brickTypeId}>
                    <Badge tone={alert.stock <= 0 ? 'error' : 'warning'}>
                      {alert.name} : {formatQuantity(alert.stock, alert.unit)} (seuil{' '}
                      {formatQuantity(alert.stockMin)})
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-2xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
              Aucun produit sous son seuil minimum : le stock de briques est suffisant.
            </div>
          )}

          {/* 4 · Commandes par statut */}
          <PageSection
            title="Commandes en cours"
            subtitle="Une commande ne touche pas le stock : elle devient une facture de vente quand on la facture."
            actions={
              <Link href="/briqueterie/commandes" className="btn btn-ghost min-h-11 border border-base-300">
                Toutes les commandes
              </Link>
            }
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {ORDER_STATUS_ORDER.map((status) => (
                <Link
                  key={status}
                  href={`/briqueterie/commandes?status=${status}`}
                  className="rounded-xl border border-base-200 bg-base-100 px-3 py-3 text-center transition-colors hover:border-primary/40"
                >
                  <div className="text-[11px] uppercase text-base-content/45">
                    {ORDER_STATUS_LABELS[status]}
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular">
                    {formatNumber(data.orders[status] ?? 0)}
                  </div>
                </Link>
              ))}
            </div>
            {(data.orders.cancelled ?? 0) > 0 && (
              <p className="mt-3 text-xs text-base-content/50">
                {formatNumber(data.orders.cancelled)} commande(s) annulée(s) — une annulation garde
                toujours son motif et son auteur.
              </p>
            )}
          </PageSection>

          {/* 5 · Graphiques d'évolution (30 derniers jours) */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <p className="mb-3 text-sm font-semibold">Production — 30 derniers jours</p>
              <RevenueTrendChart
                labels={data.charts.production.map((point) => shortDay(point.date))}
                series={[
                  { label: 'Briques produites', values: data.charts.production.map((p) => p.produced), tone: 1 },
                ]}
              />
            </Card>

            <Card>
              <p className="mb-3 text-sm font-semibold">Ventes de briques — 30 derniers jours</p>
              <RevenueTrendChart
                labels={data.charts.sales.map((point) => shortDay(point.date))}
                series={[
                  { label: 'Chiffre d’affaires', values: data.charts.sales.map((p) => p.revenue), tone: 0 },
                ]}
              />
            </Card>

            <Card className="lg:col-span-2">
              <p className="mb-3 text-sm font-semibold">Dépenses — 30 derniers jours</p>
              <RevenueTrendChart
                labels={data.charts.expenses.map((point) => shortDay(point.date))}
                series={[
                  {
                    label: 'Dépenses de production',
                    values: data.charts.expenses.map((p) => p.production),
                    tone: 2,
                  },
                  {
                    label: 'Dépenses générales',
                    values: data.charts.expenses.map((p) => p.general),
                    tone: 4,
                  },
                ]}
              />
            </Card>
          </div>

          {/* 6 · Production du mois par produit */}
          <PageSection
            title="Quantité produite par produit"
            subtitle="Mois en cours. Le coût unitaire est calculé : coût total ÷ (production − cassées)."
          >
            {data.productionByType.length === 0 ? (
              <EmptyState
                title="Aucune fabrication ce mois-ci"
                description="Lancez un lot et rattachez-lui ses dépenses : la production apparaîtra ici, avec son coût de revient."
                action={
                  canCreate ? (
                    <button
                      type="button"
                      className="btn btn-primary min-h-11"
                      onClick={() => setIsCreateOpen(true)}
                    >
                      Lancer une fabrication
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th scope="col">Produit</th>
                      <th scope="col" className="text-right">Lots</th>
                      <th scope="col" className="text-right">Produites</th>
                      <th scope="col" className="text-right">Cassées</th>
                      <th scope="col" className="text-right">Coût total</th>
                      <th scope="col" className="text-right">Coût unitaire</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.productionByType.map((row) => (
                      <tr key={row.brickTypeId}>
                        <td className="font-medium">{row.brickTypeName}</td>
                        <td className="text-right tabular">{formatNumber(row.lots)}</td>
                        <td className="text-right">
                          <QuantityText value={row.produced} />
                        </td>
                        <td className="text-right">
                          <QuantityText
                            value={row.broken}
                            className={row.broken > 0 ? 'text-warning' : ''}
                          />
                        </td>
                        <td className="text-right">
                          <MoneyText value={row.cost} currency={currency} />
                        </td>
                        <td className="text-right">
                          <MoneyText value={row.unitCost} currency={currency} bold />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </PageSection>

          {/* 7 · Stock actuel par produit */}
          <PageSection
            title="Stock actuel par produit"
            subtitle="Lu sur le produit lié, lui-même somme des mouvements de stock — une seule source de vérité."
            actions={
              <Link href="/briqueterie/stock" className="btn btn-ghost min-h-11 border border-base-300">
                Voir le stock détaillé
              </Link>
            }
          >
            {data.stock.lines.length === 0 ? (
              <EmptyState
                title="Aucun produit de briqueterie"
                description="Créez un type de brique lié à un produit pour suivre son stock ici."
              />
            ) : (
              <ResponsiveTable
                columns={stockColumns}
                data={data.stock.lines}
                getRowKey={(line) => line.brickTypeId}
                emptyMessage="Aucun produit."
              />
            )}
          </PageSection>

          {/* 8 · Meilleures ventes du mois */}
          {data.topProducts.length > 0 && (
            <PageSection title="Meilleures ventes du mois" subtitle="Par chiffre d’affaires.">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {data.topProducts.map((product) => (
                  <div
                    key={product.productName}
                    className="rounded-xl border border-base-200 bg-base-100 px-3 py-3"
                  >
                    <div className="truncate text-[11px] uppercase text-base-content/45">
                      {product.productName}
                    </div>
                    <div className="mt-1">
                      <MoneyText value={product.revenue} currency={currency} bold />
                    </div>
                    <div className="text-xs text-base-content/55">
                      {formatQuantity(product.quantity)} vendues
                    </div>
                  </div>
                ))}
              </div>
            </PageSection>
          )}

          <p className="text-center text-xs text-base-content/50">
            Période analysée : {formatDateShort(data.period.from)} → {formatDateShort(data.period.to)}.
            Les annulations ne sont jamais supprimées : elles gardent leur motif et leur auteur.
          </p>
        </>
      )}

      {/* Modales — un état booléen chacune */}
      <BrickProductionModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        brickTypes={types.filter((type) => type.isActive)}
        isOptionsLoading={!typesLoaded}
        onSaved={refresh}
      />

      <BrickTypesManagerModal
        isOpen={isTypesOpen}
        onClose={() => setIsTypesOpen(false)}
        onChanged={refresh}
        onTypesLoaded={setTypes}
      />
    </div>
  );
}
