'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ToolbarButton } from '@/components/data-toolbar';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  EmptyState,
  FormField,
  MoneyText,
  SkeletonTable,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { formatQuantity } from '@/lib/format';

/* ==================================================================
 * Composants propres au domaine « Ouvriers » (§2 : components/workers/).
 *
 * ⚠️ Les types et les libellés sont **redéclarés ici** plutôt qu'importés de
 * `lib/workers.ts` : ce fichier est un composant client, et `lib/workers.ts`
 * importe `@/db` (donc `@libsql/client`, `fs`, `path`). Un import — même
 * partiel — ferait entrer la chaîne base de données dans le bundle navigateur
 * (CONVENTIONS §11 bis). Les formes ci-dessous décrivent exactement le JSON
 * renvoyé par `/api/workers`.
 *
 * Aucune écriture ne part d'ici sans passer par l'API : la page ne touche
 * jamais la base.
 * ================================================================== */

export type WorkerRole = 'foreman' | 'worker' | 'apprentice';

/** Libellés français des trois rôles (§17.2). */
export const WORKER_ROLE_LABELS: Record<WorkerRole, string> = {
  foreman: 'Chef d’équipe',
  worker: 'Ouvrier',
  apprentice: 'Apprenti',
};

export const WORKER_ROLE_OPTIONS: { value: WorkerRole; label: string }[] = [
  { value: 'worker', label: WORKER_ROLE_LABELS.worker },
  { value: 'foreman', label: WORKER_ROLE_LABELS.foreman },
  { value: 'apprentice', label: WORKER_ROLE_LABELS.apprentice },
];

export function workerRoleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  return WORKER_ROLE_LABELS[role as WorkerRole] ?? role;
}

/** Une ligne de `workers`, telle que renvoyée par `GET /api/workers`. */
export type WorkerRow = {
  id: number;
  name: string;
  phone: string | null;
  role: WorkerRole;
  specialty: string | null;
  dailyRate: number;
  isActive: boolean;
  assignmentCount: number;
  totalDays: number;
  totalLaborCost: number;
  createdAt: string | null;
};

/** Réponse normalisée d'une liste paginée (§27.2). */
export type Paginated<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

/** Message d'erreur de l'API, ou repli lisible. */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  const message = (payload as any)?.error;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

/* ------------------------------------------------------------------
 * Modale — création / modification d'un ouvrier
 * ------------------------------------------------------------------ */

export function WorkerFormModal({
  isOpen,
  onClose,
  onSaved,
  worker,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (worker: WorkerRow) => void;
  /** `null` = création. */
  worker: WorkerRow | null;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<WorkerRole>('worker');
  const [specialty, setSpecialty] = useState('');
  const [dailyRate, setDailyRate] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(worker?.name ?? '');
    setPhone(worker?.phone ?? '');
    setRole(worker?.role ?? 'worker');
    setSpecialty(worker?.specialty ?? '');
    setDailyRate(worker ? String(worker.dailyRate ?? 0) : '');
    setIsActive(worker?.isActive ?? true);
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, worker]);

  const rate = Number(String(dailyRate).replace(',', '.'));

  async function submit() {
    if (isSubmitting) return;

    if (!name.trim()) {
      setFormError('Le nom de l’ouvrier est obligatoire.');
      return;
    }
    if (!Number.isFinite(rate) || rate < 0) {
      setFormError('Le tarif journalier doit être un nombre positif.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(worker ? `/api/workers/${worker.id}` : '/api/workers', {
        method: worker ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim() || null,
          role,
          specialty: specialty.trim() || null,
          dailyRate: rate,
          isActive,
        }),
      });

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "L'ouvrier n'a pas pu être enregistré."),
        );
      }

      const saved = (await response.json()) as WorkerRow;
      toast.success(worker ? 'Ouvrier modifié.' : `Ouvrier « ${saved.name} » créé.`);
      onSaved(saved);
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "L'ouvrier n'a pas pu être enregistré.";
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
      title={worker ? 'Modifier un ouvrier' : 'Nouvel ouvrier'}
      size="md"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField label="Nom complet" htmlFor="worker-name" required>
          <input
            id="worker-name"
            type="text"
            className="input input-bordered min-h-11 w-full"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFormError(null);
            }}
            disabled={isSubmitting}
            placeholder="Ex. Mamadou Camara"
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Rôle" htmlFor="worker-role" required>
            <select
              id="worker-role"
              className="select select-bordered min-h-11 w-full"
              value={role}
              onChange={(event) => setRole(event.target.value as WorkerRole)}
              disabled={isSubmitting}
            >
              {WORKER_ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField
            label="Tarif journalier"
            htmlFor="worker-rate"
            hint="Base du calcul « jours × tarif »."
          >
            <input
              id="worker-rate"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={dailyRate}
              onChange={(event) => {
                setDailyRate(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Téléphone" htmlFor="worker-phone">
            <input
              id="worker-phone"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              disabled={isSubmitting}
              placeholder="Ex. 622 00 00 00"
            />
          </FormField>

          <FormField label="Spécialité" htmlFor="worker-specialty" hint="Maçon, staffeur, briquetier…">
            <input
              id="worker-specialty"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={specialty}
              onChange={(event) => setSpecialty(event.target.value)}
              disabled={isSubmitting}
            />
          </FormField>
        </div>

        {worker && (
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-base-200 bg-base-200/40 px-4 py-3">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              disabled={isSubmitting}
            />
            <span className="text-sm">Ouvrier actif (proposé dans les équipes)</span>
          </label>
        )}

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Enregistrement…
              </>
            ) : worker ? (
              'Enregistrer les modifications'
            ) : (
              'Créer l’ouvrier'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------
 * Modale — gestion du référentiel (liste + création + désactivation)
 * ------------------------------------------------------------------ */

export function workerColumns(): Column<WorkerRow>[] {
  return [
    {
      key: 'name',
      label: 'Ouvrier',
      primary: true,
      render: (w) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{w.name}</div>
          <div className="text-xs text-base-content/50">{w.specialty || 'Sans spécialité'}</div>
        </div>
      ),
    },
    {
      key: 'role',
      label: 'Rôle',
      render: (w) => <Badge tone="info">{workerRoleLabel(w.role)}</Badge>,
    },
    {
      key: 'phone',
      label: 'Téléphone',
      hideOnMobile: true,
      render: (w) => <span className="tabular">{w.phone || '—'}</span>,
    },
    {
      key: 'dailyRate',
      label: 'Tarif / jour',
      render: (w) => <MoneyText value={w.dailyRate} />,
    },
    {
      key: 'assignments',
      label: 'Affectations',
      hideOnMobile: true,
      render: (w) => <span className="tabular">{w.assignmentCount}</span>,
    },
    {
      key: 'days',
      label: 'Jours cumulés',
      hideOnMobile: true,
      render: (w) => <span className="tabular">{formatQuantity(w.totalDays)}</span>,
    },
    {
      key: 'cost',
      label: 'Coût cumulé',
      hideOnMobile: true,
      render: (w) => <MoneyText value={w.totalLaborCost} />,
    },
    {
      key: 'state',
      label: 'État',
      render: (w) =>
        w.isActive ? <Badge tone="success">Actif</Badge> : <Badge tone="neutral">Inactif</Badge>,
    },
  ];
}

export function WorkersManagerModal({
  isOpen,
  onClose,
  onChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Appelée après toute écriture : les pages hôtes rafraîchissent leur liste. */
  onChanged?: () => void;
}) {
  const canManage = usePermission('workers.manage');

  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  /* Un état booléen par modale (§8.3 règle 1). */
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingWorker, setEditingWorker] = useState<WorkerRow | null>(null);
  const [isDeactivateOpen, setIsDeactivateOpen] = useState(false);
  const [targetWorker, setTargetWorker] = useState<WorkerRow | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '200', page: '1' });
        if (includeInactive) params.set('includeInactive', 'true');
        if (search.trim()) params.set('search', search.trim());

        const response = await fetch(`/api/workers?${params.toString()}`, {
          signal,
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Chargement des ouvriers impossible.'));
        }

        const payload = (await response.json()) as Paginated<WorkerRow>;
        if (signal.aborted) return;
        setWorkers(Array.isArray(payload.data) ? payload.data : []);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Chargement des ouvriers impossible.');
      } finally {
        if (!signal.aborted) setIsLoading(false);
      }
    },
    [includeInactive, search],
  );

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(() => void load(controller.signal), 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, load, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const columns = useMemo(() => workerColumns(), []);

  async function deactivate() {
    if (!targetWorker) return;
    setIsSubmitting(true);
    try {
      const reactivate = !targetWorker.isActive;
      const response = await fetch(
        `/api/workers/${targetWorker.id}${reactivate ? '?reactivate=true' : ''}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );
      if (!response.ok) {
        throw new Error(await readApiError(response, "L'opération n'a pas pu aboutir."));
      }
      toast.success(
        reactivate
          ? `Ouvrier « ${targetWorker.name} » réactivé.`
          : `Ouvrier « ${targetWorker.name} » désactivé.`,
      );
      setIsDeactivateOpen(false);
      setTargetWorker(null);
      refresh();
      onChanged?.();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "L'opération n'a pas pu aboutir.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Ouvriers"
        size="xl"
        fullScreenMobile
      >
        <div className="space-y-4">
          <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
            Table <strong>unique</strong> de main-d’œuvre, partagée par les chantiers et la
            briqueterie. Un journalier ponctuel non enregistré reste saisissable directement dans
            une équipe.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              className="input input-bordered min-h-11 min-w-[12rem] flex-1"
              placeholder="Rechercher un nom, un téléphone, une spécialité…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              type="button"
              className={`btn min-h-11 ${includeInactive ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
              aria-pressed={includeInactive}
              onClick={() => setIncludeInactive((value) => !value)}
            >
              Afficher les inactifs
            </button>
            {canManage && (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => {
                  setEditingWorker(null);
                  setIsFormOpen(true);
                }}
              >
                Nouvel ouvrier
              </button>
            )}
          </div>

          {isLoading && workers.length === 0 ? (
            <SkeletonTable rows={5} cols={4} />
          ) : error ? (
            <EmptyState
              title="Ouvriers indisponibles"
              description={error}
              action={<ToolbarButton onClick={refresh}>Réessayer</ToolbarButton>}
            />
          ) : workers.length === 0 ? (
            <EmptyState
              title="Aucun ouvrier"
              description="Enregistrez les chefs d’équipe, ouvriers et apprentis pour les affecter aux chantiers et aux fabrications."
              action={
                canManage ? (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11"
                    onClick={() => {
                      setEditingWorker(null);
                      setIsFormOpen(true);
                    }}
                  >
                    Créer le premier ouvrier
                  </button>
                ) : undefined
              }
            />
          ) : (
            <ResponsiveTable
              columns={columns}
              data={workers}
              getRowKey={(w) => w.id}
              emptyMessage="Aucun ouvrier."
              actions={
                canManage
                  ? (w) => (
                      <>
                        <ToolbarButton
                          onClick={() => {
                            setEditingWorker(w);
                            setIsFormOpen(true);
                          }}
                        >
                          Modifier
                        </ToolbarButton>
                        <ToolbarButton
                          variant={w.isActive ? 'error' : 'primary'}
                          onClick={() => {
                            setTargetWorker(w);
                            setIsDeactivateOpen(true);
                          }}
                        >
                          {w.isActive ? 'Désactiver' : 'Réactiver'}
                        </ToolbarButton>
                      </>
                    )
                  : undefined
              }
            />
          )}

          <div className="flex justify-end border-t border-base-200 pt-4">
            <button type="button" className="btn btn-ghost min-h-11" onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
      </Modal>

      <WorkerFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        worker={editingWorker}
        onSaved={() => {
          refresh();
          onChanged?.();
        }}
      />

      <ConfirmDialog
        isOpen={isDeactivateOpen}
        onClose={() => {
          if (!isSubmitting) setIsDeactivateOpen(false);
        }}
        onConfirm={deactivate}
        isSubmitting={isSubmitting}
        tone={targetWorker?.isActive ? 'error' : 'success'}
        title={targetWorker?.isActive ? 'Désactiver cet ouvrier' : 'Réactiver cet ouvrier'}
        confirmLabel={targetWorker?.isActive ? 'Désactiver' : 'Réactiver'}
        message={
          targetWorker?.isActive ? (
            <>
              <strong>{targetWorker?.name}</strong> ne sera plus proposé dans les équipes. Ses
              affectations passées sont conservées : la fiche n’est <strong>jamais supprimée</strong>.
            </>
          ) : (
            <>
              <strong>{targetWorker?.name}</strong> redeviendra proposé dans les équipes.
            </>
          )
        }
      />
    </>
  );
}
