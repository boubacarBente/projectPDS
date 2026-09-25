'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/design-system';
import { PasswordInput } from '@/components/password-input';
import { ROLES, ROLE_LABELS, type Role } from '@/lib/permissions';
// ⚠️ `MIN_PASSWORD_LENGTH` vient de `lib/constants.ts`, et non de `lib/users.ts` :
// ce dernier est un module **serveur** (il importe `@/db`). L'importer ici
// ferait entrer `@libsql/client` et `fs` dans le bundle navigateur, ce que
// Turbopack refuse. `UserRow` reste un `import type`, donc effacé au build.
import { MIN_PASSWORD_LENGTH } from '@/lib/constants';
import type { UserRow } from '@/lib/users';

/**
 * Les quatre modales du module Utilisateurs (README §8) :
 *
 *  1. **Créer** — nom, identifiant, mot de passe, rôle, téléphone ;
 *  2. **Modifier** — mêmes champs **sans** le mot de passe (route dédiée) ;
 *  3. **Changer le mot de passe** — réinitialisation par un administrateur,
 *     avec double saisie et une icône « afficher » **par champ** ;
 *  4. **Désactiver / Réactiver** — `ConfirmDialog`, jamais `window.confirm`.
 *
 * Contrat respecté ici :
 *  - **un état booléen par modale**, porté par la page appelante ;
 *  - `onClose` ne ferme **jamais** pendant un envoi (`isSubmitting`) ;
 *  - spinner sur le bouton de confirmation ;
 *  - aucun mot de passe affiché, journalisé ou renvoyé — le champ est vidé à la
 *    fermeture et n'est jamais relu depuis l'API.
 */

export type UserFormValues = {
  name: string;
  username: string;
  password: string;
  role: Role;
  phone: string;
};

const EMPTY_FORM: UserFormValues = {
  name: '',
  username: '',
  password: '',
  role: 'seller',
  phone: '',
};

type Props = {
  /** 1. Création */
  isCreateOpen: boolean;
  onCreateClose: () => void;
  onCreateSubmit: (values: UserFormValues) => Promise<void>;
  isCreating: boolean;
  /** 2. Modification — `null` hors modale */
  editingUser: UserRow | null;
  onEditClose: () => void;
  onEditSubmit: (id: number, values: Omit<UserFormValues, 'password'>) => Promise<void>;
  isEditing: boolean;
  /** 3. Changement de mot de passe — `null` hors modale */
  passwordUser: UserRow | null;
  onPasswordClose: () => void;
  onPasswordSubmit: (id: number, password: string) => Promise<void>;
  isChangingPassword: boolean;
  /** 4. Désactivation / réactivation — `null` hors modale */
  statusUser: UserRow | null;
  onStatusClose: () => void;
  onStatusConfirm: () => Promise<void>;
  isUpdatingStatus: boolean;
};

export function UserModals({
  isCreateOpen,
  onCreateClose,
  onCreateSubmit,
  isCreating,
  editingUser,
  onEditClose,
  onEditSubmit,
  isEditing,
  passwordUser,
  onPasswordClose,
  onPasswordSubmit,
  isChangingPassword,
  statusUser,
  onStatusClose,
  onStatusConfirm,
  isUpdatingStatus,
}: Props) {
  return (
    <>
      <UserFormModal
        mode="create"
        isOpen={isCreateOpen}
        onClose={onCreateClose}
        onSubmit={(values) => onCreateSubmit({ ...EMPTY_FORM, ...values, password: values.password })}
        isSubmitting={isCreating}
      />

      <UserFormModal
        mode="edit"
        isOpen={editingUser !== null}
        onClose={onEditClose}
        user={editingUser}
        onSubmit={(values) =>
          editingUser
            ? onEditSubmit(editingUser.id, {
                name: values.name,
                username: values.username,
                role: values.role,
                phone: values.phone,
              })
            : Promise.resolve()
        }
        isSubmitting={isEditing}
      />

      <PasswordModal
        isOpen={passwordUser !== null}
        onClose={onPasswordClose}
        user={passwordUser}
        onSubmit={(password) =>
          passwordUser ? onPasswordSubmit(passwordUser.id, password) : Promise.resolve()
        }
        isSubmitting={isChangingPassword}
      />

      <StatusDialog
        isOpen={statusUser !== null}
        onClose={onStatusClose}
        user={statusUser}
        onConfirm={onStatusConfirm}
        isSubmitting={isUpdatingStatus}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 1 & 2. Création / modification
 * ------------------------------------------------------------------ */

function UserFormModal({
  mode,
  isOpen,
  onClose,
  user,
  onSubmit,
  isSubmitting,
}: {
  mode: 'create' | 'edit';
  isOpen: boolean;
  onClose: () => void;
  user?: UserRow | null;
  onSubmit: (values: UserFormValues) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [form, setForm] = useState<UserFormValues>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  // Le formulaire se réamorce à chaque ouverture (et à chaque cible) : rouvrir
  // la modale ne doit jamais réafficher la saisie précédente.
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setForm(
      mode === 'edit' && user
        ? {
            name: user.name,
            username: user.username,
            role: user.role,
            phone: user.phone ?? '',
            password: '',
          }
        : EMPTY_FORM,
    );
  }, [isOpen, mode, user]);

  const set = <K extends keyof UserFormValues>(key: K, value: UserFormValues[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const handleSubmit = async () => {
    if (!form.name.trim()) return setError('Le nom est obligatoire');
    if (!form.username.trim()) return setError("L'identifiant de connexion est obligatoire");
    if (mode === 'create' && form.password.length < MIN_PASSWORD_LENGTH) {
      return setError(`Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères`);
    }
    setError(null);
    await onSubmit({ ...form, name: form.name.trim(), username: form.username.trim().toLowerCase() });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={mode === 'create' ? 'Nouvel utilisateur' : `Modifier « ${user?.name ?? ''} »`}
      size="md"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <FormField label="Nom complet" htmlFor="user-name" required>
          <input
            id="user-name"
            className="input input-bordered w-full min-h-11"
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
            placeholder="Ex. : Mamadou Diallo"
            autoComplete="off"
            disabled={isSubmitting}
          />
        </FormField>

        <FormField
          label="Identifiant de connexion"
          htmlFor="user-username"
          required
          hint="Au moins 3 caractères : lettres minuscules, chiffres, « . », « _ » ou « - »"
        >
          <input
            id="user-username"
            className="input input-bordered w-full min-h-11"
            value={form.username}
            onChange={(event) => set('username', event.target.value)}
            placeholder="Ex. : mamadou.diallo"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={isSubmitting}
          />
        </FormField>

        {mode === 'create' && (
          <FormField
            label="Mot de passe"
            htmlFor="user-password"
            required
            hint={`Au moins ${MIN_PASSWORD_LENGTH} caractères. Il ne sera plus jamais affiché.`}
          >
            <PasswordInput
              id="user-password"
              value={form.password}
              onChange={(value) => set('password', value)}
              className="min-h-11"
              autoComplete="new-password"
              disabled={isSubmitting}
            />
          </FormField>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Rôle" htmlFor="user-role" required>
            <select
              id="user-role"
              className="select select-bordered w-full min-h-11"
              value={form.role}
              onChange={(event) => set('role', event.target.value as Role)}
              disabled={isSubmitting}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Téléphone" htmlFor="user-phone" hint="Facultatif">
            <input
              id="user-phone"
              className="input input-bordered w-full min-h-11"
              value={form.phone}
              onChange={(event) => set('phone', event.target.value)}
              placeholder="Ex. : 622 00 00 00"
              inputMode="tel"
              disabled={isSubmitting}
            />
          </FormField>
        </div>

        {mode === 'edit' && (
          <p className="rounded-xl border border-base-200 bg-base-200/60 px-3 py-2 text-xs text-base-content/60">
            Le mot de passe ne se modifie pas ici : utilisez « Changer le mot de passe », qui passe par
            une route dédiée et n’est jamais journalisé.
          </p>
        )}

        {error && (
          <p className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        <ModalFooter
          onCancel={() => {
            if (!isSubmitting) onClose();
          }}
          submitLabel={mode === 'create' ? 'Créer l’utilisateur' : 'Enregistrer'}
          isSubmitting={isSubmitting}
        />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Changement de mot de passe
 * ------------------------------------------------------------------ */

function PasswordModal({
  isOpen,
  onClose,
  user,
  onSubmit,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  user: UserRow | null;
  onSubmit: (password: string) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPassword('');
    setConfirmation('');
    setError(null);
  }, [isOpen, user]);

  const handleSubmit = async () => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return setError(`Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères`);
    }
    if (password !== confirmation) return setError('Les deux saisies ne correspondent pas');
    setError(null);
    await onSubmit(password);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={`Changer le mot de passe de « ${user?.name ?? ''} »`}
      size="md"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <p className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-base-content/75">
          Communiquez le nouveau mot de passe à l’utilisateur par un moyen sûr : il n’est conservé nulle
          part en clair et ne pourra plus être affiché.
        </p>

        <FormField label="Nouveau mot de passe" htmlFor="new-password" required hint={`Au moins ${MIN_PASSWORD_LENGTH} caractères`}>
          <PasswordInput
            id="new-password"
            value={password}
            onChange={setPassword}
            className="min-h-11"
            autoComplete="new-password"
            disabled={isSubmitting}
          />
        </FormField>

        <FormField label="Confirmation" htmlFor="confirm-password" required>
          <PasswordInput
            id="confirm-password"
            value={confirmation}
            onChange={setConfirmation}
            className="min-h-11"
            autoComplete="new-password"
            disabled={isSubmitting}
          />
        </FormField>

        {/*
          L'ancien interrupteur « Afficher les mots de passe saisis » est retiré :
          chaque champ porte désormais sa propre icône, on peut donc vérifier la
          seule confirmation sans dévoiler le premier champ (voir
          `components/password-input.tsx`).
        */}

        {error && (
          <p className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        <ModalFooter
          onCancel={() => {
            if (!isSubmitting) onClose();
          }}
          submitLabel="Réinitialiser le mot de passe"
          isSubmitting={isSubmitting}
        />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 4. Désactivation / réactivation
 * ------------------------------------------------------------------ */

function StatusDialog({
  isOpen,
  onClose,
  user,
  onConfirm,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  user: UserRow | null;
  onConfirm: () => Promise<void>;
  isSubmitting: boolean;
}) {
  if (!user) return null;

  const deactivating = user.isActive;

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      isSubmitting={isSubmitting}
      tone={deactivating ? 'error' : 'success'}
      title={deactivating ? `Désactiver « ${user.name} » ?` : `Réactiver « ${user.name} » ?`}
      confirmLabel={deactivating ? 'Désactiver' : 'Réactiver'}
      message={
        deactivating ? (
          <>
            Le compte <strong>{user.username}</strong> ne pourra plus se connecter. Rien n’est supprimé :
            la fiche, les documents et l’historique de cet utilisateur sont conservés, et le compte peut
            être réactivé à tout moment. Le dernier administrateur actif ne peut pas être désactivé.
          </>
        ) : (
          <>
            Le compte <strong>{user.username}</strong> pourra de nouveau se connecter avec son mot de
            passe actuel.
          </>
        )
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * Pied de modale collant (§5.5 règle 4)
 * ------------------------------------------------------------------ */

function ModalFooter({
  onCancel,
  submitLabel,
  isSubmitting,
}: {
  onCancel: () => void;
  submitLabel: string;
  isSubmitting: boolean;
}) {
  return (
    <div className="sticky bottom-0 -mx-1 flex flex-col-reverse gap-2 border-t border-base-200 bg-base-100 px-1 pt-4 sm:flex-row sm:justify-end">
      <button type="button" onClick={onCancel} disabled={isSubmitting} className="btn btn-ghost min-h-11">
        Annuler
      </button>
      <button type="submit" disabled={isSubmitting} className="btn btn-primary min-h-11">
        {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : submitLabel}
      </button>
    </div>
  );
}
