'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string | React.ReactNode;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Force full-screen on mobile (bottom sheet style). Default false. */
  fullScreenMobile?: boolean;
  /**
   * Pied d'actions **épinglé en bas du cadre** : il ne fait pas partie de la
   * zone de défilement (le titre reste visible, seul le contenu défile) et se
   * place à 15 px du bord inférieur de la modale (`pb-[15px]` ci-dessous).
   *
   * Sans ce paramètre, rien ne change pour les autres modales : le contenu
   * entier défile dans la boîte, avec son rembourrage habituel.
   */
  footer?: React.ReactNode;
  /**
   * Fermer en cliquant à côté de la fenêtre (défaut : oui). À désactiver pour
   * une saisie longue : un clic à côté de l'assistant de création d'un compte
   * fermait la fenêtre et perdait tout ce qui avait été tapé (constaté en
   * recette le 4 octobre 2026). Le bouton ✕ ferme toujours.
   */
  closeOnOverlay?: boolean;
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

/**
 * La fenêtre est rendue **dans un portail** (`document.body`). Rendue sur
 * place, une modale ouverte depuis une autre (« Nouveau client » dans le
 * formulaire d'un chantier, d'un devis…) plaçait son `<form>` à l'intérieur du
 * `<form>` parent : HTML invalide (erreur d'hydratation « <form> cannot be a
 * descendant of <form> », constatée en recette le 8 octobre 2026).
 *
 * Un portail garde pourtant la remontée des événements **React** vers le
 * composant parent : sans `stopPropagation` ci-dessous, valider le client
 * déclenchait aussi l'envoi du formulaire du chantier.
 */
export function Modal({ isOpen, onClose, title, children, size = 'md', fullScreenMobile = false, footer, closeOnOverlay = true }: ModalProps) {
  const hasFooter = footer !== undefined && footer !== null;
  // Le portail n'existe qu'après le montage : le rendu serveur n'a pas de `document`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
          onSubmit={(event) => event.stopPropagation()}
        >
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            onClick={closeOnOverlay ? onClose : undefined}
          />

          {/* Modal box */}
          <motion.div
            initial={{ opacity: 0, y: fullScreenMobile ? 100 : -30, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: fullScreenMobile ? 100 : -50, scale: 0.97 }}
            transition={{ type: 'spring', duration: 0.5, bounce: fullScreenMobile ? 0 : 0.2 }}
            className={`modal-box ${sizeClasses[size]} relative z-10 shadow-2xl max-h-[90vh] overflow-y-auto
              ${hasFooter ? 'flex flex-col pb-[15px]' : ''}
              ${fullScreenMobile
                ? 'w-full rounded-b-none rounded-t-2xl sm:rounded-2xl sm:my-8 sm:mx-auto'
                : 'w-[calc(100%-1rem)] sm:w-full mx-auto my-2 sm:my-8'
              }`}
          >
            {title && (
              <div
                className={`flex items-center justify-between border-b border-base-200 pb-3 sm:pb-4 ${
                  hasFooter ? 'shrink-0' : ''
                }`}
              >
                <h3 className="text-base sm:text-lg font-bold">{title}</h3>
                <button onClick={onClose} className="btn btn-sm btn-circle btn-ghost hover:bg-base-300 shrink-0" aria-label="Fermer">✕</button>
              </div>
            )}
            <div
              className={`${title ? 'py-3 sm:py-4' : ''} ${
                hasFooter ? 'min-h-0 flex-1 overflow-y-auto' : ''
              }`}
            >
              {children}
            </div>
            {hasFooter && <div className="shrink-0">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
