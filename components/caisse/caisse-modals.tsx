'use client';

/**
 * Modales du module Caisse (§8, §13).
 *
 * Trois modales, **un booléen chacune** côté page (jamais une modale
 * « générique » pilotée par une chaîne, §8.3 règle 1) :
 *  - `OpenCashSessionModal` : ouverture, avec montant initial et note ;
 *  - `CloseCashSessionModal` : clôture journalière — le montant **théorique**
 *    est calculé, le **compté** est saisi, l'**écart** est affiché en direct ;
 *  - `CashMovementModal` : entrée ou sortie manuelle.
 *
 * Règles appliquées partout : `onClose` ne ferme jamais pendant un envoi,
 * spinner sur le bouton de confirmation, libellés français, aucune couleur
 * Tailwind figée (jetons `primary` / `base-*` / `success` / `error` seulement),
 * formulaires sur une colonne sous `sm` (CONVENTIONS §8).
 *
 * ⚠️ Composant **client** : il n'importe rien de `lib/caisse.ts` (module
 * serveur, §11 bis). Le type `CashSessionRow` n'arrive ici que par
 * `import type`, donc effacé à la compilation.
 */

import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { FormField, MoneyText } from '@/components/design-system';
import { DatePicker } from '@/components/date-picker';
import { today } from '@/lib/format';
import type { CashSessionRow } from '@/lib/caisse';

type FieldErrors = {
  amount?: string;
  counted?: string;
  motif?: string;
  date?: string;
  form?: string;
};

/**
 * Message d'erreur lisible renvoyé par l'API : `fail()` de `lib/api.ts` traduit
 * déjà `ValidationError`, `ForbiddenError`… en français. On ne montre jamais un
 * code HTTP à l'utilisateur, et jamais un écran blanc (CONVENTIONS §5).
 */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // Corps non JSON : on garde le message de repli.
  }
  return fallback;
}

/** Montant saisi : accepte la virgule décimale française. */
function parseAmount(value: string): number {
  return Number(value.replace(/\s/g, '').replace(',', '.'));
}

/* ------------------------------------------------------------------ *
 * Ouverture
 * ------------------------------------------------------------------ */

export function OpenCashSessionModal({
  isOpen,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [openingAmount, setOpeningAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Réamorçage à chaque ouverture : aucun résidu de la saisie précédente.
  useEffect(() => {
    if (!isOpen) return;
    setOpeningAmount('');
    setNotes('');
    setErrors({});
    setIsSubmitting(false);
  }, [isOpen]);

  function validate(): boolean {
    const next: FieldErrors = {};
    const parsed = parseAmount(openingAmount);

    if (!openingAmount.trim()) {
      next.amount = 'Le montant d’ouverture est obligatoire (0 si la caisse est vide)';
    } else if (!Number.isFinite(parsed) || parsed < 0) {
      next.amount = 'Le montant doit être un nombre positif ou nul';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    if (isSubmitting) return;
    if (!validate()) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      const response = await fetch('/api/caisse/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          openingAmount: parseAmount(openingAmount),
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Ouverture de la caisse impossible'));
      }

      toast.success('Caisse ouverte.');
      await onSaved();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ouverture de la caisse impossible';
      // Une session déjà ouverte est un cas nominal, pas un plantage : le
      // message du serveur est explicite et mérite un affichage plus long.
      toast.error(message, { autoClose: 8000 });
      setErrors({ form: message });
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
      title="Ouvrir la caisse"
      size="sm"
    >
      <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 p-3 text-success">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="mt-0.5 h-4 w-4 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 4v16m8-8H4"
          />
        </svg>
        <p className="text-xs leading-5">
          Une seule session peut être ouverte à la fois. Le montant saisi devient le premier
          mouvement de la journée : sans lui, le solde du premier encaissement serait faux.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4">
        <FormField
          label="Montant d’ouverture (GNF)"
          htmlFor="cash-opening-amount"
          required
          error={errors.amount}
          hint="Espèces présentes en caisse au moment de l’ouverture. Saisissez 0 si la caisse est vide."
        >
          <input
            id="cash-opening-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={openingAmount}
            onChange={(event) => setOpeningAmount(event.target.value)}
            placeholder="Ex. 500 000"
            className="input input-bordered w-full text-right tabular"
          />
        </FormField>

        <FormField label="Note" htmlFor="cash-opening-notes">
          <textarea
            id="cash-opening-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            placeholder="Précision utile (fond de caisse repris du caissier précédent…)"
            className="textarea textarea-bordered w-full"
          />
        </FormField>
      </div>

      {errors.form && (
        <p className="mt-3 rounded-xl border border-error/30 bg-error/10 p-3 text-xs text-error">
          {errors.form}
        </p>
      )}

      <div className="sticky bottom-0 -mx-1 mt-5 flex flex-wrap justify-end gap-3 border-t border-base-200 bg-base-100 pt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={isSubmitting}
          className="btn btn-ghost min-h-11"
        >
          Annuler
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={isSubmitting}
          className="btn btn-primary min-h-11"
        >
          {isSubmitting ? (
            <>
              <span className="loading loading-spinner loading-sm" />
              Ouverture…
            </>
          ) : (
            'Ouvrir la caisse'
          )}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Clôture journalière — l'écart est affiché, jamais masqué
 * ------------------------------------------------------------------ */

export function CloseCashSessionModal({
  isOpen,
  onClose,
  session,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** La session ouverte : son dernier `balanceAfter` est le montant théorique. */
  session: CashSessionRow | null;
  onSaved: () => void | Promise<void>;
}) {
  const [countedAmount, setCountedAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const theoretical = Number(session?.theoreticalAmount ?? 0);

  useEffect(() => {
    if (!isOpen) return;
    // On pré-remplit avec le théorique : le caissier corrige ce qu'il compte
    // réellement — l'écart nul est le cas courant, pas l'exception.
    setCountedAmount(session ? String(theoretical) : '');
    setNotes('');
    setErrors({});
    setIsSubmitting(false);
    // `theoretical` est dérivé de `session` : la dépendance explicite évite de
    // réamorcer la saisie à chaque rendu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, session?.id, theoretical]);

  const parsedCounted = parseAmount(countedAmount);
  const hasCounted = countedAmount.trim() !== '' && Number.isFinite(parsedCounted);
  const difference = hasCounted ? Math.round((parsedCounted - theoretical) * 100) / 100 : 0;

  function validate(): boolean {
    const next: FieldErrors = {};

    if (!session) {
      next.form = 'Aucune session de caisse ouverte.';
    } else if (!countedAmount.trim()) {
      next.counted = 'Le montant compté est obligatoire';
    } else if (!Number.isFinite(parsedCounted) || parsedCounted < 0) {
      next.counted = 'Le montant compté doit être un nombre positif ou nul';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    if (isSubmitting || !session) return;
    if (!validate()) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      const response = await fetch('/api/caisse/sessions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          sessionId: session.id,
          countedAmount: parsedCounted,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Clôture de la caisse impossible'));
      }

      toast.success('Caisse clôturée.');
      await onSaved();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Clôture de la caisse impossible';
      toast.error(message);
      setErrors({ form: message });
    } finally {
      setIsSubmitting(false);
    }
  }

  /**
   * Libellé de l'écart — **jamais masqué** (§8). Le signe et le mot sont
   * explicites : une couleur seule ne dirait rien à l'impression.
   */
  const differenceLabel =
    difference === 0
      ? 'Écart nul : la caisse compte exactement le montant théorique.'
      : difference > 0
        ? `Excédent de ${difference.toLocaleString('fr-FR')} GNF : il y a plus d’argent que prévu.`
        : `Manquant de ${Math.abs(difference).toLocaleString('fr-FR')} GNF : il manque de l’argent en caisse.`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title="Clôturer la caisse"
      size="md"
    >
      <div className="rounded-xl border border-base-200 bg-base-200/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-base-content/60">Montant théorique (calculé)</span>
          <MoneyText value={theoretical} bold />
        </div>
        <p className="mt-1 text-xs text-base-content/50">
          Dernier solde enregistré de la session ouverte — il n’est pas modifiable.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4">
        <FormField
          label="Montant compté (GNF)"
          htmlFor="cash-counted-amount"
          required
          error={errors.counted}
          hint="Ce que vous avez réellement compté dans la caisse."
        >
          <input
            id="cash-counted-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={countedAmount}
            onChange={(event) => setCountedAmount(event.target.value)}
            placeholder="Ex. 1 250 000"
            className="input input-bordered w-full text-right tabular"
          />
        </FormField>

        {/* L'écart est recalculé à chaque frappe et affiché explicitement. */}
        <div
          className={`rounded-xl border p-3 ${
            difference === 0
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-warning/30 bg-warning/10 text-warning'
          }`}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Écart (compté − théorique)</span>
            <span className="tabular text-base font-bold">
              {difference > 0 ? '+' : difference < 0 ? '−' : ''}
              {Math.abs(difference).toLocaleString('fr-FR')} GNF
            </span>
          </div>
          <p className="mt-1 text-xs leading-5">{differenceLabel}</p>
        </div>

        <FormField label="Note de clôture" htmlFor="cash-closing-notes">
          <textarea
            id="cash-closing-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            placeholder="Obligatoire en pratique dès qu’il y a un écart : expliquez-le ici."
            className="textarea textarea-bordered w-full"
          />
        </FormField>
      </div>

      {errors.form && (
        <p className="mt-3 rounded-xl border border-error/30 bg-error/10 p-3 text-xs text-error">
          {errors.form}
        </p>
      )}

      <div className="sticky bottom-0 -mx-1 mt-5 flex flex-wrap justify-end gap-3 border-t border-base-200 bg-base-100 pt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={isSubmitting}
          className="btn btn-ghost min-h-11"
        >
          Annuler
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={isSubmitting || !session}
          className="btn btn-primary min-h-11"
        >
          {isSubmitting ? (
            <>
              <span className="loading loading-spinner loading-sm" />
              Clôture…
            </>
          ) : (
            'Clôturer la caisse'
          )}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Mouvement manuel (entrée / sortie)
 * ------------------------------------------------------------------ */

export function CashMovementModal({
  isOpen,
  onClose,
  paymentMethods,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Liste issue de `settings.paymentMethods` (Espèces, Mobile Money…). */
  paymentMethods: string[];
  onSaved: () => void | Promise<void>;
}) {
  const [type, setType] = useState<'income' | 'expense'>('income');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Espèces');
  const [motif, setMotif] = useState('');
  const [date, setDate] = useState(today());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setType('income');
    setAmount('');
    setPaymentMethod(paymentMethods[0] ?? 'Espèces');
    setMotif('');
    setDate(today());
    setErrors({});
    setIsSubmitting(false);
  }, [isOpen, paymentMethods]);

  function validate(): boolean {
    const next: FieldErrors = {};
    const parsed = parseAmount(amount);

    if (!amount.trim()) {
      next.amount = 'Le montant est obligatoire';
    } else if (!Number.isFinite(parsed) || parsed <= 0) {
      next.amount = 'Le montant doit être strictement supérieur à 0';
    }

    if (!motif.trim()) next.motif = 'Le motif est obligatoire';
    if (!date) next.date = 'La date est obligatoire';

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    if (isSubmitting) return;
    if (!validate()) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      const response = await fetch('/api/caisse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          type,
          amount: parseAmount(amount),
          paymentMethod,
          motif: motif.trim(),
          date,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Enregistrement du mouvement impossible'));
      }

      toast.success(type === 'income' ? 'Entrée enregistrée.' : 'Sortie enregistrée.');
      await onSaved();
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Enregistrement du mouvement impossible';
      toast.error(message);
      setErrors({ form: message });
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
      title="Nouveau mouvement de caisse"
      size="md"
      fullScreenMobile
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Sens du mouvement" htmlFor="cash-movement-type" required>
          <select
            id="cash-movement-type"
            value={type}
            onChange={(event) => setType(event.target.value === 'expense' ? 'expense' : 'income')}
            className="select select-bordered w-full"
          >
            <option value="income">Entrée — de l’argent entre en caisse</option>
            <option value="expense">Sortie — de l’argent sort de la caisse</option>
          </select>
        </FormField>

        <FormField
          label="Montant (GNF)"
          htmlFor="cash-movement-amount"
          required
          error={errors.amount}
          hint="Strictement supérieur à 0."
        >
          <input
            id="cash-movement-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Ex. 150 000"
            className="input input-bordered w-full text-right tabular"
          />
        </FormField>

        <FormField label="Moyen de paiement" htmlFor="cash-movement-method">
          <select
            id="cash-movement-method"
            value={paymentMethod}
            onChange={(event) => setPaymentMethod(event.target.value)}
            className="select select-bordered w-full"
          >
            {paymentMethods.length === 0 && <option value="Espèces">Espèces</option>}
            {paymentMethods.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Date" required error={errors.date}>
          <DatePicker value={date} onChange={setDate} placeholder="jj/mm/aaaa" />
        </FormField>

        <FormField
          label="Motif"
          htmlFor="cash-movement-motif"
          required
          error={errors.motif}
          hint="« Fond de caisse remis », « Achat carburant », « Retrait gérant »…"
          className="sm:col-span-2"
        >
          <input
            id="cash-movement-motif"
            type="text"
            value={motif}
            onChange={(event) => setMotif(event.target.value)}
            placeholder="Pourquoi cet argent entre-t-il ou sort-il ?"
            className="input input-bordered w-full"
          />
        </FormField>
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-xl border border-info/30 bg-info/10 p-3 text-info">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="mt-0.5 h-4 w-4 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="text-xs leading-5">
          Ce mouvement est manuel : il ne corrige ni une vente, ni une dépense. Un mouvement se
          contre-passe par un mouvement inverse, jamais par une suppression.
        </p>
      </div>

      {errors.form && (
        <p className="mt-3 rounded-xl border border-error/30 bg-error/10 p-3 text-xs text-error">
          {errors.form}
        </p>
      )}

      <div className="sticky bottom-0 -mx-1 mt-5 flex flex-wrap justify-end gap-3 border-t border-base-200 bg-base-100 pt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={isSubmitting}
          className="btn btn-ghost min-h-11"
        >
          Annuler
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={isSubmitting}
          className="btn btn-primary min-h-11"
        >
          {isSubmitting ? (
            <>
              <span className="loading loading-spinner loading-sm" />
              Enregistrement…
            </>
          ) : (
            'Enregistrer le mouvement'
          )}
        </button>
      </div>
    </Modal>
  );
}
