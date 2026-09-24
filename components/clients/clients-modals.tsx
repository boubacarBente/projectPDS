'use client';

/**
 * Modales du module Clients (README §7.2, §8).
 *
 * Une modale par **état booléen** (§8.3 règle 1) : les appelants pilotent
 * `showFormModal`, `showDetailModal`, `showPaymentModal` et
 * `showDeactivateModal`. Le formulaire créer/modifier partage un seul
 * composant, mais reste monté dans **deux modales distinctes** : aucune modale
 * générique pilotée par une chaîne.
 *
 * Toutes les écritures passent par l'API du module (`/api/clients`,
 * `/api/paiements`) : aucune requête Drizzle ici, la logique vit dans `lib/`.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
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
  SkeletonTable,
  StatusBadge,
} from '@/components/design-system';
import { useSettings } from '@/app/parametres/page';
import { usePermission } from '@/components/role-gate';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, today } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types partagés avec les pages du module
 * ------------------------------------------------------------------ */

export type CustomerRecord = {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  creditLimit: number;
  isActive: boolean;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
  lastPurchaseDate: string | null;
  createdAt: string | null;
};

export type CustomerStatsRecord = {
  customer: CustomerRecord;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
  averageBasket: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
  creditLimitExceeded: boolean;
  topProducts: { productName: string; quantity: number; amount: number }[];
  recentInvoices: {
    id: number;
    invoiceNumber: string;
    date: string;
    total: number;
    amountPaid: number;
    remainingAmount: number;
    paymentStatus: string;
    status: string;
  }[];
};

export type CustomerFormValues = {
  name: string;
  phone: string;
  address: string;
  creditLimit: string;
  notes: string;
  isActive: boolean;
};

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

/* ------------------------------------------------------------------ *
 * Factures impayées d'un client
 *
 * ⚠️ `GET /api/ventes` appartient au module Ventes (écrit par un autre lot).
 * L'appel est donc **tolérant** : 404, réponse inattendue ou réseau indisponible
 * n'empêchent jamais la page de fonctionner — un message clair s'affiche à la
 * place du sélecteur de facture.
 * ------------------------------------------------------------------ */

export type UnpaidInvoice = {
  id: number;
  invoiceNumber: string;
  date: string;
  total: number;
  amountPaid: number;
  remainingAmount: number;
};

export const SALES_ROUTE_UNAVAILABLE = 'sales-route-unavailable';

/** `null` = chargement en cours, `string` = échec, tableau = succès. */
export type UnpaidInvoicesState = UnpaidInvoice[] | string | null;

function normalizeInvoices(payload: unknown): UnpaidInvoice[] {
  const raw: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : [];

  return raw
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const total = Number(row.total ?? 0);
      const amountPaid = Number(
        row.amountPaid ?? row.amount_paid ?? 0,
      );
      const rawRemaining = row.remainingAmount ?? row.remaining_amount ?? row.restToPay;
      const remainingAmount = Number(
        rawRemaining === undefined || rawRemaining === null ? total - amountPaid : rawRemaining,
      );

      return {
        id: Number(row.id ?? 0),
        invoiceNumber: String(row.invoiceNumber ?? row.invoice_number ?? `#${row.id ?? '?'}`),
        date: typeof row.date === 'string' ? row.date : '',
        total,
        amountPaid,
        remainingAmount: Number.isFinite(remainingAmount) ? remainingAmount : total - amountPaid,
      };
    })
    .filter((invoice) => invoice.id > 0 && invoice.remainingAmount > 0.001);
}

/**
 * Charge les factures impayées d'un client.
 *
 * @returns `SALES_ROUTE_UNAVAILABLE` si la route ventes n'existe pas (404/405),
 * un message d'erreur en cas d'autre échec, la liste sinon.
 */
export async function fetchUnpaidInvoices(
  customerId: number,
  signal?: AbortSignal,
): Promise<UnpaidInvoice[] | string> {
  try {
    const response = await fetch(`/api/ventes?customerId=${customerId}&limit=200`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
    });

    if (response.status === 404 || response.status === 405) return SALES_ROUTE_UNAVAILABLE;
    if (!response.ok) {
      return await readApiError(
        response,
        'Les factures du client n’ont pas pu être chargées.',
      );
    }

    return normalizeInvoices(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return 'Les factures du client n’ont pas pu être chargées (connexion indisponible).';
  }
}

/* ------------------------------------------------------------------ *
 * 1. Formulaire — création et modification
 * ------------------------------------------------------------------ */

function emptyFormValues(isActive = true): CustomerFormValues {
  return { name: '', phone: '', address: '', creditLimit: '', notes: '', isActive };
}

function valuesFromCustomer(customer: CustomerRecord): CustomerFormValues {
  return {
    name: customer.name ?? '',
    phone: customer.phone ?? '',
    address: customer.address ?? '',
    creditLimit: customer.creditLimit ? String(customer.creditLimit) : '',
    notes: customer.notes ?? '',
    isActive: customer.isActive,
  };
}

export function CustomerFormModal({
  isOpen,
  onClose,
  onSaved,
  customer = null,
  idPrefix = 'create',
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (customer: CustomerRecord) => void;
  /** `null` = création, sinon modification de la fiche. */
  customer?: CustomerRecord | null;
  /**
   * Préfixe des `id` de champs : deux modales (création et modification)
   * coexistent dans le DOM, leurs identifiants doivent rester uniques.
   */
  idPrefix?: string;
}) {
  const isEdit = Boolean(customer);
  const customerId = customer?.id ?? null;
  const fieldId = (name: string) => `${idPrefix}-customer-${name}`;

  const [values, setValues] = useState<CustomerFormValues>(() => emptyFormValues());
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setValues(customer ? valuesFromCustomer(customer) : emptyFormValues());
    setNameError(null);
    setFormError(null);
    setIsSubmitting(false);
    // `customerId` suffit : la fiche affichée ne change pas sans fermeture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, customerId]);

  const setField = <K extends keyof CustomerFormValues>(key: K, value: CustomerFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    const name = values.name.trim();
    if (!name) {
      setNameError('Le nom du client est obligatoire');
      return;
    }
    if (values.creditLimit.trim() && !Number.isFinite(Number(values.creditLimit))) {
      setFormError('Le plafond de crédit doit être un montant valide');
      return;
    }

    setNameError(null);
    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(
        isEdit && customer ? `/api/clients/${customer.id}` : '/api/clients',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            name,
            phone: values.phone.trim() || null,
            address: values.address.trim() || null,
            notes: values.notes.trim() || null,
            creditLimit: values.creditLimit.trim() ? Number(values.creditLimit) : 0,
            ...(isEdit ? { isActive: values.isActive } : {}),
          }),
        },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, "Le client n'a pas pu être enregistré."));
      }

      const saved = (await response.json()) as CustomerRecord;

      onSaved({ ...saved, creditLimit: Number(saved.creditLimit ?? 0) });
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Le client n'a pas pu être enregistré.",
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
      title={isEdit ? 'Modifier le client' : 'Nouveau client'}
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
          <p
            role="alert"
            className="mb-4 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
          >
            {formError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Nom du client"
            htmlFor={fieldId('name')}
            required
            error={nameError}
            className="sm:col-span-2"
          >
            <input
              id={fieldId('name')}
              type="text"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={values.name}
              onChange={(event) => setField('name', event.target.value)}
              placeholder="Ex. Mamadou Diallo"
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Téléphone"
            htmlFor={fieldId('phone')}
            hint="Utilisé pour le contact et WhatsApp."
          >
            <input
              id={fieldId('phone')}
              type="tel"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={values.phone}
              onChange={(event) => setField('phone', event.target.value)}
              placeholder="Ex. 622 00 00 00"
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Plafond de crédit (GNF)"
            htmlFor={fieldId('credit-limit')}
            hint="0 = aucun plafond. Un dépassement avertit, il ne bloque pas."
          >
            <input
              id={fieldId('credit-limit')}
              type="number"
              min={0}
              step={1000}
              inputMode="numeric"
              className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
              value={values.creditLimit}
              onChange={(event) => setField('creditLimit', event.target.value)}
              placeholder="0"
            />
          </FormField>

          <FormField label="Adresse" htmlFor={fieldId('address')} className="sm:col-span-2">
            <input
              id={fieldId('address')}
              type="text"
              className="input input-bordered min-h-11 w-full sm:min-h-0"
              value={values.address}
              onChange={(event) => setField('address', event.target.value)}
              placeholder="Quartier, commune, ville"
              autoComplete="off"
            />
          </FormField>

          <FormField
            label="Informations utiles"
            htmlFor={fieldId('notes')}
            hint="NIF, personne à contacter, conditions particulières…"
            className="sm:col-span-2"
          >
            <textarea
              id={fieldId('notes')}
              rows={3}
              className="textarea textarea-bordered w-full"
              value={values.notes}
              onChange={(event) => setField('notes', event.target.value)}
              placeholder="Notes internes"
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
                Client actif
                <span className="block text-xs text-base-content/50">
                  Un client inactif reste consultable avec son historique, mais n&apos;apparaît plus
                  dans la liste par défaut.
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
              'Créer le client'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Détail — statistiques, produits les plus achetés, dernières factures
 * ------------------------------------------------------------------ */

export function CustomerDetailModal({
  isOpen,
  onClose,
  stats,
  isLoading,
  error,
  onRetry,
  onEdit,
}: {
  isOpen: boolean;
  onClose: () => void;
  stats: CustomerStatsRecord | null;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onEdit?: () => void;
}) {
  const customer = stats?.customer ?? null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Détail du client"
      size="xl"
      fullScreenMobile
    >
      <div className="space-y-5 pb-2">
        {isLoading && <SkeletonTable rows={5} cols={4} />}

        {!isLoading && error && (
          <div className="rounded-xl border border-error/30 bg-error/10 p-4 text-sm text-error">
            <p>{error}</p>
            <button type="button" className="btn btn-sm btn-error mt-3" onClick={onRetry}>
              Réessayer
            </button>
          </div>
        )}

        {!isLoading && !error && stats && customer && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="truncate text-lg font-semibold">{customer.name}</h4>
                <p className="text-sm text-base-content/60">
                  {customer.phone || 'Téléphone non renseigné'}
                  {customer.address ? ` · ${customer.address}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {customer.isActive ? (
                  <Badge tone="success">Actif</Badge>
                ) : (
                  <Badge tone="neutral">Inactif</Badge>
                )}
                {stats.creditLimitExceeded && <Badge tone="warning">Plafond dépassé</Badge>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat
                label="Solde"
                tone={stats.balance > 0.001 ? 'error' : 'success'}
                value={<MoneyText value={stats.balance} colored bold />}
              />
              <MiniStat label="Total facturé" value={<MoneyText value={stats.totalInvoiced} />} />
              <MiniStat label="Total payé" value={<MoneyText value={stats.totalPaid} />} />
              <MiniStat
                label="Panier moyen"
                value={<MoneyText value={stats.averageBasket} />}
              />
            </div>

            <Card className="space-y-1 py-2" padded={false}>
              <div className="px-1">
                <InfoRow label="Nombre de factures">
                  <span className="tabular">{formatNumber(stats.invoiceCount)}</span>
                </InfoRow>
                <InfoRow label="Plafond de crédit">
                  {customer.creditLimit > 0 ? (
                    <MoneyText value={customer.creditLimit} />
                  ) : (
                    'Aucun plafond'
                  )}
                </InfoRow>
                <InfoRow label="Premier achat">{formatDateShort(stats.firstPurchaseDate)}</InfoRow>
                <InfoRow label="Dernier achat">{formatDateShort(stats.lastPurchaseDate)}</InfoRow>
                <InfoRow label="Créé le">{formatDateShort(customer.createdAt)}</InfoRow>
                <InfoRow label="NIF / informations">
                  <span className="font-normal text-base-content/70">
                    {customer.notes || '—'}
                  </span>
                </InfoRow>
              </div>
            </Card>

            {stats.creditLimitExceeded && (
              <p className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                Le solde dépasse le plafond de crédit autorisé. Vente possible : l&apos;application
                avertit, elle ne bloque pas.
              </p>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card padded={false} className="overflow-hidden">
                <div className="border-b border-base-200 bg-base-200/60 px-4 py-2.5">
                  <h5 className="text-sm font-semibold">Produits les plus achetés</h5>
                </div>
                {stats.topProducts.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-base-content/50">
                    Aucun achat enregistré pour ce client.
                  </p>
                ) : (
                  <ul className="divide-y divide-base-200">
                    {stats.topProducts.map((product) => (
                      <li
                        key={product.productName}
                        className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                      >
                        <span className="min-w-0 truncate">{product.productName}</span>
                        <span className="flex shrink-0 items-center gap-3">
                          <span className="tabular text-base-content/60">
                            {formatNumber(product.quantity, 0)}
                          </span>
                          <MoneyText value={product.amount} bold />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card padded={false} className="overflow-hidden">
                <div className="flex items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-2.5">
                  <h5 className="text-sm font-semibold">Dernières factures</h5>
                  <Link
                    href={`/clients/${customer.id}`}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Voir la fiche
                  </Link>
                </div>
                {stats.recentInvoices.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-base-content/50">
                    Aucune facture pour ce client.
                  </p>
                ) : (
                  <ul className="divide-y divide-base-200">
                    {stats.recentInvoices.map((invoice) => (
                      <li key={invoice.id}>
                        <Link
                          href={`/ventes/${invoice.id}`}
                          className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-base-200"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {invoice.invoiceNumber}
                            </span>
                            <span className="block text-xs text-base-content/50">
                              {formatDateShort(invoice.date)}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-3">
                            <span className="text-right">
                              <MoneyText value={invoice.total} bold />
                              {invoice.remainingAmount > 0.001 && (
                                <span className="block text-xs text-error">
                                  Reste <MoneyText value={invoice.remainingAmount} />
                                </span>
                              )}
                            </span>
                            <StatusBadge status={invoice.paymentStatus} kind="payment" />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        )}

        <div className="sticky bottom-0 flex justify-end gap-3 border-t border-base-200 bg-base-100 pb-1 pt-4">
          <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" onClick={onClose}>
            Fermer
          </button>
          {customer && (
            <>
              <Link
                href={`/clients/${customer.id}/paiements`}
                className="btn btn-outline min-h-11 sm:min-h-0"
              >
                Historique des paiements
              </Link>
              {onEdit && (
                <button
                  type="button"
                  className="btn btn-primary min-h-11 sm:min-h-0"
                  onClick={onEdit}
                >
                  Modifier
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Encaissement
 * ------------------------------------------------------------------ */

export function PaymentModal({
  isOpen,
  onClose,
  customer,
  onRecorded,
  /**
   * Contexte « facture déjà choisie » : depuis l'historique d'un client, la
   * facture reste à sélectionner ; depuis une facture, elle est imposée et le
   * sélecteur disparaît.
   */
  fetchInvoices = true,
}: {
  isOpen: boolean;
  onClose: () => void;
  customer: { id: number; name: string; balance: number };
  onRecorded: (payment: { id: number; receiptNumber: string; amount: number }) => void;
  fetchInvoices?: boolean;
}) {
  const { settings } = useSettings();
  const canCreate = usePermission('payments.create');

  const [invoicesState, setInvoicesState] = useState<UnpaidInvoicesState>(null);
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Espèces');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<{ id: number; receiptNumber: string } | null>(null);

  const paymentMethods = useMemo(() => {
    const configured = settings.paymentMethods?.filter((method) => Boolean(method?.trim())) ?? [];
    return configured.length > 0 ? configured : ['Espèces', 'Mobile Money', 'Virement', 'Crédit'];
  }, [settings.paymentMethods]);

  useEffect(() => {
    if (!isOpen) return;

    setInvoiceId(null);
    setAmount('');
    setNotes('');
    setDate(today());
    setAmountError(null);
    setReceipt(null);
    setIsSubmitting(false);
    setPaymentMethod(
      settings.paymentMethods?.some((method) => method.toLowerCase() === 'espèces')
        ? 'Espèces'
        : (settings.paymentMethods?.[0] ?? 'Espèces'),
    );

    if (!fetchInvoices) {
      setInvoicesState([]);
      return;
    }

    const controller = new AbortController();
    setInvoicesState(null);

    void (async () => {
      try {
        const result = await fetchUnpaidInvoices(customer.id, controller.signal);
        setInvoicesState(result);
        if (Array.isArray(result) && result.length > 0) {
          setInvoiceId(result[0].id);
          setAmount(String(result[0].remainingAmount));
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        setInvoicesState('Les factures du client n’ont pas pu être chargées.');
      }
    })();

    return () => controller.abort();
    // `customer.id` suffit : le client affiché ne change pas sans fermeture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, customer.id, fetchInvoices]);

  const unpaidInvoices = Array.isArray(invoicesState) ? invoicesState : [];
  const selectedInvoice = unpaidInvoices.find((invoice) => invoice.id === invoiceId) ?? null;

  const selectInvoice = (id: number) => {
    setInvoiceId(id);
    const invoice = unpaidInvoices.find((entry) => entry.id === id);
    if (invoice) {
      setAmount(String(invoice.remainingAmount));
      setAmountError(null);
    }
  };

  const submit = async () => {
    const value = Number(amount);

    if (!selectedInvoice) {
      setAmountError('Sélectionnez la facture à régler.');
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      setAmountError('Le montant doit être supérieur à zéro.');
      return;
    }
    if (value > selectedInvoice.remainingAmount + 0.01) {
      setAmountError(
        `Le montant dépasse le reste à payer (${formatNumber(selectedInvoice.remainingAmount)} GNF).`,
      );
      return;
    }
    if (!date) {
      setAmountError("La date d'encaissement est obligatoire.");
      return;
    }

    setAmountError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/paiements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          type: 'sale',
          referenceId: selectedInvoice.id,
          amount: value,
          paymentMethod,
          date,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Le paiement n'a pas pu être enregistré."));
      }

      const payment = (await response.json()) as {
        id: number;
        receiptNumber: string;
        amount: number;
      };

      setReceipt({ id: payment.id, receiptNumber: payment.receiptNumber });
      onRecorded(payment);
    } catch (error) {
      setAmountError(
        error instanceof Error ? error.message : "Le paiement n'a pas pu être enregistré.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const salesRouteMissing = invoicesState === SALES_ROUTE_UNAVAILABLE;
  const invoicesFailed = typeof invoicesState === 'string' && invoicesState !== SALES_ROUTE_UNAVAILABLE;
  const isLoadingInvoices = invoicesState === null;
  const canSubmit = canCreate && (salesRouteMissing ? false : Boolean(selectedInvoice)) && !receipt;

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
            <p className="truncate text-sm font-semibold">{customer.name}</p>
            <p className="text-xs text-base-content/60">Solde actuel</p>
          </div>
          <MoneyText value={customer.balance} colored bold className="text-lg" />
        </div>

        {receipt ? (
          <div className="space-y-3 rounded-xl border border-success/30 bg-success/10 p-4">
            <p className="text-sm font-medium text-success">
              Paiement enregistré — reçu {receipt.receiptNumber}.
            </p>
            <Link href={`/recus/${receipt.id}`} className="btn btn-success btn-sm">
              Voir le reçu
            </Link>
          </div>
        ) : (
          <>
            <FormField
              label="Facture à régler"
              htmlFor="payment-invoice"
              required
              hint={
                selectedInvoice
                  ? `Reste à payer : ${formatNumber(selectedInvoice.remainingAmount)} GNF`
                  : 'Seules les factures impayées du client sont proposées.'
              }
            >
              {isLoadingInvoices ? (
                <div className="skeleton h-11 w-full rounded-lg sm:h-10" />
              ) : salesRouteMissing ? (
                <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2.5 text-sm text-info">
                  Le module Ventes n&apos;est pas encore disponible sur ce poste : impossible de
                  choisir une facture. L&apos;encaissement sera possible dès sa mise en service.
                </p>
              ) : invoicesFailed ? (
                <p className="rounded-xl border border-error/30 bg-error/10 px-3 py-2.5 text-sm text-error">
                  {invoicesState as string}
                </p>
              ) : unpaidInvoices.length === 0 ? (
                <p className="rounded-xl border border-base-200 bg-base-200/50 px-3 py-2.5 text-sm text-base-content/60">
                  Ce client n&apos;a aucune facture impayée.
                </p>
              ) : (
                <select
                  id="payment-invoice"
                  className="select select-bordered min-h-11 w-full sm:min-h-0"
                  value={invoiceId ?? ''}
                  onChange={(event) => selectInvoice(Number(event.target.value))}
                >
                  <option value="">Sélectionner une facture…</option>
                  {unpaidInvoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {`${invoice.invoiceNumber} — ${formatDateShort(invoice.date)} — reste ${formatNumber(invoice.remainingAmount)} GNF`}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Montant reçu (GNF)" htmlFor="payment-amount" required error={amountError}>
                <input
                  id="payment-amount"
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

              <FormField label="Moyen de paiement" htmlFor="payment-method" required>
                <select
                  id="payment-method"
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

              <FormField label="Date d'encaissement" htmlFor="payment-date" required>
                <DatePicker value={date} onChange={setDate} placeholder="jj/mm/aaaa" />
              </FormField>

              <FormField label="Note" htmlFor="payment-notes" hint="Facultatif.">
                <input
                  id="payment-notes"
                  type="text"
                  className="input input-bordered min-h-11 w-full sm:min-h-0"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Ex. acompte du client"
                  autoComplete="off"
                />
              </FormField>
            </div>
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
              disabled={isSubmitting || !canSubmit}
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
 * 4. Désactivation (jamais une suppression physique, §7)
 * ------------------------------------------------------------------ */

export function DeactivateCustomerDialog({
  isOpen,
  onClose,
  onConfirm,
  customer,
  isSubmitting,
  renderConfirm,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  customer: CustomerRecord | null;
  isSubmitting: boolean;
  /** Permet à l'appelant d'ajouter un bouton d'action dans la confirmation. */
  renderConfirm?: ReactNode;
}) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Désactiver le client"
      tone="warning"
      confirmLabel="Désactiver"
      isSubmitting={isSubmitting}
      message={
        <>
          <strong>{customer?.name ?? 'Ce client'}</strong> sera désactivé : il n&apos;apparaîtra plus
          dans la liste par défaut.
          <br />
          <span className="text-sm">
            Aucune donnée n&apos;est supprimée — l&apos;historique des factures et des paiements reste
            consultable, et la fiche peut être réactivée.
          </span>
          {customer && customer.balance > 0.001 && (
            <span className="mt-2 block rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-warning">
              Attention : ce client présente encore un solde de{' '}
              {formatNumber(customer.balance)} GNF.
            </span>
          )}
        </>
      }
    >
      {renderConfirm}
    </ConfirmDialog>
  );
}
