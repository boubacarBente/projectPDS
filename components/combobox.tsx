'use client';

/**
 * Champ de saisie avec **suggestions** (combobox).
 *
 * Pourquoi ce composant existe
 * ----------------------------
 * Choisir un produit ou un client dans un `<select>` natif oblige à parcourir
 * une liste déroulante : sur un catalogue de plusieurs dizaines de lignes, on
 * cherche à l'œil. Ici on **tape** — le nom, un morceau de nom, sans se soucier
 * des accents — et la liste se réduit à ce qui correspond.
 *
 * Contraintes prises en compte
 * ----------------------------
 *  - **Le menu est rendu dans un portail** (`createPortal` sur `document.body`),
 *    positionné en `fixed` d'après la position réelle du champ. Sans cela, il
 *    serait **coupé** par le premier ancêtre qui défile : les lignes de vente
 *    vivent dans un conteneur `overflow-x-auto` (le tableau de saisie), et un
 *    menu en `absolute` y serait rogné.
 *  - **Recherche insensible aux accents et à la casse** : « sable de riviere »
 *    trouve « Sable de rivière ». Taper sans accent est le cas courant.
 *  - **Clavier complet** : ↓ / ↑ pour parcourir, `Entrée` pour choisir,
 *    `Échap` pour fermer sans rien changer, `Tab` pour sortir. La sélection
 *    courante est annoncée (`aria-activedescendant`).
 *  - **Jamais de texte libre conservé par erreur** : si la saisie ne correspond
 *    à aucune option, on revient au libellé de la valeur sélectionnée.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type ComboboxOption = {
  /** Identifiant technique (`''` = l'option « vide » : aucun choix). */
  value: string;
  /** Texte affiché et recherché. */
  label: string;
  /** Précision affichée à droite (prix, téléphone, stock…). */
  hint?: string;
};

interface ComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  /** Libellé de l'option vide, toujours proposée en tête de liste. */
  emptyLabel?: string;
  disabled?: boolean;
  /** Nom accessible quand le champ n'a pas de `<label htmlFor>`. */
  ariaLabel?: string;
  className?: string;
  /**
   * Afficher le libellé de l'option vide **dans le champ** quand rien n'est
   * choisi. Vrai pour un choix qui a du sens (« Vente comptoir ») ; faux quand
   * le champ vide doit rester vide, avec son texte d'invite (ligne de vente).
   */
  showEmptyLabel?: boolean;
  /** Au-delà, la liste est tronquée (le compteur le signale). */
  maxResults?: number;
}

/** Minuscules sans accent : « Rivière » et « riviere » se rencontrent. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  emptyLabel,
  disabled = false,
  ariaLabel,
  className = '',
  showEmptyLabel = false,
  maxResults = 50,
}: ComboboxProps) {
  const generatedId = useId();
  const inputId = id ?? `combobox-${generatedId}`;
  const listId = `${inputId}-list`;

  const allOptions = useMemo<ComboboxOption[]>(
    () => (emptyLabel !== undefined ? [{ value: '', label: emptyLabel }, ...options] : options),
    [emptyLabel, options],
  );

  const selected = useMemo(
    () => allOptions.find((option) => option.value === value) ?? null,
    [allOptions, value],
  );

  /*
   * Texte affiché hors saisie : le libellé choisi. Pour l'option vide, il n'est
   * affiché que si l'appelant le demande — une ligne de vente sans produit doit
   * laisser voir son texte d'invite, pas « Sélectionner un produit… ».
   */
  const selectedLabel = selected && (selected.value !== '' || showEmptyLabel) ? selected.label : '';

  /** Texte affiché : le libellé choisi, tant que l'utilisateur ne tape pas. */
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typingRef = useRef(false);

  /* Le libellé suit la valeur choisie (sélection externe, réinitialisation…). */
  useEffect(() => {
    if (typingRef.current) return;
    setQuery(selectedLabel);
  }, [selectedLabel]);

  const filtered = useMemo(() => {
    const term = normalize(query);
    if (!term || term === normalize(selectedLabel)) return allOptions;
    return allOptions.filter(
      (option) =>
        normalize(option.label).includes(term) || (option.hint ? normalize(option.hint).includes(term) : false),
    );
  }, [allOptions, query, selectedLabel]);

  const visible = filtered.slice(0, maxResults);
  const truncated = filtered.length - visible.length;

  /** Position du menu, d'après la place réellement occupée par le champ. */
  const place = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const box = input.getBoundingClientRect();
    const estimated = Math.min(288, 44 * Math.max(1, visible.length) + 8);
    const below = window.innerHeight - box.bottom;
    setRect({
      top: box.bottom + 4,
      left: box.left,
      width: box.width,
      up: below < estimated && box.top > below,
    });
  }, [visible.length]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScrollOrResize = () => place();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, place]);

  /* Fermeture au clic extérieur. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (inputRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
      typingRef.current = false;
      setQuery(selectedLabel);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, selected]);

  /* L'option active reste visible dans la liste. */
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const commit = (option: ComboboxOption) => {
    typingRef.current = false;
    setQuery(option.label);
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => {
        const next = current + step;
        if (next < 0) return visible.length - 1;
        if (next >= visible.length) return 0;
        return next;
      });
      return;
    }

    if (event.key === 'Enter') {
      if (open && visible[activeIndex]) {
        // On empêche la soumission du formulaire quand on choisit une suggestion.
        event.preventDefault();
        commit(visible[activeIndex]);
      }
      return;
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      typingRef.current = false;
      setQuery(selectedLabel);
      return;
    }

    if (event.key === 'Tab') {
      setOpen(false);
      typingRef.current = false;
      setQuery(selectedLabel);
    }
  };

  const list = open && rect && !disabled && (
    <ul
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={ariaLabel ?? 'Suggestions'}
      style={{
        position: 'fixed',
        top: rect.up ? undefined : rect.top,
        bottom: rect.up ? window.innerHeight - rect.top + 8 : undefined,
        left: rect.left,
        width: Math.max(rect.width, 260),
        zIndex: 80,
      }}
      className="max-h-72 overflow-y-auto rounded-xl border border-base-300 bg-base-100 py-1 shadow-2xl"
    >
      {visible.length === 0 && (
        <li className="px-3 py-2 text-sm text-base-content/50">Aucun résultat</li>
      )}
      {visible.map((option, index) => (
        <li
          key={option.value || '__empty__'}
          data-index={index}
          id={`${listId}-${index}`}
          role="option"
          aria-selected={option.value === value}
          onMouseEnter={() => setActiveIndex(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            commit(option);
          }}
          className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-sm ${
            index === activeIndex ? 'bg-base-200' : ''
          } ${option.value === value ? 'font-medium text-primary' : ''}`}
        >
          <span className="min-w-0 truncate">{option.label}</span>
          {option.hint && (
            <span className="tabular shrink-0 text-xs text-base-content/50">{option.hint}</span>
          )}
        </li>
      ))}
      {truncated > 0 && (
        <li className="px-3 py-1 text-xs text-base-content/50">
          … {truncated} autre{truncated > 1 ? 's' : ''} résultat{truncated > 1 ? 's' : ''} — précisez la recherche
        </li>
      )}
    </ul>
  );

  return (
    <>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && visible[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        className={`input input-bordered w-full ${className}`.trim()}
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          typingRef.current = true;
          setQuery(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onFocus={() => {
          if (!disabled) setOpen(true);
        }}
        onBlur={() => {
          /*
           * Fermeture immédiate : cliquer une suggestion ne fait **pas** perdre
           * le focus (son `onMouseDown` est annulé), donc `onBlur` ne se
           * déclenche que si l'on quitte vraiment le champ — et là, un texte
           * libre qui ne correspond à rien doit être abandonné au profit du
           * libellé réellement sélectionné.
           */
          setOpen(false);
          typingRef.current = false;
          setQuery(selectedLabel);
        }}
        onKeyDown={handleKeyDown}
      />
      {list && typeof document !== 'undefined' ? createPortal(list, document.body) : null}
    </>
  );
}
