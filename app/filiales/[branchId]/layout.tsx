'use client';

import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { BranchProvider } from '@/components/filiales/branch-context';

/**
 * Espace d'une filiale de production (README §31.2) : la filiale est chargée
 * une fois ici et partagée par ses onglets (tableau de bord, modèles,
 * productions, stock, commandes, ventes, clients, rapports).
 */
export default function BranchLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ branchId: string }>();
  return <BranchProvider branchId={Number(params?.branchId)}>{children}</BranchProvider>;
}
