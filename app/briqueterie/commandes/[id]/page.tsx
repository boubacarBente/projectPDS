'use client';

/**
 * Fiche d'une commande client de briques (README §20, page
 * `/briqueterie/commandes/[id]`).
 *
 * La page répond à cinq questions, dans cet ordre :
 *  1. **Qui a commandé quoi, et à quel prix ?** — en-tête, client, dates, cartes
 *     de montants ;
 *  2. **Où en est la livraison ?** — avancement livré / commandé, ligne par
 *     ligne ;
 *  3. **Où en est l'argent ?** — total, payé, reste à payer (`MoneyText
 *     remaining`), historique des acomptes avec leur reçu ;
 *  4. **Qu'a-t-on le droit de faire maintenant ?** — un bouton par étape du
 *     cycle, et **un seul geste lourd** : « Facturer », confirmé explicitement ;
 *  5. **Qui a fait quoi ?** — historique du journal d'actions de cette fiche.
 *
 * ## L'invariant de ce module
 *
 * Une commande **ne touche jamais le stock**. La facturation (`action: invoice`)
 * crée une vente du canal `brick` : c'est elle qui sort le stock, fait entrer le
 * chiffre d'affaires et transfère les acomptes déjà encaissés. Aucune écriture
 * d'ici ne touche `products.stock`.
 *
 * ⚠️ Aucun import runtime d'un module serveur (`lib/brick-orders.ts` importe
 * `@/db`) : tout vient de `components/briqueterie/commandes-modals.tsx`, qui
 * redéclare le JSON de l'API (§11 bis des conventions).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { IconAction, RowActions } from '@/components/row-actions';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  InfoRow,
  MiniStat,
  MoneyText,
  PageSection,
  QuantityText,
  SkeletonCards,
  SkeletonTable,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { auditActionLabel } from '@/lib/audit-labels';
import { formatDateShort, formatDateTime } from '@/lib/date-format';
import { formatPercent } from '@/lib/format';
import {
  BRICK_ORDER_NEXT_STATUSES,
  BRICK_ORDER_STATUS_ACTIONS,
  BRICK_ORDER_STATUS_LABELS,
  BRICK_ORDER_STATUS_TONES,
  BrickOrderCancelDialog,
  BrickOrderDeliveryModal,
  BrickOrderFormModal,
  BrickOrderInvoiceDialog,
  BrickOrderPaymentModal,
  BrickOrderStatusDialog,
  brickOrderItemColumns,
  brickOrderPaymentColumns,
  brickOrderStatusLabel,
  canRegisterDelivery,
  fetchBrickOrderHistory,
  readApiError,
  useBrickOrderOptions,
  type BrickOrderDetail,
  type BrickOrderHistoryEntry,
  type BrickOrderRow,
  type BrickOrderStatus,
} from '@/components/briqueterie/commandes-modals';

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function BrickOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orderId = Number(params?.id);

  const canUpdate = usePermission('brick.update');
  const canDelete = usePermission('brick.delete');
  const canCollect = usePermission('brick.update');
  /** Facturer **crée une vente** : c'est `sales.create` qui fait foi côté API. */
  const canInvoice = usePermission('sales.create');

  const [detail, setDetail] = useState<BrickOrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  /* Historique du journal d'actions — lecture seule, jamais bloquante. */
  const [history, setHistory] = useState<BrickOrderHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const {
    brickTypes,
    customers,
    isLoading: isOptionsLoading,
    refresh: refreshOptions,
  } = useBrickOrderOptions();

  /* Modales — un état booléen chacune (§8.3 règle 1) */
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isDeliveryOpen, setIsDeliveryOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isInvoiceOpen, setIsInvoiceOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /* ------------------------------------------------------------------ *
   * Chargement
   * ------------------------------------------------------------------ */

  useEffect(() => {
    if (!Number.isInteger(orderId) || orderId <= 0) {
      setError('Identifiant de commande invalide.');
      setNotFound(true);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    fetch(`/api/briqueterie/commandes/${orderId}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (response.status === 404) {
          setNotFound(true);
          throw new Error('Cette commande n’existe pas sur ce poste.');
        }
        if (!response.ok) {
          throw new Error(
            await readApiError(response, 'La fiche de la commande n’a pas pu être chargée.'),
          );
        }
        return (await response.json()) as BrickOrderDetail;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setDetail(payload);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setDetail(null);
        setError(
          caught instanceof Error
            ? caught.message
            : 'La fiche de la commande n’a pas pu être chargée.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [orderId, reloadToken]);

  useEffect(() => {
    if (!Number.isInteger(orderId) || orderId <= 0) return;

    const controller = new AbortController();
    setHistoryLoading(true);
    setHistoryError(null);

    void fetchBrickOrderHistory(orderId, controller.signal)
      .then((entries) => {
        if (controller.signal.aborted) return;
        setHistory(entries);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        // L'historique est un complément : son échec ne masque pas la fiche.
        setHistoryError(
          caught instanceof Error ? caught.message : 'Historique de la commande indisponible.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });

    return () => controller.abort();
  }, [orderId, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const order = detail?.order ?? null;

  const columns = useMemo(() => brickOrderItemColumns, []);
  const paymentColumns = useMemo(() => brickOrderPaymentColumns, []);

  const historyColumns = useMemo<Column<BrickOrderHistoryEntry>[]>(
    () => [
      {
        key: 'createdAt',
        label: 'Date',
        className: 'whitespace-nowrap',
        render: (entry) => (
          <span className="tabular text-sm text-base-content/70">
            {formatDateTime(entry.createdAt)}
          </span>
        ),
      },
      {
        key: 'action',
        label: 'Action',
        primary: true,
        render: (entry) => <Badge tone="primary">{auditActionLabel(entry.action)}</Badge>,
      },
      {
        key: 'userName',
        label: 'Auteur',
        render: (entry) => <span className="text-sm">{entry.userName}</span>,
      },
      {
        key: 'details',
        label: 'Détail',
        hideOnMobile: true,
        render: (entry) => (
          <span className="block max-w-md break-words text-xs text-base-content/60">
            {entry.details || '—'}
          </span>
        ),
      },
    ],
    [],
  );

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  /** Passage d'état : `PUT { action: 'set_status' }`. */
  const handleStatusChange = useCallback(
    async (status: BrickOrderStatus) => {
      if (!order) return;

      setIsSubmitting(true);
      try {
        const response = await fetch(`/api/briqueterie/commandes/${order.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'set_status', status }),
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'Le changement d’état a échoué.'));
        }

        toast.success(`Commande ${order.orderNumber} — ${BRICK_ORDER_STATUS_LABELS[status]}.`);
        setIsStatusOpen(false);
        refresh();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : 'Le changement d’état a échoué.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [order, refresh],
  );

  /**
   * **Facturation** — l'action la plus lourde de l'écran.
   *
   * `PUT { action: 'invoice' }` crée une vente (canal `brick`) : sortie de
   * stock, chiffre d'affaires, transfert des acomptes. Elle exige en plus
   * `sales.create`, et son bouton reste masqué sans cette permission — le
   * serveur la revérifie de toute façon (§9 : masquer ne protège rien).
   */
  const handleInvoice = useCallback(async () => {
    if (!order) return;

    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/briqueterie/commandes/${order.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'invoice' }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'La facturation a échoué.'));
      }

      const result = (await response.json()) as {
        order: BrickOrderRow;
        invoiceId: number;
        invoiceNumber: string;
      };

      toast.success(
        `Commande ${result.order.orderNumber} facturée (${result.invoiceNumber}) : le stock est sorti et le chiffre d’affaires enregistré.`,
        { autoClose: 8000 },
      );
      setIsInvoiceOpen(false);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'La facturation a échoué.', {
        autoClose: 8000,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [order, refresh]);

  /** Annulation motivée : motif obligatoire, jamais de suppression (§7). */
  const handleCancel = useCallback(
    async (reason: string) => {
      if (!order) return;

      setIsSubmitting(true);
      try {
        const response = await fetch(`/api/briqueterie/commandes/${order.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ reason }),
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'L’annulation a échoué.'));
        }

        toast.success(`Commande ${order.orderNumber} annulée — la fiche et son motif sont conservés.`);
        setIsCancelOpen(false);
        refresh();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : 'L’annulation a échoué.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [order, refresh],
  );

  /* ------------------------------------------------------------------ *
   * Dérivés d'affichage
   * ------------------------------------------------------------------ */

  const quantityOrdered = order?.quantityOrdered ?? 0;
  const quantityDelivered = order?.quantityDelivered ?? 0;
  const deliveryPercent = quantityOrdered > 0 ? (quantityDelivered / quantityOrdered) * 100 : 0;

  const collectable = Boolean(
    order && !order.isCancelled && !order.salesInvoiceId && order.remainingAmount > 0.001,
  );
  const invoiceable = Boolean(
    order && !order.isCancelled && !order.salesInvoiceId && order.status !== 'draft',
  );
  /**
   * « Ce reste est-il payable ? » — la question que pose `MoneyText remaining`.
   *
   * Une commande annulée ou déjà facturée n'est plus encaissable, et un
   * brouillon ne l'est pas encore (`createPayment` refuse un document non
   * actif) : leur reste reste **neutre** même non nul. Le rouge est réservé à
   * une dette réellement due sur une commande engagée.
   */
  const remainingPayable = Boolean(
    order &&
      !order.isCancelled &&
      !order.salesInvoiceId &&
      order.status !== 'draft' &&
      order.remainingAmount > 0.001,
  );
  const notFoundView = notFound || (!isLoading && !detail);

  /* ------------------------------------------------------------------ *
   * Rendu
   * ------------------------------------------------------------------ */

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Briqueterie"
        title={order ? `Commande ${order.orderNumber}` : 'Commande de briques'}
        description={
          order
            ? `${order.customerName} · commandée le ${formatDateShort(order.date)}`
            : 'Engagement client : quantités, prix négociés, acomptes et livraisons. La facturation est le seul geste qui sort le stock.'
        }
        actions={
          <>
            <Link
              href="/briqueterie/commandes"
              className="btn btn-ghost min-h-11 border border-base-300"
            >
              Retour à la liste
            </Link>
            {canUpdate && order && !order.isCancelled && !order.salesInvoiceId && (
              <button
                type="button"
                className="btn btn-outline min-h-11"
                onClick={() => setIsEditOpen(true)}
              >
                Modifier
              </button>
            )}
            {canInvoice && invoiceable && (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => setIsInvoiceOpen(true)}
              >
                Facturer
              </button>
            )}
          </>
        }
      />

      {isLoading && (
        <>
          <SkeletonCards count={4} />
          <SkeletonTable rows={4} cols={5} />
        </>
      )}

      {!isLoading && (error || notFoundView) && (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          {notFoundView ? (
            <EmptyState
              title="Commande introuvable"
              description="Cette commande n’existe pas sur ce poste, ou son identifiant est invalide. Revenez à la liste pour en choisir une autre."
              action={
                <Link href="/briqueterie/commandes" className="btn btn-primary min-h-11">
                  Retour aux commandes
                </Link>
              }
            />
          ) : (
            <ErrorState
              title="Impossible de charger la commande"
              description={error ?? 'La fiche de la commande n’a pas pu être chargée.'}
              onRetry={refresh}
            />
          )}
        </div>
      )}

      {!isLoading && !error && detail && order && (
        <>
          {/* Bandeaux d'état — jamais la couleur seule : le libellé est là. */}
          {order.isCancelled && (
            <p className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
              Cette commande est <strong>annulée</strong>
              {order.cancelReason ? ` — motif : ${order.cancelReason}` : ''}. Elle n’est{' '}
              <strong>jamais supprimée</strong> : sa fiche et son historique restent consultables.
            </p>
          )}

          {order.salesInvoiceId && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
              <span>
                Cette commande a été <strong>facturée</strong> ({order.salesInvoiceNumber}). Le stock
                est sorti et le chiffre d’affaires enregistré sur la facture ; les acomptes y ont été
                transférés.
              </span>
              <Link
                href={`/ventes/${order.salesInvoiceId}`}
                className="btn btn-success btn-sm min-h-11"
              >
                Ouvrir la facture
              </Link>
            </div>
          )}

          {/* 1 · En-tête de la commande */}
          <Card className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">Commande {order.orderNumber}</h2>
                <p className="text-sm text-base-content/60">
                  {order.customerName}
                  {order.userName ? ` · enregistrée par ${order.userName}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={BRICK_ORDER_STATUS_TONES[order.status]}>
                  {brickOrderStatusLabel(order.status)}
                </Badge>
                {order.isCancelled && <Badge tone="error">Annulée</Badge>}
                {order.salesInvoiceNumber && <Badge tone="success">Facturée</Badge>}
                {!order.isCancelled &&
                  !order.salesInvoiceId &&
                  order.promisedDate &&
                  order.promisedDate < order.date &&
                  quantityDelivered < quantityOrdered && (
                    <Badge tone="warning">Délai promis dépassé</Badge>
                  )}
              </div>
            </div>

            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              <InfoRow label="Client">
                {order.customerId ? (
                  <Link href={`/clients/${order.customerId}`} className="text-primary hover:underline">
                    {order.customerName}
                  </Link>
                ) : (
                  <span>
                    {order.customerName}{' '}
                    <span className="text-xs font-normal text-base-content/50">(hors fichier)</span>
                  </span>
                )}
              </InfoRow>
              <InfoRow label="Commandée le">{formatDateShort(order.date)}</InfoRow>
              <InfoRow label="Livraison promise">{formatDateShort(order.promisedDate)}</InfoRow>
              <InfoRow label="Échéance de paiement">{formatDateShort(order.dueDate)}</InfoRow>
              <InfoRow label="Livrée le">{formatDateShort(order.deliveryDate)}</InfoRow>
              <InfoRow label="Créée le">{formatDateShort(order.createdAt)}</InfoRow>
            </div>

            {order.notes && (
              <p className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2 text-sm text-base-content/70">
                <strong>Notes :</strong> {order.notes}
              </p>
            )}

            {/* Actions du cycle de vie — un seul geste par transition.
                « Prête » et « Partiellement livrée » n'ont qu'un geste utile :
                la livraison, qui **constate** les quantités réellement parties
                et pose elle-même le statut (« Partiellement livrée », puis
                « Livrée » quand tout est parti). Un bouton « Marquer livrée »
                affirmerait une livraison sans la saisir. */}
            {canUpdate && !order.isCancelled && !order.salesInvoiceId && (
              <div className="flex flex-wrap items-center gap-2 border-t border-base-200 pt-3">
                {canRegisterDelivery(order.status) ? (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11"
                    onClick={() => setIsDeliveryOpen(true)}
                  >
                    Enregistrer une livraison
                  </button>
                ) : (
                  (BRICK_ORDER_NEXT_STATUSES[order.status] ?? [])
                    .filter((state) => state !== 'delivered' && state !== 'partially_delivered')
                    .map((state) => (
                      <button
                        key={state}
                        type="button"
                        className="btn btn-outline min-h-11"
                        onClick={() => setIsStatusOpen(true)}
                      >
                        {BRICK_ORDER_STATUS_ACTIONS[state] ??
                          `Passer à « ${BRICK_ORDER_STATUS_LABELS[state]} »`}
                      </button>
                    ))
                )}

                {canCollect && collectable && (
                  <button
                    type="button"
                    className="btn btn-outline min-h-11"
                    onClick={() => setIsPaymentOpen(true)}
                  >
                    Encaisser un acompte
                  </button>
                )}

                {canDelete && (
                  <button
                    type="button"
                    className="btn btn-error min-h-11"
                    onClick={() => setIsCancelOpen(true)}
                  >
                    Annuler la commande
                  </button>
                )}
              </div>
            )}
          </Card>

          {/* 2 · Cartes de montants et d'avancement */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <MiniStat label="Total" tone="primary" value={<MoneyText value={order.total} bold />} />
            <MiniStat label="Payé" tone="success" value={<MoneyText value={order.amountPaid} />} />
            <MiniStat
              label="Reste à payer"
              tone={remainingPayable ? 'error' : 'neutral'}
              value={
                /* Rouge dès qu'il reste quelque chose à encaisser, neutre à
                   zéro ; une commande annulée, facturée ou encore brouillon
                   n'est pas payable, donc neutre. */
                <MoneyText
                  value={order.remainingAmount}
                  remaining={remainingPayable}
                  bold={order.remainingAmount > 0.001}
                />
              }
            />
            <MiniStat
              label="Livré"
              tone={deliveryPercent >= 100 ? 'success' : deliveryPercent > 0 ? 'info' : 'neutral'}
              value={
                <span className="whitespace-nowrap">
                  <QuantityText value={quantityDelivered} /> /{' '}
                  <QuantityText value={quantityOrdered} />
                </span>
              }
            />
            <MiniStat
              label="Remise consentie"
              value={<MoneyText value={order.discount} />}
            />
          </div>

          {/* Avancement de livraison — la largeur porte l'information, le
              pourcentage et le libellé la portent aussi (jamais la couleur seule). */}
          <Card className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Avancement de la livraison</h2>
              <Badge tone={deliveryPercent >= 100 ? 'success' : deliveryPercent > 0 ? 'info' : 'neutral'}>
                {formatPercent(deliveryPercent)} livré
              </Badge>
            </div>
            <div
              className="h-2.5 w-full overflow-hidden rounded-full bg-base-300"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(deliveryPercent)}
              aria-label="Avancement de la livraison"
            >
              <div
                className={`h-full rounded-full ${deliveryPercent >= 100 ? 'bg-success' : 'bg-primary'}`}
                style={{ width: `${Math.min(100, Math.max(0, deliveryPercent))}%` }}
              />
            </div>
            <p className="text-xs text-base-content/50">
              Livré <QuantityText value={quantityDelivered} /> sur{' '}
              <QuantityText value={quantityOrdered} /> commandées. La livraison <strong>constate</strong>{' '}
              ce qui part chez le client : c’est la facture qui écrit le stock.
            </p>
          </Card>

          {/* 3 · Lignes de la commande */}
          <PageSection
            title="Briques commandées"
            subtitle="Prix négociés et remises de ligne. Le montant de chaque ligne est recalculé par le serveur."
            actions={
              <span className="text-sm text-base-content/60">
                Sous-total <MoneyText value={order.subTotal} /> · remise{' '}
                <MoneyText value={order.discount} />
              </span>
            }
          >
            <ResponsiveTable
              columns={columns}
              data={detail.items}
              getRowKey={(item) => item.id}
              tableClassName="table-sm"
              emptyMessage="Aucune ligne sur cette commande."
            />
          </PageSection>

          {/* 4 · Historique des acomptes */}
          <PageSection
            title="Acomptes encaissés"
            subtitle="Chaque acompte a son reçu numéroté et son mouvement de caisse. À la facturation, les reçus sont transférés sur la facture — jamais recréés."
            actions={
              canCollect && collectable ? (
                <button
                  type="button"
                  className="btn btn-outline min-h-11"
                  onClick={() => setIsPaymentOpen(true)}
                >
                  Encaisser un acompte
                </button>
              ) : null
            }
          >
            {detail.payments.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucun acompte encaissé"
                  description={
                    order.isCancelled
                      ? 'Cette commande est annulée : elle n’accepte plus d’encaissement.'
                      : order.salesInvoiceId
                        ? 'Les acomptes ont été transférés sur la facture de vente.'
                        : 'Enregistrez un acompte pour sécuriser la commande : un reçu numéroté et une entrée en caisse sont créés.'
                  }
                  action={
                    canCollect && collectable ? (
                      <button
                        type="button"
                        className="btn btn-primary min-h-11"
                        onClick={() => setIsPaymentOpen(true)}
                      >
                        Encaisser le premier acompte
                      </button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <>
                <ResponsiveTable
                  columns={paymentColumns}
                  data={detail.payments}
                  getRowKey={(payment) => payment.id}
                  tableClassName="table-sm"
                  actions={(payment) => (
                    <RowActions>
                      <IconAction
                        icon="receipt"
                        label={`Voir le reçu ${payment.receiptNumber}`}
                        href={`/recus/${payment.id}`}
                      />
                    </RowActions>
                  )}
                />
                <p className="text-xs text-base-content/50">
                  Total encaissé : <MoneyText value={order.amountPaid} bold /> · reste à payer :{' '}
                  <MoneyText
                    value={order.remainingAmount}
                    remaining={remainingPayable}
                    bold
                  />
                  {detail.schedule.isOverdue ? (
                    <>
                      {' '}
                      · <span className="text-error">échéance dépassée</span>
                    </>
                  ) : null}
                </p>
              </>
            )}
          </PageSection>

          {/* 5 · Historique des modifications */}
          <PageSection
            title="Historique des modifications"
            subtitle="Création, changements d’état, encaissements et facturation de cette commande — écrits par l’application dans le journal d’actions."
          >
            {historyLoading ? (
              <SkeletonTable rows={3} cols={4} />
            ) : historyError ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <ErrorState
                  title="Historique indisponible"
                  description={historyError}
                  onRetry={refresh}
                />
              </div>
            ) : history.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucune modification enregistrée"
                  description="Cette commande n’a pas encore été modifiée depuis sa création."
                />
              </div>
            ) : (
              <ResponsiveTable
                columns={historyColumns}
                data={history}
                getRowKey={(entry) => entry.id}
                tableClassName="table-sm"
              />
            )}
          </PageSection>
        </>
      )}

      {/* 6 · Modales — un état booléen chacune */}
      {detail && (
        <>
          <BrickOrderFormModal
            isOpen={isEditOpen}
            onClose={() => setIsEditOpen(false)}
            onSaved={(next: BrickOrderDetail) => {
              setDetail(next);
              setIsEditOpen(false);
              toast.success(`Commande ${next.order.orderNumber} enregistrée.`);
              refresh();
            }}
            order={detail}
            idPrefix="edit"
            brickTypes={brickTypes}
            customers={customers}
            isOptionsLoading={isOptionsLoading}
            onCustomersChanged={refreshOptions}
          />

          <BrickOrderStatusDialog
            isOpen={isStatusOpen}
            onClose={() => setIsStatusOpen(false)}
            onConfirm={handleStatusChange}
            order={detail.order}
            isSubmitting={isSubmitting}
          />

          <BrickOrderDeliveryModal
            isOpen={isDeliveryOpen}
            onClose={() => setIsDeliveryOpen(false)}
            order={detail.order}
            items={detail.items}
            onSaved={(next: BrickOrderDetail) => {
              setDetail(next);
              setIsDeliveryOpen(false);
              refresh();
            }}
          />

          <BrickOrderPaymentModal
            isOpen={isPaymentOpen}
            onClose={() => setIsPaymentOpen(false)}
            order={detail.order}
            onRecorded={(next: BrickOrderDetail) => {
              setDetail(next);
              refresh();
            }}
          />

          <BrickOrderInvoiceDialog
            isOpen={isInvoiceOpen}
            onClose={() => setIsInvoiceOpen(false)}
            onConfirm={handleInvoice}
            order={detail.order}
            isSubmitting={isSubmitting}
          />

          <BrickOrderCancelDialog
            isOpen={isCancelOpen}
            onClose={() => {
              if (isSubmitting) return;
              setIsCancelOpen(false);
            }}
            onConfirm={handleCancel}
            order={detail.order}
            isSubmitting={isSubmitting}
          />
        </>
      )}

      {/* Une fiche introuvable ne doit pas laisser l'utilisateur sans issue. */}
      {!isLoading && !detail && !notFoundView && (
        <div className="flex justify-center">
          <button
            type="button"
            className="btn btn-ghost min-h-11 border border-base-300"
            onClick={() => router.push('/briqueterie/commandes')}
          >
            Retour aux commandes
          </button>
        </div>
      )}
    </div>
  );
}
