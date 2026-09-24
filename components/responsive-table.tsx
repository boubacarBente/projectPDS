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
}

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
}

function CardView<T>({
  columns,
  data,
  getRowKey,
  actions,
  emptyMessage,
  onRowClick,
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

            {/* Other fields as label-value grid */}
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
              {visibleCols
                .filter((c) => !c.primary)
                .map((col) => (
                  <div key={col.key} className="contents">
                    <span className="text-base-content/50 text-xs">{col.label}</span>
                    <span className={col.className}>{col.render(item)}</span>
                  </div>
                ))}
            </div>

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
            <th key={col.key} className={`font-semibold ${col.className || ''}`}>
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
              <td key={col.key} className={col.className}>
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
      <div className="sm:hidden">
        <CardView {...props} />
      </div>

      {/* Desktop: Table view */}
      <div className="hidden sm:block">
        <TableView {...props} />
      </div>
    </>
  );
}
