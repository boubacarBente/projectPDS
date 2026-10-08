'use client';

import { useRef, type KeyboardEvent } from 'react';

/**
 * Barre d'onglets d'une fiche (chantier, magasin…), placée **juste sous
 * l'en-tête de page**.
 *
 * Les onglets daisyUI (`tabs tabs-boxed`) passaient pour du texte : gris sur
 * gris, sans bordure ni effet au survol, et posés sous les cartes chiffrées, on
 * ne devinait pas que la fiche se pilotait par eux. Ici chaque onglet est une
 * **pastille bordée** qui réagit au survol (fond, bordure, curseur main),
 * l'onglet ouvert est **plein en couleur primaire**, un compteur dit ce que
 * contient la rubrique, et une légende rappelle qu'on clique pour afficher.
 *
 * Clavier (motif ARIA « tabs ») : flèches gauche/droite, Début et Fin.
 * Téléphone : la barre défile horizontalement, jamais la page. Dès `sm`, les
 * onglets passent à la ligne : tous visibles, aucun caché derrière un défilement.
 */
export type SectionTab<K extends string> = {
  key: K;
  label: string;
  /** Nombre d'éléments de la rubrique ; absent = pas de compteur. */
  count?: number;
};

export function SectionTabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  hint = 'Cliquez sur une rubrique pour l’afficher',
}: {
  tabs: SectionTab<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Nom de la barre pour les lecteurs d'écran, ex. « Rubriques du chantier ». */
  label: string;
  hint?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function focusAt(index: number) {
    const next = (index + tabs.length) % tabs.length;
    onChange(tabs[next].key);
    refs.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowRight') focusAt(index + 1);
    else if (event.key === 'ArrowLeft') focusAt(index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(tabs.length - 1);
    else return;
    event.preventDefault();
  }

  return (
    <nav aria-label={label} className="rounded-2xl border border-base-200 bg-base-100 p-2 shadow-sm">
      <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
        {label} <span className="font-normal normal-case tracking-normal">— {hint}</span>
        <span className="font-normal normal-case tracking-normal sm:hidden"> (glissez pour voir les autres)</span>
      </p>
      <div className="-mx-1 overflow-x-auto px-1 pb-0.5 sm:overflow-visible">
        <div role="tablist" aria-label={label} className="flex min-w-max gap-1.5 sm:min-w-0 sm:flex-wrap">
          {tabs.map((tab, index) => {
            const active = tab.key === value;
            return (
              <button
                key={tab.key}
                ref={(el) => {
                  refs.current[index] = el;
                }}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onChange(tab.key)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={`inline-flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap rounded-xl border px-3.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                  active
                    ? 'border-primary bg-primary text-primary-content shadow-sm'
                    : 'border-base-300 bg-base-100 text-base-content/80 hover:border-primary/50 hover:bg-primary/10 hover:text-base-content'
                }`}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span
                    className={`tabular rounded-full px-1.5 text-[11px] font-semibold leading-5 ${
                      active ? 'bg-primary-content/20 text-primary-content' : 'bg-base-200 text-base-content/70'
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
