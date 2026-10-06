'use client';

/**
 * Tableau des ventes (README §5.5 règle 2).
 *
 * Toute liste passe par `ResponsiveTable` : cartes empilées sous `sm`, tableau
 * au-dessus. La colonne **Reste** est la colonne clé du module : `MoneyText
 * remaining` (rouge tant qu'il reste quelque chose à encaisser, neutre sinon).
 *
 * Sur téléphone, la carte a un corps dédié (`renderCard`) : n° de facture en
 * titre, client et date, puis les quatre montants regroupés en grille 2 × 2.
 * La grille générique empilait sept lignes par vente aux alignements mêlés.
 *
 * La colonne **Bénéfice** n'apparaît que pour un utilisateur qui détient
 * `balances.view` — et le serveur ne lui envoie `cost`/`profit` que dans ce cas
 * (`canViewSalesProfit`) : masquer n'est pas protéger (§9).
 *
 * Les actions sont conditionnées par les permissions : on masque ce que le rôle
 * n'a pas le droit de faire — mais le serveur reste seul juge (§9).
 */

import type { ReactNode } from 'react';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { IconAction, RowActions } from '@/components/row-actions';
import { Tooltip } from '@/components/tooltip';
import { MoneyText, StatusBadge } from '@/components/design-system';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency } from '@/lib/format';
import type { SalesInvoiceRow } from '@/components/ventes/ventes-modals';
import { StoreTag } from '@/components/store-scope';

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
  canViewProfit,
  onOpenDetail,
  onOpenInvoice,
  onOpenPayment,
  onOpenCancel,
  onOpenValidate,
  emptyState,
  showStore = false,
}: {
  data: SalesInvoiceRow[];
  /** Le squelette est rendu par la page ; ce drapeau évite un état vide trompeur. */
  isLoading: boolean;
  canPay: boolean;
  canCancel: boolean;
  /** `sales.update` : détenu par les rôles qui peuvent rendre un brouillon définitif. */
  canValidate: boolean;
  /** `balances.view` : seul ce rôle reçoit (et voit) le bénéfice d'une vente. */
  canViewProfit: boolean;
  onOpenDetail: (invoice: SalesInvoiceRow) => void;
  /** Ouvre la page facture complète (`/ventes/[id]`) : impression et exports. */
  onOpenInvoice: (invoice: SalesInvoiceRow) => void;
  onOpenPayment: (invoice: SalesInvoiceRow) => void;
  onOpenCancel: (invoice: SalesInvoiceRow) => void;
  onOpenValidate: (invoice: SalesInvoiceRow) => void;
  emptyState: ReactNode;
  /** Plusieurs magasins affichés : le nom du magasin apparaît sous le n° de facture. */
  showStore?: boolean;
}) {
  if (!isLoading && data.length === 0) return <>{emptyState}</>;

  const columns = [
    {
      key: 'date',
      label: 'Date',
      // Jour de la semaine au-dessus de la date : la colonne la plus étroite
      // possible, pour que le tableau tienne en 1366 px avec les n° longs du siège.
      render: (invoice: SalesInvoiceRow) => {
        const [day, date] = formatDateShort(invoice.date).split(' ');
        return (
          <span className="block tabular text-base-content/70">
            <span className="block text-xs text-base-content/50">{day}</span>
            {date ?? day}
          </span>
        );
      },
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
          <StoreTag name={invoice.storeName} show={showStore} />
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
      // Le payé passe sous le total : une colonne de moins, le tableau tient en 1366 px.
      render: (invoice: SalesInvoiceRow) => (
        <span className="block">
          <MoneyText value={invoice.total} bold />
          <span className="block text-xs text-base-content/55">
            payé <MoneyText value={invoice.amountPaid} />
          </span>
        </span>
      ),
    },
    {
      key: 'remainingAmount',
      label: 'Reste',
      className: 'text-right whitespace-nowrap',
      /*
       * **Rouge dès qu'il reste à encaisser, neutre sinon** (règle de
       * `remaining`). `colored` était faux : un reste dû est un montant positif,
       * il apparaissait donc **vert**. Brouillon ou vente annulée : neutre, leur
       * reste n'est pas encaissable.
       */
      render: (invoice: SalesInvoiceRow) => (
        <MoneyText value={invoice.remainingAmount} remaining={invoice.status === 'active'} bold />
      ),
    },
    /*
     * Bénéfice — colonne réservée à `balances.view` (le serveur ne renvoie
     * `profit` que dans ce cas, donc `null` ici veut dire « pas le droit »).
     * `MoneyText colored` est le bon code couleur pour un résultat : vert si la
     * vente rapporte, **rouge si elle est vendue à perte**.
     *
     * Le montant seul : l'infobulle rappelle le coût des marchandises, sans
     * taux de marge (choix explicite — un taux se lit mal d'un coup d'œil).
     */
    ...(canViewProfit
      ? [
          {
            key: 'profit',
            label: 'Bénéfice',
            className: 'text-right whitespace-nowrap',
            render: (invoice: SalesInvoiceRow) => {
              // Brouillon ou vente annulée : aucun bénéfice à montrer.
              if (invoice.profit === null) {
                return <span className="text-base-content/40">—</span>;
              }

              return (
                <Tooltip label={`Coût des marchandises : ${formatCurrency(invoice.cost ?? 0)}`}>
                  <span>
                    <MoneyText value={invoice.profit} colored bold />
                  </span>
                </Tooltip>
              );
            },
          },
        ]
      : []),
    {
      key: 'paymentStatus',
      label: 'Statut',
      className: 'whitespace-nowrap',
      render: (invoice: SalesInvoiceRow) => (
        <StatusBadge status={invoice.paymentStatus} kind="payment" />
      ),
    },
  ] satisfies Column<SalesInvoiceRow>[];

  /* Corps de carte mobile : identité de la vente, puis les montants en 2 × 2. */
  const renderCard = (invoice: SalesInvoiceRow) => (
    <div className="space-y-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {invoice.customerName?.trim() ? invoice.customerName : 'Client comptoir'}
          </p>
          <p className="tabular text-xs text-base-content/60">{formatDateShort(invoice.date)}</p>
        </div>
        <span className="shrink-0">
          <StatusBadge status={invoice.paymentStatus} kind="payment" />
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-base-200/50 px-3 py-2.5">
        <div className="min-w-0">
          <dt className="text-xs text-base-content/55">Total</dt>
          <dd className="truncate">
            <MoneyText value={invoice.total} bold />
          </dd>
        </div>
        <div className="min-w-0 text-right">
          <dt className="text-xs text-base-content/55">Reste</dt>
          <dd className="truncate">
            <MoneyText value={invoice.remainingAmount} remaining={invoice.status === 'active'} bold />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-base-content/55">Payé</dt>
          <dd className="truncate">
            <MoneyText value={invoice.amountPaid} />
          </dd>
        </div>
        {canViewProfit && (
          <div className="min-w-0 text-right">
            <dt className="text-xs text-base-content/55">Bénéfice</dt>
            <dd className="truncate">
              {invoice.profit === null ? (
                <span className="text-base-content/40">—</span>
              ) : (
                <MoneyText value={invoice.profit} colored />
              )}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );

  /*
   * Emplacement vide de la taille d'un bouton-icône, **sur ordinateur seulement** :
   * les actions sont alignées à droite, donc une ligne sans « Payer » décalait
   * l'œil et le reçu d'un cran — les icônes ne formaient plus de colonnes.
   * « Payer » (vente active) et « Valider » (brouillon) s'excluent : ils
   * partagent le même emplacement.
   */
  const slot = <span aria-hidden className="hidden h-8 w-8 shrink-0 sm:inline-block" />;

  return (
    <ResponsiveTable
      columns={columns}
      data={data}
      getRowKey={(invoice) => invoice.id}
      tableClassName="table-sm"
      actionsClassName="w-40"
      renderCard={renderCard}
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
          {(canPay || canValidate) &&
            !canCollect(invoice, canPay) &&
            !(canValidate && invoice.status === 'draft') &&
            slot}
          {canCancel && invoice.status !== 'cancelled' && (
            <IconAction
              icon="cancel"
              tone="danger"
              label="Annuler la vente (avec motif)"
              onClick={() => onOpenCancel(invoice)}
            />
          )}
          {canCancel && invoice.status === 'cancelled' && slot}
        </RowActions>
      )}
    />
  );
}
