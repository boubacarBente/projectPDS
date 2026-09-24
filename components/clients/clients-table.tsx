'use client';

/**
 * Tableau des clients (README §5.5 règle 2).
 *
 * Toute liste passe par `ResponsiveTable` : cartes empilées sous `sm`, tableau
 * au-dessus. Les colonnes techniques (téléphone vide, dernier achat) sont
 * masquées sur mobile via `hideOnMobile`.
 *
 * Le solde est la colonne clé : `MoneyText colored` (rouge = dû) plus une puce
 * « Plafond dépassé » lorsque `balance > creditLimit` — on avertit, on ne
 * bloque pas (README Q18).
 */

import type { ReactNode } from 'react';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { ToolbarButton } from '@/components/data-toolbar';
import { Badge, MoneyText } from '@/components/design-system';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';
import type { CustomerRecord } from '@/components/clients/clients-modals';

export function customerExceedsCreditLimit(customer: CustomerRecord): boolean {
  return customer.creditLimit > 0 && customer.balance > customer.creditLimit;
}

function CustomerNameCell({ customer }: { customer: CustomerRecord }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="truncate font-semibold">{customer.name}</span>
      {!customer.isActive && <Badge tone="neutral">Inactif</Badge>}
      {customerExceedsCreditLimit(customer) && <Badge tone="warning">Plafond dépassé</Badge>}
    </span>
  );
}

export function ClientsTable({
  data,
  onOpenDetail,
  onOpenForm,
  onOpenPayment,
  onOpenDeactivate,
  canUpdate,
  canDelete,
  canPay,
  isLoading,
  emptyState,
}: {
  data: CustomerRecord[];
  onOpenDetail: (customer: CustomerRecord) => void;
  onOpenForm: (customer: CustomerRecord) => void;
  onOpenPayment: (customer: CustomerRecord) => void;
  onOpenDeactivate: (customer: CustomerRecord) => void;
  canUpdate: boolean;
  canDelete: boolean;
  canPay: boolean;
  /** Le squelette est rendu par la page ; ce drapeau évite un état vide trompeur. */
  isLoading: boolean;
  emptyState: ReactNode;
}) {
  if (!isLoading && data.length === 0) return <>{emptyState}</>;

  const columns = [
    {
      key: 'name',
      label: 'Nom',
      primary: true,
      render: (customer: CustomerRecord) => <CustomerNameCell customer={customer} />,
    },
    {
      key: 'phone',
      label: 'Téléphone',
      hideOnMobile: true,
      render: (customer: CustomerRecord) =>
        customer.phone ? (
          <span className="tabular whitespace-nowrap">{customer.phone}</span>
        ) : (
          <span className="text-base-content/40">—</span>
        ),
    },
    {
      key: 'invoiceCount',
      label: 'Ventes',
      className: 'text-right',
      render: (customer: CustomerRecord) => (
        <span className="tabular">{formatNumber(customer.invoiceCount)}</span>
      ),
    },
    {
      key: 'totalInvoiced',
      label: 'Total acheté',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (customer: CustomerRecord) => <MoneyText value={customer.totalInvoiced} />,
    },
    {
      key: 'totalPaid',
      label: 'Payé',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (customer: CustomerRecord) => <MoneyText value={customer.totalPaid} />,
    },
    {
      key: 'balance',
      label: 'Solde',
      className: 'text-right whitespace-nowrap',
      render: (customer: CustomerRecord) => <MoneyText value={customer.balance} colored bold />,
    },
    {
      key: 'lastPurchaseDate',
      label: 'Dernier achat',
      hideOnMobile: true,
      className: 'whitespace-nowrap',
      render: (customer: CustomerRecord) => (
        <span className="tabular text-base-content/70">
          {formatDateShort(customer.lastPurchaseDate)}
        </span>
      ),
    },
  ] satisfies Column<CustomerRecord>[];

  return (
    <ResponsiveTable
      columns={columns}
      data={data}
      getRowKey={(customer) => customer.id}
      tableClassName="table-sm"
      actionsClassName="w-56"
      actions={(customer) => (
        <div
          className="flex flex-wrap justify-end gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <ToolbarButton onClick={() => onOpenDetail(customer)} title="Voir le détail du client">
            Détail
          </ToolbarButton>
          {canUpdate && (
            <ToolbarButton onClick={() => onOpenForm(customer)} title="Modifier le client">
              Modifier
            </ToolbarButton>
          )}
          {canPay && customer.balance > 0.001 && (
            <ToolbarButton
              variant="primary"
              onClick={() => onOpenPayment(customer)}
              title="Enregistrer un paiement"
            >
              Paiement
            </ToolbarButton>
          )}
          {canDelete && customer.isActive && (
            <ToolbarButton
              variant="error"
              onClick={() => onOpenDeactivate(customer)}
              title="Désactiver le client"
            >
              Désactiver
            </ToolbarButton>
          )}
        </div>
      )}
    />
  );
}
