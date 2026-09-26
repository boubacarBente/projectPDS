'use client';

/**
 * Création d'une vente — README §10.2 à §10.5.
 *
 * **Logique métier** : reprise exacte du projet Gaz, inchangée.
 *   - produits chargés via `GET /api/produits?limit=500` avec `AbortController` ;
 *   - première ligne **préremplie** avec le premier produit et son prix de vente ;
 *   - changement de produit → le prix de vente est reposé automatiquement, mais
 *     reste modifiable (remise négociée) ;
 *   - remise par ligne **saisie en montant** (choix du client : « en prix », pas
 *     en pourcentage) et remise globale, TVA, moyen de paiement, montant
 *     encaissé, échéance, calculs (§10.3) et statut de paiement (§10.4) ;
 *   - `POST /api/ventes` strictement identique, brouillon compris : le serveur
 *     reçoit la remise de ligne **en montant**, comme avant la refonte.
 *
 * **Mise en page** : refonte visuelle calée sur la maquette validée par le
 * client — en-tête panneau teinté avec carré primaire, pastilles d'icônes
 * colorées en tête de carte, ligne produit en grille à colonnes étiquetées
 * (en-tête de tableau sur grand écran), suffixes « GNF » dans les champs
 * (montants et remise de ligne) et « % » dans le taux de TVA, badge « En
 * stock : N », chips de réassurance, carte « Montant à
 * encaisser » en aplat primaire et barre d'actions collée en bas. Deux
 * colonnes sur grand écran, une seule sur mobile : la page ne défile jamais
 * horizontalement, l'exception `data-entry-table` du README §5.5 reste
 * inutile ici.
 *
 * Le serveur reste **seul juge** du stock : un dépassement est signalé ici, mais
 * n'empêche pas la soumission ; son erreur agrégée (liste de tous les produits en
 * rupture) est affichée en `toast.error` avec `{ autoClose: 8000 }`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { BackButton } from '@/components/back-button';
import { DatePicker } from '@/components/date-picker';
import { Combobox } from '@/components/combobox';
import { Tooltip } from '@/components/tooltip';
import { IconAction } from '@/components/row-actions';
import {
  Badge,
  Card,
  ErrorState,
  FormField,
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
  /** Remise de ligne saisie **en montant** (choix du client), déduite du brut. */
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
  // La remise de ligne est saisie **en montant** (choix du client, pas en
  // pourcentage) : elle est déduite telle quelle du brut, sans conversion.
  const discount = Math.min(Math.max(rawDiscount, 0), Math.max(gross, 0));

  return { quantity, unitPrice, discount, total: gross - discount };
}

/** Initiales pour l'avatar rond de la fiche « Client sélectionné ». */
function customerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const initials = parts.map((part) => part.charAt(0).toUpperCase()).join('');
  return initials || '?';
}

/* ------------------------------------------------------------------ *
 * Briques visuelles locales (maquette) — jetons du thème uniquement
 * ------------------------------------------------------------------ */

/** Icône de tracé 24×24, `stroke` hérité (aucune couleur en dur). */
function Icon({
  d,
  children,
  className = 'h-5 w-5',
  strokeWidth = 1.8,
}: {
  d?: string;
  children?: React.ReactNode;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      aria-hidden
    >
      {children ?? <path strokeLinecap="round" strokeLinejoin="round" d={d} />}
    </svg>
  );
}

/** Teintes douces des pastilles d'en-tête de carte (variantes /10 du thème). */
const PASTILLE_TONES = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  info: 'bg-info/10 text-info',
  accent: 'bg-accent/10 text-accent',
} as const;

type PastilleTone = keyof typeof PASTILLE_TONES;

/**
 * En-tête de carte : pastille d'icône carrée arrondie (~40 px) + titre gras +
 * sous-titre discret, actions éventuelles à droite (maquette).
 */
function CardTitle({
  icon,
  tone,
  title,
  subtitle,
  actions,
}: {
  icon: React.ReactNode;
  tone: PastilleTone;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${PASTILLE_TONES[tone]}`}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-base-content/60">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Libellé de colonne au-dessus de chaque champ — masqué dès que la grille XL
 * fournit sa ligne d'en-tête (maquette). */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-base-content/50 xl:hidden">
      {children}
    </span>
  );
}

/** Champ numérique avec suffixe **dans** le champ (« GNF », « % » — maquette). */
function SuffixedInput({
  value,
  onChange,
  suffix,
  ariaLabel,
  placeholder,
  min = 0,
  step = 'any',
}: {
  value: string;
  onChange: (value: string) => void;
  suffix: string;
  ariaLabel: string;
  placeholder?: string;
  min?: number;
  step?: number | 'any';
}) {
  return (
    <label className="relative block w-full">
      <input
        type="number"
        min={min}
        step={step}
        inputMode="decimal"
        aria-label={ariaLabel}
        className="input input-bordered field-rounded h-11 w-full bg-base-100 pr-12 text-right text-sm tabular [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none sm:h-9"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] font-medium text-base-content/45">
        {suffix}
      </span>
    </label>
  );
}

/** Icône de tête d'un champ (calendrier, carte bancaire, pièces — maquette). */
function IconAdorned({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="relative">
      <span
        className="pointer-events-none absolute left-3 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-base-content/40"
        aria-hidden
      >
        {icon}
      </span>
      {children}
    </div>
  );
}

/** Ligne « libellé / valeur » du récapitulatif, à fond alterné (maquette). */
function RecapRow({
  label,
  children,
  tinted = false,
}: {
  label: string;
  children: React.ReactNode;
  tinted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${
        tinted ? 'bg-base-200/60' : 'bg-base-200/25'
      }`}
    >
      <span className="text-base-content/60">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

const ICONS = {
  /** Chariot de l'en-tête (maquette : carré primaire, icône blanche). */
  cart: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z',
  /** Sacola « Produits vendus ». */
  products: 'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z',
  notes:
    'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  summary: 'M9 7h6m-6 4h6m-6 4h3M7 3h10a2 2 0 012 2v14a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z',
  customer: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  payment: 'M3 10h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z',
  amount: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z',
  calendar: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  coins:
    'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z',
  percent:
    'M19 5L5 19M9 7.5a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm11 9a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z',
  shield:
    'M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3zm-3 9l2 2 4-4',
  check: 'M5 13l4 4L19 7',
  checkCircle: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  cube: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  lock: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
  phone:
    'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z',
  search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  heart:
    'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
} as const;

/*
 * Grille d'une ligne produit (maquette) : Produit | Qté | Prix unitaire |
 * Remise | Total | Actions. Même gabarit pour la ligne d'en-tête et chaque
 * ligne ; en dessous de XL, les champs se replient deux par deux.
 *
 * Largeurs : la colonne **Produit** prend tout le reste (1fr) et les autres
 * colonnes sont fixes et **serrées** — c'est elle qui porte le nom du produit,
 * donc la plus large de la rangée. Alignement **en haut** (`items-start`) :
 * la cellule produit empile champ + badge « En stock », un centrage vertical
 * ferait monter le champ produit au-dessus des autres.
 */
const LINE_GRID =
  'xl:grid xl:grid-cols-[minmax(0,1fr)_76px_108px_88px_96px_32px] xl:items-start xl:gap-2';

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
  const isFullyPaid = totals.remaining <= 0.001;

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
  /** Seuil d'alerte de stock configuré : sous ce niveau, le badge passe en warning. */
  const stockMin = settings.defaultStockMin ?? 0;

  /* ------------------------------------------------------------------
   * Rendu
   * ------------------------------------------------------------------ */

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      {/* ── En-tête de page (maquette : panneau teinté, carré primaire, logo) ── */}
      <header className="rounded-3xl border border-base-200 bg-linear-to-r from-primary/10 to-base-100 p-5 shadow-sm sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-base-content/60">
              <BackButton withMargin={false} />
              <span className="flex items-center gap-1.5">
                <span>Commercial</span>
                <span aria-hidden>›</span>
                <Link href="/ventes" className="font-medium hover:underline">
                  Ventes
                </Link>
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3 sm:gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-content shadow-sm sm:h-12 sm:w-12">
                <Icon d={ICONS.cart} className="h-6 w-6" strokeWidth={2} />
              </span>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Nouvelle vente</h1>
            </div>
            <p className="mt-2.5 max-w-2xl text-sm leading-6 text-base-content/60">
              Enregistrez une nouvelle vente : plusieurs produits, remises, TVA et
              encaissement immédiat.
            </p>
          </div>
          {/* Logo de l'application : `settings.companyLogo` quand un logo est
              téléversé, sinon le logo livré avec l'application. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={companyLogo}
            alt={`Logo ${settings.companyName || 'Planète Déco'}`}
            className="h-12 w-12 shrink-0 rounded-xl object-contain sm:h-14 sm:w-14"
          />
        </div>
      </header>

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
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit('active');
            }}
          >
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              {/* ── Colonne principale ─────────────────────────────────── */}
              <div className="min-w-0 space-y-5 lg:col-span-2">
                {/* 1. Produits vendus */}
                <Card padded={false} className="min-w-0">
                  <div className="px-5 pt-5">
                    <CardTitle
                      icon={<Icon d={ICONS.products} />}
                      tone="info"
                      title="Produits vendus"
                      subtitle="Ajoutez les produits ou services à vendre"
                      actions={
                        <button
                          type="button"
                          className="btn btn-primary btn-sm h-11 min-h-11 shrink-0 rounded-full px-4 font-semibold sm:h-9 sm:min-h-0"
                          onClick={addLine}
                        >
                          <Icon d="M12 4v16m8-8H4" className="h-4 w-4" strokeWidth={2.2} />
                          Ajouter un produit
                        </button>
                      }
                    />
                  </div>

                  {/* Ligne d'en-tête de la grille produit (grand écran, maquette). */}
                  <div
                    className={`mt-4 hidden border-b border-base-200 bg-base-200/40 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-base-content/50 ${LINE_GRID}`}
                    aria-hidden
                  >
                    <span>Produit</span>
                    <span>Qté</span>
                    <span>Prix unitaire</span>
                    <span>Remise</span>
                    <span className="text-right">Total</span>
                    <span />
                  </div>

                  {/* Les lignes se replient d'elles-mêmes : ni tableau large, ni
                      défilement horizontal, même à 360 px. */}
                  <ul className="divide-y divide-base-200">
                    {lines.map((line, index) => {
                      const product = productById.get(Number(line.productId));
                      const computed = computedLines[index];
                      const exceedsStock =
                        product !== undefined &&
                        computed.quantity > 0 &&
                        computed.quantity > product.stock;
                      const stockTone = product && product.stock <= stockMin ? 'warning' : 'success';

                      return (
                        <li key={line.key} className="min-w-0 px-4 py-4 sm:px-5">
                          <div className={`flex min-w-0 flex-wrap items-start gap-x-3 gap-y-3 ${LINE_GRID}`}>
                            {/* Produit : recherche + badge « En stock : N ». */}
                            <div className="min-w-0 w-full xl:w-auto">
                              <FieldLabel>Produit</FieldLabel>
                              <Combobox
                                className="h-11 w-full sm:h-9"
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
                              <span className="mt-1.5 flex flex-wrap items-center gap-2">
                                {product ? (
                                  <Badge tone={stockTone}>
                                    En stock : {formatQuantity(product.stock, product.unit)}
                                  </Badge>
                                ) : (
                                  <span className="text-xs text-base-content/50">
                                    Aucun produit sélectionné
                                  </span>
                                )}
                                {exceedsStock && (
                                  <Badge tone="warning">Quantité supérieure au stock</Badge>
                                )}
                              </span>
                            </div>

                            {/* Quantité : compteur bordé − / + (maquette). */}
                            <div className="min-w-0 grow basis-[calc(50%-0.375rem)] xl:w-auto xl:grow-0 xl:basis-auto">
                              <FieldLabel>Quantité</FieldLabel>
                              <div className="flex h-11 w-full items-stretch overflow-hidden rounded-xl border border-base-300 bg-base-100 transition-colors focus-within:border-primary sm:h-9">
                                <button
                                  type="button"
                                  className="flex w-11 shrink-0 items-center justify-center text-lg text-base-content/60 transition-colors hover:bg-base-200 disabled:opacity-30 sm:w-8 xl:w-7"
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
                                  className="min-h-0 min-w-0 flex-1 border-0 bg-transparent text-center text-sm tabular [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  value={line.quantity}
                                  onChange={(event) =>
                                    setLineField(line.key, 'quantity', event.target.value)
                                  }
                                  aria-label={`Quantité de la ligne ${index + 1}`}
                                />
                                <button
                                  type="button"
                                  className="flex w-11 shrink-0 items-center justify-center text-lg text-base-content/60 transition-colors hover:bg-base-200 sm:w-8 xl:w-7"
                                  onClick={() => stepQuantity(line.key, 1)}
                                  aria-label={`Augmenter la quantité de la ligne ${index + 1}`}
                                >
                                  +
                                </button>
                              </div>
                            </div>

                            {/* Prix unitaire : suffixe « GNF » dans le champ. */}
                            <div className="min-w-0 grow basis-[calc(50%-0.375rem)] xl:w-auto xl:grow-0 xl:basis-auto">
                              <FieldLabel>Prix unitaire</FieldLabel>
                              <SuffixedInput
                                value={line.unitPrice}
                                onChange={(value) => setLineField(line.key, 'unitPrice', value)}
                                suffix={currency}
                                ariaLabel={`Prix unitaire de la ligne ${index + 1}`}
                                step={1000}
                                placeholder="0"
                              />
                            </div>

                            {/* Remise de ligne saisie **en montant** (choix du
                                client : « en prix », pas en pourcentage). */}
                            <div className="min-w-0 grow basis-[calc(50%-0.375rem)] xl:w-auto xl:grow-0 xl:basis-auto">
                              <FieldLabel>Remise</FieldLabel>
                              <SuffixedInput
                                value={line.discount}
                                onChange={(value) => setLineField(line.key, 'discount', value)}
                                suffix={currency}
                                ariaLabel={`Remise en montant de la ligne ${index + 1}`}
                                step={1000}
                                placeholder="0"
                              />
                            </div>

                            {/* Total de ligne, aligné à droite (maquette). */}
                            <div className="flex min-w-0 grow basis-[calc(50%-0.375rem)] items-end justify-end xl:w-auto xl:grow-0 xl:basis-auto xl:justify-end">
                              <div className="w-full xl:w-auto xl:text-right">
                                <FieldLabel>Total</FieldLabel>
                                <MoneyText value={computed.total} bold className="text-sm" />
                              </div>
                            </div>

                            {/* Actions : ⋮ au-dessus de la corbeille sur grand
                                écran (maquette), rangée à droite en dessous. */}
                            <div
                              className="relative flex w-full shrink-0 flex-row items-center justify-end gap-1 pt-1 xl:w-auto xl:flex-col xl:items-center xl:justify-center xl:gap-1.5 xl:pt-0"
                              data-line-menu
                            >
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
                                <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-xl border border-base-200 bg-base-100 p-1 shadow-lg" data-line-menu>
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
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-200 px-5 py-3.5">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm min-h-11 gap-1 font-medium text-primary sm:min-h-0"
                      onClick={addLine}
                    >
                      <Icon d="M12 4v16m8-8H4" className="h-4 w-4" strokeWidth={2.2} />
                      Ajouter un autre produit
                    </button>
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm text-base-content/60">Total produits</span>
                      <MoneyText value={totals.subTotal} bold className="text-base" />
                    </div>
                  </div>
                </Card>

                {stockWarnings.length > 0 && (
                  <div className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
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
                <Card className="min-w-0 space-y-4">
                  <CardTitle
                    icon={<Icon d={ICONS.notes} />}
                    tone="accent"
                    title="Notes"
                    subtitle="Informations supplémentaires sur la vente"
                  />

                  <textarea
                    rows={4}
                    maxLength={500}
                    className="textarea textarea-bordered field-rounded w-full bg-base-100"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Note interne facultative…"
                    aria-label="Note interne facultative"
                  />
                  <div className="flex justify-end">
                    <span className="tabular text-xs text-base-content/45">{notes.length}/500</span>
                  </div>

                  {/* Puces d'aide sous forme de pilules (maquette). */}
                  <div className="flex flex-wrap gap-2">
                    {[
                      'Conditions particulières',
                      'Référence de commande',
                      'Mention d’une remise négociée',
                    ].map((pill) => (
                      <span
                        key={pill}
                        className="badge-pill border border-base-300 bg-base-200/60 px-3 py-1.5 text-xs font-medium text-base-content/70"
                      >
                        {pill}
                      </span>
                    ))}
                  </div>
                </Card>

                {/* 3. Récapitulatif */}
                <Card className="min-w-0 space-y-3">
                  <CardTitle
                    icon={<Icon d={ICONS.summary} />}
                    tone="success"
                    title="Récapitulatif"
                    subtitle="Aperçu de votre vente"
                  />

                  <div className="space-y-1.5 pt-1">
                    <RecapRow label="Sous-total">
                      <MoneyText value={totals.subTotal} />
                    </RecapRow>
                    <RecapRow label="Remise globale" tinted>
                      <MoneyText value={totals.globalDiscount} />
                    </RecapRow>
                    <RecapRow label="Total HT">
                      <MoneyText value={totals.totalHt} />
                    </RecapRow>
                    <RecapRow label={`TVA (${formatNumber(totals.rate, 2)} %)`} tinted>
                      <MoneyText value={totals.taxAmount} />
                    </RecapRow>
                  </div>

                  {/* Rangée pleine largeur « Total à payer » (maquette). */}
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-primary/10 px-4 py-3">
                    <span className="text-base font-bold text-primary">Total à payer</span>
                    <MoneyText value={totals.totalToPay} bold className="text-xl text-primary" />
                  </div>

                  {/* Chips de réassurance (maquette). */}
                  <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
                    <div className="flex items-center gap-2.5 rounded-xl bg-success/10 px-3.5 py-2.5 text-success">
                      <Icon d={ICONS.cube} className="h-5 w-5 shrink-0" strokeWidth={1.6} />
                      <span className="text-xs font-medium leading-snug">
                        Stock mis à jour automatiquement
                      </span>
                    </div>
                    <div className="flex items-center gap-2.5 rounded-xl bg-accent/10 px-3.5 py-2.5 text-accent">
                      <Icon d={ICONS.shield} className="h-5 w-5 shrink-0" strokeWidth={1.6} />
                      <span className="text-xs font-medium leading-snug">
                        Enregistrement rapide et sécurisé
                      </span>
                    </div>
                  </div>
                </Card>
              </div>

              {/* ── Colonne latérale ───────────────────────────────────── */}
              <div className="min-w-0 space-y-5">
                {/* 4. Client */}
                <Card className="min-w-0 space-y-4">
                  <CardTitle
                    icon={<Icon d={ICONS.customer} />}
                    tone="info"
                    title="Client"
                    subtitle="Client enregistré"
                  />

                  {/* Recherche avec loupe et croix d'effacement (maquette). */}
                  <div className="relative">
                    <span
                      className="pointer-events-none absolute left-3 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-base-content/40"
                      aria-hidden
                    >
                      <Icon d={ICONS.search} className="h-4.5 w-4.5" />
                    </span>
                    <Combobox
                      id="sale-customer"
                      className="min-h-11 pl-9 sm:min-h-0"
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
                      placeholder="Rechercher un client…"
                    />
                    {customerId && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs btn-circle absolute right-2 top-1/2 z-10 -translate-y-1/2 text-base-content/50 hover:text-error"
                        onClick={() => selectCustomer(null)}
                        aria-label="Effacer le client sélectionné"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {selectedCustomer ? (
                    /* Fiche « Client sélectionné » (maquette). */
                    <div className="rounded-2xl border border-base-200 bg-base-200/40 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-base-content/50">
                          Client sélectionné
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs btn-circle text-base-content/50 hover:text-error"
                          onClick={() => selectCustomer(null)}
                          aria-label="Ne plus attacher ce client à la vente"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                          {customerInitials(selectedCustomer.name)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{selectedCustomer.name}</p>
                          {(customerStats?.phone || selectedCustomer.phone) && (
                            <p className="mt-0.5 flex items-center gap-1.5 text-xs tabular text-base-content/60">
                              <Icon d={ICONS.phone} className="h-3.5 w-3.5 shrink-0" />
                              {customerStats?.phone || selectedCustomer.phone}
                            </p>
                          )}
                        </div>
                      </div>
                      {/* Encadré « Client fidèle » : uniquement quand une
                          dernière vente existe réellement dans les données. */}
                      {customerStats?.lastPurchaseDate && (
                        <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-xs font-medium text-success">
                          <Icon d={ICONS.heart} className="h-4 w-4 shrink-0" />
                          <span>
                            Client fidèle · Dernière vente :{' '}
                            {formatDateShort(customerStats.lastPurchaseDate)}
                          </span>
                        </div>
                      )}
                      {isCustomerStatsLoading && (
                        <p className="mt-2 text-xs text-base-content/50">
                          Chargement des informations client…
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="rounded-2xl border border-base-200 bg-base-200/40 px-3 py-2.5 text-xs text-base-content/60">
                      Aucun client sélectionné : la vente sera enregistrée au nom du client
                      comptoir.
                    </p>
                  )}

                  {creditWarning && (
                    <div className="rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
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
                      className="input input-bordered field-rounded min-h-11 w-full bg-base-100 sm:min-h-0"
                      value={customerName}
                      onChange={(event) => setCustomerName(event.target.value)}
                      placeholder="Client comptoir"
                      autoComplete="off"
                    />
                  </FormField>

                  <button
                    type="button"
                    className="btn btn-outline field-rounded min-h-11 w-full font-medium text-primary sm:min-h-0"
                    onClick={() => setShowCustomerModal(true)}
                    disabled={!canCreateCustomer}
                  >
                    <Icon d="M12 4v16m8-8H4" className="h-4 w-4" strokeWidth={2.2} />
                    Nouveau client
                  </button>
                </Card>

                {/* 5. Règlement */}
                <Card className="min-w-0 space-y-4">
                  <CardTitle
                    icon={<Icon d={ICONS.payment} />}
                    tone="info"
                    title="Règlement"
                    subtitle="Informations sur le paiement"
                  />

                  <div className="space-y-4">
                    <FormField label="Date de la vente" htmlFor="sale-date" required>
                      <DatePicker
                        value={date}
                        onChange={setDate}
                        placeholder="jj/mm/aaaa"
                        className="pl-10"
                      />
                    </FormField>

                    <FormField label="Moyen de paiement" htmlFor="sale-payment-method" required>
                      <IconAdorned icon={<Icon d={ICONS.payment} className="h-4 w-4" />}>
                        <select
                          id="sale-payment-method"
                          className="select select-bordered field-rounded min-h-11 w-full bg-base-100 pl-10 font-medium sm:min-h-0"
                          value={paymentMethod}
                          onChange={(event) => setPaymentMethod(event.target.value)}
                        >
                          {paymentMethods.map((method) => (
                            <option key={method} value={method}>
                              {method}
                            </option>
                          ))}
                        </select>
                      </IconAdorned>
                    </FormField>

                    <FormField
                      label={`Montant encaissé (${currency})`}
                      htmlFor="sale-amount-paid"
                      hint="0 = vente à crédit."
                    >
                      <IconAdorned icon={<Icon d={ICONS.coins} className="h-4 w-4" />}>
                        <input
                          id="sale-amount-paid"
                          type="number"
                          min={0}
                          step={1000}
                          inputMode="decimal"
                          className="input input-bordered field-rounded min-h-11 w-full bg-base-100 pl-10 pr-14 text-right tabular [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none sm:min-h-0"
                          value={amountPaid}
                          onChange={(event) => {
                            amountTouchedRef.current = true;
                            setAmountPaid(event.target.value);
                          }}
                          placeholder="0"
                        />
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] font-medium text-base-content/45">
                          {currency}
                        </span>
                      </IconAdorned>
                    </FormField>

                    {isCredit && (
                      <FormField
                        label="Échéance"
                        htmlFor="sale-due-date"
                        hint="Vente à crédit : date promise de règlement."
                      >
                        <DatePicker
                          value={dueDate}
                          onChange={setDueDate}
                          placeholder="jj/mm/aaaa"
                          className="pl-10"
                        />
                      </FormField>
                    )}

                    <FormField
                      label="Taux de TVA (%)"
                      htmlFor="sale-tax-rate"
                      hint={`Taux par défaut : ${formatNumber(settings.defaultTaxRate ?? 0, 2)} %`}
                    >
                      <IconAdorned icon={<Icon d={ICONS.percent} className="h-4 w-4" />}>
                        <input
                          id="sale-tax-rate"
                          type="number"
                          min={0}
                          step="any"
                          inputMode="decimal"
                          className="input input-bordered field-rounded min-h-11 w-full bg-base-100 pl-10 pr-10 text-right tabular [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none sm:min-h-0"
                          value={taxRate}
                          onChange={(event) => {
                            taxTouchedRef.current = true;
                            setTaxRate(event.target.value);
                          }}
                        />
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] font-medium text-base-content/45">
                          %
                        </span>
                      </IconAdorned>
                    </FormField>

                    <FormField
                      label={`Remise globale (${currency})`}
                      htmlFor="sale-global-discount"
                      hint="Déduite du sous-total, avant TVA."
                    >
                      <IconAdorned icon={<Icon d={ICONS.amount} className="h-4 w-4" />}>
                        <input
                          id="sale-global-discount"
                          type="number"
                          min={0}
                          step={1000}
                          inputMode="decimal"
                          className="input input-bordered field-rounded min-h-11 w-full bg-base-100 pl-10 pr-14 text-right tabular [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none sm:min-h-0"
                          value={discountAmount}
                          onChange={(event) => setDiscountAmount(event.target.value)}
                          placeholder="0"
                        />
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] font-medium text-base-content/45">
                          {currency}
                        </span>
                      </IconAdorned>
                    </FormField>
                  </div>

                  {isCredit && (
                    <div className="flex items-start gap-2.5 rounded-2xl border border-info/30 bg-info/10 px-3 py-2.5 text-xs leading-relaxed text-info">
                      <Icon d={ICONS.info} className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        Aucun encaissement saisi : la vente sera enregistrée <strong>à crédit</strong>,
                        le stock est débité et le reste à payer suivi dans la liste des ventes.
                      </span>
                    </div>
                  )}
                </Card>

                {/* 6. Montant à encaisser (maquette : aplat primaire, gros montant) */}
                <Card className="min-w-0 space-y-3">
                  <div className="flex items-center justify-between gap-3 rounded-2xl bg-primary/10 px-4 py-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-content shadow-sm">
                        <Icon d={ICONS.amount} className="h-5 w-5" strokeWidth={2} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-primary/80">Montant à encaisser</p>
                        <MoneyText value={totals.paid} bold className="text-2xl text-primary" />
                      </div>
                    </div>
                    {isFullyPaid ? (
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-content shadow-sm"
                        role="img"
                        aria-label="Vente entièrement couverte"
                      >
                        <Icon d={ICONS.check} className="h-5 w-5" strokeWidth={2.4} />
                      </span>
                    ) : (
                      <Badge tone="warning">
                        Reste à payer : {formatCurrency(totals.remaining, currency)}
                      </Badge>
                    )}
                  </div>

                  <div className="flex items-center gap-3 rounded-2xl border border-base-200 px-3.5 py-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
                      <Icon d={ICONS.coins} className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-wide text-base-content/50">
                        Mode de paiement
                      </p>
                      <p className="text-sm font-semibold">{paymentMethod}</p>
                    </div>
                  </div>

                  {!isFullyPaid && (
                    <p className="text-xs text-base-content/60">
                      {isCredit
                        ? 'Vente à crédit — le reste à payer est suivi depuis la liste des ventes.'
                        : 'Encaissement partiel — le reste à payer reste dû par le client.'}
                    </p>
                  )}
                </Card>
              </div>
            </div>

            {formError && (
              <p
                role="alert"
                className="rounded-2xl border border-error/30 bg-error/10 px-4 py-2.5 text-sm text-error"
              >
                {formError}
              </p>
            )}

            {/* Pied d'actions collant : « Enregistrer » reste atteignable sur un
                long formulaire mobile (§5.5 règle 4). */}
            <div className="sticky bottom-0 z-20 -mx-2 flex flex-wrap items-center justify-between gap-3 rounded-t-2xl border-t border-base-200 bg-base-100/95 px-3 py-3 backdrop-blur-sm sm:-mx-4 sm:px-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon d={ICONS.cube} className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-base-content/50">
                    Total à payer
                  </p>
                  <MoneyText value={totals.totalToPay} bold className="text-lg" />
                </div>
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
                  className="btn btn-primary min-h-11 rounded-xl px-5 font-semibold sm:min-h-0"
                  disabled={isSubmitting || !canCreate}
                >
                  {isSubmitting ? (
                    <span className="loading loading-spinner loading-sm" />
                  ) : (
                    <>
                      <Icon d={ICONS.lock} className="h-4 w-4" strokeWidth={2} />
                      Enregistrer la vente
                    </>
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
