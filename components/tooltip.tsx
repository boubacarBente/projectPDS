'use client';

/**
 * Enveloppe une commande pour lui donner une **bulle d'explication** (tooltip
 * daisyUI 5), ouverte au survol **et** au focus clavier du bouton lui-même.
 *
 * Pourquoi ce composant
 * ---------------------
 * Un `title` natif s'affiche après une seconde, dans une bulle système qui
 * ignore le thème et **ne s'ouvre pas au clavier**. Ici la bulle suit le thème,
 * s'ouvre au survol comme au focus (`:focus-visible` de daisyUI), reste dans la
 * fenêtre (jetons `--tt-*` de daisyUI) et son texte est **relié au bouton** par
 * `aria-describedby` : les lecteurs d'écran annoncent l'explication.
 *
 * Usage
 * -----
 * ```tsx
 * <Tooltip label="Un brouillon ne touche ni le stock ni la caisse.">
 *   <button className="btn">Enregistrer comme brouillon</button>
 * </Tooltip>
 * ```
 * L'enfant doit être **un seul élément** : le composant y ajoute
 * `aria-describedby` (par `cloneElement`), donc rien à câbler à la main.
 *
 * ⚠️ Ce composant est client (il génère un identifiant) : il vit hors de
 * `components/design-system.tsx`, qui reste volontairement sans état.
 */

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

interface TooltipProps {
  /** Le texte de l'explication. */
  label: ReactNode;
  /** La commande à envelopper (un seul élément). */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  /** Côté d'affichage. Par défaut au-dessus (barre d'actions en bas de fenêtre). */
  side?: 'top' | 'bottom' | 'start' | 'end';
  className?: string;
}

export function Tooltip({ label, children, side = 'top', className = '' }: TooltipProps) {
  const id = useId();

  return (
    <div className={`tooltip tooltip-${side} ${className}`.trim()}>
      <div className="tooltip-content">
        <div id={id} className="max-w-xs text-left leading-snug">
          {label}
        </div>
      </div>
      {isValidElement(children) ? cloneElement(children, { 'aria-describedby': id }) : children}
    </div>
  );
}
