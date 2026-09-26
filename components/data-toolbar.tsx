'use client';

import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SearchBar } from '@/components/search-filter';

/**
 * Barre d'outils unique d'une liste : recherche + filtres + période + export
 * sur une seule ligne (README §5.3).
 *
 * Contrat responsive (§5.5 règle 6) : `flex-wrap` systématique, et sur mobile
 * les filtres secondaires se replient derrière un bouton « Filtres (2) ».
 */
export function DataToolbar({
  search,
  onSearchChange,
  searchPlaceholder = 'Rechercher…',
  /** Filtres principaux, toujours visibles. */
  filters,
  /** Filtres secondaires, repliés sous `sm`. */
  secondaryFilters,
  /** Compteur affiché sur le bouton replié. */
  secondaryCount,
  actions,
  className = '',
}: {
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  filters?: ReactNode;
  secondaryFilters?: ReactNode;
  secondaryCount?: number;
  actions?: ReactNode;
  className?: string;
}) {
  const [showSecondary, setShowSecondary] = useState(false);

  return (
    <div className={`space-y-3 ${className}`.trim()}>
      <div className="flex flex-wrap items-center gap-2">
        {onSearchChange && (
          <div className="min-w-[12rem] flex-1">
            <SearchBar
              value={search ?? ''}
              onChange={onSearchChange}
              onClear={() => onSearchChange('')}
              placeholder={searchPlaceholder}
            />
          </div>
        )}

        {filters}

        {secondaryFilters && (
          <button
            type="button"
            onClick={() => setShowSecondary((v) => !v)}
            className={`btn btn-sm sm:hidden ${showSecondary ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
            aria-expanded={showSecondary}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
              />
            </svg>
            Filtres
            {typeof secondaryCount === 'number' && secondaryCount > 0 && ` (${secondaryCount})`}
          </button>
        )}

        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      {secondaryFilters && (
        <>
          <div className="hidden flex-wrap items-end gap-3 sm:flex">{secondaryFilters}</div>
          <AnimatePresence initial={false}>
            {showSecondary && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="overflow-hidden sm:hidden"
              >
                <div className="flex flex-col gap-3 pt-1">{secondaryFilters}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

/**
 * Bouton d'action d'en-tête, cible tactile ≥ 44 px sur mobile (§5.5 règle 3).
 *
 * `...rest` est **transmis au bouton** : c'est ainsi que `Tooltip` lui pose ses
 * gestionnaires de survol et son `aria-describedby` quand un écran l'enveloppe.
 * Sans cette transmission, les accessoires étaient silencieusement perdus et les
 * infobulles ne s'affichaient pas sur les barres d'outils.
 */
export function ToolbarButton({
  onClick,
  children,
  variant = 'ghost',
  disabled,
  title,
  type = 'button',
  ...rest
}: {
  onClick?: () => void;
  children: ReactNode;
  variant?: 'ghost' | 'primary' | 'error' | 'outline';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
} & Omit<React.ComponentProps<'button'>, 'onClick' | 'children' | 'type' | 'disabled' | 'title'>) {
  const variants: Record<string, string> = {
    ghost: 'btn-ghost border border-base-300',
    primary: 'btn-primary',
    error: 'btn-error',
    outline: 'btn-outline',
  };
  return (
    <button
      {...rest}
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`btn btn-sm min-h-11 sm:min-h-0 ${variants[variant]}`}
    >
      {children}
    </button>
  );
}
