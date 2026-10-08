'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ResponsiveTable } from '@/components/responsive-table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SectionTabs } from '@/components/section-tabs';
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
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { formatDateShort } from '@/lib/date-format';
import { formatQuantity } from '@/lib/format';
import {
  JOB_STAGES,
  JobCancelDialog,
  JobCostCard,
  JobFormModal,
  JobMaterialModal,
  JobPaymentModal,
  JobRemoveMaterialDialog,
  JobRemoveWorkerDialog,
  JobStatusBadges,
  jobNeedsPrice,
  JobWorkerModal,
  STAGE_STATUS_LABELS,
  STAGE_STATUS_TONES,
  jobCategoryLabel,
  jobMaterialColumns,
  jobPaymentColumns,
  jobStatusLabel,
  jobWorkerColumns,
  nextJobStage,
  readApiError,
  useJobSelectOptions,
  type JobStageRow,
  type JobStatus,
  type JobSubcontractRow,
  type ServiceJobDetail,
  type ServiceJobItemRow,
  type ServiceJobMaterialRow,
  type ServiceJobWorkerRow,
} from '@/components/chantiers/chantiers-modals';
import { JobExpenseModal, JobItemModal, StageModal, SubcontractModal, TeamModal } from '@/components/chantiers/job-panels';
import { HistoryTimeline, ProgressBar } from '@/components/prestations/shared';

/* ==================================================================
 * Fiche d'un chantier (cahier « Prestations » §24, README §19).
 *
 * En tête : référence, client, magasin, statut, avancement, montant, payé,
 * reste, coûts et bénéfice estimatif. Puis les onglets du cahier.
 *
 * Le montant facturé vient des **prestations** ; matériaux, équipe,
 * sous-traitance et dépenses sont des **coûts**. La rentabilité n'est
 * renvoyée par le serveur qu'à qui détient `balances.view`.
 * ================================================================== */

type Tab = 'dashboard' | 'overview' | 'items' | 'progress' | 'team' | 'materials' | 'subcontracts' | 'expenses' | 'payments' | 'documents' | 'history';

const TABS: { key: Tab; label: string }[] = [
  { key: 'dashboard', label: 'Tableau de bord' },
  { key: 'overview', label: 'Vue générale' },
  { key: 'items', label: 'Prestations' },
  { key: 'progress', label: 'Avancement' },
  { key: 'team', label: 'Équipe' },
  { key: 'materials', label: 'Matériaux' },
  { key: 'subcontracts', label: 'Sous-traitance' },
  { key: 'expenses', label: 'Dépenses' },
  { key: 'payments', label: 'Paiements' },
  { key: 'documents', label: 'Documents' },
  { key: 'history', label: 'Notes et historique' },
];

const EXPENSE_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'info' | 'error' }> = {
  approved: { label: 'Décaissée', tone: 'success' },
  to_pay: { label: 'À décaisser', tone: 'info' },
  pending: { label: 'En attente', tone: 'warning' },
  rejected: { label: 'Rejetée', tone: 'error' },
};

export default function ChantierDetailPage() {
  const params = useParams<{ id: string }>();
  const jobId = Number(params?.id);
  const { activeStoreId } = useAuth();

  const canUpdate = usePermission('jobs.update');
  const canDelete = usePermission('jobs.delete');
  const canPay = usePermission('payments.create');
  const canViewPayments = usePermission('payments.view');
  const canExpense = usePermission('expenses.create');

  const [detail, setDetail] = useState<ServiceJobDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [tab, setTab] = useState<Tab>('dashboard');

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isMaterialOpen, setIsMaterialOpen] = useState(false);
  const [isWorkerOpen, setIsWorkerOpen] = useState(false);
  const [isTeamOpen, setIsTeamOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [itemModal, setItemModal] = useState<{ open: boolean; item: ServiceJobItemRow | null }>({ open: false, item: null });
  const [itemToRemove, setItemToRemove] = useState<ServiceJobItemRow | null>(null);
  const [stageModal, setStageModal] = useState<{ open: boolean; stage: JobStageRow | null }>({ open: false, stage: null });
  const [stageToRemove, setStageToRemove] = useState<JobStageRow | null>(null);
  const [subModal, setSubModal] = useState<{ open: boolean; sub: JobSubcontractRow | null }>({ open: false, sub: null });
  const [subToCancel, setSubToCancel] = useState<JobSubcontractRow | null>(null);
  const [expenseModal, setExpenseModal] = useState<{ open: boolean; sub: JobSubcontractRow | null }>({ open: false, sub: null });
  const [materialToRemove, setMaterialToRemove] = useState<ServiceJobMaterialRow | null>(null);
  const [workerToRemove, setWorkerToRemove] = useState<ServiceJobWorkerRow | null>(null);
  const [isWorking, setIsWorking] = useState(false);

  const { products, workers, isLoading: isOptionsLoading } = useJobSelectOptions(canUpdate);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!Number.isInteger(jobId) || jobId <= 0) {
        setError('Identifiant de chantier invalide.');
        setIsLoading(false);
        return;
      }
      setError(null);
      try {
        const response = await fetch(`/api/chantiers/${jobId}`, { cache: 'no-store', credentials: 'same-origin', signal });
        setHttpStatus(response.status);
        if (!response.ok) throw new Error(await readApiError(response, 'Le chantier n’a pas pu être chargé.'));
        setDetail((await response.json()) as ServiceJobDetail);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
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

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  const job = detail?.job ?? null;
  const own = job?.storeId === activeStoreId;
  const editable = Boolean(job) && own && canUpdate && job!.status !== 'cancelled';
  const nextStage = useMemo(() => (job ? nextJobStage(job.status) : null), [job]);
  const jobServices = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of detail?.items ?? []) if (item.serviceId) map.set(item.serviceId, item.serviceName);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [detail]);

  async function call(url: string, method: string, body: unknown, success: string, fallback: string) {
    setIsWorking(true);
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readApiError(response, fallback));
      toast.success(success);
      refresh();
      return true;
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : fallback, { autoClose: 8000 });
      return false;
    } finally {
      setIsWorking(false);
    }
  }

  const changeStatus = (status: JobStatus) =>
    call(`/api/chantiers/${jobId}`, 'PUT', { status }, `Chantier : ${jobStatusLabel(status).toLowerCase()}.`, 'Le statut n’a pas pu être changé.');

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Chantiers" title="Chantier" description="Chargement du chantier…" />
        <SkeletonCards count={4} />
        <SkeletonTable rows={5} cols={5} />
      </div>
    );
  }

  if (error || !detail || !job) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Chantiers" title="Chantier" description="Fiche d’un chantier." />
        <Card>
          <ErrorState
            title={httpStatus === 404 ? 'Chantier introuvable' : httpStatus === 403 ? 'Chantier d’un autre magasin' : 'Impossible de charger le chantier'}
            description={error ?? 'Le chantier n’a pas pu être chargé.'}
            onRetry={httpStatus === 404 || httpStatus === 403 ? undefined : refresh}
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

  const { items, materials, workers: team, stages, subcontracts, expenses, payments, costs } = detail;
  const isCancelled = job.status === 'cancelled';
  const remainingPayable = !isCancelled && job.remainingAmount > 0.001;
  // Chantier ouvert sans prix : planifier, démarrer et facturer attendent un montant.
  const needsPrice = jobNeedsPrice(job);
  const directExpenses = expenses.filter((e) => e.referenceType === 'service_job');
  // Carte « Dépenses » : même règle que le coût (`computeJobCosts`, lib/jobs.ts) —
  // dépenses directes, comptées dès qu'elles sont validées (décaissées ou à décaisser).
  const expenseSummary = directExpenses.reduce(
    (acc, e) => {
      acc.count += 1;
      if (e.approvalStatus === 'approved' || e.approvalStatus === 'to_pay') acc.validated += e.amount;
      else if (e.approvalStatus === 'pending') acc.pending += 1;
      return acc;
    },
    { count: 0, validated: 0, pending: 0 },
  );
  // Compteurs des onglets : on voit ce que contient chaque rubrique avant de l'ouvrir.
  const tabCounts: Partial<Record<Tab, number>> = {
    items: items.length,
    progress: stages.length,
    team: team.length,
    materials: materials.length,
    subcontracts: subcontracts.length,
    expenses: expenses.length,
    payments: payments.length,
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Chantiers"
        title={`Chantier ${job.reference}`}
        description={`${job.title ? `${job.title} · ` : ''}${job.customerName}${job.storeName ? ` · ${job.storeName}` : ''}`}
        actions={
          <>
            {!needsPrice && (
              <Link href={`/chantiers/${job.id}/document`} className="btn btn-ghost min-h-11 border border-base-300">
                Facture
              </Link>
            )}
            {editable && (
              <button type="button" className="btn btn-outline min-h-11" onClick={() => setIsEditOpen(true)}>
                Modifier
              </button>
            )}
            {editable && job.status === 'suspended' && (
              <button type="button" className="btn btn-primary min-h-11" disabled={isWorking} onClick={() => void changeStatus('in_progress')}>
                Reprendre
              </button>
            )}
            {editable && job.status !== 'suspended' && nextStage && !needsPrice && (
              <button type="button" className="btn btn-primary min-h-11" disabled={isWorking} onClick={() => void changeStatus(nextStage.key)}>
                {nextStage.key === 'in_progress' ? 'Démarrer' : nextStage.key === 'completed' ? 'Terminer' : 'Planifier'}
              </button>
            )}
            {canPay && canViewPayments && own && remainingPayable && (
              <button type="button" className="btn btn-success min-h-11" onClick={() => setIsPaymentOpen(true)}>
                Encaisser
              </button>
            )}
          </>
        }
      />

      {/* Onglets juste sous l'en-tête : sous les cartes chiffrées, on ne
          voyait pas que la fiche se pilote par rubriques. */}
      <SectionTabs
        label="Rubriques du chantier"
        value={tab}
        onChange={setTab}
        tabs={TABS.map((entry) => ({ ...entry, count: tabCounts[entry.key] }))}
      />

      {needsPrice && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <span>
            <strong>Montant à définir :</strong> ce chantier n’a encore ni prestation ni montant forfaitaire. Il reste « En
            préparation » : ajoutez un prix pour pouvoir le planifier, le démarrer, l’encaisser et éditer sa facture.
          </span>
          {editable && (
            <button type="button" className="btn btn-warning min-h-11" onClick={() => setTab('items')}>
              Ajouter une prestation
            </button>
          )}
        </div>
      )}
      {isCancelled && (
        <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm text-error">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Chantier annulé</span>
            <Badge tone="error">Annulé</Badge>
          </div>
          <p className="mt-1.5 whitespace-pre-line wrap-break-word">{job.notes || 'Aucun motif consigné.'}</p>
          <p className="mt-1 text-xs text-error/80">Il reste consultable ; ses matériaux ont été rendus au stock.</p>
        </div>
      )}
      {job.isLate && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-error/30 bg-error/10 px-4 py-3 text-sm">
          <span>
            <strong className="text-error">En retard :</strong> la fin était prévue le {formatDateShort(job.endDate)} et le chantier n’est pas
            terminé. Mettez à jour la date prévue ou l’avancement.
          </span>
        </div>
      )}
      {!own && (
        <p className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
          Chantier du magasin <strong>{job.storeName}</strong> : consultation seule. Il se modifie depuis ce magasin.
        </p>
      )}

      {/* Onglet « Tableau de bord » : chiffres du chantier (cahier §24) et étapes. */}
      {tab === 'dashboard' && (
        <>
          <div className={`grid gap-4 sm:grid-cols-2 ${costs ? 'lg:grid-cols-3 2xl:grid-cols-6' : 'lg:grid-cols-4'}`}>
            <StatCardDelta
              label="Montant"
              tooltip="Ce que le client paie : la somme des prestations du chantier (ou le montant forfaitaire d’un chantier sans prestation)."
              tone="primary"
              value={<MoneyText value={job.total} />}
              hint={`${job.itemsCount} prestation${job.itemsCount > 1 ? 's' : ''}`}
            />
            <StatCardDelta
              label="Payé"
              tooltip="Acomptes et paiements déjà reçus du client pour ce chantier."
              tone="success"
              value={<MoneyText value={job.amountPaid} />}
              hint={`${payments.length} reçu${payments.length > 1 ? 's' : ''}`}
            />
            <StatCardDelta
              label="Reste à payer"
              tooltip="Ce que le client doit encore : montant du chantier moins ce qu’il a payé."
              tone={remainingPayable ? 'error' : 'neutral'}
              value={<MoneyText value={job.remainingAmount} remaining={!isCancelled} bold />}
              hint={isCancelled ? 'Chantier annulé' : needsPrice ? 'Montant à définir' : remainingPayable ? 'À encaisser' : 'Soldé'}
            />
            <StatCardDelta
              label="Dépenses"
              tooltip="Dépenses directes du chantier déjà validées (décaissées ou à décaisser) : transport, location, fournitures hors stock… Les paiements des sous-traitants n’y sont pas : ils comptent dans « Sous-traitance ». Le détail est dans l’onglet Dépenses."
              tone="info"
              value={<MoneyText value={expenseSummary.validated} />}
              hint={
                expenseSummary.pending > 0
                  ? `${expenseSummary.count} dépense${expenseSummary.count > 1 ? 's' : ''} · ${expenseSummary.pending} en attente`
                  : `${expenseSummary.count} dépense${expenseSummary.count > 1 ? 's' : ''}`
              }
            />
            {costs && (
              <>
                <StatCardDelta
                  label="Coûts engagés"
                  tooltip="Matériaux sortis du stock (prix d’achat) + main-d’œuvre de l’équipe + montants convenus avec les sous-traitants + autres dépenses validées."
                  tone="warning"
                  value={<MoneyText value={costs.totalCost} />}
                  hint="Matériaux, équipe, sous-traitance, dépenses"
                />
                <StatCardDelta
                  label="Bénéfice estimatif"
                  tooltip="Montant du chantier moins les coûts engagés. Estimatif : il évolue tant que le chantier n’est pas terminé."
                  tone={costs.margin >= 0 ? 'success' : 'error'}
                  value={<MoneyText value={costs.margin} colored />}
                  hint={costs.billed > 0 ? `Marge ${costs.marginPercent.toLocaleString('fr-FR')} %` : undefined}
                />
              </>
            )}
          </div>
    
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <JobStatusBadges job={job} />
                {job.responsibleName && <span className="text-sm text-base-content/60">Responsable : {job.responsibleName}</span>}
              </div>
              <ProgressBar value={job.progress} late={job.isLate} className="w-full sm:w-72" />
            </div>
            {!isCancelled && job.status !== 'suspended' && <StageTracker stages={JOB_STAGES} current={job.status === 'quote' ? 'pending' : job.status} />}
            {job.status === 'suspended' && (
              <p className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm">Chantier suspendu — « Reprendre » le remet en cours.</p>
            )}
          </Card>
        </>
      )}

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="space-y-1 lg:col-span-2">
            <h2 className="mb-2 text-sm font-semibold">Informations du chantier</h2>
            <div className="grid gap-x-6 sm:grid-cols-2">
              <InfoRow label="Client">{job.customerName}</InfoRow>
              <InfoRow label="Téléphone">
                <span className="tabular">{job.customerPhone || '—'}</span>
              </InfoRow>
              <InfoRow label="Type">
                <Badge tone="primary">{jobCategoryLabel(job.category)}</Badge>
              </InfoRow>
              <InfoRow label="Adresse">{job.siteAddress || '—'}</InfoRow>
              <InfoRow label="Début prévu">{formatDateShort(job.startDate)}</InfoRow>
              <InfoRow label="Fin prévue">{formatDateShort(job.endDate)}</InfoRow>
              <InfoRow label="Début réel">{formatDateShort(job.actualStartDate)}</InfoRow>
              <InfoRow label="Fin réelle">{formatDateShort(job.actualEndDate)}</InfoRow>
              <InfoRow label="Responsable">{job.responsibleName ?? '—'}</InfoRow>
              <InfoRow label="Magasin">{job.storeName ?? '—'}</InfoRow>
              <InfoRow label="Devis d’origine">
                {job.quoteId ? (
                  <Link href={`/chantiers/devis/${job.quoteId}`} className="link">
                    {job.quoteReference}
                  </Link>
                ) : (
                  '—'
                )}
              </InfoRow>
              <InfoRow label="Demande">
                {job.requestId ? (
                  <Link href={`/chantiers/demandes/${job.requestId}`} className="link">
                    {job.requestReference}
                  </Link>
                ) : (
                  '—'
                )}
              </InfoRow>
            </div>
            {job.description && (
              <p className="mt-3 whitespace-pre-line rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm">{job.description}</p>
            )}
          </Card>
          <Card className="space-y-2">
            <h2 className="text-sm font-semibold">Rentabilité</h2>
            {costs ? (
              <JobCostCard costs={costs} />
            ) : (
              <p className="text-sm text-base-content/60">La rentabilité est réservée aux personnes habilitées à voir les marges.</p>
            )}
          </Card>
        </div>
      )}

      {tab === 'items' && (
        <PageSection
          title="Prestations facturées"
          subtitle="Elles font le montant du chantier. Prix figés : modifier le catalogue ne les change pas."
          actions={
            editable ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setItemModal({ open: true, item: null })}>
                Ajouter une prestation
              </button>
            ) : null
          }
        >
          {items.length === 0 ? (
            <Card>
              <EmptyState
                title="Aucune prestation"
                description={
                  job.total > 0
                    ? `Chantier à montant forfaitaire (${new Intl.NumberFormat('fr-FR').format(job.total)} GNF). Ajouter une prestation remplacera ce montant par la somme des lignes.`
                    : 'Ajoutez les prestations du catalogue réalisées sur ce chantier.'
                }
              />
            </Card>
          ) : (
            <ResponsiveTable
              columns={[
                {
                  key: 'name',
                  label: 'Prestation',
                  primary: true,
                  render: (item) => (
                    <div className="min-w-0">
                      {item.serviceId ? (
                        <Link href={`/prestations/${item.serviceId}`} className="font-medium hover:underline">
                          {item.serviceName}
                        </Link>
                      ) : (
                        <span className="font-medium">{item.serviceName}</span>
                      )}
                      {item.serviceCode && <span className="block text-xs text-base-content/50">{item.serviceCode}</span>}
                    </div>
                  ),
                },
                { key: 'qty', label: 'Quantité', render: (item) => <span className="tabular">{formatQuantity(item.quantity, item.unit)}</span> },
                {
                  key: 'price',
                  label: 'Prix unitaire',
                  hideOnMobile: true,
                  className: 'text-right whitespace-nowrap',
                  render: (item) => (
                    <span className="block">
                      <MoneyText value={item.unitPrice} />
                      {item.discountPercent > 0 && <span className="block text-xs text-success">− {item.discountPercent.toLocaleString('fr-FR')} %</span>}
                    </span>
                  ),
                },
                { key: 'amount', label: 'Montant', className: 'text-right whitespace-nowrap', render: (item) => <MoneyText value={item.amount} bold /> },
              ]}
              data={items}
              getRowKey={(item) => item.id}
              actions={
                editable
                  ? (item) => (
                      <div className="flex justify-end gap-1">
                        <button type="button" className="btn btn-ghost btn-sm min-h-11" onClick={() => setItemModal({ open: true, item })}>
                          Modifier
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm min-h-11 text-error" onClick={() => setItemToRemove(item)}>
                          Retirer
                        </button>
                      </div>
                    )
                  : undefined
              }
            />
          )}
          <div className="flex justify-end">
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm">
              Montant du chantier : <MoneyText value={job.total} bold className="text-base" />
            </div>
          </div>
        </PageSection>
      )}

      {tab === 'progress' && (
        <PageSection
          title="Étapes et avancement"
          subtitle="L’avancement du chantier est la moyenne de ses étapes. Une étape à 100 % est terminée."
          actions={
            editable ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setStageModal({ open: true, stage: null })}>
                Ajouter une étape
              </button>
            ) : null
          }
        >
          {stages.length === 0 ? (
            <Card>
              <EmptyState
                title="Aucune étape"
                description="Découpez le chantier (terrassement, fondation, élévation, finitions…) pour suivre son avancement réel."
              />
            </Card>
          ) : (
            <ol className="space-y-3">
              {stages.map((stage, index) => (
                <li key={stage.id}>
                  <Card className="space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold">
                          <span className="mr-2 text-base-content/40 tabular">{index + 1}.</span>
                          {stage.name}
                        </p>
                        <p className="text-xs text-base-content/60">
                          {[
                            stage.serviceName,
                            stage.responsible && `Responsable : ${stage.responsible}`,
                            stage.plannedDate && `prévue le ${formatDateShort(stage.plannedDate)}`,
                            stage.actualDate && `réalisée le ${formatDateShort(stage.actualDate)}`,
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'Sans précision'}
                        </p>
                      </div>
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge tone={STAGE_STATUS_TONES[stage.status]}>{STAGE_STATUS_LABELS[stage.status]}</Badge>
                        {stage.isLate && <Badge tone="error">En retard</Badge>}
                      </span>
                    </div>
                    <ProgressBar value={stage.progress} late={stage.isLate} />
                    {stage.comment && <p className="text-sm text-base-content/70">{stage.comment}</p>}
                    {editable && (
                      <div className="flex flex-wrap justify-end gap-1">
                        <button type="button" className="btn btn-ghost btn-sm min-h-11" onClick={() => setStageModal({ open: true, stage })}>
                          Mettre à jour
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm min-h-11 text-error" onClick={() => setStageToRemove(stage)}>
                          Retirer
                        </button>
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ol>
          )}
        </PageSection>
      )}

      {tab === 'team' && (
        <PageSection
          title="Équipe"
          subtitle="Main-d’œuvre : jours × tarif journalier. C’est un coût du chantier, pas un montant facturé."
          actions={
            editable ? (
              <>
                <button type="button" className="btn btn-ghost min-h-11 border border-base-300" onClick={() => setIsTeamOpen(true)}>
                  Affecter une équipe
                </button>
                <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsWorkerOpen(true)}>
                  Affecter un ouvrier
                </button>
              </>
            ) : null
          }
        >
          {team.length === 0 ? (
            <Card>
              <EmptyState title="Aucun ouvrier affecté" description="Affectez une équipe entière ou un ouvrier, avec son nombre de jours." />
            </Card>
          ) : (
            <ResponsiveTable
              columns={jobWorkerColumns}
              data={team}
              getRowKey={(assignment) => assignment.id}
              actions={
                editable
                  ? (assignment) => (
                      <button type="button" className="btn btn-ghost btn-sm min-h-11 text-error" onClick={() => setWorkerToRemove(assignment)}>
                        Retirer
                      </button>
                    )
                  : undefined
              }
            />
          )}
        </PageSection>
      )}

      {tab === 'materials' && (
        <PageSection
          title="Matériaux"
          subtitle="Sortis du stock du magasin au prix d’achat : un coût du chantier."
          actions={
            editable ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsMaterialOpen(true)}>
                Sortir un matériau
              </button>
            ) : null
          }
        >
          {materials.length === 0 ? (
            <Card>
              <EmptyState title="Aucun matériau" description="Aucune matière n’a encore été sortie du stock pour ce chantier." />
            </Card>
          ) : (
            <ResponsiveTable
              columns={jobMaterialColumns}
              data={materials}
              getRowKey={(material) => material.id}
              actions={
                editable
                  ? (material) => (
                      <button type="button" className="btn btn-ghost btn-sm min-h-11 text-error" onClick={() => setMaterialToRemove(material)}>
                        Rendre au stock
                      </button>
                    )
                  : undefined
              }
            />
          )}
        </PageSection>
      )}

      {tab === 'subcontracts' && (
        <PageSection
          title="Sous-traitance"
          subtitle="Travaux confiés : montant convenu, payé par des dépenses rattachées, et reste dû."
          actions={
            editable ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setSubModal({ open: true, sub: null })}>
                Confier des travaux
              </button>
            ) : null
          }
        >
          {subcontracts.length === 0 ? (
            <Card>
              <EmptyState title="Aucune sous-traitance" description="Confiez une partie des travaux à un sous-traitant (électricien, plombier…)." />
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {subcontracts.map((sub) => (
                <Card key={sub.id} className={`space-y-3 ${sub.status === 'cancelled' ? 'opacity-70' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{sub.supplierName}</p>
                      <p className="text-sm text-base-content/65">{sub.work}</p>
                    </div>
                    {sub.status === 'cancelled' ? <Badge tone="error">Annulé</Badge> : sub.remaining <= 0.5 ? <Badge tone="success">Soldé</Badge> : <Badge tone="warning">Reste dû</Badge>}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-sm">
                    <div className="rounded-xl bg-base-200/50 p-2">
                      <span className="block text-xs text-base-content/60">Convenu</span>
                      <MoneyText value={sub.agreedAmount} bold />
                    </div>
                    <div className="rounded-xl bg-base-200/50 p-2">
                      <span className="block text-xs text-base-content/60">Payé</span>
                      <MoneyText value={sub.paid} />
                    </div>
                    <div className="rounded-xl bg-base-200/50 p-2">
                      <span className="block text-xs text-base-content/60">Reste</span>
                      <MoneyText value={sub.remaining} remaining={sub.status === 'active'} bold />
                    </div>
                  </div>
                  {sub.pending > 0 && <p className="text-xs text-warning">Paiement en attente d’approbation : {new Intl.NumberFormat('fr-FR').format(sub.pending)} GNF</p>}
                  {sub.notes && <p className="text-xs text-base-content/60">{sub.notes}</p>}
                  {editable && sub.status === 'active' && (
                    <div className="flex flex-wrap justify-end gap-1">
                      {canExpense && sub.remaining - sub.pending > 0.5 && (
                        <button type="button" className="btn btn-success btn-sm min-h-11" onClick={() => setExpenseModal({ open: true, sub })}>
                          Payer
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm min-h-11" onClick={() => setSubModal({ open: true, sub })}>
                        Modifier
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm min-h-11 text-error" onClick={() => setSubToCancel(sub)}>
                        Annuler
                      </button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </PageSection>
      )}

      {tab === 'expenses' && (
        <PageSection
          title="Dépenses du chantier"
          subtitle="Transport, location, fournitures hors stock, paiements des sous-traitants… Elles passent par la caisse et l’approbation."
          actions={
            editable && canExpense ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setExpenseModal({ open: true, sub: null })}>
                Ajouter une dépense
              </button>
            ) : null
          }
        >
          {expenses.length === 0 ? (
            <Card>
              <EmptyState title="Aucune dépense" description="Aucune dépense n’est encore rattachée à ce chantier." />
            </Card>
          ) : (
            <ResponsiveTable
              columns={[
                { key: 'date', label: 'Date', render: (e) => <span className="tabular text-base-content/70">{formatDateShort(e.date)}</span> },
                {
                  key: 'label',
                  label: 'Dépense',
                  primary: true,
                  render: (e) => (
                    <div className="min-w-0">
                      <span className="font-medium">{e.description || e.category}</span>
                      <span className="block text-xs text-base-content/55">
                        {e.category}
                        {e.beneficiary ? ` · ${e.beneficiary}` : ''}
                        {e.referenceType === 'job_subcontract' ? ' · sous-traitance' : ''}
                      </span>
                    </div>
                  ),
                },
                {
                  key: 'status',
                  label: 'État',
                  render: (e) => <Badge tone={EXPENSE_STATUS[e.approvalStatus]?.tone ?? 'neutral'}>{EXPENSE_STATUS[e.approvalStatus]?.label ?? e.approvalStatus}</Badge>,
                },
                { key: 'amount', label: 'Montant', className: 'text-right whitespace-nowrap', render: (e) => <MoneyText value={e.amount} bold /> },
              ]}
              data={expenses}
              getRowKey={(e) => e.id}
            />
          )}
          <p className="text-xs text-base-content/55">
            {directExpenses.length} dépense(s) directe(s). Les paiements aux sous-traitants figurent ici pour mémoire : dans la
            rentabilité, c’est le montant convenu qui compte.
          </p>
        </PageSection>
      )}

      {tab === 'payments' && (
        <PageSection
          title="Paiements du client"
          subtitle="Un reçu numéroté est émis pour chaque encaissement ; le reste à payer est recalculé."
          actions={
            // Toujours visible (sauf annulé ou autre magasin) : grisé avec sa raison
            // plutôt que masqué, on ne cherche pas le bouton.
            canPay && own && !isCancelled ? (
              <button
                type="button"
                className="btn btn-success min-h-11"
                disabled={!remainingPayable}
                onClick={() => setIsPaymentOpen(true)}
              >
                Encaisser
              </button>
            ) : null
          }
        >
          {canViewPayments && (
            <div className="mb-4 space-y-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <MiniStat label="Montant du chantier" tone="primary" value={needsPrice ? 'À définir' : <MoneyText value={job.total} />} />
                <MiniStat label="Déjà payé" tone="success" value={<MoneyText value={job.amountPaid} />} />
                <MiniStat
                  label="Reste à payer"
                  tone={remainingPayable ? 'error' : 'neutral'}
                  value={<MoneyText value={Math.max(job.remainingAmount, 0)} />}
                />
              </div>
              {canPay && own && !isCancelled && !remainingPayable && (
                <p className="text-xs text-base-content/60">
                  {needsPrice
                    ? 'Encaissement impossible pour l’instant : montant à définir. Ajoutez une prestation ou un montant forfaitaire.'
                    : 'Chantier soldé : le client a tout payé, il n’y a plus rien à encaisser.'}
                </p>
              )}
              {remainingPayable && (
                <p className="text-xs text-base-content/60">
                  Chaque somme reçue (acompte, avance, solde) s’enregistre avec « Encaisser » : le reste à payer se recalcule.
                </p>
              )}
            </div>
          )}
          {!canViewPayments ? (
            <Card>
              <EmptyState title="Paiements non consultables" description="Votre rôle ne permet pas de consulter les encaissements." />
            </Card>
          ) : payments.length === 0 ? (
            <Card>
              <EmptyState title="Aucun encaissement" description="Aucun règlement n’a encore été enregistré sur ce chantier." />
            </Card>
          ) : (
            <ResponsiveTable columns={jobPaymentColumns} data={payments} getRowKey={(payment) => payment.id} />
          )}
        </PageSection>
      )}

      {tab === 'documents' && (
        <PageSection title="Documents" subtitle="Documents du chantier, imprimables et exportables au nom du magasin.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <DocLink href={`/chantiers/${job.id}/document`} title="Facture du chantier" text="Prestations, paiements reçus et reste à payer." />
            {job.quoteId && <DocLink href={`/chantiers/devis/${job.quoteId}`} title={`Devis ${job.quoteReference}`} text="Le devis accepté par le client." />}
            {job.requestId && <DocLink href={`/chantiers/demandes/${job.requestId}`} title={`Demande ${job.requestReference}`} text="Le besoin exprimé par le client." />}
            {payments.map((payment) => (
              <DocLink key={payment.id} href={`/recus/${payment.id}`} title={`Reçu ${payment.receiptNumber}`} text={`${formatDateShort(payment.date)} · ${new Intl.NumberFormat('fr-FR').format(payment.amount)} GNF`} />
            ))}
          </div>
        </PageSection>
      )}

      {tab === 'history' && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="space-y-2">
            <h2 className="text-sm font-semibold">Notes</h2>
            <p className="whitespace-pre-line text-sm text-base-content/75">{job.notes || 'Aucune note.'}</p>
            {editable && (
              <button type="button" className="btn btn-ghost btn-sm min-h-11 border border-base-300" onClick={() => setIsEditOpen(true)}>
                Modifier les notes
              </button>
            )}
          </Card>
          <Card className="lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold">Historique</h2>
            <HistoryTimeline entity="service_job" id={job.id} />
          </Card>
        </div>
      )}

      {editable && canDelete && (
        <div className="flex justify-end border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11 text-error" onClick={() => setIsCancelOpen(true)}>
            Annuler le chantier
          </button>
        </div>
      )}

      {/* Modales */}
      <JobFormModal isOpen={isEditOpen} onClose={() => setIsEditOpen(false)} onSaved={refresh} job={job} />
      <JobItemModal isOpen={itemModal.open} onClose={() => setItemModal({ open: false, item: null })} jobId={job.id} item={itemModal.item} onSaved={refresh} />
      <StageModal isOpen={stageModal.open} onClose={() => setStageModal({ open: false, stage: null })} jobId={job.id} stage={stageModal.stage} services={jobServices} onSaved={refresh} />
      <SubcontractModal isOpen={subModal.open} onClose={() => setSubModal({ open: false, sub: null })} jobId={job.id} subcontract={subModal.sub} onSaved={refresh} />
      <JobExpenseModal isOpen={expenseModal.open} onClose={() => setExpenseModal({ open: false, sub: null })} jobId={job.id} subcontract={expenseModal.sub} onSaved={refresh} />
      <TeamModal isOpen={isTeamOpen} onClose={() => setIsTeamOpen(false)} jobId={job.id} onSaved={refresh} />
      <JobMaterialModal isOpen={isMaterialOpen} onClose={() => setIsMaterialOpen(false)} jobId={job.id} jobReference={job.reference} products={products} isOptionsLoading={isOptionsLoading} onAdded={refresh} />
      <JobWorkerModal isOpen={isWorkerOpen} onClose={() => setIsWorkerOpen(false)} jobId={job.id} jobReference={job.reference} workers={workers} isOptionsLoading={isOptionsLoading} onAdded={refresh} />
      <JobPaymentModal isOpen={isPaymentOpen} onClose={() => setIsPaymentOpen(false)} job={job} remainingAmount={job.remainingAmount} onRecorded={() => refresh()} />

      <JobCancelDialog
        isOpen={isCancelOpen}
        onClose={() => !isWorking && setIsCancelOpen(false)}
        onConfirm={async (reason: string) => {
          if (await call(`/api/chantiers/${job.id}`, 'DELETE', { reason }, 'Chantier annulé — matériaux rendus au stock.', 'Le chantier n’a pas pu être annulé.')) {
            setIsCancelOpen(false);
          }
        }}
        job={job}
        isSubmitting={isWorking}
      />
      <JobRemoveMaterialDialog
        isOpen={Boolean(materialToRemove)}
        onClose={() => !isWorking && setMaterialToRemove(null)}
        onConfirm={async () => {
          if (materialToRemove && (await call(`/api/chantiers/${job.id}/materiaux?materialId=${materialToRemove.id}`, 'DELETE', undefined, `${materialToRemove.productName} rendu au stock.`, 'La ligne n’a pas pu être retirée.'))) {
            setMaterialToRemove(null);
          }
        }}
        material={materialToRemove}
        isSubmitting={isWorking}
      />
      <JobRemoveWorkerDialog
        isOpen={Boolean(workerToRemove)}
        onClose={() => !isWorking && setWorkerToRemove(null)}
        onConfirm={async () => {
          if (workerToRemove && (await call(`/api/chantiers/${job.id}/ouvriers?workerId=${workerToRemove.id}`, 'DELETE', undefined, 'Affectation retirée.', 'L’affectation n’a pas pu être retirée.'))) {
            setWorkerToRemove(null);
          }
        }}
        assignment={workerToRemove}
        isSubmitting={isWorking}
      />
      <ConfirmDialog
        isOpen={Boolean(itemToRemove)}
        onClose={() => setItemToRemove(null)}
        title="Retirer cette prestation ?"
        message={
          <>
            <strong>{itemToRemove?.serviceName}</strong> sera retirée et le montant du chantier recalculé. Le retrait est inscrit dans
            l’historique.
          </>
        }
        confirmLabel="Retirer"
        isSubmitting={isWorking}
        onConfirm={async () => {
          if (itemToRemove && (await call(`/api/chantiers/${job.id}/prestations?itemId=${itemToRemove.id}`, 'DELETE', undefined, 'Prestation retirée.', 'La prestation n’a pas pu être retirée.'))) {
            setItemToRemove(null);
          }
        }}
      />
      <ConfirmDialog
        isOpen={Boolean(stageToRemove)}
        onClose={() => setStageToRemove(null)}
        title="Retirer cette étape ?"
        message={<>L’étape « {stageToRemove?.name} » sera retirée du suivi ; l’avancement sera recalculé.</>}
        confirmLabel="Retirer"
        tone="warning"
        isSubmitting={isWorking}
        onConfirm={async () => {
          if (stageToRemove && (await call(`/api/chantiers/${job.id}/etapes?stageId=${stageToRemove.id}`, 'DELETE', undefined, 'Étape retirée.', 'L’étape n’a pas pu être retirée.'))) {
            setStageToRemove(null);
          }
        }}
      />
      <ConfirmDialog
        isOpen={Boolean(subToCancel)}
        onClose={() => setSubToCancel(null)}
        title="Annuler ces travaux sous-traités ?"
        message={<>Les travaux de {subToCancel?.supplierName} ne compteront plus dans le coût du chantier. Impossible s’ils ont déjà été payés.</>}
        confirmLabel="Annuler les travaux"
        isSubmitting={isWorking}
        onConfirm={async () => {
          if (subToCancel && (await call(`/api/chantiers/${job.id}/sous-traitance?subcontractId=${subToCancel.id}`, 'DELETE', undefined, 'Travaux annulés.', 'Les travaux n’ont pas pu être annulés.'))) {
            setSubToCancel(null);
          }
        }}
      />
    </div>
  );
}

function DocLink({ href, title, text }: { href: string; title: string; text: string }) {
  return (
    <Link href={href} className="surface-card flex min-h-11 items-start gap-3 border border-base-200 bg-base-100 p-4 shadow-sm transition hover:border-primary/40">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden>
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </span>
      <span className="min-w-0">
        <span className="block truncate font-semibold">{title}</span>
        <span className="block text-sm text-base-content/60">{text}</span>
      </span>
    </Link>
  );
}
