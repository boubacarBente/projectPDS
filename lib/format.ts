/**
 * Formatage monétaire, quantitatif et de date (README §6.5 et §26).
 *
 * Règle 8 : **toute** routine d'affichage monétaire passe par `formatCurrency`
 * (`Intl.NumberFormat('fr-FR')` + devise). Règle 9 : toute date affichée passe
 * par `lib/date-format.ts`, toute date stockée est `YYYY-MM-DD`.
 */

export const DEFAULT_CURRENCY = 'GNF';

/** Un montant en GNF, sans arrondi avant affichage, avec séparateurs français. */
export function formatCurrency(
  value: number | null | undefined,
  currency: string = DEFAULT_CURRENCY,
  options: { withCurrency?: boolean; decimals?: number } = {},
): string {
  const { withCurrency = true, decimals = 0 } = options;
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;

  const formatted = new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);

  return withCurrency ? `${formatted} ${currency}` : formatted;
}

/** Montant compact pour un graphique ou une carte (1,2 M / 340 k). */
export function formatCurrencyCompact(value: number | null | undefined, currency = DEFAULT_CURRENCY): string {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const abs = Math.abs(amount);

  if (abs >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1).replace('.', ',')} Md ${currency}`;
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(1).replace('.', ',')} M ${currency}`;
  if (abs >= 1_000) return `${(amount / 1_000).toFixed(1).replace('.', ',')} k ${currency}`;
  return formatCurrency(amount, currency);
}

/**
 * Quantité : décimale seulement quand elle est significative.
 * Le m² et le kg sont décimaux, la pièce ne l'est pas — afficher « 12,000 pièces »
 * serait une faute de lecture pour un comptable.
 */
export function formatQuantity(value: number | null | undefined, unit?: string | null): string {
  const quantity = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const isInteger = Number.isInteger(quantity);

  const formatted = new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: isInteger ? 0 : 0,
    maximumFractionDigits: isInteger ? 0 : 3,
  }).format(quantity);

  return unit ? `${formatted} ${unit}` : formatted;
}

/** Nombre nu, pour une cellule de tableau. */
export function formatNumber(value: number | null | undefined, decimals = 0): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** Pourcentage, arrondi à une décimale. */
export function formatPercent(value: number | null | undefined, decimals = 1): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n)} %`;
}

/** Écart signé, pour une comparaison de période (+12,4 % / −3,1 %). */
export function formatDelta(value: number | null | undefined, decimals = 1): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${formatPercent(Math.abs(n), decimals)}`;
}

/** Date du jour au format métier `YYYY-MM-DD` (fuseau local, pas UTC). */
export function today(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** `YYYY-MM-DD` → `Date` à midi local, pour éviter tout décalage de fuseau. */
export function parseBusinessDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(date: string, days: number): string {
  const d = parseBusinessDate(date) ?? new Date();
  d.setDate(d.getDate() + days);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: string): string {
  const d = parseBusinessDate(date);
  if (!d) return date;
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const month = String(last.getMonth() + 1).padStart(2, '0');
  const day = String(last.getDate()).padStart(2, '0');
  return `${last.getFullYear()}-${month}-${day}`;
}

/** Lundi de la semaine ISO contenant `date`. */
export function startOfWeek(date: string): string {
  const d = parseBusinessDate(date);
  if (!d) return date;
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(date, diff);
}

/** Bornes de la période précédente, de même durée (comparaison §16). */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const start = parseBusinessDate(from);
  const end = parseBusinessDate(to);
  if (!start || !end) return { from, to };
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { from: prevFrom, to: prevTo };
}

/** Arrondi monétaire sûr : deux décimales, sans erreur de flottant visible. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Évite `-0` à l'affichage et les `null` qui remontent dans les calculs. */
export function safeNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function truncate(value: string | null | undefined, max = 40): string {
  if (!value) return '—';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
