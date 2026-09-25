'use client';

/**
 * Création d'une vente — README §10.2 à §10.5.
 *
 * Reprise **exacte** de la structure du projet Gaz :
 *   - produits chargés via `GET /api/produits?limit=500` avec `AbortController` ;
 *   - première ligne **préremplie** avec le premier produit et son prix de vente ;
 *   - changement de produit → le prix de vente est reposé automatiquement, mais
 *     reste modifiable (remise négociée) ;
 *   - tableau de saisie `table table-xs` : Produit · Qté · Prix unit. · Remise ·
 *     Total · (supprimer), avec pied **Total général** ;
 *   - calculs (§10.3) et statut de paiement (§10.4) affichés en direct.
 *
 * Ce tableau est le **seul** `<table>` écrit à la main autorisé (README §10.2,
 * CONVENTIONS §7) : il est balisé `data-entry-table` et son conteneur porte le
 * défilement horizontal — c'est la seule exception admise au contrat 360 px.
 *
 * Le serveur reste **seul juge** du stock : un dépassement est signalé ici, mais
 * n'empêche pas la soumission ; son erreur agrégée (liste de tous les produits en
 * rupture) est affichée en `toast.error` avec `{ autoClose: 8000 }`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { readApiError } from '@/components/ventes/ventes-modals';
import { formatCurrency, formatNumber, formatQuantity, today } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

type Product = {
  id: number;
  code: string;
  name: string;
  unit: string;
  salePrice: number;
  /** Coût courant : sert à **avertir** d'une vente à perte, jamais à préremplir. */
  purchasePrice: number;
  stock: number;
};

type Line = {
  /** Identifiant de ligne purement local (clé React stable). */
  key: string;
  productId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
};

type CustomerOption = {
  id: number;
  name: string;
  phone: string | null;
  creditLimit: number;
};

type CustomerStats = {
  balance: number;
  creditLimit: number;
  creditLimitExceeded: boolean;
};

type ComputedLine = {
  quantity: number;
  unitPrice: number;
  discount: number;
  total: number;
};

const DEFAULT_PAYMENT_METHODS = ['Espèces', 'Mobile Money', 'Virement', 'Crédit'];

function newLine(): Line {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productId: '',
    quantity: '1',
    unitPrice: '',
    discount: '',
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
  const rawDiscount = toAmount(line.discount);
  const gross = quantity * unitPrice;
  // Une remise de ligne ne peut pas rendre le total négatif.
  const discount = Math.min(Math.max(rawDiscount, 0), Math.max(gross, 0));

  return { quantity, unitPrice, discount, total: gross - discount };
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function NouvelleVentePage() {
  const router = useRouter();
  const { settings } = useSettings();
  const canCreate = usePermission('sales.create');

  /* ---- État du formulaire (§10.2, repris tel quel) ---- */
  const [products, setProducts] = useState<Product[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(today());
  const [paymentMethod, setPaymentMethod] = useState('Espèces');
  const [amountPaid, setAmountPaid] = useState('');
  const [discountAmount, setDiscountAmount] = useState('');
  const [taxRate, setTaxRate] = useState(String(settings.defaultTaxRate ?? 0));
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /* ---- Chargements ---- */
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerStats, setCustomerStats] = useState<CustomerStats | null>(null);
  const [isCustomerStatsLoading, setIsCustomerStatsLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Vrai dès que l'utilisateur a saisi un montant encaissé à la main.
   * Tant qu'il est faux, le montant suit le total (§10.2) : le formulaire
   * s'ouvre « payé » et l'utilisateur ne fait rien pour une vente comptant.
   */
  const amountTouchedRef = useRef(false);
  /** Total précédent, pour ne pas écraser un encaissement partiel en cours. */
  const previousTotalRef = useRef(0);
  /** Première initialisation des lignes : elle ne doit se produire qu'une fois. */
  const initializedRef = useRef(false);

  /* ------------------------------------------------------------------
   * Chargement du catalogue et des clients
   * ------------------------------------------------------------------ */

  const load = useCallback(async (signal: AbortSignal) => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const [productsResponse, customersResponse] = await Promise.all([
        fetch('/api/produits?limit=500', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        }),
        fetch('/api/clients?limit=500', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        }).catch(() => null),
      ]);

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
            code: String(row.code ?? ''),
            name: String(row.name ?? ''),
            unit: String(row.unit ?? 'pièce'),
            salePrice: Number(row.salePrice ?? row.sale_price ?? 0) || 0,
            purchasePrice: Number(row.purchasePrice ?? row.purchase_price ?? 0) || 0,
            stock: Number(row.stock ?? 0) || 0,
          };
        })
        .filter((product) => product.id > 0);

      setProducts(catalogue);

      if (customersResponse && customersResponse.ok) {
        const customersPayload = (await customersResponse.json()) as { data?: unknown[] };
        setCustomers(
          (Array.isArray(customersPayload.data) ? customersPayload.data : [])
            .map((raw) => {
              const row = (raw ?? {}) as Record<string, unknown>;
              return {
                id: Number(row.id ?? 0),
                name: String(row.name ?? ''),
                phone: (row.phone ?? null) as string | null,
                creditLimit: Number(row.creditLimit ?? row.credit_limit ?? 0) || 0,
              };
            })
            .filter((customer) => customer.id > 0),
        );
      }
    } catch (caught) {
      if (caught instanceof Error && caught.name === 'AbortError') return;
      setLoadError(
        caught instanceof Error ? caught.message : 'Le catalogue produits n’a pas pu être chargé.',
      );
    } finally {
      if (!signal.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    // Annulation propre au démontage : pas de « réponse du passé » (§5).
    return () => controller.abort();
  }, [load]);

  /* Première ligne préremplie avec le premier produit et son prix de vente. */
  useEffect(() => {
    if (initializedRef.current) return;
    if (products.length === 0) return;

    initializedRef.current = true;
    const first = products[0];
    setLines((current) =>
      current.map((line, index) =>
        index === 0
          ? {
              ...line,
              productId: String(first.id),
              unitPrice: first.salePrice > 0 ? String(first.salePrice) : '',
            }
          : line,
      ),
    );
  }, [products]);

  /* Le taux de TVA par défaut suit les paramètres, tant que rien n'a été saisi. */
  const taxTouchedRef = useRef(false);
  useEffect(() => {
    if (taxTouchedRef.current) return;
    setTaxRate(String(settings.defaultTaxRate ?? 0));
  }, [settings.defaultTaxRate]);

  /* ------------------------------------------------------------------
   * Encours du client choisi : on avertit, on ne bloque pas (Q18)
   * ------------------------------------------------------------------ */

  useEffect(() => {
    if (!customerId) {
      setCustomerStats(null);
      return;
    }

    const controller = new AbortController();
    let active = true;

    void (async () => {
      setIsCustomerStatsLoading(true);
      try {
        const response = await fetch(`/api/clients/${customerId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('unavailable');
        const payload = (await response.json()) as {
          balance?: number;
          creditLimitExceeded?: boolean;
          customer?: { creditLimit?: number };
        };
        if (!active) return;
        setCustomerStats({
          balance: Number(payload.balance ?? 0) || 0,
          creditLimit: Number(payload.customer?.creditLimit ?? 0) || 0,
          creditLimitExceeded: Boolean(payload.creditLimitExceeded),
        });
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        // Encours indisponible : le formulaire reste utilisable, l'alerte est
        // simplement absente.
        if (active) setCustomerStats(null);
      } finally {
        if (active) setIsCustomerStatsLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [customerId]);

  /* ------------------------------------------------------------------
   * Calculs en direct (§10.3) et statut de paiement (§10.4)
   * ------------------------------------------------------------------ */

  const productById = useMemo(() => {
    const map = new Map<number, Product>();
    products.forEach((product) => map.set(product.id, product));
    return map;
  }, [products]);

  const computedLines = useMemo(() => lines.map(computeLine), [lines]);

  const totals = useMemo(() => {
    const subTotal = computedLines.reduce((sum, line) => sum + line.total, 0);
    const globalDiscount = Math.min(Math.max(toAmount(discountAmount), 0), Math.max(subTotal, 0));
    const totalHt = subTotal - globalDiscount;
    const rate = Math.max(toAmount(taxRate), 0);
    const taxAmount = (totalHt * rate) / 100;
    const totalToPay = totalHt + taxAmount;
    const paid = Math.max(toAmount(amountPaid), 0);
    const remaining = Math.max(totalToPay - paid, 0);

    return { subTotal, globalDiscount, totalHt, rate, taxAmount, totalToPay, paid, remaining };
  }, [computedLines, discountAmount, taxRate, amountPaid]);

  const paymentStatus = useMemo(() => {
    if (totals.paid <= 0) return { key: 'unpaid', label: 'En attente', tone: 'error' as const };
    if (totals.remaining > 0.001) return { key: 'partial', label: 'Partiel', tone: 'warning' as const };
    return { key: 'paid', label: 'Payée', tone: 'success' as const };
  }, [totals.paid, totals.remaining]);

  /**
   * Le montant encaissé suit le total tant que l'utilisateur n'y a pas touché,
   * et tant qu'il était réglé au centime près (vente comptant). Un acompte
   * volontaire (50 000 sur 200 000) n'est donc jamais écrasé par une frappe.
   */
  useEffect(() => {
    if (amountTouchedRef.current) return;
    const previous = previousTotalRef.current;
    if (previous > 0 && Math.abs(toAmount(amountPaid) - previous) > 0.001) return;

    const next = totals.totalToPay > 0 ? String(Math.round(totals.totalToPay * 100) / 100) : '';
    setAmountPaid((current) => (current === next ? current : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totals.totalToPay]);

  useEffect(() => {
    previousTotalRef.current = totals.totalToPay;
  }, [totals.totalToPay]);

  /* ------------------------------------------------------------------
   * Lignes
   * ------------------------------------------------------------------ */

  const addLine = () => setLines((current) => [...current, newLine()]);

  const removeLine = (key: string) =>
    setLines((current) => (current.length <= 1 ? current : current.filter((line) => line.key !== key)));

  /**
   * Repose automatiquement le **prix de vente** du produit (modifiable ensuite).
   *
   * ⚠️ Jamais le prix d'achat : un prix d'achat est un **coût**, pas un prix de
   * facturation. Le préremplir ferait vendre à marge nulle et fausserait le
   * chiffre d'affaires comme les bénéfices (§15). Un produit sans prix de vente
   * (les matières premières, par exemple) laisse donc le champ **vide** plutôt
   * qu'à `0` : la ligne affiche « Prix de vente non défini » et le vendeur
   * saisit le prix du jour.
   */
  const handleProductChange = (key: string, productId: string) => {
    const product = productById.get(Number(productId));
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? {
              ...line,
              productId,
              unitPrice: product && product.salePrice > 0 ? String(product.salePrice) : '',
            }
          : line,
      ),
    );
  };

  const setLineField = (key: string, field: 'quantity' | 'unitPrice' | 'discount', value: string) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, [field]: value } : line)),
    );
  };

  const selectedCustomer = customerId
    ? customers.find((customer) => customer.id === Number(customerId)) ?? null
    : null;

  /** Produits dont la quantité demandée dépasse le stock disponible. */
  const stockWarnings = lines
    .map((line, index) => {
      const product = productById.get(Number(line.productId));
      if (!product) return null;
      const { quantity } = computedLines[index];
      if (quantity <= 0 || quantity <= product.stock) return null;
      return { product, quantity };
    })
    .filter((entry): entry is { product: Product; quantity: number } => entry !== null);

  /** L'encours du client, augmenté de la vente en cours, dépasse-t-il son plafond ? */
  const creditWarning = useMemo(() => {
    if (!selectedCustomer || !customerStats) return null;
    const limit = customerStats.creditLimit || selectedCustomer.creditLimit;
    if (limit <= 0) return null;
    const projected = customerStats.balance + totals.totalToPay;
    if (projected <= limit) return null;
    return { limit, projected, balance: customerStats.balance };
  }, [selectedCustomer, customerStats, totals.totalToPay]);

  const paymentMethods = useMemo(() => {
    const configured = settings.paymentMethods?.filter((method) => Boolean(method?.trim())) ?? [];
    return configured.length > 0 ? configured : DEFAULT_PAYMENT_METHODS;
  }, [settings.paymentMethods]);

  const isCredit = totals.paid <= 0;

  /* ------------------------------------------------------------------
   * Enregistrement
   * ------------------------------------------------------------------ */

  const buildPayloadLines = () =>
    lines
      .map((line, index) => {
        const computed = computedLines[index];
        return {
          productId: Number(line.productId),
          quantity: computed.quantity,
          unitPrice: computed.unitPrice,
          discount: computed.discount,
        };
      })
      .filter((line) => line.productId > 0 && line.quantity > 0);

  const submit = async (status: 'active' | 'draft') => {
    if (!canCreate) {
      toast.error('Vous n’avez pas la permission de créer une vente.');
      return;
    }
    if (lines.length === 1 && !lines[0].productId) {
      setFormError('Sélectionnez au moins un produit.');
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
      setFormError('La date de la vente est obligatoire.');
      return;
    }
    if (dueDate && dueDate < date) {
      setFormError("L'échéance ne peut pas précéder la date de la vente.");
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/ventes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          customerId: customerId ? Number(customerId) : null,
          customerName: customerName.trim() || selectedCustomer?.name || 'Client comptoir',
          date,
          dueDate: dueDate || null,
          paymentMethod,
          amountPaid: totals.paid,
          discount: totals.globalDiscount,
          taxRate: totals.rate,
          notes: notes.trim() || null,
          status,
          lines: buildPayloadLines(),
        }),
      });

      if (!response.ok) {
        // Le message agrégé du serveur (« Stock insuffisant pour créer la vente :
        // • Placo BA13 … ») doit rester lisible : il ne tient pas en 4 secondes.
        toast.error(
          await readApiError(response, "La vente n'a pas pu être enregistrée."),
          { autoClose: 8000 },
        );
        return;
      }

      const payload = (await response.json()) as { invoice?: { invoiceNumber?: string } };
      const invoiceNumber = payload.invoice?.invoiceNumber;

      toast.success(
        status === 'draft'
          ? `Brouillon ${invoiceNumber ?? ''} enregistré.`
          : `Vente ${invoiceNumber ?? ''} enregistrée.`,
      );
      router.push('/ventes');
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "La vente n'a pas pu être enregistrée (connexion indisponible).",
        { autoClose: 8000 },
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const currency = settings.currency || 'GNF';

  /* ------------------------------------------------------------------
   * Rendu
   * ------------------------------------------------------------------ */

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Commercial"
        title="Nouvelle vente"
        description="Vente comptoir ou client enregistré, plusieurs produits, remises, TVA et encaissement immédiat."
      />

      {loadError ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Impossible de préparer la vente"
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
            description="Créez au moins un produit actif avant d’enregistrer une vente."
            onRetry={() => router.push('/produits')}
            retryLabel="Aller au catalogue"
          />
        </div>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit('active');
          }}
        >
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* ── Colonne principale : lignes de la vente ─────────────── */}
            <div className="space-y-4 lg:col-span-2">
              <Card padded={false} className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-3">
                  <h2 className="text-sm font-semibold">Produits vendus</h2>
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
                <div className="w-full overflow-x-auto" data-entry-table="vente">
                  <table className="table table-xs w-full min-w-[46rem]">
                    <thead>
                      <tr className="bg-base-200">
                        <th className="min-w-[16rem] text-left">Produit</th>
                        <th className="w-24 text-right">Qté</th>
                        <th className="w-32 text-right">Prix unit.</th>
                        <th className="w-28 text-right">Remise</th>
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
                        const exceedsStock =
                          product !== undefined && computed.quantity > 0 && computed.quantity > product.stock;

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
                                    {entry.code} — {entry.name} · vente{' '}
                                    {formatNumber(entry.salePrice)} GNF · achat{' '}
                                    {formatNumber(entry.purchasePrice)} GNF
                                  </option>
                                ))}
                              </select>
                              {product && (
                                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/60">
                                  <span className="tabular">
                                    Stock : {formatQuantity(product.stock, product.unit)}
                                  </span>
                                  {exceedsStock && (
                                    <Badge tone="warning">
                                      Quantité supérieure au stock disponible
                                    </Badge>
                                  )}
                                  {/*
                                    Deux avertissements, jamais de blocage : le
                                    prix reste une décision du vendeur (§15,
                                    Q18 « avertir, on ne bloque pas »).
                                  */}
                                  {product.salePrice <= 0 && (
                                    <Badge
                                      tone="warning"
                                      title="Ce produit n’a pas de prix de vente enregistré : saisissez le prix, ou complétez la fiche produit."
                                    >
                                      Prix de vente non défini
                                    </Badge>
                                  )}
                                  {product.salePrice > 0 &&
                                    computed.unitPrice > 0 &&
                                    computed.unitPrice < product.purchasePrice && (
                                      <Badge
                                        tone="warning"
                                        title={`Prix d’achat actuel : ${formatNumber(product.purchasePrice)} GNF — cette ligne est vendue à perte.`}
                                      >
                                        Vente à perte
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
                                className={`input input-bordered input-sm h-11 w-full text-right tabular sm:h-9 ${
                                  exceedsStock ? 'border-warning' : ''
                                }`}
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
                                aria-label={`Prix unitaire de la ligne ${index + 1}`}
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                step={1000}
                                inputMode="decimal"
                                className="input input-bordered input-sm h-11 w-full text-right tabular sm:h-9"
                                value={line.discount}
                                onChange={(event) =>
                                  setLineField(line.key, 'discount', event.target.value)
                                }
                                aria-label={`Remise de la ligne ${index + 1}`}
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
                                    ? 'Une vente doit conserver au moins une ligne'
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
                        <td colSpan={4} className="text-right text-sm font-semibold">
                          Total général
                        </td>
                        <td className="text-right">
                          <MoneyText value={totals.totalToPay} bold />
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>

              {stockWarnings.length > 0 && (
                <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
                  <p className="font-semibold">Stock insuffisant — la vente reste possible</p>
                  <ul className="mt-1 list-inside list-disc">
                    {stockWarnings.map((warning) => (
                      <li key={warning.product.id}>
                        {warning.product.name} : disponible{' '}
                        <span className="tabular">
                          {formatQuantity(warning.product.stock, warning.product.unit)}
                        </span>
                        , demandé{' '}
                        <span className="tabular">
                          {formatQuantity(warning.quantity, warning.product.unit)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs">
                    Le serveur vérifie le stock à l&apos;enregistrement et refuse la vente si la
                    quantité dépasse le disponible.
                  </p>
                </div>
              )}

              <Card>
                <FormField
                  label="Notes"
                  htmlFor="sale-notes"
                  hint="Conditions particulières, référence de commande, mention d’une remise négociée…"
                >
                  <textarea
                    id="sale-notes"
                    rows={2}
                    className="textarea textarea-bordered w-full"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Note interne facultative"
                  />
                </FormField>
              </Card>
            </div>

            {/* ── Colonne latérale : client, règlement, totaux ─────────── */}
            <div className="space-y-4">
              <Card className="space-y-4">
                <h2 className="text-sm font-semibold">Client</h2>

                <FormField
                  label="Client enregistré"
                  htmlFor="sale-customer"
                  hint="Laisser « Vente comptoir » pour un client de passage."
                >
                  <select
                    id="sale-customer"
                    className="select select-bordered min-h-11 w-full sm:min-h-0"
                    value={customerId}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCustomerId(value);
                      const found = customers.find((customer) => customer.id === Number(value));
                      // Le nom affiché sur la facture suit la fiche choisie.
                      setCustomerName(found ? found.name : '');
                    }}
                  >
                    <option value="">Vente comptoir</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>
                </FormField>

                <FormField
                  label="Nom sur la facture"
                  htmlFor="sale-customer-name"
                  hint="Modifiable : un nom libre crée une vente comptoir rattachable plus tard."
                >
                  <input
                    id="sale-customer-name"
                    type="text"
                    className="input input-bordered min-h-11 w-full sm:min-h-0"
                    value={customerName}
                    onChange={(event) => setCustomerName(event.target.value)}
                    placeholder="Client comptoir"
                    autoComplete="off"
                  />
                </FormField>

                {selectedCustomer && (
                  <div className="rounded-xl border border-base-200 bg-base-200/50 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-base-content/60">Encours actuel</span>
                      <MoneyText value={customerStats?.balance ?? 0} colored bold />
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="text-base-content/60">Plafond de crédit</span>
                      <span className="tabular font-medium">
                        {(customerStats?.creditLimit || selectedCustomer.creditLimit) > 0
                          ? formatCurrency(
                              customerStats?.creditLimit || selectedCustomer.creditLimit,
                              currency,
                            )
                          : 'Aucun'}
                      </span>
                    </div>
                    {isCustomerStatsLoading && (
                      <p className="mt-1 text-base-content/50">Chargement de l’encours…</p>
                    )}
                  </div>
                )}

                {creditWarning && (
                  <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                    <p className="font-semibold">Plafond de crédit dépassé</p>
                    <p className="mt-0.5">
                      Encours actuel {formatCurrency(creditWarning.balance, currency)} + cette vente{' '}
                      {formatCurrency(totals.totalToPay, currency)} ={' '}
                      {formatCurrency(creditWarning.projected, currency)} pour un plafond de{' '}
                      {formatCurrency(creditWarning.limit, currency)}.
                    </p>
                    <p className="mt-0.5">La vente reste possible : l’application avertit seulement.</p>
                  </div>
                )}
              </Card>

              <Card className="space-y-4">
                <h2 className="text-sm font-semibold">Règlement</h2>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
                  <FormField label="Date de la vente" htmlFor="sale-date" required>
                    <DatePicker value={date} onChange={setDate} placeholder="jj/mm/aaaa" />
                  </FormField>

                  <FormField label="Moyen de paiement" htmlFor="sale-payment-method" required>
                    <select
                      id="sale-payment-method"
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
                    label="Montant encaissé (GNF)"
                    htmlFor="sale-amount-paid"
                    hint="0 = vente à crédit."
                  >
                    <input
                      id="sale-amount-paid"
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

                  {isCredit && (
                    <FormField
                      label="Échéance"
                      htmlFor="sale-due-date"
                      hint="Vente à crédit : date promise de règlement."
                    >
                      <DatePicker value={dueDate} onChange={setDueDate} placeholder="jj/mm/aaaa" />
                    </FormField>
                  )}

                  <FormField
                    label="Taux de TVA (%)"
                    htmlFor="sale-tax-rate"
                    hint={`Taux par défaut : ${formatNumber(settings.defaultTaxRate ?? 0, 2)} %`}
                  >
                    <input
                      id="sale-tax-rate"
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
                      value={taxRate}
                      onChange={(event) => {
                        taxTouchedRef.current = true;
                        setTaxRate(event.target.value);
                      }}
                    />
                  </FormField>

                  <FormField
                    label="Remise globale (GNF)"
                    htmlFor="sale-global-discount"
                    hint="Déduite du sous-total, avant TVA."
                  >
                    <input
                      id="sale-global-discount"
                      type="number"
                      min={0}
                      step={1000}
                      inputMode="decimal"
                      className="input input-bordered min-h-11 w-full tabular sm:min-h-0"
                      value={discountAmount}
                      onChange={(event) => setDiscountAmount(event.target.value)}
                      placeholder="0"
                    />
                  </FormField>
                </div>

                {isCredit && (
                  <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                    Aucun encaissement saisi : la vente sera enregistrée <strong>à crédit</strong>,
                    le stock est déduit et le reste à payer suivi dans la liste des ventes.
                  </div>
                )}
              </Card>

              <Card className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">Totaux</h2>
                  <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                </div>

                <InfoRow label="Sous-total">
                  <MoneyText value={totals.subTotal} />
                </InfoRow>
                <InfoRow label="Remise globale">
                  <MoneyText value={totals.globalDiscount} />
                </InfoRow>
                <InfoRow label="Total HT">
                  <MoneyText value={totals.totalHt} />
                </InfoRow>
                <InfoRow label={`TVA (${formatNumber(totals.rate, 2)} %)`}>
                  <MoneyText value={totals.taxAmount} />
                </InfoRow>

                <div className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-primary">Total à payer</span>
                    <MoneyText value={totals.totalToPay} bold className="text-primary" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <MiniStat
                    label="Encaissé"
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
              <p className="text-xs text-base-content/50">Total à payer</p>
              <MoneyText value={totals.totalToPay} bold className="text-lg" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-ghost min-h-11 sm:min-h-0"
                onClick={() => router.push('/ventes')}
                disabled={isSubmitting}
              >
                Annuler
              </button>
              <button
                type="button"
                className="btn btn-outline min-h-11 sm:min-h-0"
                onClick={() => void submit('draft')}
                disabled={isSubmitting || !canCreate}
                title="Enregistrer comme brouillon : ni le stock ni la caisse ne sont touchés"
              >
                Enregistrer comme brouillon
              </button>
              <button
                type="submit"
                className="btn btn-primary min-h-11 sm:min-h-0"
                disabled={isSubmitting || !canCreate}
              >
                {isSubmitting ? (
                  <span className="loading loading-spinner loading-sm" />
                ) : (
                  'Enregistrer la vente'
                )}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
