'use client';

/**
 * Inventaires physiques par magasin (cahier des charges §7 ; guide §6.16).
 *
 * Ouverture → comptage → validation : à la validation, chaque écart **justifié**
 * devient un ajustement de stock (`lib/inventories.ts`). Un seul inventaire
 * ouvert à la fois par magasin ; il s'ouvre toujours dans le magasin actif.
 *
 * ⚠️ `lib/inventories.ts` est un module serveur : `import type` uniquement.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { Modal } from '@/components/modal';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  FormField,
  MoneyText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { StoreScopeSelect, useStoreScope } from '@/components/store-scope';
import {
  INVENTORY_STATUS,
  InventoryStatusBadge,
  readApiError,
  type InventoryRecord,
} from '@/components/inventaires/inventory-ui';
import { formatNumber } from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';

const PAGE_SIZE = 15;

const STATUS_OPTIONS = Object.entries(INVENTORY_STATUS).map(([value, entry]) => ({ value, label: entry.label }));

type Category = { id: number; name: string };

export default function InventairesPage() {
  const router = useRouter();
  const canManage = usePermission('inventory.manage');
  const { activeStore, device } = useAuth();
  const { scope, setScope, apply, isConsolidated } = useStoreScope('inventaires');
  // Poste du siège sur un autre magasin : consultation seule (le serveur refuse l'ouverture).
  const readOnlyStore = device?.mode === 'hq' && activeStore !== null && activeStore.kind !== 'headquarters';

  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<InventoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showNew, setShowNew] = useState(false);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [notes, setNotes] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = apply(new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), status: status || 'all' }));
      const [listResponse, openResponse] = await Promise.all([
        fetch(`/api/inventaires?${params}`, { cache: 'no-store', credentials: 'same-origin' }),
        fetch(`/api/inventaires?${apply(new URLSearchParams({ status: 'open', limit: '1' }))}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        }),
      ]);
      if (!listResponse.ok) throw new Error(await readApiError(listResponse, 'Les inventaires n’ont pas pu être chargés.'));
      const payload = await listResponse.json();
      setRows(payload.data ?? []);
      setTotal(payload.total ?? 0);
      setTotalPages(payload.totalPages ?? 1);
      if (openResponse.ok) setOpenCount((await openResponse.json()).total ?? 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Les inventaires n’ont pas pu être chargés.');
    } finally {
      setIsLoading(false);
    }
  }, [apply, page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const openNewModal = async () => {
    setCategoryId('');
    setNotes('');
    setShowNew(true);
    if (categories === null) {
      try {
        const response = await fetch('/api/produits/categories?limit=200&sort=name', { cache: 'no-store', credentials: 'same-origin' });
        const payload = await response.json();
        setCategories(Array.isArray(payload.data) ? payload.data : []);
      } catch {
        setCategories([]);
      }
    }
  };

  const create = async () => {
    setIsCreating(true);
    try {
      const response = await fetch('/api/inventaires', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ categoryId: categoryId ? Number(categoryId) : null, notes: notes.trim() || null }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'L’inventaire n’a pas pu être ouvert.'));
      const detail = await response.json();
      toast.success(`Inventaire ${detail.inventory.reference} ouvert`);
      router.push(`/inventaires/${detail.inventory.id}`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'L’inventaire n’a pas pu être ouvert.', { autoClose: 9000 });
      setIsCreating(false);
    }
  };

  const columns: Column<InventoryRecord>[] = [
    {
      key: 'date',
      label: 'Date',
      render: (row) => <span className="whitespace-nowrap tabular">{formatDateShort(row.createdAt)}</span>,
    },
    {
      key: 'reference',
      label: 'Référence',
      primary: true,
      render: (row) => (
        <span className="block min-w-0">
          <span className="block font-mono text-sm font-semibold">{row.reference}</span>
          <span className="block text-xs text-base-content/55">{row.categoryName ?? 'Tous les produits'}</span>
        </span>
      ),
    },
    ...(isConsolidated || typeof scope === 'number'
      ? [{ key: 'store', label: 'Magasin', render: (row: InventoryRecord) => <span className="text-sm">{row.storeName}</span> }]
      : []),
    { key: 'status', label: 'Statut', render: (row) => <InventoryStatusBadge status={row.status} /> },
    {
      key: 'progress',
      label: 'Comptés',
      className: 'text-right',
      render: (row) => (
        <span className="tabular text-sm">
          {formatNumber(row.countedCount)} / {formatNumber(row.itemCount)}
        </span>
      ),
    },
    {
      key: 'gaps',
      label: 'Écarts',
      className: 'text-right',
      render: (row) =>
        row.discrepancyCount > 0 ? (
          <span className="block text-right">
            <span className="block tabular text-sm font-medium">{formatNumber(row.discrepancyCount)} produit(s)</span>
            {/* Écart en valeur : négatif = perte, positif = surplus ; le signe et le libellé portent l'information. */}
            <span className={`block text-xs ${row.discrepancyValue < 0 ? 'text-error' : 'text-success'}`}>
              {row.discrepancyValue < 0 ? 'Perte ' : 'Surplus '}
              <MoneyText value={Math.abs(row.discrepancyValue)} />
            </span>
          </span>
        ) : (
          <span className="text-sm text-base-content/50">Aucun</span>
        ),
    },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Gestion"
        title="Inventaires"
        description="Comptage physique du stock d’un magasin : chaque écart justifié corrige le stock à la validation."
        actions={
          canManage && !readOnlyStore ? (
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" onClick={() => void openNewModal()}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Nouvel inventaire
            </button>
          ) : null
        }
      />

      {openCount === null ? (
        <SkeletonCards count={2} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatCardDelta
            label="Comptages en cours"
            value={formatNumber(openCount)}
            tone={openCount > 0 ? 'warning' : 'neutral'}
            hint={openCount > 0 ? 'À terminer puis valider' : 'Aucun inventaire ouvert'}
            tooltip="Inventaires ouverts dans les magasins affichés. Tant qu’un inventaire n’est pas validé, le stock n’est pas corrigé. Un seul inventaire peut être ouvert à la fois par magasin."
          />
          <StatCardDelta
            label="Inventaires affichés"
            value={formatNumber(total)}
            hint={status ? INVENTORY_STATUS[status as keyof typeof INVENTORY_STATUS]?.label : 'Tous les statuts'}
            tooltip="Nombre d’inventaires correspondant aux filtres. Un inventaire validé ne se modifie plus ; un inventaire annulé n’a rien changé au stock."
          />
        </div>
      )}

      <DataToolbar
        filters={
          <>
            <div className="w-full sm:w-56">
              <FilterSelect
                value={status}
                onChange={(value) => {
                  setStatus(value);
                  setPage(1);
                }}
                options={STATUS_OPTIONS}
                placeholder="Tous les statuts"
              />
            </div>
            <StoreScopeSelect
              value={scope}
              onChange={(value) => {
                setScope(value);
                setPage(1);
              }}
              className="min-h-11 w-full sm:w-56"
            />
          </>
        }
      />

      {error ? (
        <Card>
          <ErrorState description={error} onRetry={() => void load()} />
        </Card>
      ) : isLoading && rows.length === 0 ? (
        <SkeletonTable rows={4} cols={6} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Aucun inventaire"
            description="Un inventaire compare le stock réellement présent au stock enregistré, puis corrige les écarts."
            action={
              canManage && !readOnlyStore ? (
                <button type="button" className="btn btn-primary min-h-11" onClick={() => void openNewModal()}>
                  Ouvrir un inventaire
                </button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ResponsiveTable
          columns={columns}
          data={rows}
          getRowKey={(row) => row.id}
          onRowClick={(row) => router.push(`/inventaires/${row.id}`)}
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      <Modal
        isOpen={showNew}
        onClose={() => {
          if (!isCreating) setShowNew(false);
        }}
        title="Nouvel inventaire"
        size="md"
        fullScreenMobile
        footer={
          <div className="flex justify-end gap-3 border-t border-base-200 pt-4">
            <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" disabled={isCreating} onClick={() => setShowNew(false)}>
              Annuler
            </button>
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" disabled={isCreating} onClick={() => void create()}>
              {isCreating ? <span className="loading loading-spinner loading-sm" /> : 'Ouvrir l’inventaire'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-base-content/70">
            L’inventaire s’ouvre dans <strong>{activeStore?.name ?? 'le magasin actif'}</strong>. La liste des
            produits à compter est préparée tout de suite ; vous pourrez compter en plusieurs fois.
          </p>
          <FormField label="Produits à compter" htmlFor="inventory-category" hint="Une catégorie seulement, ou tout le magasin.">
            <select
              id="inventory-category"
              className="select select-bordered min-h-11 w-full"
              value={categoryId}
              disabled={isCreating || categories === null}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Tous les produits</option>
              {(categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Notes" htmlFor="inventory-notes" hint="Facultatif.">
            <textarea
              id="inventory-notes"
              rows={2}
              className="textarea textarea-bordered w-full"
              value={notes}
              disabled={isCreating}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ex. inventaire de fin de mois"
            />
          </FormField>
          <Badge tone="info">Le stock n’est modifié qu’à la validation</Badge>
        </div>
      </Modal>
    </div>
  );
}
