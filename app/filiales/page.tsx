'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  EmptyState,
  ErrorState,
  MoneyText,
  PageSection,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { IconAction, RowActions } from '@/components/row-actions';
import { StoreScopeSelect, useStoreScope } from '@/components/store-scope';
import { usePermission } from '@/components/role-gate';
import { readApiError } from '@/components/workers/workers-modals';
import { BranchFormModal, BranchStatusDialog, BranchUsersModal } from '@/components/filiales/branch-admin';
import {
  BRANCH_ACTIVITY_LABELS,
  BRANCH_STATUS_LABELS,
  branchColorClasses,
  type BranchStatus,
  type ProductionBranch,
} from '@/lib/branches-shared';
import { formatNumber, startOfMonth, today } from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';

/**
 * Filiales de production (README §31) — page générale :
 *
 *  1. **Vue consolidée de la direction** : une ligne par filiale autorisée
 *     (ventes, encaissé, reste à encaisser, coût de production, marge, stock,
 *     commandes en cours), filtrable par période, magasins et filiales.
 *  2. **Administration** (siège, `brick.branches`) : créer, renommer, régler
 *     les étapes et les numéros, choisir les comptes et les clients, suspendre
 *     ou archiver. Les filiales actives ont aussi leur lien direct dans le menu.
 */

type OverviewRow = {
  branchId: number;
  name: string;
  color: ProductionBranch['color'];
  status: BranchStatus;
  unit: string;
  revenue: number;
  salesCount: number;
  collected: number;
  outstanding: number;
  productionCost: number | null;
  margin: number | null;
  producedQuantity: number;
  lossQuantity: number;
  productionsCount: number;
  openOrders: number;
  stockSaleValue: number;
  lowStockCount: number;
};

type Overview = {
  from: string;
  to: string;
  data: OverviewRow[];
  totals: {
    revenue: number;
    collected: number;
    outstanding: number;
    productionCost: number | null;
    margin: number | null;
    stockSaleValue: number;
    openOrders: number;
  };
  branches: { id: number; name: string; status: BranchStatus; color: ProductionBranch['color'] }[];
};

function BranchDot({ color }: { color: string }) {
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${branchColorClasses(color).dot}`} />;
}

const STATUS_TONES: Record<BranchStatus, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  suspended: 'warning',
  archived: 'neutral',
};

export default function FilialesPage() {
  const canView = usePermission('brick.view');
  const canManage = usePermission('brick.branches');
  const { scope, setScope, param } = useStoreScope('filiales-synthese');
  const [from, setFrom] = useState(startOfMonth(today()));
  const [to, setTo] = useState(today());
  const [selected, setSelected] = useState<number[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [isOverviewLoading, setIsOverviewLoading] = useState(true);

  const [branches, setBranches] = useState<ProductionBranch[]>([]);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [isBranchesLoading, setIsBranchesLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProductionBranch | null>(null);
  const [usersBranch, setUsersBranch] = useState<ProductionBranch | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ branch: ProductionBranch; status: BranchStatus } | null>(null);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  useEffect(() => {
    if (!canView) {
      setIsOverviewLoading(false);
      return;
    }
    const controller = new AbortController();
    setIsOverviewLoading(true);
    setOverviewError(null);
    const params = new URLSearchParams({ from, to });
    if (selected.length) params.set('branches', selected.join(','));
    if (param) params.set('store', param);
    fetch(`/api/filiales/synthese?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'La vue consolidée n’a pas pu être chargée.'));
        setOverview((await response.json()) as Overview);
      })
      .catch((caught) => {
        if (caught?.name === 'AbortError') return;
        setOverviewError(caught instanceof Error ? caught.message : 'La vue consolidée n’a pas pu être chargée.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsOverviewLoading(false);
      });
    return () => controller.abort();
  }, [canView, from, to, selected, param, reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    setIsBranchesLoading(true);
    setBranchesError(null);
    fetch(canManage ? '/api/filiales?all=true' : '/api/filiales', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Les filiales n’ont pas pu être chargées.'));
        setBranches(((await response.json()) as { data: ProductionBranch[] }).data ?? []);
      })
      .catch((caught) => {
        if (caught?.name === 'AbortError') return;
        setBranchesError(caught instanceof Error ? caught.message : 'Les filiales n’ont pas pu être chargées.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsBranchesLoading(false);
      });
    return () => controller.abort();
  }, [canManage, reloadToken]);

  /** Le menu latéral relit ses liens de filiales après une modification. */
  const afterChange = useCallback(() => {
    reload();
    window.dispatchEvent(new Event('pd:branches-changed'));
  }, [reload]);

  const withCosts = overview?.totals.margin !== null && overview?.totals.margin !== undefined;

  const overviewColumns: Column<OverviewRow>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Filiale',
        primary: true,
        render: (row) => (
          <Link href={`/filiales/${row.branchId}`} className="link link-hover flex items-center gap-2 font-medium">
            <BranchDot color={row.color} />
            {row.name}
            {row.status !== 'active' && <Badge tone={STATUS_TONES[row.status]}>{BRANCH_STATUS_LABELS[row.status]}</Badge>}
          </Link>
        ),
      },
      { key: 'revenue', label: 'Ventes', className: 'text-right', render: (row) => <MoneyText value={row.revenue} bold /> },
      { key: 'collected', label: 'Encaissé', className: 'text-right', hideOnMobile: true, render: (row) => <MoneyText value={row.collected} /> },
      {
        key: 'outstanding',
        label: 'Reste à encaisser',
        className: 'text-right',
        render: (row) => <MoneyText value={row.outstanding} remaining />,
      },
      ...(withCosts
        ? ([
            {
              key: 'cost',
              label: 'Coût de production',
              className: 'text-right',
              hideOnMobile: true,
              render: (row: OverviewRow) => <MoneyText value={row.productionCost ?? 0} />,
            },
            {
              key: 'margin',
              label: 'Marge',
              className: 'text-right',
              render: (row: OverviewRow) => <MoneyText value={row.margin ?? 0} colored bold />,
            },
          ] as Column<OverviewRow>[])
        : []),
      {
        key: 'produced',
        label: 'Produit',
        hideOnMobile: true,
        render: (row) => (
          <span className="tabular text-sm">
            {formatNumber(row.producedQuantity)} {row.unit}
            <span className="block text-xs text-base-content/60">{row.productionsCount} production(s)</span>
          </span>
        ),
      },
      { key: 'orders', label: 'Commandes en cours', hideOnMobile: true, render: (row) => <span className="tabular">{row.openOrders}</span> },
      {
        key: 'stock',
        label: 'Stock (prix de vente)',
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => (
          <div className="text-right">
            <MoneyText value={row.stockSaleValue} />
            {row.lowStockCount > 0 && <div className="text-xs text-warning">{row.lowStockCount} modèle(s) sous le seuil</div>}
          </div>
        ),
      },
    ],
    [withCosts],
  );

  const adminColumns: Column<ProductionBranch>[] = [
    {
      key: 'name',
      label: 'Filiale',
      primary: true,
      render: (branch) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            <BranchDot color={branch.color} />
            {branch.name}
          </div>
          <div className="text-xs text-base-content/60">
            {BRANCH_ACTIVITY_LABELS[branch.activity]} · {branch.storeName ?? 'tous les magasins'}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Statut',
      render: (branch) => <Badge tone={STATUS_TONES[branch.status]}>{BRANCH_STATUS_LABELS[branch.status]}</Badge>,
    },
    {
      key: 'stages',
      label: 'Étapes',
      hideOnMobile: true,
      render: (branch) => <span className="text-sm">{branch.flow.map((s) => s.label).join(' → ')}</span>,
    },
    {
      key: 'numbers',
      label: 'Numéros',
      hideOnMobile: true,
      render: (branch) => (
        <span className="font-mono text-xs">
          {branch.batchPrefix} · {branch.orderPrefix}
        </span>
      ),
    },
    {
      key: 'access',
      label: 'Accès',
      hideOnMobile: true,
      render: (branch) => (
        <span className="text-xs">
          {branch.accessMode === 'all' ? 'Tous les comptes habilités' : `${branch.usersCount ?? 0} compte(s) choisi(s)`}
          <br />
          {branch.customerMode === 'all' ? 'Tous les clients' : `${branch.customersCount ?? 0} client(s) partagé(s)`}
        </span>
      ),
    },
    {
      key: 'activity',
      label: 'Activité',
      hideOnMobile: true,
      render: (branch) => (
        <span className="text-xs">
          {branch.modelsCount ?? 0} modèle(s) · {branch.productionsCount ?? 0} production(s) · {branch.ordersCount ?? 0} commande(s)
        </span>
      ),
    },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Fabrication"
        title="Filiales de production"
        description="Briqueterie, vitrerie, meubles… : chaque filiale a son espace (tableau de bord, modèles, productions, stock, commandes, ventes, rapports) et son lien dans le menu."
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
              Nouvelle filiale
            </button>
          ) : undefined
        }
      />

      {canView && (
        <PageSection
          title="Vue consolidée"
          subtitle={
            overview ? `Du ${formatDateShort(overview.from)} au ${formatDateShort(overview.to)} — ventes et productions de la période ; reste à encaisser toutes dates.` : undefined
          }
        >
          <div className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="grid grid-cols-2 gap-3 sm:w-96">
                <label className="text-sm">
                  <span className="mb-1 block text-base-content/70">Du</span>
                  <DatePicker value={from} onChange={(value) => value && setFrom(value)} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-base-content/70">Au</span>
                  <DatePicker value={to} onChange={(value) => value && setTo(value)} />
                </label>
              </div>
              <StoreScopeSelect value={scope} onChange={setScope} className="min-h-11 w-full sm:w-56" />
              {overview && overview.branches.length > 1 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Filiales comparées">
                  {overview.branches.map((branch) => {
                    const on = selected.length === 0 || selected.includes(branch.id);
                    return (
                      <button
                        key={branch.id}
                        type="button"
                        aria-pressed={on}
                        className={`btn btn-sm min-h-11 gap-2 ${on ? 'btn-outline' : 'btn-ghost text-base-content/50'}`}
                        onClick={() =>
                          setSelected((current) => {
                            const base = current.length === 0 ? overview.branches.map((b) => b.id) : current;
                            const next = base.includes(branch.id) ? base.filter((id) => id !== branch.id) : [...base, branch.id];
                            return next.length === overview.branches.length || next.length === 0 ? [] : next;
                          })
                        }
                      >
                        <BranchDot color={branch.color} />
                        {branch.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {isOverviewLoading && !overview ? (
              <SkeletonCards count={4} />
            ) : overviewError ? (
              <ErrorState title="Vue consolidée indisponible" description={overviewError} onRetry={reload} />
            ) : overview ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <StatCardDelta
                    label="Ventes des filiales"
                    tone="primary"
                    value={<MoneyText value={overview.totals.revenue} bold />}
                    tooltip="Total facturé par les ventes validées des filiales affichées, sur la période choisie. Les brouillons et les ventes annulées ne comptent pas."
                  />
                  <StatCardDelta
                    label="Reste à encaisser"
                    tone="warning"
                    value={<MoneyText value={overview.totals.outstanding} remaining />}
                    tooltip="Ce que les clients doivent encore sur les ventes des filiales, toutes dates confondues : un dû de l’an dernier reste un dû."
                  />
                  {overview.totals.margin !== null ? (
                    <StatCardDelta
                      label="Marge sur production"
                      tone="success"
                      value={<MoneyText value={overview.totals.margin} colored bold />}
                      tooltip="Ventes de la période moins le coût de production des lots de la période (équipe + dépenses rattachées validées). Les dépenses générales des magasins (loyer…) n’y sont pas : elles restent dans le bénéfice de l’entreprise (/soldes)."
                    />
                  ) : (
                    <StatCardDelta
                      label="Commandes en cours"
                      tone="info"
                      value={formatNumber(overview.totals.openOrders)}
                      tooltip="Commandes confirmées, en production ou prêtes, pas encore livrées ni facturées."
                    />
                  )}
                  <StatCardDelta
                    label="Stock valorisé"
                    tone="info"
                    value={<MoneyText value={overview.totals.stockSaleValue} />}
                    tooltip="Stock actuel des modèles actifs, valorisé au prix de vente des produits liés, dans les magasins affichés."
                  />
                </div>
                {overview.data.length === 0 ? (
                  <EmptyState
                    title="Aucune filiale à comparer"
                    description="Aucune filiale ne vous est ouverte pour l’instant."
                    action={
                      canManage ? (
                        <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsFormOpen(true)}>
                          Créer une filiale
                        </button>
                      ) : undefined
                    }
                  />
                ) : (
                  <ResponsiveTable columns={overviewColumns} data={overview.data} getRowKey={(row) => row.branchId} />
                )}
              </>
            ) : null}
          </div>
        </PageSection>
      )}

      <PageSection
        title={canManage ? 'Administration des filiales' : 'Mes filiales'}
        subtitle={
          canManage
            ? 'Une filiale suspendue ou archivée quitte le menu et n’accepte plus d’opération ; rien n’est jamais supprimé.'
            : 'Les filiales qui vous sont ouvertes.'
        }
      >
        {isBranchesLoading && branches.length === 0 ? (
          <SkeletonTable rows={3} cols={5} />
        ) : branchesError ? (
          <ErrorState title="Filiales indisponibles" description={branchesError} onRetry={reload} />
        ) : branches.length === 0 ? (
          <EmptyState
            title="Aucune filiale"
            description="Créez une filiale (Briqueterie, Vitrerie, Meuble…) : elle aura son espace et son lien dans le menu."
            action={
              canManage ? (
                <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsFormOpen(true)}>
                  Créer la première filiale
                </button>
              ) : undefined
            }
          />
        ) : (
          <ResponsiveTable
            columns={adminColumns}
            data={branches}
            getRowKey={(branch) => branch.id}
            actions={(branch) => (
              <RowActions>
                <IconAction icon="view" label={`Ouvrir ${branch.name}`} href={`/filiales/${branch.id}`} />
                {canManage && (
                  <>
                    <IconAction
                      icon="edit"
                      label="Modifier la filiale"
                      onClick={() => {
                        setEditing(branch);
                        setIsFormOpen(true);
                      }}
                    />
                    <IconAction icon="shield" label="Comptes autorisés" onClick={() => setUsersBranch(branch)} />
                    {branch.status === 'active' ? (
                      <IconAction
                        icon="deactivate"
                        tone="danger"
                        label="Suspendre la filiale"
                        onClick={() => setStatusTarget({ branch, status: 'suspended' })}
                      />
                    ) : (
                      <IconAction
                        icon="activate"
                        tone="success"
                        label="Réactiver la filiale"
                        onClick={() => setStatusTarget({ branch, status: 'active' })}
                      />
                    )}
                    {branch.status !== 'archived' && (
                      <IconAction
                        icon="cancel"
                        tone="danger"
                        label="Archiver la filiale"
                        onClick={() => setStatusTarget({ branch, status: 'archived' })}
                      />
                    )}
                  </>
                )}
              </RowActions>
            )}
          />
        )}
      </PageSection>

      <BranchFormModal isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} branch={editing} onSaved={afterChange} />
      <BranchUsersModal isOpen={Boolean(usersBranch)} onClose={() => setUsersBranch(null)} branch={usersBranch} onSaved={afterChange} />
      <BranchStatusDialog
        branch={statusTarget?.branch ?? null}
        target={statusTarget?.status ?? null}
        onClose={() => setStatusTarget(null)}
        onDone={afterChange}
      />
    </div>
  );
}
