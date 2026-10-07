'use client';

/**
 * Modales du module Atelier de meubles (README §29).
 *
 * Une modale par **état booléen** : les pages pilotent `showFormModal`,
 * `showMaterialModal`, `showWorkerModal`, `showCancelDialog`…
 *
 * Toutes les écritures passent par `/api/atelier/**`. Aucun import runtime
 * d'un module serveur (`lib/furniture.ts` importe `@/db`, invariant 6) : les
 * types sont importés en `import type`, les constantes viennent de
 * `lib/furniture-shared.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
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
import { useSettings } from '@/app/parametres/page';
import { usePermission } from '@/components/role-gate';
import type {
  FurnitureModelMaterialRow,
  FurnitureModelRow,
  FurnitureOrderDetail,
  FurnitureOrderMaterialRow,
  FurnitureOrderRow,
  FurnitureOrderWorkerRow,
  FurnitureRequirementLine,
} from '@/lib/furniture';
import type { FurniturePurpose } from '@/lib/furniture-shared';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, today } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types locaux et aides
 * ------------------------------------------------------------------ */

export type ProductOption = {
  id: number;
  name: string;
  unit: string;
  purchasePrice: number;
  /** Stock **du magasin actif**. */
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
 * Produits du magasin actif, avec leur **stock dans ce magasin** : la modale de
 * matière doit montrer ce qui peut réellement sortir.
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
    name: String(row.name ?? ''),
    unit: String(row.unit ?? 'pièce'),
    purchasePrice: Number(row.purchasePrice ?? 0),
    stock: Number(row.stock ?? 0),
    categoryKind: row.categoryKind ?? null,
  }));
}

/** Clients **du magasin actif** (README §28.5). */
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

/** Ouvriers du magasin actif — référentiel partagé avec les chantiers. */
export async function fetchWorkers(signal?: AbortSignal): Promise<WorkerOption[]> {
  const response = await fetch('/api/workers?limit=500&sort=name', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Ouvriers indisponibles'));

  return normaliseList(await response.json()).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    role: row.role ?? null,
    dailyRate: Number(row.dailyRate ?? row.daily_rate ?? 0),
  }));
}

/** Modèles actifs **du magasin actif** (seuls utilisables pour une commande). */
export async function fetchFurnitureModels(signal?: AbortSignal): Promise<FurnitureModelRow[]> {
  const response = await fetch('/api/atelier/modeles?limit=500&page=1&sort=name', {
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
  purpose: FurniturePurpose;
  customerId: string;
  customerName: string;
  isCustom: boolean;
  modelId: string;
  dimensions: string;
  finish: string;
  quantity: string;
  startDate: string;
  promisedDate: string;
  agreedPrice: string;
  productId: string;
  notes: string;
};

function emptyOrderForm(): OrderFormValues {
  return {
    purpose: 'customer',
    customerId: '',
    customerName: '',
    isCustom: false,
    modelId: '',
    dimensions: '',
    finish: '',
    quantity: '1',
    startDate: today(),
    promisedDate: '',
    agreedPrice: '',
    productId: '',
    notes: '',
  };
}

function orderFormFromDetail(detail: FurnitureOrderDetail): OrderFormValues {
  const { order } = detail;
  return {
    purpose: order.purpose,
    customerId: order.customerId ? String(order.customerId) : '',
    customerName: order.customerId || order.purpose === 'stock' ? '' : order.customerName,
    isCustom: order.isCustom,
    modelId: order.modelId ? String(order.modelId) : '',
    dimensions: order.dimensions ?? '',
    finish: order.finish ?? '',
    quantity: String(order.quantity ?? 1),
    startDate: order.startDate ?? '',
    promisedDate: order.promisedDate ?? '',
    agreedPrice: order.total ? String(order.total) : '',
    productId: order.productId ? String(order.productId) : '',
    notes: order.notes ?? '',
  };
}

/** Aperçu des besoins calculés depuis la nomenclature, sur le stock du magasin. */
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
        Ce modèle n’a pas de nomenclature : les matières s’ajouteront à la main sur la fiche de la
        commande.
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
            {missing.length} matière{missing.length > 1 ? 's' : ''} à acheter
          </Badge>
        )}
      </div>

      <RequirementsList lines={requirements.lines} />

      <p className="text-xs text-base-content/60">
        Rien ne sort du stock à la création. Sur la fiche de la commande, « Sortir les matières
        prévues » les consomme réellement ; les chutes se saisissent ligne par ligne.
      </p>
    </div>
  );
}

/** Liste des besoins : requis, déjà sorti, stock, manque. */
export function RequirementsList({ lines }: { lines: FurnitureRequirementLine[] }) {
  return (
    <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
      {lines.map((line) => (
        <li key={line.productId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="min-w-0 font-medium">{line.productName}</span>
          <span className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-base-content/60">
              Besoin <QuantityText value={line.requiredQuantity} unit={line.unit} />
            </span>
            {line.consumedQuantity > 0 && (
              <span className="text-xs text-base-content/60">
                Sorti <QuantityText value={line.consumedQuantity} unit={line.unit} />
              </span>
            )}
            <span className="text-xs text-base-content/60">
              Stock <QuantityText value={line.availableStock} unit={line.unit} />
            </span>
            {line.toConsumeQuantity <= 0 ? (
              <Badge tone="success">Sorti</Badge>
            ) : line.isCovered ? (
              <Badge tone="info">Disponible</Badge>
            ) : (
              <Badge tone="warning">
                Manque <QuantityText value={line.missingQuantity} unit={line.unit} />
              </Badge>
            )}
          </span>
        </li>
      ))}
    </ul>
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
  onSaved: (saved: { id: number }) => void;
  /** `null` = création, sinon modification. */
  order?: FurnitureOrderDetail | null;
  models: FurnitureModelRow[];
  customers: CustomerOption[];
  products: ProductOption[];
  isOptionsLoading?: boolean;
  idPrefix?: string;
}) {
  const isEdit = Boolean(order);
  const isDelivered = Boolean(order?.order.isDelivered);
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

  /* Aperçu des besoins : uniquement à la création d'une commande liée à un modèle. */
  useEffect(() => {
    if (!isOpen || isEdit || values.isCustom || !values.modelId) {
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
        if (!response.ok) throw new Error(await readApiError(response, 'Besoins indisponibles'));
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
  }, [isOpen, isEdit, values.isCustom, values.modelId, values.quantity]);

  const setField = <K extends keyof OrderFormValues>(key: K, value: OrderFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  /** Un modèle choisi propose son prix de vente (× quantité) si le prix est vide. */
  const pickModel = (modelId: string) => {
    setValues((current) => {
      const model = models.find((m) => String(m.id) === modelId);
      const quantity = Number(current.quantity) || 1;
      const suggested = model && model.salePrice > 0 && !current.agreedPrice.trim() ? String(model.salePrice * quantity) : current.agreedPrice;
      return { ...current, modelId, agreedPrice: current.purpose === 'customer' ? suggested : current.agreedPrice };
    });
  };

  const isStock = values.purpose === 'stock';

  const submit = async () => {
    const quantity = Number(values.quantity);

    if (!values.isCustom && !values.modelId) {
      setFormError('Choisissez un modèle, ou cochez « Meuble sur mesure ».');
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
    if (isStock && !values.productId) {
      setFormError('Choisissez le produit fini qui entrera en stock à la fin de la fabrication.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    const payload: Record<string, unknown> = {
      dimensions: values.dimensions.trim() || null,
      finish: values.finish.trim() || null,
      startDate: values.startDate || null,
      promisedDate: values.promisedDate || null,
      notes: values.notes.trim() || null,
    };
    // Une commande livrée ne change plus de meuble : on n'envoie pas ces champs.
    if (!isDelivered) {
      payload.isCustom = values.isCustom;
      payload.modelId = values.isCustom ? null : Number(values.modelId);
      payload.quantity = quantity;
      if (isStock) payload.productId = Number(values.productId);
    }
    if (!isStock) {
      payload.customerId = values.customerId ? Number(values.customerId) : null;
      payload.customerName = values.customerId ? null : values.customerName.trim() || null;
      payload.agreedPrice = values.agreedPrice.trim() ? Number(values.agreedPrice) : 0;
    }
    if (!isEdit) payload.purpose = values.purpose;

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
      const saved = (await response.json()) as { id?: number; order?: { id: number } };
      onSaved({ id: Number(saved.order?.id ?? saved.id) });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "La commande n'a pas pu être enregistrée.");
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
          {!isEdit && (
            <fieldset className="sm:col-span-2">
              <legend className="mb-2 text-sm font-medium">Pour qui ce meuble ?</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(['customer', 'stock'] as FurniturePurpose[]).map((purpose) => (
                  <label
                    key={purpose}
                    className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 ${
                      values.purpose === purpose ? 'border-primary bg-primary/5' : 'border-base-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name={fieldId('purpose')}
                      className="radio radio-primary mt-0.5"
                      checked={values.purpose === purpose}
                      onChange={() => setField('purpose', purpose)}
                    />
                    <span className="text-sm">
                      {purpose === 'customer' ? 'Un client' : 'Le stock du magasin'}
                      <span className="block text-xs text-base-content/60">
                        {purpose === 'customer'
                          ? 'Commande facturée au prix convenu ; acomptes et solde s’encaissent sur la fiche.'
                          : 'Fabrication sans client : le meuble fini entre en stock à la dernière étape.'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {!isStock && (
            <>
              <FormField
                label="Client"
                htmlFor={fieldId('customer')}
                hint="Clients de ce magasin. Laisser vide pour un client de passage."
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
            </>
          )}

          <label className="flex min-h-11 cursor-pointer items-center gap-3 sm:col-span-2">
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={values.isCustom}
              disabled={isDelivered}
              onChange={(event) => {
                const isCustom = event.target.checked;
                setValues((current) => ({ ...current, isCustom, modelId: isCustom ? '' : current.modelId }));
              }}
            />
            <span className="text-sm">
              Meuble sur mesure
              <span className="block text-xs text-base-content/60">
                Sans nomenclature : les matières se saisissent sur la fiche de la commande. Les
                dimensions deviennent obligatoires.
              </span>
            </span>
          </label>

          <FormField
            label="Modèle"
            htmlFor={fieldId('model')}
            required={!values.isCustom}
            hint={values.isCustom ? 'Sans objet pour une commande sur mesure.' : 'Modèles actifs de ce magasin.'}
          >
            <select
              id={fieldId('model')}
              className="select select-bordered min-h-11 w-full sm:min-h-0"
              value={values.modelId}
              onChange={(event) => pickModel(event.target.value)}
              disabled={values.isCustom || isOptionsLoading || isDelivered}
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
              disabled={isDelivered}
              onChange={(event) => setField('quantity', event.target.value)}
            />
          </FormField>

          <FormField label="Dimensions" htmlFor={fieldId('dimensions')} required={values.isCustom} hint="Ex. 200 × 90 × 75 cm">
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
            <DatePicker value={values.startDate} onChange={(value) => setField('startDate', value)} placeholder="jj mois aaaa" />
          </FormField>

          <FormField label="Date promise" htmlFor={fieldId('promised')} hint="Base de l’indicateur « livré à temps ».">
            <DatePicker value={values.promisedDate} onChange={(value) => setField('promisedDate', value)} placeholder="jj mois aaaa" />
          </FormField>

          {isStock ? (
            <FormField
              label="Meuble fini (entre en stock)"
              htmlFor={fieldId('product')}
              required
              hint="Ce produit reçoit les unités fabriquées à la dernière étape — une seule fois."
              className="sm:col-span-2"
            >
              <select
                id={fieldId('product')}
                className="select select-bordered min-h-11 w-full sm:min-h-0"
                value={values.productId}
                onChange={(event) => setField('productId', event.target.value)}
                disabled={isOptionsLoading || isDelivered}
              >
                <option value="">Sélectionner le produit fini…</option>
                {finishedGoods.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </FormField>
          ) : (
            <FormField
              label="Prix convenu (GNF)"
              htmlFor={fieldId('agreed')}
              hint="Montant facturé au client. Les acomptes s’encaissent ensuite sur la fiche (reçu et caisse)."
              className="sm:col-span-2"
            >
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
          )}

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

        {!isEdit && !values.isCustom && values.modelId && (
          <div className="mt-4">
            <RequirementsPreview requirements={requirements} isLoading={requirementsLoading} error={requirementsError} />
          </div>
        )}

        <div className="sticky bottom-0 -mx-1 mt-5 flex justify-end gap-3 border-t border-base-200 bg-base-100 px-1 pb-1 pt-4">
          <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-0" disabled={isSubmitting}>
            {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : isEdit ? 'Enregistrer' : 'Créer la commande'}
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
  readOnly = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (materials: FurnitureModelMaterialRow[]) => void;
  model: FurnitureModelRow | null;
  products: ProductOption[];
  isOptionsLoading?: boolean;
  /** Consultation seule : modèle d'un autre magasin, ou pas le droit de le gérer. */
  readOnly?: boolean;
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
          Matières nécessaires pour <strong>une</strong> unité du modèle. Les besoins d’une commande se
          <strong> calculent</strong> depuis cette liste, sur le stock de ce magasin. La modifier ne
          change aucune commande déjà enregistrée.
        </p>

        {isLoading ? (
          <SkeletonTable rows={4} cols={4} />
        ) : readOnly && !loadError ? (
          materials.length === 0 ? (
            <p className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-6 text-center text-sm text-base-content/60">
              Aucun matériau dans la nomenclature.
            </p>
          ) : (
            <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
              {materials.map((material) => (
                <li key={material.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="font-medium">{material.productName}</span>
                  <span className="flex flex-wrap items-center gap-3 text-xs text-base-content/70">
                    <span>
                      Par unité <QuantityText value={material.quantity} unit={material.unit} />
                    </span>
                    <span>
                      Stock <QuantityText value={material.availableStock} unit={material.unit} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )
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
                Aucun matériau dans la nomenclature. Ajoutez au moins une ligne pour que les besoins des
                commandes se calculent.
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
                                  {option.name} ({option.unit})
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
          {!readOnly && (
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
          )}
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
                ? 'Aucun produit dans ce magasin : ajoutez les matières premières au catalogue.'
                : 'Stock de ce magasin. Rien ne sort si le stock ne suffit pas.'
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
            hint="Sortie distincte, lisible dans le journal de stock ; comptée dans le coût."
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
              value={<MoneyText value={totalExit * (Number(unitCost) || 0)} />}
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
            hint="Ouvriers de ce magasin (chef menuisier, ouvrier, apprenti)."
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
          motif, et les matières déjà sorties (chutes comprises) <strong>retournent au stock</strong>.
          <br />
          <span className="text-sm">
            Les acomptes déjà encaissés restent enregistrés dans la caisse : un remboursement se fait à
            part. Une commande livrée ou mise en stock ne s’annule pas.
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
        <h2 className="text-base font-semibold">{order.purpose === 'stock' ? 'Délai de fabrication' : 'Délai de livraison'}</h2>
        {order.isCancelled ? (
          <Badge tone="error">Annulée</Badge>
        ) : order.isDelivered ? (
          order.isDeliveredOnTime ? (
            <Badge tone="success">{order.purpose === 'stock' ? 'Fini à temps' : 'Livré à temps'}</Badge>
          ) : order.isLate ? (
            <Badge tone="error">En retard</Badge>
          ) : (
            <Badge tone="success">{order.stageLabel}</Badge>
          )
        ) : order.isLate ? (
          <Badge tone="warning">Délai promis dépassé</Badge>
        ) : (
          <Badge tone="info">En cours</Badge>
        )}
      </div>

      <div className="divide-y divide-base-200/70">
        <InfoRow label="Date de début">{formatDateShort(order.startDate)}</InfoRow>
        <InfoRow label="Date promise">{formatDateShort(order.promisedDate)}</InfoRow>
        <InfoRow label={order.purpose === 'stock' ? 'Mis en stock le' : 'Date de livraison'}>{formatDateShort(order.deliveryDate)}</InfoRow>
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
            ? `${order.stageLabel} le ${formatDateShort(order.deliveryDate)}, après la date promise du ${formatDateShort(order.promisedDate)}.`
            : `${order.stageLabel} le ${formatDateShort(order.deliveryDate)}, dans le délai promis du ${formatDateShort(order.promisedDate)}.`}
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * 9. Encaissement d'une commande client (acompte, solde)
 *
 * Remplace le champ « Acompte reçu » de la v1, saisi à la main sans reçu ni
 * mouvement de caisse : un encaissement passe désormais par `POST
 * /api/paiements` (`type: 'furniture_order'`), qui émet le reçu, alimente la
 * caisse du magasin et recalcule le reste à payer (invariant 2).
 * ------------------------------------------------------------------ */

export function FurniturePaymentModal({
  isOpen,
  onClose,
  order,
  onRecorded,
}: {
  isOpen: boolean;
  onClose: () => void;
  order: FurnitureOrderRow | null;
  onRecorded?: (payment: { id: number; receiptNumber: string }) => void;
}) {
  const { settings } = useSettings();
  const canCreate = usePermission('payments.create');
  const remainingAmount = order?.remainingAmount ?? 0;

  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Espèces');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<{ id: number; receiptNumber: string } | null>(null);

  const paymentMethods = useMemo(() => {
    const configured = settings.paymentMethods?.filter((method) => Boolean(method?.trim())) ?? [];
    return configured.length > 0 ? configured : ['Espèces', 'Mobile Money', 'Virement', 'Crédit'];
  }, [settings.paymentMethods]);

  useEffect(() => {
    if (!isOpen) return;
    setAmount(remainingAmount > 0 ? String(remainingAmount) : '');
    setNotes('');
    setDate(today());
    setPaymentMethod('Espèces');
    setFormError(null);
    setReceipt(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, order?.id]);

  const paid = Number(String(amount).replace(',', '.'));
  const remainingAfter = Math.max(remainingAmount - (Number.isFinite(paid) ? paid : 0), 0);

  async function submit() {
    if (!order) return;
    if (!canCreate) {
      setFormError('Vous n’avez pas la permission d’enregistrer un encaissement.');
      return;
    }
    if (!Number.isFinite(paid) || paid <= 0) {
      setFormError('Le montant doit être supérieur à zéro.');
      return;
    }
    if (paid > remainingAmount + 0.01) {
      setFormError(`Le montant dépasse le reste à payer (${formatNumber(remainingAmount)} GNF).`);
      return;
    }
    setFormError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch('/api/paiements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          type: 'furniture_order',
          referenceId: order.id,
          amount: paid,
          paymentMethod,
          date,
          notes: notes.trim() || null,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response, "L'encaissement n'a pas pu être enregistré."));
      const payment = (await response.json()) as { id: number; receiptNumber: string };
      setReceipt(payment);
      onRecorded?.(payment);
      toast.success(`Encaissement enregistré — reçu ${payment.receiptNumber}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "L'encaissement n'a pas pu être enregistré.";
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title="Encaisser sur la commande"
      size="lg"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-base-200 bg-base-200/50 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {order?.orderNumber} — {order?.customerName ?? 'Client'}
            </p>
            <p className="text-xs text-base-content/60">Reste à payer</p>
          </div>
          <MoneyText value={remainingAmount} remaining={order?.status === 'active'} bold className="text-lg" />
        </div>

        {receipt ? (
          <div className="space-y-3 rounded-xl border border-success/30 bg-success/10 p-4">
            <p className="text-sm font-medium text-success">Encaissement enregistré — reçu {receipt.receiptNumber}.</p>
            <a href={`/recus/${receipt.id}`} className="btn btn-success btn-sm min-h-11 sm:min-h-0">
              Voir le reçu
            </a>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Montant encaissé" htmlFor="furniture-payment-amount" required>
                <input
                  id="furniture-payment-amount"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  className="input input-bordered min-h-11 w-full tabular"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setFormError(null);
                  }}
                  disabled={isSubmitting}
                  placeholder="0"
                />
              </FormField>
              <FormField label="Moyen de paiement" htmlFor="furniture-payment-method">
                <select
                  id="furniture-payment-method"
                  className="select select-bordered min-h-11 w-full"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                  disabled={isSubmitting}
                >
                  {paymentMethods.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <FormField label="Date de l’encaissement">
              <DatePicker value={date} onChange={setDate} placeholder="Date" />
            </FormField>
            <FormField label="Note" htmlFor="furniture-payment-notes">
              <input
                id="furniture-payment-notes"
                type="text"
                className="input input-bordered min-h-11 w-full"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={isSubmitting}
                placeholder="Ex. acompte à la commande"
              />
            </FormField>
            <div className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Reste après encaissement</span>
                <MoneyText value={remainingAfter} remaining bold />
              </div>
            </div>
          </>
        )}

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Fermer
          </button>
          {!receipt && (
            <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
              {isSubmitting ? <span className="loading loading-spinner loading-sm" aria-hidden /> : 'Enregistrer l’encaissement'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
