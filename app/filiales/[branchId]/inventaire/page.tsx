'use client';

/**
 * Inventaire d'une filiale de production (README §31.6).
 *
 * Un inventaire de filiale porte sur **ses modèles actifs du magasin et les
 * matières de leur nomenclature**. Il suit exactement le circuit des
 * inventaires (`lib/inventories.ts`) : comptage sur la feuille
 * `/inventaires/[id]`, justification obligatoire de chaque écart, validation
 * par une personne habilitée qui crée les ajustements de stock, rapport
 * exportable. Un seul inventaire ouvert par magasin, filiales comprises.
 *
 * ⚠️ `lib/inventories.ts` est un module serveur : `import type` uniquement.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { EmptyState, ErrorState, FormField, MoneyText, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { BrickTabs, useBrickScope } from '@/components/briqueterie/brick-tabs';
import { useBranch } from '@/components/filiales/branch-context';
import { PageHeader } from '@/components/page-header';
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

export default function BranchInventoryPage() {
  const router = useRouter();
  const { branch, api, writable, canLevel } = useBranch();
  const canManage = usePermission('inventory.manage') && writable && canLevel('edit');
  const { scope, setScope, withStore, showStore } = useBrickScope();

  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<InventoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [notes, setNotes] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), status: status || 'all' });
      const response = await fetch(withStore(api(`/inventaires?${query}`)), { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(await readApiError(response, 'Les inventaires n’ont pas pu être chargés.'));
      const json = await response.json();
      setRows(json.data ?? []);
      setTotal(Number(json.total ?? 0));
      setTotalPages(Number(json.totalPages ?? 1));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Les inventaires n’ont pas pu être chargés.');
    } finally {
      setIsLoading(false);
    }
  }, [api, page, status, withStore]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openInventory() {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const response = await fetch(api('/inventaires'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ notes: notes.trim() || null }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'L’inventaire n’a pas pu être ouvert.'));
      const json = await response.json();
      toast.success(`Inventaire ${json.inventory.reference} ouvert : ${formatNumber(json.items.length)} produit(s) à compter.`);
      setShowNew(false);
      setNotes('');
      router.push(`/inventaires/${json.inventory.id}`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'L’inventaire n’a pas pu être ouvert.', { autoClose: 8000 });
    } finally {
      setIsCreating(false);
    }
  }

  const openOne = rows.find((row) => row.status === 'open');
  const validated = rows.filter((row) => row.status === 'validated');

  const columns: Column<InventoryRecord>[] = [
    { key: 'date', label: 'Ouvert le', render: (row) => formatDateShort(row.createdAt) },
    { key: 'reference', label: 'Inventaire', primary: true, render: (row) => <span className="font-semibold">{row.reference}</span> },
    ...(showStore ? [{ key: 'store', label: 'Magasin', render: (row: InventoryRecord) => row.storeName }] : []),
    { key: 'status', label: 'Statut', render: (row) => <InventoryStatusBadge status={row.status} /> },
    {
      key: 'progress',
      label: 'Comptés',
      className: 'text-right',
      render: (row) => (
        <span className="tabular">
          {formatNumber(row.countedCount)} / {formatNumber(row.itemCount)}
        </span>
      ),
    },
    { key: 'gaps', label: 'Écarts', className: 'text-right', render: (row) => <span className="tabular">{formatNumber(row.discrepancyCount)}</span> },
    {
      key: 'value',
      label: 'Valeur des écarts',
      className: 'text-right',
      hideOnMobile: true,
      render: (row) => <MoneyText value={row.discrepancyValue} colored />,
    },
    { key: 'by', label: 'Validé par', hideOnMobile: true, render: (row) => row.validatedByName ?? '—' },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow={branch.name}
        title="Inventaire"
        description="Comptage du stock réel des modèles de la filiale et des matières de leurs nomenclatures. Chaque écart se justifie ; la validation crée les ajustements de stock et l’écart reste visible dans l’historique."
        actions={
          <>
            {canManage && (
          <button type="button" className="btn btn-primary min-h-11" onClick={() => setShowNew(true)} disabled={Boolean(openOne)}>
            Ouvrir un inventaire
          </button>
        )}
          </>
        }
      />
      <BrickTabs
        scope={scope}
        onScopeChange={(value) => {
          setScope(value);
          setPage(1);
        }}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCardDelta
          label="Inventaire en cours"
          tone={openOne ? 'warning' : 'success'}
          value={openOne ? openOne.reference : 'Aucun'}
          tooltip="Inventaire de la filiale ouvert et pas encore validé. Un seul inventaire peut être ouvert à la fois dans un magasin."
        />
        <StatCardDelta
          label="Inventaires validés"
          tone="info"
          value={formatNumber(validated.length)}
          tooltip="Inventaires de cette page déjà validés : leurs écarts ont été appliqués au stock par des ajustements signés."
        />
        <StatCardDelta
          label="Écarts constatés"
          tone="primary"
          value={<MoneyText value={validated.reduce((sum, row) => sum + row.discrepancyValue, 0)} colored />}
          tooltip="Valeur au prix d’achat des écarts des inventaires validés de cette page (négatif = perte, casse ou vol ; positif = surplus)."
        />
      </div>

      <DataToolbar
        filters={
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
        }
      />

      {isLoading ? (
        <SkeletonTable rows={5} cols={6} />
      ) : error ? (
        <ErrorState title="Inventaires indisponibles" description={error} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aucun inventaire"
          description={`Aucun inventaire de la filiale « ${branch.name} » dans cette portée.`}
          action={
            canManage ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={() => setShowNew(true)}>
                Ouvrir le premier inventaire
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={columns}
            data={rows}
            getRowKey={(row) => row.id}
            onRowClick={(row) => router.push(`/inventaires/${row.id}`)}
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/60">{formatNumber(total)} inventaire(s)</p>
        </>
      )}

      <Modal
        isOpen={showNew}
        onClose={() => setShowNew(false)}
        title={`Ouvrir un inventaire — ${branch.name}`}
        footer={
          <>
            <button type="button" className="btn btn-ghost min-h-11" onClick={() => setShowNew(false)} disabled={isCreating}>
              Annuler
            </button>
            <button type="button" className="btn btn-primary min-h-11" onClick={() => void openInventory()} disabled={isCreating}>
              {isCreating ? 'Ouverture…' : 'Ouvrir et compter'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-base-content/70">
            La feuille de comptage reprend les modèles actifs de la filiale dans le magasin actif et les matières de leurs
            nomenclatures. Le stock théorique de chaque ligne est relevé au moment où vous saisissez son comptage.
          </p>
          <FormField label="Observation" htmlFor="branch-inventory-notes">
            <textarea
              id="branch-inventory-notes"
              className="textarea textarea-bordered w-full"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={isCreating}
            />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
