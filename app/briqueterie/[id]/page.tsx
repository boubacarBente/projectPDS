'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ToolbarButton } from '@/components/data-toolbar';
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
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { formatDateLong, formatDateShort } from '@/lib/date-format';
import { formatNumber, formatPercent, formatQuantity } from '@/lib/format';
import {
  BRICK_STAGES,
  BRICK_STAGE_TONES,
  BrickWorkersManagerButton,
  BrokenBricksModal,
  CancelProductionDialog,
  ProductionCostCard,
  ProductionMaterialModal,
  ProductionWorkerModal,
  RemoveMaterialDialog,
  RemoveWorkerDialog,
  brickShapeLabel,
  brickStageLabel,
  goodQuantityOf,
  nextBrickStage,
  productionMaterialColumns,
  productionWorkerColumns,
  readApiError,
  useBrickSelectOptions,
  type BrickProductionDetail,
  type BrickProductionMaterialRow,
  type BrickProductionWorkerRow,
} from '@/components/briqueterie/briqueterie-modals';

/* ==================================================================
 * Fiche d'un lot de fabrication (README §20).
 *
 * `GET /api/briqueterie/productions/[id]` renvoie `production`, `brickType`,
 * `product`, `materials`, `workers` et `costs` — le coût de revient étant
 * **calculé** (`total_cost ÷ (produced − broken)`), jamais stocké.
 *
 * Le bouton « Étape suivante » appelle `advance_stage` : c'est le serveur qui
 * décide des mouvements de stock (sortie des matières, crédit unique des
 * briques finies à l'étape `stored`). La page n'écrit jamais `products.stock`.
 * ================================================================== */

function SectionCard({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageSection
      title={title}
      subtitle={subtitle}
      actions={actions}
    >
      <Card>{children}</Card>
    </PageSection>
  );
}

export default function BrickProductionDetailPage() {
  const params = useParams<{ id: string }>();
  const productionId = Number(params?.id);

  const canUpdate = usePermission('brick.update');
  const canDelete = usePermission('brick.delete');

  const [detail, setDetail] = useState<BrickProductionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  /* Un état booléen par modale (§8.3 règle 1). */
  const [isMaterialOpen, setIsMaterialOpen] = useState(false);
  const [isWorkerOpen, setIsWorkerOpen] = useState(false);
  const [isBrokenOpen, setIsBrokenOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [isRemoveMaterialOpen, setIsRemoveMaterialOpen] = useState(false);
  const [materialToRemove, setMaterialToRemove] = useState<BrickProductionMaterialRow | null>(null);
  const [isRemoveWorkerOpen, setIsRemoveWorkerOpen] = useState(false);
  const [workerToRemove, setWorkerToRemove] = useState<BrickProductionWorkerRow | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAdvancing, setIsAdvancing] = useState(false);

  const { products, workers, isLoading: isOptionsLoading } = useBrickSelectOptions(
    isMaterialOpen || isWorkerOpen,
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!Number.isInteger(productionId) || productionId <= 0) {
        setError('Identifiant de lot invalide.');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const response = await fetch(`/api/briqueterie/productions/${productionId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        });

        if (response.status === 404) {
          setNotFound(true);
          setDetail(null);
          return;
        }

        if (!response.ok) {
          throw new Error(await readApiError(response, 'Le lot n’a pas pu être chargé.'));
        }

        setDetail((await response.json()) as BrickProductionDetail);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setDetail(null);
        setError(caught instanceof Error ? caught.message : 'Le lot n’a pas pu être chargé.');
      } finally {
        setIsLoading(false);
      }
    },
    [productionId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  /* ── Passage d'étape — mouvements de stock côté serveur ───────────── */
  async function advance() {
    if (!detail) return;
    const next = nextBrickStage(detail.production.stage);
    if (!next) return;

    setIsAdvancing(true);
    try {
      const response = await fetch(`/api/briqueterie/productions/${detail.production.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'advance_stage', stage: next.key }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Le passage d’étape a échoué.'));
      }

      if (next.key === 'stored') {
        toast.success(
          `Lot mis en stock : ${formatQuantity(goodQuantityOf(detail.production), detail.production.productUnit)} créditées au produit ${detail.production.productName}.`,
        );
      } else {
        toast.success(`Étape « ${brickStageLabel(next.key)} » enregistrée.`);
      }
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Le passage d’étape a échoué.');
    } finally {
      setIsAdvancing(false);
    }
  }

  /* ── Retrait d'une ligne de matière ───────────────────────────────── */
  async function removeMaterial() {
    if (!detail || !materialToRemove) return;
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/briqueterie/productions/${detail.production.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'remove_material', materialId: materialToRemove.id }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Le retrait a échoué.'));
      }

      toast.success(`${materialToRemove.productName} rendu au stock.`);
      setIsRemoveMaterialOpen(false);
      setMaterialToRemove(null);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Le retrait a échoué.');
    } finally {
      setIsSubmitting(false);
    }
  }

  /* ── Retrait d'une affectation ────────────────────────────────────── */
  async function removeWorker() {
    if (!detail || !workerToRemove) return;
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/briqueterie/productions/${detail.production.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'remove_worker', workerId: workerToRemove.id }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Le retrait a échoué.'));
      }

      toast.success(`Affectation de ${workerToRemove.workerName} retirée.`);
      setIsRemoveWorkerOpen(false);
      setWorkerToRemove(null);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Le retrait a échoué.');
    } finally {
      setIsSubmitting(false);
    }
  }

  /* ── Annulation motivée (jamais de suppression) ───────────────────── */
  async function cancelProduction(reason: string) {
    if (!detail) return;
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/briqueterie/productions/${detail.production.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'L’annulation a échoué.'));
      }

      toast.success('Lot annulé : le stock a été réversé, la fiche reste consultable.');
      setIsCancelOpen(false);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'L’annulation a échoué.');
    } finally {
      setIsSubmitting(false);
    }
  }

  /* ── États d'erreur et de chargement ──────────────────────────────── */
  if (isLoading && !detail) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <SkeletonCards count={4} />
        <SkeletonTable rows={6} cols={5} />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">
        <EmptyState
          title="Lot introuvable"
          description="Ce lot de fabrication n’existe pas sur ce poste, ou il a été annulé."
          action={
            <Link href="/briqueterie" className="btn btn-primary min-h-11">
              Retour aux lots
            </Link>
          }
        />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">
        <ErrorState
          title="Chargement impossible"
          description={error ?? 'Le lot n’a pas pu être chargé.'}
          onRetry={refresh}
        />
      </div>
    );
  }

  const { production, brickType, product, materials, workers: assignments, costs } = detail;
  const isCancelled = production.isCancelled;
  const next = nextBrickStage(production.stage);
  const good = goodQuantityOf(production);
  const salePrice = product?.salePrice ?? brickType?.salePrice ?? 0;
  const unit = production.productUnit || 'pièce';

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow={`Briqueterie · ${brickStageLabel(production.stage)}`}
        title={production.batchNumber}
        description={`${production.brickTypeName} — ${brickShapeLabel(production.shape)}${
          production.dimensions ? ` · ${production.dimensions}` : ''
        }${production.notes && !isCancelled ? '' : ''}`}
        actions={
          <>
            <BrickWorkersManagerButton onChanged={refresh} />
            <Link href="/briqueterie" className="btn btn-ghost min-h-11 border border-base-300">
              Tous les lots
            </Link>
            {canUpdate && !isCancelled && next && (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => void advance()}
                disabled={isAdvancing}
              >
                {isAdvancing ? (
                  <>
                    <span className="loading loading-spinner loading-sm" aria-hidden />
                    Passage…
                  </>
                ) : (
                  `Étape suivante : ${brickStageLabel(next.key)}`
                )}
              </button>
            )}
            {canDelete && !isCancelled && (
              <button
                type="button"
                className="btn btn-error min-h-11"
                onClick={() => setIsCancelOpen(true)}
              >
                Annuler le lot
              </button>
            )}
          </>
        }
      />

      {/* Bandeau d'état : annulé, ou étape courante */}
      {isCancelled ? (
        <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          <strong>Lot annulé.</strong> Le stock a été réversé (briques finies ressorties, matières
          premières rendues). La fiche n’est jamais supprimée : elle reste consultable.
        </div>
      ) : null}

      {/* 1 · Avancement — StageTracker (moulage → séchage → cuisson → stock) */}
      <Card>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Avancement de la fabrication</p>
              <p className="text-xs text-base-content/55">
                Le stock des briques finies est crédité <strong>une seule fois</strong>, à l’étape
                « Mise en stock ». Si le lot y repasse, rien n’est crédité à nouveau.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={BRICK_STAGE_TONES[production.stage]}>
                {brickStageLabel(production.stage)}
              </Badge>
              {production.stored ? (
                <Badge tone="success">Stock crédité</Badge>
              ) : (
                <Badge tone="neutral">Pas encore en stock</Badge>
              )}
            </div>
          </div>
          <StageTracker stages={BRICK_STAGES} current={production.stage} />
        </div>
      </Card>

      {/* 2 · Cartes de synthèse */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCardDelta
          label="Quantité prévue"
          tone="primary"
          value={<QuantityText value={production.plannedQuantity} unit={unit} />}
          hint={`Production : ${formatQuantity(production.producedQuantity, unit)}`}
        />
        <StatCardDelta
          label="Briques bonnes"
          tone="success"
          value={<QuantityText value={good} unit={unit} />}
          hint={`Cassées : ${formatQuantity(production.brokenQuantity, unit)}`}
        />
        <StatCardDelta
          label="Coût de revient unitaire"
          tone="info"
          value={<MoneyText value={costs.unitCost} />}
          hint={`Coût total ${formatNumber(costs.totalCost)} GNF`}
        />
        <StatCardDelta
          label="Stock du produit lié"
          tone="primary"
          value={<QuantityText value={product?.stock ?? 0} unit={unit} />}
          hint={product ? product.name : 'Produit lié introuvable'}
        />
      </div>

      {/* 3 · Informations du lot */}
      <SectionCard
        title="Informations du lot"
        subtitle="Un coût de revient n’est jamais stocké : il est recalculé à chaque lecture."
      >
        <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <InfoRow label="Numéro de lot">
            <span className="font-mono">{production.batchNumber}</span>
          </InfoRow>
          <InfoRow label="Type de brique">{production.brickTypeName}</InfoRow>
          <InfoRow label="Forme">{brickShapeLabel(production.shape)}</InfoRow>
          <InfoRow label="Dimensions">{production.dimensions || '—'}</InfoRow>
          <InfoRow label="Date de début">{formatDateLong(production.startDate)}</InfoRow>
          <InfoRow label="Date de fin">{formatDateLong(production.endDate)}</InfoRow>
          <InfoRow label="Produit lié (stock et prix de vente)">
            {product ? (
              <span>{product.name}</span>
            ) : (
              '—'
            )}
          </InfoRow>
          <InfoRow label="Prix de vente unitaire">
            <MoneyText value={salePrice} />
          </InfoRow>
          <InfoRow label="Créé par">{production.userName || 'Système'}</InfoRow>
          <InfoRow label="Créé le">{formatDateShort(production.createdAt)}</InfoRow>
        </div>
        {production.notes ? (
          <div className="mt-4 rounded-xl border border-base-200 bg-base-200/40 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/45">
              Notes de fabrication
            </p>
            <p className="mt-1 whitespace-pre-line text-sm">{production.notes}</p>
          </div>
        ) : null}
      </SectionCard>

      {/* 4 · Matières premières */}
      <SectionCard
        title="Matières premières consommées"
        subtitle="Chaque ligne sort du stock par un mouvement « sortie » (reference_type = brick_production)."
        actions={
          canUpdate && !isCancelled ? (
            <ToolbarButton variant="primary" onClick={() => setIsMaterialOpen(true)}>
              Ajouter une matière
            </ToolbarButton>
          ) : null
        }
      >
        {materials.length === 0 ? (
          <EmptyState
            title="Aucune matière première"
            description="Ajoutez l’argile, le ciment, le sable, l’eau ou le bois de chauffe consommés par ce lot : le stock est déduit automatiquement."
            action={
              canUpdate && !isCancelled ? (
                <button
                  type="button"
                  className="btn btn-primary min-h-11"
                  onClick={() => setIsMaterialOpen(true)}
                >
                  Ajouter la première matière
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ResponsiveTable
              columns={productionMaterialColumns}
              data={materials}
              getRowKey={(material) => material.id}
              emptyMessage="Aucune matière première."
              actions={
                canUpdate && !isCancelled
                  ? (material) => (
                      <ToolbarButton
                        variant="error"
                        onClick={() => {
                          setMaterialToRemove(material);
                          setIsRemoveMaterialOpen(true);
                        }}
                      >
                        Retirer
                      </ToolbarButton>
                    )
                  : undefined
              }
            />
            <div className="mt-4 flex justify-end border-t border-base-200 pt-4">
              <div className="w-full space-y-1 sm:w-80">
                <InfoRow label="Total matières premières">
                  <MoneyText value={costs.materialCost} bold />
                </InfoRow>
              </div>
            </div>
          </>
        )}
      </SectionCard>

      {/* 5 · Équipe */}
      <SectionCard
        title="Équipe affectée"
        subtitle="Montant = jours × tarif journalier. Un journalier ponctuel est saisissable librement."
        actions={
          canUpdate && !isCancelled ? (
            <ToolbarButton variant="primary" onClick={() => setIsWorkerOpen(true)}>
              Affecter un ouvrier
            </ToolbarButton>
          ) : null
        }
      >
        {assignments.length === 0 ? (
          <EmptyState
            title="Aucune affectation"
            description="Affectez les ouvriers, apprentis ou journaliers qui ont travaillé sur ce lot : leur coût alimente le coût de revient."
            action={
              canUpdate && !isCancelled ? (
                <button
                  type="button"
                  className="btn btn-primary min-h-11"
                  onClick={() => setIsWorkerOpen(true)}
                >
                  Affecter le premier ouvrier
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ResponsiveTable
              columns={productionWorkerColumns}
              data={assignments}
              getRowKey={(assignment) => assignment.id}
              emptyMessage="Aucune affectation."
              actions={
                canUpdate && !isCancelled
                  ? (assignment) => (
                      <ToolbarButton
                        variant="error"
                        onClick={() => {
                          setWorkerToRemove(assignment);
                          setIsRemoveWorkerOpen(true);
                        }}
                      >
                        Retirer
                      </ToolbarButton>
                    )
                  : undefined
              }
            />
            <div className="mt-4 flex justify-end border-t border-base-200 pt-4">
              <div className="w-full space-y-1 sm:w-80">
                <InfoRow label="Total main-d’œuvre">
                  <MoneyText value={costs.laborCost} bold />
                </InfoRow>
              </div>
            </div>
          </>
        )}
      </SectionCard>

      {/* 6 · Coût de revient et marge potentielle */}
      <SectionCard
        title="Coût de revient détaillé"
        subtitle="Coût unitaire = coût total ÷ (production − briques cassées)."
        actions={
          canUpdate && !isCancelled ? (
            <ToolbarButton variant="outline" onClick={() => setIsBrokenOpen(true)}>
              Enregistrer une casse
            </ToolbarButton>
          ) : null
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <ProductionCostCard costs={costs} salePrice={salePrice} unit={unit} />

          <div className="space-y-3">
            <div className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/45">
                Calcul détaillé
              </p>
              <div className="mt-2 space-y-1 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base-content/60">Matières premières</span>
                  <MoneyText value={costs.materialCost} />
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base-content/60">Main-d’œuvre</span>
                  <MoneyText value={costs.laborCost} />
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-base-200 pt-1 font-semibold">
                  <span>Coût total</span>
                  <MoneyText value={costs.totalCost} bold />
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base-content/60">
                    Production ({formatQuantity(costs.producedQuantity, unit)}) − cassées (
                    {formatQuantity(costs.brokenQuantity, unit)})
                  </span>
                  <QuantityText value={costs.goodQuantity} unit={unit} />
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-base-200 pt-1">
                  <span className="text-base-content/60">
                    {formatNumber(costs.totalCost)} ÷ {formatQuantity(costs.goodQuantity)}
                  </span>
                  <MoneyText value={costs.unitCost} bold />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <MiniStat
                label="Cassées"
                tone={production.brokenQuantity > 0 ? 'warning' : 'neutral'}
                value={<QuantityText value={production.brokenQuantity} unit={unit} />}
              />
              <MiniStat
                label="Taux de casse"
                tone={production.brokenQuantity > 0 ? 'warning' : 'success'}
                value={
                  production.producedQuantity > 0
                    ? formatPercent((production.brokenQuantity / production.producedQuantity) * 100)
                    : '—'
                }
              />
            </div>

            {production.brokenQuantity > 0 ? (
              <p className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-xs text-base-content/70">
                Les {formatQuantity(production.brokenQuantity, unit)} briques cassées sont comptées
                dans <code>broken_quantity</code> et sorties du stock par un mouvement « sortie »
                motivé (« briques cassées lot {production.batchNumber} »). Il n’existe pas de type
                de mouvement « perte » : c’est un <code>exit</code> explicite.
              </p>
            ) : null}
          </div>
        </div>
      </SectionCard>

      {/* 7 · Modales */}
      <ProductionMaterialModal
        isOpen={isMaterialOpen}
        onClose={() => setIsMaterialOpen(false)}
        productionId={production.id}
        batchNumber={production.batchNumber}
        products={products}
        isOptionsLoading={isOptionsLoading}
        onAdded={refresh}
      />

      <ProductionWorkerModal
        isOpen={isWorkerOpen}
        onClose={() => setIsWorkerOpen(false)}
        productionId={production.id}
        batchNumber={production.batchNumber}
        workers={workers}
        isOptionsLoading={isOptionsLoading}
        onAdded={refresh}
      />

      <BrokenBricksModal
        isOpen={isBrokenOpen}
        onClose={() => setIsBrokenOpen(false)}
        production={production}
        onRegistered={refresh}
      />

      <RemoveMaterialDialog
        isOpen={isRemoveMaterialOpen}
        onClose={() => {
          if (!isSubmitting) setIsRemoveMaterialOpen(false);
        }}
        onConfirm={removeMaterial}
        material={materialToRemove}
        isSubmitting={isSubmitting}
      />

      <RemoveWorkerDialog
        isOpen={isRemoveWorkerOpen}
        onClose={() => {
          if (!isSubmitting) setIsRemoveWorkerOpen(false);
        }}
        onConfirm={removeWorker}
        assignment={workerToRemove}
        isSubmitting={isSubmitting}
      />

      <CancelProductionDialog
        isOpen={isCancelOpen}
        onClose={() => {
          if (!isSubmitting) setIsCancelOpen(false);
        }}
        onConfirm={cancelProduction}
        production={production}
        isSubmitting={isSubmitting}
      />
    </div>
  );
}
