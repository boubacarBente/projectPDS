'use client';

/**
 * Fiche d'un compte — `/utilisateurs/[id]` (refonte du 4 octobre 2026).
 *
 * Page entière plutôt qu'une fenêtre : le client a jugé la fenêtre « Gérer »
 * trop étroite pour les magasins et les quinze domaines de droits. L'onglet
 * ouvert est gardé dans l'adresse (`?onglet=droits`) : un lien ou un retour
 * arrière rouvre au même endroit.
 *
 * Le serveur reste seul juge : `GET /api/users/[id]` exige `users.manage` et
 * le périmètre du gérant (403 sinon).
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { USER_TABS, UserDetail, type UserListItem, type UserTab } from '@/components/utilisateurs/user-detail';
import { ROLE_LABELS } from '@/lib/permissions';

function isTab(value: string | null): value is UserTab {
  return USER_TABS.some((t) => t.key === value);
}

export default function UtilisateurPage() {
  const allowed = usePermission('users.manage');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { device, user: me } = useAuth();
  const userId = Number(params.id);

  const [user, setUser] = useState<UserListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [tab, setTab] = useState<UserTab>('profil');

  // Onglet demandé dans l'adresse (`?onglet=droits`), lu après le montage comme
  // ailleurs dans l'application (pas de useSearchParams : il exige une Suspense).
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('onglet');
    if (isTab(requested)) setTab(requested);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/users/${userId}`, { cache: 'no-store', credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error ?? `Erreur ${response.status}`);
      setUser(payload as UserListItem);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Compte indisponible');
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (allowed && Number.isInteger(userId) && userId > 0) void load();
  }, [allowed, userId, load]);

  const changeTab = (next: UserTab) => {
    setTab(next);
    // `replace` : changer d'onglet n'ajoute pas une entrée d'historique par clic.
    router.replace(`/utilisateurs/${userId}?onglet=${next}`, { scroll: false });
  };

  const header = (
    <PageHeader
      eyebrow="Administration › Utilisateurs"
      title={user ? user.name : 'Compte'}
      description={user ? `${ROLE_LABELS[user.role]} · identifiant ${user.username}` : 'Profil, magasins, droits et sécurité du compte.'}
    />
  );

  if (!allowed) {
    return (
      <div className="space-y-5">
        {header}
        <Card>
          <EmptyState title="Accès réservé" description="La gestion des comptes est réservée à l’administrateur et aux gérants qui en ont reçu le droit." />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {header}
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : error || !user ? (
        <Card>
          <ErrorState title="Compte indisponible" description={error ?? 'Compte introuvable'} onRetry={() => void load()} />
        </Card>
      ) : (
        <UserDetail
          user={user}
          // Poste de magasin, compte du super administrateur vu par un autre, ou
          // administrateur vu par qui n'est pas super administrateur : consultation.
          readOnly={
            device?.mode === 'store' ||
            (user.id !== me?.id && (user.isSuperAdmin || (user.role === 'admin' && !me?.isSuperAdmin)))
          }
          tab={tab}
          onTabChange={changeTab}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
