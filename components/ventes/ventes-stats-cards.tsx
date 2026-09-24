'use client';

/**
 * Cartes de statistiques et sélecteur de période du module Ventes.
 *
 * Les mêmes cinq périodes que le tableau de bord (`Aujourd'hui / Semaine / Mois
 * / Année / Total`) alimentent `GET /api/ventes/stats?period=…`. Aucun total
 * n'est stocké : tout est calculé à la lecture (README §15).
 *
 * Le repli est volontairement tolérant : une statistique indisponible affiche
 * « — » plutôt que de faire tomber la page — la liste des ventes reste
 * exploitable même si l'agrégat échoue.
 */

import { Card, MiniStat, MoneyText, SkeletonCards } from '@/components/design-system';
import { formatCurrency, formatCurrencyCompact, formatNumber, formatPercent } from '@/lib/format';

export type VentesStatsPeriod = 'day' | 'week' | 'month' | 'year' | 'total';

export const VENTES_PERIODS: { key: VentesStatsPeriod; label: string }[] = [
  { key: 'day', label: "Aujourd'hui" },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'year', label: 'Année' },
  { key: 'total', label: 'Total' },
];

export type VentesStats = {
  period: string;
  count: number;
  revenue: number;
  totalHt: number;
  taxAmount: number;
  collected: number;
  outstanding: number;
  averageBasket: number;
  cancelledCount: number;
  topProducts: { productName: string; quantity: number; amount: number }[];
  byDay: { date: string; revenue: number; count: number }[];
};

/** Sélecteur de période, identique à celui du tableau de bord (§7.1). */
export function VentesPeriodSelector({
  period,
  onChange,
}: {
  period: VentesStatsPeriod;
  onChange: (period: VentesStatsPeriod) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Période des statistiques">
      {VENTES_PERIODS.map((entry) => (
        <button
          key={entry.key}
          type="button"
          onClick={() => onChange(entry.key)}
          aria-pressed={period === entry.key}
          className={`btn btn-sm min-h-11 sm:min-h-0 ${
            period === entry.key ? 'btn-primary' : 'btn-ghost border border-base-300'
          }`}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

export function VentesStatsCards({
  stats,
  isLoading,
  period,
  onPeriodChange,
}: {
  stats: VentesStats | null;
  isLoading: boolean;
  period: VentesStatsPeriod;
  onPeriodChange: (period: VentesStatsPeriod) => void;
}) {
  const periodLabel =
    VENTES_PERIODS.find((entry) => entry.key === period)?.label ?? 'Total';

  if (isLoading || !stats) {
    return (
      <div className="space-y-3">
        <VentesPeriodSelector period={period} onChange={onPeriodChange} />
        <SkeletonCards count={4} />
      </div>
    );
  }

  const unpaidRate =
    stats.revenue > 0 ? Math.max(0, Math.min(100, (stats.outstanding / stats.revenue) * 100)) : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <VentesPeriodSelector period={period} onChange={onPeriodChange} />
        <p className="text-xs text-base-content/50">
          {periodLabel} · {formatNumber(stats.count)} vente{stats.count > 1 ? 's' : ''}
          {stats.cancelledCount > 0
            ? ` · ${formatNumber(stats.cancelledCount)} annulée${stats.cancelledCount > 1 ? 's' : ''}`
            : ''}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat
          label={`Chiffre d'affaires — ${periodLabel.toLowerCase()}`}
          tone="primary"
          value={<span className="tabular text-base">{formatCurrency(stats.revenue)}</span>}
        />
        <MiniStat
          label="Encaissé"
          tone="success"
          value={<span className="tabular text-base">{formatCurrency(stats.collected)}</span>}
        />
        <MiniStat
          label="Restant dû"
          tone={stats.outstanding > 0.001 ? 'error' : 'success'}
          value={<span className="tabular text-base">{formatCurrency(stats.outstanding)}</span>}
        />
        <MiniStat
          label="Panier moyen"
          value={<span className="tabular text-base">{formatCurrency(stats.averageBasket)}</span>}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">Part non encaissée</h3>
            <span className="tabular text-xs text-base-content/50">
              {formatPercent(unpaidRate)} du chiffre d&apos;affaires
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-base-200">
            <div
              className="h-full rounded-full bg-error/70"
              style={{ width: `${unpaidRate}%` }}
              aria-hidden
            />
          </div>
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-base-content/50">Total HT</p>
              <MoneyText value={stats.totalHt} />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-base-content/50">TVA collectée</p>
              <MoneyText value={stats.taxAmount} />
            </div>
          </div>
        </Card>

        <Card padded={false} className="overflow-hidden">
          <div className="border-b border-base-200 bg-base-200/60 px-4 py-2.5">
            <h3 className="text-sm font-semibold">Produits les plus vendus</h3>
          </div>
          {stats.topProducts.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-base-content/50">
              Aucune vente sur cette période.
            </p>
          ) : (
            <ul className="divide-y divide-base-200">
              {stats.topProducts.slice(0, 5).map((product) => (
                <li
                  key={product.productName}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="min-w-0 truncate">{product.productName}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="tabular text-base-content/60">
                      {formatNumber(product.quantity, 2)}
                    </span>
                    <span className="tabular font-medium">
                      {formatCurrencyCompact(product.amount)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
