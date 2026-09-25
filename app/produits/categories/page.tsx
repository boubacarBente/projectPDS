'use client';

/**
 * Catégories du catalogue (§6.3, §7.4).
 *
 * Le **type** appartient à la catégorie (`finished` | `raw_material` |
 * `service`) : cette page est donc le seul endroit où le type d'un article se
 * paramètre. Une catégorie qui contient encore des produits actifs ne peut pas
 * être désactivée — le serveur le refuse (409) et l'écran l'explique avant
 * d'essayer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { RoleGate, usePermission } from '@/components/role-gate';
import {
  CATEGORY_KIND_LABELS,
  CATEGORY_KIND_OPTIONS,
  CategoryFormModal,
  readApiError,
  type CategoryView,
} from '@/components/produits/produits-modals';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatNumber, truncate } from '@/lib/format';

const PAGE_SIZE = 20;
/** Les catégories sont peu nombreuses : une seule requête suffit au filtrage local. */
const FETCH_LIMIT = 500;

type CategoriesViewState = {
  search: string;
  page: number;
  kind: string;
  includeInactive: boolean;
};

export default function ProduitsCategoriesPage() {
  const canCreate = usePermission('products.create');
  const canUpdate = usePermission('products.update');
  const canDelete = usePermission('products.delete');

  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  // Un état booléen par modale.
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [categoryToEdit, setCategoryToEdit] = useState<CategoryView | null>(null);
  const [showDeactivateModal, setShowDeactivateModal] = useState(false);
  const [categoryToDeactivate, setCategoryToDeactivate] = useState<CategoryView | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/produits/categories?includeInactive=true&limit=${FETCH_LIMIT}`,
        { cache: 'no-store', credentials: 'same-origin', signal: controller.signal },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Chargement des catégories impossible'));
      }

      const payload = await response.json();
      if (controller.signal.aborted) return;

      setCategories((payload.data ?? []) as CategoryView[]);
    } catch (loadError: any) {
      if (loadError?.name === 'AbortError') return;
      setError(loadError?.message ?? 'Chargement des catégories impossible');
    } finally {
      if (abortRef.current === controller) setIsLoading(false);
    }
  }, []);

  /* ------------------- Restauration d'état au retour arrière ---------------- */

  const rehydrated = useViewStateRehydration<CategoriesViewState>(
    'produits-categories',
    (saved) => {
      if (saved.search !== undefined) setSearch(saved.search);
      if (saved.page) setPage(saved.page);
      if (saved.kind !== undefined) setKind(saved.kind);
      if (saved.includeInactive !== undefined) setIncludeInactive(saved.includeInactive);
    },
  );

  useEffect(() => {
    if (!rehydrated) return; // ⚠️ gate du premier fetch
    void load();
  }, [rehydrated, load]);

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState<CategoriesViewState>('produits-categories', {
      search,
      page,
      kind,
      includeInactive,
    });
  }, [rehydrated, search, page, kind, includeInactive]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /* -------------------------------- Filtrage ------------------------------- */

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return categories.filter((category) => {
      if (!includeInactive && !category.isActive) return false;
      if (kind && category.kind !== kind) return false;
      if (term) {
        const haystack = `${category.name} ${category.description ?? ''}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [categories, search, kind, includeInactive]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const visible = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE),
    [filtered, page],
  );

  // Une page restaurée devenue hors bornes (liste rétrécie) est corrigée.
  useEffect(() => {
    const clamped = clampPage(page, totalPages);
    if (clamped !== null) setPage(clamped);
  }, [page, totalPages]);

  /* -------------------------------- Synthèse ------------------------------- */

  const summary = useMemo(() => {
    const active = categories.filter((c) => c.isActive);
    return {
      activeCount: active.length,
      inactiveCount: categories.length - active.length,
      coveredProducts: active.reduce((sum, c) => sum + c.activeProductCount, 0),
      finished: active.filter((c) => c.kind === 'finished').length,
      rawMaterial: active.filter((c) => c.kind === 'raw_material').length,
      service: active.filter((c) => c.kind === 'service').length,
    };
  }, [categories]);

  /* --------------------------------- Actions ------------------------------- */

  const openDeactivateModal = (category: CategoryView) => {
    // Refus annoncé **avant** l'appel : le message dit précisément quoi faire.
    if (category.activeProductCount > 0) {
      toast.info(
        `« ${category.name} » contient ${formatNumber(category.activeProductCount)} produit(s) actif(s) : ` +
          'déplacez-les vers une autre catégorie ou désactivez-les avant de désactiver cette catégorie.',
        { autoClose: 9000 },
      );
      return;
    }

    setCategoryToDeactivate(category);
    setShowDeactivateModal(true);
  };

  const confirmDeactivate = async () => {
    const target = categoryToDeactivate;
    if (!target) return;

    setIsDeactivating(true);
    try {
      const response = await fetch(`/api/produits/categories/${target.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Désactivation impossible'));
      }

      toast.success(`Catégorie « ${target.name} » désactivée`);
      setShowDeactivateModal(false);
      setCategoryToDeactivate(null);
      await load();
    } catch (deactivateError: any) {
      toast.error(deactivateError?.message ?? 'Désactivation impossible', { autoClose: 9000 });
    } finally {
      setIsDeactivating(false);
    }
  };

  const reactivate = async (category: CategoryView) => {
    try {
      const response = await fetch(`/api/produits/categories/${category.id}?reactivate=true`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Réactivation impossible'));
      }

      toast.success(`Catégorie « ${category.name} » réactivée`);
      await load();
    } catch (reactivateError: any) {
      toast.error(reactivateError?.message ?? 'Réactivation impossible', { autoClose: 8000 });
    }
  };

  /* --------------------------------- Rendu --------------------------------- */

  const kindOptions = useMemo(
    () => CATEGORY_KIND_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    [],
  );

  const hasFilters = Boolean(search.trim() || kind);
  /** Des catégories existent, mais elles sont masquées par le filtre « actives ». */
  const hiddenInactive = !includeInactive && categories.some((category) => !category.isActive);

  const columns: Column<CategoryView>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Nom',
        primary: true,
        render: (category) => (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium">{category.name}</span>
            <Badge tone={category.isActive ? 'success' : 'neutral'}>
              {category.isActive ? 'Active' : 'Désactivée'}
            </Badge>
          </div>
        ),
      },
      {
        key: 'kind',
        label: 'Type',
        render: (category) => <Badge tone="primary">{CATEGORY_KIND_LABELS[category.kind]}</Badge>,
      },
      {
        key: 'description',
        label: 'Description',
        hideOnMobile: true,
        render: (category) => (
          <span className="text-base-content/70">{truncate(category.description, 60)}</span>
        ),
      },
      {
        key: 'products',
        label: 'Produits',
        render: (category) => (
          <span className="tabular">
            {formatNumber(category.activeProductCount)}
            {category.productCount !== category.activeProductCount && (
              <span className="text-base-content/50">
                {' '}
                / {formatNumber(category.productCount)} au total
              </span>
            )}
          </span>
        ),
      },
    ],
    [],
  );

  const renderActions = (category: CategoryView) => (
    <RowActions>
      {canUpdate && (
        <IconAction
          icon="edit"
          label="Modifier la catégorie"
          onClick={() => {
            setCategoryToEdit(category);
            setShowEditModal(true);
          }}
        />
      )}

      {canDelete &&
        (category.isActive ? (
          <IconAction
            icon="deactivate"
            tone="danger"
            label={
              category.activeProductCount > 0
                ? `Impossible : ${category.activeProductCount} produit(s) actif(s) rattaché(s)`
                : 'Désactiver la catégorie'
            }
            onClick={() => openDeactivateModal(category)}
          />
        ) : (
          <IconAction
            icon="activate"
            tone="success"
            label="Réactiver la catégorie"
            onClick={() => void reactivate(category)}
          />
        ))}
    </RowActions>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Gestion"
        title="Catégories de produits"
        description="Le type — produit fini, matière première ou service — est porté par la catégorie : un seul endroit à paramétrer."
        actions={
          <RoleGate action="products.create">
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              onClick={() => setShowCreateModal(true)}
            >
              Nouvelle catégorie
            </button>
          </RoleGate>
        }
      />

      {/* Cartes de synthèse — chargement : SkeletonCards */}
      {isLoading && categories.length === 0 ? (
        <SkeletonCards count={4} />
      ) : error ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCardDelta
            label="Catégories actives"
            value={formatNumber(summary.activeCount)}
            hint={`${formatNumber(summary.inactiveCount)} désactivée(s)`}
            tone="primary"
          />
          <StatCardDelta
            label="Produits rattachés"
            value={formatNumber(summary.coveredProducts)}
            hint="Produits actifs classés"
            tone="info"
          />
          <StatCardDelta
            label="Produits finis · Matières premières"
            value={`${formatNumber(summary.finished)} · ${formatNumber(summary.rawMaterial)}`}
            hint="Répartition par type"
            tone="neutral"
          />
          <StatCardDelta
            label="Services"
            value={formatNumber(summary.service)}
            hint="Prestations vendues à la journée ou au forfait"
            tone="success"
          />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher une catégorie…"
        filters={
          <div className="w-full sm:w-48">
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
        }
        secondaryFilters={
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
            Inclure les catégories désactivées
          </label>
        }
        secondaryCount={includeInactive ? 0 : 1}
      />

      {/* Les 5 états : chargement, erreur, vide, nominal, feedback (toast) */}
      {isLoading && categories.length === 0 ? (
        <SkeletonTable rows={5} cols={4} />
      ) : error ? (
        <Card padded={false}>
          <ErrorState
            title="Catégories indisponibles"
            description={error}
            onRetry={() => void load()}
          />
        </Card>
      ) : filtered.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title={
              hasFilters
                ? 'Aucune catégorie ne correspond'
                : hiddenInactive
                  ? 'Aucune catégorie active'
                  : 'Aucune catégorie enregistrée'
            }
            description={
              hasFilters
                ? 'Élargissez la recherche ou retirez le filtre de type.'
                : hiddenInactive
                  ? 'Toutes les catégories enregistrées sont désactivées : affichez-les pour en réactiver une.'
                  : 'Créez vos catégories (Meuble, Brique, Alucobond, Staff, Placo, Peinture, Bois, Quincaillerie…) : chaque produit en hérite le type.'
            }
            action={
              hasFilters ? (
                <button
                  type="button"
                  className="btn btn-outline btn-sm min-h-11 sm:min-h-0"
                  onClick={() => {
                    setSearch('');
                    setKind('');
                    setIncludeInactive(true);
                    setPage(1);
                  }}
                >
                  Réinitialiser les filtres
                </button>
              ) : hiddenInactive ? (
                <button
                  type="button"
                  className="btn btn-outline btn-sm min-h-11 sm:min-h-0"
                  onClick={() => {
                    setIncludeInactive(true);
                    setPage(1);
                  }}
                >
                  Afficher les catégories désactivées
                </button>
              ) : (
                canCreate && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm min-h-11 sm:min-h-0"
                    onClick={() => setShowCreateModal(true)}
                  >
                    Créer la première catégorie
                  </button>
                )
              )
            }
          />
        </Card>
      ) : (
        <>
          <ResponsiveTable<CategoryView>
            columns={columns}
            data={visible}
            getRowKey={(category) => category.id}
            actions={renderActions}
            actionsClassName="w-48"
            emptyMessage="Aucune catégorie."
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-base-content/50">
              {formatNumber(filtered.length)} catégorie(s)
            </p>
            <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          </div>
        </>
      )}

      {/* ------------------------------ Modales ------------------------------ */}

      <CategoryFormModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSaved={load}
        category={null}
      />

      <CategoryFormModal
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setCategoryToEdit(null);
        }}
        onSaved={load}
        category={categoryToEdit}
      />

      <ConfirmDialog
        isOpen={showDeactivateModal}
        onClose={() => {
          if (!isDeactivating) {
            setShowDeactivateModal(false);
            setCategoryToDeactivate(null);
          }
        }}
        onConfirm={() => void confirmDeactivate()}
        title="Désactiver la catégorie"
        tone="error"
        confirmLabel="Désactiver"
        isSubmitting={isDeactivating}
        message={
          categoryToDeactivate ? (
            <>
              « <strong>{categoryToDeactivate.name}</strong> » —{' '}
              {CATEGORY_KIND_LABELS[categoryToDeactivate.kind]} — ne sera plus proposée dans les
              sélecteurs de produits. <strong>Aucune donnée n’est supprimée</strong> : la catégorie
              peut être réactivée à tout moment.
            </>
          ) : (
            'Confirmez la désactivation de la catégorie.'
          )
        }
      />
    </div>
  );
}
