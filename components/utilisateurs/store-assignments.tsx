'use client';

/**
 * Affectations d'un compte aux magasins (cahier des charges §5 ; guide §6.19).
 *
 * `StoreAssignmentEditor` : une ligne par magasin — « affecté », « gérant » et,
 * seulement si on le demande, une **période** (remplacement temporaire). La
 * période était toujours affichée avec deux champs de date vides ; elle
 * intriguait plus qu'elle n'aidait (retour client du 4 octobre 2026) : elle
 * se déplie maintenant avec « Remplacement temporaire ».
 *
 * Les magasins proposés viennent de `GET /api/magasins` : le serveur n'y renvoie
 * que les magasins **visibles** par l'utilisateur connecté. Il revérifie de
 * toute façon chaque affectation (`assertAssignableStores`).
 *
 * ⚠️ `lib/stores.ts` est un module serveur : `import type` uniquement.
 */

import { useEffect, useState } from 'react';
import { DatePicker } from '@/components/date-picker';
import { Badge } from '@/components/design-system';
import { formatDateShort } from '@/lib/date-format';

export type AssignmentDraft = {
  storeId: number;
  isManager: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

export type StoreOption = { id: number; code: string; name: string; kind: 'store' | 'headquarters'; status: string };

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

/** Résumé d'une période d'affectation, pour la liste et le récapitulatif. */
export function periodLabel(a: { startsAt: string | null; endsAt: string | null }): string | null {
  if (a.startsAt && a.endsAt) return `du ${formatDateShort(a.startsAt)} au ${formatDateShort(a.endsAt)}`;
  if (a.startsAt) return `à partir du ${formatDateShort(a.startsAt)}`;
  if (a.endsAt) return `jusqu’au ${formatDateShort(a.endsAt)}`;
  return null;
}

export function StoreAssignmentEditor({
  stores,
  value,
  onChange,
  disabled,
}: {
  stores: StoreOption[];
  value: AssignmentDraft[];
  onChange: (value: AssignmentDraft[]) => void;
  disabled?: boolean;
}) {
  const byId = new Map(value.map((a) => [a.storeId, a]));
  // Période dépliée : à la demande, ou d'office si des dates existent déjà.
  const [opened, setOpened] = useState<Set<number>>(
    () => new Set(value.filter((a) => a.startsAt || a.endsAt).map((a) => a.storeId)),
  );

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
        const showPeriod = checked && opened.has(store.id);
        return (
          <li key={store.id} className={`space-y-2 px-3 py-2.5 ${checked ? 'bg-primary/5' : ''}`}>
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
                  <span className="font-medium">{store.name}</span>{' '}
                  <span className="font-mono text-xs text-base-content/50">{store.code}</span>
                </span>
                {store.kind === 'headquarters' && <Badge tone="primary">Siège</Badge>}
                {store.status === 'suspended' && <Badge tone="warning">Suspendu</Badge>}
              </label>
              {checked && (
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
                    <input
                      type="checkbox"
                      className="toggle toggle-sm toggle-primary"
                      checked={assignment!.isManager}
                      disabled={disabled}
                      onChange={(e) => patch(store.id, { isManager: e.target.checked })}
                    />
                    Gérant
                  </label>
                  {!showPeriod && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs min-h-11 sm:min-h-0"
                      disabled={disabled}
                      onClick={() => setOpened((s) => new Set(s).add(store.id))}
                    >
                      Remplacement temporaire
                    </button>
                  )}
                </div>
              )}
            </div>
            {showPeriod && (
              <div className="rounded-lg border border-base-200 bg-base-100 p-3">
                <p className="text-xs text-base-content/70">
                  Accès limité dans le temps (congé d’un collègue, renfort…) : hors de ces dates, ce
                  magasin n’est pas accessible. Laissez vide pour un accès permanent.
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <span className="mb-1 block text-xs text-base-content/55">À partir du</span>
                    <DatePicker
                      value={assignment!.startsAt ?? ''}
                      onChange={(date) => patch(store.id, { startsAt: date || null })}
                      placeholder="jj mois aaaa"
                    />
                  </div>
                  <div>
                    <span className="mb-1 block text-xs text-base-content/55">Jusqu’au</span>
                    <DatePicker
                      value={assignment!.endsAt ?? ''}
                      onChange={(date) => patch(store.id, { endsAt: date || null })}
                      placeholder="jj mois aaaa"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs mt-2 min-h-11 sm:min-h-0"
                  disabled={disabled}
                  onClick={() => {
                    patch(store.id, { startsAt: null, endsAt: null });
                    setOpened((s) => {
                      const next = new Set(s);
                      next.delete(store.id);
                      return next;
                    });
                  }}
                >
                  Accès permanent
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
