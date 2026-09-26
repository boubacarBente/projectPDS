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
 * **Mise en page** : refonte visuelle calée sur la maquette validée par le
 * client, **identique à la page ventes** (gabarits copiés) — en-tête panneau
 * teinté `from-primary/10 to-base-100` avec carré primaire et logo, pastilles
 * d'icônes colorées en tête de carte, ligne produit en grille à colonnes
 * étiquetées (en-tête sur grand écran), suffixe « GNF » dans le champ prix,
 * encadré vert « Stock mis à jour automatiquement », pilules de la carte Notes,
 * rangée pleine largeur « Total à payer » et barre d'actions collée en bas.
 * Deux colonnes sur grand écran, une seule sur mobile : la page ne défile
 * jamais horizontalement — l'ancienne exception `data-entry-table` du README
 * §5.5 n'est plus nécessaire ici, la grille se replie d'elle-même.
 *
 * Le payload `POST /api/achats` (et `PUT /api/achats/[id]`) est **strictement
 * inchangé** : seule la présentation a été refondue.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { BackButton } from '@/components/back-button';
import { DatePicker } from '@/components/date-picker';
import { Tooltip } from '@/components/tooltip';
import { IconAction } from '@/components/row-actions';
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
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';
import { formatCurrency, formatNumber, formatQuantity, today } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Briques visuelles locales (maquette) — copiées de la page ventes,
 * jetons du thème uniquement
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

/** Champ numérique avec suffixe **dans** le champ (« GNF » — maquette). */
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
  /** Caisse / colis « Marchandises achetées ». */
  box: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  notes:
    'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  summary: 'M9 7h6m-6 4h6m-6 4h3M7 3h10a2 2 0 012 2v14a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z',
  supplier: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  payment: 'M3 10h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z',
  amount: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z',
  calendar: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  coins:
    'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z',
  cube: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  lock: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
  stock: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
} as const;

/*
 * Grille d'une ligne produit (maquette, gabarit ventes) : Produit | Qté |
 * Prix d'achat | Total | Actions. Même gabarit pour la ligne d'en-tête et
 * chaque ligne ; en dessous de XL, les champs se replient deux par deux.
 *
 * Largeurs : la colonne **Produit** prend tout le reste (1fr) et les autres
 * colonnes sont fixes et serrées — c'est elle qui porte le nom du produit.
 * Alignement **en haut** (`items-start`) : la cellule produit empile champ +
 * badges de stock, un centrage vertical ferait monter le champ produit.
 */
const LINE_GRID =
  'xl:grid xl:grid-cols-[minmax(0,1fr)_76px_128px_96px_32px] xl:items-start xl:gap-2';

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

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
    // « En attente » (maquette) : rien n'est encore réglé — l'achat repartira
    // en dette fournisseur ; puis « Partiel » et « Payé ».
    if (totals.paid <= 0) return { key: 'unpaid', label: 'En attente', tone: 'error' as const };
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
  const companyLogo = settings.companyLogo || DEFAULT_COMPANY_LOGO;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      {/* ── En-tête de page (maquette : panneau teinté, carré primaire, logo) ── */}
      <header className="rounded-3xl border border-base-200 bg-linear-to-r from-primary/10 to-base-100 p-5 shadow-sm sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-base-content/60">
              <BackButton withMargin={false} />
              <span className="flex items-center gap-1.5">
                <span>Achats</span>
                <span aria-hidden>›</span>
                <span className="font-medium">Nouvel achat</span>
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3 sm:gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-content shadow-sm sm:h-12 sm:w-12">
                <Icon d={ICONS.cart} className="h-6 w-6" strokeWidth={2} />
              </span>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                {isEditing ? 'Modifier un achat' : 'Nouvel achat'}
              </h1>
            </div>
            <p className="mt-2.5 max-w-2xl text-sm leading-6 text-base-content/60">
              Enregistrez vos achats de marchandises, matières premières ou fournitures auprès de
              vos fournisseurs : entrée en stock immédiate et règlement (comptant, acompte ou à
              crédit).
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
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* ── Colonne principale ─────────────────────────────────── */}
            <div className="min-w-0 space-y-5 lg:col-span-2">
              {/* 1. Marchandises achetées */}
              <Card padded={false} className="min-w-0">
                <div className="px-5 pt-5">
                  <CardTitle
                    icon={<Icon d={ICONS.box} />}
                    tone="primary"
                    title="Marchandises achetées"
                    subtitle="Ajoutez les produits ou services achetés"
                    actions={
                      <button
                        type="button"
                        className="btn btn-primary btn-sm h-11 min-h-11 shrink-0 rounded-full px-4 font-semibold sm:h-9 sm:min-h-0"
                        onClick={addLine}
                      >
                        <Icon d="M12 4v16m8-8H4" className="h-4 w-4" strokeWidth={2.2} />
                        Ajouter une ligne
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
                  <span>Prix d&apos;achat</span>
                  <span className="text-right">Total</span>
                  <span />
                </div>

                {/* Les lignes se replient d'elles-mêmes : ni tableau large, ni
                    défilement horizontal, même à 360 px. */}
                <ul className="divide-y divide-base-200">
                  {lines.map((line, index) => {
                    const product = productById.get(Number(line.productId));
                    const computed = computedLines[index];
                    const projectedStock = product ? product.stock + computed.quantity : 0;

                    return (
                      <li key={line.key} className="min-w-0 px-4 py-4 sm:px-5">
                        <div className={`flex min-w-0 flex-wrap items-start gap-x-3 gap-y-3 ${LINE_GRID}`}>
                          {/* Produit : sélecteur + badges de stock. */}
                          <div className="min-w-0 w-full xl:w-auto">
                            <FieldLabel>Produit</FieldLabel>
                            <select
                              className="select select-bordered field-rounded h-11 w-full bg-base-100 font-medium sm:h-9"
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
                            <span className="mt-1.5 flex flex-wrap items-center gap-2">
                              {product ? (
                                <>
                                  {/* Le stock va **augmenter** : on montre l'état
                                      actuel puis l'état après cet achat. */}
                                  <Badge tone="info">
                                    Stock actuel : {formatQuantity(product.stock, product.unit)}
                                  </Badge>
                                  {computed.quantity > 0 && (
                                    <Badge tone="success">
                                      Après achat : {formatQuantity(projectedStock, product.unit)}
                                    </Badge>
                                  )}
                                </>
                              ) : (
                                <span className="text-xs text-base-content/50">
                                  Aucun produit sélectionné
                                </span>
                              )}
                            </span>
                          </div>

                          {/* Quantité : champ simple (maquette achats). */}
                          <div className="min-w-0 grow basis-[calc(50%-0.375rem)] xl:w-auto xl:grow-0 xl:basis-auto">
                            <FieldLabel>Qté</FieldLabel>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              inputMode="decimal"
                              className="input input-bordered field-rounded h-11 w-full bg-base-100 text-center text-sm tabular [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none sm:h-9"
                              value={line.quantity}
                              onChange={(event) =>
                                setLineField(line.key, 'quantity', event.target.value)
                              }
                              aria-label={`Quantité de la ligne ${index + 1}`}
                            />
                          </div>

                          {/* Prix d'achat : suffixe « GNF » dans le champ. */}
                          <div className="min-w-0 grow basis-[calc(50%-0.375rem)] xl:w-auto xl:grow-0 xl:basis-auto">
                            <FieldLabel>Prix d&apos;achat</FieldLabel>
                            <SuffixedInput
                              value={line.unitPrice}
                              onChange={(value) => setLineField(line.key, 'unitPrice', value)}
                              suffix={currency}
                              ariaLabel={`Prix d'achat de la ligne ${index + 1}`}
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

                          {/* Actions : corbeille rouge (maquette). */}
                          <div className="flex w-full shrink-0 flex-row items-center justify-end pt-1 xl:w-auto xl:justify-center xl:pt-0">
                            <IconAction
                              icon="trash"
                              tone="danger"
                              label={
                                lines.length <= 1
                                  ? 'Un achat doit conserver au moins une ligne'
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
                    Ajouter une autre ligne
                  </button>
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm text-base-content/60">Total général</span>
                    <MoneyText value={totals.total} bold className="text-base" />
                  </div>
                </div>
              </Card>

              {/* Encadré vert (maquette) : le stock du produit choisi augmente. */}
              <div className="flex items-start gap-3 rounded-2xl border border-success/30 bg-success/10 px-4 py-3 text-success">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-success/15">
                  <Icon d={ICONS.stock} className="h-5 w-5" strokeWidth={1.6} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Stock mis à jour automatiquement</p>
                  <p className="mt-0.5 text-xs leading-relaxed">
                    Le stock du produit sélectionné sera automatiquement augmenté après
                    l&apos;enregistrement de cet achat. Chaque ligne crée une <strong>entrée</strong>{' '}
                    de stock motivée « achat … » ; un achat n&apos;est jamais refusé pour cause de
                    rupture. Les frais de fonctionnement (transport, loyer…) sont des{' '}
                    <strong>dépenses</strong>, pas des achats — ils ne touchent pas le stock.
                  </p>
                </div>
              </div>

              {/* 2. Notes */}
              <Card className="min-w-0 space-y-4">
                <CardTitle
                  icon={<Icon d={ICONS.notes} />}
                  tone="accent"
                  title="Notes"
                  subtitle="Informations supplémentaires sur la facture ou l’achat"
                />

                <textarea
                  id="purchase-notes"
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
                  {['Bon de commande', 'Référence fournisseur', 'Transporteur', 'Autres notes'].map(
                    (pill) => (
                      <span
                        key={pill}
                        className="badge-pill border border-base-300 bg-base-200/60 px-3 py-1.5 text-xs font-medium text-base-content/70"
                      >
                        {pill}
                      </span>
                    ),
                  )}
                </div>
              </Card>

              {/* 3. Récapitulatif — un achat ne porte ni remise ni TVA (§6.3) :
                  pas de lignes « Frais de transport », « Total HT » ni « TVA »
                  ici, il n'existe aucun champ correspondant. */}
              <Card className="min-w-0 space-y-3">
                <CardTitle
                  icon={<Icon d={ICONS.summary} />}
                  tone="success"
                  title="Récapitulatif"
                  subtitle="Aperçu de votre achat"
                />

                <div className="space-y-1.5 pt-1">
                  <RecapRow label="Sous-total">
                    <MoneyText value={totals.total} />
                  </RecapRow>
                </div>

                {/* Rangée pleine largeur « Total à payer » (maquette). */}
                <div className="flex items-center justify-between gap-3 rounded-xl bg-success/15 px-4 py-3">
                  <span className="text-base font-bold text-success">Total à payer</span>
                  <MoneyText value={totals.total} bold className="text-xl text-success" />
                </div>
              </Card>
            </div>

            {/* ── Colonne latérale ───────────────────────────────────── */}
            <div className="min-w-0 space-y-5">
              {/* 4. Fournisseur */}
              <Card className="min-w-0 space-y-4">
                <CardTitle
                  icon={<Icon d={ICONS.supplier} />}
                  tone="info"
                  title="Fournisseur"
                  subtitle="Fournisseur de l’achat"
                />

                <FormField
                  label="Fournisseur"
                  htmlFor="purchase-supplier"
                  required
                  hint="Obligatoire : c’est le fournisseur qui est l’auteur de la facture ou du bon de livraison — c’est la dette fournisseur qui est suivie (§15)."
                >
                  <select
                    id="purchase-supplier"
                    className="select select-bordered field-rounded min-h-11 w-full bg-base-100 font-medium sm:min-h-0"
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
                  /* Fiche « Fournisseur sélectionné » (gabarit ventes). */
                  <div className="rounded-2xl border border-base-200 bg-base-200/40 p-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                        {selectedSupplier.name.trim().charAt(0).toUpperCase() || '?'}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{selectedSupplier.name}</p>
                        {selectedSupplier.phone && (
                          <p className="mt-0.5 text-xs tabular text-base-content/60">
                            {selectedSupplier.phone}
                          </p>
                        )}
                      </div>
                    </div>
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
                    className="input input-bordered field-rounded min-h-11 w-full bg-base-100 sm:min-h-0"
                    value={supplierReference}
                    onChange={(event) => setSupplierReference(event.target.value)}
                    placeholder="Ex. FA-2026-0142"
                    autoComplete="off"
                  />
                </FormField>
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
                  <FormField label="Date de l’achat" htmlFor="purchase-date" required>
                    <DatePicker value={date} onChange={setDate} placeholder="jj/mm/aaaa" />
                  </FormField>

                  <FormField label="Moyen de paiement" htmlFor="purchase-payment-method" required>
                    <div className="relative">
                      <span
                        className="pointer-events-none absolute left-3 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-base-content/40"
                        aria-hidden
                      >
                        <Icon d={ICONS.payment} className="h-4 w-4" />
                      </span>
                      <select
                        id="purchase-payment-method"
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
                    </div>
                  </FormField>

                  <FormField
                    label={`Montant payé (${currency})`}
                    htmlFor="purchase-amount-paid"
                    hint={
                      isEditing
                        ? 'Ne peut pas être réduit : annulez l’achat pour contre-passer la caisse.'
                        : '0 = achat à crédit (dette fournisseur).'
                    }
                  >
                    <div className="relative">
                      <span
                        className="pointer-events-none absolute left-3 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-base-content/40"
                        aria-hidden
                      >
                        <Icon d={ICONS.coins} className="h-4 w-4" />
                      </span>
                      <input
                        id="purchase-amount-paid"
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
                    </div>
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
                  <div className="flex items-start gap-2.5 rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
                    <Icon d={ICONS.amount} className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Il restera <strong>{formatCurrency(totals.remaining, currency)}</strong> à
                      régler : l&apos;achat alimente la <strong>dette fournisseur</strong>, suivie
                      dans la fiche du fournisseur et dans la liste des achats.
                    </span>
                  </div>
                )}
              </Card>

              {/* 6. Totaux */}
              <Card className="min-w-0 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">Totaux</h2>
                  <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                </div>

                <div className="space-y-1.5 pt-1">
                  <RecapRow label="Sous-total">
                    <MoneyText value={totals.total} />
                  </RecapRow>
                </div>

                {/* Rangée pleine largeur « Total à payer » (maquette). */}
                <div className="flex items-center justify-between gap-3 rounded-xl bg-success/15 px-4 py-3">
                  <span className="text-base font-bold text-success">Total à payer</span>
                  <MoneyText value={totals.total} bold className="text-xl text-success" />
                </div>

                <InfoRow label="Lignes">
                  <span className="tabular">{formatNumber(buildPayloadLines().length)}</span>
                </InfoRow>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <MiniStat
                    label="PAYÉ"
                    tone={totals.paid > 0 ? 'success' : 'neutral'}
                    value={<MoneyText value={totals.paid} />}
                  />
                  <MiniStat
                    label="RESTE À PAYER"
                    tone={totals.remaining > 0.001 ? 'error' : 'success'}
                    value={<MoneyText value={totals.remaining} colored bold />}
                  />
                </div>
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
              long formulaire mobile (§5.5 règle 4). La page n'a jamais eu de
              bouton « Imprimer le reçu » : on ne l'invente pas. */}
          <div className="sticky bottom-0 z-20 -mx-2 flex flex-wrap items-center justify-between gap-3 rounded-t-2xl border-t border-base-200 bg-base-100/95 px-3 py-3 backdrop-blur-sm sm:-mx-4 sm:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon d={ICONS.coins} className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-base-content/50">
                  Total à payer
                </p>
                <MoneyText value={totals.total} bold className="text-lg" />
              </div>
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
              <Tooltip
                label={
                  isEditing
                    ? 'L’enregistrement ajuste le stock par différence et met à jour la dette fournisseur.'
                    : 'L’enregistrement augmente automatiquement le stock des produits achetés.'
                }
              >
                <button
                  type="submit"
                  className="btn btn-primary min-h-11 rounded-xl px-5 font-semibold sm:min-h-0"
                  disabled={isSubmitting || (isEditing ? !canUpdate : !canCreate)}
                >
                  {isSubmitting ? (
                    <span className="loading loading-spinner loading-sm" />
                  ) : (
                    <>
                      <Icon d={ICONS.lock} className="h-4 w-4" strokeWidth={2} />
                      {isEditing ? 'Enregistrer les modifications' : 'Enregistrer l’achat'}
                    </>
                  )}
                </button>
              </Tooltip>
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
