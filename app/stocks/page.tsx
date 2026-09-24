'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  EmptyState,
  ErrorState,
  MoneyText,
  QuantityText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useViewStateRehydration, writeViewState, clampPage } from '@/lib/view-state';
import {
  ProductHistoryModal,
  StockAdjustModal,
  movementColumns,
  type Paginated,
  type StockMovementRow,
  type StockProduct,
  type StockSummary,
} from '@/components/stocks/stocks-modals';

/* ==================================================================
 * Page « Stocks » (README §12 — Stock et inventaire).
 *
 * Deux vues, un seul état : « État du stock » (produits) et « Historique des
 * mouvements ». Toute correction passe par la modale d'ajustement, qui envoie
 * un **écart signé** à `POST /api/stocks/adjust` : cette page ne touche jamais
 * `products.stock` directement, l'invariant reste garanti par `lib/stock.ts`.
 * ================================================================== */

const PRODUCTS_LIMIT = 20;
const MOVEMENTS_LIMIT = 20;
/** Liste complète pour la sélection produit et le filtre catégorie. */
const OPTIONS_LIMIT = 500;

/** Clé d'état de vue — doit rester stable pour que le retour arrière restaure. */
const VIEW_NAME = 'stocks';

type Tab = 'products' | 'movements';

type StocksViewState = {
  activeTab: Tab;
  search: string;
  categoryId: string;
  lowStockOnly: boolean;
  outOfStockOnly: boolean;
  page: number;
  movementType: string;
  movementFrom: string;
  movementTo: string;
  movementPage: number;
};

/** Lit une réponse : message d'erreur de l'API si elle est en échec. */
async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as any)?.error ?? 'Requête impossible');
  }
  return payload as T;
}

/**
 * Corrige une page restaurée devenue hors bornes : la liste a pu rétrécir
 * depuis le relevé, et la page mémorisée n'existe plus (§5, `clampPage`).
 */
function clampIfNeeded(current: number, totalPages: number, setPage: (page: number) => void): void {
  const corrected = clampPage(current, totalPages);
  if (corrected !== null) setPage(corrected);
}

function buildQuery(entries: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export default function StocksPage() {
  const canAdjust = usePermission('stock.adjust');

  /* ── Onglet actif (un seul état booléen/discriminant) ─────────────── */
  const [activeTab, setActiveTab] = useState<Tab>('products');

  /* ── Vue « État du stock » ────────────────────────────────────────── */
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [outOfStockOnly, setOutOfStockOnly] = useState(false);
  const [page, setPage] = useState(1);

  /* ── Vue « Historique des mouvements » ────────────────────────────── */
  const [movementType, setMovementType] = useState('');
  const [movementFrom, setMovementFrom] = useState('');
  const [movementTo, setMovementTo] = useState('');
  const [movementSearch, setMovementSearch] = useState('');
  const [debouncedMovementSearch, setDebouncedMovementSearch] = useState('');
  const [movementPage, setMovementPage] = useState(1);

  /* ── Données ──────────────────────────────────────────────────────── */
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [productTotal, setProductTotal] = useState(0);
  const [productTotalPages, setProductTotalPages] = useState(1);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [productsReloadToken, setProductsReloadToken] = useState(0);

  const [allProducts, setAllProducts] = useState<StockProduct[]>([]);
  /** Passe à `true` dès que la liste complète a été chargée une première fois. */
  const [allProductsLoaded, setAllProductsLoaded] = useState(false);

  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryReloadToken, setSummaryReloadToken] = useState(0);

  const [movements, setMovements] = useState<StockMovementRow[]>([]);
  const [movementTotal, setMovementTotal] = useState(0);
  const [movementTotalPages, setMovementTotalPages] = useState(1);
  const [movementsLoading, setMovementsLoading] = useState(false);
  const [movementsError, setMovementsError] = useState<string | null>(null);
  const [movementsReloadToken, setMovementsReloadToken] = useState(0);

  /* ── Modales : un état booléen chacune (§7) ───────────────────────── */
  const [isAdjustOpen, setIsAdjustOpen] = useState(false);
  const [adjustProduct, setAdjustProduct] = useState<StockProduct | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyProduct, setHistoryProduct] = useState<StockProduct | null>(null);

  const productsRequested = useRef(false);
  const movementsRequested = useRef(false);

  /* ── Débounce de la recherche produits (300 ms, §5) ───────────────── */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* ── Débounce de la recherche dans l'historique ───────────────────── */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedMovementSearch(movementSearch), 300);
    return () => clearTimeout(timer);
  }, [movementSearch]);

  /* ── Chargement de la synthèse ───────────────────────────────────── */
  useEffect(() => {
    const controller = new AbortController();
    setSummaryLoading(true);
    setSummaryError(null);

    fetch('/api/stocks/summary', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      .then((response) => readJson<StockSummary>(response))
      .then((payload) => {
        if (controller.signal.aborted) return;
        setSummary(payload);
      })
      .catch((error: any) => {
        if (error?.name === 'AbortError') return;
        setSummaryError(error?.message ?? 'Synthèse indisponible');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSummaryLoading(false);
      });

    return () => controller.abort();
  }, [summaryReloadToken]);

  /* ── Chargement de la liste complète (filtre catégorie + modale) ──── */
  useEffect(() => {
    // Après la première passe, on ne recharge qu'à la demande : un ajustement
    // vient de changer les stocks, donc `refreshProducts()` incrémente le jeton.
    if (allProductsLoaded && productsReloadToken === 0) return;

    const controller = new AbortController();
    const query = buildQuery({ limit: OPTIONS_LIMIT, page: 1 });

    fetch(`/api/stocks?${query}`, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      .then((response) => readJson<Paginated<StockProduct>>(response))
      .then((payload) => {
        if (controller.signal.aborted) return;
        setAllProducts(Array.isArray(payload.data) ? payload.data : []);
        setAllProductsLoaded(true);
      })
      .catch(() => {
        // Liste d'appoint : son échec ne doit pas masquer la page principale.
        setAllProductsLoaded(true);
      });

    return () => controller.abort();
  }, [allProductsLoaded, productsReloadToken]);

  /* ── Chargement de l'état du stock ───────────────────────────────── */
  useEffect(() => {
    if (activeTab !== 'products') return;
    // Le premier fetch est gaté sur la réhydratation (§5) : sans cela la page
    // partirait chercher la page 1 puis relancerait aussitôt pour la page 3.
    if (productsRequested.current) return;
    productsRequested.current = true;

    const controller = new AbortController();
    setProductsLoading(true);
    setProductsError(null);

    const query = buildQuery({
      search: debouncedSearch,
      categoryId: categoryId ? Number(categoryId) : undefined,
      lowStockOnly,
      outOfStockOnly,
      page,
      limit: PRODUCTS_LIMIT,
    });

    fetch(`/api/stocks?${query}`, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      .then((response) => readJson<Paginated<StockProduct>>(response))
      .then((payload) => {
        if (controller.signal.aborted) return;
        setProducts(Array.isArray(payload.data) ? payload.data : []);
        setProductTotal(Number(payload.total ?? 0));
        setProductTotalPages(Number(payload.totalPages ?? 1) || 1);
        clampIfNeeded(page, Number(payload.totalPages ?? 1) || 1, setPage);
      })
      .catch((error: any) => {
        if (error?.name === 'AbortError') return;
        setProductsError(error?.message ?? 'Chargement du stock impossible');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setProductsLoading(false);
          productsRequested.current = false;
        }
      });

    return () => {
      controller.abort();
      productsRequested.current = false;
    };
  }, [
    activeTab,
    page,
    debouncedSearch,
    categoryId,
    lowStockOnly,
    outOfStockOnly,
    productsReloadToken,
  ]);

  /* ── Chargement de l'historique des mouvements ───────────────────── */
  useEffect(() => {
    if (activeTab !== 'movements') return;
    if (movementsRequested.current) return;
    movementsRequested.current = true;

    const controller = new AbortController();
    setMovementsLoading(true);
    setMovementsError(null);

    const query = buildQuery({
      type: movementType,
      from: movementFrom,
      to: movementTo,
      page: movementPage,
      limit: MOVEMENTS_LIMIT,
    });

    fetch(`/api/stocks/mouvements?${query}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then((response) => readJson<Paginated<StockMovementRow>>(response))
      .then((payload) => {
        if (controller.signal.aborted) return;
        setMovements(Array.isArray(payload.data) ? payload.data : []);
        setMovementTotal(Number(payload.total ?? 0));
        setMovementTotalPages(Number(payload.totalPages ?? 1) || 1);
        clampIfNeeded(movementPage, Number(payload.totalPages ?? 1) || 1, setMovementPage);
      })
      .catch((error: any) => {
        if (error?.name === 'AbortError') return;
        setMovementsError(error?.message ?? "Chargement de l'historique impossible");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setMovementsLoading(false);
          movementsRequested.current = false;
        }
      });

    return () => {
      controller.abort();
      movementsRequested.current = false;
    };
  }, [
    activeTab,
    movementPage,
    movementType,
    movementFrom,
    movementTo,
    movementsReloadToken,
  ]);

  /* ── Restauration d'état au retour arrière (§5) ───────────────────── */
  const rehydrated = useViewStateRehydration<StocksViewState>(VIEW_NAME, (saved) => {
    // Garde-fou : un snapshot d'une version antérieure ne doit pas poser un
    // onglet inconnu (l'état vit dans `sessionStorage`, donc non typé).
    if (saved.activeTab === 'products' || saved.activeTab === 'movements') {
      setActiveTab(saved.activeTab);
    }
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.categoryId !== undefined) setCategoryId(saved.categoryId);
    if (saved.lowStockOnly !== undefined) setLowStockOnly(saved.lowStockOnly);
    if (saved.outOfStockOnly !== undefined) setOutOfStockOnly(saved.outOfStockOnly);
    if (saved.page) setPage(saved.page);
    if (saved.movementType !== undefined) setMovementType(saved.movementType);
    if (saved.movementFrom !== undefined) setMovementFrom(saved.movementFrom);
    if (saved.movementTo !== undefined) setMovementTo(saved.movementTo);
    if (saved.movementPage) setMovementPage(saved.movementPage);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, {
      activeTab,
      search,
      categoryId,
      lowStockOnly,
      outOfStockOnly,
      page,
      movementType,
      movementFrom,
      movementTo,
      movementPage,
    });
  }, [
    rehydrated,
    activeTab,
    search,
    categoryId,
    lowStockOnly,
    outOfStockOnly,
    page,
    movementType,
    movementFrom,
    movementTo,
    movementPage,
  ]);

  /* ── Catégories : dérivées des produits (aucune route catégories) ─── */
  const categories = useMemo(() => {
    const map = new Map<number, string>();
    for (const product of allProducts) {
      if (product.categoryId != null && product.categoryName) {
        map.set(product.categoryId, product.categoryName);
      }
    }
    return Array.from(map, ([value, label]) => ({ value: String(value), label })).sort((a, b) =>
      a.label.localeCompare(b.label, 'fr'),
    );
  }, [allProducts]);

  /* ── Recherche locale de l'historique (la route n'a pas de `search`) ─ */
  const visibleMovements = useMemo(() => {
    const term = debouncedMovementSearch.trim().toLowerCase();
    if (!term) return movements;
    return movements.filter((m) =>
      [m.productName, m.productCode, m.motif, m.userName ?? '']
        .join(' ')
        .toLowerCase()
        .includes(term),
    );
  }, [movements, debouncedMovementSearch]);

  /* ── Rafraîchissements ────────────────────────────────────────────── */
  const refreshProducts = useCallback(() => {
    setProductsReloadToken((token) => token + 1);
  }, []);

  const refreshSummary = useCallback(() => {
    setSummaryReloadToken((token) => token + 1);
  }, []);

  const refreshMovements = useCallback(() => {
    setMovementsReloadToken((token) => token + 1);
  }, []);

  const afterAdjustment = useCallback(() => {
    refreshProducts();
    refreshSummary();
    refreshMovements();
  }, [refreshProducts, refreshSummary, refreshMovements]);

  /** Une seule bascule d'alerte à la fois : « faible » et « rupture » s'excluent. */
  function toggleLowStock() {
    setLowStockOnly((current) => {
      const next = !current;
      if (next) setOutOfStockOnly(false);
      return next;
    });
    setPage(1);
  }

  function toggleOutOfStock() {
    setOutOfStockOnly((current) => {
      const next = !current;
      if (next) setLowStockOnly(false);
      return next;
    });
    setPage(1);
  }

  /* ── Colonnes ─────────────────────────────────────────────────────── */
  const productColumns: Column<StockProduct>[] = useMemo(
    () => [
      {
        key: 'code',
        label: 'Code',
        className: 'font-mono text-xs',
        render: (p) => p.code,
      },
      {
        key: 'name',
        label: 'Nom',
        primary: true,
        render: (p) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{p.name}</div>
            {(p.isOut || p.isLow) && (
              <div className="mt-1">
                <Badge tone={p.isOut ? 'error' : 'warning'}>
                  {p.isOut ? 'Rupture' : 'Stock faible'}
                </Badge>
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'category',
        label: 'Catégorie',
        render: (p) => <span className="text-sm">{p.categoryName ?? 'Non classé'}</span>,
      },
      {
        key: 'unit',
        label: 'Unité',
        hideOnMobile: true,
        render: (p) => <span className="text-sm">{p.unit}</span>,
      },
      {
        key: 'stock',
        label: 'Stock',
        render: (p) => (
          <QuantityText
            value={p.stock}
            unit={p.unit}
            className={p.isOut ? 'font-semibold text-error' : p.isLow ? 'font-semibold text-warning' : ''}
          />
        ),
      },
      {
        key: 'stockMin',
        label: 'Seuil',
        hideOnMobile: true,
        render: (p) => <QuantityText value={p.stockMin} unit={p.unit} />,
      },
      {
        key: 'stockValue',
        label: "Valeur d'achat",
        hideOnMobile: true,
        render: (p) => <MoneyText value={p.stockValue} />,
      },
      {
        key: 'saleValue',
        label: 'Valeur de vente',
        hideOnMobile: true,
        render: (p) => <MoneyText value={p.saleValue} />,
      },
      {
        key: 'state',
        label: 'État',
        hideOnMobile: true,
        render: (p) =>
          p.isOut ? (
            <Badge tone="error">Rupture</Badge>
          ) : p.isLow ? (
            <Badge tone="warning">Stock faible</Badge>
          ) : (
            <Badge tone="success">Disponible</Badge>
          ),
      },
    ],
    [],
  );

  /* ── Rendu ────────────────────────────────────────────────────────── */
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Gestion"
        title="Stocks"
        description="État du stock, alertes de seuil, ruptures et journal des entrées, sorties et ajustements d'inventaire."
        actions={
          canAdjust ? (
            <button
              type="button"
              className="btn btn-primary min-h-11"
              onClick={() => {
                setAdjustProduct(null);
                setIsAdjustOpen(true);
              }}
            >
              Ajuster un stock
            </button>
          ) : null
        }
      />

      {/* 2 · Cartes de synthèse (les alertes portent une teinte ET un libellé) */}
      {summaryLoading ? (
        <SkeletonCards count={6} />
      ) : summaryError ? (
        <ErrorState
          title="Synthèse indisponible"
          description={summaryError}
          onRetry={refreshSummary}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <StatCardDelta
            label="Produits suivis"
            tone="primary"
            value={summary?.totalProducts ?? 0}
            hint="Produits actifs"
          />
          <StatCardDelta
            label="Stock total"
            tone="info"
            value={<QuantityText value={summary?.totalStock ?? 0} />}
            hint="Toutes unités confondues"
          />
          <StatCardDelta
            label="Valeur d'achat"
            tone="primary"
            value={<MoneyText value={summary?.totalStockValue ?? 0} />}
            hint="Stock × prix d'achat"
          />
          <StatCardDelta
            label="Valeur de vente"
            tone="success"
            value={<MoneyText value={summary?.totalSaleValue ?? 0} />}
            hint="Stock × prix de vente"
          />
          <StatCardDelta
            label="Stocks faibles"
            tone="warning"
            value={summary?.lowStockCount ?? 0}
            hint="Alerte : stock ≤ seuil"
          />
          <StatCardDelta
            label="Ruptures"
            tone="error"
            value={summary?.outOfStockCount ?? 0}
            hint="Vente bloquée"
          />
        </div>
      )}

      {/* Bascule entre les deux vues : un seul état */}
      <div role="tablist" aria-label="Vues du stock" className="tabs tabs-boxed w-full sm:w-auto">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'products'}
          className={`tab min-h-11 ${activeTab === 'products' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('products')}
        >
          État du stock
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'movements'}
          className={`tab min-h-11 ${activeTab === 'movements' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('movements')}
        >
          Historique des mouvements
        </button>
      </div>

      {activeTab === 'products' ? (
        <section className="space-y-4">
          <DataToolbar
            search={search}
            onSearchChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            searchPlaceholder="Rechercher un code ou un nom de produit…"
            filters={
              <FilterSelect
                value={categoryId}
                onChange={(value) => {
                  setCategoryId(value);
                  setPage(1);
                }}
                options={categories}
                placeholder="Toutes les catégories"
              />
            }
            secondaryFilters={
              <>
                <button
                  type="button"
                  onClick={toggleLowStock}
                  aria-pressed={lowStockOnly}
                  className={`btn min-h-11 ${lowStockOnly ? 'btn-warning' : 'btn-ghost border border-base-300'}`}
                >
                  Stock faible uniquement
                </button>
                <button
                  type="button"
                  onClick={toggleOutOfStock}
                  aria-pressed={outOfStockOnly}
                  className={`btn min-h-11 ${outOfStockOnly ? 'btn-error' : 'btn-ghost border border-base-300'}`}
                >
                  Ruptures uniquement
                </button>
              </>
            }
            secondaryCount={(lowStockOnly ? 1 : 0) + (outOfStockOnly ? 1 : 0)}
          />

          {(lowStockOnly || outOfStockOnly) && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/60">
              <span>Filtres actifs :</span>
              {lowStockOnly && <Badge tone="warning">Stock faible uniquement</Badge>}
              {outOfStockOnly && <Badge tone="error">Ruptures uniquement</Badge>}
              <button
                type="button"
                className="btn btn-ghost btn-xs min-h-11"
                onClick={() => {
                  setLowStockOnly(false);
                  setOutOfStockOnly(false);
                  setPage(1);
                }}
              >
                Réinitialiser
              </button>
            </div>
          )}

          {productsLoading ? (
            <SkeletonTable rows={6} cols={5} />
          ) : productsError ? (
            <ErrorState
              title="Chargement du stock impossible"
              description={productsError}
              onRetry={refreshProducts}
            />
          ) : products.length === 0 ? (
            <EmptyState
              title="Aucun produit à afficher"
              description={
                search || categoryId || lowStockOnly || outOfStockOnly
                  ? 'Aucun produit ne correspond à ces filtres.'
                  : 'Aucun produit actif : créez d’abord des produits pour suivre leur stock.'
              }
              action={
                search || categoryId || lowStockOnly || outOfStockOnly ? (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11"
                    onClick={() => {
                      setSearch('');
                      setCategoryId('');
                      setLowStockOnly(false);
                      setOutOfStockOnly(false);
                      setPage(1);
                    }}
                  >
                    Réinitialiser les filtres
                  </button>
                ) : (
                  <a className="btn btn-primary min-h-11" href="/produits">
                    Créer un produit
                  </a>
                )
              }
            />
          ) : (
            <>
              <ResponsiveTable
                columns={productColumns}
                data={products}
                getRowKey={(p) => p.id}
                actions={(p) => (
                  <>
                    <ToolbarButton
                      onClick={() => {
                        setHistoryProduct(p);
                        setIsHistoryOpen(true);
                      }}
                    >
                      Historique
                    </ToolbarButton>
                    {canAdjust && (
                      <ToolbarButton
                        variant="primary"
                        onClick={() => {
                          setAdjustProduct(p);
                          setIsAdjustOpen(true);
                        }}
                      >
                        Ajuster
                      </ToolbarButton>
                    )}
                  </>
                )}
              />
              <Pagination
                currentPage={page}
                totalPages={productTotalPages}
                onPageChange={setPage}
              />
              <p className="text-center text-xs text-base-content/50">
                {productTotal} produit{productTotal > 1 ? 's' : ''} — page {page} sur {productTotalPages}
              </p>
            </>
          )}
        </section>
      ) : (
        <section className="space-y-4">
          <DataToolbar
            search={movementSearch}
            onSearchChange={setMovementSearch}
            searchPlaceholder="Filtrer cette page (produit, motif, utilisateur)…"
            filters={
              <FilterSelect
                value={movementType}
                onChange={(value) => {
                  setMovementType(value);
                  setMovementPage(1);
                }}
                options={[
                  { value: 'entry', label: 'Entrée' },
                  { value: 'exit', label: 'Sortie' },
                  { value: 'adjustment', label: 'Ajustement' },
                ]}
                placeholder="Tous les types"
              />
            }
            secondaryFilters={
              <>
                <div className="space-y-1">
                  <DatePicker
                    value={movementFrom}
                    onChange={(value) => {
                      setMovementFrom(value);
                      setMovementPage(1);
                    }}
                    placeholder="Du"
                  />
                </div>
                <div className="space-y-1">
                  <DatePicker
                    value={movementTo}
                    onChange={(value) => {
                      setMovementTo(value);
                      setMovementPage(1);
                    }}
                    placeholder="Au"
                  />
                </div>
                {(movementFrom || movementTo) && (
                  <button
                    type="button"
                    className="btn btn-ghost min-h-11 border border-base-300"
                    onClick={() => {
                      setMovementFrom('');
                      setMovementTo('');
                      setMovementPage(1);
                    }}
                  >
                    Effacer la période
                  </button>
                )}
              </>
            }
            secondaryCount={(movementFrom ? 1 : 0) + (movementTo ? 1 : 0)}
          />

          {/* La route `mouvements` n'a pas de `search` : la recherche est locale
              à la page affichée. Dit explicitement pour ne pas tromper. */}
          <div className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-2.5 text-xs text-base-content/60">
            {movementSearch.trim()
              ? `Recherche locale : ${visibleMovements.length} mouvement(s) sur les ${movements.length} affichés. Utilisez le filtre de type ou la période pour élargir.`
              : 'Filtres serveur : type de mouvement et période. La recherche porte sur les mouvements de la page affichée.'}
          </div>

          {movementsLoading ? (
            <SkeletonTable rows={6} cols={5} />
          ) : movementsError ? (
            <ErrorState
              title="Historique indisponible"
              description={movementsError}
              onRetry={refreshMovements}
            />
          ) : visibleMovements.length === 0 ? (
            <EmptyState
              title="Aucun mouvement"
              description={
                movements.length === 0
                  ? 'Aucun mouvement sur cette période. Les ventes, achats et corrections d’inventaire alimentent ce journal.'
                  : 'Aucun mouvement ne correspond à la recherche sur cette page.'
              }
              action={
                movementSearch.trim() ? (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11"
                    onClick={() => setMovementSearch('')}
                  >
                    Effacer la recherche
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11"
                    onClick={() => setActiveTab('products')}
                  >
                    Voir l’état du stock
                  </button>
                )
              }
            />
          ) : (
            <>
              <ResponsiveTable
                columns={movementColumns}
                data={visibleMovements}
                getRowKey={(m) => m.id}
              />
              <Pagination
                currentPage={movementPage}
                totalPages={movementTotalPages}
                onPageChange={setMovementPage}
              />
              <p className="text-center text-xs text-base-content/50">
                {movementTotal} mouvement{movementTotal > 1 ? 's' : ''} — page {movementPage} sur{' '}
                {movementTotalPages}
              </p>
            </>
          )}
        </section>
      )}

      {/* 6 · Modales — un état booléen chacune */}
      <StockAdjustModal
        isOpen={isAdjustOpen}
        onClose={() => setIsAdjustOpen(false)}
        products={allProducts}
        isListLoading={!allProductsLoaded}
        onAdjusted={afterAdjustment}
        initialProduct={adjustProduct}
      />

      <ProductHistoryModal
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        product={historyProduct}
      />
    </div>
  );
}
