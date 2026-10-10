'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { Badge, EmptyState, ErrorState, SkeletonTable } from '@/components/design-system';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { usePermission } from '@/components/role-gate';
import { branchApiUrl, useBranch } from '@/components/filiales/branch-context';
import { BrickTabs, useBrickScope } from '@/components/briqueterie/brick-tabs';
import { readApiError } from '@/components/workers/workers-modals';

/**
 * Onglet « Clients » d'une filiale (README §31.4) — **clients partagés**.
 *
 * Un client reste celui de son magasin ; il peut acheter à plusieurs filiales
 * (briqueterie et meubles, par exemple). Une filiale en mode « tous les
 * clients » les voit tous ; en mode « clients choisis », seuls ceux partagés
 * ici sont proposés dans ses commandes et ses ventes. Chaque document garde
 * sa filiale : la fiche client montre l'historique filiale par filiale.
 */

type BranchCustomerRow = {
  customerId: number;
  name: string;
  phone: string | null;
  storeName: string | null;
  shared: boolean;
  ordersCount: number;
  salesCount: number;
};

export default function BranchCustomersPage() {
  const B = useBranch();
  const { scope, setScope, withStore, showStore } = useBrickScope();
  const canShare = usePermission('brick.types') && B.writable && B.canLevel('manage');
  const [rows, setRows] = useState<BranchCustomerRow[]>([]);
  const [search, setSearch] = useState('');
  const [onlyShared, setOnlyShared] = useState(B.branch.customerMode === 'selected');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set('search', search.trim());
        if (onlyShared) params.set('shared', 'true');
        const response = await fetch(withStore(branchApiUrl(`/clients?${params.toString()}`)), {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await readApiError(response, 'Les clients n’ont pas pu être chargés.'));
        const payload = (await response.json()) as { data: BranchCustomerRow[] };
        setRows(payload.data ?? []);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Les clients n’ont pas pu être chargés.');
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [search, onlyShared, withStore, reloadToken]);

  const toggle = useCallback(
    async (row: BranchCustomerRow) => {
      setBusyId(row.customerId);
      try {
        const response = await fetch(branchApiUrl('/clients'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: row.customerId, shared: !row.shared }),
        });
        if (!response.ok) throw new Error(await readApiError(response, 'Le partage n’a pas pu être modifié.'));
        toast.success(
          row.shared ? `${row.name} n’est plus partagé avec ${B.branch.name}.` : `${row.name} est partagé avec ${B.branch.name}.`,
        );
        setReloadToken((t) => t + 1);
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : 'Le partage n’a pas pu être modifié.');
      } finally {
        setBusyId(null);
      }
    },
    [B.branch.name],
  );

  const columns: Column<BranchCustomerRow>[] = [
    {
      key: 'name',
      label: 'Client',
      primary: true,
      render: (row) => (
        <div className="min-w-0">
          <Link href={`/clients/${row.customerId}`} className="link link-hover font-medium">
            {row.name}
          </Link>
          <div className="text-xs text-base-content/60">{row.phone || '—'}</div>
        </div>
      ),
    },
    ...(showStore
      ? [{ key: 'store', label: 'Magasin', render: (row: BranchCustomerRow) => <span className="text-sm">{row.storeName ?? '—'}</span> }]
      : []),
    {
      key: 'shared',
      label: 'Partage',
      render: (row) =>
        row.shared ? <Badge tone="success">Partagé</Badge> : <Badge tone="neutral">{B.branch.customerMode === 'all' ? 'Accès par défaut' : 'Non partagé'}</Badge>,
    },
    { key: 'orders', label: 'Commandes', render: (row) => <span className="tabular">{row.ordersCount}</span> },
    { key: 'sales', label: 'Ventes', render: (row) => <span className="tabular">{row.salesCount}</span> },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow={B.branch.name}
        title="Clients de la filiale"
        description={
          B.branch.customerMode === 'all'
            ? 'Tous les clients du magasin peuvent acheter à cette filiale. Partager un client le garde dans la liste même si la filiale passe en « clients choisis ».'
            : 'Seuls les clients partagés ici sont proposés dans les commandes et les ventes de la filiale.'
        }
      />
      <BrickTabs scope={scope} onScopeChange={setScope} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="input input-bordered flex min-h-11 w-full items-center gap-2 sm:max-w-sm">
          <span className="sr-only">Rechercher un client</span>
          <input
            type="search"
            className="grow"
            placeholder="Nom ou téléphone"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={`btn min-h-11 ${onlyShared ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
          aria-pressed={onlyShared}
          onClick={() => setOnlyShared((v) => !v)}
        >
          Seulement les clients partagés
        </button>
      </div>

      {isLoading && rows.length === 0 ? (
        <SkeletonTable rows={6} cols={4} />
      ) : error ? (
        <ErrorState title="Clients indisponibles" description={error} onRetry={() => setReloadToken((t) => t + 1)} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aucun client"
          description={onlyShared ? 'Aucun client n’est encore partagé avec cette filiale.' : 'Aucun client ne correspond à la recherche.'}
          action={
            onlyShared ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setOnlyShared(false)}>
                Voir tous les clients
              </button>
            ) : (
              <Link href="/clients" className="btn btn-primary min-h-11">
                Ouvrir les clients
              </Link>
            )
          }
        />
      ) : (
        <ResponsiveTable
          columns={columns}
          data={rows}
          getRowKey={(row) => row.customerId}
          actions={
            canShare
              ? (row) => (
                  <button
                    type="button"
                    className={`btn btn-sm min-h-11 ${row.shared ? 'btn-ghost border border-base-300' : 'btn-primary'}`}
                    disabled={busyId === row.customerId}
                    onClick={() => void toggle(row)}
                  >
                    {row.shared ? 'Retirer le partage' : 'Partager'}
                  </button>
                )
              : undefined
          }
        />
      )}
    </div>
  );
}
