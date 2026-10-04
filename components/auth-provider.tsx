'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { can as canOnPermissions, type Action, type Role } from '@/lib/permissions';

/**
 * Contexte d'authentification (repris du projet Gaz, §3.1).
 *
 * Deux évolutions :
 *  - le rôle est l'un des **6 rôles** du schéma cible (§17.2) ;
 *  - le contexte porte les **permissions effectives**, c'est-à-dire la matrice
 *    du rôle **puis** les surcharges décidées par l'administrateur pour cet
 *    utilisateur (demande explicite du client). Le menu et les écrans filtrent
 *    sur cette liste, et non sur le seul rôle.
 *
 * ⚠️ Ce filtrage est un **confort d'interface**, pas une sécurité : chaque API
 * revérifie la permission de son côté (`requireAction` → `lib/user-permissions`).
 */

export type AuthUser = {
  id: number;
  name: string;
  username: string;
  role: Role;
};

/** Magasin accessible à l'utilisateur sur ce poste. */
export type AuthStore = {
  id: number;
  code: string;
  name: string;
  kind: 'store' | 'headquarters';
  status: 'active' | 'suspended' | 'archived';
};

/** Rôle du poste dans le réseau (voir `lib/device.ts`). */
export type AuthDevice = {
  mode: 'standalone' | 'hq' | 'store';
  storeId: number | null;
  deviceCode: string | null;
  connected: boolean;
};

type AuthContextType = {
  user: AuthUser | null;
  /** Permissions effectives ; `null` tant qu'elles ne sont pas chargées. */
  permissions: Action[] | null;
  isLoading: boolean;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /** `can('sales.cancel')` — tient compte des surcharges par utilisateur. */
  can: (action: Action) => boolean;
  /** Magasins accessibles sur ce poste (sélecteur de magasin). */
  stores: AuthStore[];
  /** Magasin actif de la session : toutes les opérations y sont enregistrées. */
  activeStoreId: number | null;
  activeStore: AuthStore | null;
  /** Compte multi-magasins (administrateur général ou `stores.viewAll`). */
  allStores: boolean;
  /** Droit de changer de magasin actif (`stores.switch`, README §28.6). */
  canSwitchStore: boolean;
  device: AuthDevice | null;
  /** Change le magasin actif puis recharge la page (toutes les données changent). */
  switchStore: (storeId: number) => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  permissions: null,
  isLoading: true,
  logout: async () => {},
  refreshUser: async () => {},
  can: () => false,
  stores: [],
  activeStoreId: null,
  activeStore: null,
  allStores: false,
  canSwitchStore: false,
  device: null,
  switchStore: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<Action[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [stores, setStores] = useState<AuthStore[]>([]);
  const [activeStoreId, setActiveStoreId] = useState<number | null>(null);
  const [allStores, setAllStores] = useState(false);
  const [canSwitchStore, setCanSwitchStore] = useState(false);
  const [device, setDevice] = useState<AuthDevice | null>(null);
  const refreshRequestId = useRef(0);

  const refreshUser = useCallback(async () => {
    const requestId = refreshRequestId.current + 1;
    refreshRequestId.current = requestId;
    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/me', {
        cache: 'no-store',
        credentials: 'same-origin',
      });

      if (res.ok) {
        const data = await res.json();
        if (requestId !== refreshRequestId.current) return;
        setUser(data.user ?? null);
        setPermissions(Array.isArray(data.permissions) ? data.permissions : null);
        setStores(Array.isArray(data.stores) ? data.stores : []);
        setActiveStoreId(typeof data.activeStoreId === 'number' ? data.activeStoreId : null);
        setAllStores(Boolean(data.allStores));
        setCanSwitchStore(Boolean(data.canSwitchStore));
        setDevice(data.device ?? null);
      } else if (requestId === refreshRequestId.current) {
        setUser(null);
        setPermissions(null);
      }
    } catch {
      if (requestId === refreshRequestId.current) {
        setUser(null);
        setPermissions(null);
      }
    } finally {
      if (requestId === refreshRequestId.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const logout = useCallback(async () => {
    refreshRequestId.current += 1;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
      setPermissions(null);
      window.location.href = '/login';
    }
  }, []);

  /**
   * Tant que les permissions ne sont pas chargées, on retombe sur la matrice du
   * rôle (`permissions = null`) : l'interface reste utilisable, et le serveur
   * reste seul juge.
   */
  const can = useCallback(
    (action: Action) => canOnPermissions(user, action, permissions),
    [user, permissions],
  );

  const switchStore = useCallback(async (storeId: number) => {
    const res = await fetch('/api/auth/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ storeId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error ?? 'Changement de magasin impossible');
    }
    // Toutes les données affichées dépendent du magasin : rechargement complet.
    window.location.reload();
  }, []);

  const activeStore = stores.find((s) => s.id === activeStoreId) ?? null;

  return (
    <AuthContext.Provider
      value={{
        user,
        permissions,
        isLoading,
        logout,
        refreshUser,
        can,
        stores,
        activeStoreId,
        activeStore,
        allStores,
        canSwitchStore,
        device,
        switchStore,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
