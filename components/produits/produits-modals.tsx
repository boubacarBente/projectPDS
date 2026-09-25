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

/** Ligne produit telle que sérialisée par l'API (`createdAt` devient une chaîne). */
export type ProductView = Omit<ProductRow, 'createdAt'> & { createdAt?: string | null };

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
  description: string;
  isActive: boolean;
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
    description: '',
    isActive: true,
  };
}

function productToForm(product: ProductView): ProductFormState {
  return {
    name: product.name,
    categoryId: product.categoryId ? String(product.categoryId) : '',
    unit: product.unit,
    purchasePrice: String(product.purchasePrice ?? 0),
    salePrice: String(product.salePrice ?? 0),
    stock: String(product.stock ?? 0),
    stockMin: String(product.stockMin ?? 0),
    description: product.description ?? '',
    isActive: product.isActive,
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

    setIsSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name,
        categoryId: form.categoryId ? Number(form.categoryId) : null,
        unit: form.unit,
        purchasePrice: toAmount(form.purchasePrice),
        salePrice: toAmount(form.salePrice),
        stockMin: toAmount(form.stockMin),
        description: form.description.trim() || null,
        isActive: form.isActive,
      };
      // À la création seulement : le code interne est **généré par le serveur**
      // (`PRD-0001`), et le stock initial devient un mouvement `entry`.
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
            est l'identifiant du produit, et il est unique. Le code reste généré
            automatiquement côté serveur (`PRD-0001`) comme référence technique,
            mais il ne se saisit plus et ne s'affiche plus.
          */}
          <FormField label="Nom du produit" required>
            <input
              className="input input-bordered field-rounded w-full"
              value={form.name}
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
                disabled={isSubmitting}
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
              disabled={isSubmitting}
              onChange={(event) => set('stockMin', event.target.value)}
            />
          </FormField>

          <FormField label="Description" className="sm:col-span-2">
            <textarea
              className="textarea textarea-bordered field-rounded w-full"
              rows={2}
              value={form.description}
              disabled={isSubmitting}
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
                disabled={isSubmitting}
                onChange={(event) => set('isActive', event.target.checked)}
              />
              <span className="text-sm">{form.isActive ? 'Actif' : 'Désactivé'}</span>
            </label>
          </FormField>
        </div>

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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
              onChange={(event) => set('description', event.target.value)}
            />
          </FormField>

          <FormField label="Catégorie active">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-base-200 bg-base-200/40 px-3">
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={form.isActive}
                disabled={isSubmitting}
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
