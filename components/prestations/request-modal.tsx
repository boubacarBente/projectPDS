'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { DatePicker } from '@/components/date-picker';
import { FormField } from '@/components/design-system';
import { formatCurrency, today } from '@/lib/format';
import {
  CustomerPicker,
  readApiError,
  useActiveServices,
  useCustomers,
  type ServiceRequestRow,
} from '@/components/prestations/shared';

/**
 * Enregistrer ou modifier la demande d'un client (cahier « Prestations » §8) :
 * besoin, adresse, date souhaitée et prestations envisagées (cases à cocher
 * dans le catalogue du magasin). Aucun montant ici : le chiffrage se fait dans
 * le devis.
 */
export function RequestFormModal({
  isOpen,
  onClose,
  onSaved,
  request,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (request: ServiceRequestRow) => void;
  request: ServiceRequestRow | null;
}) {
  const { services } = useActiveServices(isOpen);
  const { customers, isLoading: customersLoading, add: addCustomer } = useCustomers(isOpen);
  const [customerId, setCustomerId] = useState('');
  const [need, setNeed] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [date, setDate] = useState(today());
  const [desiredDate, setDesiredDate] = useState('');
  const [serviceIds, setServiceIds] = useState<number[]>([]);
  const [filter, setFilter] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setCustomerId(request ? String(request.customerId) : '');
    setNeed(request?.need ?? '');
    setSiteAddress(request?.siteAddress ?? '');
    setDate(request?.date ?? today());
    setDesiredDate(request?.desiredDate ?? '');
    setServiceIds(request ? request.services.map((s) => s.serviceId).filter((id): id is number => Boolean(id)) : []);
    setNotes(request?.notes ?? '');
    setFilter('');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, request]);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return term ? services.filter((s) => `${s.name} ${s.category} ${s.code}`.toLowerCase().includes(term)) : services;
  }, [services, filter]);

  const toggle = (id: number) =>
    setServiceIds((list) => (list.includes(id) ? list.filter((value) => value !== id) : [...list, id]));

  async function submit() {
    if (isSubmitting) return;
    if (!customerId) return setFormError('Choisissez le client.');
    if (!need.trim()) return setFormError('Décrivez le besoin du client.');
    setFormError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(request ? `/api/demandes/${request.id}` : '/api/demandes', {
        method: request ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          customerId: Number(customerId),
          need: need.trim(),
          siteAddress: siteAddress.trim() || null,
          date,
          desiredDate: desiredDate || null,
          serviceIds,
          notes: notes.trim() || null,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'La demande n’a pas pu être enregistrée.'));
      const saved = (await response.json()) as ServiceRequestRow;
      toast.success(request ? 'Demande modifiée.' : `Demande ${saved.reference} enregistrée.`);
      onSaved(saved);
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'La demande n’a pas pu être enregistrée.';
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !isSubmitting && onClose()}
      title={request ? `Modifier ${request.reference}` : 'Nouvelle demande'}
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
        <FormField label="Client" htmlFor="request-customer" required>
          <CustomerPicker
            id="request-customer"
            value={customerId}
            onChange={setCustomerId}
            customers={customers}
            isLoading={customersLoading}
            onCreated={addCustomer}
            disabled={isSubmitting}
          />
        </FormField>
        <FormField label="Besoin du client" htmlFor="request-need" required>
          <textarea
            id="request-need"
            className="textarea textarea-bordered min-h-24 w-full"
            value={need}
            onChange={(event) => setNeed(event.target.value)}
            placeholder="Ce que le client veut faire réaliser, en ses mots."
            disabled={isSubmitting}
          />
        </FormField>
        <FormField label="Adresse du chantier" htmlFor="request-site">
          <input
            id="request-site"
            type="text"
            className="input input-bordered min-h-11 w-full"
            value={siteAddress}
            onChange={(event) => setSiteAddress(event.target.value)}
            placeholder="Quartier, commune, repère…"
            disabled={isSubmitting}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Date de la demande">
            <DatePicker value={date} onChange={setDate} placeholder="Date" />
          </FormField>
          <FormField label="Date souhaitée par le client">
            <DatePicker value={desiredDate} onChange={setDesiredDate} placeholder="Date souhaitée" />
          </FormField>
        </div>

        <FormField label="Prestations envisagées" hint="Facultatif : elles seront reprises dans le devis.">
          <div className="space-y-2 rounded-xl border border-base-200 p-3">
            {services.length > 6 && (
              <input
                type="search"
                className="input input-bordered input-sm min-h-11 w-full"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filtrer le catalogue…"
                aria-label="Filtrer les prestations"
              />
            )}
            {services.length === 0 ? (
              <p className="text-sm text-base-content/60">Le catalogue du magasin est vide.</p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-y-auto">
                {visible.map((service) => (
                  <li key={service.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-base-200/60">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm checkbox-primary"
                        checked={serviceIds.includes(service.id)}
                        onChange={() => toggle(service.id)}
                        disabled={isSubmitting}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{service.name}</span>
                        <span className="block text-xs text-base-content/55">
                          {service.category} · {formatCurrency(service.unitPrice)} / {service.unit}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </FormField>

        <FormField label="Notes internes" htmlFor="request-notes">
          <textarea
            id="request-notes"
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
            {isSubmitting ? <span className="loading loading-spinner loading-sm" aria-hidden /> : request ? 'Enregistrer' : 'Enregistrer la demande'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
