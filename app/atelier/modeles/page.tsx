'use client';

/**
 * Fiches modèles et nomenclature (README §21, page `/atelier/modeles`).
 *
 * C'est ici que se joue le cœur du module : sans nomenclature, une commande
 * standard ne peut pas préremplir ses matières. La modale BOM affiche donc,
 * pour **chaque ligne**, le produit, la quantité nécessaire et le **stock
 * disponible** — ce qui rend la fiche modèle immédiatement utile.
 *
 * ⚠️ Aucun import runtime d'un module serveur : `lib/furniture.ts` n'est
 * importé qu'en `import type` (§11 bis).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  EmptyState,
  ErrorState,
  MoneyText,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useViewStateRehydration, writeViewState, clampPage } from '@/lib/view-state';
import type {
  FurnitureModelMaterialRow,
  FurnitureModelRow,
} from '@/lib/furniture';
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

type ModelsViewState = {
  search: string;
  includeInactive: boolean;
  page: number;
};

type Paginated<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as any)?.error ?? 'Requête impossible');
  return payload as T;
}

export default function AtelierModelesPage() {
  const canCreate = usePermission('furniture.create');
  const canUpdate = usePermission('furniture.update');
  const canDelete = usePermission('furniture.delete');

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
  const [isOptionsLoading, setIsOptionsLoading] = useState(true);

  /* Modales : un état booléen chacune, et le contexte associé (§8.3). */
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<FurnitureModelRow | null>(null);
  const [isBomOpen, setIsBomOpen] = useState(false);
  const [bomModel, setBomModel] = useState<FurnitureModelRow | null>(null);
  const [isDeactivateOpen, setIsDeactivateOpen] = useState(false);
  const [deactivateModel, setDeactivateModel] = useState<FurnitureModelRow | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams({
      page: String(page),
      limit: String(MODELS_LIMIT),
    });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (includeInactive) params.set('includeInactive', 'true');

    fetch(`/api/atelier/modeles?${params.toString()}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
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
  }, [debouncedSearch, includeInactive, page, reloadToken]);

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
    writeViewState(VIEW_NAME, { search, includeInactive, page });
  }, [rehydrated, search, includeInactive, page]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const summary = useMemo(() => {
    const withBom = models.filter((model) => model.materialCount > 0).length;
    const withoutBom = models.length - withBom;
    const estimatedCost = models.reduce(
      (sum, model) => sum + model.estimatedMaterialCost * 1,
      0,
    );
    const avgSalePrice =
      models.length > 0 ? models.reduce((sum, model) => sum + model.salePrice, 0) / models.length : 0;
    return { withBom, withoutBom, estimatedCost, avgSalePrice };
  }, [models]);

  const columns = useMemo<Column<FurnitureModelRow>[]>(() => modelColumns, []);

  function openCreate() {
    setEditingModel(null);
    setIsFormOpen(true);
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Production"
        title="Modèles de meubles"
        description="Fiches modèles et nomenclatures : les besoins en matières d'une commande standard se calculent depuis ces listes, jamais ressaisis."
        actions={
          <>
            <Link href="/atelier" className="btn btn-ghost min-h-11 border border-base-300 sm:min-h-0">
              Commandes
            </Link>
            {canCreate && (
              <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" onClick={openCreate}>
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
          <StatCardDelta label="Modèles affichés" tone="primary" value={total} hint="Sur cette page de filtres" />
          <StatCardDelta
            label="Nomenclatures complètes"
            tone="success"
            value={summary.withBom}
            hint="Modèles prêts à préremplir une commande"
          />
          <StatCardDelta
            label="Nomenclatures à compléter"
            tone={summary.withoutBom > 0 ? 'warning' : 'success'}
            value={summary.withoutBom}
            hint="Sans nomenclature, une commande standard n’est pas préremplie"
          />
          <StatCardDelta
            label="Prix de vente moyen"
            tone="info"
            value={<MoneyText value={summary.avgSalePrice} />}
            hint="Sur les modèles affichés"
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
              : 'Créez une fiche modèle puis renseignez sa nomenclature : chaque commande standard en héritera automatiquement.'
          }
          action={
            canCreate ? (
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
            tableClassName="table-sm"
            actions={(model) => (
              <>
                <ToolbarButton
                  variant="primary"
                  onClick={() => {
                    setBomModel(model);
                    setIsBomOpen(true);
                  }}
                >
                  Nomenclature
                </ToolbarButton>
                {canUpdate && (
                  <ToolbarButton
                    onClick={() => {
                      setEditingModel(model);
                      setIsFormOpen(true);
                    }}
                  >
                    Modifier
                  </ToolbarButton>
                )}
                {canDelete && model.isActive && (
                  <ToolbarButton
                    variant="error"
                    onClick={() => {
                      setDeactivateModel(model);
                      setIsDeactivateOpen(true);
                    }}
                  >
                    Désactiver
                  </ToolbarButton>
                )}
              </>
            )}
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/50">
            {total} modèle{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

      {/* Modale 1 : fiche modèle (création / modification) */}
      <FurnitureModelFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSaved={(model: FurnitureModelRow) => {
          toast.success(
            editingModel ? `Modèle « ${model.name} » enregistré.` : `Modèle « ${model.name} » créé.`,
          );
          setIsFormOpen(false);
          setEditingModel(null);
          refresh();
        }}
        model={editingModel}
        idPrefix={editingModel ? 'edit' : 'create'}
      />

      {/* Modale 2 : nomenclature (BOM) */}
      <FurnitureBomModal
        isOpen={isBomOpen}
        onClose={() => setIsBomOpen(false)}
        onSaved={(materials: FurnitureModelMaterialRow[]) => {
          toast.success(
            `Nomenclature enregistrée — ${materials.length} matière${materials.length > 1 ? 's' : ''}.`,
          );
          setIsBomOpen(false);
          setBomModel(null);
          refresh();
        }}
        model={bomModel}
        products={products}
        isOptionsLoading={isOptionsLoading}
      />

      {/* Modale 3 : désactivation (jamais une suppression) */}
      <DeactivateModelDialog
        isOpen={isDeactivateOpen}
        onClose={() => setIsDeactivateOpen(false)}
        onConfirm={async () => {
          if (!deactivateModel) return;
          setIsDeactivating(true);
          try {
            const response = await fetch(`/api/atelier/modeles/${deactivateModel.id}`, {
              method: 'DELETE',
              credentials: 'same-origin',
            });
            if (!response.ok) {
              throw new Error(await readApiError(response, 'Désactivation impossible.'));
            }
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
