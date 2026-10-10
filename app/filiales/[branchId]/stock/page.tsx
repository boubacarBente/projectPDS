'use client';

import { branchApiUrl, useBranch } from '@/components/filiales/branch-context';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { IconAction, RowActions } from '@/components/row-actions';
import { Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Modal } from '@/components/modal';
import { usePermission } from '@/components/role-gate';
import { BrickTabs, useBrickScope } from '@/components/briqueterie/brick-tabs';
import { useAuth } from '@/components/auth-provider';
import { StoreTag } from '@/components/store-scope';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  FormField,
  InfoRow,
  MoneyText,
  QuantityText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
  type BadgeTone,
} from '@/components/design-system';
import { useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatDateTime } from '@/lib/date-format';
import { formatNumber, formatQuantity } from '@/lib/format';

/* ==================================================================
 * Page « Stock des produits finis » de la briqueterie (README §20 et §12).
 *
 * Il n'existe **pas** de module de matières premières : ce que fabrique la
 * briqueterie (les briques) est un produit fini du catalogue, et chaque type de
 * brique est rattaché à un produit (`brick_types.product_id`) qui porte le
 * stock, le seuil minimum et le prix de vente. Le stock affiché est donc celui
 * du produit lié — la même valeur que sur `/stocks`, jamais un second compteur.
 *
 * Aucune écriture ne part d'ici : une entrée vient d'un lot mis en stock
 * (B.href(`/[id]`)), une sortie d'une vente ou d'une perte. Seule une
 * **correction d'inventaire** est possible, et elle passe par
 * `POST /api/stocks/adjust` avec un **écart signé** et un motif obligatoire,
 * donc par `addStockMovement()` côté serveur (invariant « le stock ne s'écrit
 * que par un mouvement »).
 *
 * ⚠️ Aucun import de valeur depuis `lib/brick.ts` ou `lib/brick-analytics.ts` :
 * ces modules touchent `@/db` et feraient entrer `@libsql/client` et `fs` dans
 * le bundle navigateur. Les formes ci-dessous décrivent le JSON de l'API.
 * ================================================================== */

const PAGE_SIZE = 20;
/** La modale d'historique charge les 100 derniers mouvements du produit. */
const HISTORY_LIMIT = 100;

/** Clé d'état de vue — doit rester stable pour que le retour arrière restaure. */
const VIEW_NAME = 'briqueterie-stock';

/* ------------------------------------------------------------------ *
 * Types (miroir du JSON de l'API, aucune importation runtime)
 * ------------------------------------------------------------------ */

/** Ligne de `GET /api/filiales/[branchId]/stock` — `listBrickStock()`. */
type BrickStockLine = {
  brickTypeId: number;
  brickTypeName: string;
  /** Magasin du type (README §30). */
  storeId: number;
  storeName: string | null;
  shape: string;
  dimensions: string | null;
  productId: number;
  productName: string;
  unit: string;
  salePrice: number;
  purchasePrice: number;
  stock: number;
  stockMin: number;
  /** Coût de revient moyen constaté (0 tant qu'aucun lot n'est terminé). */
  averageUnitCost: number;
  isLow: boolean;
  isOut: boolean;
  stockValue: number;
  saleValue: number;
  potentialMargin: number;
};

type BrickStockSummary = {
  totalQuantity: number;
  totalPurchaseValue: number;
  totalSaleValue: number;
  lowCount: number;
  outCount: number;
};

type BrickStockPayload = {
  data: BrickStockLine[];
  total: number;
  summary: BrickStockSummary;
};

type MovementType = 'entry' | 'exit' | 'adjustment';

/** Ligne du journal de stock — `GET /api/stocks/mouvements`. */
type StockMovementRow = {
  id: number;
  productId: number;
  productName: string;
  unit: string;
  type: MovementType;
  quantity: number;
  motif: string;
  stockBefore: number;
  stockAfter: number;
  userName: string | null;
  /** Horodatage sérialisé par la route, jamais une `Date` côté client. */
  createdAt: string | null;
};

type Paginated<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type StockViewState = {
  search: string;
  lowOnly: boolean;
  page: number;
};

/* ------------------------------------------------------------------ *
 * Libellés et utilitaires client
 * ------------------------------------------------------------------ */

/** Libellés de forme : miroir de `lib/brick.ts`, qui n'est pas importable ici. */
const SHAPE_LABELS: Record<string, string> = {
  solid: 'Pleine',
  hollow: 'Creuse',
  block: 'Parpaing',
};

function shapeLabelOf(shape: string | null | undefined): string {
  if (!shape) return '—';
  return SHAPE_LABELS[shape] ?? shape;
}

/**
 * Description courte d'un type de brique : forme puis dimensions.
 *
 * L'unité de mesure n'y figure pas : elle est déjà portée par le stock et le
 * seuil, la répéter trois fois par ligne rendrait le tableau illisible.
 */
function typeLabelOf(line: BrickStockLine): string {
  const shape = shapeLabelOf(line.shape);
  return line.dimensions ? `${shape} ${line.dimensions}` : shape;
}

const MOVEMENT_LABELS: Record<MovementType, string> = {
  entry: 'Entrée',
  exit: 'Sortie',
  adjustment: 'Ajustement',
};

const MOVEMENT_TONES: Record<MovementType, BadgeTone> = {
  entry: 'success',
  exit: 'warning',
  adjustment: 'info',
};

/** Message d'erreur de l'API, ou repli lisible en français. */
async function readApiError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  const message = (payload as { error?: unknown })?.error;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

/** Quantité **signée** d'un mouvement : une sortie retire, le signe est explicite. */
function signedQuantityOf(movement: StockMovementRow): number {
  if (movement.type === 'exit') return -Math.abs(movement.quantity);
  return movement.quantity;
}

/** Une valeur numérique sûre : `null` / `undefined` n'ont pas à casser un total. */
function numberOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/* ------------------------------------------------------------------ *
 * Présentation : état d'une ligne et quantité signée
 * ------------------------------------------------------------------ */

/**
 * État du stock — **jamais la couleur seule** : le libellé porte l'information.
 *
 * `isOut` est testé avant `isLow` : le serveur calcule `isLow = stock <= seuil`,
 * donc une rupture franche (stock 0) satisfait aussi `isLow` — sans cet ordre,
 * une rupture s'afficherait « Seuil atteint ».
 */
function StockStateBadge({ line }: { line: BrickStockLine }) {
  if (line.isOut) return <Badge tone="error">Rupture</Badge>;
  if (line.isLow) return <Badge tone="warning">Seuil atteint</Badge>;
  return <Badge tone="success">Disponible</Badge>;
}

function SignedQuantity({ movement }: { movement: StockMovementRow }) {
  const signed = signedQuantityOf(movement);
  return (
    <span
      className={`inline-flex items-baseline gap-0.5 font-medium ${
        signed < 0 ? 'text-error' : 'text-success'
      }`}
    >
      <span aria-hidden>{signed < 0 ? '−' : '+'}</span>
      {/* Le signe est décoratif : le sens est dit en toutes lettres pour un lecteur d'écran. */}
      <span className="sr-only">{signed < 0 ? 'Diminution de' : 'Augmentation de'}</span>
      <QuantityText value={Math.abs(signed)} unit={movement.unit} />
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Colonnes des deux listes
 * ------------------------------------------------------------------ */

/** Colonnes de l'état du stock. Une seule ligne par type de brique. */
const buildStockColumns = (stockShowsStore: boolean): Column<BrickStockLine>[] => [
  {
    key: 'product',
    label: 'Produit',
    // Information principale : c'est elle qui titre la carte sur mobile.
    primary: true,
    render: (line) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{line.productName}</div>
        <div className="truncate text-xs text-base-content/50">
          {line.brickTypeName} — {typeLabelOf(line)}
        </div>
        <StoreTag name={line.storeName} show={stockShowsStore} />
      </div>
    ),
  },
  {
    key: 'stock',
    label: 'Stock',
    render: (line) => (
      <QuantityText
        value={line.stock}
        unit={line.unit}
        className={line.isOut || line.isLow ? 'font-semibold' : ''}
      />
    ),
  },
  {
    key: 'stockMin',
    label: 'Seuil min',
    hideOnMobile: true,
    render: (line) => <QuantityText value={line.stockMin} unit={line.unit} />,
  },
  {
    key: 'averageUnitCost',
    label: 'Coût unitaire moyen',
    hideOnMobile: true,
    render: (line) =>
      /*
       * Un coût de revient nul veut dire « aucun lot terminé », pas « gratuit » :
       * afficher « 0 GNF » ferait croire à une donnée, le tiret dit l'absence.
       */
      line.averageUnitCost > 0 ? (
        <MoneyText value={line.averageUnitCost} />
      ) : (
        <span className="text-base-content/40" title="Aucun lot terminé pour ce modèle">
          —
        </span>
      ),
  },
  {
    key: 'salePrice',
    label: 'Prix de vente',
    hideOnMobile: true,
    render: (line) => <MoneyText value={line.salePrice} />,
  },
  {
    key: 'stockValue',
    label: "Valeur d'achat",
    hideOnMobile: true,
    render: (line) => <MoneyText value={line.stockValue} />,
  },
  {
    key: 'state',
    label: 'État',
    render: (line) => <StockStateBadge line={line} />,
  },
];

/** Colonnes du journal : la date propre du mouvement est la première (§6.5 règle 8). */
const movementColumns: Column<StockMovementRow>[] = [
  {
    key: 'date',
    label: 'Date',
    primary: true,
    className: 'whitespace-nowrap text-xs text-base-content/60',
    render: (movement) => formatDateTime(movement.createdAt),
  },
  {
    key: 'type',
    label: 'Type',
    render: (movement) => (
      <Badge tone={MOVEMENT_TONES[movement.type] ?? 'neutral'}>
        {MOVEMENT_LABELS[movement.type] ?? movement.type}
      </Badge>
    ),
  },
  {
    key: 'quantity',
    label: 'Quantité',
    className: 'whitespace-nowrap',
    render: (movement) => <SignedQuantity movement={movement} />,
  },
  {
    key: 'motif',
    label: 'Motif',
    className: 'max-w-[16rem] truncate',
    render: (movement) => <span title={movement.motif}>{movement.motif || '—'}</span>,
  },
  {
    key: 'stockBefore',
    label: 'Stock avant',
    render: (movement) => <QuantityText value={movement.stockBefore} unit={movement.unit} />,
  },
  {
    key: 'stockAfter',
    label: 'Stock après',
    render: (movement) => <QuantityText value={movement.stockAfter} unit={movement.unit} />,
  },
];

/* ==================================================================
 * Modale — correction d'inventaire (écart signé, motif obligatoire)
 * ================================================================== */

/**
 * L'ajustement est un **écart signé**, jamais une valeur absolue (§12) : on
 * choisit le sens (« Entrée » / « Sortie ») puis une quantité positive, et
 * l'écart envoyé vaut `+quantité` ou `−quantité`. C'est ce qui préserve
 * `stock = somme des mouvements` — une valeur absolue écraserait l'historique.
 */
function StockAdjustModal({
  isOpen,
  onClose,
  lines,
  initialLine,
  onAdjusted,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Tous les types de brique, pour permettre de changer de produit. */
  lines: BrickStockLine[];
  /** Ligne d'où la modale a été ouverte (`null` = ouverte depuis l'en-tête). */
  initialLine: BrickStockLine | null;
  onAdjusted: () => void;
}) {
  /*
   * La sélection porte sur le **type de brique**, pas sur le produit : deux
   * types peuvent partager un produit au catalogue, et deux options de même
   * valeur rendraient le choix impossible. L'écart, lui, part sur le produit
   * (`selected.productId`), qui est bien ce qui porte le stock.
   */
  const [brickTypeId, setBrickTypeId] = useState<number | ''>('');
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [quantity, setQuantity] = useState('');
  const [motif, setMotif] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Ouverture : pré-remplissage depuis la ligne cliquée, puis remise à zéro.
  useEffect(() => {
    if (!isOpen) return;
    setBrickTypeId(initialLine?.brickTypeId ?? '');
    setDirection('add');
    setQuantity('');
    setMotif('');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, initialLine]);

  const selected = useMemo(
    () => lines.find((line) => line.brickTypeId === brickTypeId) ?? null,
    [lines, brickTypeId],
  );

  const parsedQuantity = Number(quantity.replace(',', '.'));
  const quantityValid = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
  const delta = quantityValid ? (direction === 'add' ? parsedQuantity : -parsedQuantity) : 0;
  const stockBefore = numberOrZero(selected?.stock);
  const projected = Math.round((stockBefore + delta) * 1000) / 1000;
  const wouldGoNegative = quantityValid && projected < 0;
  const motifFilled = motif.trim().length > 0;

  async function submit() {
    if (isSubmitting) return;

    if (!selected) {
      setFormError('Sélectionnez le modèle à corriger.');
      return;
    }
    if (!quantityValid) {
      setFormError('Saisissez une quantité strictement positive.');
      return;
    }
    if (wouldGoNegative) {
      setFormError(
        `Sortie impossible : le stock ne peut pas devenir négatif (maximum ${formatQuantity(stockBefore, selected.unit)}).`,
      );
      return;
    }
    if (!motifFilled) {
      setFormError('Le motif est obligatoire : c’est lui qui justifie l’écart dans le journal.');
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/stocks/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ productId: selected.productId, delta, motif: motif.trim() }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, 'L’ajustement du stock a échoué.'));
      }

      const payload = (await response.json()) as { stockBefore: number; stockAfter: number };
      toast.success(
        `Stock ajusté : ${formatQuantity(payload.stockBefore, selected.unit)} → ${formatQuantity(payload.stockAfter, selected.unit)}.`,
      );
      onAdjusted();
      onClose();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'L’ajustement du stock a échoué.';
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
      size="lg"
      fullScreenMobile
      title="Ajuster le stock d’un produit fini"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          Le stock se corrige par un <strong>écart signé</strong>, jamais par une valeur absolue :
          une entrée vient d’un lot mis en stock, une sortie d’une vente ou d’une perte, et seule
          une correction d’inventaire se saisit ici.
        </p>

        <FormField label="Modèle / produit" htmlFor="brick-stock-produit" required>
          {lines.length === 0 ? (
            <p className="rounded-lg border border-base-200 bg-base-200/50 px-3 py-2 text-sm text-base-content/60">
              Aucun modèle n’est lié à un produit : créez d’abord un modèle dans l’onglet
              Modèles.
            </p>
          ) : (
            <select
              id="brick-stock-produit"
              className="select select-bordered min-h-11 w-full"
              value={brickTypeId === '' ? '' : String(brickTypeId)}
              onChange={(event) => {
                const value = event.target.value;
                setBrickTypeId(value ? Number(value) : '');
                setFormError(null);
              }}
              disabled={isSubmitting}
            >
              <option value="">— Sélectionner un modèle —</option>
              {lines.map((line) => (
                <option key={line.brickTypeId} value={line.brickTypeId}>
                  {line.brickTypeName} — {line.productName} ({typeLabelOf(line)})
                </option>
              ))}
            </select>
          )}
        </FormField>

        {selected && (
          <div className="grid gap-x-6 gap-y-1 rounded-xl border border-base-200 px-4 py-3 sm:grid-cols-2">
            <InfoRow label="Stock actuel">
              <QuantityText value={stockBefore} unit={selected.unit} />
            </InfoRow>
            <InfoRow label="Seuil minimum">
              <QuantityText value={selected.stockMin} unit={selected.unit} />
            </InfoRow>
            <InfoRow label="État actuel">
              <StockStateBadge line={selected} />
            </InfoRow>
            <InfoRow label="Prix de vente">
              <MoneyText value={selected.salePrice} />
            </InfoRow>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Sens de l’écart" required>
            <div role="group" aria-label="Sens de l’écart" className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setDirection('add');
                  setFormError(null);
                }}
                disabled={isSubmitting}
                aria-pressed={direction === 'add'}
                className={`btn min-h-11 flex-1 ${
                  direction === 'add' ? 'btn-success' : 'btn-ghost border border-base-300'
                }`}
              >
                Entrée (+)
              </button>
              <button
                type="button"
                onClick={() => {
                  setDirection('remove');
                  setFormError(null);
                }}
                disabled={isSubmitting}
                aria-pressed={direction === 'remove'}
                className={`btn min-h-11 flex-1 ${
                  direction === 'remove' ? 'btn-warning' : 'btn-ghost border border-base-300'
                }`}
              >
                Sortie (−)
              </button>
            </div>
          </FormField>

          <FormField
            label="Quantité"
            htmlFor="brick-stock-quantite"
            required
            hint="Décimale acceptée : le m² et le kg ne sont pas entiers."
          >
            <input
              id="brick-stock-quantite"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
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
        </div>

        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            wouldGoNegative
              ? 'border-error/30 bg-error/10 text-error'
              : 'border-info/30 bg-info/10 text-base-content/80'
          }`}
          role="status"
          aria-live="polite"
        >
          {selected ? (
            wouldGoNegative ? (
              <span>
                <strong>Stock négatif impossible :</strong>{' '}
                {formatQuantity(stockBefore, selected.unit)} →{' '}
                {formatQuantity(projected, selected.unit)}. Retirez au maximum{' '}
                {formatQuantity(stockBefore, selected.unit)}.
              </span>
            ) : (
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span>Nouveau stock prévisionnel :</span>
                <QuantityText value={stockBefore} unit={selected.unit} />
                <span aria-hidden>{delta < 0 ? '−' : delta > 0 ? '+' : '±'}</span>
                <QuantityText value={Math.abs(delta)} unit={selected.unit} />
                <span aria-hidden>=</span>
                <strong className="tabular">
                  <QuantityText value={projected} unit={selected.unit} />
                </strong>
                {projected <= 0 && <span className="font-medium">(rupture de stock)</span>}
                {projected > 0 &&
                  selected.stockMin > 0 &&
                  projected <= selected.stockMin && (
                    <span className="font-medium">(sous le seuil minimum)</span>
                  )}
              </div>
            )
          ) : (
            <span>Sélectionnez un modèle pour voir le stock prévisionnel.</span>
          )}
        </div>

        <FormField
          label="Motif"
          htmlFor="brick-stock-motif"
          required
          hint="Exemple : inventaire du dépôt, casse constatée, écart de comptage…"
        >
          <input
            id="brick-stock-motif"
            type="text"
            className="input input-bordered min-h-11 w-full"
            value={motif}
            onChange={(event) => {
              setMotif(event.target.value);
              setFormError(null);
            }}
            disabled={isSubmitting}
            placeholder="Motif de la correction"
          />
        </FormField>

        {/* Le motif n'est pas décoratif : il est enregistré et relu après coup. */}
        <p className="rounded-lg border border-base-200 bg-base-200/40 px-3 py-2 text-xs text-base-content/60">
          Le motif est <strong>journalisé</strong> avec l’écart, l’auteur et l’horodatage : il
          apparaît dans l’historique des mouvements du produit et dans le journal d’actions. Un
          ajustement sans motif est refusé par le serveur.
        </p>

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
            disabled={isSubmitting || !selected || !quantityValid || !motifFilled}
          >
            {isSubmitting ? (
              <>
                <span className="loading loading-spinner loading-sm" aria-hidden />
                Enregistrement…
              </>
            ) : (
              'Enregistrer l’ajustement'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ==================================================================
 * Modale — historique des mouvements d'un produit fini
 * ================================================================== */

/**
 * `GET /api/stocks/mouvements?productId=<id>&limit=100` exige la permission
 * `stock.view` : l'entrée qui ouvre cette modale n'est donc affichée qu'aux
 * utilisateurs qui la détiennent (voir la page).
 */
function StockMovementsModal({
  isOpen,
  onClose,
  line,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** `null` = aucune ligne ciblée : l'état booléen de la page décide seul. */
  line: BrickStockLine | null;
}) {
  const [movements, setMovements] = useState<StockMovementRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Relance de la requête : un « Réessayer » ne peut pas être un no-op. */
  const [retryToken, setRetryToken] = useState(0);

  const productId = line?.productId ?? null;

  // Réouverture sur un autre produit : on repart de la première page.
  useEffect(() => {
    setPage(1);
  }, [productId]);

  useEffect(() => {
    if (!isOpen || !productId) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    // Contrat de `GET /api/stocks/mouvements` : `?productId=&type=&from=&to=&page=&limit=`.
    fetch(
      `/api/stocks/mouvements?productId=${productId}&limit=${HISTORY_LIMIT}&page=${page}`,
      {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Historique indisponible.'));
        }
        return (await response.json()) as Paginated<StockMovementRow>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setMovements(Array.isArray(payload.data) ? payload.data : []);
        setTotal(numberOrZero(payload.total));
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Historique indisponible.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [isOpen, productId, page, retryToken]);

  const totalPages = Math.max(1, Math.ceil(total / HISTORY_LIMIT));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      fullScreenMobile
      title={
        line ? `Mouvements — ${line.brickTypeName}` : 'Historique des mouvements du produit'
      }
    >
      <div className="space-y-4">
        <div className="grid gap-x-6 gap-y-1 rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 sm:grid-cols-2">
          <InfoRow label="Modèle">{line?.brickTypeName ?? '—'}</InfoRow>
          <InfoRow label="Produit lié">{line?.productName ?? '—'}</InfoRow>
          <InfoRow label="Stock théorique">
            <QuantityText value={line?.stock ?? 0} unit={line?.unit} />
          </InfoRow>
          <InfoRow label="État">
            {line ? <StockStateBadge line={line} /> : '—'}
          </InfoRow>
        </div>

        <p className="text-xs text-base-content/55">
          Journal du produit lié : entrées de lots, sorties de ventes et pertes, corrections
          d’inventaire. Le stock après mouvement est celui qui était enregistré à cet instant.
        </p>

        {isLoading && movements.length === 0 ? (
          <SkeletonTable rows={5} cols={5} />
        ) : error ? (
          <ErrorState
            title="Historique indisponible"
            description={error}
            onRetry={() => setRetryToken((token) => token + 1)}
          />
        ) : movements.length === 0 ? (
          <EmptyState
            title="Aucun mouvement"
            description="Ce produit n’a encore enregistré ni entrée, ni sortie, ni ajustement d’inventaire."
          />
        ) : (
          <>
            <ResponsiveTable
              columns={movementColumns}
              data={movements}
              getRowKey={(movement) => movement.id}
              emptyMessage="Aucun mouvement pour ce produit."
            />
            <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
            <p className="text-center text-xs text-base-content/50">
              {formatNumber(total)} mouvement{total > 1 ? 's' : ''} au journal
              {totalPages > 1 ? ` — page ${page} sur ${totalPages}` : ''}
            </p>
          </>
        )}

        <div className="flex justify-end border-t border-base-200 pt-4">
          <button type="button" onClick={onClose} className="btn btn-ghost min-h-11">
            Fermer
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ==================================================================
 * Page
 * ================================================================== */

export default function BriqueterieStockPage() {
  const B = useBranch();
  const canAdjust = usePermission('stock.adjust');
  // Le journal des mouvements est gardé par `stock.view`, pas par `brick.view`.
  const canViewMovements = usePermission('stock.view');
  const { scope, setScope, storeParam, withStore, showStore } = useBrickScope();
  const { activeStoreId } = useAuth();
  /** Un ajustement va dans le magasin actif : seulement sur ses propres lignes. */
  const adjustable = useCallback((line: BrickStockLine) => line.storeId === activeStoreId, [activeStoreId]);

  /* ── Filtres ──────────────────────────────────────────────────────── */
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [page, setPage] = useState(1);

  /* ── Données : une seule route porte les lignes et la synthèse ────── */
  const [lines, setLines] = useState<BrickStockLine[]>([]);
  const [summary, setSummary] = useState<BrickStockSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  /* ── Modales : un état booléen chacune, jamais un « mode » ────────── */
  const [isAdjustOpen, setIsAdjustOpen] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<BrickStockLine | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<BrickStockLine | null>(null);

  /* ── Débounce de la recherche (300 ms) ────────────────────────────── */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* ── Restauration d'état au retour arrière ────────────────────────── */
  const rehydrated = useViewStateRehydration<StockViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.lowOnly !== undefined) setLowOnly(saved.lowOnly);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, lowOnly, page });
  }, [rehydrated, search, lowOnly, page]);

  /* ── Chargement ───────────────────────────────────────────────────── */
  useEffect(() => {
    // Gaté sur la réhydratation : sans cela la page partirait chercher la
    // page 1 puis relancerait aussitôt pour la page restaurée (retour arrière).
    if (!rehydrated) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    fetch(withStore(branchApiUrl('/stock')), {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Chargement du stock impossible.'));
        }
        return (await response.json()) as BrickStockPayload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setLines(Array.isArray(payload.data) ? payload.data : []);
        setSummary(payload.summary ?? null);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(
          caught instanceof Error ? caught.message : 'Chargement du stock impossible.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [rehydrated, refreshToken, storeParam, withStore]);

  /* ── Rafraîchissement (jeton) ─────────────────────────────────────── */
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  /* ── Lignes en alerte : union « seuil atteint » et « rupture » ────── */
  const alertLines = useMemo(
    () =>
      lines
        .filter((line) => line.isLow || line.isOut)
        // Les ruptures d'abord : c'est ce qui bloque une vente.
        .sort((a, b) => Number(b.isOut) - Number(a.isOut) || a.stock - b.stock),
    [lines],
  );
  const outCount = alertLines.filter((line) => line.isOut).length;
  // `isLow` inclut les ruptures (le serveur compare `stock <= seuil`) : on
  // sépare les deux compteurs pour que l'addition affichée soit exacte.
  const lowCount = alertLines.length - outCount;

  /* ── Filtrage local : la route renvoie la liste complète ──────────── */
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    return lines.filter((line) => {
      if (lowOnly && !(line.isLow || line.isOut)) return false;
      if (!term) return true;
      return [line.brickTypeName, line.productName, line.shape, line.dimensions ?? '']
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }, [lines, debouncedSearch, lowOnly]);

  const hasFilters = Boolean(search.trim()) || lowOnly;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  /*
   * Page bornée à la lecture plutôt que corrigée par un effet : une page
   * restaurée peut devenir hors bornes après filtrage, et un `setState` dans un
   * effet ferait rendre la liste vide une fois avant de se corriger.
   */
  const currentPage = Math.min(page, totalPages);
  const visibleLines = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );

  const resetFilters = useCallback(() => {
    setSearch('');
    setLowOnly(false);
    setPage(1);
  }, []);

  /* ── Ouvertures de modales ────────────────────────────────────────── */
  const openAdjust = useCallback((line: BrickStockLine | null) => {
    setAdjustTarget(line);
    setIsAdjustOpen(true);
  }, []);

  const openHistory = useCallback((line: BrickStockLine) => {
    setHistoryTarget(line);
    setIsHistoryOpen(true);
  }, []);

  /* ── Rendu ────────────────────────────────────────────────────────── */
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow={B.branch.name}
        title="Stock des produits finis"
        description="Stock des pièces finies, seuils minimum et valeur du stock : chaque modèle est suivi par le produit qui le porte au catalogue."
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost min-h-11 border border-base-300"
              onClick={refresh}
              disabled={isLoading}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 00-14.9-3M4 15a8 8 0 0014.9 3"
                />
              </svg>
              Actualiser
            </button>
            {canAdjust && (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => openAdjust(null)}
              >
                Ajuster le stock
              </button>
            )}
          </>
        }
      />

      <BrickTabs scope={scope} onScopeChange={setScope} />

      {/* 2 · Cartes de synthèse */}
      {isLoading ? (
        <SkeletonCards count={4} />
      ) : error ? (
        /*
         * Une seule requête alimente les cartes **et** la liste : un seul
         * message d'erreur suffit, avec un seul bouton « Réessayer ».
         */
        <ErrorState
          title="Stock de la filiale indisponible"
          description={error}
          onRetry={refresh}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardDelta
            label="Quantité en stock"
            tooltip="Total des pièces en stock dans les magasins affichés : le stock du produit lié à chaque modèle."
            tone="info"
            value={<QuantityText value={summary?.totalQuantity ?? 0} />}
            hint={`${formatNumber(lines.length)} type${lines.length > 1 ? 's' : ''} de pièce suivi${lines.length > 1 ? 's' : ''}`}
          />
          <StatCardDelta
            label="Valeur d’achat"
            tooltip="Quantité en stock multipliée par le prix d’achat de la fiche produit. Une pièce fabriquée a souvent un prix d’achat nul : voir le coût de revient sur les lots."
            tone="primary"
            value={<MoneyText value={summary?.totalPurchaseValue ?? 0} />}
            hint="Stock × prix d’achat du produit"
          />
          <StatCardDelta
            label="Valeur de vente"
            tooltip="Ce que rapporterait le stock vendu au prix de vente de chaque produit."
            tone="success"
            value={<MoneyText value={summary?.totalSaleValue ?? 0} />}
            hint="Stock × prix de vente"
          />
          <StatCardDelta
            label="Alertes"
            tooltip="Modèles dont le stock est au seuil minimum ou épuisé."
            tone={outCount > 0 ? 'error' : 'warning'}
            value={alertLines.length}
            hint={`${formatNumber(lowCount)} sous le seuil · ${formatNumber(outCount)} en rupture`}
          />
        </div>
      )}

      {/* 4 · Alerte de stock faible : icône + badge texte, jamais la couleur seule */}
      {!isLoading && !error && alertLines.length > 0 && (
        <Card className="border-warning/40 bg-warning/5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0 text-warning" aria-hidden>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v4m0 3.5h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                />
              </svg>
            </span>
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">Alerte de stock faible</h2>
                <Badge tone={outCount > 0 ? 'error' : 'warning'}>
                  {alertLines.length} produit{alertLines.length > 1 ? 's' : ''} concerné
                  {alertLines.length > 1 ? 's' : ''}
                </Badge>
              </div>
              <p className="text-sm text-base-content/70">
                {formatNumber(lowCount)} type{lowCount > 1 ? 's' : ''} de pièce au seuil minimum
                {outCount > 0
                  ? ` et ${formatNumber(outCount)} en rupture de stock : une vente sur ces produits ne peut plus être servie.`
                  : ' : à réapprovisionner avant la prochaine vente.'}
              </p>
              <ul className="flex flex-wrap gap-2">
                {alertLines.slice(0, 6).map((line) => (
                  <li key={line.brickTypeId}>
                    <Badge tone={line.isOut ? 'error' : 'warning'}>
                      {line.isOut ? 'Rupture' : 'Seuil atteint'} · {line.brickTypeName} —{' '}
                      <QuantityText value={line.stock} unit={line.unit} />
                    </Badge>
                  </li>
                ))}
              </ul>
              {alertLines.length > 6 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm min-h-11 border border-base-300"
                  onClick={() => {
                    setLowOnly(true);
                    setPage(1);
                  }}
                >
                  Voir les {formatNumber(alertLines.length)} produits en alerte
                </button>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* 3 · Barre d'outils */}
      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un modèle ou un produit…"
        filters={
          <button
            type="button"
            onClick={() => {
              setLowOnly((current) => !current);
              setPage(1);
            }}
            aria-pressed={lowOnly}
            className={`btn min-h-11 ${
              lowOnly ? 'btn-warning' : 'btn-ghost border border-base-300'
            }`}
          >
            Seulement les alertes
          </button>
        }
      />

      {hasFilters && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/60">
          <span>Filtres actifs :</span>
          {search.trim() && <Badge tone="info">Recherche : {search}</Badge>}
          {lowOnly && <Badge tone="warning">Seulement les alertes</Badge>}
          <button type="button" className="btn btn-ghost btn-xs min-h-11" onClick={resetFilters}>
            Réinitialiser
          </button>
        </div>
      )}

      {/* 4 · Liste */}
      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        // L'erreur est déjà affichée au-dessus, avec son bouton « Réessayer ».
        null
      ) : filtered.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'Aucun produit ne correspond' : 'Aucun produit fini suivi'}
          description={
            hasFilters
              ? 'Aucun modèle ne correspond à cette recherche ou au filtre « Seulement les alertes ». Réinitialisez les filtres pour revoir tout le stock.'
              : 'Aucun modèle n’est encore rattaché à un produit : le stock ne peut pas être suivi tant que le catalogue n’est pas relié à la fabrication.'
          }
          action={
            hasFilters ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                Réinitialiser les filtres
              </button>
            ) : (
              <Link href={B.href('')} className="btn btn-primary min-h-11">
                Ouvrir la filiale
              </Link>
            )
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={buildStockColumns(showStore)}
            data={visibleLines}
            getRowKey={(line) => line.brickTypeId}
            actions={(line) => (
              <RowActions>
                {canViewMovements && (
                  <IconAction
                    icon="history"
                    label={`Historique des mouvements — ${line.brickTypeName}`}
                    onClick={() => openHistory(line)}
                  />
                )}
                {canAdjust && adjustable(line) && (
                  <IconAction
                    icon="adjust"
                    tone="primary"
                    label={`Ajuster le stock — ${line.brickTypeName}`}
                    onClick={() => openAdjust(line)}
                  />
                )}
              </RowActions>
            )}
          />
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setPage}
          />
          <p className="text-center text-xs text-base-content/50">
            {formatNumber(filtered.length)} type{filtered.length > 1 ? 's' : ''} de pièce affiché
            {filtered.length > 1 ? 's' : ''} — page {currentPage} sur {totalPages}
          </p>
        </>
      )}

      {/* 5 · Modales */}
      <StockAdjustModal
        isOpen={isAdjustOpen}
        onClose={() => setIsAdjustOpen(false)}
        lines={lines.filter(adjustable)}
        initialLine={adjustTarget}
        onAdjusted={refresh}
      />

      <StockMovementsModal
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        line={historyTarget}
      />
    </div>
  );
}
