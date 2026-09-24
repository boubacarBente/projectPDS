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

export type JobCategory = 'alucobond' | 'staff' | 'placo' | 'furniture' | 'painting';
export type JobStatus = 'quote' | 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'refused';

export type ServiceJobRow = {
  id: number;
  reference: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  category: JobCategory;
  title: string | null;
  siteAddress: string | null;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
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
  notes: string | null;
  materialsCount: number;
  workersCount: number;
  createdAt: string | null;
};

export type ServiceJobMaterialRow = {
  id: number;
  jobId: number;
  productId: number | null;
  productCode: string;
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

export type JobCosts = {
  materialsCost: number;
  laborCost: number;
  totalCost: number;
  billed: number;
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
  materials: ServiceJobMaterialRow[];
  workers: ServiceJobWorkerRow[];
  payments: PaymentRow[];
  costs: JobCosts;
};

export type JobsSummary = {
  totalJobs: number;
  byStatus: Record<JobStatus, number>;
  billed: number;
  collected: number;
  outstanding: number;
  materialsCost: number;
  laborCost: number;
  totalCost: number;
  margin: number;
  marginPercent: number;
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

export const JOB_CATEGORY_LABELS: Record<JobCategory, string> = {
  alucobond: 'Alucobond',
  staff: 'Staff',
  placo: 'Placo',
  furniture: 'Meuble',
  painting: 'Peinture',
};

export const JOB_CATEGORY_OPTIONS: { value: JobCategory; label: string }[] = (
  ['alucobond', 'staff', 'placo', 'furniture', 'painting'] as JobCategory[]
).map((value) => ({ value, label: JOB_CATEGORY_LABELS[value] }));

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  quote: 'Devis',
  pending: 'En attente',
  in_progress: 'En cours',
  completed: 'Terminé',
  cancelled: 'Annulé',
};

export const JOB_STATUS_TONES: Record<JobStatus, BadgeTone> = {
  quote: 'neutral',
  pending: 'warning',
  in_progress: 'info',
  completed: 'success',
  cancelled: 'error',
};

export const JOB_STATUS_OPTIONS: { value: JobStatus; label: string }[] = (
  ['quote', 'pending', 'in_progress', 'completed', 'cancelled'] as JobStatus[]
).map((value) => ({ value, label: JOB_STATUS_LABELS[value] }));

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Brouillon',
  sent: 'Envoyé',
  accepted: 'Accepté',
  refused: 'Refusé',
};

export const QUOTE_STATUS_TONES: Record<QuoteStatus, BadgeTone> = {
  draft: 'neutral',
  sent: 'info',
  accepted: 'success',
  refused: 'error',
};

export const QUOTE_STATUS_OPTIONS: { value: QuoteStatus; label: string }[] = (
  ['draft', 'sent', 'accepted', 'refused'] as QuoteStatus[]
).map((value) => ({ value, label: QUOTE_STATUS_LABELS[value] }));

export function jobCategoryLabel(category: string | null | undefined): string {
  if (!category) return '—';
  return JOB_CATEGORY_LABELS[category as JobCategory] ?? category;
}

export function jobStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return JOB_STATUS_LABELS[status as JobStatus] ?? status;
}

export function quoteStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return QUOTE_STATUS_LABELS[status as QuoteStatus] ?? status;
}

/** Étapes de suivi : `cancelled` est traité **à part** (§19). */
export const JOB_STAGES = [
  { key: 'quote', label: 'Devis' },
  { key: 'pending', label: 'En attente' },
  { key: 'in_progress', label: 'En cours' },
  { key: 'completed', label: 'Terminé' },
];

/** Prochaine étape d'avancement, ou `null` si le chantier est terminé/annulé. */
export function nextJobStage(status: JobStatus): { key: JobStatus; label: string } | null {
  const index = JOB_STAGES.findIndex((stage) => stage.key === status);
  if (index < 0 || index >= JOB_STAGES.length - 1) return null;
  return JOB_STAGES[index + 1] as { key: JobStatus; label: string };
}

/* ------------------------------------------------------------------ *
 * Options de sélection (clients, produits, ouvriers)
 * ------------------------------------------------------------------ */

export type CustomerOption = { id: number; name: string; phone: string | null };

export type ProductOption = {
  id: number;
  code: string;
  name: string;
  unit: string;
  purchasePrice: number;
  stock: number;
  categoryKind: string | null;
};

/**
 * Charge une seule fois les listes d'appoint (clients, produits, ouvriers) et
 * les expose aux modales. Aucune de ces listes n'est critique : un échec laisse
 * simplement la sélection vide, sans masquer la page.
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
        const [customersResponse, productsResponse, workersResponse] = await Promise.all([
          fetch('/api/clients?limit=500&page=1', {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'same-origin',
          }),
          fetch('/api/produits?limit=500&page=1', {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'same-origin',
          }),
          fetch('/api/workers?limit=200&page=1', {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'same-origin',
          }),
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
              code: String(product.code ?? ''),
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

export const jobColumns: Column<ServiceJobRow>[] = [
  {
    key: 'reference',
    label: 'Référence',
    primary: true,
    render: (job) => (
      <div className="min-w-0">
        <Link
          href={`/chantiers/${job.id}`}
          className="font-semibold text-primary hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {job.reference}
        </Link>
        {job.title && <div className="truncate text-xs text-base-content/50">{job.title}</div>}
      </div>
    ),
  },
  {
    key: 'customer',
    label: 'Client',
    render: (job) => <span className="text-sm">{job.customerName}</span>,
  },
  {
    key: 'category',
    label: 'Catégorie',
    render: (job) => <Badge tone="primary">{jobCategoryLabel(job.category)}</Badge>,
  },
  {
    key: 'site',
    label: 'Site',
    hideOnMobile: true,
    className: 'max-w-[14rem] truncate',
    render: (job) => <span title={job.siteAddress ?? ''}>{job.siteAddress || '—'}</span>,
  },
  {
    key: 'startDate',
    label: 'Début',
    className: 'whitespace-nowrap',
    render: (job) => (
      <span className="tabular text-base-content/70">{formatDateShort(job.startDate)}</span>
    ),
  },
  {
    key: 'status',
    label: 'Statut',
    render: (job) => <Badge tone={JOB_STATUS_TONES[job.status]}>{jobStatusLabel(job.status)}</Badge>,
  },
  {
    key: 'progress',
    label: 'Avancement',
    hideOnMobile: true,
    render: (job) => (
      <div className="flex flex-col gap-1">
        <Badge tone={QUOTE_STATUS_TONES[job.quoteStatus]}>
          Devis : {quoteStatusLabel(job.quoteStatus)}
        </Badge>
        <span className="text-xs text-base-content/50">
          {job.materialsCount} matériau(x) · {job.workersCount} ouvrier(s)
        </span>
      </div>
    ),
  },
  {
    key: 'total',
    label: 'Total',
    className: 'text-right whitespace-nowrap',
    render: (job) => <MoneyText value={job.total} bold />,
  },
  {
    key: 'paid',
    label: 'Payé',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (job) => <MoneyText value={job.amountPaid} />,
  },
  {
    key: 'remaining',
    label: 'Reste',
    className: 'text-right whitespace-nowrap',
    render: (job) => <MoneyText value={job.remainingAmount} colored bold />,
  },
];

export const jobMaterialColumns: Column<ServiceJobMaterialRow>[] = [
  {
    key: 'product',
    label: 'Produit',
    primary: true,
    render: (material) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{material.productName}</div>
        <div className="font-mono text-xs text-base-content/50">{material.productCode}</div>
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
    label: 'Montant',
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
          {assignment.role || 'Rôle non précisé'}
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
    label: 'Montant',
    className: 'text-right whitespace-nowrap',
    render: (assignment) => <MoneyText value={assignment.amount} bold />,
  },
];

export const jobPaymentColumns: Column<PaymentRow>[] = [
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
    key: 'date',
    label: 'Date',
    className: 'whitespace-nowrap',
    render: (payment) => (
      <span className="tabular text-base-content/70">{formatDateShort(payment.date)}</span>
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
 * Modale — nouveau devis / nouvelle prestation / modification
 * ------------------------------------------------------------------ */

export function JobFormModal({
  isOpen,
  onClose,
  onSaved,
  job,
  customers,
  isOptionsLoading,
  initial,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (job: ServiceJobRow) => void;
  /** `null` = création. */
  job: ServiceJobRow | null;
  customers: CustomerOption[];
  isOptionsLoading: boolean;
  /** Preset à la création : « Nouveau devis » ou « Nouvelle prestation ». */
  initial?: { status?: JobStatus; quoteStatus?: QuoteStatus };
}) {
  const [customerId, setCustomerId] = useState('');
  const [category, setCategory] = useState<JobCategory>('placo');
  const [title, setTitle] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState<JobStatus>('quote');
  const [quoteStatus, setQuoteStatus] = useState<QuoteStatus>('draft');
  const [quoteMaterials, setQuoteMaterials] = useState('');
  const [quoteLabor, setQuoteLabor] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setCustomerId(job ? String(job.customerId) : '');
    setCategory(job?.category ?? 'placo');
    setTitle(job?.title ?? '');
    setSiteAddress(job?.siteAddress ?? '');
    setDescription(job?.description ?? '');
    setStartDate(job?.startDate ?? '');
    setEndDate(job?.endDate ?? '');
    setStatus(job?.status === 'cancelled' ? 'cancelled' : (job?.status ?? initial?.status ?? 'quote'));
    setQuoteStatus(job?.quoteStatus ?? initial?.quoteStatus ?? 'draft');
    setQuoteMaterials(job ? String(job.quoteMaterials) : '');
    setQuoteLabor(job ? String(job.quoteLabor) : '');
    setNotes(job?.notes ?? '');
    setFormError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, job]);

  const estimate =
    (Number(String(quoteMaterials).replace(',', '.')) || 0) +
    (Number(String(quoteLabor).replace(',', '.')) || 0);

  async function submit() {
    if (isSubmitting) return;

    if (!customerId) {
      setFormError('Le client est obligatoire pour un chantier.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(job ? `/api/chantiers/${job.id}` : '/api/chantiers', {
        method: job ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          customerId: Number(customerId),
          category,
          title: title.trim() || null,
          siteAddress: siteAddress.trim() || null,
          description: description.trim() || null,
          startDate: startDate || null,
          endDate: endDate || null,
          status,
          quoteStatus,
          quoteMaterials: Number(String(quoteMaterials).replace(',', '.')) || 0,
          quoteLabor: Number(String(quoteLabor).replace(',', '.')) || 0,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Le chantier n’a pas pu être enregistré.'));
      }

      const saved = (await response.json()) as ServiceJobRow;
      toast.success(job ? 'Chantier modifié.' : `Chantier ${saved.reference} créé.`);
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
      title={
        job
          ? `Modifier ${job.reference}`
          : initial?.quoteStatus === 'accepted'
            ? 'Nouvelle prestation'
            : 'Nouveau devis'
      }
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
          Le <strong>devis</strong> et le <strong>suivi</strong> vivent dans le même document : les
          montants saisis ici sont l’estimation du devis. Dès qu’un matériau ou un ouvrier est
          ajouté, les totaux sont recalculés sur le réalisé.
        </p>

        <FormField label="Client" htmlFor="job-customer" required>
          {isOptionsLoading && customers.length === 0 ? (
            <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
          ) : (
            <select
              id="job-customer"
              className="select select-bordered min-h-11 w-full"
              value={customerId}
              onChange={(event) => {
                setCustomerId(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
            >
              <option value="">— Sélectionner un client —</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                  {customer.phone ? ` — ${customer.phone}` : ''}
                </option>
              ))}
            </select>
          )}
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Catégorie de prestation" htmlFor="job-category" required>
            <select
              id="job-category"
              className="select select-bordered min-h-11 w-full"
              value={category}
              onChange={(event) => setCategory(event.target.value as JobCategory)}
              disabled={isSubmitting}
            >
              {JOB_CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Intitulé du chantier" htmlFor="job-title">
            <input
              id="job-title"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={isSubmitting}
              placeholder="Ex. Habillage façade villa Kipé"
            />
          </FormField>
        </div>

        <FormField label="Adresse du site" htmlFor="job-site">
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
            className="textarea textarea-bordered min-h-24 w-full"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={isSubmitting}
            placeholder="Nature des travaux, contraintes, dimensions…"
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Date de début" hint="Utilisée pour filtrer les périodes.">
            <DatePicker
              value={startDate}
              onChange={setStartDate}
              placeholder="Date de début"
            />
          </FormField>
          <FormField label="Date de fin prévue">
            <DatePicker value={endDate} onChange={setEndDate} placeholder="Date de fin" />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Avancement" htmlFor="job-status">
            <select
              id="job-status"
              className="select select-bordered min-h-11 w-full"
              value={status}
              onChange={(event) => setStatus(event.target.value as JobStatus)}
              disabled={isSubmitting || job?.status === 'cancelled'}
            >
              {JOB_STATUS_OPTIONS.filter((option) => option.value !== 'cancelled').map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Statut du devis" htmlFor="job-quote-status">
            <select
              id="job-quote-status"
              className="select select-bordered min-h-11 w-full"
              value={quoteStatus}
              onChange={(event) => setQuoteStatus(event.target.value as QuoteStatus)}
              disabled={isSubmitting}
            >
              {QUOTE_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Devis — matériaux" hint="Estimation. Recalculée dès le premier matériau.">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={quoteMaterials}
              onChange={(event) => setQuoteMaterials(event.target.value)}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>
          <FormField label="Devis — main-d’œuvre" hint="Estimation. Recalculée dès la première affectation.">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={quoteLabor}
              onChange={(event) => setQuoteLabor(event.target.value)}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>
        </div>

        <div className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Montant du devis estimé</span>
            <MoneyText value={estimate} bold className="text-base" />
          </div>
        </div>

        <FormField label="Notes internes" htmlFor="job-notes">
          <textarea
            id="job-notes"
            className="textarea textarea-bordered min-h-20 w-full"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            disabled={isSubmitting}
          />
        </FormField>

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
              'Créer le chantier'
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
                  {product.code} — {product.name} ({formatQuantity(product.stock, product.unit)} en stock)
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
          <MoneyText value={remainingAmount} colored bold className="text-lg" />
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

export function JobCostCard({ costs, total }: { costs: JobCosts; total: number }) {
  const positive = costs.margin >= 0;

  return (
    <div className="space-y-1">
      <InfoRow label="Coût des matériaux">
        <MoneyText value={costs.materialsCost} />
      </InfoRow>
      <InfoRow label="Main-d’œuvre">
        <MoneyText value={costs.laborCost} />
      </InfoRow>
      <InfoRow label="Coût de revient total">
        <MoneyText value={costs.totalCost} bold />
      </InfoRow>
      <InfoRow label="Montant facturé">
        <MoneyText value={total} bold />
      </InfoRow>
      <InfoRow label="Marge">
        <span className={positive ? 'text-success' : 'text-error'}>
          <MoneyText value={costs.margin} />
          {costs.billed > 0 ? ` (${formatPercent(costs.marginPercent)})` : ''}
        </span>
      </InfoRow>
      <p className="pt-2 text-xs text-base-content/50">
        Coût de revient = matériaux au prix d’achat + main-d’œuvre (jours × tarif). Marge =
        facturé − coût. Ces montants sont <strong>calculés à la lecture</strong>, jamais stockés.
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

/**
 * Le devis est un **document facturable autonome** : son propre numéro, son
 * PDF, ses propres encaissements. Il ne génère jamais de facture de vente
 * (§15, §19) — aucun risque de double comptage du chiffre d'affaires.
 *
 * `id` est l'ancre DOM capturée par `lib/export-document.ts` (PDF / image) : le
 * papier, l'écran et le fichier exporté ne peuvent donc pas diverger.
 */
export function DevisDocument({
  id,
  company,
  job,
  materials,
  workers,
  className = '',
}: {
  id?: string;
  company: DevisCompany;
  job: ServiceJobRow;
  materials: ServiceJobMaterialRow[];
  workers: ServiceJobWorkerRow[];
  className?: string;
}) {
  const materialsTotal = materials.reduce((sum, material) => sum + material.amount, 0);
  const laborTotal = workers.reduce((sum, assignment) => sum + assignment.amount, 0);
  const total = materialsTotal + laborTotal;

  return (
    <div
      id={id}
      className={`mx-auto w-full max-w-4xl rounded-2xl border border-base-200 bg-base-100 p-6 shadow-sm sm:p-8 ${className}`.trim()}
    >
      {/* En-tête entreprise (pas de balise <header> : elle est masquée à l'impression) */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-base-200 pb-5">
        <div className="flex items-start gap-3">
          {company.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={company.logo}
              alt={`Logo ${company.name}`}
              className="h-14 w-14 rounded-xl border border-base-200 object-contain"
            />
          ) : null}
          <div>
            <p className="text-lg font-bold">{company.name}</p>
            {company.branch ? (
              <p className="text-sm text-base-content/60">{company.branch}</p>
            ) : null}
            {company.address ? (
              <p className="text-sm text-base-content/60">{company.address}</p>
            ) : null}
            <p className="text-sm text-base-content/60">
              {[company.phone, company.email].filter(Boolean).join(' · ')}
            </p>
            {company.taxId ? (
              <p className="text-xs text-base-content/50">NIF : {company.taxId}</p>
            ) : null}
          </div>
        </div>

        <div className="text-right">
          <p className="text-xl font-bold tracking-wide text-primary">DEVIS</p>
          <p className="tabular text-sm font-semibold">{job.reference}</p>
          <p className="tabular text-sm text-base-content/60">
            Établi le {formatDateShort(job.createdAt ?? job.startDate)}
          </p>
          <div className="mt-2 flex justify-end">
            <Badge tone={QUOTE_STATUS_TONES[job.quoteStatus]}>
              {quoteStatusLabel(job.quoteStatus)}
            </Badge>
          </div>
        </div>
      </div>

      {/* Client et chantier */}
      <div className="grid gap-4 py-5 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/45">
            Client
          </p>
          <p className="mt-1 font-semibold">{job.customerName}</p>
          {job.customerPhone ? (
            <p className="tabular text-sm text-base-content/60">{job.customerPhone}</p>
          ) : null}
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/45">
            Chantier
          </p>
          <p className="mt-1 font-semibold">{JOB_CATEGORY_LABELS[job.category]}</p>
          {job.title ? <p className="text-sm text-base-content/70">{job.title}</p> : null}
          {job.siteAddress ? (
            <p className="text-sm text-base-content/60">{job.siteAddress}</p>
          ) : null}
          {(job.startDate || job.endDate) && (
            <p className="tabular text-sm text-base-content/60">
              Du {formatDateShort(job.startDate)} au {formatDateShort(job.endDate)}
            </p>
          )}
        </div>
      </div>

      {job.description ? (
        <div className="mb-5 rounded-xl border border-base-200 bg-base-200/40 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/45">
            Description des travaux
          </p>
          <p className="mt-1 whitespace-pre-line text-sm">{job.description}</p>
        </div>
      ) : null}

      {/* Détail matériaux */}
      <div className="mb-5">
        <p className="mb-2 text-sm font-semibold">Matériaux</p>
        {materials.length === 0 ? (
          <p className="rounded-xl border border-base-200 bg-base-200/30 px-4 py-3 text-sm text-base-content/60">
            Aucun matériau enregistré sur ce devis.
          </p>
        ) : (
          <table className="table table-sm w-full">
            <thead>
              <tr className="bg-base-200">
                <th className="font-semibold">Désignation</th>
                <th className="font-semibold">Unité</th>
                <th className="text-right font-semibold">Quantité</th>
                <th className="text-right font-semibold">Prix unitaire</th>
                <th className="text-right font-semibold">Montant</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((material) => (
                <tr key={material.id}>
                  <td>
                    <div className="font-medium">{material.productName}</div>
                    <div className="font-mono text-xs text-base-content/50">{material.productCode}</div>
                  </td>
                  <td className="text-sm">{material.unit}</td>
                  <td className="text-right">
                    <QuantityText value={material.quantity} />
                  </td>
                  <td className="text-right">
                    <MoneyText value={material.unitCost} />
                  </td>
                  <td className="text-right">
                    <MoneyText value={material.amount} bold />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Main-d'œuvre */}
      <div className="mb-5">
        <p className="mb-2 text-sm font-semibold">Main-d’œuvre</p>
        {workers.length === 0 ? (
          <p className="rounded-xl border border-base-200 bg-base-200/30 px-4 py-3 text-sm text-base-content/60">
            Aucune affectation d’équipe enregistrée.
          </p>
        ) : (
          <table className="table table-sm w-full">
            <thead>
              <tr className="bg-base-200">
                <th className="font-semibold">Ouvrier</th>
                <th className="font-semibold">Rôle</th>
                <th className="text-right font-semibold">Jours</th>
                <th className="text-right font-semibold">Tarif / jour</th>
                <th className="text-right font-semibold">Montant</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((assignment) => (
                <tr key={assignment.id}>
                  <td className="font-medium">{assignment.workerName}</td>
                  <td className="text-sm">{assignment.role || '—'}</td>
                  <td className="text-right">
                    <span className="tabular">{formatQuantity(assignment.days)}</span>
                  </td>
                  <td className="text-right">
                    <MoneyText value={assignment.dailyRate} />
                  </td>
                  <td className="text-right">
                    <MoneyText value={assignment.amount} bold />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Totaux */}
      <div className="flex justify-end border-t border-base-200 pt-4">
        <div className="w-full space-y-1 sm:w-80">
          <InfoRow label="Sous-total matériaux">
            <MoneyText value={materialsTotal} />
          </InfoRow>
          <InfoRow label="Sous-total main-d’œuvre">
            <MoneyText value={laborTotal} />
          </InfoRow>
          <div className="flex items-center justify-between border-t border-base-200 pt-2">
            <span className="text-sm font-semibold">Total du devis</span>
            <MoneyText value={total} bold className="text-base" />
          </div>
          {job.amountPaid > 0 ? (
            <>
              <InfoRow label="Déjà encaissé">
                <MoneyText value={job.amountPaid} />
              </InfoRow>
              <InfoRow label="Reste à payer">
                <MoneyText value={Math.max(total - job.amountPaid, 0)} colored bold />
              </InfoRow>
            </>
          ) : null}
        </div>
      </div>

      <p className="mt-6 border-t border-base-200 pt-4 text-center text-xs text-base-content/50">
        {company.footerNote || 'Devis valable 30 jours. Merci pour votre confiance.'}
      </p>
    </div>
  );
}

export function JobListSkeleton() {
  return <SkeletonTable rows={6} cols={6} />;
}

export function JobEmptyProviders({ children }: { children: ReactNode }) {
  return <EmptyState title="Chantier introuvable" description="Ce chantier n’existe plus sur ce poste." action={children} />;
}
