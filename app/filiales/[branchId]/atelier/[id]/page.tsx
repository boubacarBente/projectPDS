'use client';

/**
 * Fiche d'une commande de l'ancien atelier (README §29), dans la filiale Meuble
 * (README §31.9, ancienne page `/atelier/[id]`).
 *
 * La page répond, dans cet ordre, à :
 *  1. **Où en est le travail ?** — `StageTracker` + « Étape suivante » (la
 *     dernière étape livre le client ou met le meuble en stock, une seule fois) ;
 *  2. **Quelles matières faut-il, lesquelles sont sorties, combien de chutes ?**
 *     — besoins calculés depuis la nomenclature, « Sortir les matières
 *     prévues » (tout ou rien), lignes réellement sorties ;
 *  3. **Qui a travaillé ?** — jours × tarif, journalier ponctuel inclus ;
 *  4. **Qu'a payé le client ?** — encaissements avec reçu (commande client) ;
 *  5. **Le délai promis a-t-il été tenu ?**
 *
 * Une commande ne se modifie que depuis **son** magasin : ailleurs, la fiche
 * est en lecture seule. Coûts et marge n'arrivent qu'avec `balances.view`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ResponsiveTable } from '@/components/responsive-table';
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
  StageTracker,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useBranch } from '@/components/filiales/branch-context';
import { useAuth } from '@/components/auth-provider';
import { jobPaymentColumns } from '@/components/chantiers/chantiers-modals';
import type { FurnitureOrderDetail, FurnitureOrderMaterialRow, FurnitureOrderWorkerRow, FurnitureModelRow } from '@/lib/furniture';
import { furnitureStageLabel, furnitureStageSteps, nextFurnitureStage } from '@/lib/furniture-shared';
import { formatNumber, formatPercent } from '@/lib/format';
import {
  CancelOrderDialog,
  DeliveryTiming,
  FurnitureOrderFormModal,
  FurniturePaymentModal,
  OrderMaterialModal,
  OrderWorkerModal,
  RequirementsList,
  fetchCustomers,
  fetchFurnitureModels,
  fetchProducts,
  fetchWorkers,
  orderMaterialColumns,
  orderWorkerColumns,
  readApiError,
  type CustomerOption,
  type ProductOption,
  type WorkerOption,
} from '@/components/atelier/atelier-modals';

export default function AtelierOrderPage() {
  const params = useParams<{ id: string }>();
  const orderId = Number(params?.id);
  const { activeStoreId } = useAuth();

  const { href, canLevel, writable } = useBranch();
  // Historique de l'atelier repris par la filiale Meuble (README §31.9) : droits de la filiale.
  const canUpdate = usePermission('brick.update') && canLevel('edit') && writable;
  const canDelete = usePermission('brick.delete') && canLevel('manage') && writable;
  const canPay = usePermission('payments.create');
  const canViewPayments = usePermission('payments.view');

  const [detail, setDetail] = useState<FurnitureOrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [isBusy, setIsBusy] = useState(false);

  const [models, setModels] = useState<FurnitureModelRow[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [isOptionsLoading, setIsOptionsLoading] = useState(false);
  const [optionsLoaded, setOptionsLoaded] = useState(false);

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isMaterialOpen, setIsMaterialOpen] = useState(false);
  const [isWorkerOpen, setIsWorkerOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelReasonError, setCancelReasonError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    if (!Number.isInteger(orderId) || orderId <= 0) {
      setError('Identifiant de commande invalide.');
      setStatus(400);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    fetch(`/api/atelier/commandes/${orderId}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        setStatus(response.status);
        if (!response.ok) throw new Error(await readApiError(response, 'La fiche de la commande n’a pas pu être chargée.'));
        setDetail((await response.json()) as FurnitureOrderDetail);
      })
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setDetail(null);
        setError(caught instanceof Error ? caught.message : 'La fiche de la commande n’a pas pu être chargée.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [orderId, reloadToken]);

  /* Options des modales : chargées à la première ouverture (magasin actif). */
  const needsOptions = isEditOpen || isMaterialOpen || isWorkerOpen;
  useEffect(() => {
    if (!needsOptions || optionsLoaded) return;
    const controller = new AbortController();
    setIsOptionsLoading(true);
    void Promise.all([
      fetchFurnitureModels(controller.signal).catch(() => [] as FurnitureModelRow[]),
      fetchCustomers(controller.signal).catch(() => [] as CustomerOption[]),
      fetchProducts(controller.signal).catch(() => [] as ProductOption[]),
      fetchWorkers(controller.signal).catch(() => [] as WorkerOption[]),
    ])
      .then(([modelList, customerList, productList, workerList]) => {
        if (controller.signal.aborted) return;
        setModels(modelList);
        setCustomers(customerList);
        setProducts(productList);
        setWorkers(workerList);
        setOptionsLoaded(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsOptionsLoading(false);
      });
    return () => controller.abort();
  }, [needsOptions, optionsLoaded]);

  const refresh = useCallback(() => {
    setOptionsLoaded(false);
    setReloadToken((token) => token + 1);
  }, []);

  const order = detail?.order ?? null;
  const own = order?.storeId === activeStoreId;
  const editable = Boolean(order && own && !order.isCancelled);
  const workOpen = editable && !order?.isDelivered;
  const upcoming = order ? nextFurnitureStage(order.stage) : null;
  const steps = useMemo(() => furnitureStageSteps(order?.purpose ?? 'customer'), [order?.purpose]);
  const totalWastage = useMemo(
    () => (detail?.materials ?? []).reduce((sum, line) => sum + Number(line.wastageQuantity ?? 0), 0),
    [detail?.materials],
  );
  const showCosts = detail?.costs.totalCost !== null && detail?.costs.totalCost !== undefined;
  const plannedLeft = (detail?.requirements?.lines ?? []).some((line) => line.toConsumeQuantity > 0);

  /** Une action PUT sur la commande, qui renvoie la fiche à jour. */
  async function runAction(body: Record<string, unknown>, fallback: string): Promise<FurnitureOrderDetail | null> {
    if (!order) return null;
    setIsBusy(true);
    try {
      const response = await fetch(`/api/atelier/commandes/${order.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readApiError(response, fallback));
      const next = (await response.json()) as FurnitureOrderDetail;
      setDetail(next);
      setOptionsLoaded(false); // le stock a pu bouger
      return next;
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : fallback);
      return null;
    } finally {
      setIsBusy(false);
    }
  }

  async function handleAdvance() {
    if (!order || !upcoming) return;
    const next = await runAction({ action: 'advance', stage: upcoming }, "Le changement d'étape a échoué.");
    if (!next) return;
    if (upcoming === 'delivered') {
      toast.success(
        next.order.purpose === 'stock'
          ? `${formatNumber(next.order.quantity)} meuble(s) entré(s) en stock (${next.order.productName ?? 'produit fini'}).`
          : `Commande ${next.order.orderNumber} livrée.`,
      );
    } else {
      toast.success(`Étape « ${furnitureStageLabel(upcoming, next.order.purpose)} » atteinte.`);
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl 2xl:max-w-[100rem] space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Atelier — historique"
        title={order ? `Commande ${order.orderNumber}` : isLoading ? 'Chargement…' : 'Commande d’atelier'}
        description={
          order
            ? `${order.customerName} · ${formatNumber(order.quantity)} × ${order.modelName}${order.dimensions ? ` · ${order.dimensions}` : ''}${order.finish ? ` · ${order.finish}` : ''}`
            : 'Suivi du travail, matières, équipe, coût de revient, encaissements et délai promis.'
        }
        actions={
          <>
            <Link href={href('/atelier')} className="btn btn-ghost min-h-11">
              Retour à la liste
            </Link>
            {canUpdate && editable && (
              <button type="button" className="btn btn-outline min-h-11" onClick={() => setIsEditOpen(true)}>
                Modifier
              </button>
            )}
            {canDelete && workOpen && (
              <button
                type="button"
                className="btn btn-error min-h-11"
                onClick={() => {
                  setCancelReason('');
                  setCancelReasonError(null);
                  setIsCancelOpen(true);
                }}
              >
                Annuler la commande
              </button>
            )}
          </>
        }
      />

      {isLoading && (
        <>
          <SkeletonCards count={4} />
          <SkeletonTable rows={5} cols={5} />
        </>
      )}

      {!isLoading && error && (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          {status === 404 ? (
            <EmptyState
              title="Commande introuvable"
              description="Cette commande n’existe pas. Revenez à la liste pour en choisir une autre."
              action={
                <Link href={href('/atelier')} className="btn btn-primary min-h-11">
                  Retour à l’atelier
                </Link>
              }
            />
          ) : (
            <ErrorState title="Impossible de charger la commande" description={error} onRetry={refresh} />
          )}
        </div>
      )}

      {!isLoading && !error && detail && order && (
        <>
          {order.isCancelled && (
            <p className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
              Commande <strong>annulée</strong>
              {order.cancelledAt ? ` le ${new Date(order.cancelledAt).toLocaleDateString('fr-FR')}` : ''}
              {order.cancelledByName ? ` par ${order.cancelledByName}` : ''} — motif : {order.cancelReason ?? '—'}. Les
              matières sorties ont été rendues au stock ; la fiche reste consultable.
            </p>
          )}
          {!own && (
            <p className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
              Cette commande appartient au magasin <strong>{order.storeName ?? '—'}</strong> : elle se consulte ici
              mais ne se modifie que depuis ce magasin.
            </p>
          )}

          <Card className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Suivi du travail</h2>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={order.purpose === 'stock' ? 'neutral' : 'primary'}>
                  {order.purpose === 'stock' ? 'Fabrication pour le stock' : 'Commande client'}
                </Badge>
                {order.isCustom && <Badge tone="info">Sur mesure</Badge>}
                {order.isLate && !order.isCancelled && <Badge tone="error">En retard</Badge>}
              </div>
            </div>

            <StageTracker stages={steps} current={order.stage} />

            <div className="flex flex-wrap items-center gap-3">
              {canUpdate && workOpen && upcoming ? (
                <button type="button" className="btn btn-primary min-h-11" onClick={() => void handleAdvance()} disabled={isBusy}>
                  {isBusy ? (
                    <span className="loading loading-spinner loading-sm" />
                  ) : (
                    `Étape suivante : ${furnitureStageLabel(upcoming, order.purpose)}`
                  )}
                </button>
              ) : order.isDelivered ? (
                <p className="text-sm text-base-content/70">
                  {order.purpose === 'stock'
                    ? `Meuble mis en stock${order.productName ? ` (${order.productName})` : ''} : ${formatNumber(order.quantity)} unité(s), une seule fois.`
                    : 'Commande livrée au client.'}
                </p>
              ) : null}
              {upcoming === 'delivered' && order.purpose === 'stock' && workOpen && (
                <p className="text-xs text-base-content/60">
                  La dernière étape fait entrer {formatNumber(order.quantity)} « {order.productName ?? 'produit fini'} » dans
                  le stock de ce magasin.
                </p>
              )}
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <MiniStat label="Quantité" value={<QuantityText value={order.quantity} unit="unité(s)" />} />
            {order.purpose === 'customer' ? (
              <>
                <MiniStat label="Prix convenu" tone="primary" value={<MoneyText value={order.total} bold />} />
                <MiniStat label="Encaissé" value={<MoneyText value={order.amountPaid} />} />
                <MiniStat
                  label="Reste à payer"
                  value={<MoneyText value={order.remainingAmount} remaining={order.status === 'active'} bold />}
                />
              </>
            ) : (
              <MiniStat label="Produit fini" value={order.productName ?? '—'} />
            )}
            {showCosts && (
              <>
                <MiniStat label="Coût de revient" value={<MoneyText value={detail.costs.totalCost} bold />} />
                {detail.costs.margin !== null ? (
                  <MiniStat
                    label="Marge"
                    tone={(detail.costs.margin ?? 0) < 0 ? 'error' : 'success'}
                    value={<MoneyText value={detail.costs.margin} colored bold />}
                  />
                ) : (
                  <MiniStat label="Coût d’une unité" value={<MoneyText value={detail.costs.unitCost} />} />
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <h2 className="text-base font-semibold">Informations</h2>
              <div className="mt-2 divide-y divide-base-200/70">
                <InfoRow label="Magasin">{order.storeName ?? '—'}</InfoRow>
                <InfoRow label="Pour">{order.customerName}</InfoRow>
                <InfoRow label="Modèle">
                  {order.modelName}
                  {order.isCustom && <span className="ml-2 text-xs text-base-content/60">(sur mesure)</span>}
                </InfoRow>
                <InfoRow label="Dimensions">{order.dimensions || '—'}</InfoRow>
                <InfoRow label="Finition">{order.finish || '—'}</InfoRow>
                {showCosts && (
                  <>
                    <InfoRow label="Matières (chutes comprises)">
                      <MoneyText value={detail.costs.materialCost} />
                    </InfoRow>
                    <InfoRow label="Main-d’œuvre">
                      <MoneyText value={detail.costs.laborCost} />
                    </InfoRow>
                    {detail.costs.marginPercent !== null && (
                      <InfoRow label="Marge sur le prix">{formatPercent(detail.costs.marginPercent)}</InfoRow>
                    )}
                  </>
                )}
                <InfoRow label="Notes de fabrication">
                  <span className="font-normal text-base-content/70">{order.notes || '—'}</span>
                </InfoRow>
              </div>
              {showCosts && order.purpose === 'stock' && (
                <p className="mt-3 rounded-xl border border-base-200 bg-base-200/40 px-3 py-2 text-xs text-base-content/70">
                  Ce coût n’entre pas dans les charges de la période : le meuble est en stock, son coût reviendra à sa
                  vente, au prix d’achat de sa fiche produit. Coût de revient d’une unité :{' '}
                  <MoneyText value={detail.costs.unitCost} bold />.
                </p>
              )}
            </Card>

            <DeliveryTiming detail={detail} />
          </div>

          {detail.requirements && detail.requirements.lines.length > 0 && (
            <PageSection
              title="Matières prévues par le modèle"
              subtitle={`Nomenclature × ${formatNumber(order.quantity)} unité(s), sur le stock de ce magasin. Rien ne sort tant que vous ne le demandez pas.`}
              actions={
                canUpdate && workOpen && plannedLeft ? (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11"
                    disabled={isBusy}
                    onClick={async () => {
                      const next = await runAction({ action: 'consumePlanned' }, 'Les matières prévues n’ont pas pu sortir du stock.');
                      if (next) toast.success('Matières prévues sorties du stock.');
                    }}
                  >
                    Sortir les matières prévues
                  </button>
                ) : null
              }
            >
              <RequirementsList lines={detail.requirements.lines} />
              {!detail.requirements.isCovered && plannedLeft && (
                <p className="text-xs text-warning">
                  Stock insuffisant pour {detail.requirements.missingMaterialCount} matière(s) : achetez-les ou faites-les
                  transférer avant de les sortir. Aucune sortie partielle n’est faite.
                </p>
              )}
            </PageSection>
          )}

          <PageSection
            title="Matières sorties du stock"
            subtitle="Chaque ligne a quitté le stock du magasin ; les chutes sont une sortie distincte et comptent dans le coût."
            actions={
              canUpdate && workOpen ? (
                <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsMaterialOpen(true)}>
                  Ajouter une matière
                </button>
              ) : null
            }
          >
            {detail.materials.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucune matière sortie"
                  description={
                    detail.requirements
                      ? 'Sortez les matières prévues par le modèle, ou ajoutez-les une à une avec leurs chutes.'
                      : 'Commande sur mesure : ajoutez les matières consommées une à une.'
                  }
                />
              </div>
            ) : (
              <ResponsiveTable cardsBelow="xl"
                columns={orderMaterialColumns}
                data={detail.materials}
                getRowKey={(line: FurnitureOrderMaterialRow) => line.id}
                actions={
                  canUpdate && workOpen
                    ? (line: FurnitureOrderMaterialRow) => (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm min-h-11 border border-base-300"
                          disabled={isBusy}
                          aria-label={`Rendre au stock ${line.productName}`}
                          onClick={async () => {
                            const next = await runAction({ action: 'removeMaterial', materialId: line.id }, 'Retrait impossible.');
                            if (next) toast.success('Matière et chutes rendues au stock.');
                          }}
                        >
                          Rendre au stock
                        </button>
                      )
                    : undefined
                }
              />
            )}
            {detail.materials.length > 0 && (
              <p className="text-xs text-base-content/60">
                Chutes cumulées : <QuantityText value={totalWastage} />
                {showCosts && (
                  <>
                    {' '}
                    · total matières : <MoneyText value={detail.costs.materialCost} bold />
                  </>
                )}
              </p>
            )}
          </PageSection>

          <PageSection
            title="Équipe affectée"
            subtitle="Chef menuisier, ouvriers et apprentis du magasin — un journalier ponctuel peut être saisi sans fiche."
            actions={
              canUpdate && workOpen ? (
                <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsWorkerOpen(true)}>
                  Affecter un ouvrier
                </button>
              ) : null
            }
          >
            {detail.workers.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucun ouvrier affecté"
                  description="Affectez les jours travaillés et le tarif journalier : la main-d’œuvre se calcule toute seule."
                />
              </div>
            ) : (
              <ResponsiveTable cardsBelow="xl"
                columns={orderWorkerColumns}
                data={detail.workers}
                getRowKey={(line: FurnitureOrderWorkerRow) => line.id}
                actions={
                  canUpdate && workOpen
                    ? (line: FurnitureOrderWorkerRow) => (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm min-h-11 border border-base-300"
                          disabled={isBusy}
                          aria-label={`Retirer ${line.workerName}`}
                          onClick={async () => {
                            const next = await runAction({ action: 'removeWorker', workerLineId: line.id }, 'Retrait impossible.');
                            if (next) toast.success('Affectation retirée.');
                          }}
                        >
                          Retirer
                        </button>
                      )
                    : undefined
                }
              />
            )}
          </PageSection>

          {order.purpose === 'customer' && (
            <PageSection
              title="Encaissements"
              subtitle="Acomptes et solde du client : chaque encaissement émet un reçu et entre dans la caisse du magasin."
              actions={
                canPay && editable && order.remainingAmount > 0.001 ? (
                  <button type="button" className="btn btn-success min-h-11" onClick={() => setIsPaymentOpen(true)}>
                    Encaisser
                  </button>
                ) : null
              }
            >
              {!canViewPayments ? (
                <p className="text-sm text-base-content/60">Vous n’avez pas accès au détail des encaissements.</p>
              ) : detail.payments.length === 0 ? (
                <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                  <EmptyState title="Aucun encaissement" description="Les acomptes reçus du client apparaîtront ici, avec leur reçu." />
                </div>
              ) : (
                <ResponsiveTable cardsBelow="xl" columns={jobPaymentColumns} data={detail.payments} getRowKey={(payment) => payment.id} />
              )}
            </PageSection>
          )}
        </>
      )}

      {detail && (
        <FurnitureOrderFormModal
          isOpen={isEditOpen}
          onClose={() => setIsEditOpen(false)}
          onSaved={() => {
            toast.success('Commande enregistrée.');
            setIsEditOpen(false);
            refresh();
          }}
          order={detail}
          models={models}
          customers={customers}
          products={products}
          isOptionsLoading={isOptionsLoading}
          idPrefix="edit"
        />
      )}

      <OrderMaterialModal
        isOpen={isMaterialOpen}
        onClose={() => setIsMaterialOpen(false)}
        onSaved={(next: FurnitureOrderDetail) => {
          toast.success('Sortie de matière enregistrée.');
          setIsMaterialOpen(false);
          setDetail(next);
          setOptionsLoaded(false);
        }}
        orderId={detail?.order.id ?? null}
        orderNumber={detail?.order.orderNumber ?? ''}
        materials={detail?.materials ?? []}
        products={products}
        isOptionsLoading={isOptionsLoading}
      />

      <OrderWorkerModal
        isOpen={isWorkerOpen}
        onClose={() => setIsWorkerOpen(false)}
        onSaved={(next: FurnitureOrderDetail) => {
          toast.success('Ouvrier affecté.');
          setIsWorkerOpen(false);
          setDetail(next);
        }}
        orderId={detail?.order.id ?? null}
        orderNumber={detail?.order.orderNumber ?? ''}
        workers={workers}
      />

      <FurniturePaymentModal
        isOpen={isPaymentOpen}
        onClose={() => {
          setIsPaymentOpen(false);
          refresh();
        }}
        order={order}
      />

      <CancelOrderDialog
        isOpen={isCancelOpen}
        onClose={() => setIsCancelOpen(false)}
        onConfirm={async () => {
          if (!detail) return;
          if (!cancelReason.trim()) {
            setCancelReasonError('Le motif d’annulation est obligatoire.');
            return;
          }
          setCancelReasonError(null);
          setIsCancelling(true);
          try {
            const response = await fetch(`/api/atelier/commandes/${detail.order.id}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ reason: cancelReason.trim() }),
            });
            if (!response.ok) throw new Error(await readApiError(response, "L'annulation a échoué."));
            const next = (await response.json()) as FurnitureOrderDetail;
            setDetail(next);
            setIsCancelOpen(false);
            toast.success(`Commande ${next.order.orderNumber} annulée — matières rendues au stock.`);
          } catch (caught) {
            toast.error(caught instanceof Error ? caught.message : "L'annulation a échoué.");
          } finally {
            setIsCancelling(false);
          }
        }}
        orderNumber={detail?.order.orderNumber ?? ''}
        isSubmitting={isCancelling}
        reason={cancelReason}
        onReasonChange={(value) => {
          setCancelReason(value);
          if (value.trim()) setCancelReasonError(null);
        }}
        reasonError={cancelReasonError}
      />
    </div>
  );
}
