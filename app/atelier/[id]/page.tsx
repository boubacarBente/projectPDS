'use client';

/**
 * Fiche d'une commande d'atelier (README §21, page `/atelier/[id]`).
 *
 * La page répond à quatre questions, dans cet ordre :
 *  1. **Où en est le travail ?** — `StageTracker` + bouton « Étape suivante »,
 *     qui déclenche l'entrée en stock du meuble fini **une seule fois** ;
 *  2. **Quelles matières ont été consommées, et combien ont été perdues ?** —
 *     chaque ligne porte sa quantité et ses **chutes**, et un ajout contrôle le
 *     stock disponible avant d'enregistrer ;
 *  3. **Qui a travaillé ?** — `days × dailyRate`, journalier ponctuel inclus ;
 *  4. **Le délai promis a-t-il été respecté ?** — badge explicite « Livré à
 *     temps » / « En retard », jamais la couleur seule.
 *
 * ⚠️ Aucun import runtime d'un module serveur (§11 bis) : `lib/furniture.ts`
 * est importé en `import type` uniquement. La liste des étapes est recopiée
 * pour l'affichage ; sa source de vérité reste `lib/furniture.ts`, qui valide
 * de toute façon l'étape reçue par l'API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type Stage,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import type {
  FurnitureOrderDetail,
  FurnitureOrderMaterialRow,
  FurnitureOrderWorkerRow,
  FurnitureModelRow,
  FurnitureStage,
} from '@/lib/furniture';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, formatPercent } from '@/lib/format';
import {
  CancelOrderDialog,
  FurnitureOrderFormModal,
  OrderMaterialModal,
  OrderWorkerModal,
  readApiError,
  DeliveryTiming,
  orderMaterialColumns,
  orderWorkerColumns,
  fetchCustomers,
  fetchFurnitureModels,
  fetchProducts,
  fetchWorkers,
  type CustomerOption,
  type ProductOption,
  type WorkerOption,
} from '@/components/atelier/atelier-modals';

/* Recopie d'affichage — la validation serveur reste la seule source de vérité. */
const STAGE_STEPS: Stage[] = [
  { key: 'cutting', label: 'Découpe' },
  { key: 'assembly', label: 'Assemblage' },
  { key: 'sanding', label: 'Ponçage' },
  { key: 'painting', label: 'Peinture / vernis' },
  { key: 'finishing', label: 'Finition' },
  { key: 'delivered', label: 'Livré' },
];

const STAGE_KEYS: FurnitureStage[] = [
  'cutting',
  'assembly',
  'sanding',
  'painting',
  'finishing',
  'delivered',
];

/** Étape suivante, ou `null` si la commande est déjà livrée. */
function nextStage(stage: string): FurnitureStage | null {
  const index = STAGE_KEYS.indexOf(stage as FurnitureStage);
  if (index < 0 || index >= STAGE_KEYS.length - 1) return null;
  return STAGE_KEYS[index + 1];
}

export default function AtelierOrderPage() {
  const params = useParams<{ id: string }>();
  const orderId = Number(params?.id);

  const canUpdate = usePermission('furniture.update');
  const canDelete = usePermission('furniture.delete');

  const [detail, setDetail] = useState<FurnitureOrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [isAdvancing, setIsAdvancing] = useState(false);

  /* Options des modales */
  const [models, setModels] = useState<FurnitureModelRow[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [isOptionsLoading, setIsOptionsLoading] = useState(true);

  /* Modales — un état booléen chacune */
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isMaterialOpen, setIsMaterialOpen] = useState(false);
  const [isWorkerOpen, setIsWorkerOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelReasonError, setCancelReasonError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const requested = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!Number.isInteger(orderId) || orderId <= 0) {
        setError('Identifiant de commande invalide.');
        setStatus(400);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/atelier/commandes/${orderId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        });
        setStatus(response.status);

        if (!response.ok) {
          throw new Error(await readApiError(response, 'La fiche de la commande n’a pas pu être chargée.'));
        }

        setDetail((await response.json()) as FurnitureOrderDetail);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setDetail(null);
        setError(
          caught instanceof Error ? caught.message : 'La fiche de la commande n’a pas pu être chargée.',
        );
      } finally {
        setIsLoading(false);
      }
    },
    [orderId],
  );

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      requested.current = false;
    };
  }, [load, reloadToken]);

  useEffect(() => {
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
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsOptionsLoading(false);
      });

    return () => controller.abort();
  }, []);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const order = detail?.order ?? null;
  const upcoming = order ? nextStage(order.stage) : null;
  const notFound = status === 404;

  const materialColumns = useMemo(() => orderMaterialColumns, []);
  const workerColumns = useMemo(() => orderWorkerColumns, []);

  const totalWastage = useMemo(
    () =>
      (detail?.materials ?? []).reduce((sum, line) => sum + Number(line.wastageQuantity ?? 0), 0),
    [detail?.materials],
  );

  /** Avance d'une étape : la livraison crédite le stock du meuble fini, une fois. */
  async function handleAdvance() {
    if (!order || !upcoming) return;

    setIsAdvancing(true);
    try {
      const response = await fetch(`/api/atelier/commandes/${order.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'advance', stage: upcoming }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Le changement d'étape a échoué."));
      }

      const next = (await response.json()) as FurnitureOrderDetail;
      setDetail(next);

      if (upcoming === 'delivered') {
        toast.success(
          next.order.productId
            ? `Commande ${next.order.orderNumber} livrée — le meuble fini est entré en stock.`
            : `Commande ${next.order.orderNumber} livrée.`,
        );
      } else {
        toast.success(`Étape « ${STAGE_STEPS.find((s) => s.key === upcoming)?.label} » atteinte.`);
      }
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Le changement d'étape a échoué.");
    } finally {
      setIsAdvancing(false);
    }
  }

  /** Retrait d'une ligne de matière : le stock est ré-incrémenté côté serveur. */
  async function handleRemoveMaterial(materialId: number) {
    if (!order) return;
    try {
      const response = await fetch(`/api/atelier/commandes/${order.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'removeMaterial', materialId }),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Retrait impossible.'));
      }
      setDetail((await response.json()) as FurnitureOrderDetail);
      toast.success('Matière retirée — le stock a été ré-incrémenté.');
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Retrait impossible.');
    }
  }

  async function handleRemoveWorker(workerLineId: number) {
    if (!order) return;
    try {
      const response = await fetch(`/api/atelier/commandes/${order.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'removeWorker', workerLineId }),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Retrait impossible.'));
      }
      setDetail((await response.json()) as FurnitureOrderDetail);
      toast.success('Affectation retirée.');
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Retrait impossible.');
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Production"
        title={order ? `Commande ${order.orderNumber}` : isLoading ? 'Chargement…' : 'Commande d’atelier'}
        description={
          order
            ? `${order.customerName} · ${order.modelName}${order.dimensions ? ` · ${order.dimensions}` : ''}${order.finish ? ` · ${order.finish}` : ''}`
            : 'Suivi du travail, matières consommées, équipe affectée, coût de revient et respect du délai promis.'
        }
        actions={
          <>
            <Link href="/atelier" className="btn btn-ghost min-h-11 sm:min-h-0">
              Retour à la liste
            </Link>
            {canUpdate && order && !order.isCancelled && (
              <button
                type="button"
                className="btn btn-outline min-h-11 sm:min-h-0"
                onClick={() => setIsEditOpen(true)}
              >
                Modifier
              </button>
            )}
            {canDelete && order && !order.isCancelled && (
              <button
                type="button"
                className="btn btn-error min-h-11 sm:min-h-0"
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
          {notFound ? (
            <EmptyState
              title="Commande introuvable"
              description="Cette commande n’existe pas ou a été retirée. Revenez à la liste pour en choisir une autre."
              action={
                <Link href="/atelier" className="btn btn-primary min-h-11">
                  Retour à l’atelier
                </Link>
              }
            />
          ) : (
            <ErrorState
              title="Impossible de charger la commande"
              description={error}
              onRetry={refresh}
            />
          )}
        </div>
      )}

      {!isLoading && !error && detail && order && (
        <>
          {order.isCancelled && (
            <p className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
              Cette commande est <strong>annulée</strong>. Les matières déjà sorties ont été rendues au
              stock ; la fiche reste consultable et n’a pas été supprimée.
            </p>
          )}

          {/* 1 · Suivi du travail */}
          <Card className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Suivi du travail</h2>
              <div className="flex flex-wrap items-center gap-2">
                {order.isDelivered ? (
                  order.isLate ? (
                    <Badge tone="error">En retard</Badge>
                  ) : order.promisedDate ? (
                    <Badge tone="success">Livré à temps</Badge>
                  ) : (
                    <Badge tone="success">Livré</Badge>
                  )
                ) : (
                  <Badge tone="info">En cours</Badge>
                )}
                {order.isCustom && <Badge tone="primary">Sur mesure</Badge>}
              </div>
            </div>

            <StageTracker stages={STAGE_STEPS} current={order.stage} />

            <div className="flex flex-wrap items-center gap-3">
              {canUpdate && upcoming && !order.isCancelled ? (
                <button
                  type="button"
                  className="btn btn-primary min-h-11 sm:min-h-0"
                  onClick={() => void handleAdvance()}
                  disabled={isAdvancing}
                >
                  {isAdvancing ? (
                    <span className="loading loading-spinner loading-sm" />
                  ) : (
                    `Étape suivante : ${STAGE_STEPS.find((s) => s.key === upcoming)?.label}`
                  )}
                </button>
              ) : order.isDelivered && !order.isCancelled ? (
                <p className="text-sm text-base-content/60">
                  Commande livrée : le meuble fini a été crédité en stock
                  {order.productName ? ` (${order.productName})` : ''} une seule fois.
                </p>
              ) : null}
            </div>
          </Card>

          {/* Cartes de synthèse */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <MiniStat label="Quantité" value={<QuantityText value={order.quantity} unit="unité(s)" />} />
            <MiniStat label="Coût matières" value={<MoneyText value={detail.costs.materialCost} />} />
            <MiniStat label="Main-d’œuvre" value={<MoneyText value={detail.costs.laborCost} />} />
            <MiniStat label="Coût de revient" tone="primary" value={<MoneyText value={detail.costs.totalCost} bold />} />
            <MiniStat
              label="Marge"
              tone={(detail.costs.margin ?? 0) < 0 ? 'error' : 'success'}
              value={<MoneyText value={detail.costs.margin} colored bold />}
            />
            <MiniStat
              label="Chutes de matière"
              tone={totalWastage > 0 ? 'warning' : 'neutral'}
              value={<QuantityText value={totalWastage} />}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Informations */}
            <Card className="lg:col-span-2">
              <h2 className="text-base font-semibold">Informations</h2>
              <div className="mt-2 divide-y divide-base-200/70">
                <InfoRow label="Client">{order.customerName}</InfoRow>
                <InfoRow label="Modèle">
                  {order.modelName}
                  {order.isCustom && <span className="ml-2 text-xs text-base-content/50">(sur mesure)</span>}
                </InfoRow>
                <InfoRow label="Dimensions">{order.dimensions || '—'}</InfoRow>
                <InfoRow label="Finition">{order.finish || '—'}</InfoRow>
                <InfoRow label="Meuble fini">
                  {order.productName ?? (
                    <span className="font-normal text-base-content/50">Aucun produit associé</span>
                  )}
                </InfoRow>
                <InfoRow label="Prix convenu">
                  <MoneyText value={order.agreedPrice} bold />
                </InfoRow>
                <InfoRow label="Acompte reçu">
                  <MoneyText value={order.amountPaid} />
                </InfoRow>
                <InfoRow label="Reste à encaisser">
                  <MoneyText value={detail.costs.remainingAmount} colored bold />
                </InfoRow>
                <InfoRow label="Marge">
                  <span className="inline-flex items-center gap-2">
                    <MoneyText value={detail.costs.margin} colored bold />
                    <span className="text-xs text-base-content/50">
                      {formatPercent(detail.costs.marginPercent)}
                    </span>
                  </span>
                </InfoRow>
                <InfoRow label="Notes de fabrication">
                  <span className="font-normal text-base-content/70">{order.notes || '—'}</span>
                </InfoRow>
              </div>
            </Card>

            {/* Délai */}
            <DeliveryTiming detail={detail} />
          </div>

          {/* 2 · Matériaux */}
          <PageSection
            title="Matières consommées"
            subtitle="Chaque sortie déduit le stock ; les chutes sont enregistrées comme une sortie distincte, avec un motif explicite."
            actions={
              canUpdate && !order.isCancelled ? (
                <button
                  type="button"
                  className="btn btn-primary min-h-11 sm:min-h-0"
                  onClick={() => setIsMaterialOpen(true)}
                >
                  Ajouter une matière
                </button>
              ) : null
            }
          >
            {detail.materials.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucune matière enregistrée"
                  description={
                    order.modelId
                      ? 'Le modèle possède une nomenclature : ajoutez les matières réellement consommées, en précisant les chutes constatées.'
                      : 'Commande sur mesure : ajoutez les matières consommées une par une.'
                  }
                  action={
                    canUpdate && !order.isCancelled ? (
                      <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsMaterialOpen(true)}>
                        Ajouter la première matière
                      </button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <ResponsiveTable
                columns={materialColumns}
                data={detail.materials}
                getRowKey={(line: FurnitureOrderMaterialRow) => line.id}
                tableClassName="table-sm"
                actions={
                  canUpdate && !order.isCancelled
                    ? (line: FurnitureOrderMaterialRow) => (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm min-h-11 border border-base-300 sm:min-h-0"
                          onClick={() => void handleRemoveMaterial(line.id)}
                        >
                          Retirer
                        </button>
                      )
                    : undefined
                }
              />
            )}

            {detail.materials.length > 0 && (
              <p className="text-xs text-base-content/50">
                Total matières : <MoneyText value={detail.costs.materialCost} bold /> · chutes cumulées :{' '}
                <QuantityText value={totalWastage} />
              </p>
            )}
          </PageSection>

          {/* 3 · Équipe */}
          <PageSection
            title="Équipe affectée"
            subtitle="Chef menuisier, ouvriers et apprentis — un journalier ponctuel peut être saisi sans fiche ouvrier."
            actions={
              canUpdate && !order.isCancelled ? (
                <button
                  type="button"
                  className="btn btn-primary min-h-11 sm:min-h-0"
                  onClick={() => setIsWorkerOpen(true)}
                >
                  Affecter un ouvrier
                </button>
              ) : null
            }
          >
            {detail.workers.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucun ouvrier affecté"
                  description="Affectez les jours travaillés et le tarif journalier : le montant de main-d’œuvre est calculé automatiquement."
                  action={
                    canUpdate && !order.isCancelled ? (
                      <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsWorkerOpen(true)}>
                        Affecter le premier ouvrier
                      </button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <ResponsiveTable
                columns={workerColumns}
                data={detail.workers}
                getRowKey={(line: FurnitureOrderWorkerRow) => line.id}
                tableClassName="table-sm"
                actions={
                  canUpdate && !order.isCancelled
                    ? (line: FurnitureOrderWorkerRow) => (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm min-h-11 border border-base-300 sm:min-h-0"
                          onClick={() => void handleRemoveWorker(line.id)}
                        >
                          Retirer
                        </button>
                      )
                    : undefined
                }
              />
            )}

            {detail.workers.length > 0 && (
              <p className="text-xs text-base-content/50">
                {formatNumber(detail.workers.reduce((sum, line) => sum + line.days, 0), 1)} jour(s) cumulé(s) ·{' '}
                <MoneyText value={detail.costs.laborCost} bold />
              </p>
            )}
          </PageSection>
        </>
      )}

      {/* Modale : modification de la commande */}
      {detail && (
        <FurnitureOrderFormModal
          isOpen={isEditOpen}
          onClose={() => setIsEditOpen(false)}
          onSaved={(next: FurnitureOrderDetail) => {
            toast.success(`Commande ${next.order.orderNumber} enregistrée.`);
            setIsEditOpen(false);
            setDetail(next);
          }}
          order={detail}
          models={models.filter((model) => model.isActive || model.id === detail.order.modelId)}
          customers={customers}
          products={products}
          isOptionsLoading={isOptionsLoading}
          idPrefix="edit"
        />
      )}

      {/* Modale : consommation de matière (+ chutes) */}
      <OrderMaterialModal
        isOpen={isMaterialOpen}
        onClose={() => setIsMaterialOpen(false)}
        onSaved={(next: FurnitureOrderDetail) => {
          toast.success('Sortie de matière enregistrée.');
          setIsMaterialOpen(false);
          setDetail(next);
        }}
        orderId={detail?.order.id ?? null}
        orderNumber={detail?.order.orderNumber ?? ''}
        materials={detail?.materials ?? []}
        products={products}
        isOptionsLoading={isOptionsLoading}
      />

      {/* Modale : affectation d'équipe */}
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

      {/* Modale : annulation avec motif obligatoire */}
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

            if (!response.ok) {
              throw new Error(await readApiError(response, "L'annulation a échoué."));
            }

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
