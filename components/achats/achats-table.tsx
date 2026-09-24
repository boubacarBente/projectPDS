'use client';

/**
 * Tableau des achats (README §5.5 règle 2).
 *
 * Toute liste passe par `ResponsiveTable` : cartes empilées sous `sm`, tableau
 * au-dessus. La colonne **Reste** est la colonne clé du module : c'est la
 * **dette fournisseur** (§15), rendue par `MoneyText colored`.
 *
 * Les actions sont conditionnées par les permissions : on masque ce que le rôle
 * n'a pas le droit de faire — mais le serveur reste seul juge (§9).
 */

import type { ReactNode } from 'react';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { ToolbarButton } from '@/components/data-toolbar';
import { MoneyText, StatusBadge } from '@/components/design-system';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';
import type { PurchaseInvoiceRow } from '@/components/achats/achats-modals';

/** Un achat reste-t-il réglable ? (annulé ou soldé ⇒ non) */
export function canSettle(invoice: PurchaseInvoiceRow, canPay: boolean): boolean {
  return canPay && invoice.status !== 'cancelled' && invoice.remainingAmount > 0.001;
}

export function AchatsTable({
  data,
  isLoading,
  canPay,
  canUpdate,
  canCancel,
  onOpenDetail,
  onOpenDocument,
  onOpenEdit,
  onOpenPayment,
  onOpenCancel,
  emptyState,
}: {
  data: PurchaseInvoiceRow[];
  /** Le squelette est rendu par la page ; ce drapeau évite un état vide trompeur. */
  isLoading: boolean;
  canPay: boolean;
  canUpdate: boolean;
  canCancel: boolean;
  onOpenDetail: (invoice: PurchaseInvoiceRow) => void;
  /** Ouvre le bon d'achat (`/achats/[id]`) : impression et exports. */
  onOpenDocument: (invoice: PurchaseInvoiceRow) => void;
  onOpenEdit: (invoice: PurchaseInvoiceRow) => void;
  onOpenPayment: (invoice: PurchaseInvoiceRow) => void;
  onOpenCancel: (invoice: PurchaseInvoiceRow) => void;
  emptyState: ReactNode;
}) {
  if (!isLoading && data.length === 0) return <>{emptyState}</>;

  const columns = [
    {
      key: 'reference',
      label: 'Référence',
      primary: true,
      render: (invoice: PurchaseInvoiceRow) => (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="tabular truncate font-semibold">{invoice.reference}</span>
          {invoice.status !== 'active' && <StatusBadge status={invoice.status} kind="invoice" />}
        </span>
      ),
    },
    {
      key: 'supplierName',
      label: 'Fournisseur',
      render: (invoice: PurchaseInvoiceRow) => (
        <span className="block min-w-0 truncate">{invoice.supplierName || '—'}</span>
      ),
    },
    {
      key: 'supplierReference',
      label: 'Réf. fournisseur',
      hideOnMobile: true,
      render: (invoice: PurchaseInvoiceRow) =>
        invoice.supplierReference ? (
          <span className="tabular break-all">{invoice.supplierReference}</span>
        ) : (
          <span className="text-base-content/40">—</span>
        ),
    },
    {
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (invoice: PurchaseInvoiceRow) => (
        <span className="tabular text-base-content/70">{formatDateShort(invoice.date)}</span>
      ),
    },
    {
      key: 'dueDate',
      label: 'Échéance',
      hideOnMobile: true,
      className: 'whitespace-nowrap',
      render: (invoice: PurchaseInvoiceRow) =>
        invoice.dueDate ? (
          <span className="tabular text-base-content/70">{formatDateShort(invoice.dueDate)}</span>
        ) : (
          <span className="text-base-content/40">Comptant</span>
        ),
    },
    {
      key: 'total',
      label: 'Total',
      className: 'text-right whitespace-nowrap',
      render: (invoice: PurchaseInvoiceRow) => <MoneyText value={invoice.total} bold />,
    },
    {
      key: 'amountPaid',
      label: 'Payé',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (invoice: PurchaseInvoiceRow) => <MoneyText value={invoice.amountPaid} />,
    },
    {
      key: 'remainingAmount',
      label: 'Reste',
      className: 'text-right whitespace-nowrap',
      render: (invoice: PurchaseInvoiceRow) => (
        <MoneyText value={invoice.remainingAmount} colored bold />
      ),
    },
    {
      key: 'paymentStatus',
      label: 'Statut',
      className: 'whitespace-nowrap',
      render: (invoice: PurchaseInvoiceRow) => (
        <StatusBadge status={invoice.paymentStatus} kind="payment" />
      ),
    },
    {
      key: 'itemCount',
      label: 'Lignes',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (invoice: PurchaseInvoiceRow) => (
        <span className="tabular text-base-content/60">{formatNumber(invoice.itemCount)}</span>
      ),
    },
  ] satisfies Column<PurchaseInvoiceRow>[];

  return (
    <ResponsiveTable
      columns={columns}
      data={data}
      getRowKey={(invoice) => invoice.id}
      tableClassName="table-sm"
      actionsClassName="w-72"
      actions={(invoice) => (
        <div className="flex flex-wrap justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <ToolbarButton onClick={() => onOpenDetail(invoice)} title="Voir le détail de l'achat">
            Détail
          </ToolbarButton>
          <ToolbarButton
            onClick={() => onOpenDocument(invoice)}
            title="Ouvrir le bon d'achat (impression, exports)"
          >
            Bon
          </ToolbarButton>
          {canUpdate && invoice.status !== 'cancelled' && (
            <ToolbarButton
              onClick={() => onOpenEdit(invoice)}
              title="Modifier cet achat (stock ajusté par différence)"
            >
              Modifier
            </ToolbarButton>
          )}
          {canSettle(invoice, canPay) && (
            <ToolbarButton
              variant="primary"
              onClick={() => onOpenPayment(invoice)}
              title="Enregistrer un règlement fournisseur"
            >
              Payer
            </ToolbarButton>
          )}
          {canCancel && invoice.status !== 'cancelled' && (
            <ToolbarButton
              variant="error"
              onClick={() => onOpenCancel(invoice)}
              title="Annuler l'achat (avec motif)"
            >
              Annuler
            </ToolbarButton>
          )}
        </div>
      )}
    />
  );
}
