'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Badge, Card, EmptyState, ErrorState, MoneyText, SkeletonCards, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { StoreScopeSelect, useStoreScope } from '@/components/store-scope';
import { formatNumber, formatQuantity } from '@/lib/format';
import {
  WORKER_ROLE_OPTIONS,
  WorkerFormModal,
  readApiError,
  workerRoleLabel,
  type Paginated,
  type WorkerRow,
} from '@/components/workers/workers-modals';

/* ==================================================================
 * Ouvriers et équipes (cahier « Prestations » §11).
 *
 * Chaque magasin voit **ses** ouvriers et les ouvriers **communs** (créés
 * avant la v2, ou déclarés communs par l'administration). Les équipes
 * regroupent des ouvriers : « Affecter une équipe » sur un chantier les ajoute
 * tous d'un coup, chacun à son tarif journalier.
 * ================================================================== */

export default function OuvriersPage() {
  const canManage = usePermission('workers.manage');
  const { scope, setScope, apply } = useStoreScope('ouvriers');
  const storeParam = apply(new URLSearchParams()).get('store') ?? '';
  const [search, setSearch] = useState('');
  const [team, setTeam] = useState('');
  const [role, setRole] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [view, setView] = useState<'teams' | 'list'>('teams');
  const [rows, setRows] = useState<WorkerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<WorkerRow | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    const params = new URLSearchParams({ limit: '500', sort: 'name' });
    if (showInactive) params.set('includeInactive', 'true');
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/workers?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Les ouvriers n’ont pas pu être chargés.'));
        return (await response.json()) as Paginated<WorkerRow>;
      })
      .then((payload) => setRows(payload.data ?? []))
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Les ouvriers n’ont pas pu être chargés.');
      });
    return () => controller.abort();
  }, [showInactive, storeParam, reload]);

  const refresh = useCallback(() => setReload((r) => r + 1), []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (rows ?? []).filter(
      (w) =>
        (!term || `${w.name} ${w.phone ?? ''} ${w.specialty ?? ''} ${w.team ?? ''}`.toLowerCase().includes(term)) &&
        (!team || (team === '__none' ? !w.team : w.team === team)) &&
        (!role || w.role === role),
    );
  }, [rows, search, team, role]);

  const teams = useMemo(() => {
    const map = new Map<string, WorkerRow[]>();
    for (const w of filtered) {
      const key = w.team || '';
      map.set(key, [...(map.get(key) ?? []), w]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'fr')));
  }, [filtered]);

  const teamOptions = useMemo(
    () => [
      ...[...new Set((rows ?? []).map((w) => w.team).filter((t): t is string => Boolean(t)))].sort().map((t) => ({ value: t, label: t })),
      { value: '__none', label: 'Sans équipe' },
    ],
    [rows],
  );

  async function toggleActive(worker: WorkerRow) {
    try {
      const response = await fetch(`/api/workers/${worker.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ isActive: !worker.isActive }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Modification impossible.'));
      toast.success(worker.isActive ? `${worker.name} est désactivé.` : `${worker.name} est réactivé.`);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Modification impossible.');
    }
  }

  const columns: Column<WorkerRow>[] = [
    {
      key: 'name',
      label: 'Ouvrier',
      primary: true,
      render: (w) => (
        <div className="min-w-0">
          <span className="block truncate font-medium">{w.name}</span>
          <span className="block truncate text-xs text-base-content/55">
            {w.specialty || 'Sans spécialité'}
            {w.phone ? ` · ${w.phone}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'team',
      label: 'Équipe',
      render: (w) => (
        <div className="flex flex-col items-start gap-1">
          {w.team ? <Badge tone="primary">{w.team}</Badge> : <span className="text-xs text-base-content/50">Sans équipe</span>}
          <span className="text-xs text-base-content/55">{w.storeId ? w.storeName : 'Commun à tous les magasins'}</span>
        </div>
      ),
    },
    {
      key: 'role',
      label: 'Rôle',
      hideOnMobile: true,
      render: (w) => (
        <span className="flex flex-wrap items-center gap-1">
          {workerRoleLabel(w.role)}
          {!w.isActive && <Badge tone="neutral">Inactif</Badge>}
        </span>
      ),
    },
    { key: 'rate', label: 'Tarif / jour', className: 'text-right whitespace-nowrap', render: (w) => <MoneyText value={w.dailyRate} bold /> },
    {
      key: 'usage',
      label: 'Chantiers',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (w) => (
        <span className="block text-sm">
          {formatNumber(w.assignmentCount)} affectation{w.assignmentCount > 1 ? 's' : ''}
          <span className="block text-xs text-base-content/55">{formatQuantity(w.totalDays)} jour(s)</span>
        </span>
      ),
    },
  ];

  const actions = canManage
    ? (w: WorkerRow) => (
        <div className="flex justify-end gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-sm min-h-11"
            onClick={() => {
              setEditing(w);
              setIsFormOpen(true);
            }}
          >
            Modifier
          </button>
          <button type="button" className={`btn btn-ghost btn-sm min-h-11 ${w.isActive ? 'text-warning' : 'text-success'}`} onClick={() => void toggleActive(w)}>
            {w.isActive ? 'Désactiver' : 'Réactiver'}
          </button>
        </div>
      )
    : undefined;

  const active = (rows ?? []).filter((w) => w.isActive);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Chantiers"
        title="Ouvriers et équipes"
        description="Les chefs d’équipe, ouvriers et apprentis du magasin, leur tarif journalier et leurs équipes. Leur coût s’impute aux chantiers où ils travaillent."
        actions={
          canManage ? (
            <button
              type="button"
              className="btn btn-primary min-h-11"
              onClick={() => {
                setEditing(null);
                setIsFormOpen(true);
              }}
            >
              Nouvel ouvrier
            </button>
          ) : undefined
        }
      />

      {!rows ? (
        <SkeletonCards count={3} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCardDelta label="Ouvriers actifs" tooltip="Ouvriers du magasin (et ouvriers communs) qu’on peut affecter à un chantier." tone="primary" value={formatNumber(active.length)} hint={`${formatNumber(active.filter((w) => w.role === 'foreman').length)} chef(s) d’équipe`} />
          <StatCardDelta label="Équipes" tooltip="Groupes d’ouvriers affectables d’un coup à un chantier." tone="info" value={formatNumber(new Set(active.map((w) => w.team).filter(Boolean)).size)} hint={`${formatNumber(active.filter((w) => !w.team).length)} ouvrier(s) sans équipe`} />
          <StatCardDelta label="Main-d’œuvre cumulée" tooltip="Total jours × tarif de toutes les affectations de ces ouvriers sur les chantiers." tone="warning" value={<MoneyText value={(rows ?? []).reduce((sum, w) => sum + w.totalLaborCost, 0)} />} hint={`${formatQuantity((rows ?? []).reduce((sum, w) => sum + w.totalDays, 0))} jour(s) travaillé(s)`} />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Rechercher un nom, une spécialité, une équipe…"
        filters={
          <>
            <StoreScopeSelect value={scope} onChange={setScope} className="min-h-11 w-full sm:w-52" />
            <div className="w-full sm:w-48">
              <FilterSelect value={team} onChange={setTeam} options={teamOptions} placeholder="Toutes les équipes" />
            </div>
            <div className="join w-full sm:w-auto" role="group" aria-label="Présentation">
              <button type="button" className={`btn join-item min-h-11 flex-1 whitespace-nowrap ${view === 'teams' ? 'btn-primary' : 'btn-ghost border border-base-300'}`} aria-pressed={view === 'teams'} onClick={() => setView('teams')}>
                Par équipe
              </button>
              <button type="button" className={`btn join-item min-h-11 flex-1 whitespace-nowrap ${view === 'list' ? 'btn-primary' : 'btn-ghost border border-base-300'}`} aria-pressed={view === 'list'} onClick={() => setView('list')}>
                Liste
              </button>
            </div>
          </>
        }
        secondaryFilters={
          <>
            <FilterSelect value={role} onChange={setRole} options={WORKER_ROLE_OPTIONS} placeholder="Tous les rôles" />
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="checkbox checkbox-sm" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Afficher les inactifs
            </label>
          </>
        }
        secondaryCount={[role].filter(Boolean).length + (showInactive ? 1 : 0)}
      />

      {error ? (
        <ErrorState title="Ouvriers indisponibles" description={error} onRetry={refresh} />
      ) : !rows ? (
        <SkeletonTable rows={6} cols={5} />
      ) : filtered.length === 0 ? (
        <EmptyState title="Aucun ouvrier" description={search || team || role ? 'Aucun ouvrier ne correspond.' : 'Ajoutez les ouvriers qui travaillent sur vos chantiers.'} />
      ) : view === 'list' ? (
        <ResponsiveTable columns={columns} data={filtered} getRowKey={(w) => w.id} actions={actions} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {teams.map(([name, members]) => (
            <Card key={name || 'sans-equipe'} className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{name || 'Sans équipe'}</h2>
                  <p className="text-xs text-base-content/55">
                    {members.length} ouvrier{members.length > 1 ? 's' : ''} · coût d’une journée{' '}
                    <MoneyText value={members.filter((m) => m.isActive).reduce((sum, m) => sum + m.dailyRate, 0)} bold />
                  </p>
                </div>
                {name && <Badge tone="primary">Équipe</Badge>}
              </div>
              <ul className="divide-y divide-base-200">
                {members.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {w.name}
                        {!w.isActive && <span className="ml-2 text-xs text-base-content/50">(inactif)</span>}
                      </span>
                      <span className="block truncate text-xs text-base-content/55">
                        {workerRoleLabel(w.role)}
                        {w.specialty ? ` · ${w.specialty}` : ''}
                        {w.storeId ? '' : ' · commun'}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <MoneyText value={w.dailyRate} className="text-sm" />
                      {canManage && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm min-h-11"
                          onClick={() => {
                            setEditing(w);
                            setIsFormOpen(true);
                          }}
                        >
                          Modifier
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      <WorkerFormModal isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} worker={editing} onSaved={refresh} />
    </div>
  );
}
