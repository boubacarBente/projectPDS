'use client';

/**
 * Icône d'aide « ? » avec une bulle d'explication (tooltip daisyUI 5).
 *
 * Pourquoi ce composant
 * ---------------------
 * Une précision utile — « ni le stock ni la caisse ne sont touchés » — n'a pas
 * sa place dans le libellé d'un bouton, et un `title` natif s'affiche après une
 * seconde, dans une bulle système qui ignore le thème et ne s'ouvre **pas** au
 * clavier. Ici :
 *
 *  - la bulle suit le thème (jetons DaisyUI, aucune couleur en dur) ;
 *  - elle s'ouvre **au survol** et **au focus clavier** (comportement daisyUI) ;
 *  - elle s'ouvre aussi **au clic**, ce qui la rend utilisable à la souris,
 *    au doigt et pour qui ne découvre pas le survol ;
 *  - le bouton porte un `aria-label` (« Aide : … ») et la bulle est reliée par
 *    `aria-describedby` : l'explication est lue par un lecteur d'écran.
 *
 * ⚠️ Ce composant a un état (ouvert/épinglé) : il vit dans son propre fichier
 * `'use client'`, et non dans `components/design-system.tsx` qui reste
 * volontairement **sans état** pour rester utilisable côté serveur.
 */

import { useId, useState, type ReactNode } from 'react';

interface HelpTooltipProps {
  /** Nom accessible du bouton, ex. « Aide : enregistrer comme brouillon ». */
  label: string;
  /** L'explication elle-même. */
  children: ReactNode;
  /** Côté d'affichage. Par défaut au-dessus (lisible dans une barre d'actions basse). */
  side?: 'top' | 'bottom' | 'start' | 'end';
}

export function HelpTooltip({ label, children, side = 'top' }: HelpTooltipProps) {
  const [pinned, setPinned] = useState(false);
  const id = useId();

  return (
    <div className={`tooltip tooltip-${side} align-middle ${pinned ? 'tooltip-open' : ''}`.trim()}>
      <div className="tooltip-content">
        <div id={id} className="max-w-xs text-left leading-snug">
          {children}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setPinned((current) => !current)}
        onBlur={() => setPinned(false)}
        aria-label={label}
        aria-describedby={id}
        aria-expanded={pinned}
        className="btn btn-ghost btn-xs btn-circle min-h-6 min-w-6 text-base-content/50 hover:text-base-content"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.5 9a2.5 2.5 0 115 0c0 1.5-1.5 2-2 3m-.5 3.5h.01M12 21a9 9 0 100-18 9 9 0 000 18z"
          />
        </svg>
      </button>
    </div>
  );
}
