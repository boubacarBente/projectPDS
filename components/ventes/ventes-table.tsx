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
import { IconAction, RowActions } from '@/components/row-actions';
import { MoneyText, StatusBadge } from '@/components/design-system';
import { formatDateShort } from '@/lib/date-format';
import type { SalesInvoiceRow } from '@/components/ventes/ventes-modals';

/** Une facture reste-t-elle encaissable ? (brouillon, annulée ou soldée ⇒ non) */
export function canCollect(invoice: SalesInvoiceRow, canPay: boolean): boolean {
  return canPay && invoice.status === 'active' && invoice.remainingAmount > 0.001;
}

export function VentesTable({
  data,
  isLoading,
  canPay,
  canCancel,
  canValidate,
  onOpenDetail,
  onOpenInvoice,
  onOpenPayment,
  onOpenCancel,
  onOpenValidate,
  emptyState,
}: {
  data: SalesInvoiceRow[];
  /** Le squelette est rendu par la page ; ce drapeau évite un état vide trompeur. */
  isLoading: boolean;
  canPay: boolean;
  canCancel: boolean;
  /** `sales.update` : détenu par les rôles qui peuvent rendre un brouillon définitif. */
  canValidate: boolean;
  onOpenDetail: (invoice: SalesInvoiceRow) => void;
  /** Ouvre la page facture complète (`/ventes/[id]`) : impression et exports. */
  onOpenInvoice: (invoice: SalesInvoiceRow) => void;
  onOpenPayment: (invoice: SalesInvoiceRow) => void;
  onOpenCancel: (invoice: SalesInvoiceRow) => void;
  onOpenValidate: (invoice: SalesInvoiceRow) => void;
  emptyState: ReactNode;
}) {
  if (!isLoading && data.length === 0) return <>{emptyState}</>;

  const columns = [
    {
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (invoice: SalesInvoiceRow) => (
        <span className="tabular text-base-content/70">{formatDateShort(invoice.date)}</span>
      ),
    },
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
  ] satisfies Column<SalesInvoiceRow>[];

  return (
    <ResponsiveTable
      columns={columns}
      data={data}
      getRowKey={(invoice) => invoice.id}
      tableClassName="table-sm"
      actionsClassName="w-44"
      actions={(invoice) => (
        <RowActions>
          <IconAction icon="view" label="Voir le détail de la facture" onClick={() => onOpenDetail(invoice)} />
          <IconAction
            icon="receipt"
            label="Ouvrir la facture (impression, exports)"
            onClick={() => onOpenInvoice(invoice)}
          />
          {canCollect(invoice, canPay) && (
            <IconAction
              icon="pay"
              tone="primary"
              label="Enregistrer un paiement"
              onClick={() => onOpenPayment(invoice)}
            />
          )}
          {canValidate && invoice.status === 'draft' && (
            <IconAction
              icon="activate"
              tone="success"
              label="Valider le brouillon (sortie de stock définitive)"
              onClick={() => onOpenValidate(invoice)}
            />
          )}
          {canCancel && invoice.status !== 'cancelled' && (
            <IconAction
              icon="cancel"
              tone="danger"
              label="Annuler la vente (avec motif)"
              onClick={() => onOpenCancel(invoice)}
            />
          )}
        </RowActions>
      )}
    />
  );
}
