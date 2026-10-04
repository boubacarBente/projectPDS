'use client';

/**
 * Fiche d'un compte — page `/utilisateurs/[id]` (refonte du 4 octobre 2026) :
 * tout ce qui concerne une personne au même endroit, en quatre onglets —
 * **Profil**, **Magasins**, **Droits**, **Sécurité**. Avant, il fallait cinq
 * boutons-icônes et cinq fenêtres différentes. D'abord livrée en fenêtre, la
 * fiche est devenue une page entière à la demande du client : quinze domaines
 * de droits et les affectations y manquaient de place.
 *
 * Routes utilisées (toutes revérifiées côté serveur) :
 *  - `PUT /api/users/[id]` (profil, rôle) ;
 *  - `GET|PUT /api/users/[id]/magasins` (affectations, changer de magasin) ;
 *  - `GET|PUT|DELETE /api/users/[id]/permissions` (droits par domaine) ;
 *  - `PUT /api/users/[id]/password`, `DELETE /api/users/[id]` (désactivation).
 *
 * Un administrateur a tous les droits et **ne se désactive pas** : l'onglet
 * Droits et le bouton de désactivation l'expliquent au lieu d'échouer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { Badge, FormField } from '@/components/design-system';
import { PasswordInput } from '@/components/password-input';
import { useAuth } from '@/components/auth-provider';
import { ROLES, ROLE_LABELS, type Action, type Role } from '@/lib/permissions';
import { MIN_PASSWORD_LENGTH } from '@/lib/constants';
import { formatDateTime } from '@/lib/date-format';
import type { UserStoreAssignment } from '@/lib/stores';
import type { UserRow } from '@/lib/users';
import {
  AccessEditor,
  RoleChooser,
  actionsFromChoices,
  choicesFromActions,
  type AccessChoices,
} from '@/components/utilisateurs/access-editor';
import { StoreAssignmentEditor, useAssignableStores, type AssignmentDraft } from '@/components/utilisateurs/store-assignments';

export type UserListItem = UserRow & { canSwitchStore?: boolean; customized?: boolean };

export type UserTab = 'profil' | 'magasins' | 'droits' | 'securite';
type Tab = UserTab;
export const USER_TABS: { key: Tab; label: string }[] = [
  { key: 'profil', label: 'Profil' },
  { key: 'magasins', label: 'Magasins' },
  { key: 'droits', label: 'Droits' },
  { key: 'securite', label: 'Sécurité' },
];

type Matrix = { isAdmin: boolean; roleDefaults: Action[]; effective: Action[] };

async function send(url: string, method: string, body?: unknown): Promise<any> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error ?? `Erreur ${response.status}`);
  return payload;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function UserDetail({
  user,
  readOnly,
  tab,
  onTabChange,
  onChanged,
}: {
  user: UserListItem;
  /** Poste de magasin, ou compte administrateur vu par un gérant : consultation. */
  readOnly: boolean;
  /** Onglet affiché (gardé dans l'adresse `?onglet=` par la page). */
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  /** Relecture du compte après une modification. */
  onChanged: () => void;
}) {
  const { user: me, allStores } = useAuth();
  const { stores } = useAssignableStores(true);
  const setTab = onTabChange;

  // Profil
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>('seller');
  // Magasins
  const [assignments, setAssignments] = useState<AssignmentDraft[] | null>(null);
  const [canSwitch, setCanSwitch] = useState(false);
  // Droits
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [choices, setChoices] = useState<AccessChoices>({});
  // Sécurité
  const [password, setPassword] = useState('');
  const [confirmStatus, setConfirmStatus] = useState(false);

  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadMatrix = useCallback(async (id: number) => {
    const payload = (await send(`/api/users/${id}/permissions`, 'GET')) as Matrix;
    setMatrix(payload);
    setChoices(choicesFromActions(payload.effective));
    setCanSwitch(payload.effective.includes('stores.switch'));
  }, []);

  // Champs du profil : relus à chaque rechargement du compte.
  useEffect(() => {
    setName(user.name);
    setUsername(user.username);
    setPhone(user.phone ?? '');
    setRole(user.role);
  }, [user]);

  // Affectations et droits : chargés une fois par compte (pas à chaque relecture,
  // sinon une saisie en cours dans un autre onglet serait écrasée).
  useEffect(() => {
    setAssignments(null);
    setMatrix(null);
    setPassword('');
    setConfirmStatus(false);
    setLoadError(null);
    let active = true;
    Promise.all([send(`/api/users/${user.id}/magasins`, 'GET'), loadMatrix(user.id)])
      .then(([list]) => {
        if (!active) return;
        setAssignments(
          ((Array.isArray(list) ? list : []) as UserStoreAssignment[])
            .filter((a) => a.isActive)
            .map((a) => ({ storeId: a.storeId, isManager: a.isManager, startsAt: a.startsAt, endsAt: a.endsAt })),
        );
      })
      .catch((caught: unknown) => {
        if (active) setLoadError(caught instanceof Error ? caught.message : 'Fiche indisponible');
      });
    return () => {
      active = false;
    };
  }, [user.id, loadMatrix]);

  const roleChoices = useMemo(() => choicesFromActions(matrix?.roleDefaults ?? []), [matrix]);
  const roles = ROLES.filter((r) => r !== 'admin' || allStores);
  const isAdmin = user.role === 'admin';
  const isMe = user.id === me?.id;

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Opération impossible', { autoClose: 9000 });
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = () =>
    run(async () => {
      await send(`/api/users/${user.id}`, 'PUT', {
        name: name.trim(),
        username: username.trim().toLowerCase(),
        phone: phone.trim() || null,
        role,
      });
      await loadMatrix(user.id);
    }, 'Profil enregistré');

  const saveStores = () =>
    run(async () => {
      if (!isAdmin && (assignments ?? []).length === 0) throw new Error('Cochez au moins un magasin.');
      await send(`/api/users/${user.id}/magasins`, 'PUT', {
        stores: assignments ?? [],
        ...(isAdmin ? {} : { canSwitchStore: canSwitch }),
      });
      await loadMatrix(user.id);
    }, 'Magasins enregistrés');

  const saveRights = () =>
    run(async () => {
      const desired = new Set(actionsFromChoices(choices, matrix!.effective));
      const defaults = new Set(matrix!.roleDefaults);
      const overrides = [
        ...[...desired].filter((a) => !defaults.has(a)).map((action) => ({ action, effect: 'allow' })),
        ...[...defaults].filter((a) => !desired.has(a)).map((action) => ({ action, effect: 'deny' })),
      ];
      await send(`/api/users/${user.id}/permissions`, 'PUT', { overrides });
      await loadMatrix(user.id);
    }, 'Droits enregistrés');

  const resetRights = () =>
    run(async () => {
      await send(`/api/users/${user.id}/permissions`, 'DELETE');
      await loadMatrix(user.id);
    }, 'Droits remis à ceux du rôle');

  const savePassword = () =>
    run(async () => {
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`);
      }
      await send(`/api/users/${user.id}/password`, 'PUT', { password });
      setPassword('');
    }, 'Mot de passe changé : donnez-le à la personne');

  const toggleStatus = () =>
    run(async () => {
      await send(`/api/users/${user.id}?reactivate=${!user.isActive}`, 'DELETE');
      setConfirmStatus(false);
    }, user.isActive ? 'Compte désactivé' : 'Compte réactivé');

  const dirtyRights = matrix && !isAdmin && JSON.stringify(choices) !== JSON.stringify(choicesFromActions(matrix.effective));
  const customizedNow = matrix && !isAdmin && JSON.stringify(choicesFromActions(matrix.effective)) !== JSON.stringify(roleChoices);

  return (
    <>
        <div className="space-y-4">
          {/* En-tête de la fiche */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-base-200 bg-base-100 p-4 shadow-sm sm:p-6">
            <span
              aria-hidden
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/15 text-lg font-bold text-primary"
            >
              {initials(user.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm text-base-content/60">{user.username}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge tone={isAdmin ? 'primary' : 'neutral'}>{ROLE_LABELS[user.role]}</Badge>
                <Badge tone={user.isActive ? 'success' : 'neutral'}>{user.isActive ? 'Actif' : 'Désactivé'}</Badge>
                {isMe && <Badge tone="info">C’est vous</Badge>}
              </div>
            </div>
            <p className="w-full text-xs text-base-content/60 sm:w-auto sm:text-right">Dernière connexion : {formatDateTime(user.lastLoginAt)}</p>
          </div>

          {readOnly && (
            <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">
              Consultation seulement : {isAdmin && !allStores
                ? 'seul un administrateur général modifie un compte administrateur.'
                : 'les comptes se modifient sur le poste du siège.'}
            </p>
          )}
          {loadError && <p className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{loadError}</p>}

          <div role="tablist" className="tabs tabs-border overflow-x-auto">
            {USER_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`tab min-h-11 whitespace-nowrap ${tab === t.key ? 'tab-active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* ------------------------------ Profil ------------------------------ */}
          {tab === 'profil' && (
            <div className="space-y-3 rounded-2xl border border-base-200 bg-base-100 p-4 shadow-sm sm:p-6">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Nom complet" htmlFor="sheet-name" required>
                  <input id="sheet-name" className="input input-bordered min-h-11 w-full" value={name} disabled={readOnly || busy} onChange={(e) => setName(e.target.value)} />
                </FormField>
                <FormField label="Identifiant de connexion" htmlFor="sheet-username" required>
                  <input
                    id="sheet-username"
                    className="input input-bordered min-h-11 w-full font-mono"
                    value={username}
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={readOnly || busy}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </FormField>
                <FormField label="Téléphone" htmlFor="sheet-phone" hint="Facultatif">
                  <input id="sheet-phone" className="input input-bordered min-h-11 w-full" value={phone} inputMode="tel" disabled={readOnly || busy} onChange={(e) => setPhone(e.target.value)} />
                </FormField>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium">Rôle</p>
                <RoleChooser value={role} onChange={setRole} roles={roles.includes(role) ? roles : [role, ...roles]} disabled={readOnly || busy} />
                {role !== user.role && (
                  <p className="mt-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                    Le compte sera déconnecté et repartira avec les droits du nouveau rôle (les ajustements
                    faits dans « Droits » sont conservés).
                    {user.role === 'admin' && ' Il doit rester au moins un autre administrateur actif.'}
                  </p>
                )}
              </div>
              {!readOnly && (
                <div className="flex justify-end">
                  <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" disabled={busy} onClick={() => void saveProfile()}>
                    Enregistrer le profil
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ----------------------------- Magasins ----------------------------- */}
          {tab === 'magasins' && (
            <div className="space-y-3 rounded-2xl border border-base-200 bg-base-100 p-4 shadow-sm sm:p-6">
              {isAdmin ? (
                <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">
                  Un administrateur général voit et gère <strong>tous les magasins</strong> et change de
                  magasin librement. Ses affectations ne servent qu’à le désigner gérant d’un magasin.
                </p>
              ) : (
                <p className="text-sm text-base-content/70">
                  Le compte ne voit que les magasins cochés. Enregistrer le déconnecte : il se reconnecte
                  avec ses nouveaux magasins.
                </p>
              )}
              {assignments === null || stores === null ? (
                <span className="loading loading-spinner loading-sm" />
              ) : (
                <StoreAssignmentEditor stores={stores} value={assignments} onChange={setAssignments} disabled={readOnly || busy} />
              )}
              {!isAdmin && (
                <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-base-200 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm checkbox-primary mt-0.5"
                    checked={canSwitch}
                    disabled={readOnly || busy}
                    onChange={(e) => setCanSwitch(e.target.checked)}
                  />
                  <span className="text-sm">
                    <span className="font-medium">Peut changer de magasin</span>
                    <span className="block text-xs text-base-content/60">
                      Sinon, il travaille toujours dans son magasin principal (celui dont il est gérant,
                      sinon sa première affectation) et consulte seulement les autres.
                    </span>
                  </span>
                </label>
              )}
              {!readOnly && (
                <div className="flex justify-end">
                  <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" disabled={busy || assignments === null} onClick={() => void saveStores()}>
                    Enregistrer les magasins
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ------------------------------ Droits ------------------------------ */}
          {tab === 'droits' && (
            <div className="space-y-3 rounded-2xl border border-base-200 bg-base-100 p-4 shadow-sm sm:p-6">
              {isAdmin ? (
                <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">
                  Un administrateur a <strong>tous les droits</strong>, et on ne peut pas les lui retirer :
                  l’application garde toujours quelqu’un capable de tout gérer.
                </p>
              ) : matrix === null ? (
                <span className="loading loading-spinner loading-sm" />
              ) : (
                <>
                  <p className="text-sm text-base-content/70">
                    Droits de départ : ceux du rôle <strong>{ROLE_LABELS[user.role]}</strong>. Changez un
                    domaine seulement si cette personne a besoin d’un accès différent de ses collègues ; les
                    domaines modifiés sont encadrés.
                  </p>
                  <AccessEditor choices={choices} roleChoices={roleChoices} onChange={setChoices} disabled={readOnly || busy} />
                  {!readOnly && (
                    <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-base-200 bg-base-100 pt-3">
                      {customizedNow && (
                        <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" disabled={busy} onClick={() => void resetRights()}>
                          Tout remettre comme le rôle
                        </button>
                      )}
                      <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" disabled={busy || !dirtyRights} onClick={() => void saveRights()}>
                        Enregistrer les droits
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ----------------------------- Sécurité ----------------------------- */}
          {tab === 'securite' && (
            <div className="space-y-4 rounded-2xl border border-base-200 bg-base-100 p-4 shadow-sm sm:p-6">
              <section className="rounded-xl border border-base-200 p-3">
                <h3 className="text-sm font-semibold">Nouveau mot de passe</h3>
                <p className="mt-1 text-xs text-base-content/60">
                  Personne ne peut lire un mot de passe, pas même l’administrateur : en cas d’oubli, on en
                  donne un nouveau. Le compte est déconnecté de ses autres appareils.
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <PasswordInput
                      id="sheet-password"
                      value={password}
                      onChange={setPassword}
                      autoComplete="new-password"
                      ariaLabel="Nouveau mot de passe"
                      placeholder={`Au moins ${MIN_PASSWORD_LENGTH} caractères`}
                      disabled={readOnly || busy}
                      className="min-h-11"
                    />
                  </div>
                  {!readOnly && (
                    <button type="button" className="btn btn-outline min-h-11 sm:min-h-0" disabled={busy || !password} onClick={() => void savePassword()}>
                      Changer
                    </button>
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-base-200 p-3">
                <h3 className="text-sm font-semibold">{user.isActive ? 'Désactiver le compte' : 'Réactiver le compte'}</h3>
                {isAdmin ? (
                  <p className="mt-1 text-sm text-base-content/70">
                    🔒 Un administrateur <strong>ne peut pas être désactivé</strong>. Pour lui retirer l’accès,
                    changez d’abord son rôle dans « Profil » (il doit rester un autre administrateur).
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-xs text-base-content/60">
                      {user.isActive
                        ? 'La personne ne pourra plus se connecter (départ, fin de contrat). Rien n’est supprimé : ses ventes et opérations restent, et le compte se réactive à tout moment.'
                        : 'La personne pourra de nouveau se connecter, avec les mêmes droits et magasins.'}
                    </p>
                    {!readOnly &&
                      (confirmStatus ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">Confirmer ?</span>
                          <button
                            type="button"
                            className={`btn min-h-11 sm:min-h-0 ${user.isActive ? 'btn-error' : 'btn-success'}`}
                            disabled={busy}
                            onClick={() => void toggleStatus()}
                          >
                            {user.isActive ? 'Oui, désactiver' : 'Oui, réactiver'}
                          </button>
                          <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" disabled={busy} onClick={() => setConfirmStatus(false)}>
                            Non
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={`btn btn-outline mt-2 min-h-11 sm:min-h-0 ${user.isActive ? 'btn-error' : 'btn-success'}`}
                          disabled={busy || isMe}
                          title={isMe ? 'Vous ne pouvez pas désactiver votre propre compte.' : undefined}
                          onClick={() => setConfirmStatus(true)}
                        >
                          {user.isActive ? 'Désactiver…' : 'Réactiver'}
                        </button>
                      ))}
                  </>
                )}
              </section>

              <Link href={`/utilisateurs/historique?userId=${user.id}`} className="link link-primary text-sm">
                Voir l’historique des actions de ce compte →
              </Link>
            </div>
          )}
        </div>
    </>
  );
}
