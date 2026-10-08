'use client';

import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { FormField } from '@/components/design-system';
import { useSettings } from '@/app/parametres/page';
import { jobCategoryOptions } from '@/components/chantiers/chantiers-modals';
import { readApiError, type ServiceRow } from '@/components/prestations/shared';

/**
 * Création / modification d'une prestation du catalogue **du magasin actif**.
 *
 * Le **code** est toujours attribué automatiquement (`PRE-001`, `PRE-002`…
 * propre au magasin) : il ne se saisit pas. Pas d'**unité** à choisir : une
 * nouvelle prestation se compte au forfait (les anciennes gardent la leur).
 *
 * Le prix est **estimatif** : c'est le prix de départ proposé quand on ajoute
 * la prestation à un devis ou un chantier, où il se modifie librement — une
 * même prestation n'a pas le même prix d'un chantier à l'autre. Un changement
 * de ce prix est historisé et ne modifie aucun devis ni chantier existant.
 */
export function ServiceFormModal({
  isOpen,
  onClose,
  onSaved,
  service,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (service: ServiceRow) => void;
  /** `null` = création. */
  service: ServiceRow | null;
}) {
  const { settings } = useSettings();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(service?.name ?? '');
    setCategory(service?.category ?? '');
    setUnitPrice(service ? String(service.unitPrice) : '');
    setDescription(service?.description ?? '');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, service]);

  const priceChanged = service && Number(unitPrice) !== service.unitPrice;

  async function submit() {
    if (isSubmitting) return;
    if (!name.trim()) return setFormError('Le nom de la prestation est obligatoire.');
    if (!category) return setFormError('Choisissez une catégorie.');
    const price = Number(String(unitPrice).replace(',', '.'));
    if (!Number.isFinite(price) || price < 0) return setFormError('Le prix estimatif doit être un nombre positif.');

    setFormError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(service ? `/api/prestations/${service.id}` : '/api/prestations', {
        method: service ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          // Ni code (automatique) ni unité (forfait par défaut, inchangée en modification).
          name: name.trim(),
          category,
          unitPrice: price,
          description: description.trim() || null,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'La prestation n’a pas pu être enregistrée.'));
      const saved = (await response.json()) as ServiceRow;
      toast.success(service ? 'Prestation modifiée.' : `Prestation ${saved.code} créée.`);
      onSaved(saved);
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'La prestation n’a pas pu être enregistrée.';
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
      title={service ? `Modifier ${service.code}` : 'Nouvelle prestation'}
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
          Cette prestation appartient <strong>au catalogue de votre magasin</strong> : les autres magasins ne la voient
          pas et fixent leurs propres prix.
        </p>

        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <FormField label="Nom de la prestation" htmlFor="service-name" required>
            <input
              id="service-name"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex. Installation électrique complète"
              disabled={isSubmitting}
            />
          </FormField>
          {/* Code en lecture seule : toujours attribué par le logiciel. */}
          <div>
            <p className="mb-1 text-sm font-medium text-base-content/70">Code</p>
            <p className="flex min-h-11 items-center rounded-lg border border-dashed border-base-300 bg-base-200/40 px-3 text-sm tabular text-base-content/70">
              {service ? service.code : 'Automatique (PRE-…)'}
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Catégorie" htmlFor="service-category" required hint="Liste commune, modifiable dans les paramètres.">
            <select
              id="service-category"
              className="select select-bordered min-h-11 w-full"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              disabled={isSubmitting}
            >
              <option value="">Choisir…</option>
              {jobCategoryOptions(settings.jobCategories ?? [], service?.category).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField
            label="Prix estimatif (GNF)"
            htmlFor="service-price"
            required
            hint="Prix de départ, modifiable sur chaque devis ou chantier."
          >
            <input
              id="service-price"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={unitPrice}
              onChange={(event) => setUnitPrice(event.target.value)}
              placeholder="0"
              disabled={isSubmitting}
            />
          </FormField>
        </div>

        <p className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
          <strong>Prix estimatif :</strong> il sera proposé quand vous ajouterez cette prestation à un devis ou à un
          chantier, et vous pourrez l’y changer. Une même prestation n’a pas forcément le même prix d’un chantier à l’autre
          (surface, accès, client…) : chaque chantier garde son propre prix.
        </p>

        {priceChanged && (
          <p className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
            Le nouveau prix s’appliquera aux <strong>prochains</strong> devis et chantiers. Ceux déjà établis gardent leur
            prix, et l’ancien prix reste dans l’historique.
          </p>
        )}

        <FormField label="Description" htmlFor="service-description">
          <textarea
            id="service-description"
            className="textarea textarea-bordered min-h-24 w-full"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Ce qui est compris dans la prestation, ce qui ne l’est pas…"
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
            ) : service ? (
              'Enregistrer'
            ) : (
              'Créer la prestation'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Change le statut d'une prestation (aucune suppression). Renvoie la ligne à jour. */
export async function changeServiceStatus(service: ServiceRow, status: ServiceRow['status']): Promise<ServiceRow | null> {
  try {
    const response = await fetch(`/api/prestations/${service.id}/statut`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error(await readApiError(response, 'Le statut n’a pas pu être changé.'));
    const updated = (await response.json()) as ServiceRow;
    toast.success(
      status === 'active'
        ? `${service.name} est de nouveau proposée.`
        : status === 'inactive'
          ? `${service.name} est désactivée : elle n’est plus proposée dans les devis.`
          : `${service.name} est archivée.`,
    );
    return updated;
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : 'Le statut n’a pas pu être changé.');
    return null;
  }
}
