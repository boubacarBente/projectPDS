'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { DatePicker } from '@/components/date-picker';
import { Combobox } from '@/components/combobox';
import { FormField, MoneyText } from '@/components/design-system';
import { useSettings } from '@/app/parametres/page';
import { formatCurrency, today } from '@/lib/format';
import {
  lineAmount,
  readApiError,
  useActiveServices,
  type ServiceRow,
} from '@/components/prestations/shared';
import type {
  JobStageRow,
  JobSubcontractRow,
  ServiceJobItemRow,
  StageStatus,
} from '@/components/chantiers/chantiers-modals';

/* ==================================================================
 * Modales des onglets de la fiche chantier : prestations, étapes,
 * sous-traitance, dépenses, équipe. Chacune écrit dans le **magasin actif** ;
 * le serveur refuse tout ce qui viendrait d'un autre magasin.
 * ================================================================== */

async function send(url: string, method: string, body: unknown, fallback: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await readApiError(response, fallback));
    return true;
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : fallback, { autoClose: 8000 });
    return false;
  }
}

function Footer({ onClose, isSubmitting, label }: { onClose: () => void; isSubmitting: boolean; label: string }) {
  return (
    <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
      <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
        Annuler
      </button>
      <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
        {isSubmitting ? <span className="loading loading-spinner loading-sm" aria-hidden /> : label}
      </button>
    </div>
  );
}

const num = (value: string) => Number(String(value).replace(/\s/g, '').replace(',', '.'));

/* ------------------------------------------------------------------ *
 * Ligne de prestation
 * ------------------------------------------------------------------ */

export function JobItemModal({
  isOpen,
  onClose,
  jobId,
  item,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  jobId: number;
  /** `null` = ajout. */
  item: ServiceJobItemRow | null;
  onSaved: () => void;
}) {
  const { services, isLoading } = useActiveServices(isOpen && !item);
  const [serviceId, setServiceId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [discount, setDiscount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setServiceId('');
    setQuantity(item ? String(item.quantity) : '1');
    setUnitPrice(item ? String(item.unitPrice) : '');
    setDiscount(item?.discountPercent ? String(item.discountPercent) : '');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, item]);

  const service: ServiceRow | null = services.find((s) => String(s.id) === serviceId) ?? null;
  const price = unitPrice === '' ? (service?.unitPrice ?? item?.unitPrice ?? 0) : num(unitPrice);
  const amount = lineAmount(num(quantity) || 0, price || 0, num(discount) || 0);
  const options = useMemo(
    () => services.map((s) => ({ value: String(s.id), label: s.name, hint: `${formatCurrency(s.unitPrice)} / ${s.unit}` })),
    [services],
  );

  async function submit() {
    if (!item && !serviceId) return setFormError('Choisissez une prestation du catalogue.');
    if (!(num(quantity) > 0)) return setFormError('La quantité doit être positive.');
    setFormError(null);
    setIsSubmitting(true);
    const body = {
      ...(item ? {} : { serviceId: Number(serviceId) }),
      quantity: num(quantity),
      unitPrice: unitPrice === '' ? (item ? item.unitPrice : null) : num(unitPrice),
      discountPercent: num(discount) || 0,
    };
    const ok = await send(
      item ? `/api/chantiers/${jobId}/prestations?itemId=${item.id}` : `/api/chantiers/${jobId}/prestations`,
      item ? 'PUT' : 'POST',
      body,
      'La prestation n’a pas pu être enregistrée.',
    );
    setIsSubmitting(false);
    if (ok) {
      toast.success(item ? 'Ligne modifiée.' : 'Prestation ajoutée au chantier.');
      onSaved();
      onClose();
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => !isSubmitting && onClose()} title={item ? `Modifier « ${item.serviceName} »` : 'Ajouter une prestation'} size="md" fullScreenMobile>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!item && (
          <FormField label="Prestation du catalogue" htmlFor="item-service" required>
            <Combobox
              id="item-service"
              value={serviceId}
              onChange={(value) => {
                setServiceId(value);
                setUnitPrice('');
              }}
              options={options}
              placeholder={isLoading ? 'Chargement…' : 'Rechercher une prestation…'}
              emptyLabel="Aucune prestation ne correspond"
              ariaLabel="Prestation"
            />
          </FormField>
        )}
        <div className="grid grid-cols-3 gap-3">
          <FormField label={`Quantité${service ? ` (${service.unit})` : item ? ` (${item.unit})` : ''}`} htmlFor="item-qty" required>
            <input id="item-qty" type="number" inputMode="decimal" min="0" step="any" className="input input-bordered min-h-11 w-full text-right tabular" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </FormField>
          <FormField label="Prix unitaire" htmlFor="item-price">
            <input id="item-price" type="number" inputMode="decimal" min="0" step="any" className="input input-bordered min-h-11 w-full text-right tabular" value={unitPrice} placeholder={service ? String(service.unitPrice) : ''} onChange={(e) => setUnitPrice(e.target.value)} />
          </FormField>
          <FormField label="Remise %" htmlFor="item-discount">
            <input id="item-discount" type="number" inputMode="decimal" min="0" max="100" step="any" className="input input-bordered min-h-11 w-full text-right tabular" value={discount} placeholder="0" onChange={(e) => setDiscount(e.target.value)} />
          </FormField>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          <span>Montant de la ligne</span>
          <MoneyText value={amount} bold className="text-lg" />
        </div>
        <p className="text-xs text-base-content/55">
          Le montant du chantier est recalculé. Il ne peut pas descendre sous ce que le client a déjà payé.
        </p>
        {formError && <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">{formError}</p>}
        <Footer onClose={onClose} isSubmitting={isSubmitting} label={item ? 'Enregistrer' : 'Ajouter'} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Étape
 * ------------------------------------------------------------------ */

const STAGE_OPTIONS: { value: StageStatus; label: string }[] = [
  { value: 'todo', label: 'À faire' },
  { value: 'in_progress', label: 'En cours' },
  { value: 'done', label: 'Terminée' },
  { value: 'blocked', label: 'Bloquée' },
];

export function StageModal({
  isOpen,
  onClose,
  jobId,
  stage,
  services,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  jobId: number;
  stage: JobStageRow | null;
  /** Prestations du chantier, pour rattacher l'étape. */
  services: { id: number; name: string }[];
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [responsible, setResponsible] = useState('');
  const [plannedDate, setPlannedDate] = useState('');
  const [actualDate, setActualDate] = useState('');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<StageStatus>('todo');
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(stage?.name ?? '');
    setServiceId(stage?.serviceId ? String(stage.serviceId) : '');
    setResponsible(stage?.responsible ?? '');
    setPlannedDate(stage?.plannedDate ?? '');
    setActualDate(stage?.actualDate ?? '');
    setProgress(stage?.progress ?? 0);
    setStatus(stage?.status ?? 'todo');
    setComment(stage?.comment ?? '');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, stage]);

  async function submit() {
    if (!name.trim()) return setFormError('Nommez l’étape (ex. Fondations, Élévation…).');
    setFormError(null);
    setIsSubmitting(true);
    const ok = await send(
      stage ? `/api/chantiers/${jobId}/etapes?stageId=${stage.id}` : `/api/chantiers/${jobId}/etapes`,
      stage ? 'PUT' : 'POST',
      {
        name: name.trim(),
        serviceId: serviceId ? Number(serviceId) : null,
        responsible: responsible.trim() || null,
        plannedDate: plannedDate || null,
        actualDate: actualDate || null,
        progress,
        status,
        comment: comment.trim() || null,
      },
      'L’étape n’a pas pu être enregistrée.',
    );
    setIsSubmitting(false);
    if (ok) {
      toast.success(stage ? 'Étape mise à jour.' : 'Étape ajoutée.');
      onSaved();
      onClose();
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => !isSubmitting && onClose()} title={stage ? `Étape « ${stage.name} »` : 'Nouvelle étape'} size="lg" fullScreenMobile>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Nom de l’étape" htmlFor="stage-name" required>
            <input id="stage-name" type="text" className="input input-bordered min-h-11 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Fondations" />
          </FormField>
          <FormField label="Prestation associée" htmlFor="stage-service">
            <select id="stage-service" className="select select-bordered min-h-11 w-full" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">— Aucune —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Responsable" htmlFor="stage-responsible">
            <input id="stage-responsible" type="text" className="input input-bordered min-h-11 w-full" value={responsible} onChange={(e) => setResponsible(e.target.value)} placeholder="Nom" />
          </FormField>
          <FormField label="Date prévue">
            <DatePicker value={plannedDate} onChange={setPlannedDate} placeholder="Prévue" />
          </FormField>
          <FormField label="Date réelle">
            <DatePicker value={actualDate} onChange={setActualDate} placeholder="Réelle" />
          </FormField>
        </div>
        <FormField label={`Avancement : ${progress} %`} htmlFor="stage-progress">
          <input
            id="stage-progress"
            type="range"
            min={0}
            max={100}
            step={5}
            value={progress}
            onChange={(e) => {
              const value = Number(e.target.value);
              setProgress(value);
              if (value >= 100) setStatus('done');
              else if (value > 0 && status === 'todo') setStatus('in_progress');
              else if (value < 100 && status === 'done') setStatus('in_progress');
            }}
            className="range range-primary"
          />
        </FormField>
        <FormField label="État" htmlFor="stage-status">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="État de l’étape">
            {STAGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={status === option.value}
                className={`btn btn-sm min-h-11 ${status === option.value ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                onClick={() => {
                  setStatus(option.value);
                  if (option.value === 'done') setProgress(100);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label="Commentaire" htmlFor="stage-comment">
          <textarea id="stage-comment" className="textarea textarea-bordered min-h-20 w-full" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Difficultés, réserves, ce qui reste à faire…" />
        </FormField>
        {formError && <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">{formError}</p>}
        <Footer onClose={onClose} isSubmitting={isSubmitting} label={stage ? 'Enregistrer' : 'Ajouter l’étape'} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Sous-traitance
 * ------------------------------------------------------------------ */

type SupplierOption = { id: number; name: string; specialty: string | null; isSubcontractor: boolean };

export function SubcontractModal({
  isOpen,
  onClose,
  jobId,
  subcontract,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  jobId: number;
  subcontract: JobSubcontractRow | null;
  onSaved: () => void;
}) {
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [work, setWork] = useState('');
  const [agreed, setAgreed] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSupplierId(subcontract ? String(subcontract.supplierId) : '');
    setWork(subcontract?.work ?? '');
    setAgreed(subcontract ? String(subcontract.agreedAmount) : '');
    setNotes(subcontract?.notes ?? '');
    setFormError(null);
    setIsSubmitting(false);
    if (subcontract) return;
    const controller = new AbortController();
    fetch('/api/fournisseurs?limit=500&sort=name', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { data: SupplierOption[] }) : { data: [] }))
      .then((payload) => setSuppliers(payload.data ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [isOpen, subcontract]);

  // Les sous-traitants d'abord, puis les autres fournisseurs.
  const options = useMemo(
    () =>
      [...suppliers]
        .sort((a, b) => Number(b.isSubcontractor) - Number(a.isSubcontractor))
        .map((s) => ({ value: String(s.id), label: s.name, hint: s.isSubcontractor ? (s.specialty ?? 'Sous-traitant') : 'Fournisseur' })),
    [suppliers],
  );

  async function submit() {
    if (!subcontract && !supplierId) return setFormError('Choisissez le sous-traitant.');
    if (!work.trim()) return setFormError('Décrivez les travaux confiés.');
    if (!(num(agreed) >= 0)) return setFormError('Montant convenu invalide.');
    setFormError(null);
    setIsSubmitting(true);
    const ok = await send(
      subcontract ? `/api/chantiers/${jobId}/sous-traitance?subcontractId=${subcontract.id}` : `/api/chantiers/${jobId}/sous-traitance`,
      subcontract ? 'PUT' : 'POST',
      { supplierId: subcontract ? undefined : Number(supplierId), work: work.trim(), agreedAmount: num(agreed) || 0, notes: notes.trim() || null },
      'Les travaux n’ont pas pu être enregistrés.',
    );
    setIsSubmitting(false);
    if (ok) {
      toast.success(subcontract ? 'Sous-traitance mise à jour.' : 'Travaux confiés au sous-traitant.');
      onSaved();
      onClose();
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => !isSubmitting && onClose()} title={subcontract ? `Travaux de ${subcontract.supplierName}` : 'Confier des travaux'} size="lg" fullScreenMobile>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!subcontract && (
          <FormField label="Sous-traitant" htmlFor="sub-supplier" required hint="Fiche fournisseur. Un sous-traitant se crée dans Sous-traitants ou Fournisseurs.">
            <Combobox id="sub-supplier" value={supplierId} onChange={setSupplierId} options={options} placeholder="Rechercher…" emptyLabel="Aucun fournisseur ne correspond" ariaLabel="Sous-traitant" />
          </FormField>
        )}
        <FormField label="Travaux confiés" htmlFor="sub-work" required>
          <input id="sub-work" type="text" className="input input-bordered min-h-11 w-full" value={work} onChange={(e) => setWork(e.target.value)} placeholder="Ex. Câblage et tableau électrique" />
        </FormField>
        <FormField label="Montant convenu (GNF)" htmlFor="sub-agreed" required hint="Compte dans le coût du chantier ; les paiements se font ensuite par des dépenses rattachées.">
          <input id="sub-agreed" type="number" inputMode="decimal" min="0" step="any" className="input input-bordered min-h-11 w-full tabular sm:w-64" value={agreed} onChange={(e) => setAgreed(e.target.value)} />
        </FormField>
        <FormField label="Notes (contrat, conditions)" htmlFor="sub-notes">
          <textarea id="sub-notes" className="textarea textarea-bordered min-h-20 w-full" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
        {formError && <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">{formError}</p>}
        <Footer onClose={onClose} isSubmitting={isSubmitting} label={subcontract ? 'Enregistrer' : 'Confier les travaux'} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Dépense du chantier (ou paiement d'un sous-traitant)
 * ------------------------------------------------------------------ */

export function JobExpenseModal({
  isOpen,
  onClose,
  jobId,
  subcontract,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  jobId: number;
  /** Renseigné = paiement de ce sous-traitant. */
  subcontract: JobSubcontractRow | null;
  onSaved: () => void;
}) {
  const { settings } = useSettings();
  const categories = settings.expenseCategories ?? [];
  const methods = settings.paymentMethods?.length ? settings.paymentMethods : ['Espèces'];
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const [method, setMethod] = useState('Espèces');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const preferred = subcontract
      ? categories.find((c) => c.toLowerCase().includes('sous')) ?? categories[0] ?? ''
      : categories[0] ?? '';
    setCategory(preferred);
    setAmount(subcontract ? String(Math.max(subcontract.remaining - subcontract.pending, 0)) : '');
    setDate(today());
    setDescription(subcontract ? `Paiement — ${subcontract.work}` : '');
    setBeneficiary(subcontract?.supplierName ?? '');
    setMethod(methods[0] ?? 'Espèces');
    setFormError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, subcontract]);

  async function submit() {
    if (!category) return setFormError('Choisissez une catégorie de dépense.');
    if (!(num(amount) > 0)) return setFormError('Le montant doit être positif.');
    if (subcontract && num(amount) > subcontract.remaining - subcontract.pending + 0.5) {
      return setFormError('Ce paiement dépasse ce qui reste dû au sous-traitant.');
    }
    setFormError(null);
    setIsSubmitting(true);
    const ok = await send(
      '/api/depenses',
      'POST',
      {
        category,
        amount: num(amount),
        date,
        description: description.trim() || null,
        beneficiary: beneficiary.trim() || null,
        paymentMethod: method,
        referenceType: subcontract ? 'job_subcontract' : 'service_job',
        referenceId: subcontract ? subcontract.id : jobId,
      },
      'La dépense n’a pas pu être enregistrée.',
    );
    setIsSubmitting(false);
    if (ok) {
      toast.success(subcontract ? 'Paiement du sous-traitant enregistré.' : 'Dépense rattachée au chantier.');
      onSaved();
      onClose();
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => !isSubmitting && onClose()} title={subcontract ? `Payer ${subcontract.supplierName}` : 'Dépense du chantier'} size="lg" fullScreenMobile>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          La dépense sort de la caisse du magasin et suit le circuit d’approbation habituel (au-delà du seuil fixé dans les
          paramètres). Elle reste visible dans la page Dépenses.
        </p>
        {subcontract && (
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-xl bg-base-200/50 p-2">
              <span className="block text-xs text-base-content/60">Convenu</span>
              <MoneyText value={subcontract.agreedAmount} bold />
            </div>
            <div className="rounded-xl bg-base-200/50 p-2">
              <span className="block text-xs text-base-content/60">Déjà payé</span>
              <MoneyText value={subcontract.paid} />
            </div>
            <div className="rounded-xl bg-base-200/50 p-2">
              <span className="block text-xs text-base-content/60">Reste</span>
              <MoneyText value={subcontract.remaining} remaining bold />
            </div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Catégorie" htmlFor="exp-category" required>
            <select id="exp-category" className="select select-bordered min-h-11 w-full" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Choisir…</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Montant (GNF)" htmlFor="exp-amount" required>
            <input id="exp-amount" type="number" inputMode="decimal" min="0" step="any" className="input input-bordered min-h-11 w-full tabular" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
          <FormField label="Date">
            <DatePicker value={date} onChange={setDate} placeholder="Date" />
          </FormField>
          <FormField label="Moyen de paiement" htmlFor="exp-method">
            <select id="exp-method" className="select select-bordered min-h-11 w-full" value={method} onChange={(e) => setMethod(e.target.value)}>
              {methods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField label="Bénéficiaire" htmlFor="exp-beneficiary">
          <input id="exp-beneficiary" type="text" className="input input-bordered min-h-11 w-full" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} />
        </FormField>
        <FormField label="Objet" htmlFor="exp-description">
          <input id="exp-description" type="text" className="input input-bordered min-h-11 w-full" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex. Location d’échafaudage" />
        </FormField>
        {formError && <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">{formError}</p>}
        <Footer onClose={onClose} isSubmitting={isSubmitting} label={subcontract ? 'Enregistrer le paiement' : 'Enregistrer la dépense'} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Affecter une équipe
 * ------------------------------------------------------------------ */

export function TeamModal({ isOpen, onClose, jobId, onSaved }: { isOpen: boolean; onClose: () => void; jobId: number; onSaved: () => void }) {
  const [teams, setTeams] = useState<{ team: string; count: number }[]>([]);
  const [team, setTeam] = useState('');
  const [days, setDays] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTeam('');
    setDays('');
    setFormError(null);
    const controller = new AbortController();
    fetch('/api/workers?teams=1', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { teams: { team: string; count: number }[] }) : { teams: [] }))
      .then((payload) => setTeams(payload.teams ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [isOpen]);

  async function submit() {
    if (!team) return setFormError('Choisissez une équipe.');
    if (!(num(days) > 0)) return setFormError('Indiquez le nombre de jours.');
    setFormError(null);
    setIsSubmitting(true);
    const ok = await send(`/api/chantiers/${jobId}/ouvriers`, 'POST', { team, days: num(days) }, 'L’équipe n’a pas pu être affectée.');
    setIsSubmitting(false);
    if (ok) {
      toast.success(`Équipe « ${team} » affectée.`);
      onSaved();
      onClose();
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => !isSubmitting && onClose()} title="Affecter une équipe" size="md" fullScreenMobile>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {teams.length === 0 ? (
          <p className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
            Aucune équipe n’est définie pour ce magasin. Regroupez des ouvriers en équipe depuis la page « Ouvriers et équipes ».
          </p>
        ) : (
          <FormField label="Équipe" htmlFor="team-name" required>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Équipe">
              {teams.map((t) => (
                <button
                  key={t.team}
                  type="button"
                  role="radio"
                  aria-checked={team === t.team}
                  className={`btn min-h-11 justify-between ${team === t.team ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                  onClick={() => setTeam(t.team)}
                >
                  <span className="truncate">{t.team}</span>
                  <span className="text-xs opacity-80">{t.count} ouvrier{t.count > 1 ? 's' : ''}</span>
                </button>
              ))}
            </div>
          </FormField>
        )}
        <FormField label="Jours de travail" htmlFor="team-days" required hint="Chaque ouvrier est compté à son tarif journalier.">
          <input id="team-days" type="number" inputMode="decimal" min="0" step="any" className="input input-bordered min-h-11 w-full tabular sm:w-40" value={days} onChange={(e) => setDays(e.target.value)} />
        </FormField>
        {formError && <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">{formError}</p>}
        <Footer onClose={onClose} isSubmitting={isSubmitting} label="Affecter l’équipe" />
      </form>
    </Modal>
  );
}
