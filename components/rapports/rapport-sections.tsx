'use client';

/**
 * Sections du rapport (README §16.1) — composants **présentationnels**.
 *
 * Tout ce qui s'affiche arrive par les props : aucune requête, aucune donnée
 * serveur importée. Le composant est client (il utilise `useMemo` pour ses
 * colonnes) mais il ne connaît que les **types** de `lib/rapports-types.ts`,
 * jamais `lib/rapports.ts` (CONVENTIONS §11 bis).
 *
 * Règles de rendu : `ResponsiveTable` pour toute liste, `MoneyText` pour tout
 * montant, `Badge` pour tout statut, libellés en français, aucune couleur
 * Tailwind figée.
 */

import { useMemo } from 'react';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  Card,
  EmptyState,
  InfoRow,
  MiniStat,
  MoneyText,
  QuantityText,
} from '@/components/design-system';
import { formatNumber, formatPercent, formatQuantity } from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';
import type {
  RapportComparison,
  RapportExpenses,
  RapportJobCosts,
  RapportPayables,
  RapportPeriodBounds,
  RapportProductMargin,
  RapportReceivables,
  RapportSoldProduct,
  RapportStockInsights,
  RapportSummary,
  RapportTopCustomer,
} from '@/lib/rapports-types';

/* ------------------------------------------------------------------ *
 * 1. Résumé décisionnel — ce que le dirigeant lit en premier
 * ------------------------------------------------------------------ */

export function RapportDecisionSummary({
  sentences,
  label,
}: {
  sentences: string[];
  label: string;
}) {
  if (sentences.length === 0) return null;

  return (
    <Card className="border-primary/30 bg-primary/5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 17v-6m4 6V7m4 10v-3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Résumé décisionnel</h2>
          <p className="mt-0.5 text-xs text-base-content/60">{label}</p>
          <ul className="mt-3 space-y-2">
            {sentences.map((sentence, index) => (
              <li key={index} className="flex gap-2 text-sm leading-6">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                <span>{sentence}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Comparaison avec la période précédente
 * ------------------------------------------------------------------ */

function ComparisonMetric({
  label,
  current,
  previous,
  delta,
  currency,
  format = 'money',
}: {
  label: string;
  current: number;
  previous: number;
  delta: number | null;
  currency: string;
  /** `count` : un nombre de ventes, pas un montant. */
  format?: 'money' | 'count';
}) {
  const render = (value: number) =>
    format === 'count' ? (
      <span className="tabular">{formatNumber(value)}</span>
    ) : (
      <MoneyText value={value} currency={currency} />
    );

  return (
    <div className="rounded-xl border border-base-200 bg-base-100 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-base-content/60">{label}</span>
        {delta === null ? (
          <span className="text-xs text-base-content/40" title="Aucune base de comparaison">
            —
          </span>
        ) : (
          <Badge tone={delta > 0 ? 'success' : delta < 0 ? 'error' : 'neutral'}>
            {delta > 0 ? '+' : delta < 0 ? '−' : ''}
            {formatPercent(Math.abs(delta))}
          </Badge>
        )}
      </div>
      <div className="mt-2 text-xl font-bold">{render(current)}</div>
      <div className="mt-1 text-xs text-base-content/60">
        Période précédente : {render(previous)}
      </div>
    </div>
  );
}

export function RapportComparisonPanel({
  comparison,
  period,
  previousPeriod,
  currency,
}: {
  comparison: RapportComparison;
  period: { from: string; to: string; label: string };
  previousPeriod: RapportPeriodBounds;
  currency: string;
}) {
  const currentLabel =
    period.from === period.to
      ? formatDateShort(period.from)
      : `${formatDateShort(period.from)} → ${formatDateShort(period.to)}`;
  const previousLabel =
    previousPeriod.from === previousPeriod.to
      ? formatDateShort(previousPeriod.from)
      : `${formatDateShort(previousPeriod.from)} → ${formatDateShort(previousPeriod.to)}`;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Comparaison des périodes</h3>
        <span className="text-xs text-base-content/50">
          Période précédente calculée sur la même durée que la période du rapport
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-base-content/50">
            Période courante
          </div>
          <div className="text-sm font-medium">{currentLabel}</div>
        </div>
        <div className="rounded-xl border border-base-200 bg-base-100 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-base-content/50">
            Période précédente
          </div>
          <div className="text-sm font-medium">{previousLabel}</div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <ComparisonMetric
          label="Chiffre d'affaires"
          current={comparison.revenue.current}
          previous={comparison.revenue.previous}
          delta={comparison.revenue.deltaPercent}
          currency={currency}
        />
        <ComparisonMetric
          label="Marge brute"
          current={comparison.margin.current}
          previous={comparison.margin.previous}
          delta={comparison.margin.deltaPercent}
          currency={currency}
        />
        <ComparisonMetric
          label="Nombre de ventes"
          current={comparison.salesCount.current}
          previous={comparison.salesCount.previous}
          delta={comparison.salesCount.deltaPercent}
          currency={currency}
          format="count"
        />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Produits vendus
 * ------------------------------------------------------------------ */

export function SoldByProductTable({
  rows,
  currency,
}: {
  rows: RapportSoldProduct[];
  currency: string;
}) {
  const columns = useMemo<Column<RapportSoldProduct>[]>(
    () => [
      {
        key: 'productName',
        label: 'Produit',
        primary: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.productName}</div>
            {row.productCode && (
              <div className="text-xs text-base-content/50">{row.productCode}</div>
            )}
          </div>
        ),
      },
      {
        key: 'quantity',
        label: 'Quantité',
        className: 'text-right',
        render: (row) => <QuantityText value={row.quantity} unit={row.unit} />,
      },
      {
        key: 'revenue',
        label: "Chiffre d'affaires",
        className: 'text-right',
        render: (row) => <MoneyText value={row.revenue} currency={currency} />,
      },
      {
        key: 'sharePercent',
        label: 'Part',
        className: 'text-right',
        render: (row) => <span className="tabular text-sm">{formatPercent(row.sharePercent)}</span>,
      },
    ],
    [currency],
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Aucun produit vendu"
        description="Aucune ligne de vente ne correspond à la période et aux filtres sélectionnés."
      />
    );
  }

  return (
    <ResponsiveTable
      columns={columns}
      data={rows}
      getRowKey={(row) => `${row.productId ?? 'null'}-${row.productName}`}
    />
  );
}

/* ------------------------------------------------------------------ *
 * 4. Marges par produit
 * ------------------------------------------------------------------ */

export function ProductMarginsTable({
  rows,
  currency,
}: {
  rows: RapportProductMargin[];
  currency: string;
}) {
  const columns = useMemo<Column<RapportProductMargin>[]>(
    () => [
      {
        key: 'productName',
        label: 'Produit',
        primary: true,
        render: (row) => <span className="font-medium">{row.productName}</span>,
      },
      {
        key: 'quantity',
        label: 'Quantité',
        className: 'text-right',
        render: (row) => <span className="tabular">{formatQuantity(row.quantity)}</span>,
      },
      {
        key: 'revenue',
        label: "Chiffre d'affaires",
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => <MoneyText value={row.revenue} currency={currency} />,
      },
      {
        key: 'cost',
        label: "Coût d'achat",
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => <MoneyText value={row.cost} currency={currency} />,
      },
      {
        key: 'margin',
        label: 'Marge',
        className: 'text-right',
        render: (row) => <MoneyText value={row.margin} currency={currency} colored bold />,
      },
      {
        key: 'marginPercent',
        label: 'Taux',
        className: 'text-right',
        render: (row) => (
          <Badge tone={row.marginPercent >= 20 ? 'success' : row.marginPercent >= 0 ? 'warning' : 'error'}>
            {formatPercent(row.marginPercent)}
          </Badge>
        ),
      },
    ],
    [currency],
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Aucune marge à calculer"
        description="Aucune ligne de vente sur la période : la marge par produit se calcule à partir des ventes."
      />
    );
  }

  return (
    <ResponsiveTable
      columns={columns}
      data={rows}
      getRowKey={(row) => `${row.productId ?? 'null'}-${row.productName}`}
    />
  );
}

/* ------------------------------------------------------------------ *
 * 5. Meilleurs clients
 * ------------------------------------------------------------------ */

export function TopCustomersTable({
  rows,
  currency,
}: {
  rows: RapportTopCustomer[];
  currency: string;
}) {
  const columns = useMemo<Column<RapportTopCustomer>[]>(
    () => [
      {
        key: 'customerName',
        label: 'Client',
        primary: true,
        render: (row) => <span className="font-medium">{row.customerName}</span>,
      },
      {
        key: 'salesCount',
        label: 'Ventes',
        className: 'text-right',
        render: (row) => <span className="tabular">{formatNumber(row.salesCount)}</span>,
      },
      {
        key: 'revenue',
        label: "Chiffre d'affaires",
        className: 'text-right',
        render: (row) => <MoneyText value={row.revenue} currency={currency} bold />,
      },
      {
        key: 'collected',
        label: 'Encaissé',
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => <MoneyText value={row.collected} currency={currency} />,
      },
      {
        key: 'outstanding',
        label: 'Reste dû',
        className: 'text-right',
        render: (row) => <MoneyText value={row.outstanding} currency={currency} colored />,
      },
    ],
    [currency],
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Aucun client facturé"
        description="Aucune vente rattachée à une fiche client sur la période sélectionnée."
      />
    );
  }

  return <ResponsiveTable columns={columns} data={rows} getRowKey={(row) => row.customerId} />;
}

/* ------------------------------------------------------------------ *
 * 6. Créances clients
 * ------------------------------------------------------------------ */

export function ReceivablesTable({
  data,
  currency,
}: {
  data: RapportReceivables;
  currency: string;
}) {
  const columns = useMemo<Column<RapportReceivables['items'][number]>[]>(
    () => [
      {
        key: 'customerName',
        label: 'Client',
        primary: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.customerName}</div>
            {row.phone && <div className="text-xs text-base-content/50">{row.phone}</div>}
          </div>
        ),
      },
      {
        key: 'invoiceCount',
        label: 'Factures',
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => <span className="tabular">{formatNumber(row.invoiceCount)}</span>,
      },
      {
        key: 'oldestDueDate',
        label: 'Échéance la plus ancienne',
        render: (row) => (
          <span className="text-sm">
            {row.oldestDueDate ? formatDateShort(row.oldestDueDate) : 'Sans échéance'}
          </span>
        ),
      },
      {
        key: 'overdue',
        label: 'Retard',
        render: (row) =>
          row.overdue ? <Badge tone="error">En retard</Badge> : <Badge tone="neutral">À jour</Badge>,
      },
      {
        key: 'balance',
        label: 'Solde dû',
        className: 'text-right',
        render: (row) => <MoneyText value={row.balance} currency={currency} bold />,
      },
    ],
    [currency],
  );

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-2.5">
        <h3 className="text-sm font-semibold">Clients débiteurs</h3>
        <div className="flex flex-wrap items-center gap-2">
          <MiniStat label="Créances totales" value={<MoneyText value={data.total} currency={currency} />} tone="warning" />
          <MiniStat
            label="Débiteurs"
            value={<span className="tabular">{formatNumber(data.debtorsCount)}</span>}
          />
        </div>
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          title="Aucune créance client"
          description="Toutes les factures actives sont réglées : aucun client n'a de solde restant dû."
        />
      ) : (
        <div className="p-2">
          <ResponsiveTable
            columns={columns}
            data={data.items}
            getRowKey={(row) => row.customerId}
            tableClassName="table-sm"
          />
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * 7. Dettes fournisseurs
 * ------------------------------------------------------------------ */

export function PayablesTable({
  data,
  currency,
}: {
  data: RapportPayables;
  currency: string;
}) {
  const columns = useMemo<Column<RapportPayables['items'][number]>[]>(
    () => [
      {
        key: 'supplierName',
        label: 'Fournisseur',
        primary: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.supplierName}</div>
            {row.phone && <div className="text-xs text-base-content/50">{row.phone}</div>}
          </div>
        ),
      },
      {
        key: 'invoiceCount',
        label: 'Achats',
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => <span className="tabular">{formatNumber(row.invoiceCount)}</span>,
      },
      {
        key: 'oldestDueDate',
        label: 'Échéance la plus ancienne',
        render: (row) => (
          <span className="text-sm">
            {row.oldestDueDate ? formatDateShort(row.oldestDueDate) : 'Sans échéance'}
          </span>
        ),
      },
      {
        key: 'overdue',
        label: 'Retard',
        render: (row) =>
          row.overdue ? <Badge tone="error">En retard</Badge> : <Badge tone="neutral">À jour</Badge>,
      },
      {
        key: 'balance',
        label: 'Solde dû',
        className: 'text-right',
        render: (row) => <MoneyText value={row.balance} currency={currency} bold />,
      },
    ],
    [currency],
  );

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-2.5">
        <h3 className="text-sm font-semibold">Dettes fournisseurs</h3>
        <div className="flex flex-wrap items-center gap-2">
          <MiniStat label="Dettes totales" value={<MoneyText value={data.total} currency={currency} />} tone="error" />
          <MiniStat
            label="Fournisseurs"
            value={<span className="tabular">{formatNumber(data.creditorsCount)}</span>}
          />
        </div>
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          title="Aucune dette fournisseur"
          description="Tous les achats actifs sont réglés : aucun fournisseur n'attend de paiement."
        />
      ) : (
        <div className="p-2">
          <ResponsiveTable
            columns={columns}
            data={data.items}
            getRowKey={(row) => row.supplierId}
            tableClassName="table-sm"
          />
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * 8. Stock — alertes et ruptures
 * ------------------------------------------------------------------ */

export function StockInsightsPanel({
  data,
  currency,
}: {
  data: RapportStockInsights;
  currency: string;
}) {
  const columns = useMemo<Column<RapportStockInsights['alerts'][number]>[]>(
    () => [
      {
        key: 'name',
        label: 'Produit',
        primary: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.name}</div>
            <div className="text-xs text-base-content/50">{row.code}</div>
          </div>
        ),
      },
      {
        key: 'stock',
        label: 'Stock',
        className: 'text-right',
        render: (row) => (
          <QuantityText value={row.stock} unit={row.unit} className={row.stock <= 0 ? 'text-error' : ''} />
        ),
      },
      {
        key: 'stockMin',
        label: 'Seuil',
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => <QuantityText value={row.stockMin} unit={row.unit} />,
      },
      {
        key: 'stockValue',
        label: "Valeur d'achat",
        className: 'text-right',
        render: (row) => <MoneyText value={row.stockValue} currency={currency} />,
      },
    ],
    [currency],
  );

  const hasAlerts = data.alerts.length > 0 || data.outOfStock.length > 0;

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-2.5">
        <h3 className="text-sm font-semibold">Stock</h3>
        <div className="flex flex-wrap items-center gap-2">
          <MiniStat
            label="Valeur d'achat"
            value={<MoneyText value={data.purchaseValue} currency={currency} />}
            tone="info"
          />
          <MiniStat
            label="Valeur de vente"
            value={<MoneyText value={data.saleValue} currency={currency} />}
            tone="primary"
          />
          <MiniStat
            label="Marge potentielle"
            value={<MoneyText value={data.potentialMargin} currency={currency} />}
            tone="success"
          />
          <MiniStat
            label="Ruptures"
            value={<span className="tabular">{formatNumber(data.outOfStockCount)}</span>}
            tone={data.outOfStockCount > 0 ? 'error' : 'neutral'}
          />
          <MiniStat
            label="Alertes"
            value={<span className="tabular">{formatNumber(data.lowStockCount)}</span>}
            tone={data.lowStockCount > 0 ? 'warning' : 'neutral'}
          />
        </div>
      </div>

      {!hasAlerts ? (
        <EmptyState
          title="Aucune alerte de stock"
          description={`${formatNumber(data.totalProducts)} produits actifs, aucun sous le seuil ni en rupture.`}
        />
      ) : (
        <div className="space-y-4 p-3">
          {data.outOfStock.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Badge tone="error">Ruptures</Badge>
                <span className="text-xs text-base-content/60">
                  {formatNumber(data.outOfStockCount)} produit
                  {data.outOfStockCount > 1 ? 's' : ''} à réapprovisionner en priorité
                </span>
              </div>
              <ResponsiveTable
                columns={columns}
                data={data.outOfStock}
                getRowKey={(row) => row.productId}
                tableClassName="table-sm"
              />
            </div>
          )}

          {data.alerts.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Badge tone="warning">Seuils d'alerte</Badge>
                <span className="text-xs text-base-content/60">
                  {formatNumber(data.lowStockCount)} produit
                  {data.lowStockCount > 1 ? 's' : ''} au niveau ou sous le stock minimum
                </span>
              </div>
              <ResponsiveTable
                columns={columns}
                data={data.alerts}
                getRowKey={(row) => row.productId}
                tableClassName="table-sm"
              />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * 9. Caisse, dépenses et main-d'œuvre
 * ------------------------------------------------------------------ */

export function CashAndExpensesPanel({
  summary,
  expenses,
  jobCosts,
  currency,
}: {
  summary: RapportSummary;
  expenses: RapportExpenses;
  jobCosts: RapportJobCosts;
  currency: string;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="space-y-1">
        <h3 className="mb-1 text-sm font-semibold">Caisse</h3>
        <InfoRow label="Solde de caisse">
          <MoneyText value={summary.cash.balance} currency={currency} bold />
        </InfoRow>
        <InfoRow
          label={summary.cash.sessionStatus === 'open' ? 'Entrées (session ouverte)' : 'Entrées (période)'}
        >
          <MoneyText value={summary.cash.income} currency={currency} />
        </InfoRow>
        <InfoRow
          label={summary.cash.sessionStatus === 'open' ? 'Sorties (session ouverte)' : 'Sorties (période)'}
        >
          <MoneyText value={summary.cash.expense} currency={currency} />
        </InfoRow>
        <InfoRow label="Net">
          <MoneyText value={summary.cash.net} currency={currency} colored />
        </InfoRow>
        {summary.cash.sessionStatus === 'open' && (
          <p className="pt-1 text-xs text-base-content/50">
            Une session de caisse est ouverte : les entrées et sorties ci-dessus sont celles de la
            session en cours. Le solde reste le solde global.
          </p>
        )}

        {summary.cash.byMethod.length > 0 && (
          <div className="pt-2">
            <div className="mb-1 text-xs uppercase tracking-wide text-base-content/50">
              Par moyen de paiement
            </div>
            <ul className="space-y-1">
              {summary.cash.byMethod.map((row) => (
                <li key={row.method} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-base-content/70">{row.method}</span>
                  <MoneyText value={row.net} currency={currency} colored />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card className="space-y-1">
        <h3 className="mb-1 text-sm font-semibold">Dépenses</h3>
        <InfoRow label="Total">
          <MoneyText value={expenses.total} currency={currency} bold />
        </InfoRow>
        <InfoRow label="Écritures">
          <span className="tabular">{formatNumber(expenses.count)}</span>
        </InfoRow>
        <InfoRow label="Moyenne">
          <MoneyText value={expenses.average} currency={currency} />
        </InfoRow>

        {expenses.byCategory.length > 0 && (
          <div className="pt-2">
            <div className="mb-1 text-xs uppercase tracking-wide text-base-content/50">
              Par catégorie
            </div>
            <ul className="space-y-1">
              {expenses.byCategory.slice(0, 8).map((row) => (
                <li key={row.category} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-base-content/70">
                    {row.category}
                    <span className="ml-1 text-xs text-base-content/40">
                      ({formatNumber(row.count)})
                    </span>
                  </span>
                  <MoneyText value={row.total} currency={currency} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card className="space-y-1">
        <h3 className="mb-1 text-sm font-semibold">Main-d'œuvre et matières</h3>
        <InfoRow label="Chantiers facturés">
          <span className="tabular">{formatNumber(jobCosts.serviceJobs.count)}</span>
        </InfoRow>
        <InfoRow label="CA des chantiers">
          <MoneyText value={jobCosts.serviceJobs.revenue} currency={currency} />
        </InfoRow>
        <InfoRow label="Matières chantiers">
          <MoneyText value={jobCosts.serviceJobs.materialCost} currency={currency} />
        </InfoRow>
        <InfoRow label="Briqueterie (matières)">
          <MoneyText value={jobCosts.brickProductions.materialCost} currency={currency} />
        </InfoRow>
        <InfoRow label="Atelier (matières)">
          <MoneyText value={jobCosts.furnitureOrders.materialCost} currency={currency} />
        </InfoRow>
        <InfoRow label="Main-d'œuvre totale">
          <MoneyText value={jobCosts.totalLaborCost} currency={currency} bold />
        </InfoRow>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 10. Bénéfice — décomposition du résultat
 * ------------------------------------------------------------------ */

export function NetProfitPanel({
  netProfit,
  currency,
}: {
  netProfit: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    grossMarginPercent: number;
    expenses: number;
    laborCost: number;
    netProfit: number;
  };
  currency: string;
}) {
  return (
    <Card className="space-y-1">
      <h3 className="mb-1 text-sm font-semibold">Résultat de la période</h3>
      <InfoRow label="Chiffre d'affaires des lignes de vente">
        <MoneyText value={netProfit.revenue} currency={currency} />
      </InfoRow>
      <InfoRow label="Coût des marchandises vendues">
        <MoneyText value={netProfit.cogs} currency={currency} />
      </InfoRow>
      <InfoRow label="Bénéfice brut">
        <MoneyText value={netProfit.grossProfit} currency={currency} bold />
      </InfoRow>
      <InfoRow label="Taux de marge brute">
        <span className="tabular">{formatPercent(netProfit.grossMarginPercent)}</span>
      </InfoRow>
      <InfoRow label="Dépenses de fonctionnement">
        <MoneyText value={netProfit.expenses} currency={currency} />
      </InfoRow>
      <InfoRow label="Main-d'œuvre chantiers et fabrications">
        <MoneyText value={netProfit.laborCost} currency={currency} />
      </InfoRow>
      {/*
        * Ligne de total : elle doit pouvoir passer à la ligne.
        *
        * Montant en `tabular` (donc insécable) + libellé : dans une colonne
        * étroite, la ligne imposait sa largeur à la carte et faisait déborder la
        * page. `flex-wrap` + `min-w-0` garantissent qu'elle se replie au lieu de
        * pousser la mise en page.
        */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2">
        <span className="min-w-0 text-sm font-medium">Bénéfice net</span>
        <MoneyText value={netProfit.netProfit} currency={currency} colored bold />
      </div>
    </Card>
  );
}
