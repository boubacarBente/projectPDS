const DAY_NAMES = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    value = `${value}T12:00:00`;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDateShort(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${DAY_NAMES[d.getDay()]} ${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
}

export function formatDateWithTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${DAY_NAMES[d.getDay()]} ${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

export function formatDateLong(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${DAY_NAMES[d.getDay()]} ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

export function formatMonthYear(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${DAY_NAMES[d.getDay()]} ${d.toLocaleString('fr-FR')}`;
}