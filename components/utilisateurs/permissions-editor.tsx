'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { Badge, ErrorState, Skeleton } from '@/components/design-system';
import { RoleGate } from '@/components/role-gate';
import {
  ACTION_META,
  ROLE_LABELS,
  type Action,
  type Role,
} from '@/lib/permissions';

/**
 * Écran de réglage des permissions d'un utilisateur (demande du client).
 *
 * L'administrateur choisit, **action par action**, l'un des trois états :
 *  - **Hérité** — la matrice du rôle décide (aucune surcharge) ;
 *  - **Autorisé** — accordé même si le rôle ne l'accorde pas ;
 *  - **Refusé**  — retiré même si le rôle l'accorde.
 *
 * Le rôle `admin` n'est pas modifiable : il détient toutes les permissions par
 * construction, ce qui empêche de se verrouiller hors de l'application.
 *
 * ⚠️ `lib/permissions.ts` est un module **client-safe** : il ne touche pas à la
 * base. Les données viennent exclusivement de l'API.
 */

type Effect = 'allow' | 'deny';

type MatrixAction = {
  action: Action;
  fromRole: boolean;
  effect: Effect | null;
  granted: boolean;
};

type MatrixResponse = {
  user: { id: number; name: string; username: string; role: Role };
  isAdmin: boolean;
  roleDefaults: Action[];
  overrides: { action: Action; effect: Effect }[];
  effective: Action[];
  groups: { group: string; actions: MatrixAction[] }[];
};

type Choice = Effect | null; // null = hérité du rôle

const CHOICE_LABELS: Record<'inherited' | 'allow' | 'deny', string> = {
  inherited: 'Hérité',
  allow: 'Autorisé',
  deny: 'Refusé',
};

export function PermissionsEditorModal({
  isOpen,
  userId,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  userId: number | null;
  onClose: () => void;
  /** Appelé après un enregistrement réussi (pour rafraîchir la liste). */
  onSaved?: () => void;
}) {
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [draft, setDraft] = useState<Map<Action, Choice>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/users/${userId}/permissions`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Chargement des permissions impossible');
      }

      const data = (await res.json()) as MatrixResponse;
      setMatrix(data);

      const next = new Map<Action, Choice>();
      for (const group of data.groups) {
        for (const item of group.actions) next.set(item.action, item.effect);
      }
      setDraft(next);
    } catch (err: any) {
      setError(err?.message ?? 'Chargement impossible');
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (isOpen && userId) void load();
    if (!isOpen) {
      setMatrix(null);
      setDraft(new Map());
      setError(null);
      setFilter('');
    }
  }, [isOpen, userId, load]);

  /** Nombre de surcharges explicites dans le brouillon (hors héritage). */
  const changedCount = useMemo(
    () => [...draft.values()].filter((choice) => choice !== null).length,
    [draft],
  );

  const setChoice = (action: Action, choice: Choice) =>
    setDraft((current) => {
      const next = new Map(current);
      if (choice === null) next.delete(action);
      else next.set(action, choice);
      return next;
    });

  const grantAll = () => {
    if (!matrix) return;
    const next = new Map<Action, Choice>();
    for (const group of matrix.groups) {
      for (const item of group.actions) {
        // On n'écrit une surcharge que si elle change quelque chose.
        next.set(item.action, item.fromRole ? null : 'allow');
      }
    }
    setDraft(next);
    toast.info('Toutes les permissions seront accordées');
  };

  const denyAll = () => {
    if (!matrix) return;
    const next = new Map<Action, Choice>();
    for (const group of matrix.groups) {
      for (const item of group.actions) {
        next.set(item.action, item.fromRole ? 'deny' : null);
      }
    }
    setDraft(next);
    toast.info('Toutes les permissions du rôle seront retirées');
  };

  const resetToRole = () => {
    setDraft(new Map());
    toast.info('Retour à la matrice du rôle');
  };

  const handleSave = async () => {
    if (!userId) return;
    setIsSubmitting(true);

    try {
      const overrides = [...draft.entries()]
        .filter(([, effect]) => effect !== null)
        .map(([action, effect]) => ({ action, effect }));

      const res = await fetch(`/api/users/${userId}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ overrides }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? 'Enregistrement impossible');

      toast.success('Permissions enregistrées');
      onSaved?.();
      onClose();
    } catch (err: any) {
      toast.error(err?.message ?? 'Enregistrement impossible', { autoClose: 8000 });
    } finally {
      setIsSubmitting(false);
    }
  };

  const normalizedFilter = filter.trim().toLowerCase();

  const visibleGroups = useMemo(() => {
    if (!matrix) return [];
    if (!normalizedFilter) return matrix.groups;

    return matrix.groups
      .map((group) => ({
        group: group.group,
        actions: group.actions.filter((item) => {
          const meta = ACTION_META[item.action];
          return (
            meta.label.toLowerCase().includes(normalizedFilter) ||
            item.action.toLowerCase().includes(normalizedFilter) ||
            meta.description.toLowerCase().includes(normalizedFilter)
          );
        }),
      }))
      .filter((group) => group.actions.length > 0);
  }, [matrix, normalizedFilter]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={
        matrix ? (
          <span className="flex flex-wrap items-center gap-2">
            Permissions de {matrix.user.name}
            <Badge tone={matrix.isAdmin ? 'primary' : 'neutral'}>
              {ROLE_LABELS[matrix.user.role] ?? matrix.user.role}
            </Badge>
          </span>
        ) : (
          'Permissions'
        )
      }
      size="xl"
      fullScreenMobile
    >
      {isLoading && (
        <div className="space-y-3 py-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {!isLoading && error && (
        <ErrorState title="Permissions indisponibles" description={error} onRetry={() => void load()} />
      )}

      {!isLoading && !error && matrix && (
        <div className="space-y-4 py-1">
          {/* Bandeau d'explication : la règle doit être comprise, pas devinée. */}
          {matrix.isAdmin ? (
            <div className="rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm">
              <strong>Administrateur : toutes les permissions.</strong>
              <p className="mt-1 text-xs text-base-content/70">
                Le rôle administrateur détient l’intégralité des permissions par construction, et
                ne peut pas être restreint. C’est ce qui garantit que l’application ne peut jamais
                devenir inadministrable. Pour limiter quelqu’un, changez son rôle puis ajustez ses
                permissions.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-base-200 bg-base-200/40 p-3 text-sm">
              <p className="text-xs leading-relaxed text-base-content/70">
                <strong>Hérité</strong> : la permission du rôle s’applique.{' '}
                <strong>Autorisé</strong> : accordée même si le rôle la refuse.{' '}
                <strong>Refusé</strong> : retirée même si le rôle l’accorde.
                <br />
                Un droit accordé ou retiré ici est appliqué <strong>par le serveur</strong> sur
                chaque appel d’API — ce n’est pas un simple masquage d’interface.
              </p>
            </div>
          )}

          {!matrix.isAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                className="input input-bordered field-rounded input-sm w-full max-w-xs"
                placeholder="Rechercher une permission…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <RoleGate action="users.manage">
                <button type="button" className="btn btn-ghost btn-sm" onClick={grantAll}>
                  Tout autoriser
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={denyAll}>
                  Tout refuser
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={resetToRole}>
                  Réinitialiser (rôle)
                </button>
              </RoleGate>
              <span className="ml-auto text-xs text-base-content/60 tabular">
                {changedCount} surcharge{changedCount > 1 ? 's' : ''} explicite
                {changedCount > 1 ? 's' : ''}
              </span>
            </div>
          )}

          <div className="max-h-[52vh] space-y-5 overflow-y-auto pr-1">
            {visibleGroups.length === 0 && (
              <p className="py-6 text-center text-sm text-base-content/50">
                Aucune permission ne correspond à « {filter} ».
              </p>
            )}

            {visibleGroups.map((group) => (
              <section key={group.group}>
                <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-base-content/50">
                  {group.group}
                </h3>
                <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
                  {group.actions.map((item) => (
                    <PermissionRow
                      key={item.action}
                      item={item}
                      choice={draft.get(item.action) ?? null}
                      onChoose={(choice) => setChoice(item.action, choice)}
                      readOnly={matrix.isAdmin}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={isSubmitting}
              onClick={onClose}
            >
              Fermer
            </button>
            {!matrix.isAdmin && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={isSubmitting}
                onClick={() => void handleSave()}
              >
                {isSubmitting ? (
                  <span className="loading loading-spinner loading-sm" />
                ) : (
                  'Enregistrer les permissions'
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Une ligne : libellé, rôle, et sélecteur à trois états. */
function PermissionRow({
  item,
  choice,
  onChoose,
  readOnly,
}: {
  item: MatrixAction;
  choice: Choice;
  onChoose: (choice: Choice) => void;
  readOnly: boolean;
}) {
  const meta = ACTION_META[item.action];
  const state: 'inherited' | 'allow' | 'deny' = choice ?? 'inherited';

  const resultLabel =
    state === 'allow' ? 'Accordé (surcharge)' : state === 'deny' ? 'Refusé (surcharge)' : item.fromRole ? 'Accordé par le rôle' : 'Refusé par le rôle';

  const resultTone = state === 'deny' ? 'error' : (state === 'allow' ? 'success' : item.fromRole ? 'success' : 'neutral') as
    | 'success'
    | 'error'
    | 'neutral';

  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {meta.label}
          {meta.dangerous && <Badge tone="warning">Sensible</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-base-content/55">{meta.description}</p>
        <p className="mt-1 text-[11px] text-base-content/45">
          <span className="font-mono">{item.action}</span> · {resultLabel}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {readOnly ? (
          <Badge tone={resultTone}>{choice === 'deny' ? 'Refusé' : 'Accordé'}</Badge>
        ) : (
          <div
            className="flex items-center gap-1 rounded-xl border border-base-200 bg-base-200/40 p-1"
            role="group"
            aria-label={`Permission : ${meta.label}`}
          >
            {(['inherited', 'allow', 'deny'] as const).map((option) => {
              const active = state === option;
              const activeClass =
                option === 'deny'
                  ? 'btn-error'
                  : option === 'allow'
                    ? 'btn-success'
                    : 'btn-primary';

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onChoose(option === 'inherited' ? null : option)}
                  className={`btn btn-xs min-h-8 ${active ? activeClass : 'btn-ghost'}`}
                  aria-pressed={active}
                  title={
                    option === 'inherited'
                      ? `Suivre le rôle (${item.fromRole ? 'accordé' : 'refusé'})`
                      : option === 'allow'
                        ? 'Accorder explicitement'
                        : 'Refuser explicitement'
                  }
                >
                  {CHOICE_LABELS[option]}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </li>
  );
}
