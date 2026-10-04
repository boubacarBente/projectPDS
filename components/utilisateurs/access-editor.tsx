'use client';

/**
 * Rôles et droits « en mots simples » (refonte du 4 octobre 2026, README §17.2).
 *
 * Trois briques, utilisées par l'assistant de création et par la fiche d'un
 * compte :
 *  - `RoleChooser` : le rôle se choisit sur des cartes qui disent ce que la
 *    personne peut et ne peut pas faire, pas sur une liste de codes ;
 *  - `AccessSummary` : ce que le rôle permet, domaine par domaine ;
 *  - `AccessEditor` : la personnalisation d'un compte, un niveau par domaine
 *    (Aucun accès → Consulter → Saisir → Gérer) au lieu de 60 cases.
 *
 * Tout vient de `lib/permissions.ts` (module sans dépendance serveur). Le
 * serveur reste seul juge : ces écrans ne font que composer des permissions.
 */

import {
  ACCESS_AREAS,
  ACCESS_LEVEL_LABELS,
  ROLE_LABELS,
  ROLE_PROFILES,
  actionsForAreaLevel,
  areaLevelOf,
  areaLevels,
  type AccessArea,
  type AccessLevel,
  type Action,
  type Role,
} from '@/lib/permissions';

export type AreaChoice = AccessLevel | 'custom';
export type AccessChoices = Record<string, AreaChoice>;

/** Niveau de chaque domaine pour un ensemble de permissions. */
export function choicesFromActions(actions: Iterable<Action>): AccessChoices {
  const list = [...actions];
  return Object.fromEntries(ACCESS_AREAS.map((area) => [area.id, areaLevelOf(area, list)]));
}

/**
 * Permissions voulues : un domaine resté « personnalisé » (réglage fin fait
 * avant la refonte) garde exactement ses permissions actuelles.
 */
export function actionsFromChoices(choices: AccessChoices, current: Action[]): Action[] {
  return ACCESS_AREAS.flatMap((area) => {
    const choice = choices[area.id] ?? 'none';
    if (choice === 'custom') {
      const own = new Set(area.levels.flatMap((l) => l.actions));
      return current.filter((a) => own.has(a));
    }
    return actionsForAreaLevel(area, choice);
  });
}

/** Libellé du niveau choisi pour un domaine (« Vendre et encaisser »…). */
export function levelDetail(area: AccessArea, choice: AreaChoice): string {
  if (choice === 'custom') return 'Réglage personnalisé (fait avant la nouvelle présentation)';
  if (choice === 'none') return 'Ne voit pas cette partie de l’application';
  return area.levels.find((l) => l.level === choice)?.label ?? ACCESS_LEVEL_LABELS[choice];
}

const LEVEL_TONE: Record<AreaChoice, string> = {
  none: 'bg-base-200 text-base-content/60',
  view: 'bg-info/15 text-info',
  edit: 'bg-primary/15 text-primary',
  manage: 'bg-warning/25 text-base-content',
  custom: 'bg-secondary/15 text-secondary',
};

export function LevelPill({ choice }: { choice: AreaChoice }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${LEVEL_TONE[choice]}`}>
      {choice === 'custom' ? 'Personnalisé' : ACCESS_LEVEL_LABELS[choice]}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Choix du rôle
 * ------------------------------------------------------------------ */

export function RoleChooser({
  value,
  onChange,
  roles,
  disabled,
}: {
  value: Role;
  onChange: (role: Role) => void;
  roles: Role[];
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Rôle du compte" className="grid gap-3 sm:grid-cols-2">
      {roles.map((role) => {
        const profile = ROLE_PROFILES[role];
        const selected = value === role;
        return (
          <button
            key={role}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(role)}
            className={`rounded-2xl border-2 p-4 text-left transition-colors ${
              selected ? 'border-primary bg-primary/5' : 'border-base-200 hover:border-base-300'
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-semibold">{ROLE_LABELS[role]}</span>
              <span
                aria-hidden
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  selected ? 'border-primary bg-primary' : 'border-base-300'
                }`}
              >
                {selected && <span className="h-2 w-2 rounded-full bg-primary-content" />}
              </span>
            </span>
            <span className="mt-1 block text-sm text-base-content/70">{profile.summary}</span>
            <ul className="mt-3 space-y-1 text-xs">
              {profile.can.map((item) => (
                <li key={item} className="flex gap-1.5">
                  <span aria-hidden className="text-success">✓</span>
                  <span>{item}</span>
                </li>
              ))}
              {profile.cannot.map((item) => (
                <li key={item} className="flex gap-1.5 text-base-content/60">
                  <span aria-hidden>✕</span>
                  <span>
                    <span className="sr-only">Ne peut pas : </span>
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Résumé des droits (lecture seule)
 * ------------------------------------------------------------------ */

export function AccessSummary({ choices, compact = false }: { choices: AccessChoices; compact?: boolean }) {
  const visible = ACCESS_AREAS.filter((area) => !compact || (choices[area.id] ?? 'none') !== 'none');
  return (
    <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
      {visible.map((area) => {
        const choice = choices[area.id] ?? 'none';
        return (
          <li key={area.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="min-w-0">
              <span className="block text-sm font-medium">{area.label}</span>
              <span className="block text-xs text-base-content/60">{levelDetail(area, choice)}</span>
            </span>
            <LevelPill choice={choice} />
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * Personnalisation : un niveau par domaine
 * ------------------------------------------------------------------ */

export function AccessEditor({
  choices,
  roleChoices,
  onChange,
  disabled,
}: {
  choices: AccessChoices;
  /** Niveaux par défaut du rôle : repère « comme le rôle ». */
  roleChoices: AccessChoices;
  onChange: (choices: AccessChoices) => void;
  disabled?: boolean;
}) {
  return (
    // Deux colonnes sur grand écran : quinze domaines tiennent sans défiler sans fin.
    <ul className="grid gap-2 xl:grid-cols-2">
      {ACCESS_AREAS.map((area) => {
        const choice = choices[area.id] ?? 'none';
        const roleChoice = roleChoices[area.id] ?? 'none';
        const changed = choice !== roleChoice;
        return (
          <li
            key={area.id}
            className={`rounded-xl border px-3 py-3 ${changed ? 'border-primary/40 bg-primary/5' : 'border-base-200'}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{area.label}</p>
                <p className="text-xs text-base-content/60">{area.description}</p>
              </div>
              {changed && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs min-h-11 sm:min-h-0"
                  disabled={disabled}
                  onClick={() => onChange({ ...choices, [area.id]: roleChoice })}
                >
                  Revenir au rôle
                </button>
              )}
            </div>
            <div role="radiogroup" aria-label={area.label} className="mt-2 flex flex-wrap gap-1.5">
              {areaLevels(area).map((level) => {
                const active = choice === level;
                return (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={disabled}
                    onClick={() => onChange({ ...choices, [area.id]: level })}
                    className={`btn btn-sm min-h-11 sm:min-h-0 ${active ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                  >
                    {ACCESS_LEVEL_LABELS[level]}
                    {roleChoice === level && (
                      <span className={`text-[10px] font-normal ${active ? 'opacity-80' : 'text-base-content/50'}`}>
                        (rôle)
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-base-content/70">{levelDetail(area, choice)}</p>
          </li>
        );
      })}
    </ul>
  );
}
