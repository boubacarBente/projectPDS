'use client';

/**
 * Tableau des ventes (README §5.5 règle 2).
 *
 * Toute liste passe par `ResponsiveTable` : cartes empilées sous `sm`, tableau
 * au-dessus. La colonne **Reste** est la colonne clé du module : `MoneyText
 * colored` (rouge tant qu'il reste quelque chose à encaisser).
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
import type { SalesInvoiceRow } from '@/components/ventes/ventes-modals';

/** Une facture reste-t-elle encaissable ? (annulée ou soldée ⇒ non) */
export function canCollect(invoice: SalesInvoiceRow, canPay: boolean): boolean {
  return canPay && invoice.status !== 'cancelled' && invoice.remainingAmount > 0.001;
}

export function VentesTable({
  data,
  isLoading,
  canPay,
  canCancel,
  onOpenDetail,
  onOpenInvoice,
  onOpenPayment,
  onOpenCancel,
  emptyState,
}: {
  data: SalesInvoiceRow[];
  /** Le squelette est rendu par la page ; ce drapeau évite un état vide trompeur. */
  isLoading: boolean;
  canPay: boolean;
  canCancel: boolean;
  onOpenDetail: (invoice: SalesInvoiceRow) => void;
  /** Ouvre la page facture complète (`/ventes/[id]`) : impression et exports. */
  onOpenInvoice: (invoice: SalesInvoiceRow) => void;
  onOpenPayment: (invoice: SalesInvoiceRow) => void;
  onOpenCancel: (invoice: SalesInvoiceRow) => void;
  emptyState: ReactNode;
}) {
  if (!isLoading && data.length === 0) return <>{emptyState}</>;

  const columns = [
    {
      key: 'invoiceNumber',
      label: 'Numéro',
      primary: true,
      render: (invoice: SalesInvoiceRow) => (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="tabular truncate font-semibold">{invoice.invoiceNumber}</span>
          {invoice.status !== 'active' && (
            <StatusBadge status={invoice.status} kind="invoice" />
          )}
        </span>
      ),
    },
    {
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (invoice: SalesInvoiceRow) => (
        <span className="tabular text-base-content/70">{formatDateShort(invoice.date)}</span>
      ),
    },
    {
      key: 'customerName',
      label: 'Client',
      render: (invoice: SalesInvoiceRow) => (
        <span className="block min-w-0 truncate">
          {invoice.customerName?.trim() ? invoice.customerName : 'Client comptoir'}
        </span>
      ),
    },
    {
      key: 'total',
      label: 'Total',
      className: 'text-right whitespace-nowrap',
      render: (invoice: SalesInvoiceRow) => <MoneyText value={invoice.total} bold />,
    },
    {
      key: 'amountPaid',
      label: 'Payé',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (invoice: SalesInvoiceRow) => <MoneyText value={invoice.amountPaid} />,
    },
    {
      key: 'remainingAmount',
      label: 'Reste',
      className: 'text-right whitespace-nowrap',
      render: (invoice: SalesInvoiceRow) => (
        <MoneyText value={invoice.remainingAmount} colored bold />
      ),
    },
    {
      key: 'paymentStatus',
      label: 'Statut',
      className: 'whitespace-nowrap',
      render: (invoice: SalesInvoiceRow) => (
        <StatusBadge status={invoice.paymentStatus} kind="payment" />
      ),
    },
    {
      key: 'itemCount',
      label: 'Lignes',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (invoice: SalesInvoiceRow) => (
        <span className="tabular text-base-content/60">{formatNumber(invoice.itemCount)}</span>
      ),
    },
  ] satisfies Column<SalesInvoiceRow>[];

  return (
    <ResponsiveTable
      columns={columns}
      data={data}
      getRowKey={(invoice) => invoice.id}
      tableClassName="table-sm"
      actionsClassName="w-64"
      actions={(invoice) => (
        <div
          className="flex flex-wrap justify-end gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <ToolbarButton onClick={() => onOpenDetail(invoice)} title="Voir le détail de la facture">
            Détail
          </ToolbarButton>
          <ToolbarButton onClick={() => onOpenInvoice(invoice)} title="Ouvrir la facture (impression, exports)">
            Facture
          </ToolbarButton>
          {canCollect(invoice, canPay) && (
            <ToolbarButton
              variant="primary"
              onClick={() => onOpenPayment(invoice)}
              title="Enregistrer un paiement"
            >
              Paiement
            </ToolbarButton>
          )}
          {canCancel && invoice.status !== 'cancelled' && (
            <ToolbarButton
              variant="error"
              onClick={() => onOpenCancel(invoice)}
              title="Annuler la vente (avec motif)"
            >
              Annuler
            </ToolbarButton>
          )}
        </div>
      )}
    />
  );
}
