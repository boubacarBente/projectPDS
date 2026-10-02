'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';

/**
 * Portée de **consultation** d'un écran : magasin actif, tous les magasins
 * (vue consolidée) ou un magasin précis.
 *
 * Les API de lecture acceptent `?store=` :
 *  - absent   → magasin actif (défaut) ;
 *  - `all`    → tous les magasins accessibles ;
 *  - `<id>`   → ce magasin (refusé s'il n'est pas dans le périmètre).
 *
 * La portée ne change **que l'affichage** : une écriture (vente, dépense…)
 * va toujours dans le magasin actif. Le choix est mémorisé par écran dans
 * `sessionStorage` (préférence locale, sans conséquence si indisponible).
 */
export type StoreScopeValue = 'current' | 'all' | number;

export function useStoreScope(screenKey: string) {
  const { stores } = useAuth();
  const storageKey = `pd-scope:${screenKey}`;
  const [scope, setScopeState] = useState<StoreScopeValue>('current');

  useEffect(() => {
    try {
      // Un lien `?store=<id>|all` (raccourcis de la fiche magasin) prime sur la
      // préférence mémorisée.
      const fromUrl = new URLSearchParams(window.location.search).get('store');
      const raw = fromUrl ?? window.sessionStorage.getItem(storageKey);
      if (raw === 'all') setScopeState('all');
      else if (raw && /^\d+$/.test(raw)) setScopeState(Number(raw));
    } catch {
      /* stockage indisponible : portée par défaut */
    }
  }, [storageKey]);

  const setScope = useCallback(
    (value: StoreScopeValue) => {
      setScopeState(value);
      try {
        window.sessionStorage.setItem(storageKey, String(value));
      } catch {
        /* sans effet */
      }
    },
    [storageKey],
  );

  /** Valeur à passer dans `?store=` (chaîne vide = magasin actif). */
  const param = scope === 'current' ? '' : String(scope);

  /** Ajoute `store=` à des `URLSearchParams` existants. */
  const apply = useCallback(
    (params: URLSearchParams) => {
      if (param) params.set('store', param);
      return params;
    },
    [param],
  );

  return { scope, setScope, param, apply, isMultiStore: stores.length > 1, isConsolidated: scope === 'all' };
}

/**
 * Liste déroulante « Magasin actif / Tous les magasins / <magasin> ».
 * Ne s'affiche que si l'utilisateur a accès à plusieurs magasins.
 */
export function StoreScopeSelect({
  value,
  onChange,
  className = '',
}: {
  value: StoreScopeValue;
  onChange: (value: StoreScopeValue) => void;
  className?: string;
}) {
  const { stores, activeStore } = useAuth();
  if (stores.length <= 1) return null;

  return (
    <select
      className={`select select-sm select-bordered ${className}`}
      value={value === activeStore?.id ? 'current' : String(value)}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(raw === 'current' ? 'current' : raw === 'all' ? 'all' : Number(raw));
      }}
      aria-label="Magasins affichés"
    >
      <option value="current">{activeStore ? `Magasin actif (${activeStore.name})` : 'Magasin actif'}</option>
      <option value="all">Tous les magasins</option>
      {stores
        .filter((s) => s.id !== activeStore?.id)
        .map((store) => (
          <option key={store.id} value={store.id}>
            {store.name}
          </option>
        ))}
    </select>
  );
}
