import type { ReactNode } from 'react';
import { formatCurrency, formatQuantity, formatDelta } from '@/lib/format';

/* ==================================================================
 * Bibliothèque de composants Planète Déco (README §5.3)
 *
 * Composants **purement présentationnels** : aucun état, aucun hook. Ils
 * s'utilisent aussi bien dans un composant serveur que dans un composant
 * client, ce qui évite d'alourdir le bundle par réflexe.
 *
 * Les composants interactifs vivent dans leurs fichiers dédiés :
 * `confirm-dialog.tsx`, `role-gate.tsx`, `data-toolbar.tsx`.
 * ================================================================== */

/* ------------------------------------------------------------------
 * Montants et quantités — `tabular-nums` obligatoire (§5.3)
 * ------------------------------------------------------------------ */

export function MoneyText({
  value,
  currency,
  className = '',
  colored = false,
  bold = false,
}: {
  value: number | null | undefined;
  currency?: string;
  className?: string;
  /** Colore en rouge si négatif, en vert si positif (utile pour un solde). */
  colored?: boolean;
  bold?: boolean;
}) {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const tone = colored ? (amount < 0 ? 'text-error' : amount > 0 ? 'text-success' : '') : '';

  return (
    <span className={`money tabular ${tone} ${bold ? 'font-semibold' : ''} ${className}`.trim()}>
      {formatCurrency(amount, currency)}
    </span>
  );
}

export function QuantityText({
  value,
  unit,
  className = '',
}: {
  value: number | null | undefined;
  unit?: string | null;
  className?: string;
}) {
  return (
    <span className={`quantity tabular ${className}`.trim()}>{formatQuantity(value, unit)}</span>
  );
}

/* ------------------------------------------------------------------
 * StatusBadge — Payée / Partiel / Impayée / Annulée (§5.3)
 * Jamais la couleur seule : un libellé accompagne toujours la teinte.
 * ------------------------------------------------------------------ */

export type BadgeTone = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'primary';

const TONE_CLASSES: Record<BadgeTone, string> = {
  success: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  error: 'bg-error/15 text-error border-error/30',
  info: 'bg-info/15 text-info border-info/30',
  primary: 'bg-primary/15 text-primary border-primary/30',
  neutral: 'bg-base-300 text-base-content/70 border-base-300',
};

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={`badge-pill inline-flex items-center gap-1 border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}

const PAYMENT_STATUS_MAP: Record<string, { label: string; tone: BadgeTone }> = {
  paid: { label: 'Payée', tone: 'success' },
  partial: { label: 'Partiel', tone: 'warning' },
  unpaid: { label: 'Impayée', tone: 'error' },
};

const INVOICE_STATUS_MAP: Record<string, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  draft: { label: 'Brouillon', tone: 'neutral' },
  cancelled: { label: 'Annulée', tone: 'error' },
};

/** Statut de paiement, statut de document, ou libellé libre. */
export function StatusBadge({
  status,
  kind = 'payment',
  label,
}: {
  status: string | null | undefined;
  kind?: 'payment' | 'invoice';
  label?: string;
}) {
  const map = kind === 'payment' ? PAYMENT_STATUS_MAP : INVOICE_STATUS_MAP;
  const entry = status ? map[status] : undefined;
  const tone = entry?.tone ?? 'neutral';
  const text = label ?? entry?.label ?? status ?? '—';
  return <Badge tone={tone}>{text}</Badge>;
}

/** Statut de paiement dérivé du restant dû, quand le montant est la source. */
export function paymentStatusFrom(total: number, paid: number): 'paid' | 'partial' | 'unpaid' {
  if (paid <= 0) return 'unpaid';
  if (paid + 0.001 >= total) return 'paid';
  return 'partial';
}

/* ------------------------------------------------------------------
 * Les 5 états obligatoires : Vide, Chargement, Erreur (+ Nominal, Feedback)
 * ------------------------------------------------------------------ */

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  /** Toujours proposer une action : « Créer la première vente ». */
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-base-300/60 text-base-content/40">
        {icon ?? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-7 w-7"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
            />
          </svg>
        )}
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-base-content/60">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Jamais un écran blanc : message lisible + bouton « Réessayer ». */
export function ErrorState({
  title = 'Une erreur est survenue',
  description,
  onRetry,
  retryLabel = 'Réessayer',
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error/10 text-error">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-7 w-7"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          />
        </svg>
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-base-content/60">{description}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn btn-primary btn-sm mt-5">
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/** Squelette épousant la forme du contenu — jamais un spinner plein écran. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-base-300/60 ${className}`.trim()} />;
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="surface-card border border-base-200 bg-base-100 p-5 shadow-sm">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-7 w-32" />
          <Skeleton className="mt-3 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="surface-card overflow-hidden border border-base-200 bg-base-100 shadow-sm">
      <div className="border-b border-base-200 bg-base-200/60 px-4 py-3">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="divide-y divide-base-200">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3.5">
            {Array.from({ length: cols }).map((__, c) => (
              <Skeleton key={c} className={`h-4 ${c === 0 ? 'w-40' : 'w-20'}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
 * Structure de page
 * ------------------------------------------------------------------ */

/** Section titrée d'une page : titre + sous-titre + actions à droite. */
export function PageSection({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    /*
     * `min-w-0` : un enfant de grille a `min-width: auto`, donc il refuse de
     * rétrécir sous la largeur minimale de son contenu. Dans une grille à deux
     * colonnes qui passe à une seule (mobile), les sections « Alertes de stock »
     * et « Dernières opérations » gardaient leur largeur minimale (364 px) et
     * débordaient de l'écran de 51 px. Mesuré et corrigé : le contenu se
     * comprime, les lignes tronquent, l'en-tête passe à la ligne.
     */
    <section className={`min-w-0 space-y-4 ${className}`.trim()}>
      {(title || actions) && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            {title && <h2 className="text-lg font-semibold">{title}</h2>}
            {subtitle && <p className="text-sm text-base-content/60">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Champ de formulaire : label + aide + erreur, toujours dans cet ordre. */
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className = '',
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`form-control w-full ${className}`.trim()}>
      <label className="label py-1" htmlFor={htmlFor}>
        <span className="label-text text-sm font-medium">
          {label}
          {required && <span className="ml-0.5 text-error">*</span>}
        </span>
      </label>
      {children}
      {/*
       * Le texte d'aide doit pouvoir **passer à la ligne**.
       *
       * DaisyUI définit `.label` en `inline-flex` + `white-space: nowrap` : le
       * libellé prenait donc la largeur de sa phrase entière, quelle que soit la
       * place disponible. Dans une modale ou une colonne de formulaire étroite,
       * il débordait de son cadre et poussait la page horizontalement (constaté
       * sur /parametres, /ventes/nouvelle, et les modales client / stock /
       * chantier). `w-full` + `flex-wrap` + `whitespace-normal` rendent le texte
       * à la largeur du champ.
       */}
      {error ? (
        <label className="label w-full flex-wrap whitespace-normal py-1">
          <span className="label-text-alt whitespace-normal text-error">{error}</span>
        </label>
      ) : hint ? (
        <label className="label w-full flex-wrap whitespace-normal py-1">
          <span className="label-text-alt whitespace-normal text-base-content/50">{hint}</span>
        </label>
      ) : null}
    </div>
  );
}

/** Ligne « libellé : valeur » d'une fiche de détail. */
export function InfoRow({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 py-1.5 ${className}`.trim()}>
      <span className="text-sm text-base-content/60">{label}</span>
      <span className="text-right text-sm font-medium">{children}</span>
    </div>
  );
}

/** Valeur + variation vs période précédente (README §5.3). */
export function StatCardDelta({
  label,
  value,
  delta,
  hint,
  icon,
  tone = 'primary',
}: {
  label: string;
  value: ReactNode;
  /** Variation en pourcentage ; `null` = pas de comparaison disponible. */
  delta?: number | null;
  hint?: string;
  icon?: ReactNode;
  tone?: BadgeTone;
}) {
  const hasDelta = typeof delta === 'number' && Number.isFinite(delta);
  const positive = hasDelta && delta! > 0;
  const negative = hasDelta && delta! < 0;

  return (
    <div className="surface-card border border-base-200 bg-base-100 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm text-base-content/60">{label}</span>
        {icon && (
          <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${TONE_CLASSES[tone]}`}>
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-bold tabular">{value}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {hasDelta && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium ${
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
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
            {formatDelta(delta!)}
          </span>
        )}
        {hint && <span className="text-xs text-base-content/50">{hint}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
 * StageTracker — avancement d'un processus (moulage → stock, découpe → livré)
 * ------------------------------------------------------------------ */

export type Stage = { key: string; label: string };

export function StageTracker({
  stages,
  current,
  className = '',
}: {
  stages: Stage[];
  current: string;
  className?: string;
}) {
  const currentIndex = Math.max(
    0,
    stages.findIndex((s) => s.key === current),
  );

  return (
    <ol className={`flex flex-wrap items-center gap-1.5 ${className}`.trim()}>
      {stages.map((stage, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li key={stage.key} className="flex items-center gap-1.5">
            <span
              className={`badge-pill inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-medium ${
                active
                  ? 'border-primary/40 bg-primary/15 text-primary'
                  : done
                    ? 'border-success/30 bg-success/15 text-success'
                    : 'border-base-300 bg-base-200 text-base-content/45'
              }`}
            >
              {done ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3 w-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={3}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <span className="tabular text-[10px] font-bold">{index + 1}</span>
              )}
              {stage.label}
            </span>
            {index < stages.length - 1 && (
              <span
                className={`h-px w-4 sm:w-6 ${done ? 'bg-success/50' : 'bg-base-300'}`}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------
 * Divers
 * ------------------------------------------------------------------ */

/** Carte de contenu générique, cohérente avec `SurfaceCard` de Gaz. */
export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`surface-card border border-base-200 bg-base-100 shadow-sm ${padded ? 'p-5' : ''} ${className}`.trim()}
    >
      {children}
    </div>
  );
}

/** Libellé + valeur compact, pour les barres de résumé. */
export function MiniStat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${TONE_CLASSES[tone]}`}>
      <div className="text-[11px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-sm font-semibold tabular">{value}</div>
    </div>
  );
}
