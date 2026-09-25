'use client';

/**
 * Champ de mot de passe avec **icône afficher / masquer**.
 *
 * Pourquoi ce composant existe
 * ----------------------------
 * L'icône « œil » n'existait que sur l'écran de connexion ; ailleurs, les mots
 * de passe étaient soit définitifs (`type="password"` sans contrôle), soit
 * révélés par une case à cocher **globale** qui affichait d'un coup les deux
 * champs du formulaire. Résultat : impossible de vérifier le seul champ
 * « Confirmation » sans dévoiler aussi le premier.
 *
 * Ici, **chaque champ a sa propre icône** : on affiche celui qu'on veut, quand
 * on veut. Le bouton est un vrai `<button type="button">` (il ne soumet donc
 * jamais le formulaire), il est atteignable au clavier et annoncé par un
 * `aria-label` qui décrit l'action à venir.
 *
 * ⚠️ Afficher un mot de passe est un choix **local et temporaire** : l'état
 * n'est jamais conservé après la fermeture du champ, et rien n'est enregistré.
 */

import { useState } from 'react';

interface PasswordInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Classes supplémentaires de l'`input` (`field-rounded`, `min-h-11`…). */
  className?: string;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  /** Annonce vocale du champ quand il n'a pas de `<label htmlFor>`. */
  ariaLabel?: string;
}

export function PasswordInput({
  id,
  value,
  onChange,
  className = '',
  placeholder,
  autoComplete = 'current-password',
  disabled = false,
  ariaLabel,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        // `pr-12` réserve la place de l'icône : le texte saisi ne passe jamais dessous.
        className={`input input-bordered w-full pr-12 ${className}`.trim()}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-label={ariaLabel}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        disabled={disabled}
        className="btn btn-ghost btn-sm btn-circle absolute right-1 top-1/2 -translate-y-1/2"
        aria-label={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
        aria-pressed={visible}
        title={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          {visible ? (
            /* Œil barré : le mot de passe est visible, l'action proposée est de le masquer. */
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
            />
          ) : (
            <>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}
