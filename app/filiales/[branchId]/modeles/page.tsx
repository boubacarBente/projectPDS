'use client';

import { PageHeader } from '@/components/page-header';
import { useBranch } from '@/components/filiales/branch-context';
import { BrickTabs } from '@/components/briqueterie/brick-tabs';
import { BrickTypesPanel } from '@/components/briqueterie/briqueterie-modals';
import { AtelierImportCard } from '@/components/filiales/model-materials';
import { useState } from 'react';

/**
 * Onglet « Modèles » d'une filiale (README §31.3) : ce que la filiale fabrique
 * ou vend — brique 15 creuse, vitre claire 6 mm, armoire 3 portes… Remplace
 * l'ancien écran « Types de briques ».
 */
export default function BranchModelsPage() {
  const B = useBranch();
  const [version, setVersion] = useState(0);
  return (
    <div className="mx-auto w-full max-w-7xl 2xl:max-w-[100rem] space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow={B.branch.name}
        title="Modèles"
        description="Ce que la filiale fabrique ou vend : catégorie, unité, dimensions, prix et stock (portés par le produit lié), seuil d’alerte, nomenclature des matières."
      />
      <BrickTabs />
      <AtelierImportCard onImported={() => setVersion((v) => v + 1)} />
      <BrickTypesPanel key={version} isOpen />
    </div>
  );
}
