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
import { IconAction, RowActions } from '@/components/row-actions';
import { MoneyText, StatusBadge } from '@/components/design-system';
import { formatDateShort } from '@/lib/date-format';
import type { PurchaseInvoiceRow } from '@/components/achats/achats-modals';
import { StoreTag } from '@/components/store-scope';

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
  showStore = false,
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
  /** Plusieurs magasins affichés : le magasin apparaît sous la référence. */
  showStore?: boolean;
}) {
  if (!isLoading && data.length === 0) return <>{emptyState}</>;

  /*
   * Colonnes retirées à la demande du client, pour supprimer le défilement
   * horizontal à 1366 px (écran du poste) :
   *  - **« Réf. fournisseur »** et **« Lignes »** : ~170 px ;
   *  - **« Payé »** : déductible à la lecture (Total − Reste) ;
   *  - **« Échéance »** : elle reste dans le détail de l'achat et sur le bon
   *    d'achat, et « Comptant » se lit au reste dû.
   * Aucune information n'est perdue — mais ne pas les remettre sans mesurer :
   * c'est ce qui faisait apparaître la barre de défilement.
   */
  const columns = [
    {
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (invoice: PurchaseInvoiceRow) => (
        <span className="tabular text-base-content/70">{formatDateShort(invoice.date)}</span>
      ),
    },
    {
      key: 'reference',
      label: 'Référence',
      primary: true,
      /*
       * Largeur **plafonnée** : la référence se tronque (ellipse) plutôt que
       * d'élargir la colonne. Elle reste lisible en entier dans le détail de
       * l'achat, sur le bon d'achat et dans la vue carte (mobile).
       */
      className: 'w-28',
      render: (invoice: PurchaseInvoiceRow) => (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="tabular block truncate font-semibold">{invoice.reference}</span>
          {invoice.status !== 'active' && <StatusBadge status={invoice.status} kind="invoice" />}
          <StoreTag name={invoice.storeName} show={showStore} />
        </span>
      ),
    },
    {
      key: 'supplierName',
      label: 'Fournisseur',
      /*
       * Le nom **passe à la ligne** au lieu d'élargir la colonne : les
       * fournisseurs ont des raisons sociales longues (« Alucobond Afrique de
       * l'Ouest »), et c'est ce qui faisait déborder le tableau.
       */
      className: 'w-40 whitespace-normal',
      render: (invoice: PurchaseInvoiceRow) => (
        <span className="block min-w-0 break-words">{invoice.supplierName || '—'}</span>
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
      className: 'text-right whitespace-nowrap',
      // Montant réellement décaissé : aucune couleur, c'est un fait, pas un dû.
      render: (invoice: PurchaseInvoiceRow) => <MoneyText value={invoice.amountPaid} />,
    },
    {
      key: 'remainingAmount',
      label: 'Reste',
      className: 'text-right whitespace-nowrap',
      /*
       * **Rouge dès qu'il reste à payer, neutre sinon** (règle de `remaining`).
       * `colored` était faux ici : il peignait en **vert** un montant encore dû.
       * Un achat annulé reste neutre : son reste n'est pas payable.
       */
      render: (invoice: PurchaseInvoiceRow) => (
        <MoneyText
          value={invoice.remainingAmount}
          remaining={invoice.status === 'active'}
          bold
        />
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
  ] satisfies Column<PurchaseInvoiceRow>[];

  return (
    <ResponsiveTable
      columns={columns}
      data={data}
      getRowKey={(invoice) => invoice.id}
      tableClassName="table-sm"
      actionsClassName="w-52"
      actions={(invoice) => (
        <RowActions>
          <IconAction icon="view" label="Voir le détail de l'achat" onClick={() => onOpenDetail(invoice)} />
          <IconAction
            icon="document"
            label="Ouvrir le bon d'achat (impression, exports)"
            onClick={() => onOpenDocument(invoice)}
          />
          {canUpdate && invoice.status !== 'cancelled' && (
            <IconAction
              icon="edit"
              label="Modifier cet achat (stock ajusté par différence)"
              onClick={() => onOpenEdit(invoice)}
            />
          )}
          {canSettle(invoice, canPay) && (
            <IconAction
              icon="pay"
              tone="primary"
              label="Enregistrer un règlement fournisseur"
              onClick={() => onOpenPayment(invoice)}
            />
          )}
          {canCancel && invoice.status !== 'cancelled' && (
            <IconAction
              icon="cancel"
              tone="danger"
              label="Annuler l'achat (avec motif)"
              onClick={() => onOpenCancel(invoice)}
            />
          )}
        </RowActions>
      )}
    />
  );
}
