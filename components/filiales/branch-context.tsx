'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { EmptyState, ErrorState, SkeletonCards } from '@/components/design-system';
import {
  branchApi,
  branchHref,
  stageLabel,
  type BranchAccessLevel,
  type ProductionBranch,
} from '@/lib/branches-shared';

/**
 * Filiale courante (README §31) : chargée une fois par le gabarit
 * `app/filiales/[branchId]/layout.tsx`, partagée par tous ses écrans.
 *
 * - `href('/commandes')` → `/filiales/3/commandes` (liens rendus côté serveur : hook) ;
 * - `branchApiUrl('/commandes')` → `/api/filiales/3/commandes` : utilisable hors
 *   composant (gestionnaires d'événements, fonctions de chargement), car un appel
 *   d'API part toujours **du navigateur**, depuis une page de la filiale.
 *
 * Le serveur reste seul juge : chaque route `/api/filiales/[branchId]/*` vérifie
 * l'accès à la filiale (`requireBranch`). Ce contexte ne sert qu'à l'affichage.
 */

type BranchContextValue = {
  branch: ProductionBranch;
  href: (path?: string) => string;
  api: (path?: string) => string;
  stageLabel: (key: string) => string;
  /** Niveau de la session sur la filiale au moins égal à `level`. */
  canLevel: (level: BranchAccessLevel) => boolean;
  /** Filiale active : les écritures sont acceptées. */
  writable: boolean;
  reload: () => void;
};

const BranchContext = createContext<BranchContextValue | null>(null);

const RANK: Record<BranchAccessLevel, number> = { view: 1, edit: 2, manage: 3 };

export function useBranch(): BranchContextValue {
  const value = useContext(BranchContext);
  if (!value) throw new Error('useBranch() hors d’une page de filiale (/filiales/[branchId]).');
  return value;
}

/** Variante tolérante : `null` hors d’une filiale (composants partagés avec d’autres écrans). */
export function useOptionalBranch(): BranchContextValue | null {
  return useContext(BranchContext);
}

/** Identifiant de la filiale de l’URL courante (`/filiales/3/...`), ou `null`. */
export function currentBranchId(): number | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/^\/filiales\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

/**
 * URL d’API de la filiale de la page courante. Lève si la page n’est pas une
 * page de filiale : mieux vaut une erreur visible qu’un appel à la mauvaise filiale.
 */
export function branchApiUrl(path = ''): string {
  const id = currentBranchId();
  if (!id) throw new Error('Aucune filiale dans l’adresse de la page.');
  return branchApi(id, path);
}

export function BranchProvider({ branchId, children }: { branchId: number; children: ReactNode }) {
  const [branch, setBranch] = useState<ProductionBranch | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch(branchApi(branchId), { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          setError({ status: response.status, message: json?.error ?? 'La filiale n’a pas pu être chargée.' });
          return;
        }
        setBranch(json as ProductionBranch);
      })
      .catch((reason) => {
        if (reason?.name !== 'AbortError') setError({ status: 0, message: 'La filiale n’a pas pu être chargée.' });
      });
    return () => controller.abort();
  }, [branchId, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const value = useMemo<BranchContextValue | null>(() => {
    if (!branch || branch.id !== branchId) return null;
    const level = branch.access ?? 'view';
    return {
      branch,
      href: (path = '') => branchHref(branch.id, path),
      api: (path = '') => branchApi(branch.id, path),
      stageLabel: (key: string) => stageLabel(branch, key),
      canLevel: (wanted: BranchAccessLevel) => RANK[level] >= RANK[wanted],
      writable: branch.status === 'active',
      reload,
    };
  }, [branch, branchId, reload]);

  if (error) {
    if (error.status === 403 || error.status === 404) {
      return (
        <div className="p-4">
          <EmptyState
            title={error.status === 404 ? 'Filiale introuvable' : 'Filiale non autorisée'}
            description={error.message}
            action={
              <Link href="/filiales" className="btn btn-primary min-h-11">
                Voir mes filiales
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div className="p-4">
        <ErrorState title="Filiale indisponible" description={error.message} onRetry={reload} />
      </div>
    );
  }
  if (!value) {
    return (
      <div className="space-y-4 p-4" aria-busy="true">
        <SkeletonCards count={4} />
      </div>
    );
  }
  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}
