'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { IconAction, RowActions } from '@/components/row-actions';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Badge,
  EmptyState,
  ErrorState,
  MoneyText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { RoleGate, usePermission } from '@/components/role-gate';
import {
  PaySupplierDebtModal,
  SupplierDetailModal,
  SupplierFormModal,
  type SupplierRecord,
} from '@/components/fournisseurs/fournisseurs-modals';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';

/**
 * Liste des fournisseurs (README §7.3).
 *
 * Les cinq états obligatoires sont présents : squelette, vide (avec action),
 * erreur (avec « Réessayer »), nominal (ResponsiveTable + Pagination) et
 * feedback (`toast`). Les dettes ne sont jamais stockées : elles arrivent
 * calculées par l'API (§15).
 *
 * Restauration d'état : le premier fetch est **gaté sur `rehydrated`**, sinon
 * la page 1 serait chargée puis aussitôt remplacée par la page restaurée.
 */

const PAGE_LIMIT = 20;

type SupplierFilter = 'all' | 'debtors' | 'inactive';

type SuppliersSummary = {
  totalSuppliers: number;
  activeSuppliers: number;
  debtorsCount: number;
  totalPayables: number;
  totalPurchased: number;
};

type ViewState = {
  search: string;
  filter: SupplierFilter;
  page: number;
};

const FILTER_OPTIONS = [
  { value: 'debtors', label: 'Avec dette' },
  { value: 'inactive', label: 'Inactifs' },
];

export default function FournisseursPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filter, setFilter] = useState<SupplierFilter>('all');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<SupplierRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [summary, setSummary] = useState<SuppliersSummary | null>(null);
  const [isSummaryError, setIsSummaryError] = useState(false);

  // Une modale = un état booléen, jamais une modale pilotée par une chaîne (§5.3).
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formTarget, setFormTarget] = useState<SupplierRecord | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<SupplierRecord | null>(null);
  const [isPayOpen, setIsPayOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<SupplierRecord | null>(null);
  const [isStatusDialogOpen, setIsStatusDialogOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<SupplierRecord | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canUpdate = usePermission('suppliers.update');
  const canDelete = usePermission('suppliers.delete');
  const canPay = usePermission('payments.create');

  const rehydrated = useViewStateRehydration<ViewState>('fournisseurs', (saved) => {
    if (saved.search !== undefined) setSearch(saved.search);
    if (saved.filter) setFilter(saved.filter);
    if (saved.page) setPage(saved.page);
  });

  /* ── Recherche débouncée (300 ms) ───────────────────────────────── */

  useEffect(() => {
    if (!rehydrated) return;
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [rehydrated, search]);

  /* ── Chargement de la liste ─────────────────────────────────────── */

  const load = useCallback(
    async (signal: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      let clampedAway = false;

      try {
        const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
        if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
        if (filter === 'debtors') params.set('debtors', 'true');
        if (filter === 'inactive') params.set('inactive', 'true');

        const response = await fetch(`/api/fournisseurs?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error ?? 'Chargement des fournisseurs impossible');
        }

        const payload = await response.json();
        const nextTotalPages = Math.max(1, Number(payload.totalPages ?? 1));

        // Une page restaurée a pu devenir hors bornes : on corrige au lieu
        // d'afficher une liste vide (`clampPage`, §5).
        const clamped = clampPage(page, nextTotalPages);
        if (clamped !== null) {
          clampedAway = true;
          setPage(clamped);
          return;
        }

        setRows(Array.isArray(payload.data) ? payload.data : []);
        setTotal(Number(payload.total ?? 0));
        setTotalPages(nextTotalPages);
      } catch (caught: any) {
        if (caught?.name === 'AbortError') return;
        setError(caught?.message ?? 'Une erreur est survenue');
      } finally {
        if (!clampedAway) setIsLoading(false);
      }
    },
    [page, filter, debouncedSearch],
  );

  useEffect(() => {
    if (!rehydrated) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [rehydrated, load, reloadToken]);

  /* ── Cartes de synthèse ─────────────────────────────────────────── */

  useEffect(() => {
    if (!rehydrated) return;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch('/api/fournisseurs/stats', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Synthèse indisponible');
        setSummary(await response.json());
        setIsSummaryError(false);
      } catch (caught: any) {
        if (caught?.name === 'AbortError') return;
        setIsSummaryError(true);
      }
    })();

    return () => controller.abort();
  }, [rehydrated, reloadToken]);

  /* ── Mémorisation de l'état de vue ──────────────────────────────── */

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState<ViewState>('fournisseurs', { search, filter, page });
  }, [rehydrated, search, filter, page]);

  /* ── Actions ────────────────────────────────────────────────────── */

  // La page repart à 1 sur une saisie **utilisateur** ; la réhydratation, elle,
  // passe par `setSearch`/`setFilter` directement et ne touche pas à la page.
  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handleFilterChange = (value: string) => {
    setFilter((value || 'all') as SupplierFilter);
    setPage(1);
  };

  const refresh = () => setReloadToken((token) => token + 1);

  const openCreate = () => {
    setFormTarget(null);
    setIsFormOpen(true);
  };

  const openEdit = (supplier: SupplierRecord) => {
    setFormTarget(supplier);
    setIsFormOpen(true);
  };

  const openDetail = (supplier: SupplierRecord) => {
    setDetailTarget(supplier);
    setIsDetailOpen(true);
  };

  const openPay = (supplier: SupplierRecord) => {
    setPayTarget(supplier);
    setIsPayOpen(true);
  };

  const openStatusDialog = (supplier: SupplierRecord) => {
    setStatusTarget(supplier);
    setIsStatusDialogOpen(true);
  };

  const handleToggleStatus = async () => {
    if (!statusTarget) return;
    const reactivate = !statusTarget.isActive;
    setIsSubmitting(true);

    try {
      const response = await fetch(
        `/api/fournisseurs/${statusTarget.id}${reactivate ? '?reactivate=true' : ''}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Opération impossible');
      }

      toast.success(reactivate ? 'Fournisseur réactivé' : 'Fournisseur désactivé');
      setIsStatusDialogOpen(false);
      setStatusTarget(null);
      refresh();
    } catch (caught: any) {
      toast.error(caught?.message ?? 'Opération impossible');
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ── Colonnes ───────────────────────────────────────────────────── */

  const columns: Column<SupplierRecord>[] = [
    {
      key: 'name',
      label: 'Nom',
      primary: true,
      render: (supplier) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{supplier.name}</span>
          {!supplier.isActive && <Badge tone="neutral">Inactif</Badge>}
        </div>
      ),
    },
    {
      /*
       * La colonne « Téléphone » a été retirée : le numéro reste lisible dans la
       * fiche (« Détail »), et la place gagnée revient aux colonnes chiffrées
       * (Nb achats, Total acheté, Payé, Dette) — c'est le tableau qui sert.
       * La recherche continue de porter sur le téléphone (`lib/suppliers.ts`).
       */
      key: 'purchaseCount',
      label: 'Nb achats',
      hideOnMobile: true,
      render: (supplier) => <span className="tabular">{formatNumber(supplier.purchaseCount)}</span>,
    },
    {
      key: 'totalPurchased',
      label: 'Total acheté',
      render: (supplier) => <MoneyText value={supplier.totalPurchased} />,
    },
    {
      key: 'totalPaid',
      label: 'Payé',
      render: (supplier) => <MoneyText value={supplier.totalPaid} />,
    },
    {
      key: 'balance',
      label: 'Dette',
      render: (supplier) => <MoneyText value={supplier.balance} colored bold />,
    },
    {
      key: 'lastPurchaseDate',
      label: 'Dernier achat',
      hideOnMobile: true,
      render: (supplier) => formatDateShort(supplier.lastPurchaseDate),
    },
  ];

  const isFiltered = Boolean(search.trim()) || filter !== 'all';
  const showSkeleton = isLoading && rows.length === 0 && !error;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Commercial"
        title="Fournisseurs"
        description="Coordonnées, historique des achats et suivi des dettes fournisseurs."
        actions={
          <RoleGate action="suppliers.create">
            <button type="button" onClick={openCreate} className="btn btn-primary min-h-11">
              Nouveau fournisseur
            </button>
          </RoleGate>
        }
      />

      {/* Cartes de synthèse — GET /api/fournisseurs/stats */}
      {isSummaryError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          <span>La synthèse n&apos;a pas pu être chargée.</span>
          <button type="button" onClick={refresh} className="btn btn-ghost btn-sm min-h-11">
            Réessayer
          </button>
        </div>
      ) : !summary ? (
        <SkeletonCards count={3} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCardDelta
            label="Fournisseurs"
            value={formatNumber(summary.activeSuppliers)}
            hint={`${formatNumber(summary.totalSuppliers)} fiche(s) au total`}
            tone="primary"
          />
          <StatCardDelta
            label="Dettes fournisseurs"
            value={<MoneyText value={summary.totalPayables} />}
            hint={`${formatNumber(summary.debtorsCount)} fournisseur(s) concerné(s)`}
            tone="error"
          />
          <StatCardDelta
            label="Total acheté"
            value={<MoneyText value={summary.totalPurchased} />}
            hint="Achats non annulés"
            tone="info"
          />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={handleSearchChange}
        searchPlaceholder="Rechercher un fournisseur (nom, téléphone, adresse)…"
        filters={
          <div className="w-full sm:w-52">
            <FilterSelect
              value={filter === 'all' ? '' : filter}
              onChange={handleFilterChange}
              options={FILTER_OPTIONS}
              placeholder="Tous"
            />
          </div>
        }
        actions={
          <span className="text-xs text-base-content/60">
            {formatNumber(total)} fournisseur(s)
          </span>
        }
      />

      {/* État erreur — jamais un écran blanc */}
      {error && rows.length === 0 ? (
        <ErrorState
          title="Fournisseurs indisponibles"
          description={error}
          onRetry={refresh}
        />
      ) : showSkeleton ? (
        <SkeletonTable rows={6} cols={5} />
      ) : rows.length === 0 ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <EmptyState
            title={isFiltered ? 'Aucun fournisseur ne correspond' : 'Aucun fournisseur'}
            description={
              isFiltered
                ? 'Modifiez la recherche ou le filtre pour élargir la liste.'
                : 'Enregistrez vos fournisseurs pour suivre les achats et les dettes.'
            }
            action={
              isFiltered ? (
                <button
                  type="button"
                  className="btn btn-ghost min-h-11"
                  onClick={() => {
                    setSearch('');
                    setDebouncedSearch('');
                    setFilter('all');
                    setPage(1);
                  }}
                >
                  Réinitialiser les filtres
                </button>
              ) : (
                <RoleGate
                  action="suppliers.create"
                  fallback={
                    <p className="text-sm text-base-content/60">
                      Demandez à un administrateur de créer la première fiche.
                    </p>
                  }
                >
                  <button type="button" onClick={openCreate} className="btn btn-primary min-h-11">
                    Créer le premier fournisseur
                  </button>
                </RoleGate>
              )
            }
          />
        </div>
      ) : (
        <div className={isLoading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <ResponsiveTable
            columns={columns}
            data={rows}
            getRowKey={(supplier) => supplier.id}
            emptyMessage="Aucun fournisseur."
            actions={(supplier) => (
              <RowActions>
                <IconAction
                  icon="view"
                  label="Voir le détail du fournisseur"
                  onClick={() => openDetail(supplier)}
                />
                {canUpdate && (
                  <IconAction
                    icon="edit"
                    label="Modifier le fournisseur"
                    onClick={() => openEdit(supplier)}
                  />
                )}
                {canPay && supplier.balance > 0.001 && (
                  <IconAction
                    icon="pay"
                    tone="primary"
                    label="Payer une dette fournisseur"
                    onClick={() => openPay(supplier)}
                  />
                )}
                {canDelete &&
                  (supplier.isActive ? (
                    <IconAction
                      icon="deactivate"
                      tone="danger"
                      label="Désactiver le fournisseur"
                      onClick={() => openStatusDialog(supplier)}
                    />
                  ) : (
                    <IconAction
                      icon="activate"
                      tone="success"
                      label="Réactiver le fournisseur"
                      onClick={() => openStatusDialog(supplier)}
                    />
                  ))}
              </RowActions>
            )}
          />
        </div>
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Modales — une par état booléen */}
      <SupplierFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        supplier={formTarget}
        onSaved={refresh}
      />

      <SupplierDetailModal
        isOpen={isDetailOpen}
        onClose={() => setIsDetailOpen(false)}
        supplierId={detailTarget?.id ?? null}
      />

      <PaySupplierDebtModal
        isOpen={isPayOpen}
        onClose={() => setIsPayOpen(false)}
        supplierId={payTarget?.id ?? null}
        supplierName={payTarget?.name}
        onPaid={refresh}
      />

      <ConfirmDialog
        isOpen={isStatusDialogOpen}
        onClose={() => setIsStatusDialogOpen(false)}
        onConfirm={handleToggleStatus}
        isSubmitting={isSubmitting}
        tone={statusTarget?.isActive ? 'error' : 'success'}
        title={statusTarget?.isActive ? 'Désactiver le fournisseur' : 'Réactiver le fournisseur'}
        confirmLabel={statusTarget?.isActive ? 'Désactiver' : 'Réactiver'}
        message={
          statusTarget?.isActive ? (
            <>
              <strong>{statusTarget?.name}</strong> ne sera plus proposé dans les nouveaux achats.
              La fiche n&apos;est <strong>pas supprimée</strong> : son historique d&apos;achats et ses
              dettes restent consultables, et elle peut être réactivée à tout moment.
            </>
          ) : (
            <>
              <strong>{statusTarget?.name}</strong> redeviendra disponible dans les nouveaux achats.
            </>
          )
        }
      />
    </div>
  );
}
