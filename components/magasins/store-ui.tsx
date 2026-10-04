'use client';

/**
 * Briques partagées des écrans Magasins (`/magasins`, `/magasins/[id]`).
 *
 * ⚠️ `lib/stores.ts` est un module **serveur** (il importe `@/db`) : on n'en
 * importe que des **types** (AGENTS.md, invariant 6).
 */

import { useEffect, useId, useState } from 'react';
import { Modal } from '@/components/modal';
import { Badge, FormField, type BadgeTone } from '@/components/design-system';
import { DatePicker } from '@/components/date-picker';
import { useAuth } from '@/components/auth-provider';
import type { StoreRow, StoreStatus, StoreKind, getStoreIndicators } from '@/lib/stores';

/** `createdAt` arrive sérialisé en chaîne ISO par `NextResponse.json`. */
export type StoreRecord = Omit<StoreRow, 'createdAt'> & { createdAt: string | null };
export type StoreIndicators = Awaited<ReturnType<typeof getStoreIndicators>>;
export type { StoreStatus, StoreKind };

export const STORE_STATUS_LABELS: Record<StoreStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Actif', tone: 'success' },
  suspended: { label: 'Suspendu', tone: 'warning' },
  archived: { label: 'Archivé', tone: 'neutral' },
};

export const STORE_KIND_LABELS: Record<StoreKind, string> = {
  headquarters: 'Siège',
  store: 'Magasin',
};

/** Badge de statut : libellé toujours présent, jamais la couleur seule. */
export function StoreStatusBadge({ status }: { status: StoreStatus }) {
  const entry = STORE_STATUS_LABELS[status] ?? STORE_STATUS_LABELS.active;
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

export function StoreKindBadge({ kind }: { kind: StoreKind }) {
  return <Badge tone={kind === 'headquarters' ? 'primary' : 'info'}>{STORE_KIND_LABELS[kind]}</Badge>;
}

/** Lit `{ error }` d'une réponse d'API, sinon message générique. */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const message = (payload as { error?: unknown }).error;
      if (typeof message === 'string' && message.trim()) return message;
    }
  } catch {
    /* Corps illisible : message générique. */
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Modale de création / modification
 * ------------------------------------------------------------------ */

type UserOption = { id: number; name: string; username: string };

type FormValues = {
  code: string;
  name: string;
  kind: StoreKind;
  address: string;
  phone: string;
  email: string;
  managerUserId: string;
  openingDate: string;
  openingHours: string;
  receiptFooter: string;
  notes: string;
  /** Création seulement : magasin dont on recopie la liste des produits. */
  copyAssortmentFrom: string;
};

function initialValues(store: StoreRecord | null | undefined): FormValues {
  return {
    code: store?.code ?? '',
    name: store?.name ?? '',
    kind: store?.kind ?? 'store',
    address: store?.address ?? '',
    phone: store?.phone ?? '',
    email: store?.email ?? '',
    managerUserId: store?.managerUserId ? String(store.managerUserId) : '',
    openingDate: store?.openingDate ?? '',
    openingHours: store?.openingHours ?? '',
    receiptFooter: store?.receiptFooter ?? '',
    notes: store?.notes ?? '',
    copyAssortmentFrom: '',
  };
}

/** Même règle que `cleanCode()` côté serveur : 2 à 8 lettres ou chiffres. */
const CODE_PATTERN = /^[A-Z0-9]{2,8}$/;

export function StoreFormModal({
  isOpen,
  onClose,
  onSaved,
  store,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (store: StoreRecord) => void;
  /** Absent = création. */
  store?: StoreRecord | null;
}) {
  const idPrefix = useId();
  const fieldId = (name: string) => `${idPrefix}-${name}`;
  const isEdit = Boolean(store);
  const { stores: knownStores } = useAuth();

  const [values, setValues] = useState<FormValues>(() => initialValues(store));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  /**
   * Liste des gérants possibles. `GET /api/users?options=true` exige
   * `users.manage` : sans ce droit (403), le champ « Gérant » est **masqué**
   * et le gérant actuel n'est pas envoyé — il reste inchangé.
   */
  const [userOptions, setUserOptions] = useState<UserOption[] | null>(null);
  const [managerFieldHidden, setManagerFieldHidden] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setValues(initialValues(store));
    setFormError(null);
    setCodeError(null);
    setNameError(null);
    setEmailError(null);
  }, [isOpen, store]);

  useEffect(() => {
    if (!isOpen || userOptions !== null || managerFieldHidden) return;
    let active = true;
    setUsersLoading(true);
    (async () => {
      try {
        const response = await fetch('/api/users?options=true', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!active) return;
        if (!response.ok) {
          // 403 (pas `users.manage`) ou autre échec : on masque le champ.
          setManagerFieldHidden(true);
          return;
        }
        const payload = (await response.json()) as unknown;
        setUserOptions(Array.isArray(payload) ? (payload as UserOption[]) : []);
      } catch {
        if (active) setManagerFieldHidden(true);
      } finally {
        if (active) setUsersLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [isOpen, userOptions, managerFieldHidden]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    const code = values.code.trim().toUpperCase();
    const name = values.name.trim();
    const email = values.email.trim();
    let invalid = false;

    if (!CODE_PATTERN.test(code)) {
      setCodeError('2 à 8 caractères, lettres et chiffres uniquement (ex. KAL, MATOTO).');
      invalid = true;
    } else setCodeError(null);
    if (!name) {
      setNameError('Le nom du magasin est obligatoire.');
      invalid = true;
    } else setNameError(null);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError('Adresse e-mail invalide.');
      invalid = true;
    } else setEmailError(null);
    if (invalid) return;

    setFormError(null);
    setIsSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        code,
        name,
        kind: values.kind,
        address: values.address.trim() || null,
        phone: values.phone.trim() || null,
        email: email || null,
        openingDate: values.openingDate || null,
        openingHours: values.openingHours.trim() || null,
        receiptFooter: values.receiptFooter.trim() || null,
        notes: values.notes.trim() || null,
      };
      // Chaque magasin a ses propres produits (README §28.5) : à la création,
      // on peut partir de la liste d'un magasin existant plutôt que de zéro.
      if (!isEdit && values.copyAssortmentFrom) body.copyAssortmentFrom = Number(values.copyAssortmentFrom);
      // Champ masqué = gérant inchangé : surtout ne pas l'effacer.
      if (!managerFieldHidden && userOptions !== null) {
        body.managerUserId = values.managerUserId ? Number(values.managerUserId) : null;
      }

      const response = await fetch(isEdit && store ? `/api/magasins/${store.id}` : '/api/magasins', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Le magasin n’a pas pu être enregistré.'));
      }
      onSaved((await response.json()) as StoreRecord);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'Le magasin n’a pas pu être enregistré.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass = 'input input-bordered min-h-11 w-full sm:min-h-0';

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={isEdit ? 'Modifier le magasin' : 'Nouveau magasin'}
      size="lg"
      fullScreenMobile
      footer={
        <div className="flex justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button
            type="submit"
            form={fieldId('form')}
            className="btn btn-primary min-h-11 sm:min-h-0"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : isEdit ? (
              'Enregistrer'
            ) : (
              'Créer le magasin'
            )}
          </button>
        </div>
      }
    >
      <form
        id={fieldId('form')}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {formError && (
          <p role="alert" className="mb-4 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {formError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Code" htmlFor={fieldId('code')} required error={codeError} hint="2 à 8 lettres ou chiffres, unique (ex. KAL).">
            <input
              id={fieldId('code')}
              type="text"
              className={`${inputClass} uppercase`}
              value={values.code}
              maxLength={8}
              onChange={(event) => setField('code', event.target.value.toUpperCase())}
              placeholder="Ex. KAL"
              autoComplete="off"
            />
          </FormField>

          <FormField label="Type" htmlFor={fieldId('kind')} hint="Le siège peut saisir ses propres opérations depuis le poste central.">
            <select
              id={fieldId('kind')}
              className="select select-bordered min-h-11 w-full sm:min-h-0"
              value={values.kind}
              onChange={(event) => setField('kind', event.target.value === 'headquarters' ? 'headquarters' : 'store')}
            >
              <option value="store">Magasin</option>
              <option value="headquarters">Siège</option>
            </select>
          </FormField>

          <FormField label="Nom" htmlFor={fieldId('name')} required error={nameError} className="sm:col-span-2">
            <input
              id={fieldId('name')}
              type="text"
              className={inputClass}
              value={values.name}
              onChange={(event) => setField('name', event.target.value)}
              placeholder="Ex. Magasin de Kaloum"
              autoComplete="off"
            />
          </FormField>

          <FormField label="Adresse" htmlFor={fieldId('address')} className="sm:col-span-2">
            <input
              id={fieldId('address')}
              type="text"
              className={inputClass}
              value={values.address}
              onChange={(event) => setField('address', event.target.value)}
              placeholder="Quartier, commune, ville"
              autoComplete="off"
            />
          </FormField>

          <FormField label="Téléphone" htmlFor={fieldId('phone')}>
            <input
              id={fieldId('phone')}
              type="tel"
              className={inputClass}
              value={values.phone}
              onChange={(event) => setField('phone', event.target.value)}
              placeholder="Ex. 622 00 00 00"
              autoComplete="off"
            />
          </FormField>

          <FormField label="E-mail" htmlFor={fieldId('email')} error={emailError}>
            <input
              id={fieldId('email')}
              type="email"
              className={inputClass}
              value={values.email}
              onChange={(event) => setField('email', event.target.value)}
              placeholder="Ex. kaloum@planetedeco.gn"
              autoComplete="off"
            />
          </FormField>

          {!managerFieldHidden && (
            <FormField
              label="Gérant"
              htmlFor={fieldId('manager')}
              hint="Le gérant est automatiquement affecté au magasin."
            >
              <select
                id={fieldId('manager')}
                className="select select-bordered min-h-11 w-full sm:min-h-0"
                value={values.managerUserId}
                disabled={usersLoading || userOptions === null}
                onChange={(event) => setField('managerUserId', event.target.value)}
              >
                <option value="">{usersLoading ? 'Chargement…' : 'Aucun gérant'}</option>
                {(userOptions ?? []).map((user) => (
                  <option key={user.id} value={String(user.id)}>
                    {user.name} ({user.username})
                  </option>
                ))}
              </select>
            </FormField>
          )}

          <FormField label="Date d’ouverture" htmlFor={fieldId('opening-date')}>
            <DatePicker
              value={values.openingDate}
              onChange={(date) => setField('openingDate', date)}
              placeholder="jj mois aaaa"
              className="input-md! min-h-11 text-sm! sm:min-h-0"
            />
          </FormField>

          <FormField label="Horaires" htmlFor={fieldId('hours')} className={managerFieldHidden ? '' : 'sm:col-span-2'}>
            <input
              id={fieldId('hours')}
              type="text"
              className={inputClass}
              value={values.openingHours}
              onChange={(event) => setField('openingHours', event.target.value)}
              placeholder="Ex. Lun–Sam 8h–19h"
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Pied de ticket"
            htmlFor={fieldId('footer')}
            hint="Texte imprimé en bas des tickets et reçus de ce magasin."
            className="sm:col-span-2"
          >
            <textarea
              id={fieldId('footer')}
              rows={2}
              className="textarea textarea-bordered w-full"
              value={values.receiptFooter}
              onChange={(event) => setField('receiptFooter', event.target.value)}
              placeholder="Ex. Merci de votre visite !"
            />
          </FormField>

          <FormField label="Notes" htmlFor={fieldId('notes')} className="sm:col-span-2">
            <textarea
              id={fieldId('notes')}
              rows={3}
              className="textarea textarea-bordered w-full"
              value={values.notes}
              onChange={(event) => setField('notes', event.target.value)}
              placeholder="Notes internes"
            />
          </FormField>

          {!isEdit && (
            <FormField
              label="Produits de départ"
              htmlFor={fieldId('assortment')}
              hint="Chaque magasin a sa propre liste de produits. Vous pouvez reprendre celle d’un magasin existant (sans son stock ni ses prix locaux), ou partir d’une liste vide."
              className="sm:col-span-2"
            >
              <select
                id={fieldId('assortment')}
                className="select select-bordered w-full"
                value={values.copyAssortmentFrom}
                onChange={(event) => setField('copyAssortmentFrom', event.target.value)}
              >
                <option value="">Aucun produit (liste vide)</option>
                {knownStores
                  .filter((s) => s.status !== 'archived')
                  .map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      Mêmes produits que {s.name}
                    </option>
                  ))}
              </select>
            </FormField>
          )}
        </div>
      </form>
    </Modal>
  );
}
