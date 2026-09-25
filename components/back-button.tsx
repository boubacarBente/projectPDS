'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Tooltip } from '@/components/tooltip';
import { canGoBack } from '@/lib/scroll-engine';

/** Routes sans chrome applicatif, où le bouton n'a pas de sens. */
const EXCLUDED_PATHS = new Set(['/login']);

/**
 * Route parente déduite du chemin, utilisée quand il n'y a plus d'entrée
 * précédente dans l'historique (lancement direct, ou retour jusqu'à l'origine).
 *
 *   /ventes/12              -> /ventes
 *   /clients/12/paiements   -> /clients/12
 *   /clients/types          -> /clients
 *   /ventes                 -> /
 */
function parentRoute(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length <= 1) return '/';
  return `/${segments.slice(0, -1).join('/')}`;
}

/**
 * Bouton retour, affiché en haut à gauche du contenu de toutes les pages.
 *
 * Monté une seule fois dans le layout applicatif (`components/app-shell.tsx`),
 * il remplace les flèches « Retour vers X » codées en dur dans les pages de
 * détail. Deux raisons :
 *
 * 1. Ces flèches étaient des `<Link href="/ventes">` : elles **empilent** une
 *    nouvelle entrée d'historique au lieu de revenir. Le moteur de restauration
 *    (`lib/scroll-engine.ts`) ne se déclenche que sur une vraie traversée, donc
 *    elles ne restauraient jamais ni la position ni la pagination.
 *
 * 2. Dans l'application Electron il n'y a aucune chrome de navigateur
 *    (`electron/main.js` : `setMenuBarVisibility(false)`, pas de barre d'outils),
 *    donc aucun bouton retour natif — il doit venir de l'application.
 */
export function BackButton({ withMargin = true }: { withMargin?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();

  // Rendu identique serveur/client au premier passage : le bouton dépend de
  // l'historique, indisponible au SSR. On ne l'affiche qu'après montage pour
  // éviter tout écart d'hydratation.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [hasHistory, setHasHistory] = useState(false);

  // Réévalué à chaque navigation : l'historique change sans que React ne
  // re-rende forcément pour une autre raison.
  useEffect(() => {
    setHasHistory(canGoBack());
  }, [pathname]);

  const visible = mounted && hasHistory && !EXCLUDED_PATHS.has(pathname);

  const handleBack = () => {
    if (canGoBack()) {
      router.back();
      return;
    }
    router.push(parentRoute(pathname));
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -6 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className={`flex items-center print:hidden ${withMargin ? 'mb-3 sm:mb-4' : ''}`}
        >
          <Tooltip label="Retour à la page précédente">
            <button
              type="button"
              onClick={handleBack}
              className="btn btn-ghost btn-sm btn-square"
              aria-label="Retour à la page précédente"
            >
              <svg
                className="h-4 w-4 sm:h-5 sm:w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </button>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
