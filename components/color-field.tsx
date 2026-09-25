'use client';

/**
 * Choix d'une couleur : nuancier natif + champ hexadécimal **éditable**.
 *
 * Pourquoi ce composant existe
 * ----------------------------
 * L'écran Paramètres répétait deux fois le même couple de champs, avec deux
 * défauts :
 *
 * 1. Le champ hexadécimal de la barre latérale n'avait **pas** de `onChange`.
 *    React avertit alors dans la console — « You provided a `value` prop to a
 *    form field without an `onChange` handler » — et rend le champ *read-only*
 *    pour de bon : il était donc impossible de saisir un code couleur à la
 *    main, seul le nuancier fonctionnait.
 * 2. Dans l'autre champ, la saisie ne mettait à jour que les variables CSS,
 *    pas l'état React : la valeur tapée pouvait être réécrite par n'importe
 *    quel ré-affichage (par exemple l'enregistrement optimiste déclenché par
 *    le nuancier).
 *
 * D'où la règle appliquée ici : **tant qu'on tape, la valeur vit dans un
 * brouillon local** (`draft`), l'aperçu suit la frappe, et l'enregistrement
 * n'a lieu qu'à la fin — au blur ou sur `Entrée` — quand le code est complet.
 * Un code incomplet est simplement abandonné : on revient à la valeur
 * enregistrée, jamais à un état bâtard.
 */

import { useEffect, useState } from 'react';

interface ColorFieldProps {
  /** Couleur enregistrée (`#rrggbb`) — la référence affichée hors saisie. */
  value: string;
  disabled?: boolean;
  /** Aperçu immédiat (variables CSS), sans écriture en base. */
  onPreview: (hex: string) => void;
  /** Enregistre la couleur. `silent` évite une notification par frappe du nuancier. */
  onSave: (hex: string, options?: { silent?: boolean }) => void;
}

/** Un code hexadécimal partiel reste acceptable pendant la frappe. */
const PARTIAL_HEX = /^#[0-9a-fA-F]{0,6}$/;
const COMPLETE_HEX = /^#[0-9a-fA-F]{6}$/;

export function ColorField({ value, disabled = false, onPreview, onSave }: ColorFieldProps) {
  /** `null` = aucune saisie en cours, on affiche la couleur enregistrée. */
  const [draft, setDraft] = useState<string | null>(null);

  /*
   * Si la couleur change ailleurs (bouton « Rétablir les couleurs par défaut »,
   * réponse du serveur), le brouillon ne doit pas masquer la nouvelle valeur.
   */
  useEffect(() => {
    setDraft(null);
  }, [value]);

  const shown = draft ?? value;

  const handleHexChange = (raw: string) => {
    if (!PARTIAL_HEX.test(raw)) return; // on ignore les caractères parasites
    setDraft(raw);
    onPreview(raw);
  };

  const commitTyped = () => {
    const candidate = draft;
    setDraft(null);

    if (candidate && COMPLETE_HEX.test(candidate)) {
      onSave(candidate);
      return;
    }
    if (candidate) {
      // Saisie incomplète : on annule l'aperçu au lieu de laisser une couleur
      // fantôme à l'écran.
      onPreview(value);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <input
        type="color"
        className="h-11 w-14 cursor-pointer rounded-lg border border-base-300 bg-base-100"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const hex = event.target.value;
          onPreview(hex);
          onSave(hex, { silent: true });
        }}
      />
      <input
        className="input input-bordered field-rounded w-full font-mono text-sm"
        value={shown}
        disabled={disabled}
        onChange={(event) => handleHexChange(event.target.value)}
        onBlur={commitTyped}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitTyped();
          }
        }}
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        aria-label="Code couleur hexadécimal"
      />
    </div>
  );
}
