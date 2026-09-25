'use client';

/**
 * Modales du module Achats (README §7.5, §8, §14).
 *
 * Trois familles, **un état booléen par modale** (§8.3 règle 1) — l'appelant
 * pilote `showDetailModal`, `showPaymentModal` et `showCancelModal` ; aucune
 * modale générique pilotée par une chaîne « mode » :
 *
 *   1. `PurchaseDetailModal`  — détail d'un achat (lignes, échéancier, règlements) ;
 *   2. `PurchasePaymentModal` — règlement fournisseur (acompte ou solde) ;
 *   3. `CancelPurchaseDialog` — annulation avec **motif obligatoire** (§14).
 *
 * Aucune suppression physique n'existe : on **annule**, avec motif, et le
 * serveur inverse les entrées de stock et contre-passe le décaissement.
 *
 * ## Types du contrat d'API (source unique pour tout le module)
 *
 * `PurchaseInvoiceRow` / `PurchaseInvoiceItemRow` **répètent** le contrat exposé
 * par `lib/purchases.ts`. On ne peut pas importer ce module pour autre chose
 * qu'un type (il touche la base → §11 bis), et `import type` d'un module dont on
 * ne réexporte rien obligerait à un second fichier de types hors périmètre. La
 * forme est donc recopiée **à l'identique** : toute divergence serait un bug de
 * typage côté page, pas une surprise à l'exécution (le contrôle de `tsc` la
 * signalerait si les deux venaient du même module).
 *
 * Seule adaptation assumée : `createdAt` est sérialisé en chaîne par l'API,
 * alors qu'il est un `Date` côté `lib/`. Le type accepte les deux et tout
 * l'affichage passe par `lib/date-format.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DatePicker } from '@/components/date-picker';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  Card,
  FormField,
  InfoRow,
  MiniStat,
  MoneyText,
  QuantityText,
  SkeletonTable,
  StatusBadge,
} from '@/components/design-system';
import { useSettings } from '@/app/parametres/page';
import { usePermission } from '@/components/role-gate';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, today } from '@/lib/format';
import type {
  PurchaseDocumentCompany,
  PurchaseDocumentItem,
  PurchaseDocumentInvoice,
  PurchaseDocumentSupplier,
} from '@/components/achats/purchase-document';

export type {
  PurchaseDocumentCompany,
  PurchaseDocumentItem,
  PurchaseDocumentInvoice,
  PurchaseDocumentSupplier,
};

export type PurchaseInvoiceRow = {
  id: number;
  reference: string;
  supplierReference: string | null;
  supplierId: number | null;
  supplierName: string;
  userId: number | null;
  userName: string | null;
  date: string;
  dueDate: string | null;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  status: 'active' | 'cancelled';
  cancelReason: string | null;
  notes: string | null;
  itemCount: number;
  /** `Date` côté `lib/`, chaîne après sérialisation JSON : les deux passent. */
  createdAt: Date | string | null;
};

export type PurchaseInvoiceItemRow = {
  id: number;
  invoiceId: number;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type PaymentRow = {
  id: number;
  receiptNumber: string;
  type: string;
  referenceId: number;
  amount: number;
  paymentMethod: string;
  paymentLabel: string;
  date: string;
  notes: string | null;
  userId: number | null;
  userName: string | null;
  createdAt: string | null;
};

/** Échéancier renvoyé par `GET /api/achats/[id]` (`getPaymentSchedule`). */
export type PaymentSchedule = {
  total: number;
  paid: number;
  remaining: number;
  paymentStatus: string;
  dueDate: string | null;
  documentDate: string | null;
  isOverdue: boolean;
};

export type PurchaseInvoiceDetail = {
  invoice: PurchaseInvoiceRow;
  items: PurchaseInvoiceItemRow[];
  payments: PaymentRow[];
  schedule: PaymentSchedule;
};

/* ------------------------------------------------------------------ *
 * Utilitaires partagés
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

/** Statut de document : la valeur doit être l'un des deux littéraux attendus. */
function toInvoiceStatus(value: unknown): PurchaseInvoiceRow['status'] {
  return value === 'cancelled' ? 'cancelled' : 'active';
}

/** Normalise une ligne d'API : l'API renvoie des `real`, pas des chaînes. */
export function normalizePurchaseRow(raw: unknown): PurchaseInvoiceRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    id: num(row.id),
    reference: String(row.reference ?? '—'),
    supplierReference: (row.supplierReference ?? row.supplier_reference ?? null) as string | null,
    supplierId:
      row.supplierId == null && row.supplier_id == null
        ? null
        : num(row.supplierId ?? row.supplier_id),
    supplierName: String(row.supplierName ?? row.supplier_name ?? '—'),
    userId: row.userId == null && row.user_id == null ? null : num(row.userId ?? row.user_id),
    userName: (row.userName ?? row.user_name ?? null) as string | null,
    date: String(row.date ?? ''),
    dueDate: (row.dueDate ?? row.due_date ?? null) as string | null,
    total: num(row.total),
    amountPaid: num(row.amountPaid ?? row.amount_paid),
    remainingAmount: num(row.remainingAmount ?? row.remaining_amount),
    paymentStatus: String(row.paymentStatus ?? row.payment_status ?? 'unpaid'),
    paymentMethod: String(row.paymentMethod ?? row.payment_method ?? 'Espèces'),
    status: toInvoiceStatus(row.status),
    cancelReason: (row.cancelReason ?? row.cancel_reason ?? null) as string | null,
    notes: (row.notes ?? null) as string | null,
    itemCount: num(row.itemCount ?? row.item_count),
    createdAt: (row.createdAt ?? row.created_at ?? null) as Date | string | null,
  };
}

export function normalizePurchaseItemRow(raw: unknown): PurchaseInvoiceItemRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const quantity = num(row.quantity);
  const unitPrice = num(row.unitPrice ?? row.unit_price);
  const amount = Number(row.amount);

  return {
    id: num(row.id),
    invoiceId: num(row.invoiceId ?? row.invoice_id),
    productId:
      row.productId == null && row.product_id == null
        ? null
        : num(row.productId ?? row.product_id),
    productName: String(row.productName ?? row.product_name ?? ''),
    unit: String(row.unit ?? 'pièce'),
    quantity,
    unitPrice,
    amount: Number.isFinite(amount) ? amount : quantity * unitPrice,
  };
}

export function normalizePaymentRow(raw: unknown): PaymentRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    id: num(row.id),
    receiptNumber: String(row.receiptNumber ?? row.receipt_number ?? '—'),
    type: String(row.type ?? 'purchase'),
    referenceId: num(row.referenceId ?? row.reference_id),
    amount: num(row.amount),
    paymentMethod: String(row.paymentMethod ?? row.payment_method ?? ''),
    paymentLabel: String(row.paymentLabel ?? row.payment_label ?? 'full'),
    date: String(row.date ?? ''),
    notes: (row.notes ?? null) as string | null,
    userId: row.userId == null && row.user_id == null ? null : num(row.userId ?? row.user_id),
    userName: (row.userName ?? row.user_name ?? null) as string | null,
    createdAt: (row.createdAt ?? row.created_at ?? null) as string | null,
  };
}

/** Libellés d'acompte : « deposit / balance / full » (§7). */
export const PAYMENT_LABEL_LABELS: Record<string, string> = {
  deposit: 'Acompte',
  balance: 'Solde',
  full: 'Intégral',
};

/** `PurchaseInvoiceRow` → document imprimable (§11). */
export function toPurchaseDocument(invoice: PurchaseInvoiceRow): PurchaseDocumentInvoice {
  return {
    reference: invoice.reference,
    supplierReference: invoice.supplierReference,
    date: invoice.date,
    dueDate: invoice.dueDate,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    remainingAmount: invoice.remainingAmount,
    paymentStatus: invoice.paymentStatus,
    paymentMethod: invoice.paymentMethod,
    status: invoice.status,
    notes: invoice.notes,
    cancelReason: invoice.cancelReason,
    userName: invoice.userName,
  };
}

export function toDocumentItems(items: PurchaseInvoiceItemRow[]): PurchaseDocumentItem[] {
  return items.map((item) => ({
    id: item.id,
    productName: item.productName,
    unit: item.unit,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: item.amount,
  }));
}

/** En-tête d'entreprise du document imprimable, depuis `settings` (§9.2). */
export function companyFromSettings(settings: {
  companyName: string;
  companyBranch: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyTaxId: string;
  companyLogo: string;
  currency: string;
  invoiceFooterNote: string;
}): PurchaseDocumentCompany {
  return {
    companyName: settings.companyName || 'Planète Déco Sarlu',
    companyBranch: settings.companyBranch || '',
    companyAddress: settings.companyAddress || '',
    companyPhone: settings.companyPhone || '',
    companyEmail: settings.companyEmail || '',
    companyTaxId: settings.companyTaxId || '',
    companyLogo: settings.companyLogo || '',
    currency: settings.currency || 'GNF',
    invoiceFooterNote: settings.invoiceFooterNote || '',
  };
}

/**
 * Coordonnées du fournisseur pour le document (téléphone, adresse).
 *
 * La ligne d'achat ne porte que `supplierId` et `supplierName` : on complète
 * depuis `GET /api/fournisseurs/[id]`. L'appel est **tolérant** — un échec
 * laisse simplement le bloc fournisseur sans coordonnées, le document reste
 * imprimable (c'est le nom qui fait foi).
 */
export function useSupplierContact(
  supplierId: number | null,
  enabled: boolean,
): PurchaseDocumentSupplier | null {
  const [contact, setContact] = useState<PurchaseDocumentSupplier | null>(null);

  useEffect(() => {
    if (!enabled || !supplierId) {
      setContact(null);
      return;
    }

    const controller = new AbortController();
    let active = true;

    void (async () => {
      try {
        const response = await fetch(`/api/fournisseurs/${supplierId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as Record<string, unknown>;
        const row = (payload.supplier ?? payload) as Record<string, unknown>;
        if (!active) return;
        setContact({
          name: String(row.name ?? ''),
          phone: (row.phone ?? null) as string | null,
          address: (row.address ?? null) as string | null,
        });
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        if (active) setContact(null);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [supplierId, enabled]);

  return contact;
}

/* ------------------------------------------------------------------ *
 * 1. Détail d'un achat — modale §8.2 « famille Détail »
 * ------------------------------------------------------------------ */

export type DetailLazyState = {
  items: PurchaseInvoiceItemRow[] | null;
  payments: PaymentRow[] | null;
  schedule: PaymentSchedule | null;
  isLoading: boolean;
  error: string | null;
};

const EMPTY_DETAIL: DetailLazyState = {
  items: null,
  payments: null,
  schedule: null,
  isLoading: false,
  error: null,
};

/**
 * Charge les lignes et l'échéancier d'un achat — utilisé par la modale de détail
 * ouverte depuis la liste (la page `/achats/[id]` charge déjà tout).
 */
export function usePurchaseDetailLazy(
  invoice: PurchaseInvoiceRow | null,
  enabled: boolean,
  reloadToken = 0,
): DetailLazyState & { reload: () => void } {
  const [state, setState] = useState<DetailLazyState>(EMPTY_DETAIL);
  const [token, setToken] = useState(0);

  const invoiceId = invoice?.id ?? null;

  useEffect(() => {
    if (!enabled || !invoiceId) {
      setState(EMPTY_DETAIL);
      return;
    }

    const controller = new AbortController();
    let active = true;

    setState((current) => ({ ...current, isLoading: true, error: null }));

    void (async () => {
      try {
        const response = await fetch(`/api/achats/${invoiceId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Le détail de l'achat n'a pas pu être chargé."),
          );
        }

        const payload = (await response.json()) as {
          invoice?: unknown;
          items?: unknown;
          payments?: unknown;
          schedule?: PaymentSchedule | null;
        };

        if (!active) return;

        const items = Array.isArray(payload.items)
          ? payload.items.map(normalizePurchaseItemRow)
          : [];
        const payments = Array.isArray(payload.payments)
          ? payload.payments.map(normalizePaymentRow)
          : [];
        const invoiceRow = normalizePurchaseRow(payload.invoice ?? invoice);

        setState({
          items,
          payments,
          schedule: payload.schedule ?? {
            total: invoiceRow.total,
            paid: invoiceRow.amountPaid,
            remaining: invoiceRow.remainingAmount,
            paymentStatus: invoiceRow.paymentStatus,
            dueDate: invoiceRow.dueDate,
            documentDate: invoiceRow.date,
            isOverdue: Boolean(invoiceRow.dueDate) && invoiceRow.remainingAmount > 0.001,
          },
          isLoading: false,
          error: null,
        });
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setState({
          items: null,
          payments: null,
          schedule: null,
          isLoading: false,
          error:
            caught instanceof Error
              ? caught.message
              : "Le détail de l'achat n'a pas pu être chargé.",
        });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
    // `invoice` est volontairement absent : seule son identité nous intéresse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, invoiceId, token, reloadToken]);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  return { ...state, reload };
}

export function PurchaseDetailModal({
  isOpen,
  onClose,
  invoice,
  detail,
  onOpenPayment,
  showDocumentLink = true,
}: {
  isOpen: boolean;
  onClose: () => void;
  invoice: PurchaseInvoiceRow | null;
  detail: DetailLazyState;
  /** Ouvre la modale de règlement (achat encore dû). */
  onOpenPayment?: () => void;
  /** Le lien « Voir le bon d'achat » n'a pas de sens depuis la page elle-même. */
  showDocumentLink?: boolean;
}) {
  const canPay = usePermission('payments.create');

  const items = detail.items ?? [];
  const payments = detail.payments ?? [];
  const schedule = detail.schedule;
  const remaining = schedule?.remaining ?? invoice?.remainingAmount ?? 0;
  const isCancelled = invoice?.status === 'cancelled';

  const itemColumns = [
    {
      key: 'productName',
      label: 'Désignation',
      primary: true,
      render: (item: PurchaseInvoiceItemRow) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{item.productName}</span>
        </span>
      ),
    },
    {
      key: 'quantity',
      label: 'Quantité',
      className: 'text-right whitespace-nowrap',
      render: (item: PurchaseInvoiceItemRow) => (
        <QuantityText value={item.quantity} unit={item.unit} />
      ),
    },
    {
      key: 'unitPrice',
      label: "Prix d'achat",
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (item: PurchaseInvoiceItemRow) => <MoneyText value={item.unitPrice} />,
    },
    {
      key: 'amount',
      label: 'Montant',
      className: 'text-right whitespace-nowrap',
      render: (item: PurchaseInvoiceItemRow) => <MoneyText value={item.amount} bold />,
    },
  ] satisfies Column<PurchaseInvoiceItemRow>[];

  const paymentColumns = [
    {
      key: 'receiptNumber',
      label: 'Reçu',
      primary: true,
      render: (payment: PaymentRow) => (
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
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (payment: PaymentRow) => (
        <span className="tabular text-base-content/70">{formatDateShort(payment.date)}</span>
      ),
    },
    {
      key: 'paymentMethod',
      label: 'Moyen',
      render: (payment: PaymentRow) => <span>{payment.paymentMethod || '—'}</span>,
    },
    {
      key: 'amount',
      label: 'Montant',
      className: 'text-right whitespace-nowrap',
      render: (payment: PaymentRow) => <MoneyText value={payment.amount} bold />,
    },
  ] satisfies Column<PaymentRow>[];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={invoice ? `Achat ${invoice.reference}` : "Détail de l'achat"}
      size="lg"
      fullScreenMobile
    >
      <div className="space-y-5 pb-2">
        {!invoice ? null : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="truncate text-lg font-semibold tabular">{invoice.reference}</h4>
                <p className="text-sm text-base-content/60">
                  {formatDateShort(invoice.date)} · {invoice.supplierName || '—'}
                </p>
                {invoice.supplierReference ? (
                  <p className="tabular text-xs text-base-content/50">
                    Réf. fournisseur : {invoice.supplierReference}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={invoice.status} kind="invoice" />
                <StatusBadge status={invoice.paymentStatus} kind="payment" />
                {schedule?.isOverdue && <Badge tone="error">En retard</Badge>}
              </div>
            </div>

            {isCancelled && (
              <div className="rounded-xl border border-error/30 bg-error/10 px-3 py-2.5 text-sm text-error">
                <p className="font-semibold">Achat annulé</p>
                <p className="mt-0.5 break-words">
                  Motif : {invoice.cancelReason || 'non renseigné'}
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label="Total" value={<MoneyText value={invoice.total} />} />
              <MiniStat
                label="Payé"
                tone="success"
                value={<MoneyText value={schedule?.paid ?? invoice.amountPaid} />}
              />
              <MiniStat
                label="Reste"
                tone={remaining > 0.001 ? 'error' : 'success'}
                value={<MoneyText value={remaining} colored bold />}
              />
              <MiniStat
                label="Règlement"
                value={<span className="text-sm">{invoice.paymentMethod || '—'}</span>}
              />
            </div>

            <Card padded={false} className="overflow-hidden">
              <div className="border-b border-base-200 bg-base-200/60 px-4 py-2.5">
                <h5 className="text-sm font-semibold">
                  Lignes de l&apos;achat
                  {items.length > 0 ? ` (${formatNumber(items.length)})` : ''}
                </h5>
              </div>
              {detail.isLoading ? (
                <div className="p-3">
                  <SkeletonTable rows={3} cols={4} />
                </div>
              ) : (
                <div className="p-2">
                  <ResponsiveTable
                    columns={itemColumns}
                    data={items}
                    getRowKey={(item) => item.id}
                    tableClassName="table-sm"
                    emptyMessage="Aucune ligne sur cet achat."
                  />
                </div>
              )}
            </Card>

            <Card className="space-y-1 py-2" padded={false}>
              <div className="px-4">
                <InfoRow label="Total de l'achat">
                  <MoneyText value={invoice.total} />
                </InfoRow>
                <InfoRow label="Réf. fournisseur">
                  <span className="tabular">
                    {invoice.supplierReference ? invoice.supplierReference : '—'}
                  </span>
                </InfoRow>
                <InfoRow label="Échéance">
                  <span className="tabular">
                    {invoice.dueDate ? formatDateShort(invoice.dueDate) : 'Comptant'}
                  </span>
                </InfoRow>
                <InfoRow label="Saisi par">
                  <span>{invoice.userName || '—'}</span>
                </InfoRow>
                {invoice.notes ? (
                  <InfoRow label="Notes">
                    <span className="font-normal text-base-content/70">{invoice.notes}</span>
                  </InfoRow>
                ) : null}
              </div>
            </Card>

            <Card padded={false} className="overflow-hidden">
              <div className="border-b border-base-200 bg-base-200/60 px-4 py-2.5">
                <h5 className="text-sm font-semibold">
                  Règlements enregistrés
                  {payments.length > 0 ? ` (${formatNumber(payments.length)})` : ''}
                </h5>
              </div>
              {detail.isLoading ? (
                <div className="p-3">
                  <SkeletonTable rows={2} cols={3} />
                </div>
              ) : (
                <div className="p-2">
                  <ResponsiveTable
                    columns={paymentColumns}
                    data={payments}
                    getRowKey={(payment) => payment.id}
                    tableClassName="table-sm"
                    emptyMessage="Aucun règlement enregistré pour cet achat."
                  />
                </div>
              )}
            </Card>

            {detail.error && (
              <div className="rounded-xl border border-error/30 bg-error/10 p-3 text-sm text-error">
                <p>{detail.error}</p>
                <p className="mt-1 text-xs text-base-content/60">
                  Les informations ci-dessus proviennent de la liste et restent valables.
                </p>
              </div>
            )}
          </>
        )}

        {!invoice && (
          <p className="rounded-xl border border-base-200 bg-base-200/50 px-3 py-3 text-sm text-base-content/60">
            Aucun achat sélectionné.
          </p>
        )}

        <div className="sticky bottom-0 flex flex-wrap justify-end gap-3 border-t border-base-200 bg-base-100 pb-1 pt-4">
          <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" onClick={onClose}>
            Fermer
          </button>
          {invoice && showDocumentLink && (
            <Link href={`/achats/${invoice.id}`} className="btn btn-outline min-h-11 sm:min-h-0">
              Voir le bon d&apos;achat
            </Link>
          )}
          {invoice && canPay && remaining > 0.001 && !isCancelled && onOpenPayment && (
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              onClick={onOpenPayment}
            >
              Enregistrer un paiement
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Règlement d'un achat — décaissement de caisse (§13, §15)
 * ------------------------------------------------------------------ */

export function PurchasePaymentModal({
  isOpen,
  onClose,
  invoiceId,
  documentNumber,
  supplierName,
  remainingAmount,
  onRecorded,
}: {
  isOpen: boolean;
  onClose: () => void;
  invoiceId: number;
  documentNumber: string;
  supplierName: string;
  /** Reste à payer au moment de l'ouverture — sert de montant par défaut. */
  remainingAmount: number;
  onRecorded?: (payment: { id: number; receiptNumber: string; amount: number }) => void;
}) {
  const { settings } = useSettings();
  const canCreate = usePermission('payments.create');

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

  /* Réinitialisation à chaque ouverture : la modale ne garde aucun résidu. */
  useEffect(() => {
    if (!isOpen) return;

    setAmount(remainingAmount > 0 ? String(remainingAmount) : '');
    setNotes('');
    setDate(today());
    setFormError(null);
    setReceipt(null);
    setIsSubmitting(false);
    setPaymentMethod(
      paymentMethods.some((method) => method.toLowerCase() === 'espèces')
        ? 'Espèces'
        : (paymentMethods[0] ?? 'Espèces'),
    );
    // `remainingAmount` et `paymentMethods` sont stables pendant l'ouverture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, invoiceId]);

  const paid = Number(amount);
  const remainingAfter = Math.max(remainingAmount - (Number.isFinite(paid) ? paid : 0), 0);

  const submit = async () => {
    if (!canCreate) {
      setFormError("Vous n'avez pas la permission d'enregistrer un règlement fournisseur.");
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
    if (!date) {
      setFormError('La date du règlement est obligatoire.');
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
          // `type: 'purchase'` : `createPayment` en déduit une **sortie** de
          // caisse (`DOCUMENT_CONFIG.purchase.cashType = 'expense'`).
          type: 'purchase',
          referenceId: invoiceId,
          amount: paid,
          paymentMethod,
          date,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Le règlement n'a pas pu être enregistré."));
      }

      const payment = (await response.json()) as {
        id: number;
        receiptNumber: string;
        amount: number;
      };

      setReceipt({ id: payment.id, receiptNumber: payment.receiptNumber });
      onRecorded?.({
        id: payment.id,
        receiptNumber: payment.receiptNumber,
        amount: Number(payment.amount ?? paid),
      });
    } catch (caught) {
      setFormError(
        caught instanceof Error ? caught.message : "Le règlement n'a pas pu être enregistré.",
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
      title="Enregistrer un paiement"
      size="lg"
      fullScreenMobile
    >
      <div className="space-y-4 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-base-200 bg-base-200/50 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {documentNumber} — {supplierName || '—'}
            </p>
            <p className="text-xs text-base-content/60">Reste à payer</p>
          </div>
          <MoneyText value={remainingAmount} colored bold className="text-lg" />
        </div>

        {receipt ? (
          <div className="space-y-3 rounded-xl border border-success/30 bg-success/10 p-4">
            <p className="text-sm font-medium text-success">
              Règlement enregistré — reçu {receipt.receiptNumber}.
            </p>
            <Link href={`/recus/${receipt.id}`} className="btn btn-success btn-sm min-h-11 sm:min-h-0">
              Voir le reçu
            </Link>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label="Montant payé (GNF)"
                htmlFor="purchase-payment-amount"
                required
                hint={`Reste après règlement : ${formatNumber(remainingAfter)} GNF`}
                error={formError}
              >
                <input
                  id="purchase-payment-amount"
                  type="number"
                  min={0}
                  step={1000}
                  inputMode="numeric"
                  className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0"
                />
              </FormField>

              <FormField label="Moyen de paiement" htmlFor="purchase-payment-method" required>
                <select
                  id="purchase-payment-method"
                  className="select select-bordered min-h-11 w-full sm:min-h-0"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                >
                  {paymentMethods.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </FormField>

              <FormField label="Date du règlement" htmlFor="purchase-payment-date" required>
                <DatePicker value={date} onChange={setDate} placeholder="jj/mm/aaaa" />
              </FormField>

              <FormField label="Note" htmlFor="purchase-payment-notes" hint="Facultatif.">
                <input
                  id="purchase-payment-notes"
                  type="text"
                  className="input input-bordered min-h-11 w-full sm:min-h-0"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Ex. acompte versé au fournisseur"
                  autoComplete="off"
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <MiniStat label="Reste avant" value={<MoneyText value={remainingAmount} />} />
              <MiniStat
                label="Reste après"
                tone={remainingAfter > 0.001 ? 'warning' : 'success'}
                value={<MoneyText value={remainingAfter} bold />}
              />
            </div>

            <p className="rounded-xl border border-base-200 bg-base-200/50 px-3 py-2 text-xs text-base-content/60">
              Le règlement d&apos;un achat est une <strong>sortie de caisse</strong> : elle est
              enregistrée avec un reçu numéroté et la dette fournisseur est recalculée à la lecture.
            </p>
          </>
        )}

        <div className="sticky bottom-0 flex justify-end gap-3 border-t border-base-200 bg-base-100 pb-1 pt-4">
          <button
            type="button"
            className="btn btn-ghost min-h-11 sm:min-h-0"
            onClick={onClose}
            disabled={isSubmitting}
          >
            {receipt ? 'Fermer' : 'Annuler'}
          </button>
          {!receipt && (
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              onClick={() => void submit()}
              disabled={isSubmitting || !canCreate}
            >
              {isSubmitting ? (
                <span className="loading loading-spinner loading-sm" />
              ) : (
                'Enregistrer le paiement'
              )}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Annulation — jamais une suppression (§14)
 * ------------------------------------------------------------------ */

export function CancelPurchaseDialog({
  isOpen,
  onClose,
  onConfirm,
  invoice,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Reçoit le motif saisi (toujours non vide). */
  onConfirm: (reason: string) => void | Promise<void>;
  invoice: PurchaseInvoiceRow | null;
  isSubmitting: boolean;
}) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setReason('');
    setReasonError(null);
  }, [isOpen]);

  const confirm = async () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError(
        "Le motif d'annulation est obligatoire : il est conservé sur l'achat et dans le journal d'actions.",
      );
      return;
    }
    setReasonError(null);
    await onConfirm(trimmed);
  };

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={confirm}
      title="Annuler l'achat"
      tone="error"
      confirmLabel="Annuler l'achat"
      isSubmitting={isSubmitting}
      message={
        <>
          L&apos;achat <strong className="tabular">{invoice?.reference ?? '—'}</strong> du fournisseur{' '}
          <strong>{invoice?.supplierName || '—'}</strong> sera marqué <strong>annulé</strong>.
          <span className="mt-2 block rounded-lg border border-error/30 bg-error/10 px-2.5 py-1.5 text-error">
            Les entrées de stock seront inversées et le décaissement contre-passé. L&apos;achat ne
            sera pas supprimé : il reste consultable et réimprimable, avec son motif.
          </span>
          {/*
            Cas réel documenté (lib/purchases.ts) : si la marchandise a déjà été
            vendue, l'annulation aboutit quand même — le stock peut devenir
            négatif, ce qui est visible et réparable par inventaire. Bloquer
            l'annulation laisserait un document comptablement faux.
          */}
          <span className="mt-2 block text-xs text-base-content/60">
            Si la marchandise a déjà été vendue, le stock peut passer en négatif : c&apos;est
            volontaire, l&apos;annulation doit aboutir. Corrigez ensuite par un inventaire.
          </span>
          {invoice && invoice.amountPaid > 0.001 && (
            <span className="mt-2 block text-xs text-base-content/60">
              Un règlement de {formatNumber(invoice.amountPaid)} GNF est déjà enregistré sur cet
              achat.
            </span>
          )}
        </>
      }
    >
      <FormField
        label="Motif d'annulation"
        htmlFor="purchase-cancel-reason"
        required
        error={reasonError}
        hint="Ex. erreur de saisie, retour marchandise, facture fournisseur erronée…"
      >
        <textarea
          id="purchase-cancel-reason"
          rows={3}
          className="textarea textarea-bordered w-full"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Pourquoi cet achat est-il annulé ?"
          disabled={isSubmitting}
        />
      </FormField>
    </ConfirmDialog>
  );
}
