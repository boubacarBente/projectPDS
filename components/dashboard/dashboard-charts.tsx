'use client';

import { useMemo } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
} from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';
import { formatCurrencyCompact } from '@/lib/format';
import { formatMonthYear } from '@/lib/date-format';

/**
 * Graphiques du tableau de bord et des rapports (Chart.js, repris du projet Gaz).
 *
 * Contrat responsive du README §5.5 règle 5 : hauteur `h-56 sm:h-64`, légende
 * **sous** le graphe sur mobile, graduations allégées.
 *
 * Aucune couleur n'est écrite en dur : les teintes sont lues dans les variables
 * CSS du thème (`--color-primary`, `--color-success`…) afin que le graphique
 * suive la couleur choisie par le client.
 */

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
);

/** Lit une variable CSS du thème, avec repli sûr côté serveur. */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const PALETTE_FALLBACKS = [
  '#1e40af',
  '#10b981',
  '#f59e0b',
  '#0ea5e9',
  '#ef4444',
  '#8b5cf6',
  '#14b8a6',
  '#f97316',
];

function palette(): string[] {
  return [
    cssVar('--color-primary', PALETTE_FALLBACKS[0]),
    cssVar('--color-success', PALETTE_FALLBACKS[1]),
    cssVar('--color-warning', PALETTE_FALLBACKS[2]),
    cssVar('--color-info', PALETTE_FALLBACKS[3]),
    cssVar('--color-error', PALETTE_FALLBACKS[4]),
    ...PALETTE_FALLBACKS.slice(5),
  ];
}

const BASE_OPTIONS: ChartOptions<any> = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      position: 'bottom',
      labels: {
        boxWidth: 10,
        boxHeight: 10,
        usePointStyle: true,
        padding: 14,
        font: { size: 11 },
      },
    },
    tooltip: {
      backgroundColor: 'rgba(15, 23, 42, 0.92)',
      padding: 10,
      cornerRadius: 8,
      callbacks: {
        label: (context: any) =>
          `${context.dataset.label ?? ''} : ${Number(context.parsed.y ?? context.parsed ?? 0).toLocaleString('fr-FR')} GNF`,
      },
    },
  },
  scales: {
    x: {
      grid: { display: false },
      ticks: { font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
    },
    y: {
      grid: { color: 'rgba(148, 163, 184, 0.18)' },
      border: { display: false },
      ticks: {
        font: { size: 10 },
        maxTicksLimit: 5,
        callback: (value: any) => formatCurrencyCompact(Number(value), '').trim(),
      },
    },
  },
};

/** Évolution mensuelle : ventes, achats, dépenses sur 12 mois. */
export function MonthlyEvolutionChart({
  data,
}: {
  data: { month: string; revenue: number; purchases: number; expenses: number }[];
}) {
  const colors = useMemo(() => palette(), []);

  const chartData = useMemo(
    () => ({
      labels: data.map((d) => formatMonthYear(`${d.month}-01`).replace(/^\w/, (c) => c.toUpperCase())),
      datasets: [
        {
          label: 'Ventes',
          data: data.map((d) => d.revenue),
          backgroundColor: colors[0],
          borderRadius: 6,
          maxBarThickness: 26,
        },
        {
          label: 'Achats',
          data: data.map((d) => d.purchases),
          backgroundColor: colors[3],
          borderRadius: 6,
          maxBarThickness: 26,
        },
        {
          label: 'Dépenses',
          data: data.map((d) => d.expenses),
          backgroundColor: colors[2],
          borderRadius: 6,
          maxBarThickness: 26,
        },
      ],
    }),
    [data, colors],
  );

  return (
    <div className="h-56 sm:h-64">
      <Bar data={chartData} options={BASE_OPTIONS} />
    </div>
  );
}

/** Répartition du chiffre d'affaires par produit (top 8). */
export function TopProductsChart({
  data,
}: {
  data: { productName: string; amount: number }[];
}) {
  const colors = useMemo(() => palette(), []);

  const chartData = useMemo(
    () => ({
      labels: data.map((d) => (d.productName.length > 22 ? `${d.productName.slice(0, 21)}…` : d.productName)),
      datasets: [
        {
          label: "Chiffre d'affaires",
          data: data.map((d) => d.amount),
          backgroundColor: data.map((_, i) => colors[i % colors.length]),
          borderWidth: 0,
        },
      ],
    }),
    [data, colors],
  );

  const options: ChartOptions<'doughnut'> = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '58%',
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
          padding: 12,
          font: { size: 11 },
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        padding: 10,
        cornerRadius: 8,
        callbacks: {
          label: (context: any) =>
            `${context.label} : ${Number(context.parsed ?? 0).toLocaleString('fr-FR')} GNF`,
        },
      },
    },
  };

  return (
    <div className="h-56 sm:h-64">
      <Doughnut data={chartData} options={options} />
    </div>
  );
}

/** Courbe simple : encaissements vs facturation sur la période. */
export function RevenueTrendChart({
  labels,
  series,
}: {
  labels: string[];
  series: { label: string; values: number[]; tone?: number }[];
}) {
  const colors = useMemo(() => palette(), []);

  const chartData = useMemo(
    () => ({
      labels,
      datasets: series.map((s, index) => ({
        label: s.label,
        data: s.values,
        borderColor: colors[s.tone ?? index] ?? colors[0],
        backgroundColor: `${colors[s.tone ?? index] ?? colors[0]}22`,
        fill: true,
        tension: 0.35,
        pointRadius: 2,
        borderWidth: 2,
      })),
    }),
    [labels, series, colors],
  );

  return (
    <div className="h-56 sm:h-64">
      <Line data={chartData} options={BASE_OPTIONS} />
    </div>
  );
}
