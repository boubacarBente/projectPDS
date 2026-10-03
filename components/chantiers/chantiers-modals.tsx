'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ToolbarButton } from '@/components/data-toolbar';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  EmptyState,
  FormField,
  InfoRow,
  MoneyText,
  QuantityText,
  SkeletonTable,
  type BadgeTone,
} from '@/components/design-system';
import {
  WORKER_ROLE_OPTIONS,
  WorkersManagerModal,
  readApiError,
  type WorkerRow,
} from '@/components/workers/workers-modals';
import { usePermission } from '@/components/role-gate';
import { useSettings } from '@/app/parametres/page';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';
import { jobCategoryLabel as categoryLabelOf } from '@/lib/job-categories';
import { StoreTag } from '@/components/store-scope';
import {
  CustomerPicker,
  ProgressBar,
  ServiceLinesEditor,
  linesPayload,
  newLine,
  resolveLine,
  useActiveServices,
  useCustomers,
  useResponsibles,
  type LineDraft,
} from '@/components/prestations/shared';
import { formatNumber, formatPercent, formatQuantity, today } from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';

/* ==================================================================
 * Composants propres au domaine « Chantiers » (§2 : components/chantiers/).
 *
 * ⚠️ Types et libellés sont **redéclarés ici** plutôt qu'importés de
 * `lib/jobs.ts` : ce fichier est un composant client, et `lib/jobs.ts` importe
 * `@/db` (donc `@libsql/client`, `fs`, `path`). Un import — même partiel —
 * ferait entrer la chaîne base de données dans le bundle navigateur
 * (CONVENTIONS §11 bis). Les formes ci-dessous décrivent le JSON renvoyé par
 * `/api/chantiers`.
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * Types (miroir du JSON de l'API)
 * ------------------------------------------------------------------ */

/** Type de prestation : libellé de `settings.jobCategories` (lib/job-categories.ts). */
export type JobCategory = string;
/**
 * Statuts du chantier. « En retard » n'est pas un statut : `isLate` est
 * calculé par le serveur. `quote` ne concerne que les chantiers d'avant la v2
 * (le devis est désormais un document distinct).
 */
export type JobStatus = 'quote' | 'pending' | 'planned' | 'in_progress' | 'suspended' | 'completed' | 'cancelled';
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'refused';

export type ServiceJobRow = {
  id: number;
  storeId?: number | null;
  /** Magasin du chantier (vue « tous les magasins »). */
  storeName?: string | null;
  reference: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  category: JobCategory;
  title: string | null;
  siteAddress: string | null;
  description: string | null;
  /** Début et fin **prévus**. */
  startDate: string | null;
  endDate: string | null;
  /** Début et fin **réels**. */
  actualStartDate: string | null;
  actualEndDate: string | null;
  status: JobStatus;
  quoteStatus: QuoteStatus;
  quoteMaterials: number;
  quoteLabor: number;
  quoteTotal: number;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  userId: number | null;
  userName: string | null;
  responsibleUserId: number | null;
  responsibleName: string | null;
  notes: string | null;
  progress: number;
  manualProgress: number | null;
  isLate: boolean;
  quoteId: number | null;
  quoteReference: string | null;
  requestId: number | null;
  requestReference: string | null;
  itemsCount: number;
  stagesCount: number;
  materialsCount: number;
  workersCount: number;
  createdAt: string | null;
};

export type ServiceJobItemRow = {
  id: number;
  jobId: number;
  serviceId: number | null;
  serviceCode: string | null;
  serviceName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  amount: number;
  position: number;
};

export type ServiceJobMaterialRow = {
  id: number;
  jobId: number;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  unitCost: number;
  amount: number;
  createdAt: string | null;
};

export type ServiceJobWorkerRow = {
  id: number;
  jobId: number;
  workerId: number | null;
  workerName: string;
  role: string | null;
  days: number;
  dailyRate: number;
  amount: number;
  createdAt: string | null;
};

export type StageStatus = 'todo' | 'in_progress' | 'done' | 'blocked';

export type JobStageRow = {
  id: number;
  jobId: number;
  name: string;
  serviceId: number | null;
  serviceName: string | null;
  responsible: string | null;
  plannedDate: string | null;
  actualDate: string | null;
  progress: number;
  status: StageStatus;
  comment: string | null;
  position: number;
  isLate: boolean;
};

export type JobSubcontractRow = {
  id: number;
  jobId: number;
  supplierId: number;
  supplierName: string;
  supplierPhone: string | null;
  work: string;
  agreedAmount: number;
  paid: number;
  pending: number;
  remaining: number;
  status: 'active' | 'cancelled';
  notes: string | null;
};

export type JobExpenseRow = {
  id: number;
  date: string;
  category: string;
  amount: number;
  description: string | null;
  beneficiary: string | null;
  paymentMethod: string;
  approvalStatus: string;
  referenceType: string;
  subcontractId: number | null;
};

/** Rentabilité d'un chantier — `null` sans la permission `balances.view`. */
export type JobCosts = {
  billed: number;
  collected: number;
  remaining: number;
  materialsCost: number;
  laborCost: number;
  subcontractCost: number;
  expensesCost: number;
  totalCost: number;
  margin: number;
  marginPercent: number;
};

export type PaymentRow = {
  id: number;
  receiptNumber: string;
  amount: number;
  paymentMethod: string;
  paymentLabel: string;
  date: string;
  notes: string | null;
  userName: string | null;
};

export type ServiceJobDetail = {
  job: ServiceJobRow;
  items: ServiceJobItemRow[];
  materials: ServiceJobMaterialRow[];
  workers: ServiceJobWorkerRow[];
  stages: JobStageRow[];
  subcontracts: JobSubcontractRow[];
  expenses: JobExpenseRow[];
  payments: PaymentRow[];
  costs: JobCosts | null;
};

export type JobsSummary = {
  totalJobs: number;
  byStatus: Record<JobStatus, number>;
  late: number;
  billed: number;
  collected: number;
  outstanding: number;
  materialsCost: number | null;
  laborCost: number | null;
  subcontractCost: number | null;
  expensesCost: number | null;
  totalCost: number | null;
  margin: number | null;
  marginPercent: number | null;
};

export type Paginated<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export { readApiError };

/* ------------------------------------------------------------------ *
 * Libellés français — jamais la couleur seule (§5.3)
 * ------------------------------------------------------------------ */

/**
 * Options du choix « type de prestation » : la liste des paramètres, plus le
 * type actuel d'un chantier s'il a été retiré de la liste depuis (il reste
 * affiché et conservé).
 */
export function jobCategoryOptions(list: string[], current?: string | null): { value: string; label: string }[] {
  const options = list.map((value) => ({ value, label: value }));
  const label = current ? categoryLabelOf(current) : '';
  if (label && label !== '—' && !list.some((v) => v.toLowerCase() === label.toLowerCase())) {
    options.unshift({ value: label, label });
  }
  return options;
}

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  quote: 'Devis (ancien)',
  pending: 'En préparation',
  planned: 'Planifié',
  in_progress: 'En cours',
  suspended: 'Suspendu',
  completed: 'Terminé',
  cancelled: 'Annulé',
};

export const JOB_STATUS_TONES: Record<JobStatus, BadgeTone> = {
  quote: 'neutral',
  pending: 'neutral',
  planned: 'info',
  in_progress: 'primary',
  suspended: 'warning',
  completed: 'success',
  cancelled: 'error',
};

/** Filtre de la liste : « ouverts » et « en retard » s'ajoutent aux statuts. */
export const JOB_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'open', label: 'Chantiers ouverts' },
  ...(['pending', 'planned', 'in_progress', 'suspended', 'completed', 'cancelled'] as JobStatus[]).map((value) => ({
    value,
    label: JOB_STATUS_LABELS[value],
  })),
];

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Brouillon',
  sent: 'Envoyé',
  accepted: 'Accepté',
  refused: 'Refusé',
};

export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  todo: 'À faire',
  in_progress: 'En cours',
  done: 'Terminée',
  blocked: 'Bloquée',
};
export const STAGE_STATUS_TONES: Record<StageStatus, BadgeTone> = {
  todo: 'neutral',
  in_progress: 'primary',
  done: 'success',
  blocked: 'error',
};

export function jobCategoryLabel(category: string | null | undefined): string {
  return categoryLabelOf(category);
}

export function jobStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return JOB_STATUS_LABELS[status as JobStatus] ?? status;
}

export function quoteStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return QUOTE_STATUS_LABELS[status as QuoteStatus] ?? status;
}

/** Rail d'avancement : `suspended` et `cancelled` sont traités à part. */
export const JOB_STAGES = [
  { key: 'pending', label: 'Préparation' },
  { key: 'planned', label: 'Planifié' },
  { key: 'in_progress', label: 'En cours' },
  { key: 'completed', label: 'Terminé' },
];

/** Prochaine étape d'avancement, ou `null` si le chantier est terminé/annulé. */
export function nextJobStage(status: JobStatus): { key: JobStatus; label: string } | null {
  const from = status === 'quote' ? 'pending' : status === 'suspended' ? 'planned' : status;
  const index = JOB_STAGES.findIndex((stage) => stage.key === from);
  if (index < 0 || index >= JOB_STAGES.length - 1) return null;
  return JOB_STAGES[index + 1] as { key: JobStatus; label: string };
}

/** Badge de statut d'un chantier, avec « En retard » en plus quand il l'est. */
export function JobStatusBadges({ job }: { job: Pick<ServiceJobRow, 'status' | 'isLate'> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={JOB_STATUS_TONES[job.status]}>{jobStatusLabel(job.status)}</Badge>
      {job.isLate && <Badge tone="error">En retard</Badge>}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Options de sélection (clients, produits, ouvriers)
 * ------------------------------------------------------------------ */

export type CustomerOption = { id: number; name: string; phone: string | null };

export type ProductOption = {
  id: number;
  name: string;
  unit: string;
  purchasePrice: number;
  stock: number;
  categoryKind: string | null;
};

/**
 * Charge une seule fois les listes d'appoint (clients, produits, ouvriers du
 * magasin et communs) et les expose aux modales. Aucune n'est critique : un
 * échec laisse simplement la sélection vide, sans masquer la page.
 */
export function useJobSelectOptions(enabled: boolean) {
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();

    async function load() {
      setIsLoading(true);
      try {
        const init = { signal: controller.signal, cache: 'no-store' as const, credentials: 'same-origin' as const };
        const [customersResponse, productsResponse, workersResponse] = await Promise.all([
          fetch('/api/clients?limit=500&page=1', init),
          fetch('/api/produits?limit=500&page=1', init),
          fetch('/api/workers?limit=200&page=1&sort=name', init),
        ]);

        if (controller.signal.aborted) return;

        if (customersResponse.ok) {
          const payload = (await customersResponse.json()) as Paginated<CustomerOption>;
          setCustomers(Array.isArray(payload.data) ? payload.data : []);
        }
        if (productsResponse.ok) {
          const payload = (await productsResponse.json()) as Paginated<any>;
          setProducts(
            (payload.data ?? []).map((product: any) => ({
              id: Number(product.id),
              name: String(product.name ?? ''),
              unit: String(product.unit ?? 'pièce'),
              purchasePrice: Number(product.purchasePrice ?? 0),
              stock: Number(product.stock ?? 0),
              categoryKind: product.categoryKind ?? null,
            })),
          );
        }
        if (workersResponse.ok) {
          const payload = (await workersResponse.json()) as Paginated<WorkerRow>;
          setWorkers(Array.isArray(payload.data) ? payload.data : []);
        }
      } catch {
        // Listes d'appoint : leur échec ne doit pas faire échouer la page.
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [enabled]);

  return { customers, products, workers, isLoading };
}

/* ------------------------------------------------------------------ *
 * Colonnes partagées
 * ------------------------------------------------------------------ */

/**
 * Colonnes de la liste des chantiers.
 *
 * Six colonnes (le tableau doit tenir en 1366 px) : le type et le magasin
 * sous la référence, le site sous le client, l'avancement sous le statut, le
 * payé sous le total.
 */
export function buildJobColumns(options: { showStore?: boolean } = {}): Column<ServiceJobRow>[] {
  return [
    {
      key: 'startDate',
      label: 'Début',
      render: (job) => {
        if (!job.startDate) return <span className="text-base-content/50">—</span>;
        const [day, date] = formatDateShort(job.startDate).split(' ');
        return (
          <span className="block tabular text-base-content/70">
            <span className="block text-xs text-base-content/50">{day}</span>
            {date ?? day}
          </span>
        );
      },
    },
    {
      key: 'reference',
      label: 'Chantier',
      primary: true,
      render: (job) => (
        <div className="min-w-0 max-w-[13rem]">
          <Link
            href={`/chantiers/${job.id}`}
            className="font-semibold text-primary hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {job.reference}
          </Link>
          {job.title && <div className="truncate text-xs text-base-content/60">{job.title}</div>}
          <div className="mt-1">
            <Badge tone="primary">{jobCategoryLabel(job.category)}</Badge>
          </div>
          <StoreTag name={job.storeName} show={Boolean(options.showStore)} />
        </div>
      ),
    },
    {
      key: 'customer',
      label: 'Client',
      render: (job) => (
        <div className="min-w-0 max-w-[11rem]">
          <span className="block truncate text-sm">{job.customerName}</span>
          {job.siteAddress && (
            <span className="block truncate text-xs text-base-content/55" title={job.siteAddress}>
              {job.siteAddress}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Avancement',
      render: (job) => (
        <div className="flex w-28 flex-col items-start gap-1.5">
          <JobStatusBadges job={job} />
          {job.status !== 'cancelled' && job.status !== 'quote' && <ProgressBar value={job.progress} late={job.isLate} className="w-full" />}
        </div>
      ),
    },
    {
      key: 'total',
      label: 'Total',
      className: 'text-right whitespace-nowrap',
      render: (job) => (
        <span className="block">
          <MoneyText value={job.total} bold />
          <span className="block text-xs text-base-content/55">
            payé <MoneyText value={job.amountPaid} />
          </span>
        </span>
      ),
    },
    {
      key: 'remaining',
      label: 'Reste',
      className: 'text-right whitespace-nowrap',
      // Rouge dès qu'il reste à encaisser, neutre sinon (et pour un chantier annulé).
      render: (job) => <MoneyText value={job.remainingAmount} remaining={job.status !== 'cancelled'} bold />,
    },
  ];
}

/** Colonnes par défaut (magasin actif). */
export const jobColumns: Column<ServiceJobRow>[] = buildJobColumns();

export const jobMaterialColumns: Column<ServiceJobMaterialRow>[] = [
  {
    key: 'product',
    label: 'Produit',
    primary: true,
    render: (material) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{material.productName}</div>
      </div>
    ),
  },
  {
    key: 'quantity',
    label: 'Quantité',
    render: (material) => <QuantityText value={material.quantity} unit={material.unit} />,
  },
  {
    key: 'unitCost',
    label: 'Prix d’achat',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (material) => <MoneyText value={material.unitCost} />,
  },
  {
    key: 'amount',
    label: 'Coût',
    className: 'text-right whitespace-nowrap',
    render: (material) => <MoneyText value={material.amount} bold />,
  },
];

export const jobWorkerColumns: Column<ServiceJobWorkerRow>[] = [
  {
    key: 'workerName',
    label: 'Ouvrier',
    primary: true,
    render: (assignment) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{assignment.workerName}</div>
        <div className="text-xs text-base-content/50">
          {assignment.role ? (WORKER_ROLE_OPTIONS.find((o) => o.value === assignment.role)?.label ?? assignment.role) : 'Rôle non précisé'}
          {assignment.workerId === null && ' · journalier ponctuel'}
        </div>
      </div>
    ),
  },
  {
    key: 'days',
    label: 'Jours',
    render: (assignment) => <span className="tabular">{formatQuantity(assignment.days)}</span>,
  },
  {
    key: 'dailyRate',
    label: 'Tarif / jour',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (assignment) => <MoneyText value={assignment.dailyRate} />,
  },
  {
    key: 'amount',
    label: 'Coût',
    className: 'text-right whitespace-nowrap',
    render: (assignment) => <MoneyText value={assignment.amount} bold />,
  },
];

export const jobPaymentColumns: Column<PaymentRow>[] = [
  {
    key: 'date',
    label: 'Date',
    className: 'whitespace-nowrap',
    render: (payment) => <span className="tabular text-base-content/70">{formatDateShort(payment.date)}</span>,
  },
  {
    key: 'receiptNumber',
    label: 'Reçu',
    primary: true,
    render: (payment) => (
      <Link href={`/recus/${payment.id}`} className="font-semibold text-primary hover:underline">
        {payment.receiptNumber}
      </Link>
    ),
  },
  {
    key: 'paymentMethod',
    label: 'Moyen',
    render: (payment) => <span>{payment.paymentMethod || '—'}</span>,
  },
  {
    key: 'userName',
    label: 'Caissier',
    hideOnMobile: true,
    render: (payment) => <span className="text-base-content/70">{payment.userName || '—'}</span>,
  },
  {
    key: 'amount',
    label: 'Montant',
    className: 'text-right whitespace-nowrap',
    render: (payment) => <MoneyText value={payment.amount} bold />,
  },
];

/* ------------------------------------------------------------------ *
 * Modale — ouverture ou modification d'un chantier
 * ------------------------------------------------------------------ */

/**
 * Ouverture d'un chantier **sans devis préalable** (travaux urgents, client
 * habituel) ou modification de ses informations.
 *
 * À la création, le montant vient des **prestations du catalogue** du magasin
 * (ou d'un montant forfaitaire si aucune n'est saisie). En modification, les
 * prestations se gèrent dans l'onglet « Prestations » de la fiche ; le montant
 * forfaitaire ne reste modifiable que pour un chantier sans ligne.
 */
export function JobFormModal({
  isOpen,
  onClose,
  onSaved,
  job,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (job: ServiceJobRow) => void;
  /** `null` = création. */
  job: ServiceJobRow | null;
}) {
  const { settings } = useSettings();
  const categoryList = settings.jobCategories ?? [];
  const { customers, isLoading: customersLoading, add: addCustomer } = useCustomers(isOpen);
  const { services, isLoading: servicesLoading } = useActiveServices(isOpen && !job);
  const people = useResponsibles(isOpen);

  const [customerId, setCustomerId] = useState('');
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [actualStartDate, setActualStartDate] = useState('');
  const [actualEndDate, setActualEndDate] = useState('');
  const [status, setStatus] = useState<JobStatus>('pending');
  const [responsible, setResponsible] = useState('');
  const [progress, setProgress] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setCustomerId(job ? String(job.customerId) : '');
    setCategory(job?.category ? categoryLabelOf(job.category) : '');
    setTitle(job?.title ?? '');
    setSiteAddress(job?.siteAddress ?? '');
    setDescription(job?.description ?? '');
    setStartDate(job?.startDate ?? today());
    setEndDate(job?.endDate ?? '');
    setActualStartDate(job?.actualStartDate ?? '');
    setActualEndDate(job?.actualEndDate ?? '');
    setStatus(job ? job.status : 'pending');
    setResponsible(job?.responsibleUserId ? String(job.responsibleUserId) : '');
    setProgress(job?.manualProgress != null ? String(job.manualProgress) : '');
    setAmount(job && job.itemsCount === 0 ? String(job.total) : '');
    setNotes(job?.notes ?? '');
    setLines([newLine()]);
    setFormError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, job]);

  // Type proposé d'après la première prestation choisie.
  useEffect(() => {
    if (job || category) return;
    const first = lines.map((line) => services.find((s) => String(s.id) === line.serviceId)).find(Boolean);
    if (first) setCategory(first.category);
  }, [lines, services, category, job]);

  const items = linesPayload(lines);
  const linesTotal = lines.reduce((sum, line) => sum + resolveLine(line, services).amount, 0);

  async function submit() {
    if (isSubmitting) return;
    if (!customerId) return setFormError('Le client est obligatoire pour un chantier.');
    if (!category) return setFormError('Choisissez le type de prestation.');
    if (endDate && startDate && endDate < startDate) return setFormError('La fin prévue ne peut pas précéder le début prévu.');
    if (!job && items.length === 0 && !(Number(amount) > 0)) {
      return setFormError('Ajoutez au moins une prestation, ou indiquez un montant forfaitaire.');
    }

    setFormError(null);
    setIsSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        customerId: Number(customerId),
        category,
        title: title.trim() || null,
        siteAddress: siteAddress.trim() || null,
        description: description.trim() || null,
        startDate: startDate || null,
        endDate: endDate || null,
        responsibleUserId: responsible ? Number(responsible) : null,
        notes: notes.trim() || null,
      };
      if (job) {
        body.actualStartDate = actualStartDate || null;
        body.actualEndDate = actualEndDate || null;
        if (job.stagesCount === 0) body.progress = progress === '' ? null : Number(progress);
        if (job.itemsCount === 0 && amount !== '') body.amount = Number(String(amount).replace(',', '.'));
      } else {
        body.status = status;
        body.items = items;
        if (items.length === 0) body.amount = Number(String(amount).replace(',', '.')) || 0;
      }

      const response = await fetch(job ? `/api/chantiers/${job.id}` : '/api/chantiers', {
        method: job ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Le chantier n’a pas pu être enregistré.'));
      const saved = (await response.json()) as ServiceJobRow;
      toast.success(job ? 'Chantier modifié.' : `Chantier ${saved.reference} ouvert.`);
      onSaved(saved);
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Le chantier n’a pas pu être enregistré.';
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={job ? `Modifier ${job.reference}` : 'Nouveau chantier'}
      size="xl"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!job && (
          <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
            Pour un client qui doit d’abord valider un prix, établissez plutôt un{' '}
            <Link href="/chantiers/devis/nouveau" className="link font-medium">
              devis
            </Link>{' '}
            : une fois accepté, il ouvre le chantier tout seul.
          </p>
        )}

        <FormField label="Client" htmlFor="job-customer" required>
          <CustomerPicker
            id="job-customer"
            value={customerId}
            onChange={setCustomerId}
            customers={customers}
            isLoading={customersLoading}
            onCreated={addCustomer}
            disabled={isSubmitting}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Intitulé du chantier" htmlFor="job-title">
            <input
              id="job-title"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={isSubmitting}
              placeholder="Ex. Rénovation villa Kipé"
            />
          </FormField>
          <FormField label="Type de prestation" htmlFor="job-category" required>
            <select
              id="job-category"
              className="select select-bordered min-h-11 w-full"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              disabled={isSubmitting}
            >
              <option value="">Choisir le type…</option>
              {jobCategoryOptions(categoryList, job?.category).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <FormField label="Adresse du chantier" htmlFor="job-site">
          <input
            id="job-site"
            type="text"
            className="input input-bordered min-h-11 w-full"
            value={siteAddress}
            onChange={(event) => setSiteAddress(event.target.value)}
            disabled={isSubmitting}
            placeholder="Quartier, commune, repère…"
          />
        </FormField>

        <FormField label="Description des travaux" htmlFor="job-description">
          <textarea
            id="job-description"
            className="textarea textarea-bordered min-h-20 w-full"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={isSubmitting}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label="Début prévu">
            <DatePicker value={startDate} onChange={setStartDate} placeholder="Début prévu" />
          </FormField>
          <FormField label="Fin prévue" hint="Sert à repérer les retards.">
            <DatePicker value={endDate} onChange={setEndDate} placeholder="Fin prévue" />
          </FormField>
          {job ? (
            <>
              <FormField label="Début réel">
                <DatePicker value={actualStartDate} onChange={setActualStartDate} placeholder="Début réel" />
              </FormField>
              <FormField label="Fin réelle">
                <DatePicker value={actualEndDate} onChange={setActualEndDate} placeholder="Fin réelle" />
              </FormField>
            </>
          ) : (
            <FormField label="Statut de départ" htmlFor="job-status" className="lg:col-span-2">
              <select
                id="job-status"
                className="select select-bordered min-h-11 w-full"
                value={status}
                onChange={(event) => setStatus(event.target.value as JobStatus)}
                disabled={isSubmitting}
              >
                {(['pending', 'planned', 'in_progress'] as JobStatus[]).map((value) => (
                  <option key={value} value={value}>
                    {JOB_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </FormField>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Responsable" htmlFor="job-responsible">
            <select
              id="job-responsible"
              className="select select-bordered min-h-11 w-full"
              value={responsible}
              onChange={(event) => setResponsible(event.target.value)}
              disabled={isSubmitting}
            >
              <option value="">— Non désigné —</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </FormField>
          {job && job.stagesCount === 0 && (
            <FormField label="Avancement (%)" htmlFor="job-progress" hint="Ou découpez le chantier en étapes : l’avancement en sera la moyenne.">
              <input
                id="job-progress"
                type="number"
                min="0"
                max="100"
                className="input input-bordered min-h-11 w-full tabular"
                value={progress}
                onChange={(event) => setProgress(event.target.value)}
                disabled={isSubmitting}
              />
            </FormField>
          )}
        </div>

        {!job && (
          <div className="space-y-3 rounded-xl border border-base-200 p-3 sm:p-4">
            <div>
              <h3 className="text-sm font-semibold">Prestations facturées</h3>
              <p className="text-xs text-base-content/60">
                Elles font le montant du chantier. Les matériaux, l’équipe et les dépenses sont des coûts, suivis à part.
              </p>
            </div>
            <ServiceLinesEditor lines={lines} onChange={setLines} services={services} isLoading={servicesLoading} disabled={isSubmitting} />
            {items.length === 0 && (
              <FormField label="Ou montant forfaitaire (GNF)" htmlFor="job-amount" hint="Si le chantier n’utilise aucune prestation du catalogue.">
                <input
                  id="job-amount"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  className="input input-bordered min-h-11 w-full tabular sm:w-64"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  disabled={isSubmitting}
                  placeholder="0"
                />
              </FormField>
            )}
          </div>
        )}

        {job && job.itemsCount === 0 && (
          <FormField label="Montant du chantier (GNF)" htmlFor="job-amount-edit" hint="Chantier sans prestation du catalogue : son montant se saisit ici.">
            <input
              id="job-amount-edit"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular sm:w-64"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={isSubmitting}
            />
          </FormField>
        )}

        <FormField label="Notes internes" htmlFor="job-notes">
          <textarea
            id="job-notes"
            className="textarea textarea-bordered min-h-20 w-full"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            disabled={isSubmitting}
          />
        </FormField>

        {!job && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
            <span>Montant du chantier</span>
            <MoneyText value={items.length > 0 ? linesTotal : Number(amount) || 0} bold className="text-lg" />
          </div>
        )}

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Enregistrement…
              </>
            ) : job ? (
              'Enregistrer les modifications'
            ) : (
              'Ouvrir le chantier'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — ajout d'un matériau (contrôle de stock)
 * ------------------------------------------------------------------ */

export function JobMaterialModal({
  isOpen,
  onClose,
  jobId,
  jobReference,
  products,
  isOptionsLoading,
  onAdded,
}: {
  isOpen: boolean;
  onClose: () => void;
  jobId: number;
  jobReference: string;
  products: ProductOption[];
  isOptionsLoading: boolean;
  onAdded: () => void;
}) {
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setProductId('');
    setQuantity('');
    setUnitCost('');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen]);

  const selected = useMemo(
    () => products.find((product) => String(product.id) === productId) ?? null,
    [products, productId],
  );

  const parsedQuantity = Number(String(quantity).replace(',', '.'));
  const quantityValid = Number.isFinite(parsedQuantity) && parsedQuantity > 0;

  const parsedCost = unitCost === '' ? (selected?.purchasePrice ?? 0) : Number(String(unitCost).replace(',', '.'));
  const costValid = Number.isFinite(parsedCost) && parsedCost >= 0;
  const amount = quantityValid && costValid ? parsedQuantity * parsedCost : 0;
  const insufficient = Boolean(selected) && quantityValid && parsedQuantity > selected!.stock;

  async function submit() {
    if (isSubmitting) return;

    if (!selected) {
      setFormError('Sélectionnez le produit à sortir du stock.');
      return;
    }
    if (!quantityValid) {
      setFormError('Saisissez une quantité strictement positive.');
      return;
    }
    if (insufficient) {
      setFormError(
        `Stock insuffisant : ${selected.name} (disponible ${formatQuantity(selected.stock, selected.unit)}).`,
      );
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/chantiers/${jobId}/materiaux`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          productId: selected.id,
          quantity: parsedQuantity,
          unitCost: parsedCost,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Le matériau n'a pas pu être ajouté."));
      }

      toast.success(
        `${formatQuantity(parsedQuantity, selected.unit)} de ${selected.name} sortis du stock pour ${jobReference}.`,
      );
      onAdded();
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Le matériau n'a pas pu être ajouté.";
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={`Matériaux — ${jobReference}`}
      size="lg"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          L’ajout déduit immédiatement le stock par un mouvement <strong>sortie</strong> motivé
          (« chantier {jobReference} : … »). Le produit, son code et son unité sont figés sur la
          ligne : le chantier reste imprimable même si le catalogue change.
        </p>

        <FormField label="Produit" htmlFor="job-material-product" required>
          {isOptionsLoading && products.length === 0 ? (
            <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
          ) : (
            <select
              id="job-material-product"
              className="select select-bordered min-h-11 w-full"
              value={productId}
              onChange={(event) => {
                const value = event.target.value;
                setProductId(value);
                const product = products.find((p) => String(p.id) === value);
                setUnitCost(product ? String(product.purchasePrice) : '');
                setFormError(null);
              }}
              disabled={isSubmitting}
            >
              <option value="">— Sélectionner un produit —</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({formatQuantity(product.stock, product.unit)} en stock)
                </option>
              ))}
            </select>
          )}
        </FormField>

        {selected && (
          <div className="grid gap-x-6 gap-y-1 rounded-xl border border-base-200 px-4 py-3 sm:grid-cols-2">
            <InfoRow label="Unité">{selected.unit}</InfoRow>
            <InfoRow label="Stock disponible">
              <QuantityText value={selected.stock} unit={selected.unit} />
            </InfoRow>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Quantité" htmlFor="job-material-quantity" required hint="Décimale acceptée (m², kg).">
            <input
              id="job-material-quantity"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={quantity}
              onChange={(event) => {
                setQuantity(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>

          <FormField
            label="Coût unitaire (prix d’achat)"
            htmlFor="job-material-cost"
            hint="Base du coût de revient et de la marge."
          >
            <input
              id="job-material-cost"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={unitCost}
              onChange={(event) => {
                setUnitCost(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>
        </div>

        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            insufficient ? 'border-error/30 bg-error/10 text-error' : 'border-info/30 bg-info/10'
          }`}
          role="status"
          aria-live="polite"
        >
          {insufficient ? (
            <span>
              <strong>Stock insuffisant :</strong> {formatQuantity(selected?.stock ?? 0, selected?.unit)} disponible,
              {' '}
              {formatQuantity(parsedQuantity, selected?.unit)} demandé.
            </span>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Montant de la ligne</span>
              <MoneyText value={amount} bold />
            </div>
          )}
        </div>

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button
            type="submit"
            className="btn btn-primary min-h-11"
            disabled={isSubmitting || products.length === 0}
          >
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Sortie du stock…
              </>
            ) : (
              'Ajouter le matériau'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — affectation d'un ouvrier
 * ------------------------------------------------------------------ */

export function JobWorkerModal({
  isOpen,
  onClose,
  jobId,
  jobReference,
  workers,
  isOptionsLoading,
  onAdded,
}: {
  isOpen: boolean;
  onClose: () => void;
  jobId: number;
  jobReference: string;
  workers: WorkerRow[];
  isOptionsLoading: boolean;
  onAdded: () => void;
}) {
  const [workerId, setWorkerId] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [role, setRole] = useState('worker');
  const [days, setDays] = useState('');
  const [dailyRate, setDailyRate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setWorkerId('');
    setWorkerName('');
    setRole('worker');
    setDays('');
    setDailyRate('');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen]);

  const parsedDays = Number(String(days).replace(',', '.'));
  const parsedRate = Number(String(dailyRate).replace(',', '.'));
  const daysValid = Number.isFinite(parsedDays) && parsedDays > 0;
  const amount = daysValid && Number.isFinite(parsedRate) ? parsedDays * parsedRate : 0;

  async function submit() {
    if (isSubmitting) return;

    if (!workerId && !workerName.trim()) {
      setFormError('Choisissez un ouvrier enregistré ou saisissez le nom d’un journalier.');
      return;
    }
    if (!daysValid) {
      setFormError('Saisissez un nombre de jours strictement positif.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/chantiers/${jobId}/ouvriers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          workerId: workerId ? Number(workerId) : null,
          workerName: workerName.trim() || null,
          role,
          days: parsedDays,
          dailyRate: Number.isFinite(parsedRate) ? parsedRate : 0,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "L'ouvrier n'a pas pu être affecté."));
      }

      toast.success(`Affectation enregistrée sur ${jobReference}.`);
      onAdded();
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "L'ouvrier n'a pas pu être affecté.";
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={`Équipe — ${jobReference}`}
      size="lg"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          Le montant vaut <strong>jours × tarif journalier</strong> et alimente la main-d’œuvre du
          chantier. Un <strong>journalier ponctuel</strong> qui n’est pas enregistré se saisit
          directement par son nom.
        </p>

        <FormField label="Ouvrier enregistré" htmlFor="job-worker" hint="Facultatif : laissez vide pour un journalier ponctuel.">
          {isOptionsLoading && workers.length === 0 ? (
            <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
          ) : (
            <select
              id="job-worker"
              className="select select-bordered min-h-11 w-full"
              value={workerId}
              onChange={(event) => {
                const value = event.target.value;
                setWorkerId(value);
                const worker = workers.find((w) => String(w.id) === value);
                if (worker) {
                  setWorkerName(worker.name);
                  setRole(worker.role);
                  setDailyRate(String(worker.dailyRate));
                }
                setFormError(null);
              }}
              disabled={isSubmitting}
            >
              <option value="">— Journalier ponctuel (saisie libre) —</option>
              {workers
                .filter((worker) => worker.isActive)
                .map((worker) => (
                  <option key={worker.id} value={worker.id}>
                    {worker.name} — {worker.specialty || 'sans spécialité'}
                  </option>
                ))}
            </select>
          )}
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Nom de l’ouvrier" htmlFor="job-worker-name" required>
            <input
              id="job-worker-name"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={workerName}
              onChange={(event) => {
                setWorkerName(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="Ex. Ibrahima Diallo"
            />
          </FormField>

          <FormField label="Rôle" htmlFor="job-worker-role">
            <select
              id="job-worker-role"
              className="select select-bordered min-h-11 w-full"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              disabled={isSubmitting}
            >
              {WORKER_ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Jours travaillés" htmlFor="job-worker-days" required hint="Décimal accepté (demi-journée).">
            <input
              id="job-worker-days"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={days}
              onChange={(event) => {
                setDays(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>

          <FormField label="Tarif journalier" htmlFor="job-worker-rate">
            <input
              id="job-worker-rate"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={dailyRate}
              onChange={(event) => {
                setDailyRate(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>
        </div>

        <div className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Montant de la main-d’œuvre</span>
            <MoneyText value={amount} bold className="text-base" />
          </div>
        </div>

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Enregistrement…
              </>
            ) : (
              'Affecter l’ouvrier'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modales — retrait d'une ligne (matériau / affectation)
 * ------------------------------------------------------------------ */

export function JobRemoveMaterialDialog({
  isOpen,
  onClose,
  onConfirm,
  material,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  material: ServiceJobMaterialRow | null;
  isSubmitting: boolean;
}) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      isSubmitting={isSubmitting}
      tone="warning"
      title="Retirer cette ligne de matériau"
      confirmLabel="Retirer et rendre au stock"
      message={
        <>
          <strong>{material?.productName}</strong> —{' '}
          {formatQuantity(material?.quantity ?? 0, material?.unit)} seront <strong>rendus au stock</strong>{' '}
          par un mouvement « entrée » motivé. Les totaux du chantier sont recalculés aussitôt et
          l’opération est tracée dans le journal d’actions.
        </>
      }
    />
  );
}

export function JobRemoveWorkerDialog({
  isOpen,
  onClose,
  onConfirm,
  assignment,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  assignment: ServiceJobWorkerRow | null;
  isSubmitting: boolean;
}) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      isSubmitting={isSubmitting}
      tone="warning"
      title="Retirer cette affectation"
      confirmLabel="Retirer"
      message={
        <>
          L’affectation de <strong>{assignment?.workerName}</strong> (
          {formatQuantity(assignment?.days ?? 0)} jour(s) × <MoneyText value={assignment?.dailyRate ?? 0} />)
          sera retirée et la main-d’œuvre du chantier recalculée.
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * Modale — annulation motivée (motif obligatoire)
 * ------------------------------------------------------------------ */

export function JobCancelDialog({
  isOpen,
  onClose,
  onConfirm,
  job,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
  job: ServiceJobRow | null;
  isSubmitting: boolean;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setReason('');
    setError(null);
  }, [isOpen]);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={async () => {
        if (!reason.trim()) {
          setError('Le motif d’annulation est obligatoire.');
          return;
        }
        setError(null);
        await onConfirm(reason.trim());
      }}
      isSubmitting={isSubmitting}
      tone="error"
      title="Annuler ce chantier"
      confirmLabel="Annuler le chantier"
      message={
        <>
          Le chantier <strong>{job?.reference}</strong> passera au statut « Annulé ». Il n’est{' '}
          <strong>jamais supprimé</strong> : il reste consultable et réimprimable. Les matériaux
          sortis du stock lui seront <strong>rendus</strong>.
        </>
      }
    >
      <FormField label="Motif de l’annulation" htmlFor="job-cancel-reason" required error={error}>
        <textarea
          id="job-cancel-reason"
          className="textarea textarea-bordered min-h-20 w-full"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
          disabled={isSubmitting}
          placeholder="Ex. le client a annulé la commande le 12/03"
        />
      </FormField>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — encaissement (paiement de prestation)
 * ------------------------------------------------------------------ */

export function JobPaymentModal({
  isOpen,
  onClose,
  job,
  remainingAmount,
  onRecorded,
}: {
  isOpen: boolean;
  onClose: () => void;
  job: ServiceJobRow | null;
  remainingAmount: number;
  onRecorded?: (payment: { id: number; receiptNumber: string }) => void;
}) {
  const { settings } = useSettings();
  const canCreate = usePermission('payments.create');

  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Espèces');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<{ id: number; receiptNumber: string } | null>(null);

  const paymentMethods = useMemo(() => {
    const configured = settings.paymentMethods?.filter((method) => Boolean(method?.trim())) ?? [];
    return configured.length > 0 ? configured : ['Espèces', 'Mobile Money', 'Virement', 'Crédit'];
  }, [settings.paymentMethods]);

  useEffect(() => {
    if (!isOpen) return;
    setAmount(remainingAmount > 0 ? String(remainingAmount) : '');
    setNotes('');
    setDate(today());
    setPaymentMethod('Espèces');
    setFormError(null);
    setReceipt(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, job?.id]);

  const paid = Number(String(amount).replace(',', '.'));
  const remainingAfter = Math.max(remainingAmount - (Number.isFinite(paid) ? paid : 0), 0);

  async function submit() {
    if (!job) return;

    if (!canCreate) {
      setFormError('Vous n’avez pas la permission d’enregistrer un encaissement.');
      return;
    }
    if (!Number.isFinite(paid) || paid <= 0) {
      setFormError('Le montant doit être supérieur à zéro.');
      return;
    }
    if (paid > remainingAmount + 0.01) {
      setFormError(`Le montant dépasse le reste à payer (${formatNumber(remainingAmount)} GNF).`);
      return;
    }
    if (!date) {
      setFormError('La date d’encaissement est obligatoire.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/paiements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          type: 'service_job',
          referenceId: job.id,
          amount: paid,
          paymentMethod,
          date,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Le paiement n'a pas pu être enregistré."));
      }

      const payment = (await response.json()) as { id: number; receiptNumber: string };
      setReceipt({ id: payment.id, receiptNumber: payment.receiptNumber });
      onRecorded?.({ id: payment.id, receiptNumber: payment.receiptNumber });
      toast.success(`Encaissement enregistré — reçu ${payment.receiptNumber}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Le paiement n'a pas pu être enregistré.";
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title="Encaisser sur le chantier"
      size="lg"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-base-200 bg-base-200/50 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {job?.reference} — {job?.customerName ?? 'Client'}
            </p>
            <p className="text-xs text-base-content/60">Reste à payer</p>
          </div>
          {/* Rouge dès qu'il reste à encaisser : `colored` verdissait ce reste. */}
          <MoneyText
            value={remainingAmount}
            remaining={job?.status !== 'cancelled'}
            bold
            className="text-lg"
          />
        </div>

        {receipt ? (
          <div className="space-y-3 rounded-xl border border-success/30 bg-success/10 p-4">
            <p className="text-sm font-medium text-success">
              Paiement enregistré — reçu {receipt.receiptNumber}.
            </p>
            <Link href={`/recus/${receipt.id}`} className="btn btn-success btn-sm min-h-11 sm:min-h-0">
              Voir le reçu
            </Link>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Montant encaissé" htmlFor="job-payment-amount" required>
                <input
                  id="job-payment-amount"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  className="input input-bordered min-h-11 w-full tabular"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setFormError(null);
                  }}
                  disabled={isSubmitting}
                  placeholder="0"
                />
              </FormField>

              <FormField label="Moyen de paiement" htmlFor="job-payment-method">
                <select
                  id="job-payment-method"
                  className="select select-bordered min-h-11 w-full"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                  disabled={isSubmitting}
                >
                  {paymentMethods.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            <FormField label="Date de l’encaissement">
              <DatePicker value={date} onChange={setDate} placeholder="Date" />
            </FormField>

            <FormField label="Note" htmlFor="job-payment-notes">
              <input
                id="job-payment-notes"
                type="text"
                className="input input-bordered min-h-11 w-full"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={isSubmitting}
                placeholder="Ex. acompte de démarrage"
              />
            </FormField>

            <div className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Reste après encaissement</span>
                <MoneyText value={remainingAfter} bold />
              </div>
            </div>
          </>
        )}

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Fermer
          </button>
          {!receipt && (
            <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <span className="loading loading-spinner loading-sm" aria-hidden />
                  Encaissement…
                </>
              ) : (
                'Enregistrer l’encaissement'
              )}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Bloc « coûts et marge » — calculé, jamais stocké
 * ------------------------------------------------------------------ */

export function JobCostCard({ costs }: { costs: JobCosts }) {
  const positive = costs.margin >= 0;
  const rows: [string, number][] = [
    ['Matériaux (prix d’achat)', costs.materialsCost],
    ['Main-d’œuvre (équipe)', costs.laborCost],
    ['Sous-traitance (montants convenus)', costs.subcontractCost],
    ['Autres dépenses du chantier', costs.expensesCost],
  ];
  return (
    <div className="space-y-1">
      <InfoRow label="Montant facturé">
        <MoneyText value={costs.billed} bold />
      </InfoRow>
      <InfoRow label="Encaissé">
        <MoneyText value={costs.collected} />
      </InfoRow>
      <InfoRow label="Reste à recevoir">
        <MoneyText value={costs.remaining} remaining bold />
      </InfoRow>
      <div className="my-2 border-t border-base-200" />
      {rows.map(([label, value]) => (
        <InfoRow key={label} label={label}>
          <MoneyText value={value} />
        </InfoRow>
      ))}
      <InfoRow label="Coûts engagés">
        <MoneyText value={costs.totalCost} bold />
      </InfoRow>
      <div className={`mt-2 flex items-center justify-between rounded-xl px-3 py-2.5 ${positive ? 'bg-success/10' : 'bg-error/10'}`}>
        <span className="text-sm font-semibold">Bénéfice brut estimatif</span>
        <span className={`text-right font-semibold ${positive ? 'text-success' : 'text-error'}`}>
          <MoneyText value={costs.margin} />
          <span className="block text-xs">{costs.billed > 0 ? `marge ${formatPercent(costs.marginPercent)}` : ''}</span>
        </span>
      </div>
      <p className="pt-2 text-xs text-base-content/50">
        Calculé à la lecture : facturé − (matériaux + main-d’œuvre + sous-traitance + dépenses). Les paiements
        aux sous-traitants ne sont pas comptés deux fois : c’est le montant convenu qui compte.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sélecteur d'ouvriers (référentiel partagé)
 * ------------------------------------------------------------------ */

export function JobWorkersManagerButton({ onChanged }: { onChanged?: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const canManage = usePermission('workers.manage');

  if (!canManage) return null;

  return (
    <>
      <ToolbarButton onClick={() => setIsOpen(true)}>Ouvriers</ToolbarButton>
      <WorkersManagerModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onChanged={onChanged}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Devis imprimable / exportable
 * ------------------------------------------------------------------ */

export type DevisCompany = {
  name: string;
  branch: string;
  address: string;
  phone: string;
  email: string;
  taxId: string;
  logo: string;
  currency: string;
  footerNote: string;
};

export function companyFromSettings(settings: {
  companyName: string;
  companyBranch: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyTaxId: string;
  companyLogo: string;
  currency: string;
  invoiceFooterNote: string;
}): DevisCompany {
  return {
    name: settings.companyName || 'Planète Déco Sarlu',
    branch: settings.companyBranch || '',
    address: settings.companyAddress || '',
    phone: settings.companyPhone || '',
    email: settings.companyEmail || '',
    taxId: settings.companyTaxId || '',
    logo: settings.companyLogo || DEFAULT_COMPANY_LOGO,
    currency: settings.currency || 'GNF',
    footerNote: settings.invoiceFooterNote || '',
  };
}

export function JobListSkeleton() {
  return <SkeletonTable rows={6} cols={6} />;
}

export function JobEmptyProviders({ children }: { children: ReactNode }) {
  return <EmptyState title="Chantier introuvable" description="Ce chantier n’existe plus sur ce poste." action={children} />;
}
