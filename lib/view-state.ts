'use client';

/**
 * Snapshot de l'état de vue des pages de liste, indexé sur la **même maille**
 * que les positions de scroll : l'entrée d'historique.
 *
 * Pourquoi c'est indispensable : sur ces pages, `currentPage`, `search` et les
 * filtres vivent dans des `useState` locaux. Au retour arrière, Next remonte le
 * composant, donc tout repart à page 1 sans filtre. Restaurer la position de
 * scroll sans restaurer l'état qui l'a produite ne sert à rien : le contenu
 * revenu est plus court et la position est clampée. Les deux couches doivent
 * partager la même clé.
 *
 * ── Règle « est-ce un retour ? » ─────────────────────────────────────────────
 * Chromium expose une clé unique par entrée d'historique : l'existence d'un
 * snapshot pour cette clé prouve à elle seule qu'on revient sur une entrée déjà
 * visitée — une navigation avant crée une clé neuve, donc aucun snapshot.
 * Firefox/Safari n'ont pas cette API et se rabattent sur `pathname + search`,
 * qu'une nouvelle navigation avant réutilise : il faut donc y exiger en plus
 * une traversée d'historique, sinon un clic dans la sidebar rouvrirait la
 * page 3 mémorisée au lieu de repartir du haut.
 *
 * ── Hydratation ─────────────────────────────────────────────────────────────
 * La réhydratation passe par `useLayoutEffect`, jamais par un initialiseur de
 * `useState`. Les pages sont des composants client mais Next les rend quand
 * même côté serveur : lire `sessionStorage` dans un initialiseur produirait un
 * HTML serveur (page 1, recherche vide) différent du premier rendu client
 * (page 3, recherche remplie), donc une erreur d'hydratation React 19.
 */

import { useEffect, useLayoutEffect, useState } from 'react';
import {
  currentEntryKey,
  hasNavigationApi,
  isTraverseNavigation,
} from './scroll-engine';

/** Clé de stockage dans `sessionStorage`. */
const STORE_KEY = '__gaz_view_state_v1__';

/** Nombre maximum d'entrées conservées (éviction LRU sur `at`). */
const MAX_ENTRIES = 30;

/** Délai d'écriture du store dans `sessionStorage`. */
const PERSIST_DEBOUNCE_MS = 150;

type Slot = {
  /** Valeurs de la page, telles que passées à `writeViewState`. */
  state: Record<string, unknown>;
  /** URL au moment du relevé, pour invalider un snapshot périmé. */
  url: string;
  /** Horodatage, utilisé pour l'éviction LRU. */
  at: number;
};

type Store = Record<string, Slot>;

// `window` n'existe pas au SSR : on choisit l'effet une fois pour toutes.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

let memStore: Store | null = null;
let persistTimer: number | null = null;
let flushBound = false;

// ── Persistance ─────────────────────────────────────────────────────────────

function slotKey(entryKey: string, name: string): string {
  return `${entryKey}::${name}`;
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function prune(store: Store): Store {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return store;

  keys.sort((a, b) => (store[a]?.at ?? 0) - (store[b]?.at ?? 0));

  const next: Store = {};
  for (let i = keys.length - MAX_ENTRIES; i < keys.length; i += 1) {
    next[keys[i]] = store[keys[i]];
  }
  memStore = next;
  return next;
}

function loadStore(): Store {
  if (memStore) return memStore;

  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    memStore =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Store)
        : {};
  } catch {
    memStore = {};
  }

  return memStore;
}

function persistStore(): void {
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(prune(loadStore())));
  } catch {
    // Quota dépassé ou stockage désactivé : sans gravité, la mémoire suffit.
  }
}

/**
 * L'écriture est différée, mais un `pagehide` la force : sans cela, un
 * changement de filtre suivi d'une fermeture immédiate serait perdu.
 */
function schedulePersist(): void {
  if (typeof window === 'undefined') return;

  if (!flushBound) {
    flushBound = true;
    window.addEventListener('pagehide', () => {
      if (persistTimer !== null) {
        window.clearTimeout(persistTimer);
        persistTimer = null;
      }
      persistStore();
    });
  }

  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistStore();
  }, PERSIST_DEBOUNCE_MS);
}

// ── API publique ────────────────────────────────────────────────────────────

/**
 * Relit l'état de vue mémorisé pour cette page, ou `null` s'il n'y a rien à
 * restaurer (première visite, navigation avant, URL différente).
 *
 * Synchrone et sans effet de bord : appelable depuis un `useLayoutEffect`.
 */
export function readViewState<T extends object>(name: string): Partial<T> | null {
  if (typeof window === 'undefined') return null;

  // Le navigateur gère nativement le défilement vers une ancre.
  if (window.location.hash) return null;

  // Sans API Navigation, la clé de repli est l'URL : une traversée est requise.
  if (!hasNavigationApi() && !isTraverseNavigation()) return null;

  const slot = loadStore()[slotKey(currentEntryKey(), name)];
  if (!slot) return null;

  // Garde-fou : un snapshot relevé sur une autre URL est périmé.
  if (slot.url !== currentUrl()) return null;

  return slot.state as Partial<T>;
}

/** Mémorise l'état de vue courant pour cette page, sur l'entrée d'historique active. */
export function writeViewState<T extends object>(name: string, value: T): void {
  if (typeof window === 'undefined') return;
  if (window.location.hash) return;

  loadStore()[slotKey(currentEntryKey(), name)] = {
    state: value as Record<string, unknown>,
    url: currentUrl(),
    at: Date.now(),
  };

  schedulePersist();
}

/**
 * Réhydrate l'état d'une page au montage, avant peinture, puis indique que
 * c'est fait.
 *
 * Le booléen retourné doit servir à **bloquer le premier fetch** : sans lui, la
 * page partirait chercher la page 1 puis relancerait aussitôt pour la page 3.
 */
export function useViewStateRehydration<T extends object>(
  name: string,
  apply: (saved: Partial<T>) => void,
): boolean {
  const [rehydrated, setRehydrated] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const saved = readViewState<T>(name);
    if (saved) apply(saved);
    setRehydrated(true);
    // Volontairement au montage uniquement : `apply` ne fait que pousser des
    // setState stables. La rejouer écraserait les modifications de l'utilisateur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return rehydrated;
}

/**
 * Corrige une page restaurée devenue hors bornes : entre le relevé et le retour,
 * la liste a pu rétrécir (suppressions) et la page mémorisée n'existe plus, ce
 * qui ferait afficher une liste vide.
 *
 * @returns la page corrigée, ou `null` si la page courante est valide.
 */
export function clampPage(page: number, totalPages: number): number | null {
  if (page > 1 && totalPages >= 1 && page > totalPages) return totalPages;
  return null;
}
