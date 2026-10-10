'use client';

/**
 * Page « Rapports de la briqueterie » (README §11.1, §20 point 9).
 *
 * Ordre de lecture imposé, calqué sur `/rapports` : `PageHeader` → résumé
 * décisionnel → cartes de synthèse → `DataToolbar` (période) → graphiques →
 * sections → document exportable.
 *
 * Deux points structurants :
 *
 * 1. **Aucun import de valeur depuis un module serveur.** `lib/brick-analytics.ts`
 *    interroge la base : il n'est jamais importé ici (invariant 6 — sans quoi
 *    Drizzle, `@libsql/client` et `fs` entreraient dans le bundle navigateur).
 *    Le type `BrickReports` est redéclaré dans
 *    `components/briqueterie/rapport-export.tsx`, la donnée vient de
 *    `GET /api/filiales/[branchId]/rapports` et rien d'autre.
 *
 * 2. **Le coût de production vient des dépenses rattachées aux lots et de la
 *    main-d'œuvre des affectations**, le chiffre d'affaires des ventes du canal
 *    `brick` : aucun total n'est stocké, tout est recalculé à la lecture côté
 *    serveur. La page ne fait donc aucun calcul de marge elle-même — elle
 *    affiche `report.profitability`, dont les 5 indicateurs viennent d'une source
 *    unique (`brickProfitabilityIndicators`).
 *
 * La marge est affichée ici parce que c'est un écran **interne** ; le message de
 * partage WhatsApp, lui, n'en contient aucune trace (invariant 14 pris au sens
 * large : rien de sensible dans un texte qui sort de l'application).
 */

import { branchApiUrl, useBranch } from '@/components/filiales/branch-context';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { DatePicker } from '@/components/date-picker';
import { Tooltip } from '@/components/tooltip';
import { ExportDropdown, shareOnWhatsApp } from '@/components/export-dropdown';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  MoneyText,
  PageSection,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { useSettings } from '@/app/parametres/page';
import { RevenueTrendChart } from '@/components/dashboard/dashboard-charts';
import { BrickTabs, useBrickScope } from '@/components/briqueterie/brick-tabs';
import { brickShapeLabel } from '@/components/briqueterie/briqueterie-modals';
import {
  BRICK_RAPPORT_DOCUMENT_ID,
  BrickRapportExportDocument,
  brickProfitabilityIndicators,
  buildBrickDecisionSummary,
  buildBrickRapportExportHtml,
  downloadBrickRapportCsv,
  type BrickRapportExportCompany,
  type BrickReports,
} from '@/components/briqueterie/rapport-export';
import {
  exportCompanyFromSettings,
  exportDocumentAsImage,
  exportDocumentAsPDF,
} from '@/lib/export-document';
import { useViewStateRehydration, writeViewState } from '@/lib/view-state';
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatQuantity,
  startOfMonth,
  startOfWeek,
  today,
} from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';

/** Clé d'état de vue : distincte de celle de `/rapports`. */
const VIEW_NAME = 'briqueterie-rapports';

/** Document capturé par les exports PDF / image / WhatsApp. */
const DOCUMENT_ID = BRICK_RAPPORT_DOCUMENT_ID;

/**
 * Nombre de jours tracés sur les graphiques. Une année complète donnerait 365
 * barres de 2 px : illisibles. Les tableaux, eux, gardent **toutes** les lignes.
 */
const CHART_POINTS = 45;

type PeriodKey = 'day' | 'week' | 'month' | 'year' | 'custom';

const PERIOD_SHORTCUTS: { key: Exclude<PeriodKey, 'custom'>; label: string }[] = [
  { key: 'day', label: "Aujourd'hui" },
  { key: 'week', label: 'Cette semaine' },
  { key: 'month', label: 'Ce mois' },
  { key: 'year', label: 'Cette année' },
];

const PERIOD_LABELS: Record<PeriodKey, string> = {
  day: "Aujourd'hui",
  week: 'Cette semaine',
  month: 'Ce mois',
  year: 'Cette année',
  custom: 'Période personnalisée',
};

/** Bornes d'un raccourci de période — bornes inclusives, jusqu'à aujourd'hui. */
function periodRange(
  key: Exclude<PeriodKey, 'custom'>,
  reference = today(),
): { from: string; to: string } {
  switch (key) {
    case 'day':
      return { from: reference, to: reference };
    case 'week':
      return { from: startOfWeek(reference), to: reference };
    case 'month':
      return { from: startOfMonth(reference), to: reference };
    case 'year':
      return { from: `${reference.slice(0, 4)}-01-01`, to: reference };
  }
}

/** Message d'erreur renvoyé par l'API, ou repli lisible en français. */
async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    /* corps illisible : on garde le repli */
  }
  return fallback;
}

/** Quantité en texte tabulaire — les colonnes doivent s'aligner. */
function quantity(value: number, unit?: string | null) {
  return <span className="tabular">{formatQuantity(value, unit)}</span>;
}

/* ==================================================================
 * Graphique d'évolution — barres du thème, sans dépendance
 * ================================================================== */

const BAR_TONES = {
  primary: 'bg-primary',
  warning: 'bg-warning',
  success: 'bg-success',
} as const;

type ChartPanel = {
  label: string;
  values: number[];
  tone: keyof typeof BAR_TONES;
  format: (value: number) => string;
};

/**
 * Graphique en barres tracé en `div` (aucune dépendance, invariant §4.5).
 *
 * Pourquoi ne pas réutiliser `RevenueTrendChart` : ses infobulles et son axe
 * écrivent « GNF » en dur (`dashboard-charts.tsx`). Or la production se lit en
 * **briques** et son coût en **GNF** : un même axe afficherait « 5 200 GNF » pour
 * une quantité de briques, c'est-à-dire un chiffre faux. Chaque série a donc ici
 * son propre panneau, sa propre échelle et son propre format.
 *
 * Les couleurs sont des jetons du thème (`bg-primary`, `bg-warning`) : jamais une
 * teinte figée, et jamais la couleur seule — chaque panneau porte son libellé et
 * le détail est dans l'infobulle native de chaque barre.
 */
function EvolutionBarsChart({
  labels,
  panels,
  emptyTitle,
  emptyDescription,
}: {
  labels: string[];
  panels: ChartPanel[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (labels.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="space-y-4">
      {panels.map((panel) => {
        const max = Math.max(0, ...panel.values);

        return (
          <div key={panel.label}>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-base-content/70">{panel.label}</span>
              <span className="tabular text-base-content/50">
                maximum {panel.format(max)}
              </span>
            </div>
            <div
              className="flex h-28 items-end gap-[2px]"
              role="img"
              aria-label={`${panel.label} sur la période : maximum ${panel.format(max)}, ${formatNumber(
                labels.length,
              )} point(s).`}
            >
              {panel.values.map((value, index) => (
                <div
                  key={index}
                  className="flex h-full min-w-0 flex-1 items-end"
                  title={`${labels[index]} — ${panel.format(value)}`}
                >
                  <div
                    className={`w-full rounded-t ${BAR_TONES[panel.tone]}`}
                    style={{ height: max > 0 ? `${Math.max(2, (value / max) * 100)}%` : '0%' }}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Repères de lecture : sans eux, une barre ne veut rien dire. */}
      <div className="flex justify-between gap-2 text-[11px] text-base-content/50">
        <span>{labels[0]}</span>
        {labels.length > 2 ? <span>{labels[Math.floor(labels.length / 2)]}</span> : null}
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}

/* ==================================================================
 * Colonnes des tableaux
 * ================================================================== */

type ProductionDayRow = BrickReports['productionByDay'][number];
type ProductionExpenseRow = BrickReports['expensesByProduction'][number];
type SalesPeriodRow = BrickReports['salesByPeriod'][number];
type LossRow = BrickReports['losses'][number];

/** « Lun 05/01/2026 » — la date propre de la ligne reste la première colonne. */
function dateColumn<T extends { date: string }>(): Column<T> {
  return {
    key: 'date',
    label: 'Date',
    primary: true,
    render: (row) => (
      <span className="whitespace-nowrap text-sm">{formatDateShort(row.date)}</span>
    ),
  };
}

function productionByDayColumns(currency: string): Column<ProductionDayRow>[] {
  return [
    dateColumn<ProductionDayRow>(),
    {
      key: 'lots',
      label: 'Lots',
      render: (row) => quantity(row.lots, row.lots === 1 ? 'lot' : 'lots'),
    },
    {
      key: 'produced',
      label: 'Produites',
      render: (row) => quantity(row.produced, 'pièces'),
    },
    {
      key: 'broken',
      label: 'Cassées',
      hideOnMobile: true,
      render: (row) => quantity(row.broken, 'pièces'),
    },
    {
      key: 'cost',
      label: 'Coût',
      render: (row) => <MoneyText value={row.cost} currency={currency} />,
    },
  ];
}

export default function BrickRapportsPage() {
  const B = useBranch();
  const { scope, setScope, storeParam, withStore } = useBrickScope();
  const { settings } = useSettings();
  const currency = settings.currency || 'GNF';

  const reference = today();

  const [from, setFrom] = useState(() => startOfMonth(reference));
  const [to, setTo] = useState(reference);
  const [periodKey, setPeriodKey] = useState<PeriodKey>('month');

  const [report, setReport] = useState<BrickReports | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  /* --------------------------- Restauration d'état ------------------------- */

  const rehydrated = useViewStateRehydration<{ from: string; to: string; periodKey: PeriodKey }>(
    VIEW_NAME,
    (saved) => {
      if (typeof saved.from === 'string') setFrom(saved.from);
      if (typeof saved.to === 'string') setTo(saved.to);
      if (
        saved.periodKey === 'day' ||
        saved.periodKey === 'week' ||
        saved.periodKey === 'month' ||
        saved.periodKey === 'year' ||
        saved.periodKey === 'custom'
      ) {
        setPeriodKey(saved.periodKey);
      }
    },
  );

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { from, to, periodKey });
  }, [rehydrated, from, to, periodKey]);

  /* -------------------------------- Rapport -------------------------------- */

  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    void (async () => {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ from, to });
        const response = await fetch(withStore(branchApiUrl(`/rapports?${params.toString()}`)), {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Le rapport de la filiale n'a pas pu être chargé."),
          );
        }

        const payload = (await response.json()) as BrickReports;
        if (!active) return;

        setReport(payload);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setReport(null);
        setError(
          caught instanceof Error
            ? caught.message
            : "Le rapport de la filiale n'a pas pu être chargé.",
        );
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, from, to, refreshToken, storeParam, withStore]);

  /* --------------------------------- Dérivés ------------------------------- */

  /**
   * Identité d'entreprise de l'export : `exportCompanyFromSettings` fournit le
   * logo de repli et la couleur principale **en hexadécimal**, ce qui est
   * précisément ce qui rend la capture possible (README §11.1).
   */
  const exportCompany: BrickRapportExportCompany = useMemo(
    () => exportCompanyFromSettings(settings),
    [settings],
  );

  const fileBase = `rapport-filiale-${B.branch.id}-${from}_${to}`;

  const decisionSummary = useMemo(
    () => (report ? buildBrickDecisionSummary(report, currency) : []),
    [report, currency],
  );

  /**
   * Document HTML autonome, en couleurs hexadécimales, écrit dans l'iframe
   * invisible par `lib/export-document.ts` : PDF, image et WhatsApp partagent
   * donc exactement le même document.
   */
  const exportHtml = useMemo(
    () => (report ? buildBrickRapportExportHtml(report, exportCompany) : null),
    [report, exportCompany],
  );

  const indicators = useMemo(
    () => (report ? brickProfitabilityIndicators(report) : []),
    [report],
  );

  const productionChart = useMemo(() => {
    const rows = (report?.productionByDay ?? []).slice(-CHART_POINTS);
    return {
      labels: rows.map((row) => formatDateShort(row.date)),
      produced: rows.map((row) => row.produced),
      cost: rows.map((row) => row.cost),
    };
  }, [report]);

  const salesChart = useMemo(() => {
    const rows = (report?.salesByPeriod ?? []).slice(-CHART_POINTS);
    return {
      labels: rows.map((row) => formatDateShort(row.date)),
      revenue: rows.map((row) => row.revenue),
    };
  }, [report]);

  const totals = useMemo(() => {
    if (!report) {
      return { salesCount: 0, generalExpenseCount: 0 };
    }

    return {
      salesCount: report.salesByPeriod.reduce((sum, row) => sum + row.count, 0),
      generalExpenseCount: report.generalExpensesByCategory.reduce(
        (sum, row) => sum + row.count,
        0,
      ),
    };
  }, [report]);

  /* -------------------------------- Actions -------------------------------- */

  const handleExportPDF = async () => {
    if (!exportHtml) return;
    setIsExporting(true);
    try {
      await exportDocumentAsPDF(exportHtml, fileBase);
      toast.success('PDF du rapport de la filiale généré.');
    } catch (caught: any) {
      // La cause réelle remonte : un message générique masquerait le défaut.
      toast.error(caught?.message ?? "Le PDF n'a pas pu être généré.", { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportImage = async () => {
    if (!exportHtml) return;
    setIsExporting(true);
    try {
      await exportDocumentAsImage(exportHtml, fileBase);
      toast.success('Image du rapport de la filiale générée.');
    } catch (caught: any) {
      toast.error(caught?.message ?? "L'image n'a pas pu être générée.", { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };

  /**
   * Message de partage : production, chiffre d'affaires et encaissements
   * **uniquement**. Aucun taux de marge, aucune marge : un texte partagé sort de
   * l'application et ne doit rien porter de sensible.
   */
  const buildShareText = (): string => {
    if (!report) return '';

    const collected = report.salesByPeriod.reduce((sum, row) => sum + row.collected, 0);
    const outstanding = report.salesByPeriod.reduce((sum, row) => sum + row.outstanding, 0);

    return [
      `*${settings.companyName}*`,
      `Rapport de la filiale — du ${formatDateShort(report.from)} au ${formatDateShort(report.to)}`,
      `• Production : ${formatQuantity(report.profitability.producedQuantity, 'pièces')}`,
      `• Chiffre d'affaires : ${formatCurrency(report.profitability.revenue, currency)}`,
      `• Encaissé : ${formatCurrency(collected, currency)}`,
      `• Reste à encaisser : ${formatCurrency(outstanding, currency)}`,
    ].join('\n');
  };

  const handleShareWhatsApp = async () => {
    if (!report || !exportHtml) return;

    setIsExporting(true);
    try {
      // Le document est partagé en image : `element.outerHTML` enverrait des
      // classes Tailwind sans leur feuille de styles (README §11.1).
      await shareOnWhatsApp(
        exportHtml,
        buildShareText(),
        `${fileBase}.png`,
        'Rapport de la filiale',
      );
    } catch (caught: any) {
      toast.error(caught?.message ?? "Le partage WhatsApp n'a pas pu être effectué.", {
        autoClose: 10000,
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportCsv = () => {
    if (!report) return;
    try {
      downloadBrickRapportCsv(report, exportCompany, fileBase);
      toast.success('Export tableur généré (séparateur « ; », virgule décimale, Excel français).');
    } catch {
      toast.error("L'export tableur n'a pas pu être généré.");
    }
  };

  const applyPeriod = (key: Exclude<PeriodKey, 'custom'>) => {
    const range = periodRange(key);
    setFrom(range.from);
    setTo(range.to);
    setPeriodKey(key);
  };

  /* ---------------------------------- Rendu -------------------------------- */

  const summaryCards = report ? (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <StatCardDelta
        label="Production"
        tooltip="Pièces produites par les lots commencés sur la période (annulés exclus), et nombre de lots."
        tone="primary"
        value={quantity(report.profitability.producedQuantity, 'pièces')}
        hint={`${formatNumber(
          report.productionByDay.reduce((sum, row) => sum + row.lots, 0),
        )} lot(s) sur la période`}
      />
      <StatCardDelta
        label="Coût de production"
        tooltip="Coût des lots de la période : journées de l’équipe et dépenses rattachées validées. Le coût unitaire divise ce montant par les pièces bonnes."
        tone="warning"
        value={<MoneyText value={report.profitability.productionCost} currency={currency} />}
        hint={`Coût unitaire : ${formatCurrency(report.profitability.unitCost, currency)}`}
      />
      <StatCardDelta
        label="Chiffre d'affaires"
        tooltip="Total des ventes de la filiale validées sur la période."
        tone="info"
        value={<MoneyText value={report.profitability.revenue} currency={currency} />}
        hint={`${formatNumber(totals.salesCount)} vente(s) du canal pièce`}
      />
      <StatCardDelta
        label="Marge brute"
        tooltip="Chiffre d’affaires moins le coût de production des lots de la période."
        tone={report.profitability.grossMargin >= 0 ? 'success' : 'error'}
        value={<MoneyText value={report.profitability.grossMargin} currency={currency} />}
        hint={`Taux : ${formatPercent(report.profitability.marginRate)}`}
      />
      <StatCardDelta
        label="Dépenses générales"
        tooltip="Dépenses approuvées de la période qui ne sont rattachées à aucun lot."
        tone="neutral"
        value={<MoneyText value={report.profitability.generalExpenses} currency={currency} />}
        hint={`${formatNumber(totals.generalExpenseCount)} écriture(s)`}
      />
      <StatCardDelta
        label="Résultat estimé"
        tooltip="Marge brute moins les dépenses générales : une estimation, car les pièces vendues ne sont pas toutes celles fabriquées sur la période."
        tone={report.profitability.estimatedResult >= 0 ? 'success' : 'error'}
        value={
          <MoneyText
            value={report.profitability.estimatedResult}
            currency={currency}
            colored
          />
        }
        hint="Marge brute − dépenses générales"
      />
    </div>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow={B.branch.name}
        title="Rapports de la filiale"
        description="Production, coûts, chiffre d'affaires, marge et résultat estimé sur une période — recalculés à la lecture depuis les lots, les dépenses, les ventes du canal pièce et les encaissements."
        actions={
          <ExportDropdown
            onExportPDF={handleExportPDF}
            onExportImage={handleExportImage}
            onShareWhatsApp={handleShareWhatsApp}
            label="Exporter"
          />
        }
      />

      <BrickTabs scope={scope} onScopeChange={setScope} />

      <DataToolbar
        filters={
          <div className="flex flex-wrap gap-2">
            {PERIOD_SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.key}
                type="button"
                onClick={() => applyPeriod(shortcut.key)}
                aria-pressed={periodKey === shortcut.key}
                className={`btn btn-sm min-h-11 sm:min-h-0 ${
                  periodKey === shortcut.key ? 'btn-primary' : 'btn-ghost border border-base-300'
                }`}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
        }
        secondaryFilters={
          <div className="grid w-full grid-cols-1 gap-3 sm:w-80 sm:grid-cols-2">
            <div>
              <span className="mb-1 block text-xs text-base-content/60">Du</span>
              <DatePicker
                value={from}
                onChange={(value) => {
                  if (!value) return;
                  setFrom(value);
                  setPeriodKey('custom');
                }}
                placeholder="jj mois aaaa"
              />
            </div>
            <div>
              <span className="mb-1 block text-xs text-base-content/60">Au</span>
              <DatePicker
                value={to}
                onChange={(value) => {
                  if (!value) return;
                  setTo(value);
                  setPeriodKey('custom');
                }}
                placeholder="jj mois aaaa"
              />
            </div>
          </div>
        }
        secondaryCount={2}
        actions={
          <>
            <Tooltip label="Exporter les tableaux du rapport en tableur (Excel, séparateur « ; »)">
              <ToolbarButton onClick={handleExportCsv} disabled={!report}>
                Tableur (CSV)
              </ToolbarButton>
            </Tooltip>
            <Tooltip label="Recalculer le rapport sur la période affichée">
              <ToolbarButton onClick={refresh}>Actualiser</ToolbarButton>
            </Tooltip>
          </>
        }
      />

      <p className="text-sm text-base-content/60">
        Période affichée : <span className="font-medium">{PERIOD_LABELS[periodKey]}</span> —{' '}
        <span className="tabular">
          {formatDateShort(from)} → {formatDateShort(to)}
        </span>{' '}
        (bornes incluses).
      </p>

      {/* ── 5 états : chargement, erreur, vide, nominal, feedback ─────────── */}
      {isLoading ? (
        <div className="space-y-6">
          <SkeletonCards count={6} />
          <SkeletonTable rows={6} cols={5} />
        </div>
      ) : error ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Impossible de charger le rapport de la filiale"
            description={error}
            onRetry={refresh}
          />
        </div>
      ) : !report ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <EmptyState
            title="Aucun rapport à afficher"
            description="Choisissez une période puis relancez le calcul : les chiffres sont recalculés à la lecture, jamais stockés."
            action={
              <button type="button" className="btn btn-primary min-h-11" onClick={refresh}>
                Réessayer
              </button>
            }
          />
        </div>
      ) : (
        <>
          {/* ── Résumé décisionnel : généré, jamais figé ───────────────────── */}
          <PageSection
            title="À retenir"
            subtitle="Résumé construit sur les chiffres de la période affichée."
          >
            <Card>
              {decisionSummary.length > 0 ? (
                <ul className="space-y-2 text-sm leading-6">
                  {decisionSummary.map((sentence, index) => (
                    <li key={index} className="flex gap-2">
                      <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                      <span>{sentence}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-base-content/60">
                  Aucun chiffre exploitable sur la période : lancez une production ou une vente de
                  pièces pour alimenter ce résumé.
                </p>
              )}
            </Card>
          </PageSection>

          {summaryCards}

          {/* ── Rentabilité : les 5 indicateurs et leur formule ────────────── */}
          <PageSection
            title="Rentabilité de la période"
            subtitle="Chaque montant est accompagné de sa formule : le chiffre doit rester vérifiable."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    {
                      key: 'label',
                      label: 'Indicateur',
                      primary: true,
                      render: (row) => <span className="text-sm font-medium">{row.label}</span>,
                    },
                    {
                      key: 'amount',
                      label: 'Montant',
                      render: (row) => (
                        <MoneyText
                          value={row.amount}
                          currency={currency}
                          bold
                          colored={row.key === 'estimatedResult' || row.key === 'grossMargin'}
                        />
                      ),
                    },
                    {
                      key: 'formula',
                      label: 'Formule',
                      render: (row) => (
                        <span className="text-xs text-base-content/60">{row.formula}</span>
                      ),
                    },
                  ]}
                  data={indicators}
                  getRowKey={(row) => row.key}
                  tableClassName="table-sm"
                  emptyMessage="Aucun indicateur calculable sur la période."
                />
              </div>
            </Card>
          </PageSection>

          {/* ── Graphiques d'évolution ─────────────────────────────────────── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="mb-1 text-sm font-semibold">Production de la période</h3>
              <p className="mb-3 text-xs text-base-content/60">
                Quantité produite (pièces) et coût de production (GNF), sur les{' '}
                {formatNumber(Math.min(CHART_POINTS, productionChart.labels.length))} dernier(s)
                jour(s) renseigné(s).
              </p>
              <EvolutionBarsChart
                labels={productionChart.labels}
                panels={[
                  {
                    label: 'Quantité produite',
                    values: productionChart.produced,
                    tone: 'primary',
                    format: (value) => formatQuantity(value, 'pièces'),
                  },
                  {
                    label: 'Coût de production',
                    values: productionChart.cost,
                    tone: 'warning',
                    format: (value) => formatCurrency(value, currency),
                  },
                ]}
                emptyTitle="Aucune production sur la période"
                emptyDescription="Le graphique apparaîtra dès le premier lot enregistré sur la période choisie."
              />
            </Card>

            <Card>
              <h3 className="mb-1 text-sm font-semibold">Ventes de la période</h3>
              <p className="mb-3 text-xs text-base-content/60">
                Chiffre d&apos;affaires des ventes du canal pièce, jour par jour.
              </p>
              {salesChart.labels.length > 0 ? (
                <RevenueTrendChart
                  labels={salesChart.labels}
                  series={[{ label: "Chiffre d'affaires", values: salesChart.revenue }]}
                />
              ) : (
                <EmptyState
                  title="Aucune vente sur la période"
                  description="Le graphique apparaîtra dès la première vente de la filiale facturée sur la période choisie."
                />
              )}
            </Card>
          </div>

          {/* ── Rentabilité par modèle ─────────────────────────────── */}
          <PageSection
            title="Rentabilité par modèle"
            subtitle="Coût des pièces vendues = coût unitaire du type × quantité vendue."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    {
                      key: 'brickTypeName',
                      label: 'Modèle',
                      primary: true,
                      render: (row) => <span className="text-sm font-medium">{row.brickTypeName}</span>,
                    },
                    {
                      key: 'quantitySold',
                      label: 'Quantité vendue',
                      render: (row) => quantity(row.quantitySold, 'pièces'),
                    },
                    {
                      key: 'revenue',
                      label: "Chiffre d'affaires",
                      render: (row) => <MoneyText value={row.revenue} currency={currency} />,
                    },
                    {
                      key: 'productionCost',
                      label: 'Coût des pièces vendues',
                      hideOnMobile: true,
                      render: (row) => <MoneyText value={row.productionCost} currency={currency} />,
                    },
                    {
                      key: 'margin',
                      label: 'Marge',
                      render: (row) => (
                        <MoneyText value={row.margin} currency={currency} colored />
                      ),
                    },
                    {
                      key: 'marginRate',
                      label: 'Taux',
                      render: (row) => (
                        <span className="tabular">{formatPercent(row.marginRate)}</span>
                      ),
                    },
                  ]}
                  data={report.profitabilityByProduct}
                  getRowKey={(row) => row.brickTypeId}
                  emptyMessage="Aucune vente de la filiale sur la période."
                />
              </div>
            </Card>
          </PageSection>

          {/* ── Production ─────────────────────────────────────────────────── */}
          <PageSection
            title="Production par jour"
            subtitle="Lots fabriqués, pièces produites, cassées et coût du jour."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={productionByDayColumns(currency)}
                  data={report.productionByDay}
                  getRowKey={(row) => row.date}
                  emptyMessage="Aucune production enregistrée sur la période."
                />
              </div>
            </Card>
          </PageSection>

          <PageSection
            title="Production par modèle"
            subtitle="Coût unitaire calculé sur les pièces nettes (produites − cassées)."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    {
                      key: 'brickTypeName',
                      label: 'Modèle',
                      primary: true,
                      render: (row) => <span className="text-sm font-medium">{row.brickTypeName}</span>,
                    },
                    {
                      key: 'lots',
                      label: 'Lots',
                      render: (row) => quantity(row.lots, row.lots === 1 ? 'lot' : 'lots'),
                    },
                    {
                      key: 'produced',
                      label: 'Produites',
                      render: (row) => quantity(row.produced, 'pièces'),
                    },
                    {
                      key: 'broken',
                      label: 'Cassées',
                      hideOnMobile: true,
                      render: (row) => quantity(row.broken, 'pièces'),
                    },
                    {
                      key: 'cost',
                      label: 'Coût',
                      render: (row) => <MoneyText value={row.cost} currency={currency} />,
                    },
                    {
                      key: 'unitCost',
                      label: 'Coût unitaire',
                      render: (row) => <MoneyText value={row.unitCost} currency={currency} />,
                    },
                  ]}
                  data={report.productionByType}
                  getRowKey={(row) => row.brickTypeId}
                  emptyMessage="Aucun modèle produit sur la période."
                />
              </div>
            </Card>
          </PageSection>

          {/* ── Dépenses ───────────────────────────────────────────────────── */}
          <PageSection
            title="Dépenses rattachées aux productions"
            subtitle="Ciment, sable, carburant, main-d'œuvre… : les dépenses de production sont rattachées à un lot."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    dateColumn<ProductionExpenseRow>(),
                    {
                      key: 'batchNumber',
                      label: 'Lot',
                      render: (row) => <span className="text-sm">{row.batchNumber}</span>,
                    },
                    {
                      key: 'brickTypeName',
                      label: 'Modèle',
                      hideOnMobile: true,
                      render: (row) => <span className="text-sm">{row.brickTypeName}</span>,
                    },
                    {
                      key: 'category',
                      label: 'Catégorie',
                      render: (row) => <Badge tone="neutral">{row.category}</Badge>,
                    },
                    {
                      key: 'count',
                      label: 'Écritures',
                      hideOnMobile: true,
                      render: (row) => quantity(row.count),
                    },
                    {
                      key: 'amount',
                      label: 'Montant',
                      render: (row) => <MoneyText value={row.amount} currency={currency} />,
                    },
                  ]}
                  data={report.expensesByProduction}
                  getRowKey={(row) => `${row.batchNumber}-${row.date}-${row.category}`}
                  emptyMessage="Aucune dépense rattachée à une production sur la période."
                />
              </div>
            </Card>
          </PageSection>

          <PageSection
            title="Dépenses générales par catégorie"
            subtitle="Dépenses qui ne sont rattachées à aucun lot : elles se déduisent du résultat estimé."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    {
                      key: 'category',
                      label: 'Catégorie',
                      primary: true,
                      render: (row) => <span className="text-sm font-medium">{row.category}</span>,
                    },
                    {
                      key: 'count',
                      label: 'Écritures',
                      render: (row) => quantity(row.count),
                    },
                    {
                      key: 'total',
                      label: 'Montant',
                      render: (row) => <MoneyText value={row.total} currency={currency} />,
                    },
                  ]}
                  data={report.generalExpensesByCategory}
                  getRowKey={(row) => row.category}
                  emptyMessage="Aucune dépense générale sur la période."
                />
              </div>
            </Card>
          </PageSection>

          {/* ── Ventes ─────────────────────────────────────────────────────── */}
          <PageSection
            title="Ventes par période"
            subtitle="Ventes du canal pièce, encaissements et restes à encaisser, jour par jour."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    dateColumn<SalesPeriodRow>(),
                    {
                      key: 'count',
                      label: 'Ventes',
                      render: (row) => quantity(row.count, row.count === 1 ? 'vente' : 'ventes'),
                    },
                    {
                      key: 'revenue',
                      label: "Chiffre d'affaires",
                      render: (row) => <MoneyText value={row.revenue} currency={currency} />,
                    },
                    {
                      key: 'collected',
                      label: 'Encaissé',
                      hideOnMobile: true,
                      render: (row) => <MoneyText value={row.collected} currency={currency} />,
                    },
                    {
                      key: 'outstanding',
                      label: 'Reste dû',
                      // `remaining` : rouge dès qu'il reste quelque chose, neutre à
                      // zéro. `colored` peindrait ce montant positif en vert.
                      render: (row) => <MoneyText value={row.outstanding} currency={currency} remaining />,
                    },
                  ]}
                  data={report.salesByPeriod}
                  getRowKey={(row) => row.date}
                  emptyMessage="Aucune vente de la filiale sur la période."
                />
              </div>
            </Card>
          </PageSection>

          <PageSection title="Ventes par produit" subtitle="Quantité vendue et chiffre d'affaires par produit.">
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    {
                      key: 'productName',
                      label: 'Produit',
                      primary: true,
                      render: (row) => <span className="text-sm font-medium">{row.productName}</span>,
                    },
                    {
                      key: 'quantity',
                      label: 'Quantité',
                      render: (row) => quantity(row.quantity),
                    },
                    {
                      key: 'revenue',
                      label: "Chiffre d'affaires",
                      render: (row) => <MoneyText value={row.revenue} currency={currency} />,
                    },
                  ]}
                  data={report.salesByProduct}
                  getRowKey={(row) => row.productName}
                  emptyMessage="Aucun produit vendu sur la période."
                />
              </div>
            </Card>
          </PageSection>

          <PageSection title="Ventes par client" subtitle="Classement par chiffre d'affaires sur la période.">
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    {
                      key: 'customerName',
                      label: 'Client',
                      primary: true,
                      render: (row) => <span className="text-sm font-medium">{row.customerName}</span>,
                    },
                    {
                      key: 'count',
                      label: 'Ventes',
                      render: (row) => quantity(row.count, row.count === 1 ? 'vente' : 'ventes'),
                    },
                    {
                      key: 'revenue',
                      label: "Chiffre d'affaires",
                      render: (row) => <MoneyText value={row.revenue} currency={currency} />,
                    },
                    {
                      key: 'outstanding',
                      label: 'Reste dû',
                      render: (row) => (
                        <MoneyText value={row.outstanding} currency={currency} remaining />
                      ),
                    },
                  ]}
                  data={report.salesByCustomer}
                  getRowKey={(row) => row.customerName}
                  emptyMessage="Aucun client facturé sur la période."
                />
              </div>
            </Card>
          </PageSection>

          {/* ── Créances ───────────────────────────────────────────────────── */}
          <PageSection
            title="Créances clients"
            subtitle="Soldes dus par les clients de la filiale, toutes périodes confondues."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    {
                      key: 'customerName',
                      label: 'Client',
                      primary: true,
                      render: (row) => <span className="text-sm font-medium">{row.customerName}</span>,
                    },
                    {
                      key: 'phone',
                      label: 'Téléphone',
                      hideOnMobile: true,
                      render: (row) => <span className="text-sm">{row.phone ?? '—'}</span>,
                    },
                    {
                      key: 'invoiceCount',
                      label: 'Factures',
                      render: (row) =>
                        quantity(row.invoiceCount, row.invoiceCount === 1 ? 'facture' : 'factures'),
                    },
                    {
                      key: 'balance',
                      label: 'Solde dû',
                      // Règle des dus (invariant 9) : `remaining`, jamais `colored`.
                      render: (row) => <MoneyText value={row.balance} currency={currency} remaining />,
                    },
                    {
                      key: 'oldestDueDate',
                      label: 'Échéance la plus ancienne',
                      hideOnMobile: true,
                      render: (row) => (
                        <span className="whitespace-nowrap text-xs text-base-content/60">
                          {row.oldestDueDate ? formatDateShort(row.oldestDueDate) : 'Sans échéance'}
                        </span>
                      ),
                    },
                  ]}
                  data={report.receivables}
                  getRowKey={(row) => row.customerName}
                  emptyMessage="Aucune créance client pour la filiale."
                />
              </div>
            </Card>
          </PageSection>

          {/* ── Encaissements ──────────────────────────────────────────────── */}
          <PageSection
            title="Paiements encaissés par moyen"
            subtitle="Répartition des règlements reçus sur la période, par moyen de paiement."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    {
                      key: 'paymentMethod',
                      label: 'Moyen de paiement',
                      primary: true,
                      render: (row) => (
                        <span className="text-sm font-medium">{row.paymentMethod || '—'}</span>
                      ),
                    },
                    {
                      key: 'count',
                      label: 'Nombre',
                      render: (row) => quantity(row.count),
                    },
                    {
                      key: 'total',
                      label: 'Total',
                      render: (row) => <MoneyText value={row.total} currency={currency} />,
                    },
                  ]}
                  data={report.paymentsByMethod}
                  getRowKey={(row) => row.paymentMethod}
                  emptyMessage="Aucun paiement encaissé sur la période."
                />
              </div>
            </Card>
          </PageSection>

          {/* ── Stock ──────────────────────────────────────────────────────── */}
          <PageSection
            title="État des stocks"
            subtitle="Quantités en magasin, coût de revient moyen, valeurs et alertes de seuil."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    {
                      key: 'brickTypeName',
                      label: 'Modèle',
                      primary: true,
                      // Forme, dimensions et produit sous le type : 9 colonnes dépassaient 1366 px.
                      render: (row) => (
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{row.brickTypeName}</div>
                          <div className="truncate text-xs text-base-content/60">
                            {brickShapeLabel(row.shape)}
                            {row.dimensions ? ` · ${row.dimensions}` : ''} · {row.productName}
                          </div>
                        </div>
                      ),
                    },
                    {
                      key: 'stock',
                      label: 'Stock',
                      render: (row) => quantity(row.stock, row.unit),
                    },
                    {
                      key: 'stockMin',
                      label: 'Seuil',
                      hideOnMobile: true,
                      render: (row) => quantity(row.stockMin, row.unit),
                    },
                    {
                      key: 'averageUnitCost',
                      label: 'Coût unitaire moyen',
                      hideOnMobile: true,
                      render: (row) => <MoneyText value={row.averageUnitCost} currency={currency} />,
                    },
                    {
                      key: 'stockValue',
                      label: 'Valeur du stock',
                      render: (row) => <MoneyText value={row.stockValue} currency={currency} />,
                    },
                    {
                      key: 'saleValue',
                      label: 'Valeur au prix de vente',
                      hideOnMobile: true,
                      render: (row) => <MoneyText value={row.saleValue} currency={currency} />,
                    },
                    {
                      key: 'potentialMargin',
                      label: 'Marge potentielle',
                      hideOnMobile: true,
                      render: (row) => <MoneyText value={row.potentialMargin} currency={currency} />,
                    },
                    {
                      key: 'state',
                      label: 'État',
                      // Jamais la couleur seule : l'état est écrit en toutes lettres.
                      render: (row) => (
                        <Badge tone={row.isOut ? 'error' : row.isLow ? 'warning' : 'success'}>
                          {row.isOut ? 'Rupture' : row.isLow ? 'Sous le seuil' : 'Disponible'}
                        </Badge>
                      ),
                    },
                  ]}
                  data={report.stock}
                  getRowKey={(row) => row.productId}
                  emptyMessage="Aucun modèle suivi en stock."
                />
              </div>
            </Card>
          </PageSection>

          {/* ── Pertes et casses ───────────────────────────────────────────── */}
          <PageSection
            title="Pertes et casses"
            subtitle="Pertes déclarées sur les lots de la période, avec leur motif."
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ResponsiveTable
                  columns={[
                    dateColumn<LossRow>(),
                    {
                      key: 'batchNumber',
                      label: 'Lot',
                      render: (row) => <span className="text-sm">{row.batchNumber}</span>,
                    },
                    {
                      key: 'brickTypeName',
                      label: 'Modèle',
                      hideOnMobile: true,
                      render: (row) => <span className="text-sm">{row.brickTypeName}</span>,
                    },
                    {
                      key: 'brokenQuantity',
                      label: 'Quantité cassée',
                      render: (row) => quantity(row.brokenQuantity, 'pièces'),
                    },
                    {
                      key: 'reason',
                      label: 'Motif',
                      render: (row) => (
                        <span className="text-sm text-base-content/70">
                          {row.reason ?? 'Motif non renseigné'}
                        </span>
                      ),
                    },
                  ]}
                  data={report.losses}
                  getRowKey={(row) => `${row.batchNumber}-${row.date}`}
                  emptyMessage="Aucune casse déclarée sur la période."
                />
              </div>
            </Card>
          </PageSection>

          {/* ── Document du rapport : cible des exports PDF / image / WhatsApp ── */}
          <PageSection
            title="Document du rapport"
            subtitle="C'est ce document qui est exporté en PDF, en image ou partagé sur WhatsApp ; l'export tableur reprend les mêmes tableaux."
          >
            <BrickRapportExportDocument
              id={DOCUMENT_ID}
              report={report}
              company={exportCompany}
              className="print-area"
            />
          </PageSection>
        </>
      )}

      {/* Le bandeau signale l'état d'une génération en cours (jamais un blocage muet). */}
      {isExporting ? (
        <div className="no-print fixed bottom-4 right-4 z-50 rounded-xl border border-base-200 bg-base-100 px-3 py-2 text-sm shadow-lg">
          Génération du document…
        </div>
      ) : null}
    </div>
  );
}
