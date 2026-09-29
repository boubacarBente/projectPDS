'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ToolbarButton } from '@/components/data-toolbar';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { IconAction, RowActions } from '@/components/row-actions';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  EmptyState,
  FormField,
  InfoRow,
  MiniStat,
  MoneyText,
  QuantityText,
  SkeletonTable,
  type BadgeTone,
} from '@/components/design-system';
import {
  WORKER_ROLE_OPTIONS,
  WorkersManagerModal,
  readApiError,
  type WorkerRow,
} from '@/components/workers/workers-modals';
import { usePermission } from '@/components/role-gate';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, formatPercent, formatQuantity, today } from '@/lib/format';

/* ==================================================================
 * Composants propres au domaine « Briqueterie » (§2 : components/briqueterie/).
 *
 * ⚠️ Types et libellés sont **redéclarés ici** plutôt qu'importés de
 * `lib/brick.ts` : ce fichier est un composant client, et `lib/brick.ts` importe
 * `@/db` (donc `@libsql/client`, `fs`, `path`). Un import — même partiel —
 * ferait entrer la chaîne base de données dans le bundle navigateur
 * (CONVENTIONS §11 bis). Les formes ci-dessous décrivent exactement le JSON
 * renvoyé par `/api/briqueterie/*`.
 *
 * Aucune écriture ne part d'ici autrement que par l'API : la page ne touche
 * jamais `products.stock`, tout passe par `lib/stock.ts` côté serveur.
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * Types (miroir du JSON de l'API)
 * ------------------------------------------------------------------ */

export type BrickStage = 'molding' | 'drying' | 'firing' | 'stored';
export type BrickShape = 'solid' | 'hollow' | 'block';

/** Statut de la fiche de production : enregistrée, terminée (en stock) ou annulée. */
export type BrickProductionStatus = 'registered' | 'finished' | 'cancelled';

export type BrickTypeRow = {
  id: number;
  productId: number;
  name: string;
  shape: BrickShape;
  dimensions: string | null;
  description: string | null;
  isActive: boolean;
  /** Produit lié : il porte le prix de vente **et** le stock des briques finies. */
  productName: string;
  unit: string;
  salePrice: number;
  purchasePrice: number;
  stock: number;
  productionsCount: number;
  createdAt: string | null;
};

export type BrickProductionRow = {
  id: number;
  batchNumber: string;
  brickTypeId: number;
  brickTypeName: string;
  shape: BrickShape;
  dimensions: string | null;
  productId: number;
  productName: string;
  productUnit: string;
  plannedQuantity: number;
  producedQuantity: number;
  brokenQuantity: number;
  startDate: string | null;
  endDate: string | null;
  stage: BrickStage;
  status: BrickProductionStatus;
  /** Équipe ou responsable de production (texte libre). */
  team: string | null;
  materialCost: number;
  laborCost: number;
  /** Somme des dépenses rattachées au lot. */
  expenseCost: number;
  totalCost: number;
  /** Calculé : `total_cost ÷ (produced − broken)` — jamais stocké. */
  unitCost: number;
  /** Vrai si le stock de briques finies a **déjà** été crédité. */
  stored: boolean;
  materialsCount: number;
  workersCount: number;
  /** Nombre de dépenses rattachées. */
  expensesCount: number;
  userId: number | null;
  userName: string | null;
  notes: string | null;
  isCancelled: boolean;
  cancelReason: string | null;
  cancelledAt: string | null;
  createdAt: string | null;
};

export type BrickProductionMaterialRow = {
  id: number;
  productionId: number;
  productId: number | null;
  productName: string;
  unit: string;
  quantity: number;
  unitCost: number;
  amount: number;
  createdAt: string | null;
};

/**
 * Dépense rattachée à un lot — vue « production » de la table `expenses`.
 *
 * Depuis la révision §20, **il n'y a plus de module de matières premières** : le
 * ciment, le sable, le carburant, l'électricité ou la main-d'œuvre ponctuelle sont
 * des dépenses rattachées à la fabrication, avec une catégorie métier fermée.
 */
export type BrickProductionExpenseRow = {
  id: number;
  productionId: number;
  category: string;
  description: string | null;
  amount: number;
  paymentMethod: string;
  beneficiary: string | null;
  /** Date métier `YYYY-MM-DD`. */
  date: string;
  userId: number | null;
  userName: string | null;
  cancelled: boolean;
  createdAt: string | null;
};

/** Catégories fermées des dépenses de production (miroir de `lib/expenses.ts`). */
export const PRODUCTION_EXPENSE_CATEGORIES = [
  'Ciment',
  'Sable',
  'Argile / terre',
  'Bois de chauffe',
  'Carburant',
  "Main-d'œuvre",
  'Électricité',
  'Eau',
  'Transport',
  'Entretien',
  'Autre',
] as const;

export type BrickProductionWorkerRow = {
  id: number;
  productionId: number;
  workerId: number | null;
  workerName: string;
  role: string | null;
  days: number;
  dailyRate: number;
  amount: number;
  createdAt: string | null;
};

export type ProductionCosts = {
  /** Matières premières **historiques** (lots antérieurs à la révision §20). */
  materialCost: number;
  laborCost: number;
  /** Dépenses rattachées au lot — la source de coût de la fiche. */
  expenseCost: number;
  totalCost: number;
  producedQuantity: number;
  brokenQuantity: number;
  goodQuantity: number;
  unitCost: number;
};

export type BrickProductionDetail = {
  production: BrickProductionRow;
  brickType: BrickTypeRow | null;
  product: {
    id: number;
    name: string;
    unit: string;
    stock: number;
    salePrice: number;
  } | null;
  materials: BrickProductionMaterialRow[];
  workers: BrickProductionWorkerRow[];
  expenses: BrickProductionExpenseRow[];
  costs: ProductionCosts;
};

export type BrickSummary = {
  from: string | null;
  to: string | null;
  productionsCount: number;
  produced: number;
  broken: number;
  good: number;
  sold: number;
  soldRevenue: number;
  materialsCost: number;
  laborCost: number;
  expensesCost: number;
  totalCost: number;
  averageUnitCost: number;
  byType: {
    brickTypeId: number;
    brickTypeName: string;
    produced: number;
    broken: number;
    sold: number;
    unitCost: number;
  }[];
};

export type Paginated<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export { readApiError };

/* ------------------------------------------------------------------ *
 * Libellés français — jamais la couleur seule (§5.3)
 * ------------------------------------------------------------------ */

export const BRICK_STAGE_LABELS: Record<BrickStage, string> = {
  molding: 'Moulage',
  drying: 'Séchage',
  firing: 'Cuisson',
  stored: 'En stock',
};

export const BRICK_STAGE_TONES: Record<BrickStage, BadgeTone> = {
  molding: 'neutral',
  drying: 'info',
  firing: 'warning',
  stored: 'success',
};

export const BRICK_STAGE_OPTIONS: { value: BrickStage; label: string }[] = (
  ['molding', 'drying', 'firing', 'stored'] as BrickStage[]
).map((value) => ({ value, label: BRICK_STAGE_LABELS[value] }));

export const BRICK_SHAPE_LABELS: Record<BrickShape, string> = {
  solid: 'Pleine',
  hollow: 'Creuse',
  block: 'Parpaing',
};

export const BRICK_SHAPE_OPTIONS: { value: BrickShape; label: string }[] = (
  ['solid', 'hollow', 'block'] as BrickShape[]
).map((value) => ({ value, label: BRICK_SHAPE_LABELS[value] }));

export function brickStageLabel(stage: string | null | undefined): string {
  if (!stage) return '—';
  return BRICK_STAGE_LABELS[stage as BrickStage] ?? stage;
}

export const BRICK_PRODUCTION_STATUS_LABELS: Record<BrickProductionStatus, string> = {
  registered: 'Enregistrée',
  finished: 'Terminée',
  cancelled: 'Annulée',
};

export const BRICK_PRODUCTION_STATUS_TONES: Record<BrickProductionStatus, BadgeTone> = {
  registered: 'info',
  finished: 'success',
  cancelled: 'error',
};

export function brickProductionStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return BRICK_PRODUCTION_STATUS_LABELS[status as BrickProductionStatus] ?? status;
}

export const BRICK_PRODUCTION_STATUS_OPTIONS: { value: BrickProductionStatus; label: string }[] = (
  ['registered', 'finished', 'cancelled'] as BrickProductionStatus[]
).map((value) => ({ value, label: BRICK_PRODUCTION_STATUS_LABELS[value] }));

export function brickShapeLabel(shape: string | null | undefined): string {
  if (!shape) return '—';
  return BRICK_SHAPE_LABELS[shape as BrickShape] ?? shape;
}

/** Étapes affichées par `StageTracker` : moulage → séchage → cuisson → stock. */
export const BRICK_STAGES = [
  { key: 'molding', label: 'Moulage' },
  { key: 'drying', label: 'Séchage au soleil' },
  { key: 'firing', label: 'Cuisson au four' },
  { key: 'stored', label: 'Mise en stock' },
];

/** Étape suivante, ou `null` si le lot est déjà en stock (dernière étape). */
export function nextBrickStage(stage: BrickStage): { key: BrickStage; label: string } | null {
  const index = BRICK_STAGES.findIndex((entry) => entry.key === stage);
  if (index < 0 || index >= BRICK_STAGES.length - 1) return null;
  return BRICK_STAGES[index + 1] as { key: BrickStage; label: string };
}

/** Briques réellement vendables d'un lot : `produit − cassé`, jamais négatif. */
export function goodQuantityOf(production: {
  producedQuantity: number;
  brokenQuantity: number;
}): number {
  return Math.max(0, Math.round((production.producedQuantity - production.brokenQuantity) * 1000) / 1000);
}

/* ------------------------------------------------------------------ *
 * Options de sélection
 * ------------------------------------------------------------------ */

export type ProductOption = {
  id: number;
  name: string;
  unit: string;
  purchasePrice: number;
  salePrice: number;
  stock: number;
};

/**
 * Charge une seule fois les listes d'appoint (types de briques, produits,
 * ouvriers). Aucune n'est critique : un échec laisse la sélection vide sans
 * masquer la page.
 */
export function useBrickSelectOptions(enabled: boolean) {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();

    async function load() {
      setIsLoading(true);
      try {
        const [productsResponse, workersResponse] = await Promise.all([
          fetch('/api/produits?limit=500&page=1', {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'same-origin',
          }),
          fetch('/api/workers?limit=200&page=1', {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'same-origin',
          }),
        ]);

        if (controller.signal.aborted) return;

        if (productsResponse.ok) {
          const payload = (await productsResponse.json()) as Paginated<any>;
          setProducts(
            (payload.data ?? []).map((product: any) => ({
              id: Number(product.id),
              name: String(product.name ?? ''),
              unit: String(product.unit ?? 'pièce'),
              purchasePrice: Number(product.purchasePrice ?? 0),
              salePrice: Number(product.salePrice ?? 0),
              stock: Number(product.stock ?? 0),
            })),
          );
        }
        if (workersResponse.ok) {
          const payload = (await workersResponse.json()) as Paginated<WorkerRow>;
          setWorkers(Array.isArray(payload.data) ? payload.data : []);
        }
      } catch {
        // Listes d'appoint : leur échec ne doit pas faire échouer la page.
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [enabled]);

  return { products, workers, isLoading };
}

/* ------------------------------------------------------------------ *
 * Colonnes partagées
 * ------------------------------------------------------------------ */

export const brickProductionColumns: Column<BrickProductionRow>[] = [
  {
    key: 'startDate',
    label: 'Début',
    className: 'whitespace-nowrap',
    render: (production) => (
      <span className="tabular text-base-content/70">{formatDateShort(production.startDate)}</span>
    ),
  },
  {
    key: 'batchNumber',
    label: 'Lot',
    primary: true,
    render: (production) => (
      <div className="min-w-0">
        <div className="font-mono text-sm font-semibold">{production.batchNumber}</div>
        <div className="truncate text-xs text-base-content/50">{production.brickTypeName}</div>
      </div>
    ),
  },
  {
    key: 'shape',
    label: 'Forme',
    render: (production) => <Badge tone="primary">{brickShapeLabel(production.shape)}</Badge>,
  },
  {
    key: 'dimensions',
    label: 'Dimensions',
    hideOnMobile: true,
    render: (production) => <span className="text-sm">{production.dimensions || '—'}</span>,
  },
  {
    key: 'stage',
    label: 'Étape',
    render: (production) => (
      <div className="flex flex-col items-start gap-1">
        <Badge tone={BRICK_STAGE_TONES[production.stage]}>
          {brickStageLabel(production.stage)}
        </Badge>
        {production.stored && <span className="text-[11px] text-success">Stock crédité</span>}
      </div>
    ),
  },
  {
    // Le statut est une information métier (« enregistrée / terminée / annulée »),
    // distincte de l'étape : un lot annulé garde son étape d'origine.
    key: 'status',
    label: 'Statut',
    render: (production) => (
      <Badge tone={BRICK_PRODUCTION_STATUS_TONES[production.status]}>
        {brickProductionStatusLabel(production.status)}
      </Badge>
    ),
  },
  {
    key: 'team',
    label: 'Équipe',
    hideOnMobile: true,
    render: (production) => (
      <span className="text-sm text-base-content/70">{production.team || '—'}</span>
    ),
  },
  {
    key: 'quantities',
    label: 'Briques',
    render: (production) => (
      <div className="space-y-0.5">
        <div>
          <span className="text-xs text-base-content/50">Bonnes : </span>
          <QuantityText value={goodQuantityOf(production)} unit={production.productUnit} />
        </div>
        <div>
          <span className="text-xs text-base-content/50">Cassées : </span>
          <QuantityText
            value={production.brokenQuantity}
            unit={production.productUnit}
            className={production.brokenQuantity > 0 ? 'text-warning' : ''}
          />
        </div>
      </div>
    ),
  },
  {
    key: 'unitCost',
    label: 'Coût de revient',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (production) => (
      <div className="text-right">
        <MoneyText value={production.unitCost} bold />
        <div className="text-[11px] text-base-content/50">par brique</div>
      </div>
    ),
  },
  {
    key: 'totalCost',
    label: 'Coût total',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (production) => <MoneyText value={production.totalCost} />,
  },
];

export const brickTypeColumns: Column<BrickTypeRow>[] = [
  {
    key: 'name',
    label: 'Type de brique',
    primary: true,
    render: (type) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{type.name}</div>
        <div className="text-xs text-base-content/50">
          {brickShapeLabel(type.shape)}
          {type.dimensions ? ` · ${type.dimensions}` : ''}
        </div>
      </div>
    ),
  },
  {
    key: 'product',
    label: 'Produit lié',
    render: (type) => (
      <div className="min-w-0">
        <div className="truncate text-sm">{type.productName}</div>
      </div>
    ),
  },
  {
    key: 'stock',
    label: 'Stock fini',
    render: (type) => (
      <QuantityText
        value={type.stock}
        unit={type.unit}
        className={type.stock <= 0 ? 'text-error' : ''}
      />
    ),
  },
  {
    key: 'salePrice',
    label: 'Prix de vente',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (type) => <MoneyText value={type.salePrice} />,
  },
  {
    key: 'productionsCount',
    label: 'Lots',
    hideOnMobile: true,
    render: (type) => <span className="tabular">{type.productionsCount}</span>,
  },
  {
    key: 'state',
    label: 'État',
    render: (type) =>
      type.isActive ? <Badge tone="success">Actif</Badge> : <Badge tone="neutral">Inactif</Badge>,
  },
];

export const productionMaterialColumns: Column<BrickProductionMaterialRow>[] = [
  {
    key: 'product',
    label: 'Matière première',
    primary: true,
    render: (material) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{material.productName}</div>
      </div>
    ),
  },
  {
    key: 'quantity',
    label: 'Quantité',
    render: (material) => <QuantityText value={material.quantity} unit={material.unit} />,
  },
  {
    key: 'unitCost',
    label: 'Coût unitaire',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (material) => <MoneyText value={material.unitCost} />,
  },
  {
    key: 'amount',
    label: 'Montant',
    className: 'text-right whitespace-nowrap',
    render: (material) => <MoneyText value={material.amount} bold />,
  },
];

export const productionWorkerColumns: Column<BrickProductionWorkerRow>[] = [
  {
    key: 'workerName',
    label: 'Ouvrier',
    primary: true,
    render: (assignment) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{assignment.workerName}</div>
        <div className="text-xs text-base-content/50">
          {assignment.role || 'Rôle non précisé'}
          {assignment.workerId === null && ' · journalier ponctuel'}
        </div>
      </div>
    ),
  },
  {
    key: 'days',
    label: 'Jours',
    render: (assignment) => <span className="tabular">{formatQuantity(assignment.days)}</span>,
  },
  {
    key: 'dailyRate',
    label: 'Tarif / jour',
    hideOnMobile: true,
    className: 'text-right whitespace-nowrap',
    render: (assignment) => <MoneyText value={assignment.dailyRate} />,
  },
  {
    key: 'amount',
    label: 'Montant',
    className: 'text-right whitespace-nowrap',
    render: (assignment) => <MoneyText value={assignment.amount} bold />,
  },
];

/**
 * Colonnes des **dépenses rattachées à un lot**.
 *
 * L'ordre suit la règle du dépôt (§8) : la date propre de la ligne d'abord, puis
 * la catégorie (information principale), le libellé, le moyen de paiement et le
 * montant.
 */
export const productionExpenseColumns: Column<BrickProductionExpenseRow>[] = [
  {
    key: 'date',
    label: 'Date',
    className: 'whitespace-nowrap',
    render: (expense) => (
      <span className="tabular text-base-content/70">{formatDateShort(expense.date)}</span>
    ),
  },
  {
    key: 'category',
    label: 'Catégorie',
    primary: true,
    render: (expense) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{expense.category}</div>
        {expense.description && (
          <div className="truncate text-xs text-base-content/50">{expense.description}</div>
        )}
      </div>
    ),
  },
  {
    key: 'beneficiary',
    label: 'Bénéficiaire',
    hideOnMobile: true,
    render: (expense) => <span className="text-sm">{expense.beneficiary || '—'}</span>,
  },
  {
    key: 'paymentMethod',
    label: 'Moyen',
    hideOnMobile: true,
    render: (expense) => <Badge tone="neutral">{expense.paymentMethod}</Badge>,
  },
  {
    key: 'userName',
    label: 'Saisie par',
    hideOnMobile: true,
    render: (expense) => <span className="text-sm text-base-content/70">{expense.userName || '—'}</span>,
  },
  {
    key: 'amount',
    label: 'Montant',
    className: 'text-right whitespace-nowrap',
    render: (expense) => <MoneyText value={expense.amount} bold />,
  },
];

/* ------------------------------------------------------------------ *
 * Modale — nouveau lot de fabrication
 * ------------------------------------------------------------------ */

export function BrickProductionModal({
  isOpen,
  onClose,
  onSaved,
  brickTypes,
  isOptionsLoading,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (production: BrickProductionRow) => void;
  brickTypes: BrickTypeRow[];
  isOptionsLoading: boolean;
}) {
  const [brickTypeId, setBrickTypeId] = useState('');
  const [plannedQuantity, setPlannedQuantity] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [team, setTeam] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setBrickTypeId('');
    setPlannedQuantity('');
    setStartDate(today());
    setTeam('');
    setNotes('');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen]);

  const selected = useMemo(
    () => brickTypes.find((type) => String(type.id) === brickTypeId) ?? null,
    [brickTypes, brickTypeId],
  );

  async function submit() {
    if (isSubmitting) return;

    if (!selected) {
      setFormError('Sélectionnez le type de brique à fabriquer.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/briqueterie/productions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          brickTypeId: selected.id,
          plannedQuantity: Number(String(plannedQuantity).replace(',', '.')) || 0,
          startDate: startDate || null,
          team: team.trim() || null,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Le lot n’a pas pu être créé.'));
      }

      const saved = (await response.json()) as BrickProductionRow;
      toast.success(`Lot ${saved.batchNumber} lancé au moulage.`);
      onSaved(saved);
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Le lot n’a pas pu être créé.';
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
      title="Nouveau lot de fabrication"
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
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          Le lot naît à l’étape <strong>moulage</strong>. Les <strong>dépenses de fabrication</strong>{' '}
          (ciment, sable, carburant, main-d’œuvre…) et l’équipe s’ajoutent depuis sa fiche : chaque
          dépense sort de la caisse, et les briques finies n’entrent en stock qu’à l’étape{' '}
          <strong>mise en stock</strong> — une seule fois.
        </p>

        <FormField label="Type de brique" htmlFor="brick-type" required>
          {isOptionsLoading && brickTypes.length === 0 ? (
            <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
          ) : brickTypes.length === 0 ? (
            <p className="rounded-lg border border-base-200 bg-base-200/50 px-3 py-2 text-sm text-base-content/60">
              Aucun type de brique actif. Créez d’abord un type dans « Types de briques ».
            </p>
          ) : (
            <select
              id="brick-type"
              className="select select-bordered min-h-11 w-full"
              value={brickTypeId}
              onChange={(event) => {
                setBrickTypeId(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
            >
              <option value="">— Sélectionner un type —</option>
              {brickTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                  {type.dimensions ? ` — ${type.dimensions}` : ''} ({brickShapeLabel(type.shape)})
                </option>
              ))}
            </select>
          )}
        </FormField>

        {selected && (
          <div className="grid gap-x-6 gap-y-1 rounded-xl border border-base-200 px-4 py-3 sm:grid-cols-2">
            <InfoRow label="Produit lié">{selected.productName}</InfoRow>
            <InfoRow label="Stock de briques">
              <QuantityText value={selected.stock} unit={selected.unit} />
            </InfoRow>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Quantité prévue"
            htmlFor="brick-planned"
            required
            hint="Objectif du lot, en nombre de briques."
          >
            <input
              id="brick-planned"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={plannedQuantity}
              onChange={(event) => {
                setPlannedQuantity(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>

          <FormField label="Date de début" hint="Date métier du lot (filtres de période).">
            <DatePicker value={startDate} onChange={setStartDate} placeholder="Date de début" />
          </FormField>
        </div>

        <FormField
          label="Équipe ou responsable de production"
          htmlFor="brick-team"
          hint="Qui fabrique ce lot (ex. « Équipe A — Mamadou »)."
        >
          <input
            id="brick-team"
            type="text"
            maxLength={120}
            className="input input-bordered min-h-11 w-full"
            value={team}
            onChange={(event) => setTeam(event.target.value)}
            disabled={isSubmitting}
            placeholder="Équipe A — Mamadou"
          />
        </FormField>

        <FormField label="Notes de fabrication" htmlFor="brick-notes">
          <textarea
            id="brick-notes"
            className="textarea textarea-bordered min-h-20 w-full"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            disabled={isSubmitting}
            placeholder="Ex. argile du site de Dubréka, four n°2…"
          />
        </FormField>

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
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
                Lancement…
              </>
            ) : (
              'Lancer la fabrication'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — ajout d'une matière première (contrôle de stock)
 * ------------------------------------------------------------------ */

export function ProductionMaterialModal({
  isOpen,
  onClose,
  productionId,
  batchNumber,
  products,
  isOptionsLoading,
  onAdded,
}: {
  isOpen: boolean;
  onClose: () => void;
  productionId: number;
  batchNumber: string;
  products: ProductOption[];
  isOptionsLoading: boolean;
  onAdded: () => void;
}) {
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setProductId('');
    setQuantity('');
    setUnitCost('');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen]);

  const selected = useMemo(
    () => products.find((product) => String(product.id) === productId) ?? null,
    [products, productId],
  );

  const parsedQuantity = Number(String(quantity).replace(',', '.'));
  const quantityValid = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
  const parsedCost =
    unitCost === '' ? (selected?.purchasePrice ?? 0) : Number(String(unitCost).replace(',', '.'));
  const costValid = Number.isFinite(parsedCost) && parsedCost >= 0;
  const amount = quantityValid && costValid ? parsedQuantity * parsedCost : 0;
  const insufficient = Boolean(selected) && quantityValid && parsedQuantity > selected!.stock;

  async function submit() {
    if (isSubmitting) return;

    if (!selected) {
      setFormError('Sélectionnez la matière première à consommer.');
      return;
    }
    if (!quantityValid) {
      setFormError('Saisissez une quantité strictement positive.');
      return;
    }
    if (insufficient) {
      setFormError(
        `Stock insuffisant : ${selected.name} (disponible ${formatQuantity(selected.stock, selected.unit)}).`,
      );
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/briqueterie/productions/${productionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'add_material',
          productId: selected.id,
          quantity: parsedQuantity,
          unitCost: parsedCost,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'La matière première n’a pas pu être ajoutée.'));
      }

      toast.success(
        `${formatQuantity(parsedQuantity, selected.unit)} de ${selected.name} sortis du stock pour le lot ${batchNumber}.`,
      );
      onAdded();
      onClose();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'La matière première n’a pas pu être ajoutée.';
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
      title={`Matières premières — ${batchNumber}`}
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
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          L’ajout déduit immédiatement le stock par un mouvement <strong>sortie</strong> motivé
          (« production {batchNumber} : … »). Le code, le nom et l’unité du produit sont figés sur la
          ligne : le lot reste lisible même si le catalogue change.
        </p>

        <FormField label="Matière première" htmlFor="production-material-product" required>
          {isOptionsLoading && products.length === 0 ? (
            <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
          ) : (
            <select
              id="production-material-product"
              className="select select-bordered min-h-11 w-full"
              value={productId}
              onChange={(event) => {
                const value = event.target.value;
                setProductId(value);
                const product = products.find((p) => String(p.id) === value);
                setUnitCost(product ? String(product.purchasePrice) : '');
                setFormError(null);
              }}
              disabled={isSubmitting}
            >
              <option value="">— Sélectionner un produit —</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({formatQuantity(product.stock, product.unit)} en stock)
                </option>
              ))}
            </select>
          )}
        </FormField>

        {selected && (
          <div className="grid gap-x-6 gap-y-1 rounded-xl border border-base-200 px-4 py-3 sm:grid-cols-2">
            <InfoRow label="Unité">{selected.unit}</InfoRow>
            <InfoRow label="Stock disponible">
              <QuantityText value={selected.stock} unit={selected.unit} />
            </InfoRow>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Quantité consommée"
            htmlFor="production-material-quantity"
            required
            hint="Décimale acceptée (kg, m³, litre…)."
          >
            <input
              id="production-material-quantity"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={quantity}
              onChange={(event) => {
                setQuantity(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>

          <FormField
            label="Coût unitaire (prix d’achat)"
            htmlFor="production-material-cost"
            hint="Base du coût de revient du lot."
          >
            <input
              id="production-material-cost"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={unitCost}
              onChange={(event) => {
                setUnitCost(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>
        </div>

        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            insufficient ? 'border-error/30 bg-error/10 text-error' : 'border-info/30 bg-info/10'
          }`}
          role="status"
          aria-live="polite"
        >
          {insufficient ? (
            <span>
              <strong>Stock insuffisant :</strong>{' '}
              {formatQuantity(selected?.stock ?? 0, selected?.unit)} disponible,{' '}
              {formatQuantity(parsedQuantity, selected?.unit)} demandé.
            </span>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Montant de la ligne</span>
              <MoneyText value={amount} bold />
            </div>
          )}
        </div>

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button
            type="submit"
            className="btn btn-primary min-h-11"
            disabled={isSubmitting || products.length === 0}
          >
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Sortie du stock…
              </>
            ) : (
              'Ajouter la matière'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — affectation d'un ouvrier
 * ------------------------------------------------------------------ */

export function ProductionWorkerModal({
  isOpen,
  onClose,
  productionId,
  batchNumber,
  workers,
  isOptionsLoading,
  onAdded,
}: {
  isOpen: boolean;
  onClose: () => void;
  productionId: number;
  batchNumber: string;
  workers: WorkerRow[];
  isOptionsLoading: boolean;
  onAdded: () => void;
}) {
  const [workerId, setWorkerId] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [role, setRole] = useState('worker');
  const [days, setDays] = useState('');
  const [dailyRate, setDailyRate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setWorkerId('');
    setWorkerName('');
    setRole('worker');
    setDays('');
    setDailyRate('');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen]);

  const parsedDays = Number(String(days).replace(',', '.'));
  const parsedRate = Number(String(dailyRate).replace(',', '.'));
  const daysValid = Number.isFinite(parsedDays) && parsedDays > 0;
  const amount = daysValid && Number.isFinite(parsedRate) ? parsedDays * parsedRate : 0;

  async function submit() {
    if (isSubmitting) return;

    if (!workerId && !workerName.trim()) {
      setFormError('Choisissez un ouvrier enregistré ou saisissez le nom d’un journalier.');
      return;
    }
    if (!daysValid) {
      setFormError('Saisissez un nombre de jours strictement positif.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/briqueterie/productions/${productionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'add_worker',
          workerId: workerId ? Number(workerId) : null,
          workerName: workerName.trim() || null,
          role,
          days: parsedDays,
          dailyRate: Number.isFinite(parsedRate) ? parsedRate : 0,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'L’affectation n’a pas pu être enregistrée.'));
      }

      toast.success(`Affectation enregistrée sur le lot ${batchNumber}.`);
      onAdded();
      onClose();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'L’affectation n’a pas pu être enregistrée.';
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
      title={`Équipe — ${batchNumber}`}
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
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          Le montant vaut <strong>jours × tarif journalier</strong> et alimente la main-d’œuvre du
          lot, donc son coût de revient. Un <strong>journalier ou un apprenti</strong> non enregistré
          se saisit directement par son nom.
        </p>

        <FormField
          label="Ouvrier enregistré"
          htmlFor="production-worker"
          hint="Facultatif : laissez vide pour un journalier ponctuel."
        >
          {isOptionsLoading && workers.length === 0 ? (
            <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
          ) : (
            <select
              id="production-worker"
              className="select select-bordered min-h-11 w-full"
              value={workerId}
              onChange={(event) => {
                const value = event.target.value;
                setWorkerId(value);
                const worker = workers.find((w) => String(w.id) === value);
                if (worker) {
                  setWorkerName(worker.name);
                  setRole(worker.role);
                  setDailyRate(String(worker.dailyRate));
                }
                setFormError(null);
              }}
              disabled={isSubmitting}
            >
              <option value="">— Journalier ponctuel (saisie libre) —</option>
              {workers
                .filter((worker) => worker.isActive)
                .map((worker) => (
                  <option key={worker.id} value={worker.id}>
                    {worker.name} — {worker.specialty || 'sans spécialité'}
                  </option>
                ))}
            </select>
          )}
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Nom de l’ouvrier" htmlFor="production-worker-name" required>
            <input
              id="production-worker-name"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={workerName}
              onChange={(event) => {
                setWorkerName(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="Ex. Sékou Bangoura"
            />
          </FormField>

          <FormField label="Rôle" htmlFor="production-worker-role">
            <select
              id="production-worker-role"
              className="select select-bordered min-h-11 w-full"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              disabled={isSubmitting}
            >
              {WORKER_ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Jours travaillés"
            htmlFor="production-worker-days"
            required
            hint="Décimal accepté (demi-journée)."
          >
            <input
              id="production-worker-days"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={days}
              onChange={(event) => {
                setDays(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>

          <FormField label="Tarif journalier" htmlFor="production-worker-rate">
            <input
              id="production-worker-rate"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={dailyRate}
              onChange={(event) => {
                setDailyRate(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>
        </div>

        <div className="rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Montant de la main-d’œuvre</span>
            <MoneyText value={amount} bold className="text-base" />
          </div>
        </div>

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Enregistrement…
              </>
            ) : (
              'Affecter l’ouvrier'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — briques cassées (motif obligatoire, §20)
 * ------------------------------------------------------------------ */

export function BrokenBricksModal({
  isOpen,
  onClose,
  production,
  onRegistered,
}: {
  isOpen: boolean;
  onClose: () => void;
  production: BrickProductionRow | null;
  onRegistered: () => void;
}) {
  const [brokenQuantity, setBrokenQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setBrokenQuantity('');
    // Motif pré-rempli au format demandé par le README §20, modifiable :
    // le journal de stock doit rester lisible sans ouvrir le lot.
    setReason(production ? `briques cassées lot ${production.batchNumber}` : '');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, production]);

  const parsed = Number(String(brokenQuantity).replace(',', '.'));
  const quantityValid = Number.isFinite(parsed) && parsed > 0;
  const remaining = production
    ? Math.max(0, production.producedQuantity - production.brokenQuantity)
    : 0;
  const tooMuch = quantityValid && parsed > remaining + 0.001;

  async function submit() {
    if (!production || isSubmitting) return;

    if (!quantityValid) {
      setFormError('Saisissez une quantité strictement positive.');
      return;
    }
    if (tooMuch) {
      setFormError(
        `Impossible : ${formatQuantity(parsed)} briques cassées alors qu’il ne reste que ${formatQuantity(remaining)} brique(s) non cassée(s) sur ce lot.`,
      );
      return;
    }
    if (!reason.trim()) {
      setFormError('Le motif de la casse est obligatoire : il justifie la sortie de stock.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/briqueterie/productions/${production.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'register_broken',
          brokenQuantity: parsed,
          reason: reason.trim(),
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'La casse n’a pas pu être enregistrée.'));
      }

      toast.success(
        production.stored
          ? `${formatQuantity(parsed)} brique(s) cassée(s) sorties du stock.`
          : `${formatQuantity(parsed)} brique(s) cassée(s) enregistrées : elles ne seront pas mises en stock.`,
      );
      onRegistered();
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'La casse n’a pas pu être enregistrée.';
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
      title={`Briques cassées — ${production?.batchNumber ?? ''}`}
      size="md"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-full bg-warning/10 p-3 text-warning">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m0 3.75h.008M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
          </div>
          <p className="text-sm text-base-content/70">
            Les briques cassées sont comptées dans <code>broken_quantity</code> <strong>et</strong>{' '}
            sorties du stock par un mouvement « sortie » motivé. Aucune brique cassée n’est jamais
            vendable, et le total n’est jamais déduit deux fois.
          </p>
        </div>

        <div className="grid gap-x-6 gap-y-1 rounded-xl border border-base-200 px-4 py-3 sm:grid-cols-2">
          <InfoRow label="Production du lot">
            <QuantityText value={production?.producedQuantity ?? 0} unit={production?.productUnit} />
          </InfoRow>
          <InfoRow label="Déjà cassé">
            <QuantityText value={production?.brokenQuantity ?? 0} unit={production?.productUnit} />
          </InfoRow>
          <InfoRow label="Reste non cassé">
            <QuantityText value={remaining} unit={production?.productUnit} />
          </InfoRow>
          <InfoRow label="Déjà en stock">
            {production?.stored ? <Badge tone="success">Oui</Badge> : <Badge tone="neutral">Non</Badge>}
          </InfoRow>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Quantité cassée" htmlFor="broken-quantity" required error={tooMuch ? ' ' : null}>
            <input
              id="broken-quantity"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="input input-bordered min-h-11 w-full tabular"
              value={brokenQuantity}
              onChange={(event) => {
                setBrokenQuantity(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="0"
            />
          </FormField>

          <FormField label="Motif" htmlFor="broken-reason" required>
            <input
              id="broken-reason"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="Motif de la casse"
            />
          </FormField>
        </div>

        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            tooMuch ? 'border-error/30 bg-error/10 text-error' : 'border-info/30 bg-info/10'
          }`}
          role="status"
          aria-live="polite"
        >
          {tooMuch ? (
            <span>
              <strong>Quantité impossible :</strong> il ne reste que{' '}
              {formatQuantity(remaining, production?.productUnit)} brique(s) non cassée(s).
            </span>
          ) : production?.stored ? (
            <span>
              Ce lot est <strong>en stock</strong> : la quantité sera retirée immédiatement du stock
              par un mouvement « sortie ».
            </span>
          ) : (
            <span>
              Ce lot <strong>n’est pas encore en stock</strong> : les briques cassées ne seront pas
              créditées à la mise en stock (le crédit porte sur « production − cassées »).
            </span>
          )}
        </div>

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button type="submit" className="btn btn-warning min-h-11" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Enregistrement…
              </>
            ) : (
              'Enregistrer la casse'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modales — retrait d'une ligne (matière / affectation)
 * ------------------------------------------------------------------ */

export function RemoveMaterialDialog({
  isOpen,
  onClose,
  onConfirm,
  material,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  material: BrickProductionMaterialRow | null;
  isSubmitting: boolean;
}) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      isSubmitting={isSubmitting}
      tone="warning"
      title="Retirer cette ligne de matière"
      confirmLabel="Retirer et rendre au stock"
      message={
        <>
          <strong>{material?.productName}</strong> —{' '}
          {formatQuantity(material?.quantity ?? 0, material?.unit)} seront{' '}
          <strong>rendus au stock</strong> par un mouvement « entrée » motivé. Le coût de revient du
          lot est recalculé aussitôt.
        </>
      }
    />
  );
}

export function RemoveWorkerDialog({
  isOpen,
  onClose,
  onConfirm,
  assignment,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  assignment: BrickProductionWorkerRow | null;
  isSubmitting: boolean;
}) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      isSubmitting={isSubmitting}
      tone="warning"
      title="Retirer cette affectation"
      confirmLabel="Retirer"
      message={
        <>
          L’affectation de <strong>{assignment?.workerName}</strong> (
          {formatQuantity(assignment?.days ?? 0)} jour(s) ×{' '}
          <MoneyText value={assignment?.dailyRate ?? 0} />) sera retirée et le coût de main-d’œuvre du
          lot recalculé.
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * Modale — dépense rattachée au lot
 * ------------------------------------------------------------------ */

/**
 * Saisie rapide d'une dépense de fabrication.
 *
 * C'est le cœur de la révision §20 : **plus de module de matières premières**.
 * Le ciment, le sable, le carburant, l'électricité ou la main-d'œuvre ponctuelle
 * se saisissent ici, rattachés au lot ; la catégorie est une liste fermée métier
 * (miroir de `PRODUCTION_EXPENSE_CATEGORIES`) et non la liste des paramètres.
 *
 * La dépense **sort de la caisse** (côté serveur, `lib/expenses.ts`) : le lot
 * n'est pas un simple carnet de notes, l'argent réellement dépensé est tracé.
 */
export function ProductionExpenseModal({
  isOpen,
  onClose,
  productionId,
  batchNumber,
  paymentMethods,
  expense = null,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  productionId: number;
  batchNumber: string;
  paymentMethods: string[];
  /** Dépense à corriger ; `null` = nouvelle dépense. */
  expense?: BrickProductionExpenseRow | null;
  onSaved: () => void;
}) {
  const isEdit = expense !== null;

  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [date, setDate] = useState(today());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setCategory(expense?.category ?? '');
    setAmount(expense ? String(expense.amount) : '');
    setDescription(expense?.description ?? '');
    setBeneficiary(expense?.beneficiary ?? '');
    setPaymentMethod(expense?.paymentMethod ?? paymentMethods[0] ?? 'Espèces');
    setDate(expense?.date ?? today());
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, expense, paymentMethods]);

  const parsedAmount = Number(String(amount).replace(',', '.'));
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const canSubmit = Boolean(category) && amountValid && /^\d{4}-\d{2}-\d{2}$/.test(date);

  async function submit() {
    if (isSubmitting) return;

    if (!category) {
      setFormError('Choisissez la catégorie de la dépense.');
      return;
    }
    if (!amountValid) {
      setFormError('Saisissez un montant strictement supérieur à zéro.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setFormError('La date est obligatoire.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(
        `/api/briqueterie/productions/${productionId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(
            isEdit
              ? {
                  action: 'update_expense',
                  expenseId: expense!.id,
                  category,
                  amount: parsedAmount,
                  description: description.trim() || null,
                  beneficiary: beneficiary.trim() || null,
                  paymentMethod,
                  date,
                }
              : {
                  action: 'add_expense',
                  category,
                  amount: parsedAmount,
                  description: description.trim() || null,
                  beneficiary: beneficiary.trim() || null,
                  paymentMethod,
                  date,
                },
          ),
        },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, 'La dépense n’a pas pu être enregistrée.'));
      }

      toast.success(
        isEdit
          ? `Dépense « ${category} » corrigée : le coût du lot ${batchNumber} est recalculé.`
          : `Dépense « ${category} » rattachée au lot ${batchNumber} : sortie de caisse enregistrée.`,
      );
      onSaved();
      onClose();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'La dépense n’a pas pu être enregistrée.';
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
      title={isEdit ? `Corriger une dépense — ${batchNumber}` : `Nouvelle dépense — ${batchNumber}`}
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
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          La dépense est rattachée à <strong>ce lot</strong> et <strong>sort de la caisse</strong> au
          moment de l’enregistrement. Elle entre dans le coût total de production, donc dans le coût
          de revient unitaire.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Catégorie" required>
            <select
              className="select select-bordered h-11 w-full sm:h-9"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              aria-label="Catégorie de la dépense"
            >
              <option value="">Choisir une catégorie…</option>
              {PRODUCTION_EXPENSE_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Montant" required>
            <label className="relative block">
              <input
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                className="input input-bordered h-11 w-full pr-14 text-right tabular sm:h-9"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0"
                aria-label="Montant de la dépense"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] font-medium text-base-content/45">
                GNF
              </span>
            </label>
          </FormField>

          <FormField label="Date" required>
            <DatePicker value={date} onChange={setDate} placeholder="jj mois aaaa" />
          </FormField>

          <FormField label="Moyen de paiement">
            <select
              className="select select-bordered h-11 w-full sm:h-9"
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              aria-label="Moyen de paiement de la dépense"
            >
              {paymentMethods.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Libellé / description">
            <input
              type="text"
              className="input input-bordered h-11 w-full sm:h-9"
              value={description}
              maxLength={200}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Ex. 20 sacs de ciment"
              aria-label="Libellé de la dépense"
            />
          </FormField>

          <FormField label="Bénéficiaire (facultatif)">
            <input
              type="text"
              className="input input-bordered h-11 w-full sm:h-9"
              value={beneficiary}
              maxLength={120}
              onChange={(event) => setBeneficiary(event.target.value)}
              placeholder="Fournisseur, ouvrier…"
              aria-label="Bénéficiaire de la dépense"
            />
          </FormField>
        </div>

        {formError && (
          <p className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            {formError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="btn btn-ghost min-h-11"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11" disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Enregistrement…
              </>
            ) : isEdit ? (
              'Enregistrer la correction'
            ) : (
              'Enregistrer la dépense'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Retrait d'une dépense du lot : **annulation motivée**.
 *
 * L'argent revient en caisse (mouvement inverse), la dépense n'est plus comptée,
 * et rien n'est effacé — le motif et l'auteur restent dans le journal (§7).
 */
export function RemoveExpenseDialog({
  isOpen,
  onClose,
  onConfirm,
  expense,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
  expense: BrickProductionExpenseRow | null;
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
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title="Retirer une dépense du lot"
      size="md"
      fullScreenMobile
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!reason.trim()) {
            setError('Le motif est obligatoire : une opération validée ne disparaît jamais sans trace.');
            return;
          }
          void onConfirm(reason.trim());
        }}
      >
        <p className="text-sm text-base-content/70">
          <strong>{expense?.category}</strong> — <MoneyText value={expense?.amount ?? 0} /> seront
          annulés : la dépense n’est plus comptée dans le coût du lot et{' '}
          <strong>l’argent revient en caisse</strong> par un mouvement inverse motivé. La ligne reste
          consultable.
        </p>

        <FormField label="Motif du retrait" required>
          <textarea
            rows={3}
            maxLength={300}
            className="textarea textarea-bordered w-full"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ex. dépense saisie sur le mauvais lot"
            aria-label="Motif du retrait de la dépense"
          />
        </FormField>

        {error && (
          <p className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            {error}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="btn btn-ghost min-h-11"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Conserver la dépense
          </button>
          <button type="submit" className="btn btn-error min-h-11" disabled={isSubmitting}>
            {isSubmitting ? 'Annulation…' : 'Annuler la dépense'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — annulation motivée du lot (§7 : jamais de suppression)
 * ------------------------------------------------------------------ */

export function CancelProductionDialog({
  isOpen,
  onClose,
  onConfirm,
  production,
  isSubmitting,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
  production: BrickProductionRow | null;
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
      title="Annuler ce lot de fabrication"
      confirmLabel="Annuler le lot"
      message={
        <>
          Le lot <strong>{production?.batchNumber}</strong> sera marqué annulé. Il n’est{' '}
          <strong>jamais supprimé</strong> : il reste consultable. Le stock est <strong>réversé</strong>{' '}
          — les briques finies déjà mises en stock ressortent, les matières premières consommées sont
          rendues.
        </>
      }
    >
      <FormField label="Motif de l’annulation" htmlFor="production-cancel-reason" required error={error}>
        <textarea
          id="production-cancel-reason"
          className="textarea textarea-bordered min-h-20 w-full"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
          disabled={isSubmitting}
          placeholder="Ex. four hors service, lot non conforme…"
        />
      </FormField>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Modale — gestion des types de briques (liste + création + désactivation)
 * ------------------------------------------------------------------ */

function BrickTypeFormModal({
  isOpen,
  onClose,
  onSaved,
  brickType,
  products,
  isOptionsLoading,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  brickType: BrickTypeRow | null;
  products: ProductOption[];
  isOptionsLoading: boolean;
}) {
  const [productId, setProductId] = useState('');
  const [name, setName] = useState('');
  const [shape, setShape] = useState<BrickShape>('solid');
  const [dimensions, setDimensions] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setProductId(brickType ? String(brickType.productId) : '');
    setName(brickType?.name ?? '');
    setShape(brickType?.shape ?? 'solid');
    setDimensions(brickType?.dimensions ?? '');
    setDescription(brickType?.description ?? '');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, brickType]);

  async function submit() {
    if (isSubmitting) return;

    if (!productId) {
      setFormError('Le produit lié est obligatoire : c’est lui qui porte le stock et le prix de vente.');
      return;
    }
    if (!name.trim()) {
      setFormError('Le nom du type de brique est obligatoire.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(
        brickType ? `/api/briqueterie/types/${brickType.id}` : '/api/briqueterie/types',
        {
          method: brickType ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            productId: Number(productId),
            name: name.trim(),
            shape,
            dimensions: dimensions.trim() || null,
            description: description.trim() || null,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response, 'Le type de brique n’a pas pu être enregistré.'));
      }

      toast.success(brickType ? 'Type de brique modifié.' : `Type « ${name.trim()} » créé.`);
      onSaved();
      onClose();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Le type de brique n’a pas pu être enregistré.';
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
      title={brickType ? 'Modifier le type de brique' : 'Nouveau type de brique'}
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
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          Le <strong>produit lié</strong> porte le prix de vente et le stock des briques finies. Le
          type ne fait que décrire la brique (forme, dimensions) : il ne duplique ni prix ni stock,
          sinon les deux finiraient par diverger.
        </p>

        <FormField label="Produit lié" htmlFor="brick-type-product" required>
          {isOptionsLoading && products.length === 0 ? (
            <div className="h-11 animate-pulse rounded-lg bg-base-300/60" />
          ) : (
            <select
              id="brick-type-product"
              className="select select-bordered min-h-11 w-full"
              value={productId}
              onChange={(event) => {
                setProductId(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
            >
              <option value="">— Sélectionner un produit —</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({formatNumber(product.salePrice)} GNF ·{' '}
                  {formatQuantity(product.stock, product.unit)})
                </option>
              ))}
            </select>
          )}
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Nom du type" htmlFor="brick-type-name" required>
            <input
              id="brick-type-name"
              type="text"
              className="input input-bordered min-h-11 w-full"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setFormError(null);
              }}
              disabled={isSubmitting}
              placeholder="Ex. Brique pleine 15"
            />
          </FormField>

          <FormField label="Forme" htmlFor="brick-type-shape" required>
            <select
              id="brick-type-shape"
              className="select select-bordered min-h-11 w-full"
              value={shape}
              onChange={(event) => setShape(event.target.value as BrickShape)}
              disabled={isSubmitting}
            >
              {BRICK_SHAPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <FormField
          label="Dimensions"
          htmlFor="brick-type-dimensions"
          hint="Ex. 15 × 20 × 40 cm — affichées sur les lots et les rapports."
        >
          <input
            id="brick-type-dimensions"
            type="text"
            className="input input-bordered min-h-11 w-full"
            value={dimensions}
            onChange={(event) => setDimensions(event.target.value)}
            disabled={isSubmitting}
            placeholder="Ex. 15 × 20 × 40 cm"
          />
        </FormField>

        <FormField label="Description" htmlFor="brick-type-description">
          <textarea
            id="brick-type-description"
            className="textarea textarea-bordered min-h-20 w-full"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={isSubmitting}
          />
        </FormField>

        {formError && (
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Enregistrement…
              </>
            ) : brickType ? (
              'Enregistrer les modifications'
            ) : (
              'Créer le type'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function BrickTypesManagerModal({
  isOpen,
  onClose,
  onChanged,
  onTypesLoaded,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Appelée après toute écriture : la page hôte rafraîchit sa liste. */
  onChanged?: () => void;
  /** Remonte la liste chargée, pour que la page hôte alimente ses sélecteurs. */
  onTypesLoaded?: (types: BrickTypeRow[]) => void;
}) {
  const { products, isLoading: isOptionsLoading } = useBrickSelectOptions(isOpen);
  const canManage = usePermission('brick.update');

  const [types, setTypes] = useState<BrickTypeRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [includeInactive, setIncludeInactive] = useState(false);

  /* Un état booléen par modale (§8.3 règle 1). */
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingType, setEditingType] = useState<BrickTypeRow | null>(null);
  const [isDeactivateOpen, setIsDeactivateOpen] = useState(false);
  const [targetType, setTargetType] = useState<BrickTypeRow | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '200' });
        if (includeInactive) params.set('includeInactive', 'true');

        const response = await fetch(`/api/briqueterie/types?${params.toString()}`, {
          signal,
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Chargement des types impossible.'));
        }

        const payload = (await response.json()) as Paginated<BrickTypeRow>;
        if (signal.aborted) return;
        const data = Array.isArray(payload.data) ? payload.data : [];
        setTypes(data);
        onTypesLoaded?.(data);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Chargement des types impossible.');
      } finally {
        if (!signal.aborted) setIsLoading(false);
      }
    },
    // `onTypesLoaded` est volontairement hors dépendances : la page hôte le
    // recrée à chaque rendu et relancerait la requête en boucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [includeInactive],
  );

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [isOpen, load, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const columns = useMemo(() => brickTypeColumns, []);

  async function deactivate() {
    if (!targetType) return;
    setIsSubmitting(true);
    try {
      const reactivate = !targetType.isActive;
      const response = await fetch(
        `/api/briqueterie/types/${targetType.id}${reactivate ? '?reactivate=true' : ''}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );
      if (!response.ok) {
        throw new Error(await readApiError(response, 'L’opération n’a pas pu aboutir.'));
      }
      toast.success(
        reactivate
          ? `Type « ${targetType.name} » réactivé.`
          : `Type « ${targetType.name} » désactivé : les lots passés restent lisibles.`,
      );
      setIsDeactivateOpen(false);
      setTargetType(null);
      refresh();
      onChanged?.();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'L’opération n’a pas pu aboutir.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="Types de briques" size="xl" fullScreenMobile>
        <div className="space-y-4">
          <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
            Chaque type est rattaché à un <strong>produit</strong> : c’est ce produit qui porte le prix
            de vente et le stock des briques finies. Un type n’est <strong>jamais supprimé</strong> —
            on le désactive, pour que les lots passés gardent leur libellé.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`btn min-h-11 ${includeInactive ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
              aria-pressed={includeInactive}
              onClick={() => setIncludeInactive((value) => !value)}
            >
              Afficher les types inactifs
            </button>
            {canManage && (
              <button
                type="button"
                className="btn btn-primary ml-auto min-h-11"
                onClick={() => {
                  setEditingType(null);
                  setIsFormOpen(true);
                }}
              >
                Nouveau type
              </button>
            )}
          </div>

          {isLoading && types.length === 0 ? (
            <SkeletonTable rows={5} cols={4} />
          ) : error ? (
            <EmptyState
              title="Types indisponibles"
              description={error}
              action={<ToolbarButton onClick={refresh}>Réessayer</ToolbarButton>}
            />
          ) : types.length === 0 ? (
            <EmptyState
              title="Aucun type de brique"
              description="Créez un premier type et rattachez-le au produit qui portera son stock et son prix de vente."
              action={
                canManage ? (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11"
                    onClick={() => {
                      setEditingType(null);
                      setIsFormOpen(true);
                    }}
                  >
                    Créer le premier type
                  </button>
                ) : undefined
              }
            />
          ) : (
            <ResponsiveTable
              columns={columns}
              data={types}
              getRowKey={(type) => type.id}
              emptyMessage="Aucun type de brique."
              actions={
                canManage
                  ? (type) => (
                      <RowActions>
                        <IconAction
                          icon="edit"
                          label="Modifier le type de brique"
                          onClick={() => {
                            setEditingType(type);
                            setIsFormOpen(true);
                          }}
                        />
                        <IconAction
                          icon={type.isActive ? 'deactivate' : 'activate'}
                          tone={type.isActive ? 'danger' : 'success'}
                          label={
                            type.isActive ? 'Désactiver le type de brique' : 'Réactiver le type de brique'
                          }
                          onClick={() => {
                            setTargetType(type);
                            setIsDeactivateOpen(true);
                          }}
                        />
                      </RowActions>
                    )
                  : undefined
              }
            />
          )}

          <div className="flex justify-end border-t border-base-200 pt-4">
            <button type="button" className="btn btn-ghost min-h-11" onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
      </Modal>

      <BrickTypeFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        brickType={editingType}
        products={products}
        isOptionsLoading={isOptionsLoading}
        onSaved={() => {
          refresh();
          onChanged?.();
        }}
      />

      <ConfirmDialog
        isOpen={isDeactivateOpen}
        onClose={() => {
          if (!isSubmitting) setIsDeactivateOpen(false);
        }}
        onConfirm={deactivate}
        isSubmitting={isSubmitting}
        tone={targetType?.isActive ? 'error' : 'success'}
        title={targetType?.isActive ? 'Désactiver ce type' : 'Réactiver ce type'}
        confirmLabel={targetType?.isActive ? 'Désactiver' : 'Réactiver'}
        message={
          targetType?.isActive ? (
            <>
              <strong>{targetType?.name}</strong> ne sera plus proposé pour un nouveau lot. Ses{' '}
              {targetType?.productionsCount ?? 0} lot(s) passés restent lisibles : la fiche n’est{' '}
              <strong>jamais supprimée</strong>.
            </>
          ) : (
            <>
              <strong>{targetType?.name}</strong> redeviendra proposé pour les nouveaux lots.
            </>
          )
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Bloc « coût de revient » — calculé, jamais stocké (§20)
 * ------------------------------------------------------------------ */

export function ProductionCostCard({
  costs,
  salePrice,
  unit,
}: {
  costs: ProductionCosts;
  salePrice: number;
  unit: string;
}) {
  const potentialRevenue = costs.goodQuantity * salePrice;
  const potentialMargin = potentialRevenue - costs.totalCost;
  const positive = potentialMargin >= 0;

  return (
    <div className="space-y-1">
      {/*
        Dépenses rattachées d'abord : c'est la source de coût normale depuis la
        révision §20 (plus de module de matières premières). Les deux autres
        lignes restent affichées pour les lots historiques, sauf si elles sont
        nulles — un « 0 GNF » sur une fiche récente n'apprend rien.
      */}
      <InfoRow label="Dépenses de production (ciment, sable, carburant…)">
        <MoneyText value={costs.expenseCost} />
      </InfoRow>
      {costs.laborCost > 0 && (
        <InfoRow label="Main-d’œuvre de l’équipe affectée">
          <MoneyText value={costs.laborCost} />
        </InfoRow>
      )}
      {costs.materialCost > 0 && (
        <InfoRow label="Matières premières (lots antérieurs)">
          <MoneyText value={costs.materialCost} />
        </InfoRow>
      )}
      <InfoRow label="Coût de revient total">
        <MoneyText value={costs.totalCost} bold />
      </InfoRow>
      <InfoRow label="Briques bonnes (production − cassées)">
        <QuantityText value={costs.goodQuantity} unit={unit} />
      </InfoRow>
      <div className="flex items-center justify-between border-t border-base-200 pt-2">
        <span className="text-sm font-semibold">Coût de revient unitaire</span>
        <MoneyText value={costs.unitCost} bold className="text-base" />
      </div>
      {salePrice > 0 ? (
        <>
          <InfoRow label="Valeur de vente potentielle">
            <MoneyText value={potentialRevenue} />
          </InfoRow>
          <InfoRow label="Marge potentielle">
            <span className={positive ? 'text-success' : 'text-error'}>
              <MoneyText value={potentialMargin} />
              {potentialRevenue > 0 ? ` (${formatPercent((potentialMargin / potentialRevenue) * 100)})` : ''}
            </span>
          </InfoRow>
        </>
      ) : null}
      <p className="pt-2 text-xs text-base-content/50">
        Coût de revient unitaire = coût total ÷ ({formatQuantity(costs.producedQuantity)} −{' '}
        {formatQuantity(costs.brokenQuantity)}) = {formatNumber(costs.unitCost)} GNF par brique bonne.
        Ce montant est <strong>calculé à la lecture</strong>, jamais stocké.
      </p>
    </div>
  );
}

export function BrickWorkersManagerButton({ onChanged }: { onChanged?: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const canManage = usePermission('workers.manage');

  if (!canManage) return null;

  return (
    <>
      <ToolbarButton onClick={() => setIsOpen(true)}>Ouvriers</ToolbarButton>
      <WorkersManagerModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onChanged={onChanged}
      />
    </>
  );
}

export function BrickProductionSkeleton() {
  return <SkeletonTable rows={6} cols={6} />;
}

export function BrickEmptyState({ children }: { children?: ReactNode }) {
  return (
    <EmptyState
      title="Lot introuvable"
      description="Ce lot de fabrication n’existe plus sur ce poste."
      action={children}
    />
  );
}

export { MiniStat };
