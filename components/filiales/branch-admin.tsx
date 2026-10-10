'use client';

import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/design-system';
import { readApiError } from '@/components/workers/workers-modals';
import {
  BRANCH_ACCESS_LABELS,
  BRANCH_ACTIVITIES,
  BRANCH_ACTIVITY_LABELS,
  BRANCH_COLORS,
  BRANCH_COLOR_LABELS,
  BRANCH_UNITS,
  DEFAULT_LOSS_LABELS,
  DEFAULT_STAGES,
  branchColorClasses,
  type BranchAccessLevel,
  type BranchActivity,
  type BranchStatus,
  type ProductionBranch,
} from '@/lib/branches-shared';

/**
 * Administration des filiales de production (README §31.1) — siège,
 * permission `brick.branches`. Le serveur revalide tout (`lib/branches.ts`).
 */

const PREFIX_SUGGESTIONS: Record<BranchActivity, [string, string]> = {
  bricks: ['BRI', 'BCM'],
  glass: ['VIT', 'VCM'],
  furniture: ['MEU', 'MCM'],
  other: ['PRD', 'CMD'],
};

type StoreOption = { id: number; name: string; code: string };

export function BranchFormModal({
  isOpen,
  onClose,
  onSaved,
  branch,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (branch: ProductionBranch) => void;
  /** `null` = création. */
  branch: ProductionBranch | null;
}) {
  const [name, setName] = useState('');
  const [activity, setActivity] = useState<BranchActivity>('other');
  const [description, setDescription] = useState('');
  const [storeId, setStoreId] = useState('');
  const [color, setColor] = useState('primary');
  const [sortOrder, setSortOrder] = useState('');
  const [unit, setUnit] = useState('pièce');
  const [stages, setStages] = useState<string[]>([]);
  const [lossLabel, setLossLabel] = useState('');
  const [batchPrefix, setBatchPrefix] = useState('');
  const [orderPrefix, setOrderPrefix] = useState('');
  const [accessMode, setAccessMode] = useState<'all' | 'restricted'>('all');
  const [customerMode, setCustomerMode] = useState<'all' | 'selected'>('all');
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const a = branch?.activity ?? 'other';
    setName(branch?.name ?? '');
    setActivity(a);
    setDescription(branch?.description ?? '');
    setStoreId(branch?.storeId ? String(branch.storeId) : '');
    setColor(branch?.color ?? 'primary');
    setSortOrder(branch ? String(branch.sortOrder) : '');
    setUnit(branch?.unit ?? 'pièce');
    setStages(branch ? branch.stages.map((s) => s.label) : [...DEFAULT_STAGES[a]]);
    setLossLabel(branch?.lossLabel ?? DEFAULT_LOSS_LABELS[a]);
    setBatchPrefix(branch?.batchPrefix ?? PREFIX_SUGGESTIONS[a][0]);
    setOrderPrefix(branch?.orderPrefix ?? PREFIX_SUGGESTIONS[a][1]);
    setAccessMode(branch?.accessMode ?? 'all');
    setCustomerMode(branch?.customerMode ?? 'all');
    setFormError(null);
    setIsSubmitting(false);
    const controller = new AbortController();
    fetch('/api/magasins', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { data: StoreOption[] }).data ?? [] : []))
      .then(setStores)
      .catch(() => setStores([]));
    return () => controller.abort();
  }, [isOpen, branch]);

  /** À la création, changer d'activité propose les étapes et préfixes habituels. */
  function chooseActivity(next: BranchActivity) {
    setActivity(next);
    if (branch) return;
    setStages([...DEFAULT_STAGES[next]]);
    setLossLabel(DEFAULT_LOSS_LABELS[next]);
    setBatchPrefix(PREFIX_SUGGESTIONS[next][0]);
    setOrderPrefix(PREFIX_SUGGESTIONS[next][1]);
    if (next === 'glass') setUnit('m²');
  }

  async function submit() {
    if (isSubmitting) return;
    if (!name.trim()) {
      setFormError('Donnez un nom à la filiale : c’est lui qui apparaîtra dans le menu (ex. Briqueterie, Vitrerie, Meuble).');
      return;
    }
    const cleanStages = stages.map((s) => s.trim()).filter(Boolean);
    if (cleanStages.length === 0) {
      setFormError('Indiquez au moins une étape de fabrication avant la mise en stock.');
      return;
    }
    setFormError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(branch ? `/api/filiales/${branch.id}` : '/api/filiales', {
        method: branch ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          activity,
          description: description.trim() || null,
          storeId: storeId ? Number(storeId) : null,
          color,
          sortOrder: sortOrder === '' ? undefined : Number(sortOrder),
          unit: unit.trim() || 'pièce',
          stages: cleanStages,
          lossLabel: lossLabel.trim(),
          batchPrefix: batchPrefix.trim().toUpperCase(),
          orderPrefix: orderPrefix.trim().toUpperCase(),
          accessMode,
          customerMode,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'La filiale n’a pas pu être enregistrée.'));
      const saved = (await response.json()) as ProductionBranch;
      toast.success(branch ? `Filiale « ${saved.name} » modifiée.` : `Filiale « ${saved.name} » créée : elle apparaît dans le menu.`);
      onSaved(saved);
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'La filiale n’a pas pu être enregistrée.';
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={branch ? `Modifier « ${branch.name} »` : 'Nouvelle filiale de production'}
      size="xl"
      fullScreenMobile
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Nom de la filiale" htmlFor="branch-name" required hint="Affiché tel quel dans le menu latéral.">
            <input
              id="branch-name"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex. Vitrerie"
              disabled={isSubmitting}
            />
          </FormField>
          <FormField label="Activité" htmlFor="branch-activity" hint="Indicative : elle propose des étapes et des préfixes.">
            <select
              id="branch-activity"
              className="select select-bordered min-h-11 w-full"
              value={activity}
              onChange={(event) => chooseActivity(event.target.value as BranchActivity)}
              disabled={isSubmitting}
            >
              {BRANCH_ACTIVITIES.map((value) => (
                <option key={value} value={value}>
                  {BRANCH_ACTIVITY_LABELS[value]}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <FormField label="Description" htmlFor="branch-description">
          <textarea
            id="branch-description"
            className="textarea textarea-bordered min-h-16 w-full"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={isSubmitting}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Magasin" htmlFor="branch-store" hint="Vide = la filiale travaille dans tous les magasins.">
            <select
              id="branch-store"
              className="select select-bordered min-h-11 w-full"
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
              disabled={isSubmitting}
            >
              <option value="">Tous les magasins</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Couleur" htmlFor="branch-color">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className={`h-4 w-4 shrink-0 rounded-full ${branchColorClasses(color).dot}`} />
              <select
                id="branch-color"
                className="select select-bordered min-h-11 w-full"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                disabled={isSubmitting}
              >
                {BRANCH_COLORS.map((value) => (
                  <option key={value} value={value}>
                    {BRANCH_COLOR_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </FormField>
          <FormField label="Ordre dans le menu" htmlFor="branch-order" hint="Vide = après les autres.">
            <input
              id="branch-order"
              type="number"
              min={0}
              max={999}
              inputMode="numeric"
              className="input input-bordered min-h-11 w-full"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
              disabled={isSubmitting}
            />
          </FormField>
        </div>

        <fieldset className="space-y-3 rounded-xl border border-base-200 p-4">
          <legend className="px-1 text-sm font-semibold">Fabrication</legend>
          <p className="text-xs text-base-content/70">
            Étapes dans l’ordre du métier. « En stock » est toujours la dernière : c’est elle qui fait entrer la
            production dans le stock, une seule fois.
          </p>
          <ol className="space-y-2">
            {stages.map((stage, index) => (
              <li key={index} className="flex items-center gap-2">
                <span className="w-6 text-right text-sm tabular text-base-content/60">{index + 1}.</span>
                <label className="sr-only" htmlFor={`branch-stage-${index}`}>
                  Étape {index + 1}
                </label>
                <input
                  id={`branch-stage-${index}`}
                  type="text"
                  className="input input-bordered min-h-11 w-full"
                  value={stage}
                  maxLength={40}
                  onChange={(event) => setStages((list) => list.map((s, i) => (i === index ? event.target.value : s)))}
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-square min-h-11 min-w-11"
                  aria-label={`Retirer l’étape ${index + 1}`}
                  disabled={isSubmitting || stages.length <= 1}
                  onClick={() => setStages((list) => list.filter((_, i) => i !== index))}
                >
                  ✕
                </button>
              </li>
            ))}
            <li className="flex items-center gap-2 text-sm text-base-content/70">
              <span className="w-6 text-right tabular">{stages.length + 1}.</span>
              <span className="rounded-lg bg-success/10 px-3 py-2 text-success">En stock (toujours la dernière étape)</span>
            </li>
          </ol>
          <button
            type="button"
            className="btn btn-ghost btn-sm min-h-11 border border-base-300"
            disabled={isSubmitting || stages.length >= 8}
            onClick={() => setStages((list) => [...list, ''])}
          >
            Ajouter une étape
          </button>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Unité principale" htmlFor="branch-unit" hint="Proposée aux nouveaux modèles.">
              <input
                id="branch-unit"
                type="text"
                list="branch-unit-list"
                className="input input-bordered min-h-11 w-full"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                disabled={isSubmitting}
              />
              <datalist id="branch-unit-list">
                {BRANCH_UNITS.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </FormField>
            <FormField label="Nom des pertes" htmlFor="branch-loss" hint="Ex. Cassées, Casse, Rebuts, Chutes.">
              <input
                id="branch-loss"
                type="text"
                className="input input-bordered min-h-11 w-full"
                value={lossLabel}
                maxLength={30}
                onChange={(event) => setLossLabel(event.target.value)}
                disabled={isSubmitting}
              />
            </FormField>
          </div>
        </fieldset>

        <fieldset className="grid gap-4 rounded-xl border border-base-200 p-4 sm:grid-cols-2">
          <legend className="px-1 text-sm font-semibold">Numérotation des documents</legend>
          <FormField label="Préfixe des productions" htmlFor="branch-batch-prefix" hint="Ex. VIT → VIT-KAL-2026-000001">
            <input
              id="branch-batch-prefix"
              type="text"
              className="input input-bordered min-h-11 w-full uppercase"
              value={batchPrefix}
              maxLength={6}
              onChange={(event) => setBatchPrefix(event.target.value.toUpperCase())}
              disabled={isSubmitting}
            />
          </FormField>
          <FormField label="Préfixe des commandes" htmlFor="branch-order-prefix">
            <input
              id="branch-order-prefix"
              type="text"
              className="input input-bordered min-h-11 w-full uppercase"
              value={orderPrefix}
              maxLength={6}
              onChange={(event) => setOrderPrefix(event.target.value.toUpperCase())}
              disabled={isSubmitting}
            />
          </FormField>
        </fieldset>

        <fieldset className="grid gap-4 rounded-xl border border-base-200 p-4 sm:grid-cols-2">
          <legend className="px-1 text-sm font-semibold">Accès</legend>
          <FormField label="Utilisateurs" htmlFor="branch-access">
            <select
              id="branch-access"
              className="select select-bordered min-h-11 w-full"
              value={accessMode}
              onChange={(event) => setAccessMode(event.target.value as 'all' | 'restricted')}
              disabled={isSubmitting}
            >
              <option value="all">Tous ceux qui ont les droits « Filiales de production »</option>
              <option value="restricted">Seulement les comptes choisis</option>
            </select>
          </FormField>
          <FormField label="Clients" htmlFor="branch-customers">
            <select
              id="branch-customers"
              className="select select-bordered min-h-11 w-full"
              value={customerMode}
              onChange={(event) => setCustomerMode(event.target.value as 'all' | 'selected')}
              disabled={isSubmitting}
            >
              <option value="all">Tous les clients du magasin</option>
              <option value="selected">Seulement les clients partagés avec la filiale</option>
            </select>
          </FormField>
        </fieldset>

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
            {isSubmitting ? 'Enregistrement…' : branch ? 'Enregistrer' : 'Créer la filiale'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type UserOption = { id: number; name: string; username: string };

/** Comptes autorisés d'une filiale « comptes choisis », avec leur niveau (plafond). */
export function BranchUsersModal({
  isOpen,
  onClose,
  onSaved,
  branch,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  branch: ProductionBranch | null;
}) {
  const [users, setUsers] = useState<UserOption[]>([]);
  const [levels, setLevels] = useState<Record<number, BranchAccessLevel | ''>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen || !branch) return;
    const controller = new AbortController();
    setIsLoading(true);
    Promise.all([
      fetch('/api/users?options=true', { cache: 'no-store', signal: controller.signal }).then(async (r) =>
        r.ok ? ((await r.json()) as UserOption[]) : [],
      ),
      fetch(`/api/filiales/${branch.id}/utilisateurs`, { cache: 'no-store', signal: controller.signal }).then(async (r) =>
        r.ok ? ((await r.json()) as { data: { userId: number; level: BranchAccessLevel }[] }).data : [],
      ),
    ])
      .then(([options, current]) => {
        setUsers(Array.isArray(options) ? options : []);
        setLevels(Object.fromEntries(current.map((row) => [row.userId, row.level])));
      })
      .catch(() => undefined)
      .finally(() => setIsLoading(false));
    return () => controller.abort();
  }, [isOpen, branch]);

  async function save() {
    if (!branch) return;
    setIsSubmitting(true);
    try {
      const entries = Object.entries(levels)
        .filter(([, level]) => level)
        .map(([userId, level]) => ({ userId: Number(userId), level }));
      const response = await fetch(`/api/filiales/${branch.id}/utilisateurs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: entries }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Les accès n’ont pas pu être enregistrés.'));
      toast.success(`Accès à « ${branch.name} » enregistrés.`);
      onSaved();
      onClose();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Les accès n’ont pas pu être enregistrés.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => !isSubmitting && onClose()} title={`Comptes autorisés — ${branch?.name ?? ''}`} size="lg" fullScreenMobile>
      <div className="space-y-4">
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          {branch?.accessMode === 'restricted'
            ? 'Seuls les comptes cochés voient cette filiale. Le niveau choisi plafonne leurs droits : un compte « Consulter » ne saisit rien ici, même s’il en a le droit ailleurs.'
            : 'Cette filiale est ouverte à tous les comptes qui ont les droits « Filiales de production ». La liste ci-dessous ne s’appliquera que si vous passez la filiale en « comptes choisis ».'}{' '}
          L’administrateur voit toujours toutes les filiales.
        </p>
        {isLoading ? (
          <div className="h-40 animate-pulse rounded-xl bg-base-300/50" />
        ) : (
          <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
            {users.map((user) => (
              <li key={user.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium">{user.name}</div>
                  <div className="text-xs text-base-content/60">{user.username}</div>
                </div>
                <label className="sr-only" htmlFor={`branch-user-${user.id}`}>
                  Accès de {user.name}
                </label>
                <select
                  id={`branch-user-${user.id}`}
                  className="select select-bordered min-h-11 w-full sm:w-48"
                  value={levels[user.id] ?? ''}
                  onChange={(event) => setLevels((current) => ({ ...current, [user.id]: event.target.value as BranchAccessLevel | '' }))}
                  disabled={isSubmitting}
                >
                  <option value="">Aucun accès</option>
                  {(['view', 'edit', 'manage'] as BranchAccessLevel[]).map((level) => (
                    <option key={level} value={level}>
                      {BRANCH_ACCESS_LABELS[level]}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button type="button" className="btn btn-primary min-h-11" onClick={() => void save()} disabled={isSubmitting || isLoading}>
            {isSubmitting ? 'Enregistrement…' : 'Enregistrer les accès'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Activer, suspendre ou archiver — motif obligatoire hors réactivation. */
export function BranchStatusDialog({
  branch,
  target,
  onClose,
  onDone,
}: {
  branch: ProductionBranch | null;
  target: BranchStatus | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => setReason(''), [branch, target]);
  if (!branch || !target) return null;
  const labels: Record<BranchStatus, { title: string; confirm: string; message: string; tone: 'error' | 'warning' | 'success' }> = {
    active: {
      title: `Réactiver « ${branch.name} »`,
      confirm: 'Réactiver',
      message: 'La filiale revient dans le menu et accepte de nouveau productions, commandes et ventes.',
      tone: 'success',
    },
    suspended: {
      title: `Suspendre « ${branch.name} »`,
      confirm: 'Suspendre',
      message: 'La filiale quitte le menu et n’accepte plus aucune opération ; son historique reste consultable. Vous pourrez la réactiver.',
      tone: 'warning',
    },
    archived: {
      title: `Archiver « ${branch.name} »`,
      confirm: 'Archiver',
      message: 'Réservé à une filiale fermée : plus aucune production ni commande en cours. Rien n’est supprimé, les documents restent consultables.',
      tone: 'error',
    },
  };
  const text = labels[target];

  async function confirm() {
    if (!branch || !target) return;
    if (target !== 'active' && !reason.trim()) {
      toast.error('Indiquez le motif.');
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/filiales/${branch.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_status', status: target, reason: reason.trim() || null }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Le statut n’a pas pu être modifié.'));
      toast.success(`${text.confirm} : « ${branch.name} ».`);
      onDone();
      onClose();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Le statut n’a pas pu être modifié.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ConfirmDialog
      isOpen
      onClose={() => !isSubmitting && onClose()}
      onConfirm={confirm}
      isSubmitting={isSubmitting}
      tone={text.tone}
      title={text.title}
      confirmLabel={text.confirm}
      message={text.message}
    >
      {target !== 'active' && (
        <FormField label="Motif" htmlFor="branch-status-reason" required>
          <textarea
            id="branch-status-reason"
            className="textarea textarea-bordered min-h-20 w-full"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={isSubmitting}
          />
        </FormField>
      )}
    </ConfirmDialog>
  );
}
