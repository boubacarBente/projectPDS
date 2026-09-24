'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  EmptyState,
  ErrorState,
  MoneyText,
  PageSection,
  QuantityText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useViewStateRehydration, writeViewState, clampPage } from '@/lib/view-state';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, formatPercent, formatQuantity } from '@/lib/format';
import {
  BRICK_STAGE_LABELS,
  BRICK_STAGE_TONES,
  BrickProductionModal,
  BrickTypesManagerModal,
  BrokenBricksModal,
  BrickWorkersManagerButton,
  brickProductionColumns,
  brickShapeLabel,
  brickStageLabel,
  goodQuantityOf,
  nextBrickStage,
  readApiError,
  type BrickProductionRow,
  type BrickStage,
  type BrickSummary,
  type BrickTypeRow,
  type Paginated,
} from '@/components/briqueterie/briqueterie-modals';

/* ==================================================================
 * Page « Briqueterie » (README §20).
 *
 * Vue d'ensemble : synthèse de la période, rapport fabriquées / cassées /
 * vendues par type, liste des lots filtrable par type, par étape et par
 * période, et deux modales d'action (« Nouveau lot », « Types de briques »).
 *
 * Les matières premières et l'équipe se gèrent depuis la fiche du lot
 * (`/briqueterie/[id]`) : chaque écriture y déclenche un mouvement de stock
 * côté serveur, jamais depuis cette page.
 *
 * ⚠️ Aucun import runtime de `lib/brick.ts` : ce module touche `@/db`. Les
 * types et libellés sont redéclarés dans `components/briqueterie/`, et toute la
 * donnée passe par `/api/briqueterie/*` (CONVENTIONS §11 bis).
 * ================================================================== */

const PRODUCTIONS_LIMIT = 20;

/** Clé d'état de vue — doit rester stable pour que le retour arrière restaure. */
const VIEW_NAME = 'briqueterie';

type ProductionsViewState = {
  search: string;
  brickTypeId: string;
  stage: string;
  from: string;
  to: string;
  page: number;
};

function buildQuery(entries: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/** Forme d'un type, à partir de la liste chargée — repli neutre si absente. */
function shapeOfType(types: BrickTypeRow[], brickTypeId: number): string | null {
  return types.find((type) => type.id === brickTypeId)?.shape ?? null;
}

export default function BriqueteriePage() {
  const canCreate = usePermission('brick.create');
  const canUpdate = usePermission('brick.update');

  /* ── Filtres de la liste ──────────────────────────────────────────── */
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [brickTypeId, setBrickTypeId] = useState('');
  const [stage, setStage] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  /* ── Données ──────────────────────────────────────────────────────── */
  const [productions, setProductions] = useState<BrickProductionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [types, setTypes] = useState<BrickTypeRow[]>([]);
  const [typesLoaded, setTypesLoaded] = useState(false);

  const [summary, setSummary] = useState<BrickSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryToken, setSummaryToken] = useState(0);

  /* ── Modales : un état booléen chacune (§8.3 règle 1) ─────────────── */
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isTypesOpen, setIsTypesOpen] = useState(false);
  const [isBrokenOpen, setIsBrokenOpen] = useState(false);
  const [brokenTarget, setBrokenTarget] = useState<BrickProductionRow | null>(null);
  const [isAdvancing, setIsAdvancing] = useState<number | null>(null);

  const requestGate = useRef(false);

  /* ── Débounce de la recherche (300 ms, §5) ────────────────────────── */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* ── Liste des types : filtre + sélecteur de la modale ────────────── */
  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/briqueterie/types?limit=200', {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Types de briques indisponibles.'));
        }
        return (await response.json()) as Paginated<BrickTypeRow>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setTypes(Array.isArray(payload.data) ? payload.data : []);
      })
      .catch(() => {
        // Liste d'appoint : son échec ne doit pas masquer la page principale.
      })
      .finally(() => {
        if (!controller.signal.aborted) setTypesLoaded(true);
      });

    return () => controller.abort();
  }, [reloadToken]);

  /* ── Synthèse de la période ───────────────────────────────────────── */
  useEffect(() => {
    const controller = new AbortController();
    setSummaryLoading(true);
    setSummaryError(null);

    const query = buildQuery({ stats: 1, from, to });

    fetch(`/api/briqueterie/productions?${query}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Synthèse indisponible.'));
        }
        return (await response.json()) as { summary: BrickSummary };
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setSummary(payload.summary ?? null);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setSummaryError(caught instanceof Error ? caught.message : 'Synthèse indisponible');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSummaryLoading(false);
      });

    return () => controller.abort();
  }, [from, to, summaryToken]);

  /* ── Liste des lots ───────────────────────────────────────────────── */
  useEffect(() => {
    // Le gate sur `typesLoaded` évite de partir chercher les lots avant que le
    // filtre « type » ne soit alimenté, et garantit qu'un seul fetch est en vol.
    if (!typesLoaded) return;
    if (requestGate.current) return;
    requestGate.current = true;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    const query = buildQuery({
      search: debouncedSearch,
      brickTypeId: brickTypeId ? Number(brickTypeId) : undefined,
      stage,
      from,
      to,
      page,
      limit: PRODUCTIONS_LIMIT,
    });

    fetch(`/api/briqueterie/productions?${query}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Chargement des lots impossible.'));
        }
        return (await response.json()) as Paginated<BrickProductionRow>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setProductions(Array.isArray(payload.data) ? payload.data : []);
        setTotal(Number(payload.total ?? 0));
        const pages = Number(payload.totalPages ?? 1) || 1;
        setTotalPages(pages);
        const corrected = clampPage(page, pages);
        if (corrected !== null) setPage(corrected);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Chargement des lots impossible.');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
          requestGate.current = false;
        }
      });

    return () => {
      controller.abort();
      requestGate.current = false;
    };
  }, [typesLoaded, page, debouncedSearch, brickTypeId, stage, from, to, reloadToken]);

  /* ── Restauration d'état au retour arrière (§5) ───────────────────── */
  const rehydrated = useViewStateRehydration<ProductionsViewState>(VIEW_NAME, (saved) => {
    if (saved.search !== undefined) {
      setSearch(saved.search);
      setDebouncedSearch(saved.search);
    }
    if (saved.brickTypeId !== undefined) setBrickTypeId(saved.brickTypeId);
    if (saved.stage !== undefined) setStage(saved.stage);
    if (saved.from !== undefined) setFrom(saved.from);
    if (saved.to !== undefined) setTo(saved.to);
    if (saved.page) setPage(saved.page);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, brickTypeId, stage, from, to, page });
  }, [rehydrated, search, brickTypeId, stage, from, to, page]);

  /* ── Rafraîchissements ────────────────────────────────────────────── */
  const refreshAll = useCallback(() => {
    setReloadToken((token) => token + 1);
    setSummaryToken((token) => token + 1);
  }, []);

  const refreshSummary = useCallback(() => setSummaryToken((token) => token + 1), []);
  const refreshList = useCallback(() => setReloadToken((token) => token + 1), []);

  /* ── Étape suivante : le crédit de stock est géré côté serveur ────── */
  const advance = useCallback(
    async (production: BrickProductionRow) => {
      const next = nextBrickStage(production.stage);
      if (!next) return;

      setIsAdvancing(production.id);
      try {
        const response = await fetch(`/api/briqueterie/productions/${production.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'advance_stage', stage: next.key }),
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, 'Le passage d’étape a échoué.'));
        }

        const updated = (await response.json()) as BrickProductionRow;

        if (next.key === 'stored') {
          toast.success(
            `Lot ${updated.batchNumber} mis en stock : ${formatQuantity(goodQuantityOf(updated), updated.productUnit)} créditées au produit ${updated.productName}.`,
          );
        } else {
          toast.success(`Lot ${updated.batchNumber} — étape « ${brickStageLabel(next.key)} ».`);
        }

        refreshAll();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : 'Le passage d’étape a échoué.');
      } finally {
        setIsAdvancing(null);
      }
    },
    [refreshAll],
  );

  /* ── Options de filtre ────────────────────────────────────────────── */
  const typeFilterOptions = useMemo(
    () =>
      types.map((type) => ({
        value: String(type.id),
        label: `${type.name}${type.dimensions ? ` — ${type.dimensions}` : ''}`,
      })),
    [types],
  );

  const stageFilterOptions = useMemo(
    () =>
      (Object.keys(BRICK_STAGE_LABELS) as BrickStage[]).map((key) => ({
        value: key,
        label: BRICK_STAGE_LABELS[key],
      })),
    [],
  );

  const hasFilters = Boolean(search || brickTypeId || stage || from || to);

  const resetFilters = useCallback(() => {
    setSearch('');
    setBrickTypeId('');
    setStage('');
    setFrom('');
    setTo('');
    setPage(1);
  }, []);

  /* ── Colonnes : le numéro de lot devient un lien vers la fiche ────── */
  const columns: Column<BrickProductionRow>[] = useMemo(
    () =>
      brickProductionColumns.map((column) =>
        column.key === 'batchNumber'
          ? {
              ...column,
              render: (production: BrickProductionRow) => (
                <div className="min-w-0">
                  <Link
                    href={`/briqueterie/${production.id}`}
                    className="font-mono text-sm font-semibold text-primary hover:underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {production.batchNumber}
                  </Link>
                  <div className="truncate text-xs text-base-content/50">
                    {production.brickTypeName}
                  </div>
                </div>
              ),
            }
          : column,
      ),
    [],
  );

  /* ── Rendu ────────────────────────────────────────────────────────── */
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Production"
        title="Briqueterie"
        description="Lots de fabrication, matières premières consommées, pertes et coût de revient par brique."
        actions={
          <>
            <BrickWorkersManagerButton onChanged={refreshAll} />
            <button
              type="button"
              className="btn btn-ghost min-h-11 border border-base-300"
              onClick={() => setIsTypesOpen(true)}
            >
              Types de briques
            </button>
            {canCreate && (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => setIsCreateOpen(true)}
              >
                Nouveau lot
              </button>
            )}
          </>
        }
      />

      {/* 2 · Cartes de synthèse — fabriquées, cassées, coûts */}
      {summaryLoading ? (
        <SkeletonCards count={6} />
      ) : summaryError ? (
        <ErrorState title="Synthèse indisponible" description={summaryError} onRetry={refreshSummary} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <StatCardDelta
            label="Lots de la période"
            tone="primary"
            value={summary?.productionsCount ?? 0}
            hint={`${summary?.byType.length ?? 0} type(s) de brique`}
          />
          <StatCardDelta
            label="Briques fabriquées"
            tone="success"
            value={<QuantityText value={summary?.good ?? 0} />}
            hint="Production − cassées"
          />
          <StatCardDelta
            label="Briques cassées"
            tone="warning"
            value={<QuantityText value={summary?.broken ?? 0} />}
            hint={
              summary && summary.produced + summary.broken > 0
                ? `${formatPercent((summary.broken / (summary.produced + summary.broken)) * 100)} de la production`
                : 'Aucune perte enregistrée'
            }
          />
          <StatCardDelta
            label="Coût de revient total"
            tone="info"
            value={<MoneyText value={summary?.totalCost ?? 0} />}
            hint="Matières + main-d’œuvre"
          />
          <StatCardDelta
            label="Coût unitaire moyen"
            tone="primary"
            value={<MoneyText value={summary?.averageUnitCost ?? 0} />}
            hint="Par brique bonne"
          />
          <StatCardDelta
            label="Briques vendues"
            tone="success"
            value={<QuantityText value={summary?.sold ?? 0} />}
            hint={
              summary && summary.soldRevenue > 0
                ? `${formatNumber(summary.soldRevenue)} GNF facturés sur la période`
                : 'Aucune vente sur la période'
            }
          />
        </div>
      )}

      {/* Rapport fabriquées / cassées / vendues par type (§20) */}
      <PageSection
        title="Fabriquées, cassées et vendues par type"
        subtitle="Le coût de revient unitaire est calculé : coût total ÷ (production − cassées)."
      >
        {summaryLoading ? (
          <SkeletonTable rows={3} cols={5} />
        ) : (summary?.byType.length ?? 0) === 0 ? (
          <EmptyState
            title="Aucune fabrication sur cette période"
            description="Lancez un premier lot, ou élargissez la période : seuls les lots fabriqués dans l’intervalle apparaissent ici."
            action={
              canCreate ? (
                <button
                  type="button"
                  className="btn btn-primary min-h-11"
                  onClick={() => setIsCreateOpen(true)}
                >
                  Lancer une fabrication
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(summary?.byType ?? []).map((type) => (
              <div
                key={type.brickTypeId}
                className="rounded-xl border border-base-200 bg-base-100 p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{type.brickTypeName}</div>
                    <div className="text-xs text-base-content/50">
                      Coût unitaire <MoneyText value={type.unitCost} />
                    </div>
                  </div>
                  <Badge tone="primary">{brickShapeLabel(shapeOfType(types, type.brickTypeId))}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[11px] uppercase text-base-content/45">Fabriquées</div>
                    <div className="font-semibold text-success">
                      <QuantityText value={type.produced} />
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase text-base-content/45">Cassées</div>
                    <div className="font-semibold text-warning">
                      <QuantityText value={type.broken} />
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase text-base-content/45">Vendues</div>
                    <div className="font-semibold text-info">
                      <QuantityText value={type.sold} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </PageSection>

      {/* 3 · Barre d'outils */}
      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un numéro de lot, un type, une note…"
        filters={
          <>
            <FilterSelect
              value={brickTypeId}
              onChange={(value) => {
                setBrickTypeId(value);
                setPage(1);
              }}
              options={typeFilterOptions}
              placeholder="Tous les types"
            />
            <FilterSelect
              value={stage}
              onChange={(value) => {
                setStage(value);
                setPage(1);
              }}
              options={stageFilterOptions}
              placeholder="Toutes les étapes"
            />
          </>
        }
        secondaryFilters={
          <>
            <div className="space-y-1">
              <DatePicker
                value={from}
                onChange={(value) => {
                  setFrom(value);
                  setPage(1);
                }}
                placeholder="Du"
              />
            </div>
            <div className="space-y-1">
              <DatePicker
                value={to}
                onChange={(value) => {
                  setTo(value);
                  setPage(1);
                }}
                placeholder="Au"
              />
            </div>
            {(from || to) && (
              <button
                type="button"
                className="btn btn-ghost min-h-11 border border-base-300"
                onClick={() => {
                  setFrom('');
                  setTo('');
                  setPage(1);
                }}
              >
                Effacer la période
              </button>
            )}
          </>
        }
        secondaryCount={(from ? 1 : 0) + (to ? 1 : 0)}
      />

      {hasFilters && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/60">
          <span>Filtres actifs :</span>
          {search && <Badge tone="info">Recherche : {search}</Badge>}
          {brickTypeId && (
            <Badge tone="primary">
              Type : {types.find((type) => String(type.id) === brickTypeId)?.name ?? brickTypeId}
            </Badge>
          )}
          {stage && <Badge tone={BRICK_STAGE_TONES[stage as BrickStage]}>{brickStageLabel(stage)}</Badge>}
          {(from || to) && (
            <Badge tone="neutral">
              {from ? formatDateShort(from) : '…'} → {to ? formatDateShort(to) : '…'}
            </Badge>
          )}
          <button type="button" className="btn btn-ghost btn-xs min-h-11" onClick={resetFilters}>
            Réinitialiser
          </button>
        </div>
      )}

      {/* 4 · Liste des lots */}
      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <ErrorState
          title="Chargement des lots impossible"
          description={error}
          onRetry={refreshList}
        />
      ) : productions.length === 0 ? (
        <EmptyState
          title="Aucun lot de fabrication"
          description={
            hasFilters
              ? 'Aucun lot ne correspond à ces filtres. Élargissez la période ou réinitialisez la recherche.'
              : 'Lancez un premier lot : les matières premières consommées sortiront du stock et le coût de revient se calculera automatiquement.'
          }
          action={
            hasFilters ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                Réinitialiser les filtres
              </button>
            ) : canCreate ? (
              <button
                type="button"
                className="btn btn-primary min-h-11"
                onClick={() => setIsCreateOpen(true)}
              >
                Lancer une fabrication
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={columns}
            data={productions}
            getRowKey={(production) => production.id}
            actions={(production) => {
              const next = nextBrickStage(production.stage);
              return (
                <>
                  <Link
                    href={`/briqueterie/${production.id}`}
                    className="btn btn-ghost btn-sm min-h-11 border border-base-300 sm:min-h-0"
                  >
                    Fiche
                  </Link>
                  {canUpdate && next && (
                    <ToolbarButton
                      variant="primary"
                      disabled={isAdvancing === production.id}
                      onClick={() => void advance(production)}
                      title={`Passer à l’étape « ${brickStageLabel(next.key)} »`}
                    >
                      {isAdvancing === production.id ? 'Étape…' : `→ ${brickStageLabel(next.key)}`}
                    </ToolbarButton>
                  )}
                  {canUpdate && (
                    <ToolbarButton
                      variant="outline"
                      onClick={() => {
                        setBrokenTarget(production);
                        setIsBrokenOpen(true);
                      }}
                    >
                      Casse
                    </ToolbarButton>
                  )}
                </>
              );
            }}
          />
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/50">
            {total} lot{total > 1 ? 's' : ''} — page {page} sur {totalPages}
          </p>
        </>
      )}

      {/* 6 · Modales — un état booléen chacune */}
      <BrickProductionModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        brickTypes={types.filter((type) => type.isActive)}
        isOptionsLoading={!typesLoaded}
        onSaved={refreshAll}
      />

      <BrickTypesManagerModal
        isOpen={isTypesOpen}
        onClose={() => setIsTypesOpen(false)}
        onChanged={refreshAll}
        onTypesLoaded={setTypes}
      />

      <BrokenBricksModal
        isOpen={isBrokenOpen}
        onClose={() => setIsBrokenOpen(false)}
        production={brokenTarget}
        onRegistered={refreshAll}
      />
    </div>
  );
}
