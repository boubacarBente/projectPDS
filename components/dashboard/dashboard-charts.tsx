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
  type Chart,
  type ChartOptions,
  type Plugin,
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

/**
 * Convertit `oklch(L C H)` en hexadécimal.
 *
 * Le thème écrit la couleur principale en `oklch(…)` (lib/colors.ts) ; le
 * canevas de Chart.js l'**ignore** et retombe sur le noir — constaté sur le
 * pilotage des chantiers : l'aire sous la courbe était entièrement noire.
 * Formules OKLab → sRGB de Björn Ottosson.
 */
function oklchToHex(value: string): string | null {
  const match = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i);
  if (!match) return null;
  const L = Number(match[1]) / (match[2] ? 100 : 1);
  const C = Number(match[3]);
  const h = (Number(match[4]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const hex = linear
    .map((x) => {
      const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(x, 0), 1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('');
  return `#${hex}`;
}

/** Lit une variable CSS du thème (convertie en hexadécimal), avec repli sûr côté serveur. */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) return fallback;
  if (value.startsWith('#')) return value;
  return oklchToHex(value) ?? fallback;
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

/**
 * Couleur adoucie pour le remplissage sous une courbe.
 *
 * Ajouter `22` au bout de la couleur ne marche que pour un hexadécimal : le
 * thème fournit des couleurs `oklch(…)`, et `oklch(…)22` est invalide — le
 * canevas remplissait alors toute l’aire en **noir** (constaté sur le pilotage
 * des chantiers). On insère donc l’opacité selon la forme de la couleur.
 */
function translucent(color: string, alpha: number): string {
  const value = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value + Math.round(alpha * 255).toString(16).padStart(2, '0');
  const fn = value.match(/^(oklch|oklab|rgb|hsl|lab|lch)((.*))$/i);
  if (fn && !fn[2].includes('/')) return `${fn[1]}(${fn[2]} / ${alpha})`;
  return 'transparent';
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

/**
 * Achats d'**un client**, mois par mois (fiche client).
 *
 * Même rendu que `MonthlyEvolutionChart` (mêmes options, même palette lue dans
 * les variables CSS du thème), mais une **seule** série : les totaux mensuels
 * des factures du client, agrégés côté page à partir des factures déjà
 * chargées (`GET /api/clients/[id]`). Aucun montant n'est inventé : un mois sans
 * facture vaut **0** et reste affiché, la période est donc lisible telle quelle.
 *
 * Le total de la période est écrit au centre du graphe par un greffon Chart.js
 * (`afterDatasetsDraw`) — équivalent du montant central de la maquette, sans
 * toucher aux données ni au rendu des barres.
 */
export function CustomerMonthlyPurchasesChart({
  data,
  currency = 'GNF',
}: {
  data: { month: string; total: number }[];
  currency?: string;
}) {
  const colors = useMemo(() => palette(), []);

  const chartData = useMemo(
    () => ({
      labels: data.map((d) => {
        const label = formatMonthYear(`${d.month}-01`);
        return label.replace(/^\w/, (c) => c.toUpperCase());
      }),
      datasets: [
        {
          label: 'Achats du client',
          data: data.map((d) => d.total),
          backgroundColor: colors[0],
          borderRadius: 6,
          maxBarThickness: 26,
        },
      ],
    }),
    [data, colors],
  );

  const total = useMemo(() => data.reduce((sum, d) => sum + d.total, 0), [data]);

  /**
   * Greffon local : total de la période au centre du graphe. Instancié par
   * `useMemo` pour que React ne recrée pas le greffon à chaque rendu.
   */
  const options: ChartOptions<'bar'> = useMemo(() => {
    const totalPlugin: Plugin<'bar'> = {
      id: 'totalAchatsClient',
      afterDatasetsDraw: (chart: Chart<'bar'>) => {
        const { ctx, chartArea } = chart;
        if (!chartArea) return;

        const centerX = (chartArea.left + chartArea.right) / 2;
        const centerY = (chartArea.top + chartArea.bottom) / 2;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = cssVar('--color-base-content', 'currentColor');
        ctx.globalAlpha = 0.35;
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText('Total sur 12 mois', centerX, centerY - 14);
        ctx.globalAlpha = 1;
        ctx.font = '700 17px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(
          `${Number(total).toLocaleString('fr-FR')} ${currency}`,
          centerX,
          centerY + 8,
        );
        ctx.restore();
      },
    };

    return { ...BASE_OPTIONS, plugins: { ...BASE_OPTIONS.plugins, totalPlugin } };
  }, [total, currency]);

  return (
    <div className="h-56 sm:h-64">
      <Bar data={chartData} options={options} />
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
        backgroundColor: translucent(colors[s.tone ?? index] ?? colors[0], 0.13),
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
