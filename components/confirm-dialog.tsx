'use client';

import type { ReactNode } from 'react';
import { Modal } from '@/components/modal';

/**
 * Enveloppe de `Modal` pour toute confirmation (README §5.3, §8.2).
 *
 * Conventions appliquées (§8.3) :
 *  - un seul état booléen par modale, porté par l'appelant ;
 *  - `onClose` ne ferme **jamais** pendant une opération en cours ;
 *  - bouton de confirmation désactivé + spinner pendant l'envoi ;
 *  - icône d'avertissement colorée selon la nature (destructif / création / effet de bord) ;
 *  - pied de modale systématique, actions collantes sur mobile.
 */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  isSubmitting = false,
  tone = 'error',
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  /** Phrase de conséquence — ce qui va réellement se passer. */
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  isSubmitting?: boolean;
  /** `error` destructif · `success` création · `warning` effet de bord. */
  tone?: 'error' | 'success' | 'warning' | 'primary';
  /** Contenu additionnel (champ « motif » obligatoire, par exemple). */
  children?: ReactNode;
}) {
  const toneClasses: Record<string, string> = {
    error: 'bg-error/10 text-error',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    primary: 'bg-primary/10 text-primary',
  };
  const buttonClasses: Record<string, string> = {
    error: 'btn-error',
    success: 'btn-success',
    warning: 'btn-warning',
    primary: 'btn-primary',
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={title}
      size="sm"
    >
      <div className="py-2">
        <div className="mb-4 flex items-start gap-3">
          <div className={`shrink-0 rounded-full p-3 ${toneClasses[tone]}`}>
            {tone === 'success' ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m0 3.75h.008M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                />
              </svg>
            )}
          </div>
          <div className="text-sm text-base-content/70">{message}</div>
        </div>

        {children}

        <div className="flex justify-end gap-3 border-t border-base-200 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="btn btn-ghost"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={isSubmitting}
            className={`btn ${buttonClasses[tone]}`}
          >
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
