/**
 * Types de prestation des chantiers.
 *
 * Avant la v2, le type était un **code figé** dans le code (alucobond, staff,
 * placo, furniture, painting) : un magasin d'électricité ne pouvait pas créer
 * un chantier « Électricité ». Désormais, c'est une **liste fermée modifiable**
 * dans les paramètres (`settings.jobCategories`), commune à tous les magasins :
 * chacun ouvre un chantier de n'importe quel type, et les rapports regroupent
 * sans doublon (« Électricité » et « electricite » ne peuvent pas coexister).
 *
 * Le libellé est stocké tel quel dans `service_jobs.category`. Les chantiers
 * créés avant la v2 gardent leur ancien code : il est traduit à la lecture (pas
 * de migration de base, rien n'est réécrit).
 *
 * Module **sans base de données** : importable côté client.
 */

/** Anciens codes (v1) → libellé de la liste par défaut. */
export const LEGACY_JOB_CATEGORY_LABELS: Record<string, string> = {
  alucobond: 'Alucobond / façade',
  staff: 'Plâtre / staff',
  placo: 'Placo / faux plafond',
  furniture: 'Menuiserie / meubles',
  painting: 'Peinture',
};

/** Libellé affichable d'un type de prestation (ancien code traduit). */
export function jobCategoryLabel(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '—';
  return LEGACY_JOB_CATEGORY_LABELS[raw] ?? raw;
}

/**
 * Valeurs stockées qui correspondent à un libellé : le libellé lui-même, plus
 * l'ancien code s'il existe (filtre « type » de la liste des chantiers).
 */
export function jobCategoryStoredValues(label: string): string[] {
  const legacy = Object.entries(LEGACY_JOB_CATEGORY_LABELS)
    .filter(([, l]) => l.toLowerCase() === label.trim().toLowerCase())
    .map(([code]) => code);
  return [label.trim(), ...legacy];
}

/**
 * Retrouve le libellé canonique de la liste (casse de la liste), ou `null` si
 * la valeur n'en fait pas partie.
 */
export function matchJobCategory(value: unknown, list: string[]): string | null {
  const wanted = jobCategoryLabel(String(value ?? '')).toLowerCase();
  return list.find((item) => item.toLowerCase() === wanted) ?? null;
}
