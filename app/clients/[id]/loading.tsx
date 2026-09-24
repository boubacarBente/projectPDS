'use client';

/**
 * État de chargement de la fiche client (README §5.3).
 *
 * Un squelette épousant la forme du contenu — jamais un spinner plein écran :
 * quatre cartes de synthèse, puis le tableau des dernières factures.
 */

import { Skeleton, SkeletonCards, SkeletonTable } from '@/components/design-system';

export default function ClientDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div className="rounded-2xl border border-base-200 bg-base-100 p-5 shadow-sm sm:p-6">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-7 w-64" />
        <Skeleton className="mt-3 h-4 w-80" />
      </div>

      <SkeletonCards count={4} />
      <SkeletonTable rows={5} cols={5} />
    </div>
  );
}
