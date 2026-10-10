'use client';

/**
 * Modales et pièces partagées du module « Commandes de briques » (README §20).
 *
 * ## Pourquoi les types sont redéclarés ici
 *
 * Ce fichier est un **composant client**. `lib/brick-orders.ts` importe `@/db`
 * (donc `@libsql/client`, `fs`, `path`) : un import — même partiel — ferait
 * entrer la chaîne base de données dans le bundle navigateur et casserait le
 * build (CONVENTIONS §11 bis). Les types ci-dessous sont donc le **miroir
 * exact** du JSON renvoyé par branchApiUrl(`/commandes*`), et toute écriture
 * passe par l'API.
 *
 * ## Ce qu'une commande fait — et ne fait pas
 *
 * La commande **ne touche jamais le stock** : elle engage un client sur des
 * quantités, à un prix négocié. C'est la **facture** (action `invoice`, bouton
 * « Facturer » de la fiche) qui sort le stock et fait entrer le chiffre
 * d'affaires, en transférant les acomptes déjà encaissés. Aucune modale d'ici
 * n'écrit `products.stock`.
 *
 * ## Une modale = un état booléen
 *
 * Chaque modale est pilotée par un booléen distinct chez l'appelant
 * (`isCreateOpen`, `isPaymentOpen`, `isCancelOpen`…) et jamais par un « mode »
 * en chaîne (§8.3 règle 1).
 */

import { branchApiUrl, useBranch } from '@/components/filiales/branch-context';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Combobox } from '@/components/combobox';
import { DatePicker } from '@/components/date-picker';
import type { Column } from '@/components/responsive-table';
import {
  Badge,
  EmptyState,
  FormField,
  InfoRow,
  MoneyText,
  QuantityText,
  type BadgeTone,
} from '@/components/design-system';
import { CustomerFormModal, type CustomerRecord } from '@/components/clients/clients-modals';
import { useSettings } from '@/app/parametres/page';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, formatQuantity, today } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types — miroir du JSON de l'API
 * ------------------------------------------------------------------ */

export type BrickOrderStatus =
  | 'draft'
  | 'confirmed'
  | 'in_production'
  | 'ready'
  | 'partially_delivered'
  | 'delivered'
  | 'cancelled';

export type BrickOrderItemRow = {
  id: number;
  orderId: number;
  brickTypeId: number | null;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  amount: number;
  deliveredQuantity: number;
};

export type BrickOrderRow = {
  id: number;
  orderNumber: string;
  customerId: number | null;
  customerName: string;
  userId: number | null;
  userName: string | null;
  /** Date métier `YYYY-MM-DD`. */
  date: string;
  dueDate: string | null;
  deliveryDate: string | null;
  promisedDate: string | null;
  subTotal: number;
  discount: number;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  status: BrickOrderStatus;
  salesInvoiceId: number | null;
  salesInvoiceNumber: string | null;
  cancelReason: string | null;
  notes: string | null;
  itemsCount: number;
  quantityOrdered: number;
  quantityDelivered: number;
  isCancelled: boolean;
  createdAt: string | null;
};

export type BrickOrderPaymentRow = {
  id: number;
  receiptNumber: string;
  amount: number;
  paymentMethod: string;
  paymentLabel: string;
  date: string;
  notes: string | null;
};

export type BrickOrderSchedule = {
  total: number;
  paid: number;
  remaining: number;
  paymentStatus: string;
  dueDate: string | null;
  documentDate: string | null;
  isOverdue: boolean;
  payments: unknown[];
};

export type BrickOrderDetail = {
  order: BrickOrderRow;
  items: BrickOrderItemRow[];
  payments: BrickOrderPaymentRow[];
  schedule: BrickOrderSchedule;
};

export type Paginated<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

/** Type de brique proposé à la saisie — `GET /api/briqueterie/types?limit=200`. */
export type BrickTypeOption = {
  id: number;
  name: string;
  productId: number;
  productName: string;
  unit: string;
  salePrice: number;
  isActive: boolean;
  shape: string | null;
  dimensions: string | null;
  /**
   * Stock du **produit lié**, lu sur `GET /api/briqueterie/stock`.
   *
   * Il ne s'agit pas d'une réserve : une commande n'engage aucun stock et peut
   * précéder la fabrication. C'est un repère de saisie, pour ne pas promettre
   * une quantité invendable sans le dire.
   */
  stock: number;
};

/** Client issu de `/api/clients` — mêmes fiches que l'écran `/clients`. */
export type CustomerOption = {
  id: number;
  name: string;
  phone: string | null;
  creditLimit: number;
};

/** Entrée du journal d'actions d'une commande. */
export type BrickOrderHistoryEntry = {
  id: number;
  userName: string;
  action: string;
  entity: string;
  entityId: number | null;
  details: string | null;
  createdAt: string | null;
};

/* ------------------------------------------------------------------ *
 * Libellés et teintes — jamais la couleur seule (§5.5 règle 4)
 * ------------------------------------------------------------------ */

export const BRICK_ORDER_STATUS_LABELS: Record<BrickOrderStatus, string> = {
  draft: 'Brouillon',
  confirmed: 'Confirmée',
  in_production: 'En production',
  ready: 'Prête',
  partially_delivered: 'Partiellement livrée',
  delivered: 'Livrée',
  cancelled: 'Annulée',
};

export const BRICK_ORDER_STATUS_TONES: Record<BrickOrderStatus, BadgeTone> = {
  draft: 'neutral',
  confirmed: 'info',
  in_production: 'warning',
  ready: 'primary',
  partially_delivered: 'info',
  delivered: 'success',
  cancelled: 'error',
};

/** Statuts affichés par le filtre de la liste, dans l'ordre du cycle de vie. */
export const BRICK_ORDER_STATUS_OPTIONS: { value: BrickOrderStatus; label: string }[] = (
  [
    'draft',
    'confirmed',
    'in_production',
    'ready',
    'partially_delivered',
    'delivered',
    'cancelled',
  ] as BrickOrderStatus[]
).map((value) => ({ value, label: BRICK_ORDER_STATUS_LABELS[value] }));

export function brickOrderStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return BRICK_ORDER_STATUS_LABELS[status as BrickOrderStatus] ?? status;
}

/**
 * Statuts atteignables par le bouton « changer d'état », **recopiés** depuis
 * `STATUS_TRANSITIONS` de `lib/brick-orders.ts`.
 *
 * ⚠️ La règle qui fait foi vit côté serveur : un appel direct à l'API la
 * subit aussi. Cette table ne sert qu'à ne pas proposer un bouton voué à
 * l'échec ; `cancelled` n'y figure pas, il a son propre bouton motivé, et
 * `delivered` s'obtient par une livraison complète, jamais par un saut d'état.
 */
export const BRICK_ORDER_NEXT_STATUSES: Record<BrickOrderStatus, BrickOrderStatus[]> = {
  draft: ['confirmed'],
  confirmed: ['in_production'],
  in_production: ['ready'],
  ready: ['partially_delivered', 'delivered'],
  partially_delivered: ['delivered'],
  delivered: [],
  cancelled: [],
};

/** Verbe à l'impératif d'un passage d'état, pour le libellé du bouton. */
export const BRICK_ORDER_STATUS_ACTIONS: Partial<Record<BrickOrderStatus, string>> = {
  confirmed: 'Confirmer la commande',
  in_production: 'Passer en production',
  ready: 'Marquer prête',
  partially_delivered: 'Marquer partiellement livrée',
  delivered: 'Marquer livrée',
};

/** Statuts qui acceptent une saisie de quantité livrée (§ `registerBrickOrderDelivery`). */
export function canRegisterDelivery(status: BrickOrderStatus): boolean {
  return status === 'ready' || status === 'partially_delivered';
}

/* ------------------------------------------------------------------ *
 * Lecture des listes d'appoint
 * ------------------------------------------------------------------ */

/** Message lisible à partir d'une réponse d'API en échec. */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const message = (payload as { error?: unknown }).error;
      if (typeof message === 'string' && message.trim()) return message;
    }
  } catch {
    /* Corps illisible : on garde le message générique. */
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

/** Types de briques actifs : ils portent le prix pré-rempli des lignes. */
export async function fetchBrickTypes(signal?: AbortSignal): Promise<BrickTypeOption[]> {
  const response = await fetch(branchApiUrl('/modeles?limit=200'), {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Modèles indisponibles'));

  return normaliseList(await response.json()).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    productId: Number(row.productId ?? 0),
    productName: String(row.productName ?? ''),
    unit: String(row.unit ?? 'pièce'),
    salePrice: Number(row.salePrice ?? 0),
    isActive: row.isActive !== false,
    shape: row.shape ?? null,
    dimensions: row.dimensions ?? null,
    stock: 0,
  }));
}

/**
 * Stock des briques finies, par type.
 *
 * Liste d'appoint : un échec laisse le stock à zéro sans masquer la page, et
 * l'interface ne prétend alors rien sur la disponibilité.
 */
export async function fetchBrickTypeStocks(signal?: AbortSignal): Promise<Map<number, number>> {
  const response = await fetch(branchApiUrl('/stock'), {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Stock indisponible'));

  const stocks = new Map<number, number>();
  for (const row of normaliseList(await response.json())) {
    stocks.set(Number(row.brickTypeId ?? row.id ?? 0), Number(row.stock ?? 0));
  }
  return stocks;
}

/** Clients enregistrés — les mêmes fiches que l'écran `/clients`. */
export async function fetchCustomers(signal?: AbortSignal): Promise<CustomerOption[]> {
  const response = await fetch('/api/clients?limit=500', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Clients indisponibles'));

  return normaliseList(await response.json()).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    phone: row.phone == null ? null : String(row.phone),
    creditLimit: Number(row.creditLimit ?? 0),
  }));
}

/**
 * Historique d'**une** commande.
 *
 * `GET /api/briqueterie/historique` est en lecture seule et n'est **pas**
 * journalisé (consulter un historique n'est pas une opération à tracer) : son
 * échec ne doit donc jamais empêcher l'affichage d'une fiche.
 */
export async function fetchBrickOrderHistory(
  orderId: number,
  signal?: AbortSignal,
): Promise<BrickOrderHistoryEntry[]> {
  const params = new URLSearchParams({
    entity: 'brick_order',
    entityId: String(orderId),
    limit: '50',
  });

  const response = await fetch(branchApiUrl(`/historique?${params.toString()}`), {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response, 'Historique indisponible'));

  return normaliseList(await response.json()).map((row) => ({
    id: Number(row.id),
    userName: String(row.userName ?? 'Système'),
    action: String(row.action ?? ''),
    entity: String(row.entity ?? 'brick_order'),
    entityId: row.entityId == null ? null : Number(row.entityId),
    details: row.details == null ? null : String(row.details),
    createdAt: row.createdAt == null ? null : String(row.createdAt),
  }));
}

/* ------------------------------------------------------------------ *
 * Options partagées des modales
 * ------------------------------------------------------------------ */

export type BrickOrderOptions = {
  brickTypes: BrickTypeOption[];
  customers: CustomerOption[];
  /** `true` tant que la première passe n'est pas revenue. */
  isLoading: boolean;
  /** Recharge les deux listes (après création d'un client, par exemple). */
  refresh: () => void;
};

/**
 * Charge, **une seule fois par écran**, les deux listes d'appoint.
 *
 * Aucune n'est critique : un échec laisse la sélection vide sans masquer la
 * page, et la saisie libre du client reste possible.
 */
export function useBrickOrderOptions(enabled = true): BrickOrderOptions {
  const [brickTypes, setBrickTypes] = useState<BrickTypeOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    setIsLoading(true);

    void Promise.all([
      fetchBrickTypes(controller.signal).catch(() => [] as BrickTypeOption[]),
      fetchBrickTypeStocks(controller.signal).catch(() => new Map<number, number>()),
      fetchCustomers(controller.signal).catch(() => [] as CustomerOption[]),
    ])
      .then(([typeList, stocks, customerList]) => {
        if (controller.signal.aborted) return;
        setBrickTypes(
          typeList.map((type) => ({ ...type, stock: stocks.get(type.id) ?? type.stock })),
        );
        setCustomers(customerList);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [enabled, reloadToken]);

  return useMemo(
    () => ({
      brickTypes,
      customers,
      isLoading,
      refresh: () => setReloadToken((token) => token + 1),
    }),
    [brickTypes, customers, isLoading],
  );
}

/* ------------------------------------------------------------------ *
 * Aides numériques et calculs
 * ------------------------------------------------------------------ */

/** Saisie décimale française : la virgule est acceptée comme séparateur. */
function toAmount(value: string): number {
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Montant d'une ligne : `quantité × prix − remise`, jamais négatif. */
export function computeLineAmount(line: {
  quantity: string;
  unitPrice: string;
  discount: string;
}): number {
  const gross = toAmount(line.quantity) * toAmount(line.unitPrice);
  const discount = Math.min(Math.max(toAmount(line.discount), 0), gross);
  return Math.max(0, gross - discount);
}

export type LineDraft = {
  /** Clé React stable : l'index ne suffit pas dès qu'une ligne est retirée. */
  key: string;
  brickTypeId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
};

let lineSeed = 0;
function newLineKey(): string {
  lineSeed += 1;
  return `ligne-${lineSeed}`;
}

/** Une ligne vierge : quantité `1`, prix à renseigner depuis le type choisi. */
function emptyLine(): LineDraft {
  return { key: newLineKey(), brickTypeId: '', quantity: '1', unitPrice: '', discount: '' };
}

/* ------------------------------------------------------------------ *
 * Modale — création et modification d'une commande
 * ------------------------------------------------------------------ */

export function BrickOrderFormModal({
  isOpen,
  onClose,
  onSaved,
  order = null,
  idPrefix = 'create',
  brickTypes,
  customers,
  isOptionsLoading,
  onCustomersChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (detail: BrickOrderDetail) => void;
  /** `null` = création ; sinon remplacement des lignes et des dates. */
  order?: BrickOrderDetail | null;
  /** Deux modales coexistent dans le DOM : leurs `id` de champs doivent différer. */
  idPrefix?: string;
  brickTypes: BrickTypeOption[];
  customers: CustomerOption[];
  isOptionsLoading: boolean;
  /** Remonte la liste des clients après une création depuis cette modale. */
  onCustomersChanged?: () => void;
}) {
  const B = useBranch();
  const isEdit = Boolean(order);
  const fieldId = (name: string) => `${idPrefix}-brick-order-${name}`;

  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [date, setDate] = useState(today());
  const [promisedDate, setPromisedDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine()]);
  const [globalDiscount, setGlobalDiscount] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'draft' | 'confirmed'>('draft');

  const [isCustomerFormOpen, setIsCustomerFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * Numéro d'ouverture de la modale, incrémenté à chaque affichage.
   *
   * Il sert de `key` aux champs à suggestions. `Combobox` garde le texte
   * affiché dans son propre état, initialisé **une seule fois** : la modale
   * restant montée entre deux ouvertures (c'est `AnimatePresence` qui anime sa
   * disparition), le champ client rouvrirait vide sur une commande qui a
   * pourtant un client. Remonter le champ à chaque ouverture le réinitialise
   * depuis la valeur réellement sélectionnée.
   */
  const [formVersion, setFormVersion] = useState(0);

  /* La modale repart d'un état propre à chaque ouverture. `order?.order.id`
     suffit en dépendance : la fiche affichée ne change pas sans fermeture. */
  const orderId = order?.order.id ?? null;
  useEffect(() => {
    if (!isOpen) return;

    setFormVersion((version) => version + 1);

    if (order) {
      setCustomerId(order.order.customerId ? String(order.order.customerId) : '');
      setCustomerName(order.order.customerId ? '' : order.order.customerName);
      setDate(order.order.date || today());
      setPromisedDate(order.order.promisedDate ?? '');
      setDueDate(order.order.dueDate ?? '');
      setGlobalDiscount(order.order.discount ? String(order.order.discount) : '');
      setNotes(order.order.notes ?? '');
      setStatus(order.order.status === 'confirmed' ? 'confirmed' : 'draft');
      setLines(
        order.items.length > 0
          ? order.items.map((item) => ({
              key: newLineKey(),
              brickTypeId: item.brickTypeId ? String(item.brickTypeId) : '',
              quantity: String(item.quantity),
              unitPrice: String(item.unitPrice),
              discount: item.discount ? String(item.discount) : '',
            }))
          : [emptyLine()],
      );
    } else {
      setCustomerId('');
      setCustomerName('');
      setDate(today());
      setPromisedDate('');
      setDueDate('');
      setLines([emptyLine()]);
      setGlobalDiscount('');
      setNotes('');
      setStatus('draft');
    }

    setFormError(null);
    setIsSubmitting(false);
    setIsCustomerFormOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, orderId]);

  const typeById = useMemo(
    () => new Map(brickTypes.map((type) => [String(type.id), type])),
    [brickTypes],
  );

  /** Le type est pré-rempli à son prix de vente, puis reste modifiable (négocié). */
  function selectType(key: string, value: string) {
    const type = typeById.get(value);
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? { ...line, brickTypeId: value, unitPrice: type ? String(type.salePrice) : line.unitPrice }
          : line,
      ),
    );
    setFormError(null);
  }

  function setLineField(key: string, field: 'quantity' | 'unitPrice' | 'discount', value: string) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, [field]: value } : line)),
    );
    setFormError(null);
  }

  function removeLine(key: string) {
    setLines((current) => (current.length <= 1 ? current : current.filter((line) => line.key !== key)));
  }

  /* Totaux recalculés en direct, exactement comme le serveur les calcule :
     sous-total = somme des lignes, remise globale plafonnée à ce sous-total. */
  const subTotal = useMemo(
    () => lines.reduce((sum, line) => sum + computeLineAmount(line), 0),
    [lines],
  );
  const discountValue = Math.min(Math.max(toAmount(globalDiscount), 0), subTotal);
  const total = Math.max(0, subTotal - discountValue);

  const selectedCustomer = customers.find((customer) => String(customer.id) === customerId) ?? null;
  const customerLabel = selectedCustomer?.name ?? customerName.trim();

  async function submit() {
    if (isSubmitting) return;

    if (!customerId && !customerName.trim()) {
      setFormError('Sélectionnez un client enregistré ou saisissez le nom du client.');
      return;
    }
    if (!date) {
      setFormError('La date de la commande est obligatoire.');
      return;
    }
    if (lines.length === 0) {
      setFormError('Ajoutez au moins une ligne de pièces.');
      return;
    }

    const prepared: { line: LineDraft; brickTypeId: number; quantity: number; unitPrice: number; discount: number }[] = [];
    for (const line of lines) {
      const label = line.brickTypeId
        ? (typeById.get(line.brickTypeId)?.name ?? 'ligne')
        : 'une ligne sans modèle';
      if (!line.brickTypeId) {
        setFormError(`Choisissez le modèle de ${label === 'ligne' ? 'chaque ligne' : label}.`);
        return;
      }
      const quantity = toAmount(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setFormError(`« ${label} » : la quantité doit être strictement positive.`);
        return;
      }
      const unitPrice = toAmount(line.unitPrice);
      if (unitPrice < 0) {
        setFormError(`« ${label} » : le prix unitaire ne peut pas être négatif.`);
        return;
      }
      prepared.push({
        line,
        brickTypeId: Number(line.brickTypeId),
        quantity,
        unitPrice,
        discount: toAmount(line.discount),
      });
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const body = {
        customerId: customerId ? Number(customerId) : null,
        customerName: customerId ? undefined : customerName.trim(),
        date,
        promisedDate: promisedDate || null,
        dueDate: dueDate || null,
        discount: toAmount(globalDiscount),
        notes: notes.trim() || null,
        items: prepared.map((entry) => ({
          brickTypeId: entry.brickTypeId,
          quantity: entry.quantity,
          unitPrice: entry.unitPrice,
          discount: entry.discount,
        })),
        // Le statut n'est accepté qu'à la création : une commande confirmée ne
        // redevient pas brouillon par une modification de ses lignes.
        ...(isEdit ? {} : { status }),
      };

      const response = await fetch(
        isEdit && order ? branchApiUrl(`/commandes/${order.order.id}`) : branchApiUrl('/commandes'),
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, 'La commande n’a pas pu être enregistrée.'));
      }

      const saved = (await response.json()) as BrickOrderDetail;
      toast.success(
        isEdit
          ? `Commande ${saved.order.orderNumber} enregistrée — ${saved.items.length} ligne(s).`
          : `Commande ${saved.order.orderNumber} créée pour ${saved.order.customerName}.`,
      );
      onSaved(saved);
      onClose();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'La commande n’a pas pu être enregistrée.';
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={() => {
          if (!isSubmitting) onClose();
        }}
        title={isEdit ? 'Modifier la commande' : 'Nouvelle commande de la filiale'}
        size="xl"
        fullScreenMobile
      >
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
            Une commande <strong>n’engage que le client</strong> : elle ne sort aucun stock. La
            sortie de stock et le chiffre d’affaires naissent à la <strong>facturation</strong>, qui
            transfère les acomptes déjà encaissés sur la facture de vente.
          </p>

          {/* ── Client ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <FormField
              label="Client enregistré"
              htmlFor={fieldId('customer')}
              hint="La recherche s’affranchit des accents et de la casse."
            >
              {isOptionsLoading && customers.length === 0 ? (
                <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
              ) : (
                <Combobox
                  key={`customer-${formVersion}`}
                  id={fieldId('customer')}
                  className="min-h-11"
                  value={customerId}
                  onChange={(value) => {
                    setCustomerId(value);
                    if (value) setCustomerName('');
                    setFormError(null);
                  }}
                  options={customers.map((customer) => ({
                    value: String(customer.id),
                    label: customer.name,
                    hint: customer.phone ?? undefined,
                  }))}
                  emptyLabel="Aucun client enregistré (saisie libre ci-dessous)"
                  placeholder="Rechercher un client…"
                />
              )}
            </FormField>

            <FormField
              label="Ou client en saisie libre"
              htmlFor={fieldId('customer-name')}
              hint="Nom hors fichier client (vente comptoir). Le serveur le rapproche d’une fiche existante du même nom."
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id={fieldId('customer-name')}
                  type="text"
                  className="input input-bordered min-h-11 w-full flex-1"
                  value={customerName}
                  onChange={(event) => {
                    setCustomerName(event.target.value);
                    setFormError(null);
                  }}
                  disabled={isSubmitting || Boolean(customerId)}
                  placeholder="Ex. Mamadou Diallo"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-ghost min-h-11 border border-base-300"
                  onClick={() => setIsCustomerFormOpen(true)}
                  disabled={isSubmitting}
                >
                  Nouveau client
                </button>
              </div>
            </FormField>
          </div>

          {customerLabel && (
            <p className="text-sm text-base-content/60">
              Commande au nom de <strong className="text-base-content">{customerLabel}</strong>
              {selectedCustomer && selectedCustomer.creditLimit > 0 ? (
                <> — plafond de crédit <MoneyText value={selectedCustomer.creditLimit} /></>
              ) : null}
            </p>
          )}

          {/* ── Dates ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Date de la commande" htmlFor={fieldId('date')} required>
              <DatePicker value={date} onChange={setDate} placeholder="jj mois aaaa" />
            </FormField>

            <FormField
              label="Livraison promise"
              htmlFor={fieldId('promised')}
              hint="Sert au suivi du délai, pas à la facturation."
            >
              <DatePicker
                value={promisedDate}
                onChange={setPromisedDate}
                placeholder="jj mois aaaa"
              />
            </FormField>

            <FormField
              label="Échéance de paiement"
              htmlFor={fieldId('due')}
              hint="Date au-delà de laquelle le reste à payer est en retard."
            >
              <DatePicker value={dueDate} onChange={setDueDate} placeholder="jj mois aaaa" />
            </FormField>
          </div>

          {/* ── Lignes de pièces ──────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Pièces commandées</h3>
              <button
                type="button"
                className="btn btn-ghost min-h-11 border border-base-300"
                onClick={() => setLines((current) => [...current, emptyLine()])}
                disabled={isSubmitting}
              >
                Ajouter une ligne
              </button>
            </div>

            {brickTypes.length === 0 && !isOptionsLoading ? (
              <EmptyState
                title="Aucun modèle actif"
                description="Créez d’abord un modèle (il porte le produit, le stock et le prix de vente) depuis l’onglet Modèles de la filiale."
                action={
                  <Link href={B.href('')} className="btn btn-primary min-h-11">
                    Ouvrir la filiale
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
                {lines.map((line, index) => {
                  const type = typeById.get(line.brickTypeId) ?? null;
                  const amount = computeLineAmount(line);
                  // Signal, jamais un blocage : une commande n'engage aucun stock.
                  const exceedsStock = Boolean(type) && toAmount(line.quantity) > type!.stock;

                  return (
                    <li key={line.key} className="space-y-3 p-3 sm:p-4">
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="min-w-0 flex-1 basis-full sm:basis-64">
                          <label
                            className="mb-1 block text-xs text-base-content/60"
                            htmlFor={`${fieldId('line-type')}-${line.key}`}
                          >
                            Modèle {index + 1}
                          </label>
                          {isOptionsLoading && brickTypes.length === 0 ? (
                            <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
                          ) : (
                            <Combobox
                              key={`${line.key}-${formVersion}`}
                              id={`${fieldId('line-type')}-${line.key}`}
                              className="min-h-11"
                              value={line.brickTypeId}
                              onChange={(value) => selectType(line.key, value)}
                              options={brickTypes
                                .filter((entry) => entry.isActive || entry.id === type?.id)
                                .map((entry) => ({
                                  value: String(entry.id),
                                  label: entry.name,
                                  hint: `${formatNumber(entry.salePrice)} GNF`,
                                }))}
                              emptyLabel="Choisir un type…"
                              showEmptyLabel
                              placeholder="Rechercher un modèle…"
                              ariaLabel={`Modèle de la ligne ${index + 1}`}
                            />
                          )}
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <Badge tone="info">Unité : {type?.unit ?? '—'}</Badge>
                            {type?.dimensions && <Badge tone="neutral">{type.dimensions}</Badge>}
                            {type && (
                              <Badge tone={exceedsStock ? 'warning' : 'success'}>
                                Stock fini : {formatQuantity(type.stock, type.unit)}
                              </Badge>
                            )}
                            {exceedsStock && <Badge tone="warning">À produire</Badge>}
                            {type && (
                              <span className="text-xs text-base-content/50">{type.productName}</span>
                            )}
                          </div>
                        </div>

                        <div className="w-24">
                          <label
                            className="mb-1 block text-xs text-base-content/60"
                            htmlFor={`${fieldId('line-quantity')}-${line.key}`}
                          >
                            Quantité
                          </label>
                          <input
                            id={`${fieldId('line-quantity')}-${line.key}`}
                            type="number"
                            min={0}
                            step="any"
                            inputMode="decimal"
                            className="input input-bordered min-h-11 w-full tabular"
                            value={line.quantity}
                            onChange={(event) => setLineField(line.key, 'quantity', event.target.value)}
                            disabled={isSubmitting}
                            autoComplete="off"
                          />
                        </div>

                        <div className="w-36">
                          <label
                            className="mb-1 block text-xs text-base-content/60"
                            htmlFor={`${fieldId('line-price')}-${line.key}`}
                          >
                            Prix unitaire (GNF)
                          </label>
                          <input
                            id={`${fieldId('line-price')}-${line.key}`}
                            type="number"
                            min={0}
                            step="any"
                            inputMode="decimal"
                            className="input input-bordered min-h-11 w-full tabular"
                            value={line.unitPrice}
                            onChange={(event) => setLineField(line.key, 'unitPrice', event.target.value)}
                            disabled={isSubmitting}
                            autoComplete="off"
                            placeholder="0"
                          />
                        </div>

                        <div className="w-32">
                          <label
                            className="mb-1 block text-xs text-base-content/60"
                            htmlFor={`${fieldId('line-discount')}-${line.key}`}
                          >
                            Remise (GNF)
                          </label>
                          <input
                            id={`${fieldId('line-discount')}-${line.key}`}
                            type="number"
                            min={0}
                            step="any"
                            inputMode="decimal"
                            className="input input-bordered min-h-11 w-full tabular"
                            value={line.discount}
                            onChange={(event) => setLineField(line.key, 'discount', event.target.value)}
                            disabled={isSubmitting}
                            autoComplete="off"
                            placeholder="0"
                          />
                        </div>

                        <div className="flex w-full items-end justify-between gap-3 sm:w-auto">
                          <div className="text-right">
                            <span className="block text-xs text-base-content/60">Total ligne</span>
                            <MoneyText value={amount} bold />
                          </div>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm min-h-11 min-w-11 text-error"
                            onClick={() => removeLine(line.key)}
                            disabled={isSubmitting || lines.length <= 1}
                            aria-label={`Retirer la ligne ${index + 1}`}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ── Remise globale, totaux, notes ──────────────────────── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <FormField
                label="Remise globale (GNF)"
                htmlFor={fieldId('discount')}
                hint={`Appliquée après les remises de ligne, plafonnée au sous-total (${formatNumber(subTotal)} GNF).`}
              >
                <input
                  id={fieldId('discount')}
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  className="input input-bordered min-h-11 w-full tabular"
                  value={globalDiscount}
                  onChange={(event) => {
                    setGlobalDiscount(event.target.value);
                    setFormError(null);
                  }}
                  disabled={isSubmitting}
                  autoComplete="off"
                  placeholder="0"
                />
              </FormField>

              {!isEdit && (
                <FormField
                  label="État de la commande"
                  htmlFor={fieldId('status')}
                  hint="Un brouillon se confirme ensuite depuis sa fiche."
                >
                  <select
                    id={fieldId('status')}
                    className="select select-bordered min-h-11 w-full"
                    value={status}
                    onChange={(event) => setStatus(event.target.value === 'confirmed' ? 'confirmed' : 'draft')}
                    disabled={isSubmitting}
                  >
                    <option value="draft">Brouillon</option>
                    <option value="confirmed">Confirmée</option>
                  </select>
                </FormField>
              )}

              <FormField label="Notes" htmlFor={fieldId('notes')}>
                <textarea
                  id={fieldId('notes')}
                  className="textarea textarea-bordered min-h-20 w-full"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  disabled={isSubmitting}
                  placeholder="Ex. livraison sur le chantier de Kipé, camion du client…"
                />
              </FormField>
            </div>

            <div className="surface-card h-fit space-y-1 rounded-xl border border-base-200 bg-base-100 p-4">
              <InfoRow label="Sous-total des lignes">
                <MoneyText value={subTotal} />
              </InfoRow>
              <InfoRow label="Remise globale">
                <MoneyText value={discountValue} />
              </InfoRow>
              <div className="flex items-center justify-between border-t border-base-200 pt-2">
                <span className="text-sm font-semibold">Total de la commande</span>
                <MoneyText value={total} bold className="text-base" />
              </div>
              <p className="pt-2 text-xs text-base-content/50">
                Le total est <strong>recalculé par le serveur</strong> à partir des lignes : il n’est
                jamais pris depuis cet écran.
              </p>
            </div>
          </div>

          {formError && (
            <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
              {formError}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
            <button
              type="button"
              className="btn btn-ghost min-h-11"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Annuler
            </button>
            <button
              type="submit"
              className="btn btn-primary min-h-11"
              disabled={isSubmitting || brickTypes.length === 0}
            >
              {isSubmitting ? (
                <>
                  <span className="loading loading-spinner loading-sm" aria-hidden />
                  Enregistrement…
                </>
              ) : isEdit ? (
                'Enregistrer les modifications'
              ) : (
                'Créer la commande'
              )}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modale partagée du module Clients : mêmes fiches partout (§7.2). */}
      <CustomerFormModal
        isOpen={isCustomerFormOpen}
        onClose={() => setIsCustomerFormOpen(false)}
        idPrefix={`${idPrefix}-brick-order-customer`}
        onSaved={(customer: CustomerRecord) => {
          setCustomerId(String(customer.id));
          setCustomerName('');
          onCustomersChanged?.();
          toast.success(`Client « ${customer.name} » créé et sélectionné.`);
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — encaissement d'un acompte
 * ------------------------------------------------------------------ */

/**
 * Enregistre un acompte sur la commande.
 *
 * Le reçu est **numéroté par le serveur** : l'écran ne fabrique jamais de
 * numéro, il affiche celui que l'API renvoie. Un brouillon ou une commande
 * annulée sont refusés côté serveur — on masque donc le bouton en amont.
 */
export function BrickOrderPaymentModal({
  isOpen,
  onClose,
  order,
  onRecorded,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Commande visée ; `null` laisse la modale inerte (fermeture en cours). */
  order: BrickOrderRow | null;
  onRecorded: (detail: BrickOrderDetail, receiptNumber: string) => void;
}) {
  const { settings } = useSettings();

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

  const orderId = order?.id ?? null;

  useEffect(() => {
    if (!isOpen) return;

    setAmount('');
    setNotes('');
    setDate(today());
    setFormError(null);
    setReceipt(null);
    setIsSubmitting(false);
    setPaymentMethod(
      settings.paymentMethods?.some((method) => method.toLowerCase() === 'espèces')
        ? 'Espèces'
        : (settings.paymentMethods?.[0] ?? 'Espèces'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, orderId]);

  const remaining = order?.remainingAmount ?? 0;
  const value = toAmount(amount);
  const exceedsRemaining = value > remaining + 0.01;

  async function submit() {
    if (!order || isSubmitting) return;

    if (!Number.isFinite(value) || value <= 0) {
      setFormError('Le montant de l’acompte doit être supérieur à zéro.');
      return;
    }
    if (exceedsRemaining) {
      setFormError(
        `Le montant dépasse le reste à payer (${formatNumber(remaining)} GNF).`,
      );
      return;
    }
    if (!date) {
      setFormError('La date de l’encaissement est obligatoire.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(branchApiUrl(`/commandes/${order.id}/paiements`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          amount: value,
          paymentMethod,
          date,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'L’acompte n’a pas pu être enregistré.'));
      }

      const detail = (await response.json()) as BrickOrderDetail;
      const recorded = detail.payments[detail.payments.length - 1];
      setReceipt(
        recorded ? { id: recorded.id, receiptNumber: recorded.receiptNumber } : null,
      );
      toast.success(
        recorded
          ? `Acompte encaissé — reçu ${recorded.receiptNumber}.`
          : 'Acompte encaissé sur la commande.',
      );
      onRecorded(detail, recorded?.receiptNumber ?? '');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'L’acompte n’a pas pu être enregistré.';
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
      title={order ? `Acompte — commande ${order.orderNumber}` : 'Encaisser un acompte'}
      size="lg"
      fullScreenMobile
    >
      <div className="space-y-4">
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          L’acompte est un <strong>encaissement réel</strong> : reçu numéroté, entrée en caisse et
          reste à payer recalculé. À la facturation, il sera <strong>transféré</strong> sur la
          facture de vente — le reçu et le mouvement de caisse restent les mêmes, l’argent n’est
          jamais compté deux fois.
        </p>

        <div className="grid gap-x-6 gap-y-1 rounded-xl border border-base-200 px-4 py-3 sm:grid-cols-2">
          <InfoRow label="Total de la commande">
            <MoneyText value={order?.total ?? 0} />
          </InfoRow>
          <InfoRow label="Déjà encaissé">
            <MoneyText value={order?.amountPaid ?? 0} />
          </InfoRow>
          <InfoRow label="Reste à payer">
            {/* Rouge dès qu'il reste quelque chose à encaisser, neutre à zéro ;
                une commande annulée, facturée ou encore brouillon n'est pas
                encaissable, donc neutre. */}
            <MoneyText
              value={remaining}
              remaining={
                Boolean(order) &&
                !order!.isCancelled &&
                !order!.salesInvoiceId &&
                order!.status !== 'draft' &&
                remaining > 0.001
              }
              bold
            />
          </InfoRow>
          <InfoRow label="Échéance">{formatDateShort(order?.dueDate ?? null)}</InfoRow>
        </div>

        {receipt ? (
          <div className="space-y-3 rounded-xl border border-success/30 bg-success/10 p-4">
            <p className="text-sm font-medium text-success">
              Acompte enregistré — reçu {receipt.receiptNumber}.
            </p>
            <Link href={`/recus/${receipt.id}`} className="btn btn-success btn-sm min-h-11">
              Voir le reçu
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              label="Montant reçu (GNF)"
              htmlFor="brick-order-payment-amount"
              required
              error={exceedsRemaining ? ' ' : null}
              hint={remaining > 0.001 ? `Reste à payer : ${formatNumber(remaining)} GNF` : 'Commande déjà soldée.'}
            >
              <input
                id="brick-order-payment-amount"
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                className="input input-bordered min-h-11 w-full tabular"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setFormError(null);
                }}
                disabled={isSubmitting}
                autoComplete="off"
                placeholder="0"
              />
            </FormField>

            <FormField label="Moyen de paiement" htmlFor="brick-order-payment-method" required>
              <select
                id="brick-order-payment-method"
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

            <FormField label="Date d’encaissement" htmlFor="brick-order-payment-date" required>
              <DatePicker value={date} onChange={setDate} placeholder="jj mois aaaa" />
            </FormField>

            <FormField label="Note" htmlFor="brick-order-payment-notes" hint="Facultatif.">
              <input
                id="brick-order-payment-notes"
                type="text"
                className="input input-bordered min-h-11 w-full"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={isSubmitting}
                autoComplete="off"
                placeholder="Ex. acompte de 30 %"
              />
            </FormField>
          </div>
        )}

        {exceedsRemaining && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            Le montant saisi dépasse le reste à payer ({formatNumber(remaining)} GNF).
          </p>
        )}

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11"
            onClick={onClose}
            disabled={isSubmitting}
          >
            {receipt ? 'Fermer' : 'Annuler'}
          </button>
          {!receipt && (
            <button
              type="button"
              className="btn btn-primary min-h-11"
              onClick={() => void submit()}
              disabled={isSubmitting || !order || remaining <= 0.001}
            >
              {isSubmitting ? (
                <>
                  <span className="loading loading-spinner loading-sm" aria-hidden />
                  Encaissement…
                </>
              ) : (
                'Encaisser l’acompte'
              )}
            </button>
          )}
        </div>

        {!receipt && remaining <= 0.001 && (
          <p className="text-sm text-base-content/60">
            Cette commande est déjà soldée : aucun acompte supplémentaire n’est possible.
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — enregistrement d'une livraison
 * ------------------------------------------------------------------ */

/**
 * Constat de ce qui est réellement parti chez le client.
 *
 * La livraison **ne sort pas le stock** : elle enregistre un fait. Le statut
 * découle des quantités côté serveur (« livrée » seulement si tout est parti),
 * et la saisie est bornée par le reste à livrer de chaque ligne.
 */
export function BrickOrderDeliveryModal({
  isOpen,
  onClose,
  order,
  items,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  order: BrickOrderRow | null;
  items: BrickOrderItemRow[];
  onSaved: (detail: BrickOrderDetail) => void;
}) {
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const orderId = order?.id ?? null;

  /* À l'ouverture, chaque ligne est pré-remplie avec **ce qui reste à
     livrer** : le cas courant est de tout livrer, et corriger un champ est
     plus rapide que le remplir. */
  useEffect(() => {
    if (!isOpen) return;

    const next: Record<number, string> = {};
    for (const item of items) {
      const rest = Math.max(0, item.quantity - item.deliveredQuantity);
      next[item.id] = rest > 0 ? String(rest) : '0';
    }
    setQuantities(next);
    setFormError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, orderId]);

  const totalToDeliver = items.reduce(
    (sum, item) => sum + Math.max(0, toAmount(quantities[item.id] ?? '0')),
    0,
  );

  async function submit() {
    if (!order || isSubmitting) return;

    const deliveries = items
      .map((item) => ({ itemId: item.id, quantity: toAmount(quantities[item.id] ?? '0') }))
      .filter((line) => line.quantity > 0);

    if (deliveries.length === 0) {
      setFormError('Indiquez au moins une quantité livrée.');
      return;
    }

    for (const line of deliveries) {
      const item = items.find((entry) => entry.id === line.itemId);
      if (!item) continue;
      const rest = Math.max(0, item.quantity - item.deliveredQuantity);
      if (line.quantity > rest + 0.001) {
        setFormError(
          `« ${item.productName} » : ${formatQuantity(line.quantity)} livrées alors qu’il ne reste que ${formatQuantity(rest, item.unit)} à livrer.`,
        );
        return;
      }
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(branchApiUrl(`/commandes/${order.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'deliver', deliveries }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'La livraison n’a pas pu être enregistrée.'));
      }

      const detail = (await response.json()) as BrickOrderDetail;
      toast.success(
        detail.order.status === 'delivered'
          ? `Commande ${detail.order.orderNumber} livrée en totalité.`
          : `Livraison enregistrée — ${formatQuantity(detail.order.quantityDelivered)} sur ${formatQuantity(detail.order.quantityOrdered)}.`,
      );
      onSaved(detail);
      onClose();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'La livraison n’a pas pu être enregistrée.';
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
      title={order ? `Livraison — commande ${order.orderNumber}` : 'Enregistrer une livraison'}
      size="lg"
      fullScreenMobile
    >
      <div className="space-y-4">
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          La livraison <strong>constate</strong> ce qui part chez le client. Elle ne modifie pas le
          stock : c’est la <strong>facture</strong> qui l’écrit. Le statut passe automatiquement à
          « Partiellement livrée », puis à « Livrée » quand toutes les lignes sont parties.
        </p>

        {items.length === 0 ? (
          <EmptyState
            title="Aucune ligne à livrer"
            description="Cette commande ne contient aucune ligne de pièces."
          />
        ) : (
          <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
            {items.map((item) => {
              const rest = Math.max(0, item.quantity - item.deliveredQuantity);
              const entry = toAmount(quantities[item.id] ?? '0');
              const tooMuch = entry > rest + 0.001;

              return (
                <li key={item.id} className="flex flex-wrap items-end gap-3 p-3 sm:p-4">
                  <div className="min-w-0 flex-1 basis-full sm:basis-48">
                    <div className="truncate font-medium">{item.productName}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-base-content/50">
                      <span>
                        Commandé <QuantityText value={item.quantity} unit={item.unit} />
                      </span>
                      <span>
                        Déjà livré <QuantityText value={item.deliveredQuantity} unit={item.unit} />
                      </span>
                    </div>
                  </div>

                  <div className="w-28">
                    <label
                      className="mb-1 block text-xs text-base-content/60"
                      htmlFor={`delivery-${item.id}`}
                    >
                      Livré maintenant
                    </label>
                    <input
                      id={`delivery-${item.id}`}
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      className={`input input-bordered min-h-11 w-full tabular ${tooMuch ? 'input-error' : ''}`}
                      value={quantities[item.id] ?? ''}
                      onChange={(event) => {
                        setQuantities((current) => ({ ...current, [item.id]: event.target.value }));
                        setFormError(null);
                      }}
                      disabled={isSubmitting}
                      autoComplete="off"
                      aria-label={`Quantité livrée pour ${item.productName}`}
                    />
                  </div>

                  <div className="text-right">
                    <span className="block text-xs text-base-content/60">Reste à livrer</span>
                    <QuantityText value={rest} unit={item.unit} />
                  </div>

                  {tooMuch && <Badge tone="error">Dépasse le reste à livrer</Badge>}
                </li>
              );
            })}
          </ul>
        )}

        {items.length > 0 && (
          <p className="text-sm text-base-content/60">
            Total de cette livraison : <QuantityText value={totalToDeliver} /> sur{' '}
            <QuantityText value={order?.quantityOrdered ?? 0} /> commandées.
          </p>
        )}

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Annuler
          </button>
          <button
            type="button"
            className="btn btn-primary min-h-11"
            onClick={() => void submit()}
            disabled={isSubmitting || items.length === 0 || totalToDeliver <= 0}
          >
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Enregistrement…
              </>
            ) : (
              'Enregistrer la livraison'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — changement d'état
 * ------------------------------------------------------------------ */

/**
 * Choix et confirmation d'un passage d'état.
 *
 * Pourquoi le choix vit ici plutôt que sur la ligne : une commande « Prête »
 * peut devenir « Partiellement livrée » ou « Livrée » directement. Multiplier
 * les icônes d'action sur la ligne noierait les chiffres ; la modale, elle,
 * nomme chaque état en toutes lettres et rappelle qu'aucun état ne touche le
 * stock.
 *
 * La liste proposée est une **recopie d'affichage** de `STATUS_TRANSITIONS` ;
 * le serveur revalide de toute façon la transition reçue.
 */
export function BrickOrderStatusDialog({
  isOpen,
  onClose,
  onConfirm,
  order,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (status: BrickOrderStatus) => void | Promise<void>;
  /** Commande visée ; `null` laisse la modale inerte (fermeture en cours). */
  order: BrickOrderRow | null;
  isSubmitting: boolean;
}) {
  const reachable = order ? (BRICK_ORDER_NEXT_STATUSES[order.status] ?? []) : [];
  const [choice, setChoice] = useState<BrickOrderStatus | ''>('');

  useEffect(() => {
    if (!isOpen) return;
    setChoice(reachable[0] ?? '');
    // `reachable` est dérivé du statut : il ne change pas sans fermeture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, order?.id, order?.status]);

  const selected = choice || reachable[0] || null;

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={() => (selected ? onConfirm(selected) : undefined)}
      isSubmitting={isSubmitting}
      tone="primary"
      title="Changer l’état de la commande"
      confirmLabel={selected ? `Passer à « ${BRICK_ORDER_STATUS_LABELS[selected]} »` : 'Confirmer'}
      message={
        <>
          La commande <strong>{order?.orderNumber ?? ''}</strong> est actuellement «{' '}
          {brickOrderStatusLabel(order?.status)} ».
          <span className="block pt-1 text-sm">
            Un état est un suivi de production : il ne touche ni le stock ni la caisse. Seule la
            facturation les engage.
          </span>
        </>
      }
    >
      {reachable.length === 0 ? (
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          Aucun changement d’état n’est possible depuis « {brickOrderStatusLabel(order?.status)} ».
        </p>
      ) : reachable.length === 1 ? (
        <div className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm">
          Nouvel état :{' '}
          <strong>{BRICK_ORDER_STATUS_LABELS[reachable[0]]}</strong>
        </div>
      ) : (
        <FormField label="Nouvel état" htmlFor="brick-order-next-status" required>
          <select
            id="brick-order-next-status"
            className="select select-bordered min-h-11 w-full"
            value={selected ?? ''}
            onChange={(event) => setChoice(event.target.value as BrickOrderStatus)}
            disabled={isSubmitting}
          >
            {reachable.map((state) => (
              <option key={state} value={state}>
                {BRICK_ORDER_STATUS_LABELS[state]}
              </option>
            ))}
          </select>
        </FormField>
      )}
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — facturation (action sensible : stock + chiffre d'affaires)
 * ------------------------------------------------------------------ */

/**
 * Confirmation **explicite** de la facturation.
 *
 * Elle crée une vente (canal `brick`) : le stock sort, le chiffre d'affaires
 * entre, et les acomptes déjà encaissés sont transférés sur la facture. Le
 * message le dit en clair, sans jargon — c'est l'action la plus lourde de
 * l'écran, elle n'est jamais déclenchée par un simple clic.
 */
export function BrickOrderInvoiceDialog({
  isOpen,
  onClose,
  onConfirm,
  order,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  order: BrickOrderRow | null;
  isSubmitting: boolean;
}) {
  const deposits = order?.amountPaid ?? 0;

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      isSubmitting={isSubmitting}
      tone="warning"
      title="Facturer la commande"
      confirmLabel="Facturer maintenant"
      message={
        <>
          Facturer <strong>{order?.orderNumber ?? ''}</strong> crée une <strong>vente</strong> de{' '}
          <MoneyText value={order?.total ?? 0} bold /> au nom de{' '}
          <strong>{order?.customerName ?? ''}</strong> :{' '}
          <strong>la facture sort le stock et entre dans le chiffre d’affaires</strong>.
          {deposits > 0.001 ? (
            <span className="mt-2 block rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-info">
              Les acomptes déjà encaissés (<MoneyText value={deposits} bold />) sont{' '}
              <strong>transférés</strong> sur la facture : le reçu et le mouvement de caisse restent
              les mêmes, l’argent n’est compté qu’une fois.
            </span>
          ) : null}
          <span className="mt-2 block text-sm">
            La commande passe à « Livrée » et ne sera plus modifiable : les corrections se feront
            ensuite sur la facture.
          </span>
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * Modale — annulation motivée (§7 : jamais de suppression)
 * ------------------------------------------------------------------ */

export function BrickOrderCancelDialog({
  isOpen,
  onClose,
  onConfirm,
  order,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
  order: BrickOrderRow | null;
  isSubmitting: boolean;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setReason('');
    setError(null);
  }, [isOpen]);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={async () => {
        if (!reason.trim()) {
          setError('Le motif d’annulation est obligatoire.');
          return;
        }
        setError(null);
        await onConfirm(reason.trim());
      }}
      isSubmitting={isSubmitting}
      tone="error"
      title="Annuler la commande"
      confirmLabel="Annuler la commande"
      message={
        <>
          La commande <strong>{order?.orderNumber ?? ''}</strong> sera marquée annulée. Elle n’est{' '}
          <strong>jamais supprimée</strong> : elle reste consultable avec son motif.
          <span className="mt-2 block text-sm">
            Le motif est obligatoire — il tient lieu de trace. Une commande déjà facturée ne peut pas
            être annulée : il faut d’abord annuler la facture de vente.
          </span>
        </>
      }
    >
      <FormField label="Motif de l’annulation" htmlFor="brick-order-cancel-reason" required error={error}>
        <textarea
          id="brick-order-cancel-reason"
          className="textarea textarea-bordered min-h-20 w-full"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
          disabled={isSubmitting}
          placeholder="Ex. client injoignable, prix finalement refusé…"
        />
      </FormField>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Colonnes partagées — lignes de la fiche
 * ------------------------------------------------------------------ */

export const brickOrderItemColumns: Column<BrickOrderItemRow>[] = [
  {
    key: 'productName',
    label: 'Produit',
    primary: true,
    render: (item) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{item.productName}</div>
        <div className="text-xs text-base-content/50">{item.unit}</div>
      </div>
    ),
  },
  {
    key: 'quantity',
    label: 'Quantité',
    className: 'text-right whitespace-nowrap',
    render: (item) => <QuantityText value={item.quantity} unit={item.unit} />,
  },
  {
    key: 'unitPrice',
    label: 'Prix unitaire',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (item) => <MoneyText value={item.unitPrice} />,
  },
  {
    key: 'discount',
    label: 'Remise',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (item) =>
      item.discount > 0 ? (
        <MoneyText value={item.discount} />
      ) : (
        <span className="text-base-content/40">—</span>
      ),
  },
  {
    key: 'amount',
    label: 'Total',
    className: 'text-right whitespace-nowrap',
    render: (item) => <MoneyText value={item.amount} bold />,
  },
  {
    key: 'deliveredQuantity',
    label: 'Livré',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (item) => (
      <QuantityText
        value={item.deliveredQuantity}
        unit={item.unit}
        className={
          item.deliveredQuantity >= item.quantity - 0.001 ? 'text-success' : 'text-base-content/60'
        }
      />
    ),
  },
];

/** Colonnes de l'historique des acomptes — le reçu reste atteignable. */
export const brickOrderPaymentColumns: Column<BrickOrderPaymentRow>[] = [
  {
    key: 'date',
    label: 'Date',
    className: 'whitespace-nowrap',
    render: (payment) => (
      <span className="tabular text-base-content/70">{formatDateShort(payment.date)}</span>
    ),
  },
  {
    key: 'receiptNumber',
    label: 'Reçu',
    primary: true,
    render: (payment) => (
      <Link
        href={`/recus/${payment.id}`}
        className="font-semibold text-primary hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        {payment.receiptNumber}
      </Link>
    ),
  },
  {
    key: 'paymentMethod',
    label: 'Moyen',
    render: (payment) => <span>{payment.paymentMethod || '—'}</span>,
  },
  {
    key: 'notes',
    label: 'Note',
    hideOnMobile: true,
    render: (payment) => <span className="text-base-content/60">{payment.notes || '—'}</span>,
  },
  {
    key: 'amount',
    label: 'Montant',
    className: 'text-right whitespace-nowrap',
    render: (payment) => <MoneyText value={payment.amount} bold />,
  },
];

/* Le type `Column` est ré-exporté pour que les pages n'aient pas à importer
   `responsive-table` uniquement pour typer une colonne dérivée. */
export type { Column };
