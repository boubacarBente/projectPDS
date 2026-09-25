'use client';

/**
 * Modales du module Atelier (README §21, §8).
 *
 * Une modale par **état booléen** (§8.3 règle 1) : les pages pilotent
 * `showFormModal`, `showMaterialModal`, `showWorkerModal`, `showCancelDialog`…
 * Aucune modale générique pilotée par une chaîne.
 *
 * Toutes les écritures passent par `/api/atelier/**` : aucun accès base ici, et
 * surtout **aucun import runtime** d'un module serveur (`lib/furniture.ts` est
 * serveur — §11 bis des conventions). Les types sont importés en `import type`,
 * donc effacés à la compilation.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  Card,
  FormField,
  InfoRow,
  MiniStat,
  MoneyText,
  QuantityText,
  SkeletonTable,
} from '@/components/design-system';
import { type Column } from '@/components/responsive-table';
import type {  FurnitureModelMaterialRow,
  FurnitureModelRow,
  FurnitureOrderDetail,
  FurnitureOrderMaterialRow,
  FurnitureOrderWorkerRow,
  FurnitureRequirementLine,
} from '@/lib/furniture';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, today } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types locaux et aides
 * ------------------------------------------------------------------ */

export type ProductOption = {
  id: number;
  code: string;
  name: string;
  unit: string;
  purchasePrice: number;
  stock: number;
  categoryKind: string | null;
};

export type CustomerOption = { id: number; name: string };

export type WorkerOption = { id: number; name: string; role: string | null; dailyRate: number };

/** Message lisible à partir d'une réponse d'API en échec. */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const message = (payload as { error?: unknown }).error;
      if (typeof message === 'string' && message.trim()) return message;
    }
  } catch {
    /* corps illisible : on garde le message générique */
  }
  return fallback;
}

function normaliseList(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray((payload as any).data)) {
    return (payload as any).data;
  }
  return [];
}

/**
 * Charge les produits **matières premières** et les meubles finis.
 *
 * La route `/api/stocks` existante expose `categoryKind`, ce qui évite de
 * deviner : un matériau est un produit dont la catégorie porte
 * `kind = 'raw_material'` (§21). Une liste locale complète est préférée ici à
 * une recherche serveur, car la modale doit afficher le **stock disponible**
 * au moment de la saisie.
 */
export async function fetchProducts(signal?: AbortSignal): Promise<ProductOption[]> {
  const response = await fetch('/api/stocks?limit=500&page=1', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Produits indisponibles'));

  return normaliseList(await response.json()).map((row) => ({
    id: Number(row.id),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    unit: String(row.unit ?? 'pièce'),
    purchasePrice: Number(row.purchasePrice ?? 0),
    stock: Number(row.stock ?? 0),
    categoryKind: row.categoryKind ?? null,
  }));
}

export async function fetchCustomers(signal?: AbortSignal): Promise<CustomerOption[]> {
  const response = await fetch('/api/clients?limit=500&page=1', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Clients indisponibles'));

  return normaliseList(await response.json()).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
  }));
}

/** Ouvriers — route partagée par les chantiers, la briqueterie et l'atelier. */
export async function fetchWorkers(signal?: AbortSignal): Promise<WorkerOption[]> {
  const response = await fetch('/api/workers?limit=500', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (response.status === 404 || response.status === 405) return [];
  if (!response.ok) throw new Error(await readApiError(response, 'Ouvriers indisponibles'));

  return normaliseList(await response.json()).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    role: row.role ?? null,
    dailyRate: Number(row.dailyRate ?? row.daily_rate ?? 0),
  }));
}

export async function fetchFurnitureModels(signal?: AbortSignal): Promise<FurnitureModelRow[]> {
  const response = await fetch('/api/atelier/modeles?limit=500&page=1', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Modèles indisponibles'));

  return normaliseList(await response.json());
}

/* ------------------------------------------------------------------ *
 * 1. Formulaire de commande — création et modification
 * ------------------------------------------------------------------ */

export type OrderFormValues = {
  customerId: string;
  customerName: string;
  isCustom: boolean;
  modelId: string;
  modelName: string;
  dimensions: string;
  finish: string;
  quantity: string;
  startDate: string;
  promisedDate: string;
  deliveryDate: string;
  agreedPrice: string;
  amountPaid: string;
  productId: string;
  notes: string;
};

function emptyOrderForm(): OrderFormValues {
  return {
    customerId: '',
    customerName: '',
    isCustom: false,
    modelId: '',
    modelName: '',
    dimensions: '',
    finish: '',
    quantity: '1',
    startDate: today(),
    promisedDate: '',
    deliveryDate: '',
    agreedPrice: '',
    amountPaid: '',
    productId: '',
    notes: '',
  };
}

function orderFormFromDetail(detail: FurnitureOrderDetail): OrderFormValues {
  const { order } = detail;
  return {
    customerId: order.customerId ? String(order.customerId) : '',
    customerName: order.customerId ? '' : order.customerName,
    isCustom: order.isCustom,
    modelId: order.modelId ? String(order.modelId) : '',
    modelName: order.modelId ? '' : order.modelName,
    dimensions: order.dimensions ?? '',
    finish: order.finish ?? '',
    quantity: String(order.quantity ?? 1),
    startDate: order.startDate ?? '',
    promisedDate: order.promisedDate ?? '',
    deliveryDate: order.deliveryDate ?? '',
    agreedPrice: order.agreedPrice ? String(order.agreedPrice) : '',
    amountPaid: order.amountPaid ? String(order.amountPaid) : '',
    productId: order.productId ? String(order.productId) : '',
    notes: order.notes ?? '',
  };
}

/** Cœur de §21 : aperçu des besoins calculés depuis la nomenclature du modèle. */
function RequirementsPreview({
  requirements,
  isLoading,
  error,
}: {
  requirements: { quantity: number; lines: FurnitureRequirementLine[]; isCovered: boolean } | null;
  isLoading: boolean;
  error: string | null;
}) {
  if (isLoading) return <SkeletonTable rows={3} cols={4} />;

  if (error) {
    return (
      <p className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
        {error}
      </p>
    );
  }

  if (!requirements || requirements.lines.length === 0) {
    return (
      <p className="rounded-xl border border-base-200 bg-base-200/50 px-3 py-2 text-sm text-base-content/60">
        Ce modèle n’a pas de nomenclature : les matières devront être ajoutées à la main sur la fiche
        de la commande.
      </p>
    );
  }

  const missing = requirements.lines.filter((line) => !line.isCovered);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Besoins calculés depuis la nomenclature</span>
        {requirements.isCovered ? (
          <Badge tone="success">Stock suffisant</Badge>
        ) : (
          <Badge tone="warning">
            {missing.length} matière{missing.length > 1 ? 's' : ''} à compléter
          </Badge>
        )}
      </div>

      <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
        {requirements.lines.map((line) => (
          <li key={line.productId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="block truncate font-medium">{line.productName}</span>
            </span>
            <span className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-base-content/60">
                Besoin <QuantityText value={line.requiredQuantity} unit={line.unit} />
              </span>
              <span className="text-xs text-base-content/60">
                Stock <QuantityText value={line.availableStock} unit={line.unit} />
              </span>
              {line.isCovered ? (
                <Badge tone="success">Couvert</Badge>
              ) : (
                <Badge tone="warning">
                  Manque <QuantityText value={line.missingQuantity} unit={line.unit} />
                </Badge>
              )}
            </span>
          </li>
        ))}
      </ul>

      <p className="text-xs text-base-content/50">
        Les matières seront <strong>préremplies</strong> sur la commande sans mouvement de stock : la
        consommation réelle et les chutes se saisissent ensuite sur la fiche de la commande.
      </p>
    </div>
  );
}

export function FurnitureOrderFormModal({
  isOpen,
  onClose,
  onSaved,
  order = null,
  models,
  customers,
  products,
  isOptionsLoading = false,
  idPrefix = 'create',
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (detail: FurnitureOrderDetail) => void;
  /** `null` = création, sinon modification. */
  order?: FurnitureOrderDetail | null;
  models: FurnitureModelRow[];
  customers: CustomerOption[];
  products: ProductOption[];
  isOptionsLoading?: boolean;
  idPrefix?: string;
}) {
  const isEdit = Boolean(order);
  const orderId = order?.order.id ?? null;
  const fieldId = (name: string) => `${idPrefix}-order-${name}`;

  const [values, setValues] = useState<OrderFormValues>(() => emptyOrderForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requirements, setRequirements] = useState<{
    quantity: number;
    lines: FurnitureRequirementLine[];
    isCovered: boolean;
  } | null>(null);
  const [requirementsLoading, setRequirementsLoading] = useState(false);
  const [requirementsError, setRequirementsError] = useState<string | null>(null);

  const finishedGoods = useMemo(
    () => products.filter((product) => product.categoryKind !== 'raw_material'),
    [products],
  );

  useEffect(() => {
    if (!isOpen) return;
    setValues(order ? orderFormFromDetail(order) : emptyOrderForm());
    setFormError(null);
    setIsSubmitting(false);
    setRequirements(null);
    setRequirementsError(null);
    // `orderId` suffit : la commande affichée ne change pas sans fermeture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, orderId]);

  /* Aperçu des besoins : uniquement pour une commande standard liée à un modèle. */
  useEffect(() => {
    if (!isOpen || values.isCustom || !values.modelId) {
      setRequirements(null);
      setRequirementsError(null);
      return;
    }

    const quantity = Number(values.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setRequirements(null);
      return;
    }

    const controller = new AbortController();
    setRequirementsLoading(true);
    setRequirementsError(null);

    fetch(`/api/atelier/modeles/${values.modelId}?quantity=${quantity}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Besoins indisponibles'));
        }
        return response.json();
      })
      .then((payload: any) => {
        if (controller.signal.aborted) return;
        const next = payload?.requirements;
        setRequirements(
          next
            ? { quantity: Number(next.quantity ?? quantity), lines: next.lines ?? [], isCovered: Boolean(next.isCovered) }
            : null,
        );
      })
      .catch((error: any) => {
        if (error?.name === 'AbortError') return;
        setRequirements(null);
        setRequirementsError(error?.message ?? 'Besoins indisponibles');
      })
      .finally(() => {
        if (!controller.signal.aborted) setRequirementsLoading(false);
      });

    return () => controller.abort();
  }, [isOpen, values.isCustom, values.modelId, values.quantity]);

  const setField = <K extends keyof OrderFormValues>(key: K, value: OrderFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    const quantity = Number(values.quantity);

    if (!values.isCustom && !values.modelId) {
      setFormError('Sélectionnez un modèle, ou cochez « Sur mesure ».');
      return;
    }
    if (values.isCustom && !values.dimensions.trim()) {
      setFormError('Une commande sur mesure doit préciser ses dimensions.');
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setFormError('La quantité doit être supérieure à zéro.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    const payload = {
      customerId: values.customerId ? Number(values.customerId) : null,
      customerName: values.customerId ? null : values.customerName.trim() || null,
      isCustom: values.isCustom,
      modelId: values.isCustom ? null : Number(values.modelId),
      modelName: values.isCustom ? null : null,
      dimensions: values.dimensions.trim() || null,
      finish: values.finish.trim() || null,
      quantity,
      startDate: values.startDate || null,
      promisedDate: values.promisedDate || null,
      deliveryDate: values.deliveryDate || null,
      agreedPrice: values.agreedPrice.trim() ? Number(values.agreedPrice) : 0,
      amountPaid: values.amountPaid.trim() ? Number(values.amountPaid) : 0,
      productId: values.productId ? Number(values.productId) : null,
      notes: values.notes.trim() || null,
    };

    try {
      const response = await fetch(
        isEdit && order ? `/api/atelier/commandes/${order.order.id}` : '/api/atelier/commandes',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(isEdit ? { action: 'update', ...payload } : payload),
        },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, "La commande n'a pas pu être enregistrée."));
      }

      onSaved((await response.json()) as FurnitureOrderDetail);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "La commande n'a pas pu être enregistrée.",
      );
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
      title={isEdit ? `Modifier la commande ${order?.order.orderNumber ?? ''}` : 'Nouvelle commande d’atelier'}
      size="xl"
      fullScreenMobile
    >
      <form
        className="pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {formError && (
          <p role="alert" className="mb-4 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {formError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Client"
            htmlFor={fieldId('customer')}
            hint="Laisser vide pour un client de passage : le nom saisi ci-contre est conservé."
          >
            <select
              id={fieldId('customer')}
              className="select select-bordered min-h-11 w-full sm:min-h-0"
              value={values.customerId}
              onChange={(event) => setField('customerId', event.target.value)}
              disabled={isOptionsLoading}
            >
              <option value="">Client de passage…</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Nom du client de passage" htmlFor={fieldId('customer-name')}>
            <input
              id={fieldId('customer-name')}
              type="text"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={values.customerName}
              onChange={(event) => setField('customerName', event.target.value)}
              placeholder="Ex. Aïssatou Bah"
              disabled={Boolean(values.customerId)}
              autoComplete="off"
            />
          </FormField>

          <label className="flex min-h-11 cursor-pointer items-center gap-3 sm:col-span-2">
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={values.isCustom}
              onChange={(event) => {
                const isCustom = event.target.checked;
                setField('isCustom', isCustom);
                if (isCustom) {
                  setField('modelId', '');
                  setField('modelName', 'Sur mesure');
                } else {
                  setField('modelName', '');
                }
              }}
            />
            <span className="text-sm">
              Meuble sur mesure
              <span className="block text-xs text-base-content/50">
                Une commande sur mesure n’a pas de nomenclature : les matières se saisissent sur la
                fiche de la commande. Les dimensions deviennent obligatoires.
              </span>
            </span>
          </label>

          <FormField
            label="Modèle"
            htmlFor={fieldId('model')}
            required={!values.isCustom}
            hint={
              values.isCustom
                ? 'Sans objet pour une commande sur mesure.'
                : 'Les matériaux seront préremplis depuis la nomenclature du modèle.'
            }
          >
            <select
              id={fieldId('model')}
              className="select select-bordered min-h-11 w-full sm:min-h-0"
              value={values.modelId}
              onChange={(event) => setField('modelId', event.target.value)}
              disabled={values.isCustom || isOptionsLoading}
            >
              <option value="">Sélectionner un modèle…</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.code} — {model.name}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Quantité" htmlFor={fieldId('quantity')} required>
            <input
              id={fieldId('quantity')}
              type="number"
              min={0}
              step={1}
              inputMode="decimal"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={values.quantity}
              onChange={(event) => setField('quantity', event.target.value)}
            />
          </FormField>

          <FormField
            label="Dimensions"
            htmlFor={fieldId('dimensions')}
            required={values.isCustom}
            hint="Ex. 200 × 90 × 75 cm"
          >
            <input
              id={fieldId('dimensions')}
              type="text"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={values.dimensions}
              onChange={(event) => setField('dimensions', event.target.value)}
              placeholder="Longueur × largeur × hauteur"
              autoComplete="off"
            />
          </FormField>

          <FormField label="Finition / goût du client" htmlFor={fieldId('finish')}>
            <input
              id={fieldId('finish')}
              type="text"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={values.finish}
              onChange={(event) => setField('finish', event.target.value)}
              placeholder="Ex. vernis acajou mat"
              autoComplete="off"
            />
          </FormField>

          <FormField label="Date de début" htmlFor={fieldId('start')}>
            <DatePicker
              value={values.startDate}
              onChange={(value) => setField('startDate', value)}
              placeholder="jj/mm/aaaa"
            />
          </FormField>

          <FormField
            label="Date promise"
            htmlFor={fieldId('promised')}
            hint="Base de l’indicateur « livré à temps »."
          >
            <DatePicker
              value={values.promisedDate}
              onChange={(value) => setField('promisedDate', value)}
              placeholder="jj/mm/aaaa"
            />
          </FormField>

          <FormField label="Prix convenu (GNF)" htmlFor={fieldId('agreed')}>
            <input
              id={fieldId('agreed')}
              type="number"
              min={0}
              step={1000}
              inputMode="numeric"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={values.agreedPrice}
              onChange={(event) => setField('agreedPrice', event.target.value)}
              placeholder="0"
            />
          </FormField>

          <FormField label="Acompte reçu (GNF)" htmlFor={fieldId('paid')}>
            <input
              id={fieldId('paid')}
              type="number"
              min={0}
              step={1000}
              inputMode="numeric"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={values.amountPaid}
              onChange={(event) => setField('amountPaid', event.target.value)}
              placeholder="0"
            />
          </FormField>

          <FormField
            label="Meuble fini (entrée en stock à la livraison)"
            htmlFor={fieldId('product')}
            hint="Produit crédité d’une entrée à la livraison — une seule fois."
            className="sm:col-span-2"
          >
            <select
              id={fieldId('product')}
              className="select select-bordered min-h-11 w-full sm:min-h-0"
              value={values.productId}
              onChange={(event) => setField('productId', event.target.value)}
              disabled={isOptionsLoading}
            >
              <option value="">Aucun produit fini associé</option>
              {finishedGoods.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Notes de fabrication" htmlFor={fieldId('notes')} className="sm:col-span-2">
            <textarea
              id={fieldId('notes')}
              rows={3}
              className="textarea textarea-bordered w-full"
              value={values.notes}
              onChange={(event) => setField('notes', event.target.value)}
              placeholder="Précisions d’atelier, contraintes du client…"
            />
          </FormField>
        </div>

        {!values.isCustom && values.modelId && (
          <div className="mt-4">
            <RequirementsPreview
              requirements={requirements}
              isLoading={requirementsLoading}
              error={requirementsError}
            />
          </div>
        )}

        <div className="sticky bottom-0 -mx-1 mt-5 flex justify-end gap-3 border-t border-base-200 bg-base-100 px-1 pb-1 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11 sm:min-h-0"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-0" disabled={isSubmitting}>
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : isEdit ? (
              'Enregistrer'
            ) : (
              'Créer la commande'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Formulaire de modèle
 * ------------------------------------------------------------------ */

export type ModelFormValues = {
  code: string;
  name: string;
  description: string;
  standardDimensions: string;
  laborHours: string;
  salePrice: string;
  isActive: boolean;
};

function emptyModelForm(): ModelFormValues {
  return {
    code: '',
    name: '',
    description: '',
    standardDimensions: '',
    laborHours: '',
    salePrice: '',
    isActive: true,
  };
}

export function FurnitureModelFormModal({
  isOpen,
  onClose,
  onSaved,
  model = null,
  idPrefix = 'create',
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (model: FurnitureModelRow) => void;
  model?: FurnitureModelRow | null;
  idPrefix?: string;
}) {
  const isEdit = Boolean(model);
  const modelId = model?.id ?? null;
  const fieldId = (name: string) => `${idPrefix}-model-${name}`;

  const [values, setValues] = useState<ModelFormValues>(() => emptyModelForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setValues(
      model
        ? {
            code: model.code ?? '',
            name: model.name ?? '',
            description: model.description ?? '',
            standardDimensions: model.standardDimensions ?? '',
            laborHours: model.laborHours ? String(model.laborHours) : '',
            salePrice: model.salePrice ? String(model.salePrice) : '',
            isActive: model.isActive,
          }
        : emptyModelForm(),
    );
    setFormError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, modelId]);

  const setField = <K extends keyof ModelFormValues>(key: K, value: ModelFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    if (!values.name.trim()) {
      setFormError('Le nom du modèle est obligatoire.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    const payload = {
      code: values.code.trim() || null,
      name: values.name.trim(),
      description: values.description.trim() || null,
      standardDimensions: values.standardDimensions.trim() || null,
      laborHours: values.laborHours.trim() ? Number(values.laborHours) : 0,
      salePrice: values.salePrice.trim() ? Number(values.salePrice) : 0,
      isActive: values.isActive,
    };

    try {
      const response = await fetch(
        isEdit && model ? `/api/atelier/modeles/${model.id}` : '/api/atelier/modeles',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, "Le modèle n'a pas pu être enregistré."));
      }

      onSaved((await response.json()) as FurnitureModelRow);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Le modèle n'a pas pu être enregistré.",
      );
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
      title={isEdit ? 'Modifier le modèle' : 'Nouveau modèle de meuble'}
      size="lg"
      fullScreenMobile
    >
      <form
        className="pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {formError && (
          <p role="alert" className="mb-4 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {formError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Code"
            htmlFor={fieldId('code')}
            hint="Généré automatiquement (MOD-0001) s’il est laissé vide."
          >
            <input
              id={fieldId('code')}
              type="text"
              className="input input-bordered min-h-11 w-full font-mono sm:min-h-0"
              value={values.code}
              onChange={(event) => setField('code', event.target.value)}
              placeholder="MOD-0001"
              autoComplete="off"
            />
          </FormField>

          <FormField label="Nom du modèle" htmlFor={fieldId('name')} required>
            <input
              id={fieldId('name')}
              type="text"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={values.name}
              onChange={(event) => setField('name', event.target.value)}
              placeholder="Ex. Armoire 3 portes"
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Dimensions standard"
            htmlFor={fieldId('dimensions')}
            hint="Ex. 180 × 60 × 200 cm"
          >
            <input
              id={fieldId('dimensions')}
              type="text"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={values.standardDimensions}
              onChange={(event) => setField('standardDimensions', event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Heures de main-d’œuvre"
            htmlFor={fieldId('labor')}
            hint="Estimation pour une unité."
          >
            <input
              id={fieldId('labor')}
              type="number"
              min={0}
              step={0.5}
              inputMode="decimal"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={values.laborHours}
              onChange={(event) => setField('laborHours', event.target.value)}
              placeholder="0"
            />
          </FormField>

          <FormField label="Prix de vente (GNF)" htmlFor={fieldId('price')}>
            <input
              id={fieldId('price')}
              type="number"
              min={0}
              step={1000}
              inputMode="numeric"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={values.salePrice}
              onChange={(event) => setField('salePrice', event.target.value)}
              placeholder="0"
            />
          </FormField>

          <FormField label="Description" htmlFor={fieldId('description')} className="sm:col-span-2">
            <textarea
              id={fieldId('description')}
              rows={2}
              className="textarea textarea-bordered w-full"
              value={values.description}
              onChange={(event) => setField('description', event.target.value)}
              placeholder="Bois utilisé, particularités de fabrication…"
            />
          </FormField>

          {isEdit && (
            <label className="flex min-h-11 cursor-pointer items-center gap-3 sm:col-span-2">
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={values.isActive}
                onChange={(event) => setField('isActive', event.target.checked)}
              />
              <span className="text-sm">
                Modèle actif
                <span className="block text-xs text-base-content/50">
                  Un modèle désactivé reste consultable et reste rattaché à ses commandes passées.
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="sticky bottom-0 -mx-1 mt-5 flex justify-end gap-3 border-t border-base-200 bg-base-100 px-1 pb-1 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11 sm:min-h-0"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-0" disabled={isSubmitting}>
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : isEdit ? (
              'Enregistrer'
            ) : (
              'Créer le modèle'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Nomenclature (BOM) d'un modèle
 * ------------------------------------------------------------------ */

type BomLine = { productId: number; quantity: string };

function bomFromMaterials(materials: FurnitureModelMaterialRow[]): BomLine[] {
  return materials.map((material) => ({
    productId: material.productId,
    quantity: String(material.quantity),
  }));
}

/**
 * Modale de nomenclature : ajouter / retirer des matériaux et voir, pour chaque
 * ligne, le produit, la quantité nécessaire et le **stock disponible**.
 */
export function FurnitureBomModal({
  isOpen,
  onClose,
  onSaved,
  model,
  products,
  isOptionsLoading = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (materials: FurnitureModelMaterialRow[]) => void;
  model: FurnitureModelRow | null;
  products: ProductOption[];
  isOptionsLoading?: boolean;
}) {
  const [lines, setLines] = useState<BomLine[]>([]);
  const [materials, setMaterials] = useState<FurnitureModelMaterialRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const modelId = model?.id ?? null;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!modelId) return;
      setIsLoading(true);
      setLoadError(null);

      try {
        const response = await fetch(`/api/atelier/modeles/${modelId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        });
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Nomenclature indisponible'));
        }
        const payload = (await response.json()) as { materials: FurnitureModelMaterialRow[] };
        const list = Array.isArray(payload.materials) ? payload.materials : [];
        setMaterials(list);
        setLines(bomFromMaterials(list));
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        setLoadError(error instanceof Error ? error.message : 'Nomenclature indisponible');
      } finally {
        setIsLoading(false);
      }
    },
    [modelId],
  );

  useEffect(() => {
    if (!isOpen || !modelId) return;
    setFormError(null);
    setIsSubmitting(false);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [isOpen, modelId, load]);

  const rawMaterials = useMemo(
    () => products.filter((product) => product.categoryKind === 'raw_material'),
    [products],
  );

  /** Stock disponible par produit, pour l'afficher sur chaque ligne. */
  const productById = useMemo(() => {
    const map = new Map<number, ProductOption>();
    for (const product of products) map.set(product.id, product);
    return map;
  }, [products]);

  function addLine() {
    const used = new Set(lines.map((line) => line.productId));
    const available = rawMaterials.find((product) => !used.has(product.id)) ?? products.find((p) => !used.has(p.id));
    if (!available) return;
    setLines((current) => [...current, { productId: available.id, quantity: '1' }]);
  }

  function removeLine(index: number) {
    setLines((current) => current.filter((_, position) => position !== index));
  }

  const submit = async () => {
    if (!modelId) return;

    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setFormError('Chaque ligne doit porter une quantité supérieure à zéro.');
        return;
      }
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/atelier/modeles/${modelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          materials: lines.map((line) => ({
            productId: line.productId,
            quantity: Number(line.quantity),
          })),
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "La nomenclature n'a pas pu être enregistrée."));
      }

      const payload = (await response.json()) as { materials: FurnitureModelMaterialRow[] };
      onSaved(Array.isArray(payload.materials) ? payload.materials : []);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "La nomenclature n'a pas pu être enregistrée.",
      );
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
      title={`Nomenclature — ${model?.name ?? 'modèle'}`}
      size="xl"
      fullScreenMobile
    >
      <div className="space-y-4 pb-2">
        {formError && (
          <p role="alert" className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {formError}
          </p>
        )}

        <p className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2.5 text-xs text-base-content/60">
          Les besoins en matières d’une commande standard se <strong>calculent</strong> depuis cette
          nomenclature. Retirer une ligne ne la supprime pas : elle est désactivée, ce qui préserve la
          synchronisation et l’historique.
        </p>

        {isLoading ? (
          <SkeletonTable rows={4} cols={4} />
        ) : loadError ? (
          <div className="rounded-xl border border-error/30 bg-error/10 p-4 text-sm text-error">
            <p>{loadError}</p>
            <button type="button" className="btn btn-sm btn-error mt-3" onClick={() => void load()}>
              Réessayer
            </button>
          </div>
        ) : (
          <>
            {lines.length === 0 ? (
              <p className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-6 text-center text-sm text-base-content/60">
                Aucun matériau dans la nomenclature. Ajoutez au moins une ligne pour que les commandes
                standard soient préremplies.
              </p>
            ) : (
              <ul className="space-y-3">
                {lines.map((line, index) => {
                  const product = productById.get(line.productId);
                  const quantity = Number(line.quantity);
                  const available = product?.stock ?? 0;
                  const shortfall = Number.isFinite(quantity) && quantity > available;

                  return (
                    <li
                      key={`${line.productId}-${index}`}
                      className="rounded-xl border border-base-200 bg-base-100 p-3"
                    >
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
                        <div className="sm:col-span-6">
                          <FormField label="Produit (matière première)">
                            <select
                              className="select select-bordered min-h-11 w-full sm:min-h-0"
                              value={line.productId}
                              onChange={(event) =>
                                setLines((current) =>
                                  current.map((entry, position) =>
                                    position === index
                                      ? { ...entry, productId: Number(event.target.value) }
                                      : entry,
                                  ),
                                )
                              }
                              disabled={isOptionsLoading}
                            >
                              {(rawMaterials.length > 0 ? rawMaterials : products).map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.code} — {option.name} ({option.unit})
                                </option>
                              ))}
                            </select>
                          </FormField>
                        </div>

                        <div className="sm:col-span-3">
                          <FormField label="Quantité par unité">
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              inputMode="decimal"
                              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
                              value={line.quantity}
                              onChange={(event) =>
                                setLines((current) =>
                                  current.map((entry, position) =>
                                    position === index
                                      ? { ...entry, quantity: event.target.value }
                                      : entry,
                                  ),
                                )
                              }
                            />
                          </FormField>
                        </div>

                        <div className="sm:col-span-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-base-content/60">
                              Stock :{' '}
                              <QuantityText value={available} unit={product?.unit ?? ''} />
                            </span>
                            {shortfall ? (
                              <Badge tone="warning">Au-dessus du stock</Badge>
                            ) : (
                              <Badge tone="success">Couvert</Badge>
                            )}
                          </div>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm mt-2 min-h-11 w-full border border-base-300 sm:min-h-0"
                            onClick={() => removeLine(index)}
                          >
                            Retirer la ligne
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <button
              type="button"
              className="btn btn-ghost min-h-11 w-full border border-dashed border-base-300 sm:min-h-0"
              onClick={addLine}
              disabled={isOptionsLoading}
            >
              Ajouter un matériau
            </button>

            {materials.length > 0 && (
              <p className="text-xs text-base-content/50">
                {materials.length} ligne{materials.length > 1 ? 's' : ''} enregistrée
                {materials.length > 1 ? 's' : ''} — coût matière estimé d’une unité :{' '}
                <MoneyText
                  value={materials.reduce((sum, material) => sum + material.amount, 0)}
                  bold
                />
              </p>
            )}
          </>
        )}

        <div className="sticky bottom-0 flex justify-end gap-3 border-t border-base-200 bg-base-100 pb-1 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11 sm:min-h-0"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Fermer
          </button>
          <button
            type="button"
            className="btn btn-primary min-h-11 sm:min-h-0"
            onClick={() => void submit()}
            disabled={isSubmitting || isLoading || Boolean(loadError)}
          >
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              'Enregistrer la nomenclature'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 4. Ajout d'un matériau consommé (avec contrôle de stock et chutes)
 * ------------------------------------------------------------------ */

export function OrderMaterialModal({
  isOpen,
  onClose,
  onSaved,
  orderId,
  orderNumber,
  materials,
  products,
  isOptionsLoading = false,
  initialProductId = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (detail: FurnitureOrderDetail) => void;
  /** Identifiant local de la commande — la route `[id]` est appelée par `id`. */
  orderId: number | null;
  orderNumber: string;
  materials: FurnitureOrderMaterialRow[];
  products: ProductOption[];
  isOptionsLoading?: boolean;
  initialProductId?: number | null;
}) {
  const alreadyOnOrder = useMemo(
    () => new Set(materials.map((material) => material.productId).filter((id): id is number => id != null)),
    [materials],
  );

  const rawMaterials = useMemo(
    () => products.filter((product) => product.categoryKind === 'raw_material'),
    [products],
  );

  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [wastage, setWastage] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const first = initialProductId ? String(initialProductId) : '';
    setProductId(first);
    setQuantity('');
    setWastage('');
    const product = products.find((entry) => entry.id === Number(first));
    setUnitCost(product ? String(product.purchasePrice) : '');
    setFormError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialProductId]);

  const selected = products.find((product) => product.id === Number(productId)) ?? null;

  const requested = Number(quantity) || 0;
  const wasted = Number(wastage) || 0;
  const totalExit = requested + wasted;
  const stockShortfall = selected ? totalExit > selected.stock : false;

  const submit = async () => {
    if (!orderId) return;

    if (!selected) {
      setFormError('Sélectionnez le matériau consommé.');
      return;
    }
    if (!Number.isFinite(requested) || requested <= 0) {
      setFormError('La quantité consommée doit être supérieure à zéro.');
      return;
    }
    if (wasted < 0) {
      setFormError('Les chutes ne peuvent pas être négatives.');
      return;
    }
    if (stockShortfall && selected) {
      setFormError(
        `Stock insuffisant : ${selected.name} (disponible ${formatNumber(selected.stock)} ${selected.unit}, demandé ${formatNumber(totalExit)} ${selected.unit}).`,
      );
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/atelier/commandes/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'addMaterial',
          productId: selected.id,
          quantity: requested,
          wastageQuantity: wasted,
          unitCost: unitCost.trim() ? Number(unitCost) : undefined,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "La matière n'a pas pu être enregistrée."));
      }

      onSaved((await response.json()) as FurnitureOrderDetail);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "La matière n'a pas pu être enregistrée.",
      );
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
      title={`Consommer une matière — commande ${orderNumber}`}
      size="lg"
      fullScreenMobile
    >
      <div className="space-y-4 pb-2">
        {formError && (
          <p role="alert" className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {formError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Matériau"
            htmlFor="order-material-product"
            required
            hint={
              products.length === 0
                ? 'Aucun produit disponible : créez les matières premières dans le catalogue.'
                : 'Le stock est contrôlé avant l’enregistrement.'
            }
            className="sm:col-span-2"
          >
            <select
              id="order-material-product"
              className="select select-bordered min-h-11 w-full sm:min-h-0"
              value={productId}
              onChange={(event) => {
                const next = event.target.value;
                setProductId(next);
                const product = products.find((entry) => entry.id === Number(next));
                setUnitCost(product ? String(product.purchasePrice) : '');
              }}
              disabled={isOptionsLoading}
            >
              <option value="">Sélectionner un matériau…</option>
              {(rawMaterials.length > 0 ? rawMaterials : products).map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} · stock {formatNumber(product.stock)} {product.unit}
                  {alreadyOnOrder.has(product.id) ? ' · déjà sur la commande' : ''}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Quantité consommée" htmlFor="order-material-quantity" required>
            <input
              id="order-material-quantity"
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="0"
            />
          </FormField>

          <FormField
            label="Chutes de bois / pertes"
            htmlFor="order-material-wastage"
            hint="Enregistrées comme une sortie distincte, avec un motif explicite."
          >
            <input
              id="order-material-wastage"
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={wastage}
              onChange={(event) => setWastage(event.target.value)}
              placeholder="0"
            />
          </FormField>

          <FormField
            label="Coût unitaire (GNF)"
            htmlFor="order-material-cost"
            hint="Prérempli avec le prix d’achat du produit ; modifiable pour un lot réel."
            className="sm:col-span-2"
          >
            <input
              id="order-material-cost"
              type="number"
              min={0}
              step={100}
              inputMode="numeric"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={unitCost}
              onChange={(event) => setUnitCost(event.target.value)}
              placeholder="0"
            />
          </FormField>
        </div>

        {selected && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat label="Stock disponible" value={<QuantityText value={selected.stock} unit={selected.unit} />} />
            <MiniStat label="Sortie totale" value={<QuantityText value={totalExit} unit={selected.unit} />} />
            <MiniStat
              label="Coût matière"
              value={<MoneyText value={requested * (Number(unitCost) || 0)} />}
            />
            <MiniStat
              label="État du stock"
              tone={stockShortfall ? 'error' : 'success'}
              value={stockShortfall ? 'Insuffisant' : 'Suffisant'}
            />
          </div>
        )}

        <div className="sticky bottom-0 flex justify-end gap-3 border-t border-base-200 bg-base-100 pb-1 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11 sm:min-h-0"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Annuler
          </button>
          <button
            type="button"
            className="btn btn-primary min-h-11 sm:min-h-0"
            onClick={() => void submit()}
            disabled={isSubmitting || !selected}
          >
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              'Enregistrer la sortie'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 5. Affectation d'équipe
 * ------------------------------------------------------------------ */

export function OrderWorkerModal({
  isOpen,
  onClose,
  onSaved,
  orderId,
  orderNumber,
  workers,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (detail: FurnitureOrderDetail) => void;
  orderId: number | null;
  orderNumber: string;
  workers: WorkerOption[];
}) {
  const [workerId, setWorkerId] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [role, setRole] = useState('');
  const [days, setDays] = useState('1');
  const [dailyRate, setDailyRate] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setWorkerId('');
    setWorkerName('');
    setRole('');
    setDays('1');
    setDailyRate('');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen]);

  const amount = (Number(days) || 0) * (Number(dailyRate) || 0);

  const submit = async () => {
    if (!orderId) return;

    if (!workerId && !workerName.trim()) {
      setFormError('Sélectionnez un ouvrier enregistré, ou saisissez le nom d’un journalier.');
      return;
    }
    if (!Number.isFinite(Number(days)) || Number(days) <= 0) {
      setFormError('Le nombre de jours doit être supérieur à zéro.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/atelier/commandes/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'addWorker',
          workerId: workerId ? Number(workerId) : null,
          workerName: workerName.trim() || null,
          role: role.trim() || null,
          days: Number(days),
          dailyRate: Number(dailyRate) || 0,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "L'affectation n'a pas pu être enregistrée."));
      }

      onSaved((await response.json()) as FurnitureOrderDetail);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "L'affectation n'a pas pu être enregistrée.",
      );
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
      title={`Affecter un ouvrier — commande ${orderNumber}`}
      size="lg"
      fullScreenMobile
    >
      <div className="space-y-4 pb-2">
        {formError && (
          <p role="alert" className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {formError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Ouvrier enregistré"
            htmlFor="order-worker-select"
            hint="Chef menuisier, ouvrier ou apprenti — table `workers` partagée."
          >
            <select
              id="order-worker-select"
              className="select select-bordered min-h-11 w-full sm:min-h-0"
              value={workerId}
              onChange={(event) => {
                const next = event.target.value;
                setWorkerId(next);
                const worker = workers.find((entry) => entry.id === Number(next));
                if (worker) {
                  setRole(worker.role ?? '');
                  setDailyRate(String(worker.dailyRate ?? 0));
                }
              }}
            >
              <option value="">Journalier ponctuel (saisie libre)…</option>
              {workers.map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.name}
                  {worker.role ? ` — ${worker.role}` : ''}
                </option>
              ))}
            </select>
          </FormField>

          <FormField
            label="Nom du journalier"
            htmlFor="order-worker-name"
            required={!workerId}
            hint="Utile pour un ouvrier non enregistré."
          >
            <input
              id="order-worker-name"
              type="text"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={workerName}
              onChange={(event) => setWorkerName(event.target.value)}
              placeholder="Ex. Sékou Camara"
              disabled={Boolean(workerId)}
              autoComplete="off"
            />
          </FormField>

          <FormField label="Rôle" htmlFor="order-worker-role" hint="Ex. chef menuisier, apprenti.">
            <input
              id="order-worker-role"
              type="text"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField label="Jours travaillés" htmlFor="order-worker-days" required>
            <input
              id="order-worker-days"
              type="number"
              min={0}
              step={0.5}
              inputMode="decimal"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </FormField>

          <FormField label="Tarif journalier (GNF)" htmlFor="order-worker-rate" required>
            <input
              id="order-worker-rate"
              type="number"
              min={0}
              step={1000}
              inputMode="numeric"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={dailyRate}
              onChange={(event) => setDailyRate(event.target.value)}
              placeholder="0"
            />
          </FormField>

          <div className="sm:col-span-2">
            <MiniStat label="Montant calculé (jours × tarif)" tone="primary" value={<MoneyText value={amount} bold />} />
          </div>
        </div>

        <div className="sticky bottom-0 flex justify-end gap-3 border-t border-base-200 bg-base-100 pb-1 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11 sm:min-h-0"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Annuler
          </button>
          <button
            type="button"
            className="btn btn-primary min-h-11 sm:min-h-0"
            onClick={() => void submit()}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              'Affecter'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 6. Annulation d'une commande — motif obligatoire
 * ------------------------------------------------------------------ */

export function CancelOrderDialog({
  isOpen,
  onClose,
  onConfirm,
  orderNumber,
  isSubmitting,
  reason,
  onReasonChange,
  reasonError,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  orderNumber: string;
  isSubmitting: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
  reasonError: string | null;
}) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title={`Annuler la commande ${orderNumber}`}
      tone="error"
      confirmLabel="Annuler la commande"
      isSubmitting={isSubmitting}
      message={
        <>
          La commande sera <strong>annulée</strong>, jamais supprimée : elle reste consultable avec son
          motif, et les matières déjà sorties <strong>retournent au stock</strong>.
          <br />
          <span className="text-sm">
            Un meuble déjà livré n’est pas dé-crédité automatiquement : traitez le retour de
            marchandise comme une opération distincte.
          </span>
        </>
      }
    >
      <FormField
        label="Motif d’annulation"
        htmlFor="cancel-order-reason"
        required
        error={reasonError}
        hint="Obligatoire — il est conservé dans la fiche et dans le journal d’actions."
      >
        <textarea
          id="cancel-order-reason"
          rows={3}
          className="textarea textarea-bordered w-full"
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="Ex. le client a annulé sa commande par téléphone"
        />
      </FormField>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ *
 * 7. Désactivation d'un modèle
 * ------------------------------------------------------------------ */

export function DeactivateModelDialog({
  isOpen,
  onClose,
  onConfirm,
  model,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  model: FurnitureModelRow | null;
  isSubmitting: boolean;
}) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Désactiver le modèle"
      tone="warning"
      confirmLabel="Désactiver"
      isSubmitting={isSubmitting}
      message={
        <>
          <strong>{model?.name ?? 'Ce modèle'}</strong> ne sera plus proposé pour les nouvelles
          commandes.
          <br />
          <span className="text-sm">
            Aucune donnée n’est supprimée : la nomenclature et les commandes passées restent
            consultables, et le modèle peut être réactivé.
          </span>
          {model && model.orderCount > 0 && (
            <span className="mt-2 block rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-warning">
              Ce modèle est utilisé par {formatNumber(model.orderCount)} commande
              {model.orderCount > 1 ? 's' : ''}.
            </span>
          )}
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * 8. Colonnes partagées
 * ------------------------------------------------------------------ */

/** Colonnes de la nomenclature, réutilisées par la page des modèles. */
export const modelColumns: Column<FurnitureModelRow>[] = [
  {
    key: 'code',
    label: 'Code',
    className: 'font-mono text-xs whitespace-nowrap',
    render: (model) => model.code,
  },
  {
    key: 'name',
    label: 'Modèle',
    primary: true,
    render: (model) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{model.name}</div>
        {!model.isActive && (
          <div className="mt-1">
            <Badge tone="neutral">Inactif</Badge>
          </div>
        )}
      </div>
    ),
  },
  {
    key: 'dimensions',
    label: 'Dimensions standard',
    hideOnMobile: true,
    render: (model) => (
      <span className="text-sm text-base-content/70">{model.standardDimensions || '—'}</span>
    ),
  },
  {
    key: 'laborHours',
    label: 'Main-d’œuvre',
    render: (model) => <QuantityText value={model.laborHours} unit="h" />,
  },
  {
    key: 'salePrice',
    label: 'Prix de vente',
    className: 'text-right whitespace-nowrap',
    render: (model) => <MoneyText value={model.salePrice} bold />,
  },
  {
    key: 'materialCount',
    label: 'Matériaux',
    render: (model) =>
      model.materialCount === 0 ? (
        <Badge tone="warning">Nomenclature vide</Badge>
      ) : (
        <span className="tabular">{formatNumber(model.materialCount)}</span>
      ),
  },
  {
    key: 'estimatedMaterialCost',
    label: 'Coût matière / unité',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (model) => <MoneyText value={model.estimatedMaterialCost} />,
  },
  {
    key: 'materials',
    label: 'Nomenclature',
    hideOnMobile: true,
    render: (model) => (
      <span className="text-sm text-base-content/70">
        {model.materialCount > 0
          ? `${formatNumber(model.materialCount)} matière${model.materialCount > 1 ? 's' : ''}`
          : 'À compléter'}
      </span>
    ),
  },
];

/** Colonnes des matériaux d'une commande (fiche commande). */
export const orderMaterialColumns: Column<FurnitureOrderMaterialRow>[] = [
  {
    key: 'productName',
    label: 'Matière',
    primary: true,
    render: (line) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{line.productName}</div>
      </div>
    ),
  },
  {
    key: 'quantity',
    label: 'Quantité',
    className: 'text-right whitespace-nowrap',
    render: (line) => <QuantityText value={line.quantity} unit={line.unit} />,
  },
  {
    key: 'wastageQuantity',
    label: 'Chutes / pertes',
    render: (line) =>
      line.wastageQuantity > 0 ? (
        <Badge tone="warning">
          <QuantityText value={line.wastageQuantity} unit={line.unit} />
        </Badge>
      ) : (
        <span className="text-sm text-base-content/50">Aucune</span>
      ),
  },
  {
    key: 'unitCost',
    label: 'Coût unitaire',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (line) => <MoneyText value={line.unitCost} />,
  },
  {
    key: 'amount',
    label: 'Montant',
    className: 'text-right whitespace-nowrap',
    render: (line) => <MoneyText value={line.amount} bold />,
  },
];

/** Colonnes de l'équipe affectée à une commande. */
export const orderWorkerColumns: Column<FurnitureOrderWorkerRow>[] = [
  {
    key: 'workerName',
    label: 'Ouvrier',
    primary: true,
    render: (line) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{line.workerName}</div>
        {line.workerId == null && <div className="text-xs text-base-content/50">Journalier</div>}
      </div>
    ),
  },
  {
    key: 'role',
    label: 'Rôle',
    hideOnMobile: true,
    render: (line) => <span className="text-sm">{line.role || '—'}</span>,
  },
  {
    key: 'days',
    label: 'Jours',
    className: 'text-right whitespace-nowrap',
    render: (line) => <QuantityText value={line.days} unit="j" />,
  },
  {
    key: 'dailyRate',
    label: 'Tarif / jour',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (line) => <MoneyText value={line.dailyRate} />,
  },
  {
    key: 'amount',
    label: 'Montant',
    className: 'text-right whitespace-nowrap',
    render: (line) => <MoneyText value={line.amount} bold />,
  },
];

/** Ligne « dates et délai » d'une fiche commande. */
export function DeliveryTiming({ detail }: { detail: FurnitureOrderDetail }) {
  const { order } = detail;

  return (
    <Card className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Délai de livraison</h2>
        {order.isCancelled ? (
          <Badge tone="error">Annulée</Badge>
        ) : order.isDelivered ? (
          order.isDeliveredOnTime ? (
            <Badge tone="success">Livré à temps</Badge>
          ) : order.isLate ? (
            <Badge tone="error">En retard</Badge>
          ) : (
            <Badge tone="success">Livré</Badge>
          )
        ) : order.promisedDate && order.promisedDate < today() ? (
          <Badge tone="warning">Délai promis dépassé</Badge>
        ) : (
          <Badge tone="info">En cours</Badge>
        )}
      </div>

      <div className="divide-y divide-base-200/70">
        <InfoRow label="Date de début">{formatDateShort(order.startDate)}</InfoRow>
        <InfoRow label="Date promise">{formatDateShort(order.promisedDate)}</InfoRow>
        <InfoRow label="Date de livraison">{formatDateShort(order.deliveryDate)}</InfoRow>
        <InfoRow label="Commande créée le">{formatDateShort(order.createdAt)}</InfoRow>
      </div>

      {order.isDelivered && order.promisedDate && order.deliveryDate && (
        <p
          className={`rounded-xl border px-3 py-2 text-sm ${
            order.isLate
              ? 'border-error/30 bg-error/10 text-error'
              : 'border-success/30 bg-success/10 text-success'
          }`}
        >
          {order.isLate
            ? `Livré le ${formatDateShort(order.deliveryDate)}, après la date promise du ${formatDateShort(order.promisedDate)}.`
            : `Livré le ${formatDateShort(order.deliveryDate)}, dans le délai promis du ${formatDateShort(order.promisedDate)}.`}
        </p>
      )}
    </Card>
  );
}
