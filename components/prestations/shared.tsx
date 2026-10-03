'use client';

import { useEffect, useMemo, useState } from 'react';
import { Combobox } from '@/components/combobox';
import { Badge, MoneyText, type BadgeTone } from '@/components/design-system';
import { CustomerFormModal, type CustomerRecord } from '@/components/clients/clients-modals';
import { usePermission } from '@/components/role-gate';
import { readApiError } from '@/components/workers/workers-modals';
import { formatCurrency, formatQuantity } from '@/lib/format';

/* ==================================================================
 * Prestations de chantier — briques communes aux écrans (catalogue,
 * demandes, devis, chantiers, pilotage).
 *
 * ⚠️ Types et libellés **redéclarés** ici : `lib/services.ts`, `lib/quotes.ts`
 * et `lib/jobs.ts` importent `@/db` ; une seule importation de valeur ferait
 * entrer `@libsql/client` dans le bundle navigateur (AGENTS.md, invariant 6).
 * Ces formes décrivent le JSON des routes `/api/prestations`, `/api/devis`,
 * `/api/demandes` et `/api/chantiers`.
 * ================================================================== */

export { readApiError };

export type Paginated<T> = { data: T[]; total: number; page: number; limit: number; totalPages: number };

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

export type ServiceStatus = 'active' | 'inactive' | 'archived';

export type ServiceRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  code: string;
  name: string;
  category: string;
  description: string | null;
  unit: string;
  unitPrice: number;
  status: ServiceStatus;
  jobsCount: number;
  revenue: number;
  quantity: number;
  createdAt: string | null;
};

export type ServiceDetail = {
  service: ServiceRow;
  priceHistory: { id: number; oldPrice: number; newPrice: number; userName: string | null; date: string }[];
  jobs: {
    jobId: number;
    reference: string;
    customerName: string;
    status: string;
    startDate: string | null;
    quantity: number;
    unit: string;
    unitPrice: number;
    amount: number;
  }[];
  quotesCount: number;
};

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  active: 'Active',
  inactive: 'Désactivée',
  archived: 'Archivée',
};
export const SERVICE_STATUS_TONES: Record<ServiceStatus, BadgeTone> = {
  active: 'success',
  inactive: 'warning',
  archived: 'neutral',
};

/** Unités proposées (le champ reste libre : « voyage », « point lumineux »…). */
export const SERVICE_UNITS = ['forfait', 'm²', 'm³', 'mètre', 'heure', 'jour', 'unité', 'point', 'pièce'];

/* ------------------------------------------------------------------ *
 * Demandes
 * ------------------------------------------------------------------ */

export type RequestStatus =
  | 'new'
  | 'study'
  | 'visit'
  | 'quote_to_prepare'
  | 'quote_sent'
  | 'accepted'
  | 'refused'
  | 'converted';

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  new: 'Nouvelle',
  study: 'À l’étude',
  visit: 'Visite prévue',
  quote_to_prepare: 'Devis à préparer',
  quote_sent: 'Devis envoyé',
  accepted: 'Acceptée',
  refused: 'Refusée',
  converted: 'Convertie en chantier',
};
export const REQUEST_STATUS_TONES: Record<RequestStatus, BadgeTone> = {
  new: 'info',
  study: 'warning',
  visit: 'warning',
  quote_to_prepare: 'primary',
  quote_sent: 'primary',
  accepted: 'success',
  refused: 'error',
  converted: 'success',
};
/** Étapes du rail d'une demande (le refus est traité à part). */
export const REQUEST_STAGES: { key: RequestStatus; label: string }[] = [
  { key: 'new', label: 'Nouvelle' },
  { key: 'study', label: 'Étude' },
  { key: 'visit', label: 'Visite' },
  { key: 'quote_to_prepare', label: 'Devis à préparer' },
  { key: 'quote_sent', label: 'Devis envoyé' },
  { key: 'accepted', label: 'Acceptée' },
  { key: 'converted', label: 'Chantier' },
];

export type ServiceRequestRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  reference: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  date: string;
  need: string;
  siteAddress: string | null;
  desiredDate: string | null;
  status: RequestStatus;
  services: { serviceId: number | null; serviceName: string }[];
  quoteId: number | null;
  quoteReference: string | null;
  jobId: number | null;
  jobReference: string | null;
  userName: string | null;
  notes: string | null;
  createdAt: string | null;
};

export type RequestsSummary = { total: number; pending: number; byStatus: Record<RequestStatus, number> };

/* ------------------------------------------------------------------ *
 * Devis
 * ------------------------------------------------------------------ */

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'refused' | 'cancelled';
export type QuoteDisplayStatus = QuoteStatus | 'expired';

export const QUOTE_LABELS: Record<QuoteDisplayStatus, string> = {
  draft: 'Brouillon',
  sent: 'Envoyé',
  accepted: 'Accepté',
  refused: 'Refusé',
  cancelled: 'Annulé',
  expired: 'Expiré',
};
export const QUOTE_TONES: Record<QuoteDisplayStatus, BadgeTone> = {
  draft: 'neutral',
  sent: 'info',
  accepted: 'success',
  refused: 'error',
  cancelled: 'error',
  expired: 'warning',
};

export type QuoteRow = {
  id: number;
  storeId: number;
  storeName: string | null;
  reference: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  requestId: number | null;
  requestReference: string | null;
  date: string;
  validUntil: string | null;
  category: string | null;
  title: string | null;
  siteAddress: string | null;
  description: string | null;
  status: QuoteStatus;
  displayStatus: QuoteDisplayStatus;
  total: number;
  itemsCount: number;
  jobId: number | null;
  jobReference: string | null;
  cancelReason: string | null;
  userName: string | null;
  notes: string | null;
  createdAt: string | null;
};

export type QuoteItemRow = {
  id: number;
  serviceId: number | null;
  serviceCode: string | null;
  serviceName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  grossAmount: number;
  amount: number;
  position: number;
};

export type QuotesSummary = {
  total: number;
  byStatus: Record<QuoteDisplayStatus, number>;
  pendingCount: number;
  pendingAmount: number;
  acceptedAmount: number;
  acceptanceRate: number;
};

/* ------------------------------------------------------------------ *
 * Badges
 * ------------------------------------------------------------------ */

export function QuoteStatusBadge({ status }: { status: QuoteDisplayStatus }) {
  return <Badge tone={QUOTE_TONES[status] ?? 'neutral'}>{QUOTE_LABELS[status] ?? status}</Badge>;
}

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return <Badge tone={REQUEST_STATUS_TONES[status] ?? 'neutral'}>{REQUEST_STATUS_LABELS[status] ?? status}</Badge>;
}

export function ServiceStatusBadge({ status }: { status: ServiceStatus }) {
  return <Badge tone={SERVICE_STATUS_TONES[status] ?? 'neutral'}>{SERVICE_STATUS_LABELS[status] ?? status}</Badge>;
}

/** Barre d'avancement accessible : le pourcentage est **écrit**, jamais porté par la seule couleur. */
export function ProgressBar({ value, late = false, className = '' }: { value: number; late?: boolean; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const tone = pct >= 100 ? 'bg-success' : late ? 'bg-error' : 'bg-primary';
  return (
    <div className={`flex items-center gap-2 ${className}`.trim()}>
      <div
        className="h-2 min-w-[3rem] flex-1 overflow-hidden rounded-full bg-base-300"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Avancement ${pct} %`}
      >
        <div className={`h-full rounded-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-xs font-semibold tabular">{pct} %</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Données d'appoint
 * ------------------------------------------------------------------ */

export type CustomerOption = { id: number; name: string; phone: string | null };
export type ResponsibleOption = { id: number; name: string; role: string };

/** Prestations **actives** du magasin actif : les seules utilisables dans un document. */
export function useActiveServices(enabled = true) {
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setIsLoading(true);
    fetch('/api/prestations?status=active&limit=500', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as Paginated<ServiceRow>) : { data: [] }))
      .then((payload) => setServices(Array.isArray(payload.data) ? payload.data : []))
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [enabled]);
  return { services, isLoading };
}

/** Clients (référentiel commun à tous les magasins). */
export function useCustomers(enabled = true) {
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setIsLoading(true);
    fetch('/api/clients?limit=500&page=1&sort=name', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as Paginated<CustomerOption>) : { data: [] }))
      .then((payload) => setCustomers(Array.isArray(payload.data) ? payload.data : []))
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [enabled, token]);
  return { customers, isLoading, reload: () => setToken((t) => t + 1), add: (c: CustomerOption) => setCustomers((list) => [c, ...list]) };
}

/** Responsables possibles d'un chantier du magasin actif. */
export function useResponsibles(enabled = true) {
  const [people, setPeople] = useState<ResponsibleOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch('/api/chantiers/responsables', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { data: ResponsibleOption[] }) : { data: [] }))
      .then((payload) => setPeople(payload.data ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return people;
}

/* ------------------------------------------------------------------ *
 * Choix du client, avec création sur place
 * ------------------------------------------------------------------ */

/**
 * Le client se choisit dans le **référentiel commun** ; s'il n'existe pas
 * encore, « Nouveau client » le crée sans quitter le formulaire, et il servira
 * ensuite aussi bien aux ventes qu'aux chantiers de tous les magasins.
 */
export function CustomerPicker({
  id,
  value,
  onChange,
  customers,
  isLoading,
  onCreated,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  customers: CustomerOption[];
  isLoading: boolean;
  onCreated: (customer: CustomerOption) => void;
  disabled?: boolean;
}) {
  const canCreate = usePermission('customers.create');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const options = useMemo(
    () => customers.map((c) => ({ value: String(c.id), label: c.name, hint: c.phone ?? undefined })),
    [customers],
  );
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <div className="min-w-0 flex-1">
        {isLoading && customers.length === 0 ? (
          <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
        ) : (
          <Combobox
            id={id}
            value={value}
            onChange={onChange}
            options={options}
            placeholder="Rechercher un client (nom, téléphone)…"
            emptyLabel="Aucun client ne correspond"
            ariaLabel="Client"
            disabled={disabled}
          />
        )}
      </div>
      {canCreate && (
        <button
          type="button"
          className="btn btn-ghost min-h-11 shrink-0 border border-base-300"
          onClick={() => setIsCreateOpen(true)}
          disabled={disabled}
        >
          Nouveau client
        </button>
      )}
      <CustomerFormModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        idPrefix={`${id}-new`}
        onSaved={(customer: CustomerRecord) => {
          const option = { id: customer.id, name: customer.name, phone: customer.phone ?? null };
          onCreated(option);
          onChange(String(customer.id));
          setIsCreateOpen(false);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Éditeur de lignes de prestations
 * ------------------------------------------------------------------ */

export type LineDraft = {
  key: string;
  serviceId: string;
  quantity: string;
  /** Vide = prix du catalogue. */
  unitPrice: string;
  discountPercent: string;
};

let lineCounter = 0;
export function newLine(partial: Partial<LineDraft> = {}): LineDraft {
  lineCounter += 1;
  return { key: `l${Date.now()}-${lineCounter}`, serviceId: '', quantity: '1', unitPrice: '', discountPercent: '', ...partial };
}

const num = (value: string) => {
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/** Montant d'une ligne — même formule que le serveur (`lineAmount`). */
export function lineAmount(quantity: number, unitPrice: number, discountPercent: number): number {
  const discount = Math.min(100, Math.max(0, discountPercent || 0));
  return Math.round(quantity * unitPrice * (1 - discount / 100) * 100) / 100;
}

export function resolveLine(line: LineDraft, services: ServiceRow[]) {
  const service = services.find((s) => String(s.id) === line.serviceId) ?? null;
  const quantity = num(line.quantity);
  const unitPrice = line.unitPrice.trim() === '' ? (service?.unitPrice ?? 0) : num(line.unitPrice);
  const discountPercent = num(line.discountPercent);
  return { service, quantity, unitPrice, discountPercent, amount: lineAmount(quantity, unitPrice, discountPercent) };
}

/** Lignes prêtes pour l'API (lignes sans prestation ignorées). */
export function linesPayload(lines: LineDraft[]) {
  return lines
    .filter((line) => line.serviceId)
    .map((line) => ({
      serviceId: Number(line.serviceId),
      quantity: num(line.quantity),
      unitPrice: line.unitPrice.trim() === '' ? null : num(line.unitPrice),
      discountPercent: num(line.discountPercent),
    }));
}

/**
 * Saisie des prestations d'un devis ou d'un chantier.
 *
 * Desktop : une grille alignée (prestation, quantité, prix, remise, montant).
 * Mobile : une carte par ligne, champs empilés — aucune table qui déborde.
 * Le prix est prérempli depuis le **catalogue du magasin** et reste
 * négociable ; le serveur le fige dans la ligne.
 */
export function ServiceLinesEditor({
  lines,
  onChange,
  services,
  isLoading,
  disabled,
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  services: ServiceRow[];
  isLoading?: boolean;
  disabled?: boolean;
}) {
  const options = useMemo(
    () =>
      services.map((s) => ({
        value: String(s.id),
        label: `${s.name}`,
        hint: `${s.code} · ${formatCurrency(s.unitPrice)} / ${s.unit}`,
      })),
    [services],
  );
  const update = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const remove = (key: string) => onChange(lines.filter((line) => line.key !== key));
  const total = lines.reduce((sum, line) => sum + resolveLine(line, services).amount, 0);

  if (!isLoading && services.length === 0) {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
        Le catalogue de ce magasin n’a encore aucune prestation active. Créez-en depuis la page{' '}
        <a href="/prestations" className="link font-medium">
          Prestations
        </a>{' '}
        avant d’établir un devis.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="hidden grid-cols-[minmax(0,1fr)_6rem_8.5rem_5.5rem_8.5rem_2.75rem] gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-base-content/50 lg:grid">
        <span>Prestation</span>
        <span className="text-right">Quantité</span>
        <span className="text-right">Prix unitaire</span>
        <span className="text-right">Remise %</span>
        <span className="text-right">Montant</span>
        <span className="sr-only">Retirer</span>
      </div>

      {lines.map((line, index) => {
        const resolved = resolveLine(line, services);
        return (
          <div
            key={line.key}
            className="grid gap-2 rounded-xl border border-base-200 bg-base-200/30 p-3 lg:grid-cols-[minmax(0,1fr)_6rem_8.5rem_5.5rem_8.5rem_2.75rem] lg:items-center lg:border-0 lg:bg-transparent lg:p-1"
          >
            <div className="min-w-0">
              <span className="mb-1 block text-xs font-medium text-base-content/60 lg:hidden">Prestation {index + 1}</span>
              <Combobox
                id={`line-${line.key}`}
                value={line.serviceId}
                onChange={(value) => update(line.key, { serviceId: value, unitPrice: '' })}
                options={options}
                placeholder={isLoading ? 'Chargement du catalogue…' : 'Choisir une prestation…'}
                emptyLabel="Aucune prestation ne correspond"
                ariaLabel={`Prestation de la ligne ${index + 1}`}
                disabled={disabled}
              />
              {resolved.service && (
                <span className="mt-1 block truncate text-xs text-base-content/55">
                  {resolved.service.category} · par {resolved.service.unit}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 lg:contents">
              <label className="lg:block">
                <span className="mb-1 block text-xs text-base-content/60 lg:sr-only">Quantité</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  className="input input-bordered min-h-11 w-full text-right tabular"
                  value={line.quantity}
                  onChange={(event) => update(line.key, { quantity: event.target.value })}
                  aria-label={`Quantité de la ligne ${index + 1}`}
                  disabled={disabled}
                />
              </label>
              <label className="lg:block">
                <span className="mb-1 block text-xs text-base-content/60 lg:sr-only">Prix unitaire</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  className="input input-bordered min-h-11 w-full text-right tabular"
                  value={line.unitPrice}
                  placeholder={resolved.service ? String(resolved.service.unitPrice) : '0'}
                  onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                  aria-label={`Prix unitaire de la ligne ${index + 1}`}
                  disabled={disabled}
                />
              </label>
              <label className="lg:block">
                <span className="mb-1 block text-xs text-base-content/60 lg:sr-only">Remise %</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100"
                  step="any"
                  className="input input-bordered min-h-11 w-full text-right tabular"
                  value={line.discountPercent}
                  placeholder="0"
                  onChange={(event) => update(line.key, { discountPercent: event.target.value })}
                  aria-label={`Remise de la ligne ${index + 1}`}
                  disabled={disabled}
                />
              </label>
            </div>
            <div className="flex items-center justify-between gap-2 lg:contents">
              <span className="text-xs text-base-content/60 lg:hidden">
                {formatQuantity(resolved.quantity, resolved.service?.unit ?? '')}
              </span>
              <MoneyText value={resolved.amount} bold className="text-right lg:block" />
              <button
                type="button"
                className="btn btn-ghost btn-square min-h-11 min-w-11 text-error"
                onClick={() => remove(line.key)}
                aria-label={`Retirer la ligne ${index + 1}`}
                disabled={disabled || lines.length <= 1}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-200 pt-3">
        <button
          type="button"
          className="btn btn-ghost min-h-11 border border-dashed border-base-300"
          onClick={() => onChange([...lines, newLine()])}
          disabled={disabled}
        >
          + Ajouter une prestation
        </button>
        <div className="text-right">
          <span className="block text-xs uppercase tracking-wide text-base-content/55">Total</span>
          <MoneyText value={total} bold className="text-xl" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Historique des modifications d'un document
 * ------------------------------------------------------------------ */

type AuditEntry = {
  id: number;
  userName: string;
  storeName: string | null;
  action: string;
  details: string | null;
  createdAt: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  create: 'Création',
  update: 'Modification',
  cancel: 'Annulation',
  validate: 'Validation',
  reject: 'Refus',
  payment: 'Encaissement',
  approve: 'Approbation',
};

const FIELD_LABELS: Record<string, string> = {
  name: 'Nom',
  code: 'Code',
  category: 'Catégorie',
  unit: 'Unité',
  unitPrice: 'Prix',
  description: 'Description',
  title: 'Intitulé',
  siteAddress: 'Adresse',
  startDate: 'Début prévu',
  endDate: 'Fin prévue',
  actualStartDate: 'Début réel',
  actualEndDate: 'Fin réelle',
  progress: 'Avancement',
  responsibleUserId: 'Responsable',
  notes: 'Notes',
  amount: 'Montant',
  status: 'Statut',
  validUntil: 'Validité',
  date: 'Date',
  items: 'Prestations',
  customerId: 'Client',
  need: 'Besoin',
  desiredDate: 'Date souhaitée',
  serviceIds: 'Prestations souhaitées',
  total: 'Total',
  lines: 'Lignes',
  customer: 'Client',
};

const STATUS_WORDS: Record<string, string> = {
  pending: 'en préparation',
  planned: 'planifié',
  in_progress: 'en cours',
  suspended: 'suspendu',
  completed: 'terminé',
  cancelled: 'annulé',
  todo: 'à faire',
  done: 'terminée',
  blocked: 'bloquée',
  new: 'nouvelle',
  study: 'à l’étude',
  visit: 'visite prévue',
  quote_to_prepare: 'devis à préparer',
  refused: 'refusée',
};

function money(value: unknown): string {
  return formatCurrency(Number(value) || 0);
}

/** Traduit le détail JSON d'une entrée du journal en phrases lisibles. */
export function describeAudit(details: string | null): string[] {
  if (!details) return [];
  let data: Record<string, any>;
  try {
    data = JSON.parse(details);
  } catch {
    return [details];
  }
  const lines: string[] = [];
  const word = (value: unknown) => STATUS_WORDS[String(value)] ?? String(value);
  if (data.changes && typeof data.changes === 'object') {
    for (const [key, change] of Object.entries<any>(data.changes)) {
      const label = FIELD_LABELS[key] ?? key;
      const fmt = (v: unknown) => (key === 'unitPrice' ? money(v) : v === null || v === '' ? '—' : String(v));
      lines.push(`${label} : ${fmt(change?.from)} → ${fmt(change?.to)}`);
    }
  }
  if (data.addedService !== undefined && data.total !== undefined) lines.push(`Prestation ajoutée — nouveau total ${money(data.total)}`);
  if (data.updatedLine !== undefined) lines.push(`Ligne modifiée — nouveau total ${money(data.total)}`);
  if (data.removedService) lines.push(`Prestation retirée : ${data.removedService} (${money(data.amount)})`);
  if (data.addedStage) lines.push(`Étape ajoutée : ${data.addedStage}`);
  if (data.stage) lines.push(`Étape « ${data.stage} » : ${data.progress ?? 0} % (${word(data.stageStatus)})`);
  if (data.removedStage) lines.push(`Étape retirée : ${data.removedStage}`);
  if (data.addedWorker) lines.push(`Ouvrier affecté : ${data.addedWorker} — ${data.days} j`);
  if (data.addedTeam) lines.push(`Équipe affectée : ${data.addedTeam} (${data.members} ouvriers, ${data.days} j)`);
  if (data.subcontractor) lines.push(`Sous-traitance : ${data.subcontractor}${data.work ? ` — ${data.work}` : ''}${data.agreedAmount !== undefined ? ` (${money(data.agreedAmount)})` : ''}`);
  if (data.convertedTo) lines.push(`Converti en chantier ${data.convertedTo}`);
  if (data.fromQuote) lines.push(`Ouvert depuis le devis ${data.fromQuote}`);
  if (data.duplicatedFrom) lines.push('Nouvelle version d’un devis');
  if (data.reason) lines.push(`Motif : ${data.reason}`);
  if (data.status && !data.changes) lines.push(`Statut : ${word(data.status)}`);
  if (Array.isArray(data.fields) && data.fields.length) {
    lines.push(`Champs modifiés : ${data.fields.map((f: string) => FIELD_LABELS[f] ?? f).join(', ')}`);
  }
  if (data.unitPrice !== undefined && !data.changes && data.name) lines.push(`${data.name} — ${money(data.unitPrice)} / ${data.unit ?? ''}`);
  if (lines.length === 0) {
    for (const [key, value] of Object.entries(data)) {
      if (key === 'reference' || value === null || typeof value === 'object') continue;
      const label = FIELD_LABELS[key] ?? key;
      lines.push(`${label} : ${key === 'total' || key === 'amount' ? money(value) : word(value)}`);
    }
  }
  return lines;
}

/** Fil chronologique des modifications d'un document (lecture : `jobs.view`). */
export function HistoryTimeline({ entity, id }: { entity: 'service_job' | 'quote' | 'service' | 'service_request'; id: number }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/historique?entity=${entity}&id=${id}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Historique indisponible.'));
        return (await response.json()) as { data: AuditEntry[] };
      })
      .then((payload) => setEntries(payload.data ?? []))
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Historique indisponible.');
      });
    return () => controller.abort();
  }, [entity, id]);

  if (error) return <p className="rounded-xl bg-error/10 px-4 py-3 text-sm text-error">{error}</p>;
  if (!entries) return <div className="h-24 animate-pulse rounded-xl bg-base-300/50" />;
  if (entries.length === 0) {
    return <p className="rounded-xl border border-base-200 bg-base-200/30 px-4 py-3 text-sm text-base-content/60">Aucune modification enregistrée.</p>;
  }
  return (
    <ol className="relative space-y-4 border-l border-base-300 pl-5">
      {entries.map((entry) => (
        <li key={entry.id} className="relative">
          <span className="absolute -left-[1.6rem] top-1 h-3 w-3 rounded-full border-2 border-base-100 bg-primary" aria-hidden />
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-semibold">{ACTION_LABELS[entry.action] ?? entry.action}</span>
            <span className="text-base-content/60">par {entry.userName}</span>
            <span className="text-xs text-base-content/50 tabular">
              {entry.createdAt ? new Date(entry.createdAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : ''}
            </span>
          </div>
          {describeAudit(entry.details).map((line, index) => (
            <p key={index} className="text-sm text-base-content/70">
              {line}
            </p>
          ))}
        </li>
      ))}
    </ol>
  );
}
