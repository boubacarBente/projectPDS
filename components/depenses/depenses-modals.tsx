'use client';

/**
 * Modales du module Dépenses (§7.9, §14).
 *
 * Deux modales, **un booléen chacune** côté page (jamais un « mode » sous forme
 * de chaîne, §8.3) :
 *  - `ExpenseFormModal` : création **et** modification — c'est le même
 *    formulaire, une seule modale ;
 *  - `CancelExpenseModal` : annulation, avec **motif obligatoire** (§26.13).
 *
 * Règles appliquées partout : `onClose` ne ferme jamais pendant un envoi,
 * spinner sur le bouton de confirmation, libellés en français, aucune couleur
 * Tailwind figée (jetons `primary` / `base-*` / `info` uniquement).
 */

import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField, MoneyText } from '@/components/design-system';
import { DatePicker } from '@/components/date-picker';
import { today } from '@/lib/format';
import type { ExpenseRow } from '@/lib/expenses';

type FieldErrors = {
  category?: string;
  amount?: string;
  date?: string;
  reason?: string;
  form?: string;
};

/**
 * Message d'erreur lisible renvoyé par l'API (`fail()` de `lib/api.ts` traduit
 * déjà `ValidationError`, `ForbiddenError`… en français). On ne montre jamais
 * un code HTTP à l'utilisateur, et jamais un écran blanc.
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

/* ------------------------------------------------------------------ *
 * Créer / modifier
 * ------------------------------------------------------------------ */

export function ExpenseFormModal({
  isOpen,
  onClose,
  expense,
  expenseCategories,
  paymentMethods,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** `null` = création ; une dépense = modification. */
  expense: ExpenseRow | null;
  /** Liste **fermée** de `settings.expenseCategories` (§6.6). */
  expenseCategories: string[];
  /** Liste de `settings.paymentMethods`. */
  paymentMethods: string[];
  onSaved: () => void | Promise<void>;
}) {
  const isEdit = expense !== null;

  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [paymentMethod, setPaymentMethod] = useState('Espèces');
  const [beneficiary, setBeneficiary] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Le formulaire est réamorcé à chaque ouverture : jamais de résidu de la
  // dépense précédente (défaut classique d'une modale réutilisée).
  useEffect(() => {
    if (!isOpen) return;

    setCategory(expense?.category ?? expenseCategories[0] ?? '');
    setAmount(expense ? String(expense.amount) : '');
    setDate(expense?.date ?? today());
    setPaymentMethod(expense?.paymentMethod ?? paymentMethods[0] ?? 'Espèces');
    setBeneficiary(expense?.beneficiary ?? '');
    setDescription(expense?.description ?? '');
    setErrors({});
    setIsSubmitting(false);
  }, [isOpen, expense, expenseCategories, paymentMethods]);

  /**
   * Une catégorie sortie des paramètres depuis l'enregistrement reste
   * affichée (on ne réécrit pas l'histoire), mais elle est signalée : il faut
   * en choisir une de la liste pour pouvoir enregistrer.
   */
  const categoryOptions = (() => {
    const list = [...expenseCategories];
    if (category && !list.includes(category)) list.unshift(category);
    return list;
  })();
  const categoryIsLegacy = Boolean(category) && !expenseCategories.includes(category);

  function validate(): boolean {
    const next: FieldErrors = {};

    if (!category.trim()) {
      next.category = 'La catégorie est obligatoire';
    } else if (!expenseCategories.includes(category)) {
      next.category = 'Choisissez une catégorie de la liste des paramètres';
    }

    const parsed = Number(amount.replace(',', '.'));
    if (!amount.trim()) {
      next.amount = 'Le montant est obligatoire';
    } else if (!Number.isFinite(parsed) || parsed <= 0) {
      next.amount = 'Le montant doit être supérieur à 0';
    }

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
      const response = await fetch(isEdit ? `/api/depenses/${expense!.id}` : '/api/depenses', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          category,
          amount: Number(amount.replace(',', '.')),
          date,
          paymentMethod,
          beneficiary: beneficiary.trim() || null,
          description: description.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Enregistrement impossible"));
      }
      toast.success(isEdit ? 'Dépense modifiée' : 'Dépense enregistrée');
      await onSaved();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Enregistrement impossible";
      toast.error(message);
      setErrors((previous) => ({ ...previous, form: message }));
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
      title={isEdit ? 'Modifier la dépense' : 'Nouvelle dépense'}
      size="lg"
      fullScreenMobile
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField
          label="Catégorie"
          htmlFor="expense-category"
          required
          error={errors.category}
          hint={
            categoryIsLegacy
              ? "Cette catégorie n'est plus dans la liste des paramètres."
              : 'Liste fermée, gérée dans les paramètres.'
          }
        >
          <select
            id="expense-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="select select-bordered w-full"
          >
            <option value="">Choisir une catégorie…</option>
            {categoryOptions.map((item) => (
              <option key={item} value={item}>
                {item === category && categoryIsLegacy ? `${item} (hors liste)` : item}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="Montant (GNF)"
          htmlFor="expense-amount"
          required
          error={errors.amount}
          hint="Montant global de la dépense, supérieur à 0."
        >
          <input
            id="expense-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Ex. 250 000"
            className="input input-bordered w-full text-right tabular"
          />
        </FormField>

        <FormField label="Date" required error={errors.date}>
          <DatePicker value={date} onChange={setDate} placeholder="jj/mm/aaaa" />
        </FormField>

        <FormField label="Moyen de paiement" htmlFor="expense-payment-method">
          <select
            id="expense-payment-method"
            value={paymentMethod}
            onChange={(event) => setPaymentMethod(event.target.value)}
            className="select select-bordered w-full"
          >
            {paymentMethods.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="Bénéficiaire"
          htmlFor="expense-beneficiary"
          hint="Optionnel — à qui l'argent a été versé."
          className="sm:col-span-2"
        >
          <input
            id="expense-beneficiary"
            type="text"
            value={beneficiary}
            onChange={(event) => setBeneficiary(event.target.value)}
            placeholder="Ex. Mamadou Camara, SOTELGUI…"
            className="input input-bordered w-full"
          />
        </FormField>

        <FormField label="Description" htmlFor="expense-description" className="sm:col-span-2">
          <textarea
            id="expense-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            placeholder="Précisions utiles (trajet, période concernée, référence…)"
            className="textarea textarea-bordered w-full"
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
          Une dépense sort de la caisse et ne modifie jamais le stock. Une modification de
          montant, de moyen de paiement, de date ou de catégorie contre-passe l&apos;ancien
          mouvement de caisse et en enregistre un nouveau.
        </p>
      </div>

      {errors.form && (
        <p className="mt-3 rounded-xl border border-error/30 bg-error/10 p-3 text-xs text-error">
          {errors.form}
        </p>
      )}

      {/* Pied d'actions collant : le bouton reste atteignable sur un long
          formulaire mobile (§5.5 règle 4). */}
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
          ) : isEdit ? (
            'Enregistrer les modifications'
          ) : (
            'Enregistrer la dépense'
          )}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Annulation
 * ------------------------------------------------------------------ */

export function CancelExpenseModal({
  isOpen,
  onClose,
  expense,
  currency,
  onCancelled,
}: {
  isOpen: boolean;
  onClose: () => void;
  expense: ExpenseRow | null;
  currency: string;
  onCancelled: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setReason('');
    setErrors({});
    setIsSubmitting(false);
  }, [isOpen, expense]);

  async function handleConfirm() {
    if (isSubmitting || !expense) return;

    if (!reason.trim()) {
      setErrors({ reason: "Le motif d'annulation est obligatoire" });
      return;
    }

    setIsSubmitting(true);
    setErrors({});

    try {
      const response = await fetch(`/api/depenses/${expense.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason: reason.trim() }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Annulation impossible"));
      }

      toast.success('Dépense annulée');
      await onCancelled();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Annulation impossible";
      toast.error(message);
      setErrors({ form: message });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      tone="error"
      confirmLabel="Annuler la dépense"
      cancelLabel="Retour"
      isSubmitting={isSubmitting}
      title="Annuler cette dépense ?"
      message={
        expense ? (
          <div className="space-y-2">
            <p>
              La dépense <strong>{expense.category}</strong> de{' '}
              <MoneyText value={expense.amount} currency={currency} bold /> ne sera plus comptée
              dans les totaux ni dans le bénéfice net.
            </p>
            <p>
              Un mouvement de caisse inverse (entrée du même montant) sera enregistré. La dépense
              n&apos;est pas effacée : elle reste consultable dans le journal d&apos;actions.
            </p>
          </div>
        ) : (
          'Confirmez-vous cette annulation ?'
        )
      }
    >
      <FormField
        label="Motif de l'annulation"
        htmlFor="expense-cancel-reason"
        required
        error={errors.reason ?? errors.form}
        hint="Obligatoire : « Erreur de saisie », « Doublon », « Montant corrigé »…"
      >
        <textarea
          id="expense-cancel-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          placeholder="Pourquoi cette dépense est-elle annulée ?"
          className="textarea textarea-bordered w-full"
          disabled={isSubmitting}
        />
      </FormField>
    </ConfirmDialog>
  );
}
