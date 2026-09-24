'use client';

/**
 * Liste des clients (README §7.2, CONVENTIONS §5).
 *
 * Ordre imposé : `PageHeader` → cartes de synthèse → `DataToolbar` →
 * `ResponsiveTable` → `Pagination` → modales (une par état booléen).
 *
 * Les agrégats (ventes, total acheté, payé, solde) sont calculés par l'API
 * depuis les factures et les paiements : rien n'est stocké (README §15).
 *
 * Cas particulier de pagination : le filtre « Inactifs » n'existe pas côté API
 * (`GET /api/clients` ne sait filtrer que « débiteurs » et « inactifs inclus »).
 * Dans ce cas seulement, la page charge l'ensemble (`limit=500`) et pagine en
 * mémoire — le résultat est identique, et le contrat d'URL reste respecté.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import {
  EmptyState,
  ErrorState,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { ClientsTable } from '@/components/clients/clients-table';
import {
  CustomerDetailModal,
  CustomerFormModal,
  DeactivateCustomerDialog,
  PaymentModal,
  readApiError,
  type CustomerRecord,
  type CustomerStatsRecord,
} from '@/components/clients/clients-modals';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatNumber } from '@/lib/format';

const PAGE_LIMIT = 10;
const VIEW_NAME = 'clients';
/** Plafond de l'API (`lib/customers.ts`) pour la pagination en mémoire. */
const FETCH_ALL_LIMIT = 500;

type StatusFilter = 'all' | 'debtors' | 'inactive';
/**
 * Tris de la liste. `recent` (défaut) = **dernier client enregistré en
 * premier** : c'est la règle de toutes les listes de l'application
 * (`lib/list-sort.ts`).
 */
type SortOrder = 'recent' | 'name' | 'balance';

type CustomersSummary = {
  totalCustomers: number;
  activeCustomers: number;
  debtorsCount: number;
  totalReceivables: number;
  totalInvoiced: number;
};

type ViewState = {
  search: string;
  statusFilter: StatusFilter;
  page: number;
  sortOrder: SortOrder;
};

/**
 * Choix de tri **autres que le défaut**.
 *
 * Le défaut (« dernière insertion ») est porté par le `placeholder` du
 * `FilterSelect`, qui est rendu comme une option à valeur vide. Le remettre
 * dans la liste afficherait **deux fois le même libellé** dans le menu — donc
 * la valeur du filtre est ramenée à `''` quand on est sur le tri par défaut
 * (voir `value={sortOrder === 'recent' ? '' : sortOrder}` plus bas).
 */
const SORT_OPTIONS = [
  { value: 'name', label: 'Tri : nom (A→Z)' },
  { value: 'balance', label: 'Tri : solde décroissant' },
];

/** Statut : même patron que les autres écrans de liste (`all` = défaut). */
const STATUS_OPTIONS = [
  { value: 'all', label: 'Tous les clients' },
  { value: 'debtors', label: 'Débiteurs' },
  { value: 'inactive', label: 'Inactifs' },
];

function isStatusFilter(value: unknown): value is StatusFilter {
  return value === 'all' || value === 'debtors' || value === 'inactive';
}

function isSortOrder(value: unknown): value is SortOrder {
  return value === 'recent' || value === 'name' || value === 'balance';
}

/** Échappement CSV : un nom contenant `;` ou `"` ne doit pas casser le fichier. */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export default function ClientsPage() {
  const canCreate = usePermission('customers.create');
  const canUpdate = usePermission('customers.update');
  const canDelete = usePermission('customers.delete');
  const canPay = usePermission('payments.create');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('recent');
  const [page, setPage] = useState(1);

  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<CustomersSummary | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  /* Un état booléen par modale (§8.3 règle 1). */
  const [showFormModal, setShowFormModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showDeactivateModal, setShowDeactivateModal] = useState(false);
  const [activeCustomer, setActiveCustomer] = useState<CustomerRecord | null>(null);

  const [detailStats, setDetailStats] = useState<CustomerStatsRecord | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);

  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
    if (typeof saved.search === 'string') setSearch(saved.search);
    if (isStatusFilter(saved.statusFilter)) setStatusFilter(saved.statusFilter);
    if (isSortOrder(saved.sortOrder)) setSortOrder(saved.sortOrder);
    if (typeof saved.page === 'number' && saved.page > 0) setPage(saved.page);
  });

  /* Recherche débouncée à 300 ms — la frappe ne déclenche pas une requête par touche. */
  useEffect(() => {
    if (!rehydrated) return;
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search, rehydrated]);

  /* Chargement de la liste. Le premier fetch est **gaté** sur `rehydrated` :
     sans ce verrou, la page chargerait la page 1 puis rechargerait la page 3. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
        if (debouncedSearch) params.set('search', debouncedSearch);
        /*
         * Le tri part au serveur : c'est la seule façon de trier *toute* la
         * base. Un tri local ne trierait que la page affichée — « solde
         * décroissant » montrerait alors le plus gros solde de la page 1, pas
         * celui de l'entreprise.
         */
        params.set('sort', sortOrder);

        if (statusFilter === 'inactive') {
          // Filtre absent de l'API : on charge tout et on pagine en mémoire.
          params.set('limit', String(FETCH_ALL_LIMIT));
          params.set('includeInactive', 'true');
        } else if (statusFilter === 'debtors') {
          params.set('debtors', 'true');
        } else {
          params.set('includeInactive', 'true');
          params.set('page', String(page));
        }

        const response = await fetch(`/api/clients?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'Les clients n’ont pas pu être chargés.'));
        }

        const payload = (await response.json()) as {
          data?: CustomerRecord[];
          total?: number;
          totalPages?: number;
        };

        if (!active) return;

        const rows = Array.isArray(payload.data) ? payload.data : [];

        if (statusFilter === 'inactive') {
          const inactive = rows.filter((customer) => !customer.isActive);
          // L'ordre demandé est déjà appliqué par l'API : on ne retrie pas ici.
          const pages = Math.max(1, Math.ceil(inactive.length / PAGE_LIMIT));

          setCustomers(inactive.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT));
          setTotal(inactive.length);
          setTotalPages(pages);

          const corrected = clampPage(page, pages);
          if (corrected !== null) setPage(corrected);
        } else {
          const pages = Math.max(1, Number(payload.totalPages ?? 1));
          setCustomers(rows);
          setTotal(Number(payload.total ?? rows.length));
          setTotalPages(pages);

          const corrected = clampPage(page, pages);
          if (corrected !== null) setPage(corrected);
        }

        setIsLoading(false);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(
          caught instanceof Error ? caught.message : 'Les clients n’ont pas pu être chargés.',
        );
        setCustomers([]);
        setIsLoading(false);
      }
    }

    void load();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, debouncedSearch, statusFilter, page, sortOrder, refreshToken]);

  /* Cartes de synthèse. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    async function loadSummary() {
      setIsSummaryLoading(true);
      try {
        const response = await fetch('/api/clients/stats', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            await readApiError(response, 'Les statistiques n’ont pas pu être chargées.'),
          );
        }
        const payload = (await response.json()) as CustomersSummary;
        if (!active) return;
        setSummary({
          totalCustomers: Number(payload.totalCustomers ?? 0),
          activeCustomers: Number(payload.activeCustomers ?? 0),
          debtorsCount: Number(payload.debtorsCount ?? 0),
          totalReceivables: Number(payload.totalReceivables ?? 0),
          totalInvoiced: Number(payload.totalInvoiced ?? 0),
        });
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setSummary(null);
      } finally {
        if (active) setIsSummaryLoading(false);
      }
    }

    void loadSummary();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, refreshToken]);

  /* Mémorisation de l'état de vue, sur la même maille que le retour arrière. */
  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, statusFilter, page, sortOrder });
  }, [rehydrated, search, statusFilter, page, sortOrder]);

  /*
   * Aucun tri ici : l'API renvoie déjà la liste dans l'ordre demandé
   * (`?sort=recent|name|balance`). Voir `lib/list-sort.ts`.
   */
  const visibleCustomers = customers;

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  const closeDetailModal = useCallback(() => setShowDetailModal(false), []);
  const closePaymentModal = useCallback(() => setShowPaymentModal(false), []);
  const closeDeactivateModal = useCallback(() => setShowDeactivateModal(false), []);

  const loadDetail = useCallback(async (customer: CustomerRecord) => {
    setIsDetailLoading(true);
    setDetailError(null);
    try {
      const response = await fetch(`/api/clients/${customer.id}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'La fiche du client n’a pas pu être chargée.'));
      }
      setDetailStats((await response.json()) as CustomerStatsRecord);
    } catch (caught) {
      setDetailStats(null);
      setDetailError(
        caught instanceof Error ? caught.message : 'La fiche du client n’a pas pu être chargée.',
      );
    } finally {
      setIsDetailLoading(false);
    }
  }, []);

  const openDetailModal = (customer: CustomerRecord) => {
    setActiveCustomer(customer);
    setDetailStats(null);
    setShowDetailModal(true);
    void loadDetail(customer);
  };

  const openEditModal = (customer: CustomerRecord) => {
    setActiveCustomer(customer);
    setShowDetailModal(false);
    setShowFormModal(true);
  };

  const openCreateModal = () => {
    setActiveCustomer(null);
    setShowCreateModal(true);
  };

  const openPaymentModal = (customer: CustomerRecord) => {
    setActiveCustomer(customer);
    setShowDetailModal(false);
    setShowPaymentModal(true);
  };

  const openDeactivateModal = (customer: CustomerRecord) => {
    setActiveCustomer(customer);
    setShowDeactivateModal(true);
  };

  const handleCustomerSaved = (saved: CustomerRecord) => {
    const isEdit = Boolean(activeCustomer);
    toast.success(isEdit ? 'Client modifié.' : 'Client créé.');
    setShowFormModal(false);
    setShowCreateModal(false);
    setActiveCustomer(null);
    if (isEdit && saved?.id) void loadDetail(saved);
    refresh();
  };

  const handlePaymentRecorded = (payment: { receiptNumber: string }) => {
    toast.success(`Paiement enregistré — reçu ${payment.receiptNumber}.`);
    refresh();
  };

  const handleDeactivate = async () => {
    if (!activeCustomer) return;
    setIsDeactivating(true);
    try {
      const response = await fetch(`/api/clients/${activeCustomer.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Le client n’a pas pu être désactivé.'));
      }
      toast.success(`« ${activeCustomer.name} » a été désactivé.`);
      setShowDeactivateModal(false);
      setActiveCustomer(null);
      refresh();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : 'Le client n’a pas pu être désactivé.',
      );
    } finally {
      setIsDeactivating(false);
    }
  };

  /** « Export » : CSV du jeu de données affiché, ouvrable dans Excel. */
  const exportCsv = () => {
    if (visibleCustomers.length === 0) {
      toast.error('Aucun client à exporter.');
      return;
    }

    const header = [
      'Nom',
      'Téléphone',
      'Adresse',
      'Ventes',
      'Total acheté (GNF)',
      'Payé (GNF)',
      'Solde (GNF)',
      'Plafond (GNF)',
      'Dernier achat',
      'Statut',
    ];

    const lines = visibleCustomers.map((customer) =>
      [
        csvField(customer.name),
        csvField(customer.phone ?? ''),
        csvField(customer.address ?? ''),
        String(customer.invoiceCount),
        String(customer.totalInvoiced),
        String(customer.totalPaid),
        String(customer.balance),
        String(customer.creditLimit),
        csvField(customer.lastPurchaseDate ?? ''),
        csvField(customer.isActive ? 'Actif' : 'Inactif'),
      ].join(';'),
    );

    const csv = `\uFEFF${header.join(';')}\n${lines.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);

    toast.success('Export CSV généré.');
  };

  const summaryCards = isSummaryLoading || !summary ? (
    <SkeletonCards count={5} />
  ) : (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <StatCardDelta
        label="Clients"
        value={<span className="tabular">{formatNumber(summary.totalCustomers)}</span>}
        hint={`${formatNumber(summary.activeCustomers)} actifs`}
      />
      <StatCardDelta
        label="Débiteurs"
        tone="warning"
        value={<span className="tabular">{formatNumber(summary.debtorsCount)}</span>}
        hint="Clients avec un solde dû"
      />
      <StatCardDelta
        label="Créances clients"
        tone="error"
        value={<span className="tabular">{formatNumber(summary.totalReceivables)}</span>}
        hint="GNF — restes à payer"
      />
      <StatCardDelta
        label="Total facturé"
        tone="success"
        value={<span className="tabular">{formatNumber(summary.totalInvoiced)}</span>}
        hint="GNF — ventes actives"
      />
      <StatCardDelta
        label="Clients inactifs"
        tone="neutral"
        value={
          <span className="tabular">
            {formatNumber(summary.totalCustomers - summary.activeCustomers)}
          </span>
        }
        hint="Fiches désactivées"
      />
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Commercial"
        title="Clients"
        description="Répertoire des clients, encours, plafonds de crédit et encaissements."
        actions={
          canCreate ? (
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" onClick={openCreateModal}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Nouveau client
            </button>
          ) : null
        }
      />

      {summaryCards}

      <DataToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Rechercher un nom, un téléphone, une adresse…"
        filters={
          <div className="w-full sm:w-52">
            <FilterSelect
              value={statusFilter}
              onChange={(value) => {
                setStatusFilter(isStatusFilter(value) ? value : 'all');
                setPage(1);
              }}
              options={STATUS_OPTIONS}
              placeholder="Tous les clients"
            />
          </div>
        }
        secondaryFilters={
          <div className="w-full sm:w-56">
            <FilterSelect
              /*
               * Le tri par défaut est rendu par le `placeholder` (valeur vide) :
               * sans ce mappage, le `<select>` n'aurait aucune option
               * correspondante et s'afficherait vide.
               */
              value={sortOrder === 'recent' ? '' : sortOrder}
              onChange={(value) => {
                setSortOrder(isSortOrder(value) ? value : 'recent');
                setPage(1);
              }}
              options={SORT_OPTIONS}
              placeholder="Tri : dernière insertion"
            />
          </div>
        }
        secondaryCount={sortOrder === 'recent' ? 0 : 1}
        actions={
          <>
            <ToolbarButton onClick={exportCsv} title="Exporter la liste affichée au format CSV">
              Exporter
            </ToolbarButton>
            <ToolbarButton onClick={refresh} title="Recharger la liste">
              Actualiser
            </ToolbarButton>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-base-content/60">
        <span>
          {isLoading
            ? 'Chargement…'
            : `${formatNumber(total)} client${total > 1 ? 's' : ''} ${
                total > 1 ? 'trouvés' : 'trouvé'
              }`}
        </span>
        {statusFilter === 'debtors' && <span>Filtre : clients débiteurs</span>}
        {statusFilter === 'inactive' && <span>Filtre : clients inactifs</span>}
      </div>

      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Impossible de charger les clients"
            description={error}
            onRetry={refresh}
          />
        </div>
      ) : (
        <ClientsTable
          data={visibleCustomers}
          isLoading={isLoading}
          canUpdate={canUpdate}
          canDelete={canDelete}
          canPay={canPay}
          onOpenDetail={openDetailModal}
          onOpenForm={openEditModal}
          onOpenPayment={openPaymentModal}
          onOpenDeactivate={openDeactivateModal}
          emptyState={
            <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
              <EmptyState
                title={
                  debouncedSearch || statusFilter !== 'all'
                    ? 'Aucun client ne correspond'
                    : 'Aucun client enregistré'
                }
                description={
                  debouncedSearch || statusFilter !== 'all'
                    ? 'Modifiez la recherche ou le filtre de statut pour élargir les résultats.'
                    : 'Créez la première fiche client pour suivre ses achats, son solde et ses encaissements.'
                }
                action={
                  canCreate ? (
                    <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" onClick={openCreateModal}>
                      Créer le premier client
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost min-h-11 sm:min-h-0"
                      onClick={() => {
                        setSearch('');
                        setStatusFilter('all');
                        setPage(1);
                      }}
                    >
                      Réinitialiser la recherche
                    </button>
                  )
                }
              />
            </div>
          }
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Modales — une par état booléen (§8.3 règle 1). */}
      <CustomerFormModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSaved={handleCustomerSaved}
        idPrefix="create"
      />

      <CustomerFormModal
        isOpen={showFormModal}
        onClose={() => setShowFormModal(false)}
        onSaved={handleCustomerSaved}
        customer={activeCustomer}
        idPrefix="edit"
      />

      <CustomerDetailModal
        isOpen={showDetailModal}
        onClose={closeDetailModal}
        stats={detailStats}
        isLoading={isDetailLoading}
        error={detailError}
        onRetry={() => {
          if (activeCustomer) void loadDetail(activeCustomer);
        }}
        onEdit={canUpdate && activeCustomer ? () => openEditModal(activeCustomer) : undefined}
      />

      {activeCustomer && (
        <PaymentModal
          isOpen={showPaymentModal}
          onClose={closePaymentModal}
          customer={{
            id: activeCustomer.id,
            name: activeCustomer.name,
            balance: activeCustomer.balance,
          }}
          onRecorded={handlePaymentRecorded}
        />
      )}

      <DeactivateCustomerDialog
        isOpen={showDeactivateModal}
        onClose={closeDeactivateModal}
        onConfirm={handleDeactivate}
        customer={activeCustomer}
        isSubmitting={isDeactivating}
      />
    </div>
  );
}
