'use client';

import { motion, AnimatePresence } from 'framer-motion';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string | React.ReactNode;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Force full-screen on mobile (bottom sheet style). Default false. */
  fullScreenMobile?: boolean;
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export function Modal({ isOpen, onClose, title, children, size = 'md', fullScreenMobile = false }: ModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Modal box */}
          <motion.div
            initial={{ opacity: 0, y: fullScreenMobile ? 100 : -30, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: fullScreenMobile ? 100 : -50, scale: 0.97 }}
            transition={{ type: 'spring', duration: 0.5, bounce: fullScreenMobile ? 0 : 0.2 }}
            className={`modal-box ${sizeClasses[size]} relative z-10 shadow-2xl max-h-[90vh] overflow-y-auto
              ${fullScreenMobile
                ? 'w-full rounded-b-none rounded-t-2xl sm:rounded-2xl sm:my-8 sm:mx-auto'
                : 'w-[calc(100%-1rem)] sm:w-full mx-auto my-2 sm:my-8'
              }`}
          >
            {title && (
              <div className="flex items-center justify-between border-b border-base-200 pb-3 sm:pb-4">
                <h3 className="text-base sm:text-lg font-bold">{title}</h3>
                <button onClick={onClose} className="btn btn-sm btn-circle btn-ghost hover:bg-base-300 shrink-0" aria-label="Fermer">✕</button>
              </div>
            )}
            <div className={title ? 'py-3 sm:py-4' : ''}>{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
