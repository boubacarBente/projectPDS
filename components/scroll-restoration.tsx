'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { initScrollEngine, notifyRouteRendered } from '@/lib/scroll-engine';

/**
 * Monte le moteur de restauration du scroll. Ne rend rien.
 *
 * À monter une seule fois, en **frère** de `<AppShell>` dans le layout racine :
 * `AppShell` a des retours anticipés (page `/login`, écran de chargement auth)
 * qui démonteraient ce composant et réinitialiseraient le moteur.
 *
 * Ne pas utiliser `useSearchParams` ici : en Next 16 il exige un boundary
 * `<Suspense>` faute de quoi le build de production échoue
 * (`missing-suspense-with-csr-bailout`). Le jour où les filtres de liste
 * passent dans l'URL, dépendre plutôt de `pathname` + d'un listener popstate.
 */
export function ScrollRestoration() {
  const pathname = usePathname();

  useEffect(() => initScrollEngine(), []);

  // Un changement de pathname signifie que React a commit le DOM de la nouvelle
  // route : c'est le signal qui libère la restauration mise en attente par
  // `popstate`. Attendre ce signal évite de scroller sur le contenu de la page
  // sortante, qui est encore en place — et donc encore haut — juste après le
  // retour arrière.
  useEffect(() => {
    notifyRouteRendered();
  }, [pathname]);

  return null;
}
