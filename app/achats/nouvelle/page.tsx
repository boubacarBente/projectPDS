'use client';

/**
 * Saisie d'un achat (README §7.5, §14).
 *
 * Modèle exact de `app/ventes/nouvelle/page.tsx`, avec les différences
 * imposées par le métier :
 *  - **fournisseur obligatoire** (§14 : contrairement à une dépense) ;
 *  - **prix d'achat** et non prix de vente — reposé automatiquement au
 *    changement de produit depuis `products.purchase_price` ;
 *  - **pas de remise, pas de TVA** : `purchase_invoices` ne porte qu'un `total`
 *    et `purchase_invoice_items` n'a pas de colonne `discount` (§6.3) ;
 *  - **pas de brouillon** : un achat est un document validé (`active`), il fait
 *    entrer le stock immédiatement ;
 *  - le **stock actuel** de chaque produit est affiché : il va **augmenter**
 *    (un achat n'est jamais refusé pour cause de rupture — §12).
 *
 * Le formulaire sert aussi à la **modification** : `/achats/nouvelle?edit=<id>`
 * (le module n'alloue pas de seconde page pour un formulaire identique). Dans ce
 * cas, `PUT /api/achats/[id]` ajuste le stock **par différence** par produit, et
 * un `amountPaid` inférieur au déjà-payé est refusé par le serveur : on ne
 * supprime jamais un décaissement, on annule l'achat.
 *
 * Le tableau de lignes est l'**unique exception balisée** au contrat 360 px
 * (§5.5 règle 1) : il défile horizontalement (`data-entry-table`, `overflow-x-auto`).
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  Card,
  ErrorState,
  FormField,
  InfoRow,
  MiniStat,
  MoneyText,
  SkeletonTable,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useSettings } from '@/app/parametres/page';
import { readApiError } from '@/components/achats/achats-modals';
import { formatCurrency, formatNumber, formatQuantity, today } from '@/lib/format';

type Product = {
  id: number;
  name: string;
  unit: string;
  purchasePrice: number;
  stock: number;
};

type Line = {
  /** Identifiant de ligne purement local (clé React stable). */
  key: string;
  productId: string;
  quantity: string;
  /** **Prix d'achat** unitaire (et non prix de vente). */
  unitPrice: string;
};

type SupplierOption = {
  id: number;
  name: string;
  phone: string | null;
};

type ComputedLine = {
  quantity: number;
  unitPrice: number;
  total: number;
};

const DEFAULT_PAYMENT_METHODS = ['Espèces', 'Mobile Money', 'Virement', 'Crédit'];

function newLine(): Line {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productId: '',
    quantity: '1',
    unitPrice: '',
  };
}

/** Montant saisi → nombre ; `''` vaut 0, une valeur non numérique aussi. */
function toAmount(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function computeLine(line: Line): ComputedLine {
  const quantity = toAmount(line.quantity);
  const unitPrice = toAmount(line.unitPrice);
  return { quantity, unitPrice, total: quantity * unitPrice };
}

function AchatsNouvelleContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { settings } = useSettings();
  const canCreate = usePermission('purchases.create');
  const canUpdate = usePermission('purchases.update');

  const editId = Number(searchParams.get('edit') ?? 0);
  const isEditing = Number.isInteger(editId) && editId > 0;

  const [products, setProducts] = useState<Product[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [supplierReference, setSupplierReference] = useState('');
  const [date, setDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Espèces');
  const [amountPaid, setAmountPaid] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  // Le montant payé suit le total tant que l'utilisateur n'y a pas touché : le
  // formulaire s'ouvre « payé », on repasse à un acompte à la main.
  const amountTouchedRef = useRef(false);
  const previousTotalRef = useRef(0);
  const initializedRef = useRef(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setIsLoading(true);
      setLoadError(null);

      try {
        const requests: Promise<Response>[] = [
          fetch('/api/produits?limit=500', {
            cache: 'no-store',
            credentials: 'same-origin',
            signal,
          }),
          fetch('/api/fournisseurs?limit=500', {
            cache: 'no-store',
            credentials: 'same-origin',
            signal,
          }).catch(() => null as unknown as Response),
        ];

        if (isEditing) {
          requests.push(
            fetch(`/api/achats/${editId}`, {
              cache: 'no-store',
              credentials: 'same-origin',
              signal,
            }),
          );
        }

        const [productsResponse, suppliersResponse, invoiceResponse] = await Promise.all(requests);

        if (!productsResponse.ok) {
          throw new Error(
            await readApiError(productsResponse, 'Le catalogue produits n’a pas pu être chargé.'),
          );
        }

        const productsPayload = (await productsResponse.json()) as { data?: unknown[] };
        const catalogue: Product[] = (Array.isArray(productsPayload.data) ? productsPayload.data : [])
          .map((raw) => {
            const row = (raw ?? {}) as Record<string, unknown>;
            return {
              id: Number(row.id ?? 0),
              name: String(row.name ?? ''),
              unit: String(row.unit ?? 'pièce'),
              // C'est bien le **prix d'achat** qui est reposé ici (§7.5).
              purchasePrice: Number(row.purchasePrice ?? row.purchase_price ?? 0) || 0,
              stock: Number(row.stock ?? 0) || 0,
            };
          })
          .filter((product) => product.id > 0);

        setProducts(catalogue);

        if (suppliersResponse && suppliersResponse.ok) {
          const suppliersPayload = (await suppliersResponse.json()) as { data?: unknown[] };
          setSuppliers(
            (Array.isArray(suppliersPayload.data) ? suppliersPayload.data : [])
              .map((raw) => {
                const row = (raw ?? {}) as Record<string, unknown>;
                return {
                  id: Number(row.id ?? 0),
                  name: String(row.name ?? ''),
                  phone: (row.phone ?? null) as string | null,
                };
              })
              .filter((supplier) => supplier.id > 0),
          );
        }

        // ── Modification : on préremplit depuis la facture existante ──────
        if (isEditing && invoiceResponse) {
          if (invoiceResponse.status === 404) {
            throw new Error('Achat introuvable.');
          }
          if (!invoiceResponse.ok) {
            throw new Error(await readApiError(invoiceResponse, 'L’achat n’a pas pu être chargé.'));
          }

          const payload = (await invoiceResponse.json()) as {
            invoice?: Record<string, unknown>;
            items?: Record<string, unknown>[];
          };
          const invoice = payload.invoice ?? {};
          const rawItems = Array.isArray(payload.items) ? payload.items : [];

          if (String(invoice.status ?? 'active') === 'cancelled') {
            throw new Error('Un achat annulé ne peut pas être modifié.');
          }

          setSupplierId(invoice.supplierId == null ? '' : String(invoice.supplierId));
          setSupplierReference(
            String(invoice.supplierReference ?? invoice.supplier_reference ?? '') || '',
          );
          setDate(String(invoice.date ?? today()));
          setDueDate(String(invoice.dueDate ?? invoice.due_date ?? '') || '');
          setPaymentMethod(String(invoice.paymentMethod ?? invoice.payment_method ?? 'Espèces'));
          setAmountPaid(
            Number(invoice.amountPaid ?? invoice.amount_paid ?? 0) > 0
              ? String(Number(invoice.amountPaid ?? invoice.amount_paid ?? 0))
              : '',
          );
          setNotes(String(invoice.notes ?? '') || '');

          // Le montant est repris tel quel : on ne veut PAS qu'il se recale sur
          // le total recalculé pendant l'édition.
          amountTouchedRef.current = true;
          initializedRef.current = true;

          const nextLines: Line[] = rawItems.map((raw, index) => ({
            key: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
            productId:
              raw.productId == null && raw.product_id == null
                ? ''
                : String(raw.productId ?? raw.product_id),
            quantity: String(Number(raw.quantity ?? 0) || 0),
            unitPrice: String(Number(raw.unitPrice ?? raw.unit_price ?? 0) || 0),
          }));

          setLines(nextLines.length > 0 ? nextLines : [newLine()]);
        }
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setLoadError(
          caught instanceof Error ? caught.message : 'Le catalogue produits n’a pas pu être chargé.',
        );
      } finally {
        if (!signal.aborted) setIsLoading(false);
      }
    },
    [editId, isEditing],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    // Annulation propre au démontage : pas de « réponse du passé » (§5).
    return () => controller.abort();
  }, [load]);

  /* En création seulement : première ligne préremplie avec le premier produit
     et son **prix d'achat**. En modification, les lignes viennent du serveur. */
  useEffect(() => {
    if (initializedRef.current) return;
    if (isEditing) return;
    if (products.length === 0) return;

    initializedRef.current = true;
    const first = products[0];
    setLines((current) =>
      current.map((line, index) =>
        index === 0
          ? { ...line, productId: String(first.id), unitPrice: String(first.purchasePrice) }
          : line,
      ),
    );
  }, [products, isEditing]);

  const paymentMethods = useMemo(() => {
    const configured = settings.paymentMethods?.filter((method) => Boolean(method?.trim())) ?? [];
    return configured.length > 0 ? configured : DEFAULT_PAYMENT_METHODS;
  }, [settings.paymentMethods]);

  const productById = useMemo(() => {
    const map = new Map<number, Product>();
    products.forEach((product) => map.set(product.id, product));
    return map;
  }, [products]);

  const computedLines = useMemo(() => lines.map(computeLine), [lines]);

  const totals = useMemo(() => {
    const total = computedLines.reduce((sum, line) => sum + line.total, 0);
    const paid = Math.max(toAmount(amountPaid), 0);
    const remaining = Math.max(total - paid, 0);

    return { total, paid, remaining };
  }, [computedLines, amountPaid]);

  const paymentStatus = useMemo(() => {
    if (totals.paid <= 0) return { key: 'unpaid', label: 'À payer', tone: 'error' as const };
    if (totals.remaining > 0.001) return { key: 'partial', label: 'Partiel', tone: 'warning' as const };
    return { key: 'paid', label: 'Payé', tone: 'success' as const };
  }, [totals.paid, totals.remaining]);

  /* Le montant payé suit le total tant qu'il n'a pas été saisi à la main. */
  useEffect(() => {
    if (amountTouchedRef.current) return;
    const previous = previousTotalRef.current;
    if (previous > 0 && Math.abs(toAmount(amountPaid) - previous) > 0.001) return;

    const next = totals.total > 0 ? String(Math.round(totals.total * 100) / 100) : '';
    setAmountPaid((current) => (current === next ? current : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totals.total]);

  useEffect(() => {
    previousTotalRef.current = totals.total;
  }, [totals.total]);

  const addLine = () => setLines((current) => [...current, newLine()]);

  const removeLine = (key: string) =>
    setLines((current) =>
      current.length <= 1 ? current : current.filter((line) => line.key !== key),
    );

  /**
   * Repose automatiquement le **prix d'achat** du produit (modifiable ensuite).
   * Un achat se saisit au prix du fournisseur, jamais au prix de revente.
   */
  const handleProductChange = (key: string, productId: string) => {
    const product = productById.get(Number(productId));
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? { ...line, productId, unitPrice: product ? String(product.purchasePrice) : '' }
          : line,
      ),
    );
  };

  const setLineField = (key: string, field: 'quantity' | 'unitPrice', value: string) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, [field]: value } : line)),
    );
  };

  const selectedSupplier = supplierId
    ? (suppliers.find((supplier) => supplier.id === Number(supplierId)) ?? null)
    : null;

  const buildPayloadLines = () =>
    lines
      .map((line, index) => {
        const computed = computedLines[index];
        return {
          productId: Number(line.productId),
          quantity: computed.quantity,
          unitPrice: computed.unitPrice,
        };
      })
      .filter((line) => line.productId > 0 && line.quantity > 0);

  const submit = async () => {
    if (isEditing ? !canUpdate : !canCreate) {
      toast.error(
        isEditing
          ? 'Vous n’avez pas la permission de modifier un achat.'
          : 'Vous n’avez pas la permission de créer un achat.',
      );
      return;
    }
    // Le fournisseur est **obligatoire** (§14) : c'est la différence structurante
    // avec une dépense, où il est optionnel.
    if (!supplierId) {
      setFormError('Le fournisseur est obligatoire pour un achat.');
      return;
    }
    if (buildPayloadLines().length === 0) {
      setFormError('Chaque ligne doit porter un produit et une quantité supérieure à zéro.');
      return;
    }
    if (lines.some((line) => line.productId && toAmount(line.quantity) <= 0)) {
      setFormError('Une quantité nulle ou négative a été saisie sur une ligne.');
      return;
    }
    if (!date) {
      setFormError("La date de l'achat est obligatoire.");
      return;
    }
    if (dueDate && dueDate < date) {
      setFormError("L'échéance ne peut pas précéder la date de l'achat.");
      return;
    }
    if (totals.paid > totals.total + 0.01) {
      setFormError(
        `Le montant payé ne peut pas dépasser le total de l’achat (${formatNumber(totals.total)} GNF).`,
      );
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(isEditing ? `/api/achats/${editId}` : '/api/achats', {
        method: isEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          supplierId: Number(supplierId),
          supplierReference: supplierReference.trim() || null,
          date,
          dueDate: dueDate || null,
          paymentMethod,
          amountPaid: totals.paid,
          notes: notes.trim() || null,
          status: 'active',
          lines: buildPayloadLines(),
        }),
      });

      if (!response.ok) {
        // Le message du serveur doit rester lisible : un refus de stock
        // (« Stock insuffisant : … ») ou un motif de règlement ne tient pas en
        // 4 secondes.
        toast.error(
          await readApiError(
            response,
            isEditing ? "L’achat n’a pas pu être modifié." : "L’achat n’a pas pu être enregistré.",
          ),
          { autoClose: 8000 },
        );
        return;
      }

      const payload = (await response.json()) as { invoice?: { reference?: string } };
      const reference = payload.invoice?.reference;

      toast.success(
        isEditing
          ? `Achat ${reference ?? ''} modifié.`
          : `Achat ${reference ?? ''} enregistré — stock augmenté.`,
      );
      router.push('/achats');
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "L’achat n’a pas pu être enregistré (connexion indisponible).",
        { autoClose: 8000 },
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const currency = settings.currency || 'GNF';

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Commercial"
        title={isEditing ? 'Modifier un achat' : 'Nouvel achat'}
        description="Marchandises achetées, prix d’achat, entrée en stock immédiate et règlement fournisseur (comptant, acompte ou à crédit)."
      />

      {loadError ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Impossible de préparer l’achat"
            description={loadError}
            onRetry={() => {
              const controller = new AbortController();
              void load(controller.signal);
            }}
          />
        </div>
      ) : isLoading ? (
        <SkeletonTable rows={5} cols={5} />
      ) : products.length === 0 ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Aucun produit au catalogue"
            description="Créez au moins un produit actif avant d’enregistrer un achat."
            onRetry={() => router.push('/produits')}
            retryLabel="Aller au catalogue"
          />
        </div>
      ) : suppliers.length === 0 ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Aucun fournisseur enregistré"
            description="Un achat exige un fournisseur : créez d’abord sa fiche (contrairement à une dépense, où il est optionnel)."
            onRetry={() => router.push('/fournisseurs')}
            retryLabel="Aller aux fournisseurs"
          />
        </div>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <Card padded={false} className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-3">
                  <h2 className="text-sm font-semibold">Marchandises achetées</h2>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline min-h-11 sm:min-h-0"
                    onClick={addLine}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    Ajouter une ligne
                  </button>
                </div>

                {/* Conteneur à défilement horizontal : le tableau de saisie est
                    l'unique exception balisée au contrat 360 px (§5.5 règle 1). */}
                <div className="w-full overflow-x-auto" data-entry-table="achat">
                  <table className="table table-xs w-full min-w-[42rem]">
                    <thead>
                      <tr className="bg-base-200">
                        <th className="min-w-[16rem] text-left">Produit</th>
                        <th className="w-24 text-right">Qté</th>
                        <th className="w-32 text-right">Prix d&apos;achat</th>
                        <th className="w-32 text-right">Total</th>
                        <th className="w-12 text-right">
                          <span className="sr-only">Supprimer</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, index) => {
                        const product = productById.get(Number(line.productId));
                        const computed = computedLines[index];
                        const projectedStock = product ? product.stock + computed.quantity : 0;

                        return (
                          <tr key={line.key} className="align-top">
                            <td>
                              <select
                                className="select select-bordered select-sm h-11 w-full sm:h-9"
                                value={line.productId}
                                onChange={(event) => handleProductChange(line.key, event.target.value)}
                                aria-label={`Produit de la ligne ${index + 1}`}
                              >
                                <option value="">Sélectionner un produit…</option>
                                {products.map((entry) => (
                                  <option key={entry.id} value={entry.id}>
                                    {entry.name} ({formatNumber(entry.purchasePrice)} GNF)
                                  </option>
                                ))}
                              </select>
                              {product && (
                                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/60">
                                  {/* Le stock va **augmenter** : on montre l'état
                                      actuel puis l'état après cet achat. */}
                                  <span className="tabular">
                                    Stock actuel : {formatQuantity(product.stock, product.unit)}
                                  </span>
                                  {computed.quantity > 0 && (
                                    <Badge tone="success">
                                      Après achat : {formatQuantity(projectedStock, product.unit)}
                                    </Badge>
                                  )}
                                </span>
                              )}
                            </td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                step="any"
                                inputMode="decimal"
                                className="input input-bordered input-sm h-11 w-full text-right tabular sm:h-9"
                                value={line.quantity}
                                onChange={(event) =>
                                  setLineField(line.key, 'quantity', event.target.value)
                                }
                                aria-label={`Quantité de la ligne ${index + 1}`}
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                step={1000}
                                inputMode="decimal"
                                className="input input-bordered input-sm h-11 w-full text-right tabular sm:h-9"
                                value={line.unitPrice}
                                onChange={(event) =>
                                  setLineField(line.key, 'unitPrice', event.target.value)
                                }
                                aria-label={`Prix d'achat de la ligne ${index + 1}`}
                              />
                            </td>
                            <td className="text-right">
                              <MoneyText value={computed.total} className="text-sm" />
                            </td>
                            <td className="text-right">
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm btn-square text-error"
                                onClick={() => removeLine(line.key)}
                                disabled={lines.length <= 1}
                                title={
                                  lines.length <= 1
                                    ? 'Un achat doit conserver au moins une ligne'
                                    : 'Supprimer cette ligne'
                                }
                                aria-label={`Supprimer la ligne ${index + 1}`}
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  className="h-4 w-4"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  strokeWidth={2}
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                  />
                                </svg>
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3} className="text-right text-sm font-semibold">
                          Total général
                        </td>
                        <td className="text-right">
                          <MoneyText value={totals.total} bold />
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>

              <div className="rounded-xl border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success">
                <p className="font-semibold">Le stock augmentera à l&apos;enregistrement</p>
                <p className="mt-1 text-xs">
                  Chaque ligne crée une <strong>entrée</strong> de stock motivée « achat … ». Un
                  achat n&apos;est jamais refusé pour cause de rupture : il fait entrer la
                  marchandise. Les frais de fonctionnement (transport, loyer…) sont des{' '}
                  <strong>dépenses</strong>, pas des achats — ils ne touchent pas le stock.
                </p>
              </div>

              <Card>
                <FormField
                  label="Notes"
                  htmlFor="purchase-notes"
                  hint="Conditions d’achat, mention d’une remise fournisseur négociée, référence de commande…"
                >
                  <textarea
                    id="purchase-notes"
                    rows={2}
                    className="textarea textarea-bordered w-full"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Note interne facultative"
                  />
                </FormField>
              </Card>
            </div>

            <div className="space-y-4">
              <Card className="space-y-4">
                <h2 className="text-sm font-semibold">Fournisseur</h2>

                <FormField
                  label="Fournisseur"
                  htmlFor="purchase-supplier"
                  required
                  hint="Obligatoire : c’est la dette fournisseur qui est suivie (§15)."
                >
                  <select
                    id="purchase-supplier"
                    className="select select-bordered min-h-11 w-full sm:min-h-0"
                    value={supplierId}
                    onChange={(event) => setSupplierId(event.target.value)}
                  >
                    <option value="">Sélectionner un fournisseur…</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                  </select>
                </FormField>

                {selectedSupplier && (
                  <div className="rounded-xl border border-base-200 bg-base-200/50 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-base-content/60">Fournisseur</span>
                      <span className="min-w-0 truncate font-medium">{selectedSupplier.name}</span>
                    </div>
                    {selectedSupplier.phone ? (
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="text-base-content/60">Téléphone</span>
                        <span className="tabular font-medium">{selectedSupplier.phone}</span>
                      </div>
                    ) : null}
                  </div>
                )}

                <FormField
                  label="Référence fournisseur"
                  htmlFor="purchase-supplier-reference"
                  hint="Numéro de la facture du fournisseur (facultatif)."
                >
                  <input
                    id="purchase-supplier-reference"
                    type="text"
                    className="input input-bordered min-h-11 w-full sm:min-h-0"
                    value={supplierReference}
                    onChange={(event) => setSupplierReference(event.target.value)}
                    placeholder="Ex. FA-2026-0142"
                    autoComplete="off"
                  />
                </FormField>
              </Card>

              <Card className="space-y-4">
                <h2 className="text-sm font-semibold">Règlement</h2>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
                  <FormField label="Date de l’achat" htmlFor="purchase-date" required>
                    <DatePicker value={date} onChange={setDate} placeholder="jj/mm/aaaa" />
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

                  <FormField
                    label="Montant payé (GNF)"
                    htmlFor="purchase-amount-paid"
                    hint={
                      isEditing
                        ? 'Ne peut pas être réduit : annulez l’achat pour contre-passer la caisse.'
                        : '0 = achat à crédit (dette fournisseur).'
                    }
                  >
                    <input
                      id="purchase-amount-paid"
                      type="number"
                      min={0}
                      step={1000}
                      inputMode="decimal"
                      className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
                      value={amountPaid}
                      onChange={(event) => {
                        amountTouchedRef.current = true;
                        setAmountPaid(event.target.value);
                      }}
                      placeholder="0"
                    />
                  </FormField>

                  {totals.paid < totals.total - 0.001 && (
                    <FormField
                      label="Échéance"
                      htmlFor="purchase-due-date"
                      hint="Achat à crédit : date promise de règlement au fournisseur."
                    >
                      <DatePicker value={dueDate} onChange={setDueDate} placeholder="jj/mm/aaaa" />
                    </FormField>
                  )}
                </div>

                {totals.paid < totals.total - 0.001 && (
                  <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                    Il restera <strong>{formatCurrency(totals.remaining, currency)}</strong> à régler :
                    l&apos;achat alimente la <strong>dette fournisseur</strong>, suivie dans la fiche
                    du fournisseur et dans la liste des achats.
                  </div>
                )}
              </Card>

              <Card className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">Totaux</h2>
                  <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                </div>

                <div className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-primary">Total de l&apos;achat</span>
                    <MoneyText value={totals.total} bold className="text-primary" />
                  </div>
                </div>

                <InfoRow label="Lignes">
                  <span className="tabular">{formatNumber(buildPayloadLines().length)}</span>
                </InfoRow>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <MiniStat
                    label="Payé"
                    tone={totals.paid > 0 ? 'success' : 'neutral'}
                    value={<MoneyText value={totals.paid} />}
                  />
                  <MiniStat
                    label="Reste à payer"
                    tone={totals.remaining > 0.001 ? 'error' : 'success'}
                    value={<MoneyText value={totals.remaining} colored bold />}
                  />
                </div>
              </Card>

              {formError && (
                <p
                  role="alert"
                  className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
                >
                  {formError}
                </p>
              )}
            </div>
          </div>

          {/* Pied d'actions collant : « Enregistrer » reste atteignable sur un
              long formulaire mobile (§5.5 règle 4). */}
          <div className="sticky bottom-0 z-20 -mx-2 flex flex-wrap items-center justify-between gap-3 border-t border-base-200 bg-base-100/95 px-2 py-3 backdrop-blur-sm">
            <div className="min-w-0">
              <p className="text-xs text-base-content/50">Total de l&apos;achat</p>
              <MoneyText value={totals.total} bold className="text-lg" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-ghost min-h-11 sm:min-h-0"
                onClick={() => router.push('/achats')}
                disabled={isSubmitting}
              >
                Annuler
              </button>
              <button
                type="submit"
                className="btn btn-primary min-h-11 sm:min-h-0"
                disabled={isSubmitting || (isEditing ? !canUpdate : !canCreate)}
              >
                {isSubmitting ? (
                  <span className="loading loading-spinner loading-sm" />
                ) : isEditing ? (
                  'Enregistrer les modifications'
                ) : (
                  'Enregistrer l’achat'
                )}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * `useSearchParams` impose une frontière `Suspense` (Next.js 16) : sans elle, la
 * page ne peut pas être prérendue statiquement. L'enveloppe ne change rien au
 * rendu, elle évite seulement l'erreur de build.
 */
export default function NouvelAchatPage() {
  return (
    <Suspense fallback={<SkeletonTable rows={5} cols={5} />}>
      <AchatsNouvelleContent />
    </Suspense>
  );
}
