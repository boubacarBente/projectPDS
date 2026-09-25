'use client';

/**
 * Catalogue produits (§4, §7.4).
 *
 * Page de liste : en-tête, cartes de synthèse, barre d'outils (recherche
 * débouncée + filtres), `ResponsiveTable`, pagination, puis les modales — une
 * par état booléen (§5, §8.3).
 *
 * Le **stock** n'est jamais modifié ici : l'action « Ajuster le stock » renvoie
 * vers `/stocks`, seul endroit qui enregistre un mouvement et préserve
 * l'invariant « `products.stock` = somme des `stock_movements` » (§6.1).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { IconAction, RowActions } from '@/components/row-actions';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  MiniStat,
  MoneyText,
  QuantityText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { RoleGate, usePermission } from '@/components/role-gate';
import {
  CATEGORY_KIND_LABELS,
  CATEGORY_KIND_OPTIONS,
  ProductFormModal,
  StockBadge,
  readApiError,
  type CategoryView,
  type ProductView,
} from '@/components/produits/produits-modals';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatNumber } from '@/lib/format';
import type { ProductsSummary } from '@/lib/products';
// Le `SettingsProvider` vit dans ce module (monté par `app/layout.tsx`) : le
// contexte donne la liste **fermée** des unités et la devise, sans requête.
import { useSettings } from '@/app/parametres/page';

const PAGE_SIZE = 20;

type ProductsViewState = {
  search: string;
  page: number;
  categoryId: string;
  kind: string;
  lowStockOnly: boolean;
  includeInactive: boolean;
};

export default function ProduitsPage() {
  const { settings } = useSettings();
  const canCreate = usePermission('products.create');
  const canUpdate = usePermission('products.update');
  const canDelete = usePermission('products.delete');

  const currency = settings.currency || 'GNF';
  const units = settings.units.length > 0 ? settings.units : ['pièce'];

  /* ------------------------------- État liste ------------------------------ */
  const [items, setItems] = useState<ProductView[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [categoryId, setCategoryId] = useState('');
  const [kind, setKind] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);

  const [stats, setStats] = useState<ProductsSummary | null>(null);
  const [categories, setCategories] = useState<CategoryView[]>([]);

  /* ------------------------------- Modales -------------------------------- */
  // Un état booléen par modale : aucune modale pilotée par une chaîne « mode ».
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [productToEdit, setProductToEdit] = useState<ProductView | null>(null);
  const [showDeactivateModal, setShowDeactivateModal] = useState(false);
  const [productToDeactivate, setProductToDeactivate] = useState<ProductView | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  /* --------------------------------- Chargement ---------------------------- */

  const load = useCallback(async () => {
    // Toute requête annulable l'est : pas de « réponse du passé » qui écrase une
    // saisie plus récente (§5).
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search.trim()) params.set('search', search.trim());
      if (categoryId) params.set('categoryId', categoryId);
      if (kind) params.set('kind', kind);
      if (lowStockOnly) params.set('lowStock', 'true');
      if (includeInactive) params.set('includeInactive', 'true');

      const response = await fetch(`/api/produits?${params.toString()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Chargement du catalogue impossible'));
      }

      const payload = await response.json();
      if (controller.signal.aborted) return;

      setItems((payload.data ?? []) as ProductView[]);
      setTotal(Number(payload.total ?? 0));

      const pages = Number(payload.totalPages ?? 1) || 1;
      setTotalPages(pages);

      // Une page restaurée devenue hors bornes (liste rétrécie) est corrigée.
      const clamped = clampPage(page, pages);
      if (clamped !== null) setPage(clamped);
    } catch (loadError: any) {
      if (loadError?.name === 'AbortError') return;
      setError(loadError?.message ?? 'Chargement du catalogue impossible');
    } finally {
      if (abortRef.current === controller) setIsLoading(false);
    }
  }, [page, search, categoryId, kind, lowStockOnly, includeInactive]);

  /** Compteurs et catégories : jamais bloquants pour l'affichage de la liste. */
  const loadSummary = useCallback(async () => {
    try {
      const [statsResponse, categoriesResponse] = await Promise.all([
        fetch('/api/produits/stats', { cache: 'no-store', credentials: 'same-origin' }),
        fetch('/api/produits/categories?includeInactive=true&limit=200', {
          cache: 'no-store',
          credentials: 'same-origin',
        }),
      ]);

      if (statsResponse.ok) setStats((await statsResponse.json()) as ProductsSummary);
      if (categoriesResponse.ok) {
        const payload = await categoriesResponse.json();
        setCategories((payload.data ?? []) as CategoryView[]);
      }
    } catch {
      // Un compteur indisponible ne doit pas transformer la page en écran blanc.
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), loadSummary()]);
  }, [load, loadSummary]);

  /* ------------------- Restauration d'état au retour arrière ---------------- */

  const rehydrated = useViewStateRehydration<ProductsViewState>('produits', (saved) => {
    if (saved.search !== undefined) setSearch(saved.search);
    if (saved.page) setPage(saved.page);
    if (saved.categoryId !== undefined) setCategoryId(saved.categoryId);
    if (saved.kind !== undefined) setKind(saved.kind);
    if (saved.lowStockOnly !== undefined) setLowStockOnly(saved.lowStockOnly);
    if (saved.includeInactive !== undefined) setIncludeInactive(saved.includeInactive);
  });

  useEffect(() => {
    if (!rehydrated) return; // ⚠️ sans ce garde-fou : page 1 puis page 3
    void loadSummary();
  }, [rehydrated, loadSummary]);

  useEffect(() => {
    if (!rehydrated) return;
    const timer = setTimeout(() => {
      void load();
    }, 300); // débounce de la recherche
    return () => clearTimeout(timer);
  }, [rehydrated, load]);

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState<ProductsViewState>('produits', {
      search,
      page,
      categoryId,
      kind,
      lowStockOnly,
      includeInactive,
    });
  }, [rehydrated, search, page, categoryId, kind, lowStockOnly, includeInactive]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /* --------------------------------- Actions ------------------------------- */

  const openEditModal = (product: ProductView) => {
    setProductToEdit(product);
    setShowEditModal(true);
  };

  const openDeactivateModal = (product: ProductView) => {
    setProductToDeactivate(product);
    setShowDeactivateModal(true);
  };

  const confirmDeactivate = async () => {
    const target = productToDeactivate;
    if (!target) return;

    setIsDeactivating(true);
    try {
      const response = await fetch(`/api/produits/${target.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Désactivation impossible'));
      }

      toast.success(`« ${target.name} » a été désactivé`);
      setShowDeactivateModal(false);
      setProductToDeactivate(null);
      await refreshAll();
    } catch (deactivateError: any) {
      toast.error(deactivateError?.message ?? 'Désactivation impossible', { autoClose: 8000 });
    } finally {
      setIsDeactivating(false);
    }
  };

  const reactivate = async (product: ProductView) => {
    try {
      const response = await fetch(`/api/produits/${product.id}?reactivate=true`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Réactivation impossible'));
      }

      toast.success(`« ${product.name} » est de nouveau actif`);
      await refreshAll();
    } catch (reactivateError: any) {
      toast.error(reactivateError?.message ?? 'Réactivation impossible', { autoClose: 8000 });
    }
  };

  /* -------------------------------- Rendu ---------------------------------- */

  const categoryOptions = useMemo(
    () => categories.filter((c) => c.isActive).map((c) => ({ value: String(c.id), label: c.name })),
    [categories],
  );

  const kindOptions = useMemo(
    () => CATEGORY_KIND_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    [],
  );

  const hasFilters = Boolean(
    search.trim() || categoryId || kind || lowStockOnly || includeInactive,
  );

  /** Des produits existent, mais tous sont désactivés (filtre « actifs » par défaut). */
  const onlyInactive = !hasFilters && total === 0 && (stats?.totalProducts ?? 0) > 0;

  const activeSecondaryCount = [lowStockOnly, includeInactive].filter(Boolean).length;

  const columns: Column<ProductView>[] = useMemo(
    () => [
      /*
       * La colonne « Code » est retirée (demande client) : le **nom** est
       * l'identifiant du produit, et il est unique. Le code interne reste généré
       * côté serveur comme référence technique, mais ne s'affiche plus.
       */
      {
        key: 'name',
        label: 'Nom',
        primary: true,
        render: (product) => (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium">{product.name}</span>
            {!product.isActive && <Badge tone="neutral">Désactivé</Badge>}
          </div>
        ),
      },
      {
        key: 'category',
        label: 'Catégorie',
        hideOnMobile: true,
        render: (product) =>
          product.categoryName ? (
            <div className="flex flex-col">
              <span>{product.categoryName}</span>
              {product.categoryKind && (
                <span className="text-xs text-base-content/50">
                  {CATEGORY_KIND_LABELS[product.categoryKind]}
                </span>
              )}
            </div>
          ) : (
            <span className="text-base-content/50">Sans catégorie</span>
          ),
      },
      {
        key: 'unit',
        label: 'Unité',
        render: (product) => product.unit,
      },
      {
        key: 'purchasePrice',
        label: 'Prix d’achat',
        render: (product) => <MoneyText value={product.purchasePrice} currency={currency} />,
      },
      {
        key: 'salePrice',
        label: 'Prix de vente',
        render: (product) => <MoneyText value={product.salePrice} currency={currency} />,
      },
      {
        key: 'stock',
        label: 'Stock',
        render: (product) => (
          <div className="flex flex-wrap items-center gap-2">
            <QuantityText value={product.stock} unit={product.unit} />
            <StockBadge product={product} />
          </div>
        ),
      },
      {
        key: 'stockValue',
        label: 'Valeur',
        hideOnMobile: true,
        render: (product) => <MoneyText value={product.stockValue} currency={currency} />,
      },
    ],
    [currency],
  );

  const renderActions = (product: ProductView) => (
    <RowActions>
      {canUpdate && (
        <IconAction
          icon="edit"
          label="Modifier le produit"
          onClick={() => openEditModal(product)}
        />
      )}

      {product.isActive && (
        <IconAction
          icon="adjust"
          label="Ajuster le stock (mouvement d’inventaire)"
          href={`/stocks?productId=${product.id}`}
        />
      )}

      {canDelete &&
        (product.isActive ? (
          <IconAction
            icon="deactivate"
            tone="danger"
            label="Désactiver le produit"
            onClick={() => openDeactivateModal(product)}
          />
        ) : (
          <IconAction
            icon="activate"
            tone="success"
            label="Réactiver le produit"
            onClick={() => void reactivate(product)}
          />
        ))}
    </RowActions>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Gestion"
        title="Produits"
        description="Catalogue, prix d’achat et de vente, unités et état du stock en temps réel."
        actions={
          <RoleGate action="products.create">
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              onClick={() => setShowCreateModal(true)}
            >
              Nouveau produit
            </button>
          </RoleGate>
        }
      />

      {/* Cartes de synthèse — état de chargement : SkeletonCards */}
      {stats ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCardDelta
            label="Produits actifs"
            value={formatNumber(stats.activeProducts)}
            hint={`${formatNumber(stats.totalProducts)} au total, désactivés compris`}
            tone="primary"
          />
          <StatCardDelta
            label="Catégories actives"
            value={formatNumber(stats.categoriesCount)}
            hint="Le type est porté par la catégorie"
            tone="info"
          />
          <StatCardDelta
            label="Stock faible"
            value={formatNumber(stats.lowStockCount)}
            hint="Seuil d’alerte atteint"
            tone="warning"
          />
          <StatCardDelta
            label="En rupture"
            value={formatNumber(stats.outOfStockCount)}
            hint="Stock nul"
            tone="error"
          />
          <StatCardDelta
            label="Valeur du stock (achat)"
            value={<MoneyText value={stats.stockPurchaseValue} currency={currency} />}
            hint="Stock × prix d’achat"
            tone="neutral"
          />
          <StatCardDelta
            label="Valeur du stock (vente)"
            value={<MoneyText value={stats.stockSaleValue} currency={currency} />}
            hint="Stock × prix de vente"
            tone="success"
          />
        </div>
      ) : isLoading ? (
        <SkeletonCards count={6} />
      ) : null}

      {/* Aperçu des alertes de stock (§4) */}
      {stats && (stats.lowStockCount > 0 || stats.outOfStockCount > 0) && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
          <span>
            <strong>{formatNumber(stats.lowStockCount)}</strong> produit(s) en stock faible et{' '}
            <strong>{formatNumber(stats.outOfStockCount)}</strong> en rupture.
          </span>
          {!lowStockOnly && (
            <button
              type="button"
              className="btn btn-sm btn-outline min-h-11 sm:min-h-0"
              onClick={() => {
                setLowStockOnly(true);
                setPage(1);
              }}
            >
              Voir les alertes
            </button>
          )}
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un nom ou une description…"
        filters={
          <>
            <div className="w-full sm:w-52">
              <FilterSelect
                value={categoryId}
                onChange={(value) => {
                  setCategoryId(value);
                  setPage(1);
                }}
                options={categoryOptions}
                placeholder="Toutes catégories"
              />
            </div>
            <div className="w-full sm:w-44">
              <FilterSelect
                value={kind}
                onChange={(value) => {
                  setKind(value);
                  setPage(1);
                }}
                options={kindOptions}
                placeholder="Tous les types"
              />
            </div>
          </>
        }
        secondaryFilters={
          <>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="toggle toggle-sm toggle-warning"
                checked={lowStockOnly}
                onChange={(event) => {
                  setLowStockOnly(event.target.checked);
                  setPage(1);
                }}
              />
              Stock faible uniquement
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="toggle toggle-sm toggle-primary"
                checked={includeInactive}
                onChange={(event) => {
                  setIncludeInactive(event.target.checked);
                  setPage(1);
                }}
              />
              Inclure les produits désactivés
            </label>
          </>
        }
        secondaryCount={activeSecondaryCount}
        actions={
          <Link
            href="/produits/categories"
            className="btn btn-sm btn-ghost min-h-11 border border-base-300 sm:min-h-0"
          >
            Catégories
          </Link>
        }
      />

      {/* Les 5 états : chargement, erreur, vide, nominal, feedback (toast) */}
      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <Card padded={false}>
          <ErrorState
            title="Catalogue indisponible"
            description={error}
            onRetry={() => void load()}
          />
        </Card>
      ) : total === 0 ? (
        <Card padded={false}>
          <EmptyState
            title={
              hasFilters
                ? 'Aucun produit ne correspond'
                : onlyInactive
                  ? 'Aucun produit actif'
                  : 'Aucun produit au catalogue'
            }
            description={
              hasFilters
                ? 'Élargissez la recherche ou retirez un filtre pour retrouver vos articles.'
                : onlyInactive
                  ? 'Tous les produits enregistrés sont désactivés : affichez-les pour en réactiver un.'
                  : 'Commencez par créer une catégorie, puis votre premier produit : code généré, prix d’achat et de vente, unité et seuil d’alerte.'
            }
            action={
              hasFilters ? (
                <button
                  type="button"
                  className="btn btn-outline btn-sm min-h-11 sm:min-h-0"
                  onClick={() => {
                    setSearch('');
                    setCategoryId('');
                    setKind('');
                    setLowStockOnly(false);
                    setIncludeInactive(false);
                    setPage(1);
                  }}
                >
                  Réinitialiser les filtres
                </button>
              ) : onlyInactive ? (
                <button
                  type="button"
                  className="btn btn-outline btn-sm min-h-11 sm:min-h-0"
                  onClick={() => {
                    setIncludeInactive(true);
                    setPage(1);
                  }}
                >
                  Afficher les produits désactivés
                </button>
              ) : (
                canCreate && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm min-h-11 sm:min-h-0"
                    onClick={() => setShowCreateModal(true)}
                  >
                    Créer le premier produit
                  </button>
                )
              )
            }
          />
        </Card>
      ) : (
        <>
          <ResponsiveTable<ProductView>
            columns={columns}
            data={items}
            getRowKey={(product) => product.id}
            actions={renderActions}
            actionsClassName="w-56"
            emptyMessage="Aucun produit."
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-base-content/50">
              {formatNumber(total)} produit(s) au catalogue
            </p>
            <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          </div>
        </>
      )}

      {/* ------------------------------ Modales ------------------------------ */}

      <ProductFormModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSaved={refreshAll}
        product={null}
        categories={categories.filter((c) => c.isActive)}
        units={units}
      />

      <ProductFormModal
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setProductToEdit(null);
        }}
        onSaved={refreshAll}
        product={productToEdit}
        categories={categories.filter((c) => c.isActive)}
        units={units}
      />

      <ConfirmDialog
        isOpen={showDeactivateModal}
        onClose={() => {
          if (!isDeactivating) {
            setShowDeactivateModal(false);
            setProductToDeactivate(null);
          }
        }}
        onConfirm={() => void confirmDeactivate()}
        title="Désactiver le produit"
        tone="error"
        confirmLabel="Désactiver"
        isSubmitting={isDeactivating}
        message={
          productToDeactivate ? (
            <>
              <p>
                « <strong>{productToDeactivate.name}</strong> » ({productToDeactivate.code}) ne sera
                plus proposé à la vente ni dans les listes. <strong>Aucune donnée n’est supprimée</strong> :
                les factures anciennes restent lisibles et le produit peut être réactivé.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <MiniStat
                  label="Stock actuel"
                  value={<QuantityText value={productToDeactivate.stock} unit={productToDeactivate.unit} />}
                  tone="neutral"
                />
                <MiniStat
                  label="Valeur du stock"
                  value={<MoneyText value={productToDeactivate.stockValue} currency={currency} />}
                  tone="neutral"
                />
                <MiniStat
                  label="État"
                  value={<StockBadge product={productToDeactivate} />}
                  tone={productToDeactivate.isOut ? 'error' : productToDeactivate.isLow ? 'warning' : 'success'}
                />
              </div>
              {productToDeactivate.stock > 0 && (
                <p className="mt-3">
                  Ce produit conserve <strong>du stock</strong> : il reste consultable depuis le
                  catalogue (filtre « Inclure les produits désactivés ») et les mouvements existants
                  sont intacts.
                </p>
              )}
            </>
          ) : (
            'Confirmez la désactivation du produit.'
          )
        }
      />
    </div>
  );
}
