'use client';

/**
 * Liste des magasins (cahier des charges §4, §6 ; guide multi-magasins §6.14).
 *
 * Tableau **comparatif** : une ligne par établissement avec ses indicateurs de
 * la période, et une ligne de total. Les indicateurs sont calculés par l'API
 * magasin par magasin (`getStoreIndicators`) : la comparaison ne mélange jamais
 * les données de deux magasins.
 *
 * Création réservée au siège (`stores.manage` + poste siège ou autonome) : sur
 * un poste de magasin, le serveur renvoie 403 et le bouton est masqué.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  EmptyState,
  ErrorState,
  MoneyText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import {
  StoreFormModal,
  StoreKindBadge,
  StoreStatusBadge,
  readApiError,
  type StoreIndicators,
  type StoreRecord,
} from '@/components/magasins/store-ui';
import { formatCurrency, formatNumber } from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';

type Period = 'day' | 'week' | 'month' | 'year';
type StoreWithIndicators = StoreRecord & { indicators: StoreIndicators };

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'day', label: 'Aujourd’hui' },
  { value: 'week', label: 'Cette semaine' },
  { value: 'month', label: 'Ce mois' },
  { value: 'year', label: 'Cette année' },
];

const isPeriod = (value: string): value is Period => PERIOD_OPTIONS.some((o) => o.value === value);

const EMPTY_INDICATORS: StoreIndicators = {
  revenue: 0,
  salesCount: 0,
  averageBasket: 0,
  purchases: 0,
  expenses: 0,
  collected: 0,
  receivables: 0,
  payables: 0,
  stockValue: 0,
  lowStock: 0,
  users: 0,
};

export default function MagasinsPage() {
  const router = useRouter();
  const { device, allStores } = useAuth();
  const canManage = usePermission('stores.manage');
  // Les magasins sont une donnée centrale : modifiables au siège uniquement.
  const canCreate = canManage && device?.mode !== 'store';

  const [period, setPeriod] = useState<Period>('month');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<StoreWithIndicators[]>([]);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ indicators: 'true', period });
      if (includeArchived) params.set('includeArchived', 'true');
      const response = await fetch(`/api/magasins?${params}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Les magasins n’ont pas pu être chargés.'));
      const payload = await response.json();
      setRows(Array.isArray(payload.data) ? payload.data : []);
      setRange(payload.period ? { from: payload.period.from, to: payload.period.to } : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Les magasins n’ont pas pu être chargés.');
    } finally {
      setIsLoading(false);
    }
  }, [period, includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((s) =>
      [s.code, s.name, s.address ?? '', s.managerName ?? ''].some((v) => v.toLowerCase().includes(term)),
    );
  }, [rows, search]);

  /** Total du réseau : somme des magasins affichés (archivés compris s'ils sont affichés). */
  const totals = useMemo(() => {
    const sum = filtered.reduce<StoreIndicators>(
      (acc, s) => {
        const i = s.indicators ?? EMPTY_INDICATORS;
        return {
          revenue: acc.revenue + i.revenue,
          salesCount: acc.salesCount + i.salesCount,
          averageBasket: 0,
          purchases: acc.purchases + i.purchases,
          expenses: acc.expenses + i.expenses,
          collected: acc.collected + i.collected,
          receivables: acc.receivables + i.receivables,
          payables: acc.payables + i.payables,
          stockValue: acc.stockValue + i.stockValue,
          lowStock: acc.lowStock + i.lowStock,
          users: acc.users + i.users,
        };
      },
      { ...EMPTY_INDICATORS },
    );
    sum.averageBasket = sum.salesCount > 0 ? Math.round(sum.revenue / sum.salesCount) : 0;
    return sum;
  }, [filtered]);

  const activeCount = rows.filter((s) => s.status === 'active').length;
  const suspendedCount = rows.filter((s) => s.status === 'suspended').length;

  const columns: Column<StoreWithIndicators>[] = [
    {
      key: 'name',
      label: 'Magasin',
      primary: true,
      render: (s) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-base-content/60">{s.code}</span>
            <span className="font-medium">{s.name}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/55">
            <StoreKindBadge kind={s.kind} />
            {s.managerName && <span>Gérant : {s.managerName}</span>}
          </div>
        </div>
      ),
    },
    { key: 'status', label: 'Statut', render: (s) => <StoreStatusBadge status={s.status} /> },
    {
      key: 'revenue',
      label: 'Chiffre d’affaires',
      className: 'text-right',
      render: (s) => <MoneyText value={s.indicators?.revenue} bold />,
    },
    {
      key: 'sales',
      label: 'Ventes',
      className: 'text-right',
      render: (s) => <span className="tabular">{formatNumber(s.indicators?.salesCount ?? 0)}</span>,
    },
    {
      key: 'expenses',
      label: 'Dépenses',
      className: 'text-right',
      hideOnMobile: true,
      render: (s) => <MoneyText value={s.indicators?.expenses} />,
    },
    {
      key: 'receivables',
      label: 'Créances',
      className: 'text-right',
      render: (s) => <MoneyText value={s.indicators?.receivables} remaining />,
    },
    {
      key: 'stock',
      label: 'Valeur du stock',
      className: 'text-right',
      hideOnMobile: true,
      render: (s) => <MoneyText value={s.indicators?.stockValue} />,
    },
    {
      key: 'alerts',
      label: 'Alertes stock',
      className: 'text-right',
      hideOnMobile: true,
      render: (s) =>
        (s.indicators?.lowStock ?? 0) > 0 ? (
          <span className="tabular font-semibold text-warning">
            {formatNumber(s.indicators.lowStock)} produit(s)
          </span>
        ) : (
          <span className="text-base-content/45">Aucune</span>
        ),
    },
  ];

  const periodLabel = PERIOD_OPTIONS.find((o) => o.value === period)?.label ?? '';

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Magasins"
        description="Établissements du réseau : statut, gérant, et comparaison de leurs indicateurs sur la période."
        actions={
          canCreate ? (
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              onClick={() => setShowForm(true)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Nouveau magasin
            </button>
          ) : null
        }
      />

      {canManage && device?.mode === 'store' && (
        <div className="alert border border-info/30 bg-info/10 text-sm">
          <span>
            Les magasins sont gérés au siège : ce poste de magasin les affiche en consultation.
          </span>
        </div>
      )}

      {isLoading && rows.length === 0 ? (
        <SkeletonCards count={4} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCardDelta
            label="Magasins actifs"
            tooltip="Nombre d’établissements ouverts qui peuvent enregistrer des ventes, des achats et des opérations de caisse. Un magasin suspendu reste visible mais ne peut plus rien enregistrer."
            value={formatNumber(activeCount)}
            hint={suspendedCount > 0 ? `${formatNumber(suspendedCount)} suspendu(s)` : 'Aucun magasin suspendu'}
          />
          <StatCardDelta
            label={`Chiffre d’affaires — ${periodLabel.toLowerCase()}`}
            tooltip="Total des ventes validées de tous les magasins affichés sur la période choisie, qu’elles soient payées ou non. Les ventes annulées et les brouillons ne comptent pas."
            value={<MoneyText value={totals.revenue} />}
            hint={`${formatNumber(totals.salesCount)} vente(s), panier moyen ${formatCurrency(totals.averageBasket)}`}
          />
          <StatCardDelta
            label="Créances clients"
            tooltip="Argent que les clients doivent encore aux magasins affichés : la partie non payée des factures en cours, à la date d’aujourd’hui."
            value={<MoneyText value={totals.receivables} remaining />}
            hint="Reste à encaisser sur les factures actives"
          />
          <StatCardDelta
            label="Valeur du stock"
            tooltip="Ce que vaut la marchandise présente dans les magasins affichés, calculée avec le prix d’achat de chaque produit. Le chiffre est celui d’aujourd’hui, quelle que soit la période choisie."
            value={<MoneyText value={totals.stockValue} />}
            hint={`${formatNumber(totals.lowStock)} alerte(s) de stock`}
          />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Rechercher un code, un nom, un gérant…"
        filters={
          <div className="w-full sm:w-52">
            <FilterSelect
              value={period}
              onChange={(value) => setPeriod(isPeriod(value) ? value : 'month')}
              options={PERIOD_OPTIONS}
              placeholder="Ce mois"
            />
          </div>
        }
        actions={
          allStores ? (
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              Afficher les archivés
            </label>
          ) : null
        }
      />

      {range && (
        <p className="text-xs text-base-content/55">
          Période : du {formatDateShort(range.from)} au {formatDateShort(range.to)}. Les créances et la
          valeur du stock sont celles du jour.
        </p>
      )}

      {error ? (
        <ErrorState description={error} onRetry={() => void load()} />
      ) : isLoading && rows.length === 0 ? (
        <SkeletonTable rows={4} cols={8} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aucun magasin"
          description="Créez le premier établissement du réseau."
        />
      ) : (
        <div className="surface-card border border-base-200 bg-base-100 p-2 shadow-sm sm:p-0">
          <ResponsiveTable
            columns={columns}
            data={filtered}
            getRowKey={(s) => s.id}
            onRowClick={(s) => router.push(`/magasins/${s.id}`)}
            emptyMessage="Aucun magasin ne correspond à la recherche."
          />
          {filtered.length > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-200 px-4 py-3 text-sm">
              <span className="font-semibold">Total réseau ({formatNumber(filtered.length)} magasins)</span>
              <span className="flex flex-wrap gap-x-5 gap-y-1">
                <span>
                  CA <MoneyText value={totals.revenue} bold />
                </span>
                <span>
                  Dépenses <MoneyText value={totals.expenses} />
                </span>
                <span>
                  Créances <MoneyText value={totals.receivables} remaining />
                </span>
                <span>
                  Stock <MoneyText value={totals.stockValue} />
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      <StoreFormModal
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        onSaved={(store) => {
          setShowForm(false);
          toast.success(`Magasin ${store.code} créé`);
          router.push(`/magasins/${store.id}`);
        }}
      />
    </div>
  );
}
