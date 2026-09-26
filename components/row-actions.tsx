'use client';

/**
 * Actions de ligne en **icône** (README §5.5 règle 2).
 *
 * Pourquoi ce composant existe
 * ----------------------------
 * Les colonnes « Actions » des listes alignaient des boutons **en texte**
 * (Détail · Modifier · Payer · Désactiver) : quatre à cinq boutons larges par
 * ligne, qui se repliaient sur deux lignes, mangeaient la moitié de la largeur
 * du tableau et noyaient les chiffres — la colonne la plus visible pour la
 * moins utile.
 *
 * Règles appliquées
 * -----------------
 *  - **L'icône seule ne suffit jamais** : chaque bouton porte `title` (info-bulle
 *    à la souris), `aria-label` (lecteur d'écran) et un `sr-only` avec le
 *    libellé complet. Sans cela, une icône est un devinette pour l'utilisateur
 *    et un `button` sans nom pour l'accessibilité.
 *  - **Cible tactile ≥ 44 px sur mobile** (`min-h-11 min-w-11`), 32 px sur
 *    desktop : c'est le contrat §5.5 règle 3.
 *  - **Couleur = sens** : `danger` pour ce qui retire un droit ou annule
 *    (jamais la couleur seule — le libellé est toujours là), `primary` pour
 *    l'action attendue (payer), `success` pour une réactivation.
 *  - L'icône vient d'un jeu **fermé** (`ActionIcon`) : deux écrans qui font la
 *    même chose montrent la même icône.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Tooltip } from '@/components/tooltip';

export type ActionIcon =
  | 'view'
  | 'edit'
  | 'pay'
  | 'deactivate'
  | 'activate'
  | 'cancel'
  | 'document'
  | 'receipt'
  | 'adjust'
  | 'history'
  | 'key'
  | 'shield'
  | 'advance'
  | 'broken'
  | 'list'
  | 'workers';

/** Tracés 24×24, `stroke` hérité de la couleur du bouton (aucune couleur en dur). */
const PATHS: Record<ActionIcon, ReactNode> = {
  view: (
    <>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
      />
    </>
  ),
  edit: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
    />
  ),
  pay: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path strokeLinecap="round" d="M6 9.5v5M18 9.5v5" />
    </>
  ),
  deactivate: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path strokeLinecap="round" d="M7.5 7.5l9 9" />
    </>
  ),
  activate: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ),
  cancel: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path strokeLinecap="round" d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  document: (
    <>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"
      />
      <path strokeLinecap="round" d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  receipt: (
    <>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"
      />
      <path strokeLinecap="round" d="M9.5 8h5M9.5 12h5" />
    </>
  ),
  adjust: (
    <>
      <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  history: (
    <>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 12a8.5 8.5 0 108.5-8.5A8.5 8.5 0 005 6" />
      <path strokeLinecap="round" d="M3.5 3.5V7H7" />
      <path strokeLinecap="round" d="M12 8v4.5l3 2" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="14" r="4" />
      <path strokeLinecap="round" d="M11 11l8-8M17 5l2 2M15 7l2 2" />
    </>
  ),
  shield: (
    <>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
    </>
  ),
  advance: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 8l4 4-4 4M13.5 8v8" />
    </>
  ),
  broken: (
    <>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 4l8.5 15h-17L12 4z"
      />
      <path strokeLinecap="round" d="M12 10v4M12 16.5v.5" />
    </>
  ),
  list: (
    <>
      <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h10" />
      <circle cx="19" cy="18" r="1.4" />
    </>
  ),
  workers: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 19.5c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8" />
      <path strokeLinecap="round" d="M16 5.5a3 3 0 010 5.6M18.5 19.5c0-2.2-.6-3.8-1.7-4.8" />
    </>
  ),
};

const TONES = {
  neutral: '',
  primary: 'text-primary',
  danger: 'text-error',
  success: 'text-success',
} as const;

interface IconActionProps {
  icon: ActionIcon;
  /** Libellé complet, obligatoire : il devient info-bulle ET nom accessible. */
  label: string;
  onClick?: () => void;
  /** Rend un lien (navigation) au lieu d'un bouton. */
  href?: string;
  tone?: keyof typeof TONES;
  disabled?: boolean;
}

export function IconAction({
  icon,
  label,
  onClick,
  href,
  tone = 'neutral',
  disabled = false,
}: IconActionProps) {
  const className = `btn btn-ghost btn-sm btn-circle min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 ${TONES[tone]}`.trim();

  const content = (
    <>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden
      >
        {PATHS[icon]}
      </svg>
      <span className="sr-only">{label}</span>
    </>
  );

  if (href && !disabled) {
    return (
      <Tooltip label={label} ariaDescribedBy={false}>
        <Link href={href} className={className} aria-label={label}>
          {content}
        </Link>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={label} ariaDescribedBy={false}>
      <button type="button" onClick={onClick} disabled={disabled} className={className} aria-label={label}>
        {content}
      </button>
    </Tooltip>
  );
}

/** Conteneur des actions d'une ligne : alignées à droite, sans repli disgracieux. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-nowrap items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
      {children}
    </div>
  );
}
