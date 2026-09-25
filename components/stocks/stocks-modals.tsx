'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { Badge, EmptyState, FormField, InfoRow, QuantityText, Skeleton, SkeletonTable, type BadgeTone } from '@/components/design-system';
import { ToolbarButton } from '@/components/data-toolbar';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { formatQuantity } from '@/lib/format';
import { formatDateTime } from '@/lib/date-format';

/* ==================================================================
 * Composants propres au domaine « Stocks » (§2 : components/stocks/).
 *
 * Deux modales, chacune pilotée par **un seul état booléen** côté page
 * (§7 « Modale pilotée par une chaîne » interdit) :
 *   - `StockAdjustModal`  : correction d'inventaire (écart **signé**) ;
 *   - `ProductHistoryModal` : journal des mouvements d'un produit.
 *
 * Aucune écriture ne part d'ici : la correction passe par
 * `POST /api/stocks/adjust`, donc par `adjustStock()` de `lib/stock.ts`.
 *
 * ⚠️ Les types sont **redéclarés** ici plutôt qu'importés de `lib/stock.ts` :
 * ce fichier est un composant client, et `lib/stock.ts` importe `db/` (donc
 * `@libsql/client`, `fs`, `path`). Un import — même partiel — ferait entrer la
 * chaîne base de données dans le bundle navigateur. Les formes ci-dessous
 * décrivent exactement le JSON renvoyé par les routes `/api/stocks/*`.
 * ================================================================== */

export type StockMovementType = 'entry' | 'exit' | 'adjustment';

/** Libellés français des trois seuls types de mouvement (§12). */
export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  entry: 'Entrée',
  exit: 'Sortie',
  adjustment: 'Ajustement',
};

/** Produit enrichi de son état de stock — `listStockProducts()`. */
export type StockProduct = {
  id: number;
  code: string;
  name: string;
  unit: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryKind: string | null;
  stock: number;
  stockMin: number;
  purchasePrice: number;
  salePrice: number;
  stockValue: number;
  saleValue: number;
  isLow: boolean;
  isOut: boolean;
};

/** Ligne du journal de stock — `listStockMovements()`. */
export type StockMovementRow = {
  id: number;
  productId: number;
  productCode: string;
  productName: string;
  unit: string;
  type: StockMovementType;
  quantity: number;
  motif: string;
  stockBefore: number;
  stockAfter: number;
  referenceType: string | null;
  referenceId: number | null;
  userId: number | null;
  userName: string | null;
  /** Horodatage sérialisé en JSON par la route (jamais une `Date` côté client). */
  createdAt: string | null;
};

/** Synthèse de `GET /api/stocks/summary`. */
export type StockSummary = {
  totalProducts: number;
  totalStock: number;
  totalStockValue: number;
  totalSaleValue: number;
  lowStockCount: number;
  outOfStockCount: number;
};

/** Réponse normalisée d'une liste paginée (§27.2). */
export type Paginated<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

const MOVEMENT_TONES: Record<StockMovementType, BadgeTone> = {
  entry: 'success',
  exit: 'warning',
  adjustment: 'info',
};

/** Libellé français d'un type de mouvement — jamais la couleur seule. */
export function movementLabel(type: StockMovementType): string {
  return STOCK_MOVEMENT_LABELS[type] ?? type;
}

/**
 * Quantité **signée** du journal : `entry` et `adjustment` positif ajoutent,
 * `exit` retire ; un `adjustment` négatif retire aussi. Le signe est toujours
 * explicite, sinon deux lignes opposées se lisent identiquement.
 */
export function signedMovementQuantity(movement: StockMovementRow): number {
  if (movement.type === 'exit') return -Math.abs(movement.quantity);
  return movement.quantity;
}

function MovementTypeBadge({ type }: { type: StockMovementType }) {
  return <Badge tone={MOVEMENT_TONES[type] ?? 'neutral'}>{movementLabel(type)}</Badge>;
}

function SignedQuantityText({ movement }: { movement: StockMovementRow }) {
  const signed = signedMovementQuantity(movement);
  const tone = signed < 0 ? 'text-error' : 'text-success';

  return (
    <span className={`inline-flex items-baseline gap-0.5 font-medium ${tone}`}>
      <span aria-hidden>{signed < 0 ? '−' : '+'}</span>
      <QuantityText value={Math.abs(signed)} unit={movement.unit} />
    </span>
  );
}

/** Colonnes du journal des mouvements — partagées par la page et la modale. */
export const movementColumns: Column<StockMovementRow>[] = [
  {
    key: 'date',
    label: 'Date',
    className: 'whitespace-nowrap text-xs text-base-content/60',
    render: (m) => formatDateTime(m.createdAt),
  },
  {
    key: 'product',
    label: 'Produit',
    primary: true,
    render: (m) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{m.productName}</div>
      </div>
    ),
  },
  {
    key: 'type',
    label: 'Type',
    render: (m) => <MovementTypeBadge type={m.type} />,
  },
  {
    key: 'quantity',
    label: 'Quantité',
    className: 'whitespace-nowrap',
    render: (m) => <SignedQuantityText movement={m} />,
  },
  {
    key: 'motif',
    label: 'Motif',
    className: 'max-w-[16rem] truncate',
    render: (m) => <span title={m.motif}>{m.motif || '—'}</span>,
  },
  {
    key: 'before',
    label: 'Avant',
    hideOnMobile: true,
    render: (m) => <QuantityText value={m.stockBefore} unit={m.unit} />,
  },
  {
    key: 'after',
    label: 'Après',
    hideOnMobile: true,
    render: (m) => <QuantityText value={m.stockAfter} unit={m.unit} />,
  },
  {
    key: 'user',
    label: 'Utilisateur',
    render: (m) => <span className="text-sm">{m.userName ?? 'Système'}</span>,
  },
];

/* ------------------------------------------------------------------
 * Modale — historique des mouvements d'un produit
 * ------------------------------------------------------------------ */

const HISTORY_LIMIT = 20;

export function ProductHistoryModal({
  isOpen,
  onClose,
  product,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** `null` = aucune modale ouverte : l'état booléen de la page décide seul. */
  product: StockProduct | null;
}) {
  const [movements, setMovements] = useState<StockMovementRow[]>([]);
  const [movementTotal, setMovementTotal] = useState(0);
  const [movementPage, setMovementPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Relance de la dernière requête : un « Réessayer » ne peut pas être un no-op. */
  const [retryToken, setRetryToken] = useState(0);

  const productId = product?.id ?? null;

  const load = useCallback(
    async (signal: AbortSignal, id: number, page: number) => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          productId: String(id),
          page: String(page),
          limit: String(HISTORY_LIMIT),
        });
        const res = await fetch(`/api/stocks/mouvements?${params.toString()}`, {
          signal,
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error ?? "Chargement de l'historique impossible");
        }
        const payload: Paginated<StockMovementRow> = await res.json();
        if (signal.aborted) return;
        setMovements(Array.isArray(payload.data) ? payload.data : []);
        setMovementTotal(Number(payload.total ?? 0));
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setError(err?.message ?? "Chargement de l'historique impossible");
      } finally {
        if (!signal.aborted) setIsLoading(false);
      }
    },
    [],
  );

  // Un seul effet : `isOpen` ouvre la modale, `productId` / `movementPage`
  // changent la requête. Toute réponse obsolète est annulée (§5 « AbortController »).
  useEffect(() => {
    if (!isOpen || !productId) return;

    const controller = new AbortController();
    void load(controller.signal, productId, movementPage);
    return () => controller.abort();
  }, [isOpen, productId, movementPage, retryToken, load]);

  // Réouverture sur un autre produit : on repart de la première page.
  useEffect(() => {
    setMovementPage(1);
  }, [productId]);

  const totalPages = Math.max(1, Math.ceil(movementTotal / HISTORY_LIMIT));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      fullScreenMobile
      title={product ? `Historique — ${product.name}` : 'Historique des mouvements'}
    >
      <div className="space-y-4">
        <div className="grid gap-x-6 gap-y-1 rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 sm:grid-cols-2">
          <InfoRow label="Code produit">{product?.code ?? '—'}</InfoRow>
          <InfoRow label="Catégorie">{product?.categoryName ?? 'Non classé'}</InfoRow>
          <InfoRow label="Stock théorique">
            <QuantityText value={product?.stock ?? 0} unit={product?.unit} />
          </InfoRow>
          <InfoRow label="Seuil d'alerte">
            <QuantityText value={product?.stockMin ?? 0} unit={product?.unit} />
          </InfoRow>
        </div>

        {isLoading && movements.length === 0 ? (
          <SkeletonTable rows={5} cols={4} />
        ) : error ? (
          <EmptyState
            title="Historique indisponible"
            description={error}
            action={
              <ToolbarButton onClick={() => setRetryToken((token) => token + 1)}>
                Réessayer
              </ToolbarButton>
            }
          />
        ) : movements.length === 0 ? (
          <EmptyState
            title="Aucun mouvement"
            description="Ce produit n'a encore enregistré ni entrée, ni sortie, ni ajustement."
          />
        ) : (
          <>
            <ResponsiveTable
              columns={movementColumns}
              data={movements}
              getRowKey={(m) => m.id}
              emptyMessage="Aucun mouvement pour ce produit."
            />

            {totalPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-200 pt-3">
                <span className="text-xs text-base-content/50">
                  Page {movementPage} sur {totalPages} — {movementTotal} mouvement
                  {movementTotal > 1 ? 's' : ''}
                </span>
                <div className="flex items-center gap-2">
                  <ToolbarButton
                    onClick={() => setMovementPage((p) => Math.max(1, p - 1))}
                    disabled={movementPage <= 1 || isLoading}
                  >
                    Précédent
                  </ToolbarButton>
                  <ToolbarButton
                    onClick={() => setMovementPage((p) => Math.min(totalPages, p + 1))}
                    disabled={movementPage >= totalPages || isLoading}
                  >
                    Suivant
                  </ToolbarButton>
                </div>
              </div>
            )}
          </>
        )}

        <div className="flex justify-end border-t border-base-200 pt-4">
          <button type="button" onClick={onClose} className="btn btn-ghost">
            Fermer
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------
 * Modale — ajustement d'inventaire (écart signé)
 * ------------------------------------------------------------------ */

/**
 * Ajustement = **écart signé**, jamais une valeur absolue (§12).
 *
 * Formulation retenue pour rester sans ambiguïté pour un magasinier :
 * on choisit d'abord le **sens** (« Ajouter au stock » / « Retirer du stock »)
 * puis une **quantité positive** ; l'écart envoyé à l'API vaut `+quantité` ou
 * `−quantité`. Le stock théorique et le stock prévisionnel sont affichés en
 * direct, et un retrait qui rendrait le stock négatif est bloqué avant l'envoi
 * (le serveur le refuserait de toute façon : `InsufficientStockError`).
 */
export function StockAdjustModal({
  isOpen,
  onClose,
  products,
  isListLoading = false,
  onAdjusted,
  initialProduct,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Produits sélectionnables, chargés par la page (`GET /api/stocks?limit=500`). */
  products: StockProduct[];
  /**
   * `true` tant que la liste n'est pas arrivée **et** qu'elle est vide : on
   * affiche un squelette plutôt qu'un faux « aucun produit ».
   */
  isListLoading?: boolean;
  /** Appelée après un ajustement réussi : la page rafraîchit liste et synthèse. */
  onAdjusted: (productId: number) => void;
  initialProduct?: StockProduct | null;
}) {
  const [productId, setProductId] = useState<number | ''>('');
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [quantity, setQuantity] = useState('');
  const [motif, setMotif] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Ouverture : pré-remplissage depuis la ligne cliquée, puis remise à zéro.
  useEffect(() => {
    if (!isOpen) return;
    setProductId(initialProduct?.id ?? '');
    setDirection('add');
    setQuantity('');
    setMotif('');
    setFormError(null);
    setIsSubmitting(false);
  }, [isOpen, initialProduct]);

  const selected = useMemo(
    () => products.find((p) => p.id === productId) ?? null,
    [products, productId],
  );

  const parsedQuantity = Number(String(quantity).replace(',', '.'));
  const quantityValid = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
  const delta = quantityValid ? (direction === 'add' ? parsedQuantity : -parsedQuantity) : 0;
  const stockBefore = selected?.stock ?? 0;
  const projected = stockBefore + delta;
  const wouldGoNegative = quantityValid && projected < 0;

  const stockLabel = selected ? ` (${selected.name})` : '';

  async function submit() {
    if (isSubmitting) return;

    if (!selected) {
      setFormError('Sélectionnez le produit à corriger.');
      return;
    }
    if (!quantityValid) {
      setFormError('Saisissez une quantité strictement positive.');
      return;
    }
    if (wouldGoNegative) {
      setFormError(
        `Retrait impossible : le stock${stockLabel} ne peut pas devenir négatif (maximum ${formatQuantity(stockBefore, selected.unit)}).`,
      );
      return;
    }
    if (!motif.trim()) {
      setFormError("Le motif de l'ajustement est obligatoire : il justifie l'écart dans le journal.");
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch('/api/stocks/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ productId: selected.id, delta, motif: motif.trim() }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Ajustement impossible');
      }

      const payload: { stockBefore: number; stockAfter: number } = await res.json();
      toast.success(
        `Stock ajusté : ${formatQuantity(payload.stockBefore, selected.unit)} → ${formatQuantity(payload.stockAfter, selected.unit)}`,
      );
      onAdjusted(selected.id);
      onClose();
    } catch (err: any) {
      const message = err?.message ?? 'Ajustement impossible';
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
      title="Ajuster un stock"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          La correction enregistre un <strong>écart</strong> dans le journal
          (<em>ajustement d&apos;inventaire</em>), jamais une valeur absolue : le stock affiché doit
          toujours rester égal à la somme des mouvements.
        </p>

        <FormField label="Produit" htmlFor="stock-adjust-product" required>
          {isListLoading ? (
            <Skeleton className="h-11 w-full" />
          ) : products.length === 0 ? (
            <p className="rounded-lg border border-base-200 bg-base-200/50 px-3 py-2 text-sm text-base-content/60">
              Aucun produit actif à ajuster : créez d&apos;abord un produit dans le catalogue.
            </p>
          ) : (
            <select
              id="stock-adjust-product"
              className="select select-bordered min-h-11 w-full"
              value={productId === '' ? '' : String(productId)}
              onChange={(event) => {
                const value = event.target.value;
                setProductId(value ? Number(value) : '');
                setFormError(null);
              }}
              disabled={isSubmitting}
            >
              <option value="">— Sélectionner un produit —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </select>
          )}
        </FormField>

        {selected && (
          <div className="grid gap-x-6 gap-y-1 rounded-xl border border-base-200 px-4 py-3 sm:grid-cols-2">
            <InfoRow label="Stock théorique actuel">
              <QuantityText value={stockBefore} unit={selected.unit} />
            </InfoRow>
            <InfoRow label="Seuil d'alerte">
              <QuantityText value={selected.stockMin} unit={selected.unit} />
            </InfoRow>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Sens de l'ajustement" required>
            <div role="group" aria-label="Sens de l'ajustement" className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setDirection('add');
                  setFormError(null);
                }}
                disabled={isSubmitting}
                aria-pressed={direction === 'add'}
                className={`btn min-h-11 flex-1 ${direction === 'add' ? 'btn-success' : 'btn-ghost border border-base-300'}`}
              >
                Ajouter au stock
              </button>
              <button
                type="button"
                onClick={() => {
                  setDirection('remove');
                  setFormError(null);
                }}
                disabled={isSubmitting}
                aria-pressed={direction === 'remove'}
                className={`btn min-h-11 flex-1 ${direction === 'remove' ? 'btn-warning' : 'btn-ghost border border-base-300'}`}
              >
                Retirer du stock
              </button>
            </div>
          </FormField>

          <FormField
            label="Quantité"
            htmlFor="stock-adjust-quantity"
            required
            hint="Décimale acceptée : le m² et le kg ne sont pas entiers."
          >
            <input
              id="stock-adjust-quantity"
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
                {formatQuantity(stockBefore, selected.unit)} → {formatQuantity(projected, selected.unit)}.
                Retirez au maximum {formatQuantity(stockBefore, selected.unit)}.
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
                {projected <= 0 && <span className="text-error">(rupture de stock)</span>}
                {projected > 0 && selected.stockMin > 0 && projected <= selected.stockMin && (
                  <span className="text-warning">(sous le seuil d&apos;alerte)</span>
                )}
              </div>
            )
          ) : (
            <span>Sélectionnez un produit pour voir le stock prévisionnel.</span>
          )}
        </div>

        <FormField
          label="Motif"
          htmlFor="stock-adjust-motif"
          required
          hint="Exemple : inventaire du 12/03, casse, chute de bois, erreur de saisie…"
        >
          <input
            id="stock-adjust-motif"
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
            disabled={isSubmitting || products.length === 0}
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
