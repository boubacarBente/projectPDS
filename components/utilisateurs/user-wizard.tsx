'use client';

/**
 * Création d'un compte en quatre étapes (refonte du 4 octobre 2026) :
 * **Qui** → **Rôle** → **Magasins** → **Vérifier**.
 *
 * L'ancien formulaire empilait tout sur un seul écran, avec un rôle choisi
 * dans une liste sans explication. Ici chaque étape pose une seule question,
 * le rôle se choisit sur des cartes qui disent ce que la personne pourra
 * faire, et le récapitulatif montre ses droits avant de créer le compte.
 *
 * Envoi : `POST /api/users` (`stores`, `canSwitchStore`) — le serveur revérifie
 * tout (rôle attribuable, magasins du périmètre, identifiant libre).
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/modal';
import { FormField } from '@/components/design-system';
import { PasswordInput } from '@/components/password-input';
import { useAuth } from '@/components/auth-provider';
import { ROLES, ROLE_LABELS, permissionsOf, type Role } from '@/lib/permissions';
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from '@/lib/constants';
import { AccessSummary, RoleChooser, choicesFromActions } from '@/components/utilisateurs/access-editor';
import {
  StoreAssignmentEditor,
  periodLabel,
  useAssignableStores,
  type AssignmentDraft,
} from '@/components/utilisateurs/store-assignments';

const STEPS = ['Qui', 'Rôle', 'Magasins', 'Vérifier'] as const;

/** « Mamadou Diallo » → « mamadou.diallo » (sans accents ni espaces). */
function suggestUsername(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

export function UserWizard({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Reçoit l'identifiant du compte créé (la liste ouvre alors sa fiche). */
  onCreated: (id: number) => void;
}) {
  const { user: me, activeStoreId } = useAuth();
  const { stores, error: storesError } = useAssignableStores(isOpen);
  // Le rôle Administrateur n'est attribuable que par le super administrateur (README §17.2).
  const roles = ROLES.filter((r) => r !== 'admin' || me?.isSuperAdmin);

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('seller');
  const [assignments, setAssignments] = useState<AssignmentDraft[]>([]);
  const [canSwitch, setCanSwitch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Une modale rouverte repart de zéro (jamais la saisie précédente).
  useEffect(() => {
    if (!isOpen) return;
    setStep(0);
    setName('');
    setUsername('');
    setUsernameTouched(false);
    setPhone('');
    setPassword('');
    setRole('seller');
    setAssignments(activeStoreId ? [{ storeId: activeStoreId, isManager: false, startsAt: null, endsAt: null }] : []);
    setCanSwitch(false);
    setError(null);
  }, [isOpen, activeStoreId]);

  const roleChoices = useMemo(() => {
    const actions = permissionsOf({ role });
    return choicesFromActions(role !== 'admin' && canSwitch ? [...actions, 'stores.switch'] : actions);
  }, [role, canSwitch]);

  /** Contrôle de l'étape courante ; renvoie le message d'erreur ou `null`. */
  const validate = (index: number): string | null => {
    if (index === 0) {
      if (!name.trim()) return 'Indiquez le nom de la personne.';
      if (!USERNAME_PATTERN.test(username.trim().toLowerCase())) {
        return 'L’identifiant doit faire au moins 3 caractères : lettres minuscules, chiffres, « . », « _ » ou « - ».';
      }
      if (password.length < MIN_PASSWORD_LENGTH) return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`;
    }
    if (index === 2 && role !== 'admin' && assignments.length === 0) {
      return 'Cochez au moins un magasin : le compte ne pourra travailler que là.';
    }
    return null;
  };

  const next = () => {
    const message = validate(step);
    setError(message);
    if (!message) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const submit = async () => {
    for (let i = 0; i < STEPS.length - 1; i += 1) {
      const message = validate(i);
      if (message) {
        setStep(i);
        setError(message);
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name: name.trim(),
          username: username.trim().toLowerCase(),
          phone: phone.trim() || null,
          password,
          role,
          stores: role === 'admin' ? [] : assignments,
          canSwitchStore: role !== 'admin' && canSwitch,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error ?? 'Création impossible');
      onCreated(Number(payload.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Création impossible');
    } finally {
      setSubmitting(false);
    }
  };

  const storeName = (id: number) => stores?.find((s) => s.id === id)?.name ?? `Magasin #${id}`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="Nouvel utilisateur"
      size="lg"
      fullScreenMobile
      closeOnOverlay={false}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-200 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11 sm:min-h-0"
            disabled={submitting}
            onClick={() => (step === 0 ? onClose() : (setError(null), setStep((s) => s - 1)))}
          >
            {step === 0 ? 'Annuler' : '← Retour'}
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" onClick={next}>
              Continuer →
            </button>
          ) : (
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" disabled={submitting} onClick={() => void submit()}>
              {submitting ? <span className="loading loading-spinner loading-sm" /> : 'Créer le compte'}
            </button>
          )}
        </div>
      }
    >
      {/* Étapes */}
      <ol className="mb-5 grid grid-cols-4 gap-2" aria-label="Étapes">
        {STEPS.map((label, index) => (
          <li key={label} aria-current={index === step ? 'step' : undefined}>
            <span className={`block h-1.5 rounded-full ${index <= step ? 'bg-primary' : 'bg-base-200'}`} />
            <span className={`mt-1 block text-xs ${index === step ? 'font-semibold' : 'text-base-content/60'}`}>
              {index + 1}. {label}
            </span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="space-y-3">
          <FormField label="Nom complet" htmlFor="wiz-name" required>
            <input
              id="wiz-name"
              className="input input-bordered min-h-11 w-full"
              value={name}
              autoComplete="off"
              placeholder="Ex. : Mamadou Diallo"
              onChange={(e) => {
                setName(e.target.value);
                if (!usernameTouched) setUsername(suggestUsername(e.target.value));
              }}
            />
          </FormField>
          <FormField
            label="Identifiant de connexion"
            htmlFor="wiz-username"
            required
            hint="Proposé à partir du nom. Lettres minuscules, chiffres, « . », « _ » ou « - »."
          >
            <input
              id="wiz-username"
              className="input input-bordered min-h-11 w-full font-mono"
              value={username}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => {
                setUsername(e.target.value);
                setUsernameTouched(true);
              }}
            />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Mot de passe"
              htmlFor="wiz-password"
              required
              hint={`Au moins ${MIN_PASSWORD_LENGTH} caractères. Donnez-le à la personne : il ne sera plus affiché.`}
            >
              <PasswordInput id="wiz-password" value={password} onChange={setPassword} autoComplete="new-password" className="min-h-11" />
            </FormField>
            <FormField label="Téléphone" htmlFor="wiz-phone" hint="Facultatif">
              <input
                id="wiz-phone"
                className="input input-bordered min-h-11 w-full"
                value={phone}
                inputMode="tel"
                placeholder="Ex. : 622 00 00 00"
                onChange={(e) => setPhone(e.target.value)}
              />
            </FormField>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <p className="text-sm text-base-content/70">
            Que fera cette personne ? Le rôle donne ses droits de départ ; vous pourrez les ajuster plus
            tard, domaine par domaine, depuis sa fiche.
          </p>
          <RoleChooser value={role} onChange={setRole} roles={roles} />
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          {role === 'admin' ? (
            <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">
              Un administrateur général voit et gère <strong>tous les magasins</strong> : rien à cocher.
            </p>
          ) : (
            <>
              <p className="text-sm text-base-content/70">
                Dans quels magasins travaille-t-elle ? Elle ne verra que les magasins cochés. « Gérant »
                lui permet d’approuver les dépenses et les transferts de ce magasin.
              </p>
              {storesError ? (
                <p className="text-sm text-error">{storesError}</p>
              ) : stores === null ? (
                <span className="loading loading-spinner loading-sm" />
              ) : (
                <StoreAssignmentEditor stores={stores} value={assignments} onChange={setAssignments} />
              )}
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-base-200 px-3 py-2.5">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm checkbox-primary mt-0.5"
                  checked={canSwitch}
                  onChange={(e) => setCanSwitch(e.target.checked)}
                />
                <span className="text-sm">
                  <span className="font-medium">Peut changer de magasin</span>
                  <span className="block text-xs text-base-content/60">
                    Pour passer d’un magasin coché à l’autre. Sinon, elle travaille toujours dans son
                    magasin principal (celui dont elle est gérante, sinon le premier coché) et consulte
                    seulement les autres.
                  </span>
                </span>
              </label>
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <dl className="grid gap-x-4 gap-y-2 rounded-xl border border-base-200 p-3 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-base-content/60">Nom</dt>
            <dd className="font-medium">{name}</dd>
            <dt className="text-base-content/60">Identifiant</dt>
            <dd className="font-mono">{username.trim().toLowerCase()}</dd>
            <dt className="text-base-content/60">Rôle</dt>
            <dd className="font-medium">{ROLE_LABELS[role]}</dd>
            <dt className="text-base-content/60">Magasins</dt>
            <dd>
              {role === 'admin' ? (
                'Tous'
              ) : (
                <ul className="space-y-0.5">
                  {assignments.map((a) => (
                    <li key={a.storeId}>
                      {storeName(a.storeId)}
                      {a.isManager ? ' · gérant' : ''}
                      {periodLabel(a) ? ` · ${periodLabel(a)}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            {role !== 'admin' && (
              <>
                <dt className="text-base-content/60">Changer de magasin</dt>
                <dd>{canSwitch ? 'Oui' : 'Non — reste dans son magasin principal'}</dd>
              </>
            )}
          </dl>
          <div>
            <p className="mb-2 text-sm font-semibold">Ce qu’elle pourra faire</p>
            <AccessSummary choices={roleChoices} compact />
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
