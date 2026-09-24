'use client';

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
  SkeletonCards,
  SkeletonTable,
  StageTracker,
  StatusBadge,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { formatDateShort } from '@/lib/date-format';
import { formatPercent } from '@/lib/format';
import {
  JOB_STAGES,
  JobCancelDialog,
  JobCostCard,
  JobFormModal,
  JobMaterialModal,
  JobPaymentModal,
  JobRemoveMaterialDialog,
  JobRemoveWorkerDialog,
  JobWorkerModal,
  JobWorkersManagerButton,
  jobCategoryLabel,
  jobMaterialColumns,
  jobPaymentColumns,
  jobStatusLabel,
  jobWorkerColumns,
  nextJobStage,
  quoteStatusLabel,
  readApiError,
  useJobSelectOptions,
  type JobStatus,
  type ServiceJobDetail,
  type ServiceJobMaterialRow,
  type ServiceJobWorkerRow,
} from '@/components/chantiers/chantiers-modals';

/* ==================================================================
 * Fiche d'un chantier (README §19).
 *
 * Le devis et le suivi vivent dans le **même** document : cette page montre
 * donc l'avancement (`StageTracker`), les matériaux réellement sortis du
 * stock, l'équipe, les coûts calculés et les encaissements de la prestation.
 *
 * Aucune suppression : un chantier s'annule avec un motif obligatoire, et ses
 * matériaux retournent au stock.
 * ================================================================== */

type Tab = 'materials' | 'team' | 'costs' | 'payments';

const TAB_LABELS: Record<Tab, string> = {
  materials: 'Matériaux',
  team: 'Équipe',
  costs: 'Coûts et marge',
  payments: 'Paiements',
};

export default function ChantierDetailPage() {
  const params = useParams<{ id: string }>();
  const jobId = Number(params?.id);

  const canUpdate = usePermission('jobs.update');
  const canDelete = usePermission('jobs.delete');
  const canPay = usePermission('payments.create');
  const canViewPayments = usePermission('payments.view');

  const [detail, setDetail] = useState<ServiceJobDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>('materials');

  /* Un état booléen par modale (§8.3 règle 1). */
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isMaterialOpen, setIsMaterialOpen] = useState(false);
  const [isWorkerOpen, setIsWorkerOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isRemoveMaterialOpen, setIsRemoveMaterialOpen] = useState(false);
  const [isRemoveWorkerOpen, setIsRemoveWorkerOpen] = useState(false);
  const [materialToRemove, setMaterialToRemove] = useState<ServiceJobMaterialRow | null>(null);
  const [workerToRemove, setWorkerToRemove] = useState<ServiceJobWorkerRow | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isChangingStatus, setIsChangingStatus] = useState(false);

  const { customers, products, workers, isLoading: isOptionsLoading } = useJobSelectOptions(canUpdate);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!Number.isInteger(jobId) || jobId <= 0) {
        setError('Identifiant de chantier invalide.');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const response = await fetch(`/api/chantiers/${jobId}`, {
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
          throw new Error(await readApiError(response, 'Le chantier n’a pas pu être chargé.'));
        }

        const payload = (await response.json()) as ServiceJobDetail;
        setDetail(payload);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setDetail(null);
        setError(caught instanceof Error ? caught.message : 'Le chantier n’a pas pu être chargé.');
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [jobId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const job = detail?.job ?? null;
  const isCancelled = job?.status === 'cancelled';
  const nextStage = useMemo(() => (job ? nextJobStage(job.status) : null), [job]);

  /* ------------------------------------------------------------------
   * Écritures
   * ------------------------------------------------------------------ */

  const changeStatus = useCallback(
    async (status: JobStatus) => {
      if (!job) return;
      setIsChangingStatus(true);
      try {
        const response = await fetch(`/api/chantiers/${job.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ status }),
        });
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Le statut n’a pas pu être modifié.'));
        }
        toast.success(`Chantier ${job.reference} : ${jobStatusLabel(status).toLowerCase()}.`);
        refresh();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : 'Le statut n’a pas pu être modifié.');
      } finally {
        setIsChangingStatus(false);
      }
    },
    [job, refresh],
  );

  const cancelJob = useCallback(
    async (reason: string) => {
      if (!job) return;
      setIsCancelling(true);
      try {
        const response = await fetch(`/api/chantiers/${job.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ reason }),
        });
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Le chantier n’a pas pu être annulé.'));
        }
        toast.success(`Chantier ${job.reference} annulé — matériaux rendus au stock.`);
        setIsCancelOpen(false);
        refresh();
      } catch (caught) {
        toast.error(
          caught instanceof Error ? caught.message : 'Le chantier n’a pas pu être annulé.',
          { autoClose: 8000 },
        );
      } finally {
        setIsCancelling(false);
      }
    },
    [job, refresh],
  );

  const removeMaterial = useCallback(async () => {
    if (!job || !materialToRemove) return;
    setIsRemoving(true);
    try {
      const response = await fetch(
        `/api/chantiers/${job.id}/materiaux?materialId=${materialToRemove.id}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );
      if (!response.ok) {
        throw new Error(await readApiError(response, 'La ligne n’a pas pu être retirée.'));
      }
      toast.success(`${materialToRemove.productName} rendu au stock.`);
      setIsRemoveMaterialOpen(false);
      setMaterialToRemove(null);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'La ligne n’a pas pu être retirée.');
    } finally {
      setIsRemoving(false);
    }
  }, [job, materialToRemove, refresh]);

  const removeWorker = useCallback(async () => {
    if (!job || !workerToRemove) return;
    setIsRemoving(true);
    try {
      const response = await fetch(`/api/chantiers/${job.id}/ouvriers?workerId=${workerToRemove.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'L’affectation n’a pas pu être retirée.'));
      }
      toast.success('Affectation retirée.');
      setIsRemoveWorkerOpen(false);
      setWorkerToRemove(null);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'L’affectation n’a pas pu être retirée.');
    } finally {
      setIsRemoving(false);
    }
  }, [job, workerToRemove, refresh]);

  /* ------------------------------------------------------------------
   * Les 5 états : chargement, erreur, vide, nominal, feedback
   * ------------------------------------------------------------------ */

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader
          eyebrow="Production"
          title="Chantier"
          description="Chargement du chantier, de ses matériaux, de son équipe et de ses encaissements…"
        />
        <SkeletonCards count={4} />
        <SkeletonTable rows={5} cols={5} />
      </div>
    );
  }

  if (error || notFound || !detail || !job) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader
          eyebrow="Production"
          title="Chantier"
          description="Devis, matériaux, équipe, coûts et encaissements d’une prestation."
        />
        <Card>
          <ErrorState
            title={notFound ? 'Chantier introuvable' : 'Impossible de charger le chantier'}
            description={
              notFound
                ? 'Ce chantier n’existe pas ou a été retiré de ce poste.'
                : (error ?? 'Le chantier n’a pas pu être chargé.')
            }
            onRetry={notFound ? undefined : refresh}
          />
        </Card>
        <div className="flex justify-center">
          <Link href="/chantiers" className="btn btn-ghost min-h-11">
            Retour à la liste des chantiers
          </Link>
        </div>
      </div>
    );
  }

  const { materials, workers: team, payments, costs } = detail;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Production"
        title={`Chantier ${job.reference}`}
        description={`${job.customerName} · ${job.siteAddress || 'site non renseigné'}`}
        actions={
          <>
            <JobWorkersManagerButton onChanged={refresh} />
            <Link href={`/chantiers/devis/${job.id}`} className="btn btn-ghost min-h-11 border border-base-300">
              Voir le devis
            </Link>
            {canUpdate && !isCancelled && (
              <button
                type="button"
                className="btn btn-outline min-h-11"
                onClick={() => setIsEditOpen(true)}
              >
                Modifier
              </button>
            )}
            {canUpdate && !isCancelled && nextStage && (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                disabled={isChangingStatus}
                onClick={() => void changeStatus(nextStage.key)}
              >
                {isChangingStatus ? (
                  <span className="loading loading-spinner loading-sm" aria-hidden />
                ) : nextStage.key === 'in_progress' ? (
                  'Passer en cours'
                ) : nextStage.key === 'completed' ? (
                  'Terminer'
                ) : (
                  `Passer à « ${nextStage.label} »`
                )}
              </button>
            )}
            {canPay && canViewPayments && !isCancelled && job.remainingAmount > 0.001 && (
              <button
                type="button"
                className="btn btn-success min-h-11"
                onClick={() => setIsPaymentOpen(true)}
              >
                Encaisser
              </button>
            )}
            {canDelete && !isCancelled && (
              <button
                type="button"
                className="btn btn-error min-h-11"
                onClick={() => setIsCancelOpen(true)}
              >
                Annuler
              </button>
            )}
          </>
        }
      />

      {isCancelled && (
        <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm text-error">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Chantier annulé</span>
            <Badge tone="error">Annulé</Badge>
          </div>
          <p className="mt-1.5 whitespace-pre-line break-words">
            {job.notes || 'Aucun motif consigné.'}
          </p>
          <p className="mt-1 text-xs text-error/80">
            Le chantier n’est pas supprimé : il reste consultable. Ses matériaux ont été rendus au
            stock par des mouvements « entrée » motivés.
          </p>
        </div>
      )}

      {/* Avancement : `cancelled` est traité à part, jamais dans le rail. */}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Avancement</h2>
            <p className="text-xs text-base-content/55">
              Devis → en attente → en cours → terminé. Un chantier annulé sort du rail.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={job.quoteStatus === 'accepted' ? 'success' : 'info'}>
              Devis : {quoteStatusLabel(job.quoteStatus)}
            </Badge>
            <StatusBadge status={job.paymentStatus} kind="payment" />
          </div>
        </div>

        {isCancelled ? (
          <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            Avancement interrompu : ce chantier a été annulé.
          </div>
        ) : (
          <StageTracker stages={JOB_STAGES} current={job.status} />
        )}
      </Card>

      {/* En-tête de la fiche */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-1 lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold">Informations du chantier</h2>
          <div className="grid gap-x-6 sm:grid-cols-2">
            <InfoRow label="Client">{job.customerName}</InfoRow>
            <InfoRow label="Téléphone">
              <span className="tabular">{job.customerPhone || '—'}</span>
            </InfoRow>
            <InfoRow label="Catégorie">
              <Badge tone="primary">{jobCategoryLabel(job.category)}</Badge>
            </InfoRow>
            <InfoRow label="Site">{job.siteAddress || '—'}</InfoRow>
            <InfoRow label="Date de début">
              <span className="tabular">{formatDateShort(job.startDate)}</span>
            </InfoRow>
            <InfoRow label="Date de fin">
              <span className="tabular">{formatDateShort(job.endDate)}</span>
            </InfoRow>
          </div>
          {job.description && (
            <p className="mt-3 whitespace-pre-line rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm">
              {job.description}
            </p>
          )}
        </Card>

        <Card className="space-y-3">
          <h2 className="text-sm font-semibold">Facturation</h2>
          <div className="grid grid-cols-2 gap-3">
            <MiniStat label="Total" value={<MoneyText value={job.total} />} />
            <MiniStat label="Payé" tone="success" value={<MoneyText value={job.amountPaid} />} />
          </div>
          <MiniStat
            label="Reste à payer"
            tone={job.remainingAmount > 0.001 ? 'error' : 'success'}
            value={<MoneyText value={job.remainingAmount} colored bold />}
          />
          <p className="text-xs text-base-content/50">
            Document facturable autonome : ses encaissements lui appartiennent et ne génèrent aucune
            facture de vente — le chiffre d’affaires n’est jamais compté deux fois.
          </p>
        </Card>
      </div>

      {/* Sections */}
      <div role="tablist" aria-label="Sections du chantier" className="tabs tabs-boxed w-full sm:w-auto">
        {(Object.keys(TAB_LABELS) as Tab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`tab min-h-11 ${activeTab === tab ? 'tab-active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {activeTab === 'materials' && (
        <PageSection
          title="Matériaux"
          subtitle="Chaque ligne a déduit le stock par un mouvement « sortie » motivé."
          actions={
            canUpdate && !isCancelled ? (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => setIsMaterialOpen(true)}
              >
                Ajouter un matériau
              </button>
            ) : null
          }
        >
          {materials.length === 0 ? (
            <Card>
              <EmptyState
                title="Aucun matériau"
                description="Aucune matière n’a encore été sortie du stock pour ce chantier."
                action={
                  canUpdate && !isCancelled ? (
                    <button
                      type="button"
                      className="btn btn-primary min-h-11"
                      onClick={() => setIsMaterialOpen(true)}
                    >
                      Ajouter le premier matériau
                    </button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <ResponsiveTable
              columns={jobMaterialColumns}
              data={materials}
              getRowKey={(material) => material.id}
              emptyMessage="Aucun matériau."
              actions={
                canUpdate && !isCancelled
                  ? (material) => (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm min-h-11 text-error"
                        onClick={() => {
                          setMaterialToRemove(material);
                          setIsRemoveMaterialOpen(true);
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
      )}

      {activeTab === 'team' && (
        <PageSection
          title="Équipe"
          subtitle="Main-d’œuvre : jours × tarif journalier. Un journalier ponctuel peut être saisi à la volée."
          actions={
            canUpdate && !isCancelled ? (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => setIsWorkerOpen(true)}
              >
                Affecter un ouvrier
              </button>
            ) : null
          }
        >
          {team.length === 0 ? (
            <Card>
              <EmptyState
                title="Aucun ouvrier affecté"
                description="Affectez un chef d’équipe, un ouvrier ou un apprenti pour calculer la main-d’œuvre."
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
            </Card>
          ) : (
            <ResponsiveTable
              columns={jobWorkerColumns}
              data={team}
              getRowKey={(assignment) => assignment.id}
              emptyMessage="Aucune affectation."
              actions={
                canUpdate && !isCancelled
                  ? (assignment) => (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm min-h-11 text-error"
                        onClick={() => {
                          setWorkerToRemove(assignment);
                          setIsRemoveWorkerOpen(true);
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
      )}

      {activeTab === 'costs' && (
        <PageSection
          title="Coûts et marge"
          subtitle="Calculés à la lecture : matériaux au prix d’achat + main-d’œuvre."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <JobCostCard costs={costs} total={job.total} />
            </Card>
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold">Devis</h3>
              <InfoRow label="Devis matériaux">
                <MoneyText value={job.quoteMaterials} />
              </InfoRow>
              <InfoRow label="Devis main-d’œuvre">
                <MoneyText value={job.quoteLabor} />
              </InfoRow>
              <InfoRow label="Total du devis">
                <MoneyText value={job.quoteTotal} bold />
              </InfoRow>
              <InfoRow label="Statut du devis">
                <Badge tone={job.quoteStatus === 'accepted' ? 'success' : 'info'}>
                  {quoteStatusLabel(job.quoteStatus)}
                </Badge>
              </InfoRow>
              <InfoRow label="Marge">
                <span className="tabular">
                  {formatPercent(costs.billed > 0 ? costs.marginPercent : 0)}
                </span>
              </InfoRow>
            </Card>
          </div>
        </PageSection>
      )}

      {activeTab === 'payments' && (
        <PageSection
          title="Paiements"
          subtitle="Un reçu numéroté est émis pour chaque encaissement ; le reste à payer est recalculé."
          actions={
            canPay && !isCancelled && job.remainingAmount > 0.001 ? (
              <button
                type="button"
                className="btn btn-success min-h-11"
                onClick={() => setIsPaymentOpen(true)}
              >
                Encaisser
              </button>
            ) : null
          }
        >
          {!canViewPayments ? (
            <Card>
              <EmptyState
                title="Paiements non consultables"
                description="Votre rôle ne permet pas de consulter les encaissements."
              />
            </Card>
          ) : payments.length === 0 ? (
            <Card>
              <EmptyState
                title="Aucun encaissement"
                description={
                  isCancelled
                    ? 'Ce chantier est annulé : aucun encaissement ne peut plus être enregistré.'
                    : 'Aucun règlement n’a encore été enregistré sur cette prestation.'
                }
                action={
                  canPay && !isCancelled ? (
                    <button
                      type="button"
                      className="btn btn-primary min-h-11"
                      onClick={() => setIsPaymentOpen(true)}
                    >
                      Enregistrer un encaissement
                    </button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <ResponsiveTable
              columns={jobPaymentColumns}
              data={payments}
              getRowKey={(payment) => payment.id}
              emptyMessage="Aucun encaissement."
            />
          )}
        </PageSection>
      )}

      {/* Modales */}
      <JobFormModal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        onSaved={() => {
          toast.success('Chantier modifié.');
          refresh();
        }}
        job={job}
        customers={customers}
        isOptionsLoading={isOptionsLoading}
      />

      <JobMaterialModal
        isOpen={isMaterialOpen}
        onClose={() => setIsMaterialOpen(false)}
        jobId={job.id}
        jobReference={job.reference}
        products={products}
        isOptionsLoading={isOptionsLoading}
        onAdded={refresh}
      />

      <JobWorkerModal
        isOpen={isWorkerOpen}
        onClose={() => setIsWorkerOpen(false)}
        jobId={job.id}
        jobReference={job.reference}
        workers={workers}
        isOptionsLoading={isOptionsLoading}
        onAdded={refresh}
      />

      <JobPaymentModal
        isOpen={isPaymentOpen}
        onClose={() => setIsPaymentOpen(false)}
        job={job}
        remainingAmount={job.remainingAmount}
        onRecorded={() => refresh()}
      />

      <JobCancelDialog
        isOpen={isCancelOpen}
        onClose={() => {
          if (!isCancelling) setIsCancelOpen(false);
        }}
        onConfirm={cancelJob}
        job={job}
        isSubmitting={isCancelling}
      />

      <JobRemoveMaterialDialog
        isOpen={isRemoveMaterialOpen}
        onClose={() => {
          if (!isRemoving) setIsRemoveMaterialOpen(false);
        }}
        onConfirm={removeMaterial}
        material={materialToRemove}
        isSubmitting={isRemoving}
      />

      <JobRemoveWorkerDialog
        isOpen={isRemoveWorkerOpen}
        onClose={() => {
          if (!isRemoving) setIsRemoveWorkerOpen(false);
        }}
        onConfirm={removeWorker}
        assignment={workerToRemove}
        isSubmitting={isRemoving}
      />
    </div>
  );
}
