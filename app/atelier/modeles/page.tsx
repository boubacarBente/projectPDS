'use client';

/**
 * Modèles de meubles et nomenclatures (README §29, page `/atelier/modeles`).
 *
 * Chaque magasin a **son** catalogue de modèles. La nomenclature d'un modèle
 * (matières pour une unité) donne les besoins d'une commande, calculés sur le
 * stock du magasin. Un modèle ne se modifie que depuis son magasin, avec la
 * permission `furniture.models` ; ailleurs, la nomenclature se consulte.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { IconAction, RowActions } from '@/components/row-actions';
import { Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { EmptyState, ErrorState, MoneyText, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { StoreScopeSelect, StoreTag, scopeShowsStore, useStoreScope } from '@/components/store-scope';
import { useViewStateRehydration, writeViewState, clampPage } from '@/lib/view-state';
import type { FurnitureModelMaterialRow, FurnitureModelRow } from '@/lib/furniture';
import { formatNumber } from '@/lib/format';
import {
  DeactivateModelDialog,
  FurnitureBomModal,
  FurnitureModelFormModal,
  fetchProducts,
  modelColumns,
  readApiError,
  type ProductOption,
} from '@/components/atelier/atelier-modals';

const MODELS_LIMIT = 20;
const VIEW_NAME = 'atelier-modeles';

type ModelsViewState = { search: string; includeInactive: boolean; page: number };

type Paginated<T> = { data: T[]; total: number; page: number; limit: number; totalPages: number };

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as any)?.error ?? 'Requête impossible');
  return payload as T;
}

export default function AtelierModelesPage() {
  const canManage = usePermission('furniture.models');
  const { activeStoreId } = useAuth();
  const { scope, setScope, apply } = useStoreScope('atelier-modeles');
  const storeParam = apply(new URLSearchParams()).get('store') ?? undefined;
  const showStore = scopeShowsStore(scope);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);

  const [models, setModels] = useState<FurnitureModelRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [isOptionsLoading, setIsOptionsLoading] = useState(false);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<FurnitureModelRow | null>(null);
  const [isBomOpen, setIsBomOpen] = useState(false);
  const [bomModel, setBomModel] = useState<FurnitureModelRow | null>(null);
  const [isDeactivateOpen, setIsDeactivateOpen] = useState(false);
  const [deactivateModel, setDeactivateModel] = useState<FurnitureModelRow | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);

  const canEdit = (model: FurnitureModelRow) => canManage && model.storeId === activeStoreId;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* Produits du magasin actif : nécessaires seulement pour modifier une nomenclature. */
  useEffect(() => {
    if (!isBomOpen || !bomModel || !canEdit(bomModel)) return;
    const controller = new AbortController();
    setIsOptionsLoading(true);
    fetchProducts(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setProducts(list);
      })
      .catch(() => {
        if (!controller.signal.aborted) setProducts([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsOptionsLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBomOpen, bomModel?.id]);

  const rehydrated = useViewStateRehydration<ModelsViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.includeInactive !== undefined) setIncludeInactive(saved.includeInactive);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: String(MODELS_LIMIT) });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (includeInactive) params.set('includeInactive', 'true');
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/atelier/modeles?${params.toString()}`, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      .then((response) => readJson<Paginated<FurnitureModelRow>>(response))
      .then((payload) => {
        if (controller.signal.aborted) return;
        setModels(Array.isArray(payload.data) ? payload.data : []);
        setTotal(Number(payload.total ?? 0));
        setTotalPages(Number(payload.totalPages ?? 1) || 1);
        const corrected = clampPage(page, Number(payload.totalPages ?? 1) || 1);
        if (corrected !== null) setPage(corrected);
      })
      .catch((caught: any) => {
        if (caught?.name === 'AbortError') return;
        setError(caught?.message ?? 'Chargement des modèles impossible');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [rehydrated, debouncedSearch, includeInactive, page, storeParam, reloadToken]);

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, includeInactive, page });
  }, [rehydrated, search, includeInactive, page]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const summary = useMemo(() => {
    const withBom = models.filter((model) => model.materialCount > 0).length;
    const avgSalePrice = models.length > 0 ? models.reduce((sum, model) => sum + model.salePrice, 0) / models.length : 0;
    return { withBom, withoutBom: models.length - withBom, avgSalePrice };
  }, [models]);

  const columns = useMemo<Column<FurnitureModelRow>[]>(
    () =>
      modelColumns.map((column) =>
        column.key === 'name'
          ? {
              ...column,
              render: (model: FurnitureModelRow) => (
                <div className="min-w-0">
                  {column.render(model)}
                  <StoreTag name={model.storeName} show={showStore} />
                </div>
              ),
            }
          : column,
      ),
    [showStore],
  );

  function openCreate() {
    setEditingModel(null);
    setIsFormOpen(true);
  }

  async function reactivate(model: FurnitureModelRow) {
    try {
      const response = await fetch(`/api/atelier/modeles/${model.id}?reactivate=true`, { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok) throw new Error(await readApiError(response, 'Réactivation impossible.'));
      toast.success(`Modèle « ${model.name} » réactivé.`);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Réactivation impossible.');
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Atelier"
        title="Modèles de meubles"
        description="Fiches modèles du magasin et leurs nomenclatures : les matières d'une commande se calculent depuis ces listes, jamais ressaisies."
        actions={
          <>
            <Link href="/atelier" className="btn btn-ghost min-h-11 border border-base-300">
              Commandes
            </Link>
            {canManage && (
              <button type="button" className="btn btn-primary min-h-11" onClick={openCreate}>
                Nouveau modèle
              </button>
            )}
          </>
        }
      />

      {isLoading && models.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="skeleton h-24 w-full rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardDelta
            label="Modèles"
            tooltip="Nombre de modèles de meubles correspondant aux filtres, dans les magasins affichés."
            tone="primary"
            value={formatNumber(total)}
            hint={includeInactive ? 'Inactifs compris' : 'Modèles actifs'}
          />
          <StatCardDelta
            label="Nomenclatures prêtes"
            tooltip="Modèles de cette page dont la liste de matières est renseignée : leurs commandes calculent seules les matières nécessaires."
            tone="success"
            value={formatNumber(summary.withBom)}
            hint="Besoins calculés automatiquement"
          />
          <StatCardDelta
            label="À compléter"
            tooltip="Modèles de cette page sans liste de matières : il faudra saisir leurs matières à la main sur chaque commande."
            tone={summary.withoutBom > 0 ? 'warning' : 'success'}
            value={formatNumber(summary.withoutBom)}
            hint="Nomenclature vide"
          />
          <StatCardDelta
            label="Prix de vente moyen"
            tooltip="Moyenne des prix de vente indicatifs des modèles de cette page. Le prix réel se convient avec le client sur chaque commande."
            tone="info"
            value={<MoneyText value={summary.avgSalePrice} />}
            hint="Prix indicatif"
          />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un code ou un nom de modèle…"
        filters={
          <StoreScopeSelect
            value={scope}
            onChange={(value) => {
              setScope(value);
              setPage(1);
            }}
            className="min-h-11 w-full sm:w-52"
          />
        }
        secondaryFilters={
          <button
            type="button"
            onClick={() => {
              setIncludeInactive((current) => !current);
              setPage(1);
            }}
            aria-pressed={includeInactive}
            className={`btn min-h-11 ${includeInactive ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
          >
            Afficher les modèles inactifs
          </button>
        }
        secondaryCount={includeInactive ? 1 : 0}
      />

      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <ErrorState title="Chargement des modèles impossible" description={error} onRetry={refresh} />
      ) : models.length === 0 ? (
        <EmptyState
          title="Aucun modèle de meuble"
          description={
            debouncedSearch || includeInactive
              ? 'Aucun modèle ne correspond à ces filtres.'
              : 'Créez une fiche modèle puis renseignez sa nomenclature : chaque commande calculera ses matières à partir d’elle.'
          }
          action={
            canManage ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={openCreate}>
                Créer le premier modèle
              </button>
            ) : (
              <Link href="/atelier" className="btn btn-primary min-h-11">
                Voir les commandes
              </Link>
            )
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={columns}
            data={models}
            getRowKey={(model) => model.id}
            actions={(model) => (
              <RowActions>
                <IconAction
                  icon="list"
                  tone="primary"
                  label={`Nomenclature de ${model.name}`}
                  onClick={() => {
                    setBomModel(model);
                    setIsBomOpen(true);
                  }}
                />
                {canEdit(model) && (
                  <IconAction
                    icon="edit"
                    label={`Modifier ${model.name}`}
                    onClick={() => {
                      setEditingModel(model);
                      setIsFormOpen(true);
                    }}
                  />
                )}
                {canEdit(model) && model.isActive && (
                  <IconAction
                    icon="deactivate"
                    tone="danger"
                    label={`Désactiver ${model.name}`}
                    onClick={() => {
                      setDeactivateModel(model);
                      setIsDeactivateOpen(true);
                    }}
                  />
                )}
                {canEdit(model) && !model.isActive && (
                  <IconAction icon="activate" tone="success" label={`Réactiver ${model.name}`} onClick={() => void reactivate(model)} />
                )}
              </RowActions>
            )}
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/60">
            {formatNumber(total)} modèle{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

      <FurnitureModelFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSaved={(model: FurnitureModelRow) => {
          toast.success(editingModel ? `Modèle « ${model.name} » enregistré.` : `Modèle « ${model.name} » créé.`);
          setIsFormOpen(false);
          const created = !editingModel;
          setEditingModel(null);
          refresh();
          // Un modèle sans nomenclature ne sert à rien : on enchaîne sur elle.
          if (created) {
            setBomModel(model);
            setIsBomOpen(true);
          }
        }}
        model={editingModel}
        idPrefix={editingModel ? 'edit' : 'create'}
      />

      <FurnitureBomModal
        isOpen={isBomOpen}
        onClose={() => setIsBomOpen(false)}
        onSaved={(materials: FurnitureModelMaterialRow[]) => {
          toast.success(`Nomenclature enregistrée — ${materials.length} matière${materials.length > 1 ? 's' : ''}.`);
          setIsBomOpen(false);
          setBomModel(null);
          refresh();
        }}
        model={bomModel}
        products={products}
        isOptionsLoading={isOptionsLoading}
        readOnly={!bomModel || !canEdit(bomModel)}
      />

      <DeactivateModelDialog
        isOpen={isDeactivateOpen}
        onClose={() => setIsDeactivateOpen(false)}
        onConfirm={async () => {
          if (!deactivateModel) return;
          setIsDeactivating(true);
          try {
            const response = await fetch(`/api/atelier/modeles/${deactivateModel.id}`, { method: 'DELETE', credentials: 'same-origin' });
            if (!response.ok) throw new Error(await readApiError(response, 'Désactivation impossible.'));
            toast.success(`Modèle « ${deactivateModel.name} » désactivé.`);
            setIsDeactivateOpen(false);
            setDeactivateModel(null);
            refresh();
          } catch (caught) {
            toast.error(caught instanceof Error ? caught.message : 'Désactivation impossible.');
          } finally {
            setIsDeactivating(false);
          }
        }}
        model={deactivateModel}
        isSubmitting={isDeactivating}
      />
    </div>
  );
}
