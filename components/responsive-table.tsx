'use client';

import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  render: (item: T) => ReactNode;
  /** Hide this column in mobile card view */
  hideOnMobile?: boolean;
  /** Show at the top of the card, with emphasis */
  primary?: boolean;
  className?: string;
  /**
   * Colonne **secondaire** du tableau : affichée seulement à partir de cette
   * largeur d'écran (elle reste dans la carte mobile). Sur un portable de
   * 1366 px, le menu laisse ~1 000 px au contenu : une liste de 9 colonnes y
   * cachait ses dernières colonnes (actions comprises) — `verify:ui`.
   */
  minScreen?: 'lg' | 'xl' | '2xl';
}

/**
 * Classes **écrites en toutes lettres** (Tailwind ne génère que celles qu'il
 * lit dans le code : une classe construite `${bp}:table-cell` n'existerait pas).
 */
const MIN_SCREEN_CLASS: Record<NonNullable<Column<unknown>['minScreen']>, string> = {
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
  '2xl': 'hidden 2xl:table-cell',
};

/** Largeur à partir de laquelle le tableau remplace les cartes. */
export type CardsBelow = 'sm' | 'md' | 'lg' | 'xl';

const CARDS_CLASSES: Record<CardsBelow, { cards: string; table: string; grid: string }> = {
  sm: { cards: 'sm:hidden', table: 'hidden sm:block', grid: 'grid-cols-2' },
  md: { cards: 'md:hidden', table: 'hidden md:block', grid: 'grid-cols-2 sm:grid-cols-4' },
  lg: { cards: 'lg:hidden', table: 'hidden lg:block', grid: 'grid-cols-2 sm:grid-cols-4' },
  xl: { cards: 'xl:hidden', table: 'hidden xl:block', grid: 'grid-cols-2 sm:grid-cols-4' },
};

interface ResponsiveTableProps<T> {
  columns: Column<T>[];
  data: T[];
  /** Unique key for each row */
  getRowKey: (item: T) => string | number;
  /** Actions rendered at the bottom of each card / right of each row */
  actions?: (item: T) => ReactNode;
  /** Renders when data is empty */
  emptyMessage?: string;
  /** Called when a row is clicked */
  onRowClick?: (item: T) => void;
  /** Optional desktop table sizing and layout classes */
  tableClassName?: string;
  /** Keeps the desktop actions column at a predictable width */
  actionsClassName?: string;
  /**
   * Corps de carte mobile sur mesure, à la place de la grille « libellé / valeur ».
   * Le titre (colonne `primary`) et les actions restent rendus par la carte.
   *
   * Pourquoi : la grille générique empile une ligne par colonne. Pour une liste
   * riche (ventes : date, client, total, payé, reste, bénéfice, statut), la carte
   * faisait sept lignes aux alignements mêlés (textes à gauche, montants à
   * droite) ; un corps dédié regroupe les montants et divise la hauteur par deux.
   */
  renderCard?: (item: T) => ReactNode;
  /**
   * En dessous de cette largeur, la liste s'affiche en **cartes** (défaut `sm` :
   * téléphone). Les listes larges des filiales passent `xl` : sur tablette
   * (portrait ou paysage, menu ouvert), des cartes valent mieux qu'un tableau
   * qui défile ou cache ses colonnes.
   */
  cardsBelow?: CardsBelow;
}

function CardView<T>({
  columns,
  data,
  getRowKey,
  actions,
  emptyMessage,
  onRowClick,
  renderCard,
  cardsBelow = 'sm',
}: ResponsiveTableProps<T>) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-base-content/60">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
        </svg>
        <p className="text-sm">{emptyMessage || 'Aucune donnée.'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.map((item) => {
        const visibleCols = columns.filter((c) => !c.hideOnMobile);
        const primaryCol = visibleCols.find((c) => c.primary);

        return (
          <div
            key={getRowKey(item)}
            onClick={() => onRowClick?.(item)}
            className={`bg-base-100 border border-base-200 rounded-xl p-4 shadow-sm ${
              onRowClick ? 'cursor-pointer hover:border-primary/40 hover:shadow-md active:scale-[0.98] transition-all' : ''
            }`}
          >
            {/* Primary field as card title */}
            {primaryCol && (
              <div className="font-semibold text-base mb-2">{primaryCol.render(item)}</div>
            )}

            {/* Other fields as label-value grid (or the list's own card body) */}
            {renderCard ? (
              renderCard(item)
            ) : (
              <div className={`grid ${CARDS_CLASSES[cardsBelow].grid} gap-x-3 gap-y-1.5 text-sm`}>
                {visibleCols
                  .filter((c) => !c.primary)
                  .map((col) => (
                    <div key={col.key} className="contents">
                      <span className="text-base-content/50 text-xs">{col.label}</span>
                      <span className={col.className}>{col.render(item)}</span>
                    </div>
                  ))}
              </div>
            )}

            {/* Actions at bottom */}
            {actions && (
              <div className="flex justify-end gap-1 mt-3 pt-3 border-t border-base-200/60">
                {actions(item)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TableView<T>({
  columns,
  data,
  getRowKey,
  actions,
  onRowClick,
  tableClassName,
  actionsClassName,
}: ResponsiveTableProps<T>) {
  return (
    <table className={`table ${tableClassName || ''}`}>
      <thead>
        <tr className="bg-base-200">
          {columns.map((col) => (
            <th key={col.key} className={`font-semibold ${col.className || ''} ${col.minScreen ? MIN_SCREEN_CLASS[col.minScreen] : ''}`}>
              {col.label}
            </th>
          ))}
          {actions && <th className={`font-semibold text-right ${actionsClassName || ''}`}>Actions</th>}
        </tr>
      </thead>
      <tbody>
        {data.map((item) => (
          <tr
            key={getRowKey(item)}
            className={`hover:bg-base-200 ${onRowClick ? 'cursor-pointer' : ''}`}
            onClick={() => onRowClick?.(item)}
          >
            {columns.map((col) => (
              <td key={col.key} className={`${col.className || ''} ${col.minScreen ? MIN_SCREEN_CLASS[col.minScreen] : ''}`}>
                {col.render(item)}
              </td>
            ))}
            {actions && (
              <td className={actionsClassName}>
                <div className="flex justify-end gap-1">{actions(item)}</div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ResponsiveTable<T>(props: ResponsiveTableProps<T>) {
  if (props.data.length === 0 && !props.emptyMessage) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-base-content/60">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
        </svg>
        <p className="text-sm">{props.emptyMessage || 'Aucune donnée.'}</p>
      </div>
    );
  }

  return (
    <>
      {/* Mobile: Card view */}
      <div className={CARDS_CLASSES[props.cardsBelow ?? 'sm'].cards}>
        <CardView {...props} />
      </div>

      {/* Desktop: Table view */}
      <div className={CARDS_CLASSES[props.cardsBelow ?? 'sm'].table}>
        {/*
         * Le défilement horizontal appartient au **tableau**, pas à la page.
         *
         * Un tableau de 9 à 10 colonnes (stocks, achats…)
         * est plus large que l'écran : sans ce conteneur, il imposait sa largeur
         * à `main` et faisait déborder toute la page (barre horizontale en bas,
         * contenu coupé). Ici, seule la carte du tableau défile : le cadre, les
         * en-têtes de page et le menu restent en place.
         */}
        <div className="w-full overflow-x-auto">
          <TableView {...props} />
        </div>
      </div>
    </>
  );
}
