'use client';

/**
 * Création d'une vente — README §10.2 à §10.5.
 *
 * **Logique métier** : reprise exacte du projet Gaz, inchangée.
 *   - produits chargés via `GET /api/produits?limit=500` avec `AbortController` ;
 *   - première ligne **préremplie** avec le premier produit et son prix de vente ;
 *   - changement de produit → le prix de vente est reposé automatiquement, mais
 *     reste modifiable (remise négociée) ;
 *   - remise par ligne (en montant) et remise globale, TVA, moyen de paiement,
 *     montant encaissé, échéance, calculs (§10.3) et statut de paiement (§10.4) ;
 *   - `POST /api/ventes` identique, brouillon compris.
 *
 * **Mise en page** : refondue sur la maquette validée par le client — page en
 * cartes, deux colonnes sur grand écran, barre d'actions collée en bas. Le
 * tableau de saisie `table table-xs` a cédé la place à des lignes en grille qui
 * se replient d'elles-mêmes : la page ne défile plus horizontalement, donc
 * l'exception `data-entry-table` du README §5.5 n'est plus nécessaire ici.
 *
 * Le serveur reste **seul juge** du stock : un dépassement est signalé ici, mais
 * n'empêche pas la soumission ; son erreur agrégée (liste de tous les produits en
 * rupture) est affichée en `toast.error` avec `{ autoClose: 8000 }`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DatePicker } from '@/components/date-picker';
import { Combobox } from '@/components/combobox';
import { Tooltip } from '@/components/tooltip';
import { IconAction, RowActions } from '@/components/row-actions';
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
import { CustomerFormModal, type CustomerRecord } from '@/components/clients/clients-modals';
import { usePermission } from '@/components/role-gate';
import { useSettings } from '@/app/parametres/page';
import { readApiError } from '@/components/ventes/ventes-modals';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency, formatNumber, formatQuantity, today } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

type Product = {
  id: number;
  name: string;
  unit: string;
  salePrice: number;
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
  /** Téléphone de la fiche, plus frais que la liste chargée au montage. */
  phone: string | null;
  /** Dernier achat connu : « — » si le client n'a jamais acheté. */
  lastPurchaseDate: string | null;
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

/**
 * Puce d'icône d'en-tête de carte.
 *
 * Elle reprend le vocabulaire des `Card` du projet (pastille `bg-primary/15`)
 * sans jamais poser de couleur en dur : les jetons du thème suivent le choix de
 * l'utilisateur (`lib/colors.ts`).
 */
function CardIcon({ d }: { d: string }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-5 w-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={d} />
      </svg>
    </span>
  );
}

/** Libellé de colonne, au-dessus de chaque champ de ligne (mobile comme desktop). */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-base-content/50">
      {children}
    </span>
  );
}

const ICONS = {
  products: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  notes:
    'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  summary: 'M9 7h6m-6 4h6m-6 4h3M7 3h10a2 2 0 012 2v14a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z',
  customer: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  payment: 'M3 10h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z',
  amount: 'M3 8h18v8H3V8zm9 2.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
} as const;

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function NouvelleVentePage() {
  const router = useRouter();
  const { settings } = useSettings();
  const canCreate = usePermission('sales.create');
  const canCreateCustomer = usePermission('customers.create');

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

  /* ---- Ajout rapide d'un produit (barre de la carte « Produits vendus ») ---- */
  const [productToAdd, setProductToAdd] = useState('');
  /** Menu ⋮ d'une ligne : une seule ligne ouverte à la fois. */
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  /** Modale de création client — composant partagé du module Clients. */
  const [showCustomerModal, setShowCustomerModal] = useState(false);

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
            name: String(row.name ?? ''),
            unit: String(row.unit ?? 'pièce'),
            salePrice: Number(row.salePrice ?? row.sale_price ?? 0) || 0,
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
          ? { ...line, productId: String(first.id), unitPrice: String(first.salePrice) }
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
          lastPurchaseDate?: string | null;
          customer?: { creditLimit?: number; phone?: string | null };
        };
        if (!active) return;
        setCustomerStats({
          balance: Number(payload.balance ?? 0) || 0,
          creditLimit: Number(payload.customer?.creditLimit ?? 0) || 0,
          creditLimitExceeded: Boolean(payload.creditLimitExceeded),
          phone: payload.customer?.phone ?? null,
          lastPurchaseDate: payload.lastPurchaseDate ?? null,
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

  /* Fermeture du menu ⋮ : clic extérieur ou `Échap`. */
  useEffect(() => {
    if (!openMenuKey) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-line-menu]')) return;
      setOpenMenuKey(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenuKey(null);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuKey]);

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

  /** Ajoute une ligne déjà porteuse du produit choisi dans la barre d'ajout. */
  const addProductLine = () => {
    const product = productById.get(Number(productToAdd));
    const line = newLine();
    if (product) {
      line.productId = String(product.id);
      line.unitPrice = String(product.salePrice);
    }
    setLines((current) => [...current, line]);
    setProductToAdd('');
  };

  const removeLine = (key: string) => {
    setOpenMenuKey(null);
    setLines((current) =>
      current.length <= 1 ? current : current.filter((line) => line.key !== key),
    );
  };

  /** Duplication : la copie se place juste sous la ligne d'origine. */
  const duplicateLine = (key: string) => {
    setOpenMenuKey(null);
    setLines((current) => {
      const index = current.findIndex((line) => line.key === key);
      if (index < 0) return current;
      const copy: Line = { ...current[index], key: newLine().key };
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
    });
  };

  /** Remet la ligne à son état d'origine (produit compris). */
  const resetLine = (key: string) => {
    setOpenMenuKey(null);
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...newLine(), key: line.key } : line)),
    );
  };

  /** Repose automatiquement le **prix de vente** du produit (modifiable ensuite). */
  const handleProductChange = (key: string, productId: string) => {
    const product = productById.get(Number(productId));
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? {
              ...line,
              productId,
              unitPrice: product ? String(product.salePrice) : '',
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

  /**
   * Compteur de quantité (− / +). La quantité reste une **chaîne** dans l'état,
   * comme la saisie clavier : le pas de 1 ne change donc rien au reste des
   * calculs. Arrondi au millième, sinon 0,1 + 0,2 afficherait 0,30000000000000004.
   */
  const stepQuantity = (key: string, delta: number) => {
    setLines((current) =>
      current.map((line) => {
        if (line.key !== key) return line;
        const next = Math.max(0, Math.round((toAmount(line.quantity) + delta) * 1000) / 1000);
        return { ...line, quantity: String(next) };
      }),
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
   * Client : sélection et création à la volée
   * ------------------------------------------------------------------ */

  const selectCustomer = (option: CustomerOption | null) => {
    setCustomerId(option ? String(option.id) : '');
    // Le nom affiché sur la facture suit la fiche choisie.
    setCustomerName(option ? option.name : '');
  };

  /**
   * Client créé depuis **la modale partagée du module Clients**
   * (`CustomerFormModal`, qui poste sur `/api/clients`) : on l'insère en tête de
   * la liste locale puis on le sélectionne, sans recharger la page ni dupliquer
   * le formulaire.
   */
  const handleCustomerCreated = (saved: CustomerRecord) => {
    const option: CustomerOption = {
      id: saved.id,
      name: saved.name,
      phone: saved.phone ?? null,
      creditLimit: Number(saved.creditLimit ?? 0) || 0,
    };

    setCustomers((current) =>
      current.some((customer) => customer.id === option.id)
        ? current.map((customer) => (customer.id === option.id ? option : customer))
        : [option, ...current],
    );
    setShowCustomerModal(false);
    selectCustomer(option);
    toast.success(`Client « ${option.name} » créé et sélectionné pour cette vente.`);
  };

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
  const companyLogo = settings.companyLogo || DEFAULT_COMPANY_LOGO;

  /* ------------------------------------------------------------------
   * Rendu
   * ------------------------------------------------------------------ */

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1.5">
            <span>Commercial</span>
            <span aria-hidden>›</span>
            <Link href="/ventes" className="hover:underline">
              Ventes
            </Link>
          </span>
        }
        title="Nouvelle vente"
        description="Vente comptoir ou client enregistré, plusieurs produits, remises, TVA et encaissement immédiat."
        actions={
          /* Le client a demandé le **logo de l'application** à cet emplacement :
             `settings.companyLogo` quand un logo est téléversé, sinon le logo
             livré avec l'application (même règle que les documents imprimés). */
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={companyLogo}
            alt={`Logo ${settings.companyName || 'Planète Déco'}`}
            className="ml-auto h-12 w-12 shrink-0 rounded-xl object-contain sm:ml-0 sm:h-14 sm:w-14"
          />
        }
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
        <>
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submit('active');
            }}
          >
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              {/* ── Colonne principale ─────────────────────────────────── */}
              <div className="min-w-0 space-y-4 lg:col-span-2">
                {/* 1. Produits vendus */}
                <Card padded={false} className="min-w-0">
                  <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
                    <div className="flex min-w-0 items-start gap-3">
                      <CardIcon d={ICONS.products} />
                      <div className="min-w-0">
                        <h2 className="text-sm font-semibold">Produits vendus</h2>
                        <p className="text-xs text-base-content/60">
                          Recherchez un produit, puis ajustez quantité, prix et remise. Le prix de
                          vente enregistré est reposé automatiquement.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Barre d'ajout : choix du produit + bouton d'ajout. */}
                  <div className="flex flex-wrap items-center gap-2 px-5 py-4">
                    <div className="min-w-0 grow basis-56">
                      <Combobox
                        id="sale-add-product"
                        className="h-11 w-full sm:h-10"
                        value={productToAdd}
                        onChange={setProductToAdd}
                        options={products.map((entry) => ({
                          value: String(entry.id),
                          label: entry.name,
                          hint: `${formatNumber(entry.salePrice)} GNF`,
                        }))}
                        emptyLabel="Sélectionner un produit…"
                        placeholder="Rechercher un produit à ajouter…"
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline min-h-11 shrink-0 sm:min-h-0"
                      onClick={addProductLine}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                      Ajouter un produit
                    </button>
                  </div>

                  {/* Les lignes se replient d'elles-mêmes : ni tableau large, ni
                      défilement horizontal, même à 360 px. */}
                  <ul className="divide-y divide-base-200 border-t border-base-200">
                    {lines.map((line, index) => {
                      const product = productById.get(Number(line.productId));
                      const computed = computedLines[index];
                      const exceedsStock =
                        product !== undefined &&
                        computed.quantity > 0 &&
                        computed.quantity > product.stock;
                      const gross = computed.quantity * computed.unitPrice;
                      const discountPercent = gross > 0 ? (computed.discount / gross) * 100 : 0;

                      return (
                        <li key={line.key} className="min-w-0 px-5 py-4">
                          {/* Une seule ligne de champs dès que la place le permet ;
                              en dessous, les blocs se replient deux par deux — jamais
                              de défilement horizontal. */}
                          <div className="flex min-w-0 flex-wrap items-start gap-2">
                            <div className="min-w-0 grow basis-36">
                              <Combobox
                                className="h-11 sm:h-9"
                                value={line.productId}
                                onChange={(value) => handleProductChange(line.key, value)}
                                options={products.map((entry) => ({
                                  value: String(entry.id),
                                  label: entry.name,
                                  hint: `${formatNumber(entry.salePrice)} GNF`,
                                }))}
                                emptyLabel="Sélectionner un produit…"
                                placeholder="Tapez le nom du produit…"
                                ariaLabel={`Produit de la ligne ${index + 1}`}
                              />
                              <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/60">
                                <span className="tabular">
                                  {product
                                    ? `Stock : ${formatQuantity(product.stock, product.unit)}`
                                    : 'Aucun produit sélectionné'}
                                </span>
                                {exceedsStock && (
                                  <Badge tone="warning">
                                    Quantité supérieure au stock disponible
                                  </Badge>
                                )}
                              </span>
                            </div>

                            <div className="min-w-0 grow basis-28">
                              <FieldLabel>Quantité</FieldLabel>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm btn-square min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                                  onClick={() => stepQuantity(line.key, -1)}
                                  disabled={toAmount(line.quantity) <= 0}
                                  aria-label={`Diminuer la quantité de la ligne ${index + 1}`}
                                >
                                  −
                                </button>
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  inputMode="decimal"
                                  className={`input input-bordered input-sm h-11 min-w-0 flex-1 text-right tabular sm:h-9 ${
                                    exceedsStock ? 'border-warning' : ''
                                  }`}
                                  value={line.quantity}
                                  onChange={(event) =>
                                    setLineField(line.key, 'quantity', event.target.value)
                                  }
                                  aria-label={`Quantité de la ligne ${index + 1}`}
                                />
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm btn-square min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                                  onClick={() => stepQuantity(line.key, 1)}
                                  aria-label={`Augmenter la quantité de la ligne ${index + 1}`}
                                >
                                  +
                                </button>
                              </div>
                            </div>

                            <div className="min-w-0 grow basis-20">
                              <FieldLabel>Prix unit.</FieldLabel>
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
                            </div>

                            <div className="min-w-0 grow basis-20">
                              <FieldLabel>Remise</FieldLabel>
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
                              {/* Remise exprimée en montant (elle est déduite telle
                                  quelle du total) : le pourcentage n'est qu'une
                                  lecture, il ne change pas le calcul. */}
                              <span className="mt-1 block text-right text-xs text-base-content/50">
                                {formatNumber(discountPercent, 1)} %
                              </span>
                            </div>

                            <div className="min-w-0 grow basis-28">
                              <FieldLabel>Total</FieldLabel>
                              <span className="flex min-h-11 items-center justify-end sm:min-h-9">
                                <MoneyText value={computed.total} className="text-sm" bold />
                              </span>
                            </div>

                            <div className="ml-auto flex shrink-0 items-center gap-1 self-start pt-5">
                              <RowActions>
                                <div className="relative" data-line-menu>
                                  <IconAction
                                    icon="menu"
                                    label={`Autres actions sur la ligne ${index + 1}`}
                                    onClick={() =>
                                      setOpenMenuKey((current) =>
                                        current === line.key ? null : line.key,
                                      )
                                    }
                                  />
                                  {openMenuKey === line.key && (
                                    <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-xl border border-base-200 bg-base-100 p-1 shadow-lg">
                                      <button
                                        type="button"
                                        className="btn btn-ghost btn-sm w-full justify-start font-normal"
                                        onClick={() => duplicateLine(line.key)}
                                      >
                                        Dupliquer la ligne
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-ghost btn-sm w-full justify-start font-normal"
                                        onClick={() => resetLine(line.key)}
                                      >
                                        Réinitialiser la ligne
                                      </button>
                                    </div>
                                  )}
                                </div>
                                <IconAction
                                  icon="trash"
                                  tone="danger"
                                  label={
                                    lines.length <= 1
                                      ? 'Une vente doit conserver au moins une ligne'
                                      : `Supprimer la ligne ${index + 1}`
                                  }
                                  disabled={lines.length <= 1}
                                  onClick={() => removeLine(line.key)}
                                />
                              </RowActions>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-200 px-5 py-3">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm min-h-11 font-medium text-primary sm:min-h-0"
                      onClick={addLine}
                    >
                      + Ajouter un autre produit
                    </button>
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm text-base-content/60">Total produits</span>
                      <MoneyText value={totals.subTotal} bold className="text-base" />
                    </div>
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

                {/* 2. Notes */}
                <Card className="min-w-0 space-y-3">
                  <div className="flex items-start gap-3">
                    <CardIcon d={ICONS.notes} />
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold">Notes</h2>
                      <p className="text-xs text-base-content/60">
                        Visible uniquement dans l’application, jamais sur le reçu du client.
                      </p>
                    </div>
                  </div>

                  <FormField label="Note interne" htmlFor="sale-notes">
                    <textarea
                      id="sale-notes"
                      rows={3}
                      className="textarea textarea-bordered w-full"
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="Note interne facultative…"
                    />
                  </FormField>

                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <ul className="list-inside list-disc space-y-0.5 text-xs text-base-content/50">
                      <li>Conditions particulières</li>
                      <li>Référence de commande</li>
                      <li>Mention d’une remise négociée</li>
                    </ul>
                    <span className="tabular text-xs text-base-content/50">
                      {notes.length} caractère{notes.length > 1 ? 's' : ''}
                    </span>
                  </div>
                </Card>

                {/* 3. Récapitulatif */}
                <Card className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <CardIcon d={ICONS.summary} />
                      <div className="min-w-0">
                        <h2 className="text-sm font-semibold">Récapitulatif</h2>
                        <p className="text-xs text-base-content/60">
                          Montants recalculés en direct à chaque modification.
                        </p>
                      </div>
                    </div>
                    <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                  </div>

                  <div className="pt-1">
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
                  </div>

                  <div className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-primary">Total à payer</span>
                      <MoneyText value={totals.totalToPay} bold className="text-primary" />
                    </div>
                  </div>

                  <ul className="grid grid-cols-1 gap-1 pt-1 text-xs text-base-content/60 sm:grid-cols-2">
                    <li className="flex items-center gap-2">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4 shrink-0 text-success"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      Stock mis à jour automatiquement
                    </li>
                    <li className="flex items-center gap-2">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4 shrink-0 text-success"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      Enregistrement rapide et sécurisé
                    </li>
                  </ul>
                </Card>
              </div>

              {/* ── Colonne latérale ───────────────────────────────────── */}
              <div className="min-w-0 space-y-4">
                {/* 4. Client */}
                <Card className="min-w-0 space-y-4">
                  <div className="flex items-start gap-3">
                    <CardIcon d={ICONS.customer} />
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold">Client</h2>
                      <p className="text-xs text-base-content/60">
                        Client enregistré, ou vente comptoir sans fiche.
                      </p>
                    </div>
                  </div>

                  <FormField label="Client enregistré" htmlFor="sale-customer">
                    <Combobox
                      id="sale-customer"
                      className="min-h-11 sm:min-h-0"
                      value={customerId}
                      onChange={(value) =>
                        selectCustomer(
                          customers.find((customer) => customer.id === Number(value)) ?? null,
                        )
                      }
                      options={customers.map((customer) => ({
                        value: String(customer.id),
                        label: customer.name,
                        hint: customer.phone ?? undefined,
                      }))}
                      emptyLabel="Vente comptoir"
                      showEmptyLabel
                      placeholder="Tapez le nom du client…"
                    />
                  </FormField>

                  {selectedCustomer ? (
                    <div className="rounded-xl border border-base-200 bg-base-200/50 px-3 py-2 text-xs">
                      <p className="truncate text-sm font-medium">{selectedCustomer.name}</p>
                      <p className="text-base-content/60">
                        {customerStats?.phone || selectedCustomer.phone || 'Téléphone non renseigné'}
                      </p>
                      <p className="mt-1 text-base-content/60">
                        Dernier achat :{' '}
                        <span className="font-medium text-base-content/80">
                          {formatDateShort(customerStats?.lastPurchaseDate)}
                        </span>
                      </p>
                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-base-300 pt-2">
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
                  ) : (
                    <p className="rounded-xl border border-base-200 bg-base-200/50 px-3 py-2 text-xs text-base-content/60">
                      Aucun client sélectionné : la vente sera enregistrée au nom du client
                      comptoir.
                    </p>
                  )}

                  {creditWarning && (
                    <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                      <p className="font-semibold">Plafond de crédit dépassé</p>
                      <p className="mt-0.5">
                        Encours actuel {formatCurrency(creditWarning.balance, currency)} + cette
                        vente {formatCurrency(totals.totalToPay, currency)} ={' '}
                        {formatCurrency(creditWarning.projected, currency)} pour un plafond de{' '}
                        {formatCurrency(creditWarning.limit, currency)}.
                      </p>
                      <p className="mt-0.5">
                        La vente reste possible : l’application avertit seulement.
                      </p>
                    </div>
                  )}

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

                  <button
                    type="button"
                    className="btn btn-outline min-h-11 w-full sm:min-h-0"
                    onClick={() => setShowCustomerModal(true)}
                    disabled={!canCreateCustomer}
                  >
                    + Nouveau client
                  </button>
                </Card>

                {/* 5. Règlement */}
                <Card className="min-w-0 space-y-4">
                  <div className="flex items-start gap-3">
                    <CardIcon d={ICONS.payment} />
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold">Règlement</h2>
                      <p className="text-xs text-base-content/60">
                        Date, moyen de paiement et encaissement immédiat.
                      </p>
                    </div>
                  </div>

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
                      label={`Montant encaissé (${currency})`}
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
                      label={`Remise globale (${currency})`}
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

                {/* 6. Montant à encaisser (carte mise en avant) */}
                <Card className="min-w-0 space-y-3 ring-2 ring-primary/30">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <CardIcon d={ICONS.amount} />
                      <div className="min-w-0">
                        <h2 className="text-sm font-semibold">Montant à encaisser</h2>
                        <p className="text-xs text-base-content/60">
                          Mode de paiement : <strong>{paymentMethod}</strong>
                        </p>
                      </div>
                    </div>
                    <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                  </div>

                  <div className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-primary">Reste à payer</span>
                      <MoneyText value={totals.remaining} bold className="text-primary" />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
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

                  <p className="text-xs text-base-content/60">
                    Règlement en <strong>{paymentMethod}</strong>
                    {isCredit
                      ? ' — vente à crédit, à suivre depuis la liste des ventes.'
                      : ' — encaissement immédiat à l’enregistrement.'}
                  </p>
                </Card>
              </div>
            </div>

            {formError && (
              <p
                role="alert"
                className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
              >
                {formError}
              </p>
            )}

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
                {/*
                  L'explication était un `title` natif — bulle système, hors thème,
                  invisible au clavier. Elle est désormais portée par la bulle du
                  bouton lui-même : on survole (ou on tabule sur) « Enregistrer
                  comme brouillon » et l'explication s'affiche.
                */}
                <Tooltip
                  label={
                    <>
                      Un brouillon enregistre la vente <strong>sans toucher au stock</strong> ni à la
                      caisse, et sans émettre de reçu. Vous pourrez la reprendre, la modifier, puis
                      l&apos;enregistrer définitivement depuis la liste des ventes.
                    </>
                  }
                >
                  <button
                    type="button"
                    className="btn btn-outline min-h-11 sm:min-h-0"
                    onClick={() => void submit('draft')}
                    disabled={isSubmitting || !canCreate}
                  >
                    Enregistrer comme brouillon
                  </button>
                </Tooltip>
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

          {/*
            Modale partagée du module Clients : elle porte son **propre** `<form>`,
            elle est donc montée hors du formulaire de vente (un `<form>` imbriqué
            est invalide en HTML).
          */}
          <CustomerFormModal
            isOpen={showCustomerModal}
            onClose={() => setShowCustomerModal(false)}
            onSaved={handleCustomerCreated}
            idPrefix="sale-create"
          />
        </>
      )}
    </div>
  );
}
