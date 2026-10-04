'use client';

/**
 * Modales du module Produits (§4, §7.4).
 *
 * Conventions appliquées (§8.3) :
 *  - **un état booléen par modale** — il n'existe aucun « mode » textuel ; la
 *    création et la modification sont deux modales distinctes, distinguées par
 *    la présence d'un produit à modifier ;
 *  - `onClose` ne ferme **jamais** pendant un envoi ;
 *  - bouton de confirmation désactivé + spinner pendant l'envoi ;
 *  - formulaires sur **une colonne sous `sm`** (§5.5) et cibles ≥ 44 px.
 *
 * Depuis la modification, le **stock** est en lecture seule : il se corrige par
 * un mouvement (`/stocks`), ce qui préserve l'invariant
 * « `products.stock` = somme des `stock_movements` ».
 */

import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { Badge, FormField, MiniStat, MoneyText, QuantityText } from '@/components/design-system';
import { formatPercent } from '@/lib/format';
// `import type` uniquement : `lib/products.ts` touche la base et ne doit jamais
// entrer dans le bundle navigateur.
import type { CategoryKind, CategoryRow, ProductRow } from '@/lib/products';
import { useAuth } from '@/components/auth-provider';
import { useSettings } from '@/app/parametres/page';
import { formatCurrency } from '@/lib/format';

/** Ligne produit telle que sérialisée par l'API (`createdAt` devient une chaîne). */
/**
 * `canEditCatalog` : calculé par le serveur (`GET /api/produits`) — la fiche
 * commune est-elle modifiable par cet utilisateur ? (README §28.5)
 */
export type ProductView = Omit<ProductRow, 'createdAt'> & { createdAt?: string | null; canEditCatalog?: boolean };

/** Ligne catégorie telle que sérialisée par l'API. */
export type CategoryView = Omit<CategoryRow, 'createdAt'> & { createdAt?: string | null };

/** Traduction des types — le type est porté par la catégorie (§6.3). */
export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  finished: 'Produit fini',
  raw_material: 'Matière première',
  service: 'Service',
};

export const CATEGORY_KIND_OPTIONS: { value: CategoryKind; label: string }[] = [
  { value: 'finished', label: 'Produit fini' },
  { value: 'raw_material', label: 'Matière première' },
  { value: 'service', label: 'Service' },
];

/** Étiquette d'état de stock : jamais la couleur seule, toujours un libellé. */
export function StockBadge({ product }: { product: ProductView }) {
  if (product.isOut) return <Badge tone="error">Rupture</Badge>;
  if (product.isLow) return <Badge tone="warning">Stock faible</Badge>;
  return <Badge tone="success">En stock</Badge>;
}

/** Montant saisi (virgule acceptée) → nombre ; jamais négatif. */
function toAmount(value: string): number {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Message d'erreur renvoyé par l'API, ou un repli lisible. */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  return (payload as { error?: string })?.error ?? fallback;
}

/* ==================================================================
 * Produit — création / modification
 * ================================================================== */

type ProductFormState = {
  name: string;
  categoryId: string;
  unit: string;
  purchasePrice: string;
  salePrice: string;
  stock: string;
  stockMin: string;
  barcode: string;
  description: string;
  isActive: boolean;
  /** Réglages du magasin actif — vide = valeur du catalogue. */
  localSalePrice: string;
  localStockMin: string;
};

function emptyProductForm(units: string[]): ProductFormState {
  return {
    name: '',
    categoryId: '',
    unit: units[0] ?? 'pièce',
    purchasePrice: '0',
    salePrice: '0',
    stock: '0',
    stockMin: '0',
    barcode: '',
    description: '',
    isActive: true,
    localSalePrice: '',
    localStockMin: '',
  };
}

function productToForm(product: ProductView): ProductFormState {
  return {
    name: product.name,
    categoryId: product.categoryId ? String(product.categoryId) : '',
    unit: product.unit,
    purchasePrice: String(product.purchasePrice ?? 0),
    /*
     * Valeurs du **catalogue**, pas les valeurs effectives du magasin : avant
     * correction, un produit qui avait un prix local voyait ce prix recopié
     * dans le prix du catalogue à l'enregistrement — donc imposé à tous les
     * magasins.
     */
    salePrice: String(product.catalogSalePrice ?? product.salePrice ?? 0),
    stock: String(product.stock ?? 0),
    stockMin: String(product.catalogStockMin ?? product.stockMin ?? 0),
    barcode: product.barcode ?? '',
    description: product.description ?? '',
    isActive: product.isActive,
    localSalePrice: product.localSalePrice == null ? '' : String(product.localSalePrice),
    localStockMin: product.localStockMin == null ? '' : String(product.localStockMin),
  };
}

export function ProductFormModal({
  isOpen,
  onClose,
  onSaved,
  product,
  categories,
  units,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Rechargement des listes après succès (liste + compteurs). */
  onSaved: () => void | Promise<void>;
  /** `null` = création ; sinon modification du produit passé. */
  product: ProductView | null;
  categories: CategoryView[];
  units: string[];
}) {
  const isEdit = product !== null;
  const { device, activeStore } = useAuth();
  const { settings } = useSettings();
  /*
   * Chaque magasin crée ses produits (README §28.5). En modification, la fiche
   * commune n'est modifiable que par le siège ou par le magasin qui a créé le
   * produit, s'il est seul à le proposer — le serveur le dit (`canEditCatalog`)
   * et le revérifie à l'enregistrement.
   */
  const canEditCatalog = isEdit ? (product?.canEditCatalog ?? device?.mode !== 'store') : true;
  const localPricesAllowed = settings.localPricesAllowed;
  const [form, setForm] = useState<ProductFormState>(() => emptyProductForm(units));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Réinitialisation à chaque ouverture : une modale rouverte ne doit jamais
  // conserver la saisie précédente.
  useEffect(() => {
    if (!isOpen) return;
    setForm(product ? productToForm(product) : emptyProductForm(units));
    setError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, product?.id]);

  const set = <K extends keyof ProductFormState>(key: K, value: ProductFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const margin = toAmount(form.salePrice) - toAmount(form.purchasePrice);
  const marginRate =
    toAmount(form.purchasePrice) > 0 ? (margin / toAmount(form.purchasePrice)) * 100 : 0;

  // L'unité courante reste proposée même si le paramètre a changé depuis.
  const unitOptions = form.unit && !units.includes(form.unit) ? [form.unit, ...units] : units;

  const submit = async () => {
    if (isSubmitting) return;

    const name = form.name.trim();
    if (!name) {
      setError('Le nom du produit est obligatoire.');
      return;
    }
    const localPrice = form.localSalePrice.trim();
    const localMin = form.localStockMin.trim();
    if ((localPrice && !(toAmount(localPrice) > 0)) || (localMin && toAmount(localMin) < 0)) {
      setError('Le prix local doit être positif, et le seuil local positif ou nul (laissez vide pour le catalogue).');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = canEditCatalog
        ? {
            name,
            categoryId: form.categoryId ? Number(form.categoryId) : null,
            unit: form.unit,
            purchasePrice: toAmount(form.purchasePrice),
            salePrice: toAmount(form.salePrice),
            stockMin: toAmount(form.stockMin),
            barcode: form.barcode.trim() || null,
            description: form.description.trim() || null,
            isActive: form.isActive,
          }
        : {};
      // Réglages du magasin actif : envoyés seulement s'ils ont changé.
      if (isEdit) {
        const previousPrice = product!.localSalePrice == null ? '' : String(product!.localSalePrice);
        const previousMin = product!.localStockMin == null ? '' : String(product!.localStockMin);
        if (localPricesAllowed && localPrice !== previousPrice) body.localSalePrice = localPrice ? toAmount(localPrice) : null;
        if (localMin !== previousMin) body.localStockMin = localMin ? toAmount(localMin) : null;
      }
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
      // À la création seulement : le stock initial devient un mouvement `entry`.
      if (!isEdit) {
        body.stock = toAmount(form.stock);
      }

      const response = await fetch(isEdit ? `/api/produits/${product!.id}` : '/api/produits', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(
          await readApiError(response, isEdit ? 'Modification impossible' : 'Création impossible'),
        );
      }

      toast.success(isEdit ? 'Produit modifié' : 'Produit créé');
      await onSaved();
      onClose();
    } catch (submitError: any) {
      const message = submitError?.message ?? 'Enregistrement impossible';
      setError(message);
      toast.error(message, { autoClose: 8000 });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={isEdit ? `Modifier ${product?.name ?? 'le produit'}` : 'Nouveau produit'}
      size="lg"
      fullScreenMobile
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {/*
            Le champ « Code interne » a été retiré (demande client) : le **nom**
            est l'identifiant du produit, et il est unique.
          */}
          <FormField label="Nom du produit" required>
            <input
              className="input input-bordered field-rounded w-full"
              value={form.name}
              disabled={isSubmitting || !canEditCatalog}
              placeholder="Ex. Alucobond 4 mm"
              onChange={(event) => set('name', event.target.value)}
            />
          </FormField>

          <FormField
            label="Catégorie"
            hint={
              categories.length === 0
                ? 'Aucune catégorie active : créez-en une depuis « Catégories ».'
                : 'Le type (produit fini, matière première, service) vient de la catégorie.'
            }
          >
            <select
              className="select select-bordered field-rounded w-full"
              value={form.categoryId}
              disabled={isSubmitting || !canEditCatalog}
              onChange={(event) => set('categoryId', event.target.value)}
            >
              <option value="">Sans catégorie</option>
              {categories.map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {category.name} — {CATEGORY_KIND_LABELS[category.kind]}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Unité" hint="Liste fermée issue des paramètres.">
            <select
              className="select select-bordered field-rounded w-full"
              value={form.unit}
              disabled={isSubmitting || !canEditCatalog}
              onChange={(event) => set('unit', event.target.value)}
            >
              {unitOptions.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Prix d’achat" hint="Base du calcul de marge.">
            <input
              type="number"
              min={0}
              step="1"
              inputMode="decimal"
              className="input input-bordered field-rounded w-full tabular"
              value={form.purchasePrice}
              disabled={isSubmitting || !canEditCatalog}
              onChange={(event) => set('purchasePrice', event.target.value)}
            />
          </FormField>

          <FormField label="Prix de vente">
            <input
              type="number"
              min={0}
              step="1"
              inputMode="decimal"
              className="input input-bordered field-rounded w-full tabular"
              value={form.salePrice}
              disabled={isSubmitting || !canEditCatalog}
              onChange={(event) => set('salePrice', event.target.value)}
            />
          </FormField>

          <div className="sm:col-span-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <MiniStat
                label="Marge unitaire"
                tone={margin > 0 ? 'success' : margin < 0 ? 'error' : 'neutral'}
                value={<MoneyText value={margin} colored bold />}
              />
              <MiniStat
                label="Taux de marge"
                tone={marginRate > 0 ? 'success' : 'neutral'}
                value={formatPercent(marginRate)}
              />
            </div>
          </div>

          {isEdit ? (
            <FormField
              label="Stock actuel"
              hint="Lecture seule : le stock se corrige par un mouvement, depuis « Stocks »."
            >
              <div className="flex min-h-11 items-center gap-2 rounded-xl border border-base-200 bg-base-200/50 px-3">
                <QuantityText value={product?.stock ?? 0} unit={product?.unit} />
                {product && <StockBadge product={product} />}
              </div>
            </FormField>
          ) : (
            <FormField
              label="Stock initial"
              hint="Enregistré comme mouvement d’entrée « Stock initial »."
            >
              <input
                type="number"
                min={0}
                step="0.001"
                inputMode="decimal"
                className="input input-bordered field-rounded w-full tabular"
                value={form.stock}
                disabled={isSubmitting || !canEditCatalog}
                onChange={(event) => set('stock', event.target.value)}
              />
            </FormField>
          )}

          <FormField
            label="Seuil d’alerte"
            hint="0 = pas d’alerte. La quantité est décimale (m², kg)."
          >
            <input
              type="number"
              min={0}
              step="0.001"
              inputMode="decimal"
              className="input input-bordered field-rounded w-full tabular"
              value={form.stockMin}
              disabled={isSubmitting || !canEditCatalog}
              onChange={(event) => set('stockMin', event.target.value)}
            />
          </FormField>

          <FormField label="Code-barres" hint="Facultatif : permet de retrouver le produit en le scannant.">
            <input
              className="input input-bordered field-rounded w-full font-mono"
              value={form.barcode}
              disabled={isSubmitting || !canEditCatalog}
              onChange={(event) => set('barcode', event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField label="Description" className="sm:col-span-2">
            <textarea
              className="textarea textarea-bordered field-rounded w-full"
              rows={2}
              value={form.description}
              disabled={isSubmitting || !canEditCatalog}
              onChange={(event) => set('description', event.target.value)}
            />
          </FormField>

          <FormField
            label="Produit actif"
            hint="Un produit désactivé reste lisible sur les anciennes factures."
            className="sm:col-span-2"
          >
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-base-200 bg-base-200/40 px-3">
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={form.isActive}
                disabled={isSubmitting || !canEditCatalog}
                onChange={(event) => set('isActive', event.target.checked)}
              />
              <span className="text-sm">{form.isActive ? 'Actif' : 'Désactivé'}</span>
            </label>
          </FormField>
        </div>

        {isEdit && (
          <div className="mt-5 rounded-xl border border-primary/25 bg-primary/5 p-4">
            <h3 className="text-sm font-semibold">Réglages de {activeStore?.name ?? 'ce magasin'}</h3>
            <p className="mt-1 text-xs text-base-content/60">
              Ne concernent que ce magasin. Laissez vide pour appliquer la valeur du catalogue.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <FormField
                label="Prix de vente local"
                hint={
                  localPricesAllowed
                    ? `Catalogue : ${formatCurrency(toAmount(form.salePrice))}`
                    : 'Prix locaux désactivés dans les paramètres : le prix du catalogue s’applique.'
                }
              >
                <input
                  type="number"
                  min={0}
                  step="1"
                  inputMode="decimal"
                  className="input input-bordered field-rounded w-full tabular"
                  value={form.localSalePrice}
                  placeholder="Prix du catalogue"
                  disabled={isSubmitting || !localPricesAllowed}
                  onChange={(event) => set('localSalePrice', event.target.value)}
                />
              </FormField>
              <FormField label="Seuil d’alerte local" hint={`Catalogue : ${form.stockMin || '0'}`}>
                <input
                  type="number"
                  min={0}
                  step="0.001"
                  inputMode="decimal"
                  className="input input-bordered field-rounded w-full tabular"
                  value={form.localStockMin}
                  placeholder="Seuil du catalogue"
                  disabled={isSubmitting}
                  onChange={(event) => set('localStockMin', event.target.value)}
                />
              </FormField>
            </div>
          </div>
        )}

        {!canEditCatalog && (
          <p className="mt-4 rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">
            Ce produit est aussi vendu par d’autres magasins (ou appartient au catalogue du siège) :
            sa fiche (nom, prix, unité…) se modifie au siège. Ici, seuls les réglages de votre magasin
            se modifient.
          </p>
        )}

        {!isEdit && (
          <p className="mt-4 rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">
            Le produit sera ajouté aux produits de <strong>{activeStore?.name ?? 'votre magasin'}</strong>.
            Les autres magasins ne le verront que s’ils l’ajoutent à leur tour. S’il existe déjà dans un
            autre magasin, utilisez plutôt « Ajouter du catalogue ».
          </p>
        )}

        {error && (
          <p className="mt-4 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        <div className="sticky bottom-0 mt-5 flex justify-end gap-3 border-t border-base-200 bg-base-100 pt-4">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={isSubmitting}
            onClick={onClose}
          >
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : isEdit ? (
              'Enregistrer'
            ) : (
              'Créer le produit'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ==================================================================
 * Catégorie — création / modification
 * ================================================================== */

type CategoryFormState = {
  name: string;
  kind: CategoryKind;
  description: string;
  isActive: boolean;
};

function emptyCategoryForm(): CategoryFormState {
  return { name: '', kind: 'finished', description: '', isActive: true };
}

function categoryToForm(category: CategoryView): CategoryFormState {
  return {
    name: category.name,
    kind: category.kind,
    description: category.description ?? '',
    isActive: category.isActive,
  };
}

export function CategoryFormModal({
  isOpen,
  onClose,
  onSaved,
  category,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  /** `null` = création ; sinon modification de la catégorie passée. */
  category: CategoryView | null;
}) {
  const isEdit = category !== null;
  // Liste commune : un magasin peut en ajouter une (README §28.5), mais modifier
  // une catégorie existante touche tout le réseau — au siège seulement (le serveur refuse aussi).
  const { device } = useAuth();
  const canEditCatalog = !isEdit || device?.mode !== 'store';
  const [form, setForm] = useState<CategoryFormState>(emptyCategoryForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setForm(category ? categoryToForm(category) : emptyCategoryForm());
    setError(null);
    setIsSubmitting(false);
  }, [isOpen, category]);

  const set = <K extends keyof CategoryFormState>(key: K, value: CategoryFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    if (isSubmitting) return;

    const name = form.name.trim();
    if (!name) {
      setError('Le nom de la catégorie est obligatoire.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(
        isEdit ? `/api/produits/categories/${category!.id}` : '/api/produits/categories',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            name,
            kind: form.kind,
            description: form.description.trim() || null,
            isActive: form.isActive,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          await readApiError(response, isEdit ? 'Modification impossible' : 'Création impossible'),
        );
      }

      toast.success(isEdit ? 'Catégorie modifiée' : 'Catégorie créée');
      await onSaved();
      onClose();
    } catch (submitError: any) {
      const message = submitError?.message ?? 'Enregistrement impossible';
      setError(message);
      toast.error(message, { autoClose: 8000 });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={isEdit ? `Modifier ${category?.name ?? 'la catégorie'}` : 'Nouvelle catégorie'}
      size="md"
      fullScreenMobile
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4">
          <FormField label="Nom" required>
            <input
              className="input input-bordered field-rounded w-full"
              value={form.name}
              disabled={isSubmitting || !canEditCatalog}
              placeholder="Ex. Alucobond"
              onChange={(event) => set('name', event.target.value)}
            />
          </FormField>

          <FormField
            label="Type"
            required
            hint="Le type est porté par la catégorie : tous ses produits en héritent (un seul endroit à paramétrer)."
          >
            <select
              className="select select-bordered field-rounded w-full"
              value={form.kind}
              disabled={isSubmitting || !canEditCatalog}
              onChange={(event) => set('kind', event.target.value as CategoryKind)}
            >
              {CATEGORY_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Description">
            <textarea
              className="textarea textarea-bordered field-rounded w-full"
              rows={2}
              value={form.description}
              disabled={isSubmitting || !canEditCatalog}
              onChange={(event) => set('description', event.target.value)}
            />
          </FormField>

          <FormField label="Catégorie active">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-base-200 bg-base-200/40 px-3">
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={form.isActive}
                disabled={isSubmitting || !canEditCatalog}
                onChange={(event) => set('isActive', event.target.checked)}
              />
              <span className="text-sm">{form.isActive ? 'Active' : 'Désactivée'}</span>
            </label>
          </FormField>
        </div>

        {error && (
          <p className="mt-4 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        <div className="sticky bottom-0 mt-5 flex justify-end gap-3 border-t border-base-200 bg-base-100 pt-4">
          <button type="button" className="btn btn-ghost" disabled={isSubmitting} onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : isEdit ? (
              'Enregistrer'
            ) : (
              'Créer la catégorie'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ==================================================================
 * Ajouter un produit du catalogue commun au magasin actif
 * ================================================================== */

/**
 * Chaque magasin a ses propres produits (README §28.5), mais le catalogue est
 * commun : plutôt que de recréer « Ciment 50 kg » (refusé, le nom est unique
 * dans tout le réseau), un magasin reprend le produit existant. Il garde alors
 * la fiche commune et règle son prix local et son seuil.
 */
export function CatalogPickerModal({
  isOpen,
  onClose,
  onAdded,
}: {
  isOpen: boolean;
  onClose: () => void;
  onAdded: () => void | Promise<void>;
}) {
  const { activeStore } = useAuth();
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<ProductView[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSearch('');
    setError(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ catalog: 'true', limit: '30', sort: 'name' });
        if (search.trim()) params.set('search', search.trim());
        const response = await fetch(`/api/produits?${params}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await readApiError(response, 'Catalogue indisponible'));
        const payload = await response.json();
        setRows((payload.data ?? []) as ProductView[]);
      } catch (loadError: any) {
        if (loadError?.name !== 'AbortError') setError(loadError?.message ?? 'Catalogue indisponible');
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, search]);

  const add = async (product: ProductView) => {
    setAddingId(product.id);
    try {
      const response = await fetch(`/api/produits/${product.id}/assortiment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ listed: true }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Ajout impossible'));
      toast.success(`« ${product.name} » fait maintenant partie des produits de ${activeStore?.name ?? 'votre magasin'}`);
      setRows((current) => current.map((row) => (row.id === product.id ? { ...row, listed: true } : row)));
      await onAdded();
    } catch (addError: any) {
      toast.error(addError?.message ?? 'Ajout impossible', { autoClose: 8000 });
    } finally {
      setAddingId(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Ajouter un produit du catalogue" size="lg" fullScreenMobile>
      <p className="text-sm text-base-content/70">
        Produits déjà créés par le siège ou par un autre magasin. Ajoutez ceux que{' '}
        <strong>{activeStore?.name ?? 'votre magasin'}</strong> vend : ils apparaîtront dans vos ventes,
        achats, stocks et inventaires.
      </p>
      <input
        type="search"
        className="input input-bordered field-rounded mt-4 w-full"
        placeholder="Rechercher un produit…"
        aria-label="Rechercher un produit du catalogue"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        autoComplete="off"
      />
      <div className="mt-4 space-y-2">
        {isLoading && rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-base-content/60">Chargement…</p>
        ) : error ? (
          <p className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{error}</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-base-content/60">Aucun produit ne correspond.</p>
        ) : (
          rows.map((product) => (
            <div
              key={product.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-base-200 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{product.name}</p>
                <p className="text-xs text-base-content/60">
                  {product.categoryName ?? 'Sans catégorie'} · {formatCurrency(product.catalogSalePrice)} ·{' '}
                  {product.ownerStoreName ? `créé par ${product.ownerStoreName}` : 'catalogue du siège'} ·{' '}
                  {product.listedStoreCount} magasin(s)
                </p>
              </div>
              {product.listed ? (
                <Badge tone="success">Déjà dans votre magasin</Badge>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary min-h-11 sm:min-h-0"
                  disabled={addingId !== null}
                  onClick={() => void add(product)}
                >
                  {addingId === product.id ? <span className="loading loading-spinner loading-sm" /> : 'Ajouter'}
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <div className="sticky bottom-0 mt-5 flex justify-end border-t border-base-200 bg-base-100 pt-4">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}
