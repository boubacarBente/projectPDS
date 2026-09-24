'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { DatePicker } from '@/components/date-picker';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  EmptyState,
  ErrorState,
  FormField,
  InfoRow,
  MoneyText,
  Skeleton,
  SkeletonTable,
  StatusBadge,
} from '@/components/design-system';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency, formatNumber, today } from '@/lib/format';

/* ==================================================================
 * Modales du module Fournisseurs (§7.3, README §8)
 *
 * Règles appliquées :
 *  - **une modale = un état booléen** porté par la page appelante ; aucune
 *    modale pilotée par une chaîne « mode » ;
 *  - `onClose` ne ferme jamais pendant un envoi, et le bouton de confirmation
 *    porte un spinner ;
 *  - aucun `window.confirm` / `alert` / `prompt` : tout passe par `Modal` et
 *    `ConfirmDialog` ;
 *  - toute liste passe par `ResponsiveTable`, tout montant par `MoneyText`.
 *
 * Les types ci-dessous décrivent la **forme JSON** échangée avec l'API. Ils
 * sont volontairement déclarés ici plutôt qu'importés de `lib/suppliers.ts` :
 * un composant client ne doit jamais tirer Drizzle ni la base dans son bundle.
 * ================================================================== */

export type SupplierRecord = {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  purchaseCount: number;
  totalPurchased: number;
  totalPaid: number;
  balance: number;
  lastPurchaseDate: string | null;
};

export type SupplierPurchaseEntry = {
  id: number;
  reference: string;
  supplierReference: string | null;
  date: string;
  dueDate: string | null;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  status: string;
};

export type SupplierStatsRecord = {
  supplier: SupplierRecord;
  purchaseCount: number;
  totalPurchased: number;
  totalPaid: number;
  balance: number;
  averageBasket: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
  topProducts: { productName: string; quantity: number; amount: number }[];
  recentPurchases: SupplierPurchaseEntry[];
};

/** Moyens de paiement par défaut (`lib/settings-schema.ts`). */
export const PAYMENT_METHODS = ['Espèces', 'Mobile Money', 'Virement', 'Crédit'] as const;

/** Libellés d'échéancier de `lib/payments.ts`. */
export const PAYMENT_LABELS: Record<string, string> = {
  deposit: 'Acompte',
  balance: 'Solde',
  full: 'Intégral',
};

type PurchaseInvoiceOption = {
  id: number;
  reference: string;
  date: string | null;
  total: number;
  amountPaid: number;
  remainingAmount: number;
};

/* ------------------------------------------------------------------
 * Modale « Nouveau / Modifier un fournisseur »
 * ------------------------------------------------------------------ */

export function SupplierFormModal({
  isOpen,
  onClose,
  supplier,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** `null` = création. Le booléen `isOpen` suffit : pas d'état « mode ». */
  supplier: SupplierRecord | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(supplier?.name ?? '');
    setPhone(supplier?.phone ?? '');
    setAddress(supplier?.address ?? '');
    setNotes(supplier?.notes ?? '');
    setIsActive(supplier?.isActive ?? true);
    setFormError(null);
  }, [isOpen, supplier]);

  const requestClose = () => {
    if (!isSubmitting) onClose();
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    if (!name.trim()) {
      setFormError('Le nom du fournisseur est obligatoire.');
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    try {
      const response = await fetch(
        supplier ? `/api/fournisseurs/${supplier.id}` : '/api/fournisseurs',
        {
          method: supplier ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            name: name.trim(),
            phone: phone.trim() || null,
            address: address.trim() || null,
            notes: notes.trim() || null,
            isActive,
          }),
        },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Enregistrement impossible');
      }

      toast.success(supplier ? 'Fournisseur modifié' : 'Fournisseur créé');
      onSaved();
      onClose();
    } catch (error: any) {
      const message = error?.message ?? 'Enregistrement impossible';
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      title={supplier ? 'Modifier le fournisseur' : 'Nouveau fournisseur'}
      size="md"
      fullScreenMobile
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Nom" htmlFor="supplier-name" required className="sm:col-span-2">
            <input
              id="supplier-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="input input-bordered min-h-11 w-full"
              placeholder="Ex. : Ets Diallo Matériaux"
              autoComplete="off"
            />
          </FormField>

          <FormField label="Téléphone" htmlFor="supplier-phone">
            <input
              id="supplier-phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              className="input input-bordered min-h-11 w-full"
              placeholder="Ex. : 620 00 00 00"
              autoComplete="off"
            />
          </FormField>

          <FormField label="Adresse" htmlFor="supplier-address">
            <input
              id="supplier-address"
              type="text"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="input input-bordered min-h-11 w-full"
              placeholder="Ex. : Madina, Conakry"
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Notes"
            htmlFor="supplier-notes"
            hint="Informations utiles : conditions de règlement, contact, délais…"
            className="sm:col-span-2"
          >
            <textarea
              id="supplier-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="textarea textarea-bordered w-full"
              rows={3}
              placeholder="Ex. : règlement à 30 jours"
            />
          </FormField>

          {supplier && (
            <FormField label="Statut" className="sm:col-span-2">
              <label className="flex min-h-11 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  className="toggle toggle-primary"
                  checked={isActive}
                  onChange={(event) => setIsActive(event.target.checked)}
                />
                <span className="text-sm">
                  {isActive ? 'Fournisseur actif' : 'Fournisseur désactivé'}
                </span>
              </label>
            </FormField>
          )}
        </div>

        {formError && (
          <p className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {formError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 border-t border-base-200 pt-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={requestClose}
            disabled={isSubmitting}
            className="btn btn-ghost min-h-11"
          >
            Annuler
          </button>
          <button type="submit" disabled={isSubmitting} className="btn btn-primary min-h-11">
            {isSubmitting ? (
              <span className="loading loading-spinner loading-sm" />
            ) : supplier ? (
              'Enregistrer les modifications'
            ) : (
              'Créer le fournisseur'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------
 * Modale « Détail du fournisseur »
 * ------------------------------------------------------------------ */

export function SupplierDetailModal({
  isOpen,
  onClose,
  supplierId,
}: {
  isOpen: boolean;
  onClose: () => void;
  supplierId: number | null;
}) {
  const [stats, setStats] = useState<SupplierStatsRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!isOpen || !supplierId) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(`/api/fournisseurs/${supplierId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error ?? 'Chargement de la fiche impossible');
        }
        setStats(await response.json());
      } catch (caught: any) {
        if (caught?.name === 'AbortError') return;
        setError(caught?.message ?? 'Chargement de la fiche impossible');
      } finally {
        setIsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [isOpen, supplierId, reloadToken]);

  const purchaseColumns: Column<SupplierPurchaseEntry>[] = [
    {
      key: 'reference',
      label: 'N° facture',
      primary: true,
      render: (purchase) => (
        <span className="font-medium">{purchase.reference}</span>
      ),
    },
    {
      key: 'date',
      label: 'Date',
      render: (purchase) => formatDateShort(purchase.date),
    },
    {
      key: 'total',
      label: 'Total',
      render: (purchase) => <MoneyText value={purchase.total} />,
    },
    {
      key: 'amountPaid',
      label: 'Payé',
      hideOnMobile: true,
      render: (purchase) => <MoneyText value={purchase.amountPaid} />,
    },
    {
      key: 'remainingAmount',
      label: 'Reste',
      render: (purchase) => (
        <MoneyText value={purchase.remainingAmount} colored bold />
      ),
    },
    {
      key: 'paymentStatus',
      label: 'Paiement',
      render: (purchase) => <StatusBadge status={purchase.paymentStatus} kind="payment" />,
    },
  ];

  const productColumns: Column<{ productName: string; quantity: number; amount: number }>[] = [
    {
      key: 'productName',
      label: 'Produit',
      primary: true,
      render: (product) => product.productName,
    },
    {
      key: 'quantity',
      label: 'Quantité',
      render: (product) => <span className="tabular">{formatNumber(product.quantity, 2)}</span>,
    },
    {
      key: 'amount',
      label: 'Montant',
      render: (product) => <MoneyText value={product.amount} />,
    },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={stats ? stats.supplier.name : 'Fiche fournisseur'}
      size="lg"
      fullScreenMobile
    >
      {isLoading && !stats ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
          <SkeletonTable rows={4} cols={4} />
        </div>
      ) : error ? (
        <ErrorState
          title="Fiche indisponible"
          description={error}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      ) : !stats ? (
        <EmptyState
          title="Aucune donnée"
          description="Cette fiche fournisseur ne contient encore aucune information."
        />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            {stats.supplier.isActive ? (
              <Badge tone="success">Actif</Badge>
            ) : (
              <Badge tone="neutral">Inactif</Badge>
            )}
            <Badge tone={stats.balance > 0.001 ? 'warning' : 'neutral'}>
              {stats.balance > 0.001 ? 'Dette en cours' : 'À jour'}
            </Badge>
          </div>

          <div className="rounded-xl border border-base-200 bg-base-100 px-4 py-2">
            <InfoRow label="Téléphone">{stats.supplier.phone || '—'}</InfoRow>
            <InfoRow label="Adresse">{stats.supplier.address || '—'}</InfoRow>
            <InfoRow label="Notes">
              <span className="block max-w-md text-right whitespace-pre-line">
                {stats.supplier.notes || '—'}
              </span>
            </InfoRow>
            <InfoRow label="Premier achat">{formatDateShort(stats.firstPurchaseDate)}</InfoRow>
            <InfoRow label="Dernier achat">{formatDateShort(stats.lastPurchaseDate)}</InfoRow>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-base-content/60">
                Achats
              </div>
              <div className="text-sm font-semibold tabular">
                {formatNumber(stats.purchaseCount)}
              </div>
            </div>
            <div className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-base-content/60">
                Total acheté
              </div>
              <div className="text-sm font-semibold">
                <MoneyText value={stats.totalPurchased} />
              </div>
            </div>
            <div className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-base-content/60">Payé</div>
              <div className="text-sm font-semibold">
                <MoneyText value={stats.totalPaid} />
              </div>
            </div>
            <div className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-base-content/60">Dette</div>
              <div className="text-sm font-semibold">
                <MoneyText value={stats.balance} colored bold />
              </div>
            </div>
          </div>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Dernières factures d&apos;achat</h3>
            {stats.recentPurchases.length === 0 ? (
              <EmptyState
                title="Aucun achat enregistré"
                description="Les factures d'achat de ce fournisseur apparaîtront ici."
                action={
                  <Link href={`/fournisseurs/${stats.supplier.id}`} className="btn btn-primary btn-sm">
                    Ouvrir la fiche complète
                  </Link>
                }
              />
            ) : (
              <ResponsiveTable
                columns={purchaseColumns}
                data={stats.recentPurchases}
                getRowKey={(purchase) => purchase.id}
              />
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Produits les plus achetés</h3>
            {stats.topProducts.length === 0 ? (
              <EmptyState
                title="Aucun produit"
                description="Les produits achetés chez ce fournisseur apparaîtront ici."
              />
            ) : (
              <ResponsiveTable
                columns={productColumns}
                data={stats.topProducts}
                getRowKey={(product) => product.productName}
              />
            )}
          </section>

          <div className="flex flex-col-reverse gap-2 border-t border-base-200 pt-4 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} className="btn btn-ghost min-h-11">
              Fermer
            </button>
            <Link
              href={`/fournisseurs/${stats.supplier.id}`}
              className="btn btn-primary min-h-11"
            >
              Voir la fiche complète
            </Link>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------
 * Modale « Payer une dette »
 * ------------------------------------------------------------------ */

type PurchaseInvoiceState = {
  invoices: PurchaseInvoiceOption[];
  warning: string | null;
};

const PURCHASES_UNAVAILABLE =
  "Les factures d'achat de ce fournisseur n'ont pas pu être chargées (module Achats indisponible). Saisissez l'identifiant de la facture à régler.";

/**
 * Charge les factures d'achat impayées du fournisseur.
 *
 * ⚠️ `GET /api/achats` appartient au module Achats — l'appel est **tolérant** :
 * une route absente (404) ou en erreur ne doit jamais faire planter la modale
 * de règlement, elle affiche un message clair et laisse la saisie manuelle.
 */
async function loadUnpaidPurchases(
  supplierId: number,
  signal: AbortSignal,
): Promise<PurchaseInvoiceState> {
  try {
    const response = await fetch(`/api/achats?supplierId=${supplierId}&limit=200`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
    });

    if (!response.ok) {
      // 404 = route du module Achats pas encore livrée ; 403 = droits
      // insuffisants. Dans les deux cas on n'empêche pas le règlement.
      return {
        invoices: [],
        warning:
          response.status === 404
            ? "Le module Achats n'est pas encore disponible : saisissez l'identifiant de la facture d'achat à régler."
            : "Les factures d'achat de ce fournisseur n'ont pas pu être chargées (droits insuffisants ou module Achats indisponible). Saisissez l'identifiant de la facture à régler.",
      };
    }

    const payload = await response.json().catch(() => null);
    const rows: any[] = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

    const invoices: PurchaseInvoiceOption[] = rows
      .map((row) => ({
        id: Number(row.id),
        reference: String(
          row.reference ?? row.invoiceNumber ?? row.supplierReference ?? `Facture #${row.id}`,
        ),
        date: row.date ?? null,
        total: Number(row.total ?? 0),
        amountPaid: Number(row.amountPaid ?? row.amount_paid ?? 0),
        remainingAmount: Number(row.remainingAmount ?? row.remaining_amount ?? 0),
        status: String(row.status ?? 'active'),
      }))
      .filter(
        (row) =>
          Number.isInteger(row.id) &&
          row.id > 0 &&
          row.remainingAmount > 0.001 &&
          row.status !== 'cancelled',
      )
      .map((row) => ({
        id: row.id,
        reference: row.reference,
        date: row.date,
        total: row.total,
        amountPaid: row.amountPaid,
        remainingAmount: row.remainingAmount,
      }));

    if (invoices.length === 0) {
      return {
        invoices,
        warning: "Aucune facture d'achat impayée n'a été trouvée pour ce fournisseur.",
      };
    }

    return { invoices, warning: null };
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    return { invoices: [], warning: PURCHASES_UNAVAILABLE };
  }
}

export function PaySupplierDebtModal({
  isOpen,
  onClose,
  supplierId,
  supplierName,
  onPaid,
}: {
  isOpen: boolean;
  onClose: () => void;
  supplierId: number | null;
  supplierName?: string;
  onPaid: () => void;
}) {
  const [invoices, setInvoices] = useState<PurchaseInvoiceOption[]>([]);
  const [isLoadingInvoices, setIsLoadingInvoices] = useState(false);
  const [invoiceWarning, setInvoiceWarning] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [referenceId, setReferenceId] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<string>(PAYMENT_METHODS[0]);
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setReferenceId('');
    setAmount('');
    setPaymentMethod(PAYMENT_METHODS[0]);
    setDate(today());
    setNotes('');
    setFormError(null);
  }, [isOpen, supplierId]);

  useEffect(() => {
    if (!isOpen || !supplierId) return;

    const controller = new AbortController();
    setIsLoadingInvoices(true);
    setInvoiceWarning(null);

    void (async () => {
      try {
        const state = await loadUnpaidPurchases(supplierId, controller.signal);
        setInvoices(state.invoices);
        setInvoiceWarning(state.warning);
      } catch (caught: any) {
        if (caught?.name === 'AbortError') return;
        setInvoices([]);
        setInvoiceWarning(PURCHASES_UNAVAILABLE);
      } finally {
        setIsLoadingInvoices(false);
      }
    })();

    return () => controller.abort();
  }, [isOpen, supplierId, reloadToken]);

  const selectedInvoice = useMemo(
    () => invoices.find((invoice) => String(invoice.id) === referenceId) ?? null,
    [invoices, referenceId],
  );

  const requestClose = () => {
    if (!isSubmitting) onClose();
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    const targetId = Number(referenceId);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      setFormError("Sélectionnez la facture d'achat à régler.");
      return;
    }

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setFormError('Le montant du règlement doit être supérieur à zéro.');
      return;
    }

    if (!date) {
      setFormError('Choisissez la date du règlement.');
      return;
    }

    if (selectedInvoice && value > selectedInvoice.remainingAmount + 0.01) {
      setFormError(
        `Le montant dépasse le reste à payer (${formatCurrency(selectedInvoice.remainingAmount)}).`,
      );
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    try {
      const response = await fetch('/api/paiements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          type: 'purchase',
          referenceId: targetId,
          amount: value,
          paymentMethod,
          date,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Règlement impossible');
      }

      toast.success('Règlement enregistré');
      onPaid();
      onClose();
    } catch (error: any) {
      const message = error?.message ?? 'Règlement impossible';
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      title={supplierName ? `Payer une dette — ${supplierName}` : 'Payer une dette'}
      size="md"
      fullScreenMobile
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Facture d'achat"
            htmlFor="payment-purchase"
            required
            className="sm:col-span-2"
            hint={
              selectedInvoice
                ? `Reste à payer : ${formatCurrency(selectedInvoice.remainingAmount)}`
                : undefined
            }
          >
            {isLoadingInvoices ? (
              <Skeleton className="h-11 w-full" />
            ) : invoices.length > 0 ? (
              <select
                id="payment-purchase"
                value={referenceId}
                onChange={(event) => {
                  setReferenceId(event.target.value);
                  const invoice = invoices.find((item) => String(item.id) === event.target.value);
                  if (invoice) setAmount(String(invoice.remainingAmount));
                }}
                className="select select-bordered min-h-11 w-full"
              >
                <option value="">Sélectionner une facture…</option>
                {invoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.reference} — reste {formatCurrency(invoice.remainingAmount)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="payment-purchase"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={referenceId}
                onChange={(event) => setReferenceId(event.target.value)}
                className="input input-bordered min-h-11 w-full tabular"
                placeholder="Identifiant de la facture d'achat"
              />
            )}
          </FormField>

          {invoiceWarning && (
            <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning sm:col-span-2">
              <p>{invoiceWarning}</p>
              {invoices.length === 0 && !isLoadingInvoices && (
                <button
                  type="button"
                  onClick={() => setReloadToken((token) => token + 1)}
                  className="btn btn-ghost btn-xs mt-1"
                >
                  Réessayer
                </button>
              )}
            </div>
          )}

          <FormField label="Montant" htmlFor="payment-amount" required>
            <input
              id="payment-amount"
              type="number"
              min={0}
              step="1"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="input input-bordered min-h-11 w-full tabular"
              placeholder="Ex. : 1 500 000"
            />
          </FormField>

          <FormField label="Moyen de paiement" htmlFor="payment-method">
            <select
              id="payment-method"
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="select select-bordered min-h-11 w-full"
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </FormField>

          <FormField
            label="Date du règlement"
            hint="Date métier au format AAAA-MM-JJ."
            className="sm:col-span-2"
          >
            <DatePicker value={date} onChange={setDate} placeholder="Choisir une date" />
          </FormField>

          <FormField label="Notes" htmlFor="payment-notes" className="sm:col-span-2">
            <textarea
              id="payment-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="textarea textarea-bordered w-full"
              rows={2}
              placeholder="Ex. : règlement partiel de la facture ACH-2026-000012"
            />
          </FormField>
        </div>

        {formError && (
          <p className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {formError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 border-t border-base-200 pt-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={requestClose}
            disabled={isSubmitting}
            className="btn btn-ghost min-h-11"
          >
            Annuler
          </button>
          <button type="submit" disabled={isSubmitting} className="btn btn-primary min-h-11">
            {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : 'Enregistrer le règlement'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
