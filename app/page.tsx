'use client';

/**
 * Tableau de bord (§7.1) — refonte visuelle calée sur la maquette du client.
 *
 * **Présentation seule** : toutes les valeurs affichées viennent de
 * `GET /api/operations/snapshot` (`lib/dashboard.ts`), sans aucun calcul ni
 * requête ajoutés. Deux écarts assumés avec la maquette, faute de données :
 *   - l'écart « vs période précédente » n'est calculé que pour le chiffre
 *     d'affaires (`comparison.deltaPercent`) : il n'est donc affiché que sur
 *     cette carte, jamais extrapolé aux autres métriques ;
 *   - les listes n'embarquent aucune image de produit (donnée inexistante).
 *
 * **Pied de page supprimé** à la demande du client : la barre d'actions du bas
 * de la maquette est un résidu de la page ventes ; le tableau de bord ne se
 * termine par rien. L'actualisation manuelle a été remontée dans l'en-tête.
 *
 * Mise en page : en-tête panneau dégradé `from-primary/10 to-base-100` avec
 * carré primaire, logo à droite et sélecteur de période intégré ; cartes de
 * métriques à pastille ; chips de la composition du bénéfice ; graphiques
 * Chart.js existants (`dashboard-charts.tsx`) inchangés, simplement habillés.
 * Aucune couleur en dur : jetons du thème uniquement, le primaire étant
 * configurable par le client.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import {
  Card,
  EmptyState,
  ErrorState,
  MoneyText,
  QuantityText,
  Skeleton,
  SkeletonCards,
  StatusBadge,
  Badge,
} from '@/components/design-system';
import {
  MonthlyEvolutionChart,
  TopProductsChart,
} from '@/components/dashboard/dashboard-charts';
import { RoleGate } from '@/components/role-gate';
import { Tooltip } from '@/components/tooltip';
import { useSettings } from '@/app/parametres/page';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';
import { formatDateShort, formatDateTime } from '@/lib/date-format';
import { formatDelta, formatPercent } from '@/lib/format';
import type { DashboardSnapshot, PeriodKey } from '@/lib/dashboard';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'day', label: "Aujourd'hui" },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'year', label: 'Année' },
  { key: 'total', label: 'Total' },
];

/**
 * Textes des infobulles — regroupés ici pour être relus d'un coup d'œil
 * ------------------------------------------------------------------ */

/**
 * Largeur des bulles du tableau de bord. Les explications font plusieurs
 * phrases : à la largeur par défaut de `Tooltip` (20 rem) elles s'étirent en
 * hauteur. Même valeur que les infobulles longues de la fiche client (§7.2).
 */
const TOOLTIP_MAX_WIDTH = 'min(26rem, calc(100vw - 1rem))';

/**
 * Explication de chaque carte de métrique, affichée au **survol de la pastille**
 * (et au focus clavier) : la bulle s'ouvre immédiatement, et le curseur devient
 * une main pour annoncer qu'il y a quelque chose à lire.
 *
 * Pourquoi les textes sont regroupés ici, et non écrits dans le JSX : sur la
 * fiche client (§7.2) la même règle s'applique — une explication qui dérive du
 * calcul est un mensonge affiché, et on ne la voit qu'en les relisant côte à
 * côte. Un test en recette a montré que « bénéfice » voulait dire deux choses
 * différentes selon l'écran ; ces phrases disent donc explicitement **d'où**
 * vient chaque montant.
 *
 * ⚠️ Ces phrases doivent rester **vraies** :
 *  - chiffre d'affaires et bénéfice viennent de `getPeriodResult()`
 *    (`lib/profit.ts`) : montants **HT**, prestations de chantier incluses, et
 *    c'est exactement ce qu'affiche `/soldes` pour la même période ;
 *  - le coût retenu est le prix d'achat **actuel** du catalogue, pas celui du
 *    jour de la vente (Q20) — c'est ce que dit le mot « estimé » ;
 *  - caisse, créances et dettes sont des **photos** : elles ne dépendent pas de
 *    la période choisie, contrairement au chiffre d'affaires et au bénéfice.
 */
const METRIC_TOOLTIPS = {
  "Chiffre d'affaires":
    'Tout ce qui a été facturé sur la période : ventes de marchandises hors taxes + prestations de chantier. Les brouillons et les documents annulés ne comptent pas. C’est le même montant que sur la page Soldes.',

  'Bénéfice net estimé':
    'Ce qu’il reste une fois toutes les charges payées : chiffre d’affaires − coût d’achat des marchandises vendues − dépenses de fonctionnement − main-d’œuvre. Les prestations de chantier comptent dans le chiffre d’affaires, et leurs matériaux dans le coût. C’est exactement le « Bénéfice net » de la page Soldes. « Estimé », car le coût utilisé est le prix d’achat actuel des produits, pas celui du jour de la vente.',

  'Disponible en caisse':
    'L’argent réellement présent dans la caisse : le dernier solde enregistré, toutes sessions confondues. C’est une photo du moment — ce montant ne change donc pas avec la période choisie.',

  'Créances clients':
    'Tout ce que les clients doivent encore : montant facturé − paiements déjà reçus, toutes périodes confondues. C’est une photo à la date du jour, indépendante de la période choisie.',

  'Dettes fournisseurs':
    'Tout ce que l’entreprise doit encore aux fournisseurs : montant acheté − règlements déjà effectués, toutes périodes confondues. Photo à la date du jour, indépendante de la période choisie.',
} as const;

/**
 * Explication de chaque poste du calcul du bénéfice (« Composition du
 * bénéfice »). C'est le cœur de la lisibilité de la carte : le bénéfice net
 * n'est pas un chiffre tombé du ciel, c'est une soustraction qu'on peut suivre
 * ligne à ligne.
 */
const PROFIT_CHIP_TOOLTIPS = {
  "Chiffre d'affaires":
    'Tout ce qui a été facturé sur la période : ventes hors taxes + prestations de chantier. C’est le point de départ du calcul.',

  'Coût des marchandises':
    'Ce que les marchandises vendues ont coûté : quantité vendue × prix d’achat actuel du produit, plus les matériaux consommés par les chantiers.',

  'Marge brute':
    'Chiffre d’affaires − coût des marchandises. Ce que l’activité rapporte avant de payer les dépenses de fonctionnement et la main-d’œuvre.',

  Dépenses:
    'Frais de fonctionnement de la période : transport, loyer, salaires administratifs, carburant, électricité… Une dépense annulée n’est plus comptée.',

  "Main-d'œuvre":
    'Salaires et paiements de main-d’œuvre des chantiers. Un chantier annulé ne laisse pas sa main-d’œuvre dans le calcul.',

  'Bénéfice net':
    'Marge brute − dépenses − main-d’œuvre. C’est ce que l’activité a réellement rapporté sur la période, et le même montant que sur la page Soldes.',
} as const;

/** Explication de l'en-tête de chaque carte de section du tableau de bord. */
const CARD_TOOLTIPS = {
  'Composition du bénéfice':
    'Le détail du calcul, du chiffre d’affaires au bénéfice net. Chaque pastille est expliquée à son survol.',
  'Évolution sur 12 mois':
    'Chiffre d’affaires, achats et dépenses mois par mois sur les douze derniers mois. Le coût d’achat des marchandises n’y est pas ventilé.',
  'Produits les plus vendus':
    'Les produits qui ont généré le plus de chiffre d’affaires sur la période choisie.',
  'Alertes de stock':
    'Produits en rupture (stock à zéro) ou descendus au seuil d’alerte défini sur leur fiche.',
  'Dernières opérations':
    'Les huit dernières ventes enregistrées, avec leur statut de paiement. Les brouillons n’y figurent pas.',
  'Clients débiteurs':
    'Les clients qui doivent encore de l’argent, du plus gros encours au plus petit, avec leur échéance la plus ancienne.',
} as const;

/* ------------------------------------------------------------------ *
 * Briques visuelles locales (maquette) — copiées des pages ventes et
 * achats validées, jetons du thème uniquement
 * ------------------------------------------------------------------ */

/** Icône de tracé 24×24, `stroke` hérité (aucune couleur en dur). */
function Icon({
  d,
  children,
  className = 'h-5 w-5',
  strokeWidth = 1.8,
}: {
  d?: string;
  children?: React.ReactNode;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      aria-hidden
    >
      {children ?? <path strokeLinecap="round" strokeLinejoin="round" d={d} />}
    </svg>
  );
}

/** Teintes douces des pastilles (variantes /10 du thème). */
const PASTILLE_TONES = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  info: 'bg-info/10 text-info',
  accent: 'bg-accent/10 text-accent',
  warning: 'bg-warning/10 text-warning',
  error: 'bg-error/10 text-error',
  neutral: 'bg-base-200/80 text-base-content/60',
} as const;

type PastilleTone = keyof typeof PASTILLE_TONES;

/**
 * Pastille d'icône (carré arrondi ~40 px) des cartes de métriques et des
 * en-têtes de section.
 *
 * Quand `tooltip` est fourni, la pastille **devient la commande de l'infobulle**
 * (motif déjà en place sur la fiche client, §7.2) :
 *  - la bulle s'ouvre **immédiatement** au survol (`onMouseEnter`) et au focus
 *    clavier (`tabIndex`), et se ferme à la sortie ou sur Échap ;
 *  - le curseur passe en main (`cursor-pointer`) pour annoncer qu'il y a
 *    quelque chose à lire ;
 *  - `role="img"` + `aria-label` donnent un nom accessible à la pastille, qui
 *    n'a aucun texte — sans quoi l'infobulle serait annoncée dans le vide.
 *
 * La commande est la pastille entière (40 px) et non l'icône seule (20 px) :
 * même rendu, mais une cible de survol/focus deux fois plus large.
 *
 * `maxWidth` : ces explications sont des phrases entières (« Bénéfice net
 * estimé » en compte 413 caractères). À la largeur par défaut de `Tooltip`
 * (20 rem), la bulle s'étire en hauteur ; 26 rem est la valeur déjà retenue
 * ailleurs pour un texte de plusieurs phrases (README §7.2).
 */
function Pastille({
  tone,
  tooltip,
  ariaLabel,
  children,
  className = '',
}: {
  tone: PastilleTone;
  /** Explication affichée au survol. Sans elle, la pastille reste inerte. */
  tooltip?: React.ReactNode;
  /** Nom accessible — le titre de la carte ou le libellé de la métrique. */
  ariaLabel?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const base = `flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${PASTILLE_TONES[tone]} ${className}`;

  if (!tooltip) {
    return <span className={base}>{children}</span>;
  }

  return (
    <Tooltip label={tooltip} maxWidth={TOOLTIP_MAX_WIDTH}>
      <span className={`${base} cursor-pointer`} tabIndex={0} role="img" aria-label={ariaLabel}>
        {children}
      </span>
    </Tooltip>
  );
}

/**
 * En-tête de carte : pastille d'icône carrée arrondie (~40 px) + titre gras +
 * sous-titre discret, actions éventuelles à droite (maquette).
 */
function CardTitle({
  icon,
  tone,
  title,
  subtitle,
  actions,
}: {
  icon: React.ReactNode;
  tone: PastilleTone;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  // Le titre sert de clé des infobulles : une carte sans explication n'en a pas.
  const tooltip = CARD_TOOLTIPS[title as keyof typeof CARD_TOOLTIPS];

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Pastille tone={tone} tooltip={tooltip} ariaLabel={title}>
          {icon}
        </Pastille>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-base-content/60">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Carte de métrique : pastille colorée, libellé, valeur en gros puis ligne
 * secondaire. `delta` n'est renseigné que lorsqu'un écart existe réellement
 * dans l'instantané (chiffre d'affaires) — sinon seule l'aide est affichée.
 *
 * La pastille porte l'explication de la métrique (`METRIC_TOOLTIPS`), ouverte
 * immédiatement au survol : c'est elle qui lève l'ambiguïté entre des montants
 * qui ne se comparent pas (chiffre d'affaires de la période, caisse et soldes
 * figés à la date du jour).
 */
function MetricCard({
  label,
  value,
  hint,
  delta,
  tone,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  delta?: number | null;
  tone: PastilleTone;
  icon: React.ReactNode;
}) {
  const hasDelta = typeof delta === 'number' && Number.isFinite(delta);
  const positive = hasDelta && delta! > 0;
  const negative = hasDelta && delta! < 0;
  // Le libellé de la carte est la clé de son explication (METRIC_TOOLTIPS).
  const iconTooltip = METRIC_TOOLTIPS[label as keyof typeof METRIC_TOOLTIPS];

  return (
    <div className="surface-card min-w-0 border border-base-200 bg-base-100 p-4 shadow-sm sm:p-5">
      <Pastille tone={tone} tooltip={iconTooltip} ariaLabel={label}>
        {icon}
      </Pastille>
      <p className="mt-3 truncate text-sm text-base-content/60">{label}</p>
      {/*
       * Même règle que sur la fiche client : le montant ne se coupe jamais.
       * `.metric-amount` + `.metric-value` (app/globals.css) font suivre la
       * taille du chiffre à la largeur de la carte.
       */}
      <div className="metric-amount mt-1">
        <p className="metric-value font-bold tabular">{value}</p>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        {hasDelta && (
          <span
            className={`inline-flex items-center gap-1 font-medium ${
              positive ? 'text-success' : negative ? 'text-error' : 'text-base-content/50'
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-3.5 w-3.5 ${negative ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
            {formatDelta(delta!)}
          </span>
        )}
        {hint && <span className="text-base-content/50">{hint}</span>}
      </div>
    </div>
  );
}

/** Teintes des chips « Composition du bénéfice » (maquette : une par poste). */
const CHIP_TONES = {
  primary: 'bg-primary/15 text-primary border-primary/30',
  info: 'bg-info/15 text-info border-info/30',
  accent: 'bg-accent/15 text-accent border-accent/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  error: 'bg-error/15 text-error border-error/30',
  success: 'bg-success/15 text-success border-success/30',
} as const;

type ChipTone = keyof typeof CHIP_TONES;

/** Chip « libellé / montant » de la composition du bénéfice (maquette). */
function ProfitChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone: ChipTone;
}) {
  // Le libellé du chip est la clé de son explication (PROFIT_CHIP_TOOLTIPS).
  const tooltip = PROFIT_CHIP_TOOLTIPS[label as keyof typeof PROFIT_CHIP_TOOLTIPS];
  const className = `min-w-0 rounded-xl border px-3 py-2 ${CHIP_TONES[tone]}`;

  const content = (
    <>
      <div className="truncate text-[11px] font-semibold uppercase tracking-wide opacity-80">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular">{value}</div>
    </>
  );

  /*
   * Sans explication, le chip reste un simple badge. Avec, il devient une
   * commande : `tabIndex` pour le clavier, et le texte du chip (libellé +
   * montant) sert de nom accessible — inutile de le répéter en `aria-label`.
   */
  if (!tooltip) return <div className={className}>{content}</div>;

  return (
    <Tooltip label={tooltip} maxWidth={TOOLTIP_MAX_WIDTH}>
      <div className={`${className} cursor-pointer`} tabIndex={0}>
        {content}
      </div>
    </Tooltip>
  );
}

const ICONS = {
  /** Maison du fil d'Ariane (maquette). */
  home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2 2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  /** Carré primaire de l'en-tête (maquette : maison). */
  dashboard:
    'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2 2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  money:
    'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  trend: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
  wallet:
    'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
  users:
    'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  building:
    'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5',
  /** Barres du graphe « Évolution » (une seule tracé). */
  chart:
    'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  cube: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  alert:
    'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
  receipt:
    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  refresh:
    'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
} as const;

/* ------------------------------------------------------------------ *
 * En-tête du tableau de bord (maquette) : panneau dégradé, carré
 * primaire, sélecteur de période + logo à droite. Aucun bouton retour :
 * c'est la page d'accueil de l'application.
 * ------------------------------------------------------------------ */
function DashboardHeader({
  periodLabel,
  logo,
  companyName,
  period,
  onPeriodChange,
  isRefreshing,
  onRefresh,
}: {
  periodLabel: string;
  logo: string;
  companyName: string;
  period: PeriodKey;
  onPeriodChange: (key: PeriodKey) => void;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="rounded-3xl border border-base-200 bg-linear-to-r from-primary/10 to-base-100 p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-base-content/60">
            <Icon d={ICONS.home} className="h-3.5 w-3.5" />
            <span>Pilotage</span>
            <span aria-hidden>›</span>
            <span className="font-medium">Tableau de bord</span>
          </div>
          <div className="mt-3 flex items-center gap-3 sm:gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-content shadow-sm sm:h-12 sm:w-12">
              <Icon d={ICONS.dashboard} className="h-6 w-6" strokeWidth={2} />
            </span>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Tableau de bord</h1>
          </div>
          <p className="mt-2.5 max-w-2xl text-sm leading-6 text-base-content/60">
            Activité commerciale, caisse, dettes et stock
            {periodLabel ? ` — ${periodLabel.toLowerCase()}` : ''}.
          </p>
        </div>

        {/* Sélecteur de période existant + actualisation manuelle + logo */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-base-200 bg-base-100/80 p-1">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => onPeriodChange(p.key)}
                className={`btn btn-sm ${period === p.key ? 'btn-primary' : 'btn-ghost'}`}
                aria-pressed={period === p.key}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-square btn-sm shrink-0"
            disabled={isRefreshing}
            onClick={onRefresh}
            aria-label="Actualiser le tableau de bord"
            title="Actualiser"
          >
            {isRefreshing ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <Icon d={ICONS.refresh} className="h-4 w-4" strokeWidth={2} />
            )}
          </button>
          {/* Logo de l'application : `settings.companyLogo` quand un logo est
              téléversé, sinon le logo livré avec l'application. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logo}
            alt={`Logo ${companyName}`}
            className="h-11 w-11 shrink-0 rounded-xl object-contain sm:h-14 sm:w-14"
          />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function DashboardPage() {
  const { settings } = useSettings();
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/operations/snapshot?period=${period}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Chargement du tableau de bord impossible');
      }
      setSnapshot((await res.json()) as DashboardSnapshot);
    } catch (err: any) {
      setError(err?.message ?? 'Chargement impossible');
    } finally {
      setIsLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const companyLogo = settings.companyLogo || DEFAULT_COMPANY_LOGO;
  const companyName = settings.companyName || 'Planète Déco';

  /* -------------------------------- Erreur -------------------------------- */
  if (error) {
    return (
      <div className="space-y-6">
        <DashboardHeader
          periodLabel=""
          logo={companyLogo}
          companyName={companyName}
          period={period}
          onPeriodChange={setPeriod}
          isRefreshing={false}
          onRefresh={() => void load()}
        />
        <Card>
          <ErrorState
            title="Tableau de bord indisponible"
            description={error}
            onRetry={() => void load()}
          />
        </Card>
      </div>
    );
  }

  /* ------------------------------- Chargement ------------------------------ */
  if (isLoading && !snapshot) {
    return (
      <div className="space-y-6">
        <DashboardHeader
          periodLabel=""
          logo={companyLogo}
          companyName={companyName}
          period={period}
          onPeriodChange={setPeriod}
          isRefreshing={false}
          onRefresh={() => void load()}
        />
        <SkeletonCards count={5} />
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const data = snapshot;
  const isEmpty =
    data != null &&
    data.sales.count === 0 &&
    data.jobs.count === 0 &&
    data.recentSales.length === 0 &&
    data.stock.purchaseValue === 0;

  const periodLabel = data?.period.label ?? '';

  return (
    <div className="space-y-6">
      <DashboardHeader
        periodLabel={periodLabel}
        logo={companyLogo}
        companyName={companyName}
        period={period}
        onPeriodChange={setPeriod}
        isRefreshing={isLoading}
        onRefresh={() => {
          void load().then(() => toast.success('Tableau de bord actualisé'));
        }}
      />

      {/* État vide : on propose une action, jamais une page muette. */}
      {isEmpty ? (
        <Card>
          <EmptyState
            title="Aucune activité enregistrée"
            description="Commencez par créer vos produits et vos clients, puis enregistrez votre première vente. Le tableau de bord se remplira automatiquement."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/produits" className="btn btn-primary">
                  Créer mes produits
                </Link>
                <Link href="/ventes/nouvelle" className="btn btn-outline">
                  Nouvelle vente
                </Link>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          {/* ---------------------------- Indicateurs ---------------------------- */}
          {/*
            * Cinq cartes par rangée à partir de `2xl` seulement : à 1366 px,
            * cinq colonnes coupaient les montants (« 162 514 30… »). Voir la
            * règle `.metric-amount` / `.metric-value` dans `app/globals.css`.
            */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-5">
            {/* Seul le chiffre d'affaires dispose d'une comparaison de période
                dans l'instantané : l'écart n'est donc affiché qu'ici. */}
            <MetricCard
              label="Chiffre d'affaires"
              value={<MoneyText value={data!.profit.revenue} bold />}
              delta={data!.comparison.deltaPercent}
              hint={
                typeof data!.comparison.deltaPercent === 'number' &&
                Number.isFinite(data!.comparison.deltaPercent)
                  ? 'vs période précédente'
                  : undefined
              }
              tone="primary"
              icon={<Icon d={ICONS.money} />}
            />
            <MetricCard
              label="Bénéfice net estimé"
              value={<MoneyText value={data!.profit.netProfit} bold colored />}
              hint={`Marge brute ${formatPercent(data!.profit.grossMarginPercent)}`}
              tone="success"
              icon={<Icon d={ICONS.trend} />}
            />
            <MetricCard
              label="Disponible en caisse"
              value={<MoneyText value={data!.cash.balance} bold />}
              hint={
                data!.cash.sessionStatus === 'open'
                  ? `Caisse ouverte${data!.cash.sessionOpenedAt ? ` depuis ${formatDateTime(data!.cash.sessionOpenedAt)}` : ''}`
                  : 'Aucune session ouverte'
              }
              tone="accent"
              icon={<Icon d={ICONS.wallet} />}
            />
            <MetricCard
              label="Créances clients"
              value={<MoneyText value={data!.receivables.total} bold />}
              hint={`${data!.receivables.debtorsCount} client(s) débiteur(s)`}
              tone="warning"
              icon={<Icon d={ICONS.users} />}
            />
            <MetricCard
              label="Dettes fournisseurs"
              value={<MoneyText value={data!.payables.total} bold />}
              hint={`${data!.payables.creditorsCount} fournisseur(s) à régler`}
              tone="info"
              icon={<Icon d={ICONS.building} />}
            />
          </div>

          {/* ------------------------- Détail du bénéfice ------------------------- */}
          <Card className="min-w-0">
            <CardTitle
              icon={
                <Icon>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
                </Icon>
              }
              tone="success"
              title="Composition du bénéfice"
              subtitle="Chiffre d’affaires HT + prestations de chantier, coût des marchandises, dépenses et main-d’œuvre — la même définition que la page Soldes (§15). Aucun montant n’est stocké : tout est recalculé à la lecture."
            />

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <ProfitChip
                label="Chiffre d'affaires"
                value={<MoneyText value={data!.profit.revenue} />}
                tone="primary"
              />
              <ProfitChip
                label="Coût des marchandises"
                value={<MoneyText value={data!.profit.cogs} />}
                tone="info"
              />
              <ProfitChip
                label="Marge brute"
                value={<MoneyText value={data!.profit.grossProfit} />}
                tone="accent"
              />
              <ProfitChip
                label="Dépenses"
                value={<MoneyText value={data!.profit.expenses} />}
                tone="warning"
              />
              <ProfitChip
                label="Main-d'œuvre"
                value={<MoneyText value={data!.profit.laborCost} />}
                tone="error"
              />
              <ProfitChip
                label="Bénéfice net"
                value={<MoneyText value={data!.profit.netProfit} />}
                tone={data!.profit.netProfit >= 0 ? 'success' : 'error'}
              />
            </div>

            {data!.jobs.revenue > 0 && (
              <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-info/10 px-4 py-3 text-sm text-info">
                <Icon d={ICONS.info} className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Dont <strong>{data!.jobs.count}</strong> prestation(s) de chantier pour{' '}
                  <MoneyText value={data!.jobs.revenue} /> — <strong>incluses</strong> dans le
                  chiffre d’affaires ci-dessus, jamais comptées deux fois : ce sont des documents
                  facturables autonomes, comme sur la page Soldes.
                </p>
              </div>
            )}
          </Card>

          {/* ------------------------------ Graphiques ---------------------------- */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardTitle
                icon={<Icon d={ICONS.chart} />}
                tone="primary"
                title="Évolution sur 12 mois"
                subtitle="Ventes, achats et dépenses par mois."
              />
              <div className="mt-4">
                <MonthlyEvolutionChart data={data!.monthly} />
              </div>
            </Card>

            <Card className="min-w-0">
              <CardTitle
                icon={<Icon d={ICONS.cube} />}
                tone="info"
                title="Produits les plus vendus"
                subtitle={`Chiffre d'affaires par produit — ${periodLabel.toLowerCase()}.`}
              />
              <div className="mt-4">
                {data!.topProducts.length === 0 ? (
                  <EmptyState
                    title="Aucune vente sur la période"
                    description="Les produits les plus vendus apparaîtront ici dès la première vente enregistrée."
                  />
                ) : (
                  <TopProductsChart data={data!.topProducts} />
                )}
              </div>
            </Card>
          </div>

          {/* --------------------------- Alertes et listes ------------------------ */}
          <div className="grid gap-5 lg:grid-cols-2">
            {/* En-tête de tableau et lignes sur la même grille : le nom du
                produit se comprime (minmax), jamais de défilement horizontal. */}
            <Card padded={false} className="min-w-0">
              <div className="px-5 pt-5">
                <CardTitle
                  icon={<Icon d={ICONS.alert} />}
                  tone="warning"
                  title="Alertes de stock"
                  subtitle={`${data!.stock.lowStockCount} produit(s) sous le seuil, ${data!.stock.outOfStockCount} en rupture.`}
                  actions={
                    <Link href="/stocks" className="btn btn-ghost btn-sm">
                      Voir le stock
                    </Link>
                  }
                />
              </div>

              {data!.stock.alerts.length === 0 ? (
                <div className="px-5 pb-5">
                  <EmptyState
                    title="Aucune alerte de stock"
                    description="Tous les produits sont au-dessus de leur seuil d’alerte."
                  />
                </div>
              ) : (
                <>
                  <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-y border-base-200 bg-base-200/40 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-base-content/50">
                    <span>Produit</span>
                    <span className="text-right">Stock actuel</span>
                    <span className="text-right">Statut</span>
                  </div>
                  <ul className="divide-y divide-base-200">
                    {data!.stock.alerts.map((product) => (
                      <li
                        key={product.id}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-5 py-3"
                      >
                        <p className="truncate text-sm font-medium">{product.name}</p>
                        <QuantityText value={product.stock} unit={product.unit} className="text-sm" />
                        <Badge tone={product.isOut ? 'error' : 'warning'}>
                          {product.isOut ? 'Rupture' : 'Stock faible'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>

            <Card padded={false} className="min-w-0">
              <div className="px-5 pt-5">
                <CardTitle
                  icon={<Icon d={ICONS.receipt} />}
                  tone="primary"
                  title="Dernières opérations"
                  subtitle="Les huit dernières ventes enregistrées."
                  actions={
                    <RoleGate action="sales.view">
                      <Link href="/ventes" className="btn btn-ghost btn-sm">
                        Toutes les ventes
                      </Link>
                    </RoleGate>
                  }
                />
              </div>

              {data!.recentSales.length === 0 ? (
                <div className="px-5 pb-5">
                  <EmptyState
                    title="Aucune vente enregistrée"
                    description="Enregistrez votre première vente pour la voir apparaître ici."
                    action={
                      <Link href="/ventes/nouvelle" className="btn btn-primary btn-sm">
                        Nouvelle vente
                      </Link>
                    }
                  />
                </div>
              ) : (
                <ul className="mt-4 divide-y divide-base-200 border-t border-base-200">
                  {data!.recentSales.map((sale) => (
                    <li key={sale.id}>
                      <Link
                        href={`/ventes/${sale.id}`}
                        className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-base-200/60"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {sale.customerName || 'Client comptoir'}
                          </p>
                          <p className="truncate text-xs text-base-content/50">
                            {sale.invoiceNumber} · {formatDateShort(sale.date)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <MoneyText value={sale.total} className="text-sm" />
                          <StatusBadge status={sale.paymentStatus} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* ------------------------ Clients débiteurs ------------------------- */}
          {data!.receivables.top.length > 0 && (
            <Card padded={false} className="min-w-0">
              <div className="px-5 pt-5">
                <CardTitle
                  icon={<Icon d={ICONS.users} />}
                  tone="info"
                  title="Clients débiteurs"
                  subtitle="Les encours les plus importants à relancer."
                  actions={
                    <Link href="/soldes" className="btn btn-ghost btn-sm">
                      Voir tous les soldes
                    </Link>
                  }
                />
              </div>
              <ul className="mt-4 divide-y divide-base-200 border-t border-base-200">
                {data!.receivables.top.map((customer) => (
                  <li key={customer.id}>
                    <Link
                      href={`/clients/${customer.id}`}
                      className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-base-200/60"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{customer.name}</p>
                        <p className="truncate text-xs text-base-content/50">
                          {customer.phone ?? 'Sans téléphone'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {customer.overdue && <Badge tone="error">En retard</Badge>}
                        {/* Solde dû par le client : rouge dès qu'il reste quelque
                            chose à encaisser. */}
                        <MoneyText value={customer.balance} className="text-sm" due bold />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      {/* Aucun pied de page : demande explicite du client. */}
    </div>
  );
}
