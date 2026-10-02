'use client';

/**
 * Affectations d'un compte aux magasins (cahier des charges §5 ; guide §6.19).
 *
 *  - `StoreAssignmentEditor` : liste de cases « affecté » + « gérant » + période
 *    facultative, utilisée à la création d'un compte et dans la modale ci-dessous ;
 *  - `StoreAssignmentsModal` : `GET` puis `PUT /api/users/[id]/magasins`.
 *
 * Les magasins proposés viennent de `GET /api/magasins` : le serveur n'y renvoie
 * que les magasins **visibles** par l'utilisateur connecté (tous pour
 * l'administrateur général, les siens pour un gérant). Il revérifie de toute
 * façon chaque affectation (`assertAssignableStores`).
 *
 * ⚠️ `lib/stores.ts` est un module serveur : `import type` uniquement.
 */

import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { DatePicker } from '@/components/date-picker';
import { Badge } from '@/components/design-system';
import type { UserStoreAssignment } from '@/lib/stores';
import type { UserRow } from '@/lib/users';

export type AssignmentDraft = {
  storeId: number;
  isManager: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

type StoreOption = { id: number; code: string; name: string; kind: 'store' | 'headquarters'; status: string };

/** Magasins proposés à l'affectation (non archivés, visibles par l'utilisateur connecté). */
export function useAssignableStores(enabled: boolean) {
  const [stores, setStores] = useState<StoreOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || stores !== null) return;
    let active = true;
    fetch('/api/magasins', { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error ?? 'Liste des magasins indisponible');
        if (active) setStores(Array.isArray(payload.data) ? payload.data : []);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Liste des magasins indisponible');
      });
    return () => {
      active = false;
    };
  }, [enabled, stores]);

  return { stores, error };
}

export function StoreAssignmentEditor({
  stores,
  value,
  onChange,
  disabled,
  showPeriod = false,
}: {
  stores: StoreOption[];
  value: AssignmentDraft[];
  onChange: (value: AssignmentDraft[]) => void;
  disabled?: boolean;
  /** Dates de début / fin (délégation temporaire, §5 du cahier des charges). */
  showPeriod?: boolean;
}) {
  const byId = new Map(value.map((a) => [a.storeId, a]));

  const toggle = (storeId: number, checked: boolean) => {
    if (checked) onChange([...value, { storeId, isManager: false, startsAt: null, endsAt: null }]);
    else onChange(value.filter((a) => a.storeId !== storeId));
  };
  const patch = (storeId: number, changes: Partial<AssignmentDraft>) =>
    onChange(value.map((a) => (a.storeId === storeId ? { ...a, ...changes } : a)));

  if (stores.length === 0) {
    return <p className="text-sm text-base-content/60">Aucun magasin disponible.</p>;
  }

  return (
    <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
      {stores.map((store) => {
        const assignment = byId.get(store.id);
        const checked = Boolean(assignment);
        return (
          <li key={store.id} className="space-y-2 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex min-h-11 cursor-pointer items-center gap-3 sm:min-h-0">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm checkbox-primary"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => toggle(store.id, e.target.checked)}
                />
                <span className="text-sm">
                  <span className="font-mono text-xs text-base-content/55">{store.code}</span>{' '}
                  <span className="font-medium">{store.name}</span>
                </span>
                {store.kind === 'headquarters' && <Badge tone="primary">Siège</Badge>}
                {store.status === 'suspended' && <Badge tone="warning">Suspendu</Badge>}
              </label>
              {checked && (
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
                  <input
                    type="checkbox"
                    className="toggle toggle-sm toggle-primary"
                    checked={assignment!.isManager}
                    disabled={disabled}
                    onChange={(e) => patch(store.id, { isManager: e.target.checked })}
                  />
                  Gérant de ce magasin
                </label>
              )}
            </div>
            {checked && showPeriod && (
              <div className="grid gap-2 pl-0 sm:grid-cols-2 sm:pl-7">
                <div>
                  <span className="mb-1 block text-xs text-base-content/55">À partir du (facultatif)</span>
                  <DatePicker
                    value={assignment!.startsAt ?? ''}
                    onChange={(date) => patch(store.id, { startsAt: date || null })}
                    placeholder="jj mois aaaa"
                  />
                </div>
                <div>
                  <span className="mb-1 block text-xs text-base-content/55">Jusqu’au (facultatif)</span>
                  <DatePicker
                    value={assignment!.endsAt ?? ''}
                    onChange={(date) => patch(store.id, { endsAt: date || null })}
                    placeholder="jj mois aaaa"
                  />
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function StoreAssignmentsModal({
  user,
  onClose,
  onSaved,
}: {
  /** `null` = modale fermée. */
  user: UserRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isOpen = user !== null;
  const { stores, error: storesError } = useAssignableStores(isOpen);
  const [value, setValue] = useState<AssignmentDraft[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setIsLoading(true);
    setLoadError(null);
    fetch(`/api/users/${user.id}/magasins`, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error ?? 'Affectations indisponibles');
        const list = (Array.isArray(payload) ? payload : []) as UserStoreAssignment[];
        if (active) {
          setValue(
            list
              .filter((a) => a.isActive)
              .map((a) => ({ storeId: a.storeId, isManager: a.isManager, startsAt: a.startsAt, endsAt: a.endsAt })),
          );
        }
      })
      .catch((caught: unknown) => {
        if (active) setLoadError(caught instanceof Error ? caught.message : 'Affectations indisponibles');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user]);

  const save = async () => {
    if (!user) return;
    if (user.role !== 'admin' && value.length === 0) {
      toast.error('Affectez ce compte à au moins un magasin.');
      return;
    }
    const invalid = value.find((a) => a.startsAt && a.endsAt && a.startsAt > a.endsAt);
    if (invalid) {
      toast.error('Une date de fin précède la date de début.');
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/users/${user.id}/magasins`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ stores: value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error ?? 'Enregistrement impossible');
      toast.success(`Magasins de « ${user.name} » enregistrés`);
      onSaved();
      onClose();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Enregistrement impossible', { autoClose: 8000 });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={`Magasins de « ${user?.name ?? ''} »`}
      size="lg"
      fullScreenMobile
      footer={
        <div className="flex justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" disabled={isSubmitting} onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn-primary min-h-11 sm:min-h-0"
            disabled={isSubmitting || isLoading || Boolean(loadError) || stores === null}
            onClick={() => void save()}
          >
            {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : 'Enregistrer'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-base-content/70">
          Cochez les magasins dans lesquels ce compte peut travailler. Le <strong>gérant</strong> d’un
          magasin peut approuver ses dépenses et ses transferts. Une période limite l’affectation dans
          le temps (remplacement, délégation temporaire).
        </p>
        {user?.role === 'admin' && (
          <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">
            Un administrateur général voit déjà tous les magasins : ses affectations ne servent qu’à
            choisir les magasins proposés à la connexion.
          </p>
        )}
        <p className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
          Après l’enregistrement, ce compte sera <strong>déconnecté</strong> : il devra se reconnecter
          pour travailler avec ses nouveaux magasins.
        </p>
        {loadError || storesError ? (
          <p role="alert" className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {loadError ?? storesError}
          </p>
        ) : isLoading || stores === null ? (
          <div className="flex justify-center py-6">
            <span className="loading loading-spinner" />
          </div>
        ) : (
          <StoreAssignmentEditor stores={stores} value={value} onChange={setValue} disabled={isSubmitting} showPeriod />
        )}
      </div>
    </Modal>
  );
}
