'use client';

import type { ReactNode } from 'react';
import { useAuth } from '@/components/auth-provider';
import type { Action } from '@/lib/permissions';

/**
 * Masque un bloc selon la permission (README §5.3, §5.4).
 *
 * La décision vient du contexte d'authentification, donc des **permissions
 * effectives** : matrice du rôle **puis** surcharges par utilisateur décidées
 * par l'administrateur. Un droit retiré à la main disparaît donc réellement de
 * l'interface, et un droit accordé à la main y apparaît.
 *
 * ⚠️ **Masquer n'est pas protéger.** Ce composant n'est qu'un confort
 * d'interface : chaque Route Handler vérifie systématiquement les droits via
 * `requireAction()`. Ne jamais s'appuyer sur lui pour la sécurité.
 */
export function RoleGate({
  action,
  anyOf,
  children,
  fallback = null,
}: {
  action?: Action;
  anyOf?: Action[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can, permissions, isLoading } = useAuth();

  // Pendant le chargement des permissions, on n'affiche pas le bloc plutôt que
  // de l'afficher puis de le retirer : un bouton qui apparaît puis disparaît
  // est plus déroutant qu'un bouton qui apparaît un peu plus tard.
  if (isLoading || permissions === null) return <>{fallback}</>;

  const allowed =
    anyOf && anyOf.length > 0 ? anyOf.some((a) => can(a)) : action ? can(action) : false;

  return <>{allowed ? children : fallback}</>;
}

/** Version hook, pour un `if` dans un composant client. */
export function usePermission(action: Action): boolean {
  const { can } = useAuth();
  return can(action);
}

export function usePermissionAny(actions: Action[]): boolean {
  const { can } = useAuth();
  return actions.some((a) => can(a));
}

/** Vrai quand les permissions sont chargées (utile pour différer un rendu). */
export function usePermissionsReady(): boolean {
  const { permissions, isLoading } = useAuth();
  return !isLoading && permissions !== null;
}
