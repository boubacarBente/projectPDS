'use client';

/**
 * Page Rapports (README §16, §16.1, §16.2 ; CONVENTIONS §5).
 *
 * Ordre imposé : `PageHeader` → résumé décisionnel → cartes de synthèse →
 * `DataToolbar` (période + filtres secondaires) → graphiques → sections →
 * document exportable → historique des envois.
 *
 * Deux points structurants :
 *
 * 1. **Aucun import runtime d'un module serveur** (CONVENTIONS §11 bis).
 *    `lib/rapports.ts` et `lib/report-sender.ts` touchent la base : ils ne sont
 *    jamais importés ici. Les types viennent de `lib/rapports-types.ts`
 *    (`import type`, effacé à la compilation), la donnée vient de
 *    `/api/rapports` et l'envoi de `/api/rapports/envoyer`.
 *
 * 2. **Le mode manuel est le mode par défaut** (§16.3, Q9) : l'application
 *    prépare le message, enregistre la livraison et ouvre WhatsApp/SMS avec le
 *    texte pré-rempli. C'est le seul mode qui fonctionne hors ligne — et cette
 *    page dit toujours la vérité sur ce qui s'est passé (« message préparé » ≠
 *    « rapport envoyé »).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { DatePicker } from '@/components/date-picker';
import { Modal } from '@/components/modal';
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
import { useAuth } from '@/components/auth-provider';
import { useSettings } from '@/app/parametres/page';
import {
  MonthlyEvolutionChart,
  TopProductsChart,
} from '@/components/dashboard/dashboard-charts';
import {
  CashAndExpensesPanel,
  NetProfitPanel,
  PayablesTable,
  ProductMarginsTable,
  RapportComparisonPanel,
  RapportDecisionSummary,
  ReceivablesTable,
  SoldByProductTable,
  StockInsightsPanel,
  TopCustomersTable,
} from '@/components/rapports/rapport-sections';
import {
  RAPPORT_DOCUMENT_ID,
  RapportExportDocument,
  downloadRapportCsv,
  type RapportExportCompany,
} from '@/components/rapports/rapport-export';
import {
  exportCompanyFromSettings,
  exportDocumentAsImage,
  exportDocumentAsPDF,
  renderExportDocument,
} from '@/lib/export-document';
import { can } from '@/lib/permissions';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatCurrency, formatNumber, formatQuantity, startOfMonth, startOfWeek, today } from '@/lib/format';
import { formatDateShort, formatDateTime } from '@/lib/date-format';
import type {
  RapportData,
  RapportDeliveryRow,
  RapportSendResult,
} from '@/lib/rapports-types';

const VIEW_NAME = 'rapports';
const DOCUMENT_ID = RAPPORT_DOCUMENT_ID;
const HISTORY_LIMIT = 10;

type PeriodKey = 'day' | 'week' | 'month' | 'year' | 'custom';

const PERIOD_SHORTCUTS: { key: Exclude<PeriodKey, 'custom'>; label: string }[] = [
  { key: 'day', label: "Aujourd'hui" },
  { key: 'week', label: 'Cette semaine' },
  { key: 'month', label: 'Ce mois' },
  { key: 'year', label: 'Cette année' },
];

/** Bornes d'un raccourci de période — bornes inclusives, jusqu'à aujourd'hui. */
function periodRange(key: Exclude<PeriodKey, 'custom'>, reference = today()): { from: string; to: string } {
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

const PAYMENT_STATUS_OPTIONS = [
  { value: 'paid', label: 'Payée' },
  { value: 'partial', label: 'Partiellement payée' },
  { value: 'unpaid', label: 'Impayée' },
];

const PERIOD_LABELS: Record<string, string> = {
  day: 'Jour',
  week: 'Semaine',
  month: 'Mois',
};

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
};

type ViewState = {
  from: string;
  to: string;
  periodKey: PeriodKey;
  productId: string;
  customerId: string;
  supplierId: string;
  paymentStatus: string;
  historyPage: number;
};

/** Message d'erreur renvoyé par l'API, ou repli lisible en français. */
async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  } catch {
    /* corps illisible : on garde le repli */
  }
  return fallback;
}

/** Ouvre l'URL de partage : `sms:` remplace la page, `wa.me` s'ouvre à côté. */
function openShareUrl(url: string): boolean {
  if (url.startsWith('sms:')) {
    window.location.href = url;
    return true;
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  return opened !== null;
}

export default function RapportsPage() {
  const { settings } = useSettings();
  const { user, isLoading: isAuthLoading } = useAuth();

  const currency = settings.currency || 'GNF';

  /**
   * `reports.viewAll` (admin, gérant) autorise toute période. Un vendeur n'a que
   * `reports.view` : sa période est verrouillée sur aujourd'hui, ici comme côté
   * serveur (`GET /api/rapports` refuse, `POST /api/rapports/envoyer` force).
   */
  const canViewAll = !isAuthLoading && can(user, 'reports.viewAll');
  const isPeriodLocked = !isAuthLoading && !canViewAll;

  const reference = today();

  const [from, setFrom] = useState(reference);
  const [to, setTo] = useState(reference);
  const [periodKey, setPeriodKey] = useState<PeriodKey>('day');
  const [productId, setProductId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');

  const [report, setReport] = useState<RapportData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const [productOptions, setProductOptions] = useState<{ value: string; label: string }[]>([]);
  const [customerOptions, setCustomerOptions] = useState<{ value: string; label: string }[]>([]);
  const [supplierOptions, setSupplierOptions] = useState<{ value: string; label: string }[]>([]);

  /* Historique des envois */
  const [historyPage, setHistoryPage] = useState(1);
  const [history, setHistory] = useState<RapportDeliveryRow[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  /* Envoi — un état booléen par modale (§8.3 règle 1). */
  const [isSendOpen, setIsSendOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [channel, setChannel] = useState<'whatsapp' | 'sms'>('whatsapp');
  const [recipientsText, setRecipientsText] = useState('');

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  /* --------------------------- Restauration d'état ------------------------- */

  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
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
    if (typeof saved.productId === 'string') setProductId(saved.productId);
    if (typeof saved.customerId === 'string') setCustomerId(saved.customerId);
    if (typeof saved.supplierId === 'string') setSupplierId(saved.supplierId);
    if (typeof saved.paymentStatus === 'string') setPaymentStatus(saved.paymentStatus);
    if (typeof saved.historyPage === 'number' && saved.historyPage > 0) setHistoryPage(saved.historyPage);
  });

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState<ViewState>(VIEW_NAME, {
      from,
      to,
      periodKey,
      productId,
      customerId,
      supplierId,
      paymentStatus,
      historyPage,
    });
  }, [rehydrated, from, to, periodKey, productId, customerId, supplierId, paymentStatus, historyPage]);

  /**
   * Verrou de période pour un rôle sans `reports.viewAll` : on ramène la vue sur
   * aujourd'hui plutôt que de laisser l'utilisateur buter sur un refus serveur.
   */
  useEffect(() => {
    if (isAuthLoading || canViewAll) return;
    if (from !== reference || to !== reference || periodKey !== 'day') {
      setFrom(reference);
      setTo(reference);
      setPeriodKey('day');
    }
  }, [isAuthLoading, canViewAll, from, to, periodKey, reference]);

  /* ------------------------------- Rapport -------------------------------- */

  useEffect(() => {
    if (!rehydrated || isAuthLoading) return;

    const controller = new AbortController();
    let active = true;

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ from, to });
        if (productId) params.set('productId', productId);
        if (customerId) params.set('customerId', customerId);
        if (supplierId) params.set('supplierId', supplierId);
        if (paymentStatus) params.set('paymentStatus', paymentStatus);

        const response = await fetch(`/api/rapports?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, "Le rapport n'a pas pu être chargé."));
        }

        const payload = (await response.json()) as { report?: RapportData };
        if (!active) return;

        setReport(payload.report ?? null);
        setIsLoading(false);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setReport(null);
        setError(caught instanceof Error ? caught.message : "Le rapport n'a pas pu être chargé.");
        setIsLoading(false);
      }
    }

    void load();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, isAuthLoading, from, to, productId, customerId, supplierId, paymentStatus, refreshToken]);

  /* --------------------------- Options de filtres -------------------------- */

  useEffect(() => {
    if (!rehydrated) return;

    let active = true;

    async function loadOptions() {
      const fetchList = async (url: string): Promise<any[]> => {
        try {
          const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
          if (!response.ok) return [];
          const payload = await response.json();
          return Array.isArray(payload?.data) ? payload.data : [];
        } catch {
          // Un filtre sans options reste utilisable : la page ne casse pas.
          return [];
        }
      };

      const [products, customers, suppliers] = await Promise.all([
        fetchList('/api/produits?limit=200'),
        fetchList('/api/clients?limit=200'),
        fetchList('/api/fournisseurs?limit=200'),
      ]);

      if (!active) return;

      setProductOptions(
        products
          .map((item: any) => ({ value: String(item.id), label: String(item.name ?? item.code ?? '') }))
          .filter((option) => option.label),
      );
      setCustomerOptions(
        customers
          .map((item: any) => ({ value: String(item.id), label: String(item.name ?? '') }))
          .filter((option) => option.label),
      );
      setSupplierOptions(
        suppliers
          .map((item: any) => ({ value: String(item.id), label: String(item.name ?? '') }))
          .filter((option) => option.label),
      );
    }

    void loadOptions();

    return () => {
      active = false;
    };
  }, [rehydrated]);

  /* -------------------------- Historique des envois ------------------------ */

  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    async function loadHistory() {
      setIsHistoryLoading(true);
      setHistoryError(null);

      try {
        const params = new URLSearchParams({
          page: String(historyPage),
          limit: String(HISTORY_LIMIT),
        });

        const response = await fetch(`/api/rapports/envois?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await readApiError(response, "L'historique des envois n'a pas pu être chargé."));
        }

        const payload = (await response.json()) as {
          data?: RapportDeliveryRow[];
          total?: number;
          totalPages?: number;
        };

        if (!active) return;

        setHistory(Array.isArray(payload.data) ? payload.data : []);
        setHistoryTotal(Number(payload.total ?? 0));

        // Une page restaurée devenue hors bornes est corrigée (annulations, filtres).
        const pages = Math.max(1, Number(payload.totalPages ?? 1));
        setHistoryTotalPages(pages);
        const corrected = clampPage(historyPage, pages);
        if (corrected !== null) setHistoryPage(corrected);

        setIsHistoryLoading(false);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setHistory([]);
        setHistoryTotal(0);
        setHistoryTotalPages(1);
        setHistoryError(
          caught instanceof Error ? caught.message : "L'historique des envois n'a pas pu être chargé.",
        );
        setIsHistoryLoading(false);
      }
    }

    void loadHistory();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, historyPage, refreshToken]);

  /* -------------------------------- Actions -------------------------------- */

  const exportCompany = useMemo<RapportExportCompany>(
    () => ({
      companyName: settings.companyName,
      companyBranch: settings.companyBranch,
      companyAddress: settings.companyAddress,
      companyPhone: settings.companyPhone,
      companyEmail: settings.companyEmail,
      companyTaxId: settings.companyTaxId,
      companyLogo: settings.companyLogo,
      currency,
    }),
    [settings, currency],
  );

  const fileBase = `rapport-${from}_${to}`;

  /**
   * Document HTML autonome (couleurs hexadécimales uniquement) utilisé par les
   * trois exports. Capturer la page affichée échouait : ses couleurs Tailwind
   * (`oklch`, `color-mix`) sont illisibles pour le moteur de capture. Voir
   * `lib/export-document.ts`.
   */
  const exportHtml = useMemo(() => {
    if (!report) return null;

    const money = (value: number) => formatCurrency(value, currency);
    const variation = (deltaPercent: number | null) =>
      deltaPercent === null ? '—' : `${deltaPercent > 0 ? '+' : ''}${formatNumber(deltaPercent, 1)} %`;

    return renderExportDocument({
      documentTitle: "Rapport d'activité",
      documentDate: `Période : ${formatDateShort(report.period.from)} → ${formatDateShort(report.period.to)}`,
      company: exportCompanyFromSettings(settings),
      meta: [
        ['Période', report.period.label],
        ['Ventes', formatNumber(report.summary.salesCount)],
        ['Panier moyen', money(report.summary.averageBasket)],
      ],
      blocks: [
        {
          kind: 'keyValue',
          title: 'Synthèse',
          rows: [
            ["Chiffre d'affaires TTC", money(report.summary.revenueTtc)],
            ["Chiffre d'affaires HT", money(report.summary.revenueHt)],
            ['Encaissé', money(report.summary.collected)],
            ['Restant dû sur la période', money(report.summary.outstanding)],
            ['Dépenses', money(report.summary.expenses)],
            ['Bénéfice net', money(report.summary.netProfit)],
            ['Solde de caisse', money(report.summary.cash.balance)],
          ],
        },
        {
          kind: 'table',
          title: 'Comparaison avec la période précédente',
          columns: [
            { label: 'Indicateur' },
            { label: 'Période', align: 'right' },
            { label: 'Précédente', align: 'right' },
            { label: 'Variation', align: 'right' },
          ],
          numeric: [1, 2, 3],
          rows: [
            [
              "Chiffre d'affaires",
              money(report.comparison.revenue.current),
              money(report.comparison.revenue.previous),
              variation(report.comparison.revenue.deltaPercent),
            ],
            [
              'Marge brute',
              money(report.comparison.margin.current),
              money(report.comparison.margin.previous),
              variation(report.comparison.margin.deltaPercent),
            ],
            [
              'Nombre de ventes',
              formatNumber(report.comparison.salesCount.current),
              formatNumber(report.comparison.salesCount.previous),
              variation(report.comparison.salesCount.deltaPercent),
            ],
          ],
        },
        ...(report.soldByProduct.length > 0
          ? [
              {
                kind: 'table' as const,
                title: 'Produits vendus',
                columns: [
                  { label: 'Code' },
                  { label: 'Produit' },
                  { label: 'Qté', align: 'right' as const },
                  { label: "Chiffre d'affaires", align: 'right' as const },
                  { label: 'Part', align: 'right' as const },
                ],
                numeric: [2, 3, 4],
                rows: report.soldByProduct
                  .slice(0, 25)
                  .map((product) => [
                    product.productCode,
                    product.productName,
                    formatQuantity(product.quantity, product.unit),
                    money(product.revenue),
                    `${formatNumber(product.sharePercent, 1)} %`,
                  ]),
              },
            ]
          : []),
        ...(report.productMargins.length > 0
          ? [
              {
                kind: 'table' as const,
                title: 'Rentabilité par produit',
                columns: [
                  { label: 'Produit' },
                  { label: 'CA', align: 'right' as const },
                  { label: 'Coût', align: 'right' as const },
                  { label: 'Marge', align: 'right' as const },
                  { label: 'Taux', align: 'right' as const },
                ],
                numeric: [1, 2, 3, 4],
                rows: report.productMargins
                  .slice(0, 20)
                  .map((margin) => [
                    margin.productName,
                    money(margin.revenue),
                    money(margin.cost),
                    money(margin.margin),
                    `${formatNumber(margin.marginPercent, 1)} %`,
                  ]),
              },
            ]
          : []),
        {
          kind: 'table',
          title: `Clients débiteurs (${formatNumber(report.receivables.debtorsCount)})`,
          columns: [
            { label: 'Client' },
            { label: 'Factures', align: 'right' },
            { label: 'Solde', align: 'right' },
            { label: 'Échéance la plus ancienne' },
          ],
          numeric: [1, 2],
          rows:
            report.receivables.items.length === 0
              ? []
              : report.receivables.items.map((item) => [
                  item.customerName,
                  formatNumber(item.invoiceCount),
                  money(item.balance),
                  item.oldestDueDate
                    ? `${formatDateShort(item.oldestDueDate)}${item.overdue ? ' — en retard' : ''}`
                    : '—',
                ]),
        },
        {
          kind: 'table',
          title: `Dettes fournisseurs (${formatNumber(report.payables.creditorsCount)})`,
          columns: [
            { label: 'Fournisseur' },
            { label: 'Factures', align: 'right' },
            { label: 'Solde', align: 'right' },
            { label: 'Échéance la plus ancienne' },
          ],
          numeric: [1, 2],
          rows:
            report.payables.items.length === 0
              ? []
              : report.payables.items.map((item) => [
                  item.supplierName,
                  formatNumber(item.invoiceCount),
                  money(item.balance),
                  item.oldestDueDate ? formatDateShort(item.oldestDueDate) : '—',
                ]),
        },
        {
          kind: 'keyValue',
          title: 'Stock',
          rows: [
            ['Valeur du stock (prix d’achat)', money(report.stockInsights.purchaseValue)],
            ['Valeur du stock (prix de vente)', money(report.stockInsights.saleValue)],
            ['Marge potentielle en stock', money(report.stockInsights.potentialMargin)],
            ['Produits sous le seuil', formatNumber(report.stockInsights.lowStockCount)],
            ['Produits en rupture', formatNumber(report.stockInsights.outOfStockCount)],
          ],
        },
      ],
      notes:
        report.decisionSummary.length > 0
          ? report.decisionSummary.map((line) => `• ${line}`).join('\n')
          : null,
      footer: `Rapport généré par le logiciel de gestion ${settings.companyName || 'Planète Déco Sarlu'}`,
    });
  }, [report, settings, currency]);

  const handleExportPDF = async () => {
    if (!exportHtml) return;
    setIsExporting(true);
    try {
      await exportDocumentAsPDF(exportHtml, fileBase);
      toast.success('PDF du rapport généré.');
    } catch (error: any) {
      toast.error(error?.message ?? "Le PDF n'a pas pu être généré.", { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportImage = async () => {
    if (!exportHtml) return;
    setIsExporting(true);
    try {
      await exportDocumentAsImage(exportHtml, fileBase);
      toast.success('Image du rapport générée.');
    } catch (error: any) {
      toast.error(error?.message ?? "L'image n'a pas pu être générée.", { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };

  /**
   * Message de partage court. Le gabarit d'envoi fait foi côté serveur
   * (`lib/report-sender.ts`) ; ici c'est un résumé de partage, jamais une
   * prétention d'envoi.
   */
  const buildShareText = (data: RapportData): string =>
    [
      `*${settings.companyName}*`,
      `Rapport ${data.period.label}`,
      `• Ventes : ${formatNumber(data.summary.salesCount)}`,
      `• Chiffre d'affaires : ${formatCurrency(data.summary.revenueTtc, currency)}`,
      `• Bénéfice net : ${formatCurrency(data.summary.netProfit, currency)}`,
      `• Caisse : ${formatCurrency(data.summary.cash.balance, currency)}`,
      `• Clients débiteurs : ${formatCurrency(data.receivables.total, currency)}`,
      `• Dettes fournisseurs : ${formatCurrency(data.payables.total, currency)}`,
    ].join('\n');

  const handleShareWhatsApp = async () => {
    if (!report || !exportHtml) return;

    setIsExporting(true);
    try {
      // Même document que le PDF et l'image : partager `element.outerHTML`
      // enverrait des classes Tailwind sans leur feuille de styles.
      await shareOnWhatsApp(
        exportHtml,
        buildShareText(report),
        `${fileBase}.png`,
        "Rapport d'activité",
      );
    } catch (error: any) {
      toast.error(error?.message ?? "Le partage WhatsApp n'a pas pu être effectué.", {
        autoClose: 10000,
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportCsv = () => {
    if (!report) return;
    try {
      downloadRapportCsv(report, exportCompany, fileBase);
      toast.success('Export CSV généré (séparateur « ; », compatible Excel).');
    } catch {
      toast.error("L'export CSV n'a pas pu être généré.");
    }
  };

  const openSendModal = () => {
    setChannel(settings.reportChannels?.includes('sms') ? 'sms' : 'whatsapp');
    setRecipientsText((settings.reportRecipients ?? []).join(', '));
    setIsSendOpen(true);
  };

  /**
   * Envoi réel. La période transmise reste dans le vocabulaire de
   * `report_deliveries` (`day` | `week` | `month`) : une période personnalisée
   * ou annuelle est enregistrée comme `day` avec ses bornes explicites, seules
   * les bornes faisant foi.
   */
  const handleSendReport = async () => {
    if (!report) return;

    setIsSending(true);
    try {
      const recipients = recipientsText
        .split(/[,;\n]/)
        .map((value) => value.trim())
        .filter(Boolean);

      const payloadPeriod: 'day' | 'week' | 'month' =
        periodKey === 'week' || periodKey === 'month' ? periodKey : 'day';

      const response = await fetch('/api/rapports/envoyer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ period: payloadPeriod, from, to, channel, recipients }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "L'envoi du rapport a échoué.");
      }

      const result = payload as RapportSendResult;

      if (result.requiresManualSend) {
        // Mode manuel : rien n'a été envoyé par l'application. On le dit.
        const opened = result.shareUrl ? openShareUrl(result.shareUrl) : false;
        if (opened) {
          toast.success(
            `Message préparé pour ${recipients.length > 0 ? recipients.join(', ') : 'le contact de votre choix'} : validez l’envoi dans ${CHANNEL_LABELS[channel]}.`,
            { autoClose: 8000 },
          );
        } else if (recipients.length === 0) {
          toast.warning(
            'Message préparé, mais aucun destinataire enregistré : renseignez les destinataires dans les paramètres ou saisissez un numéro.',
            { autoClose: 8000 },
          );
        } else {
          toast.warning(
            "Le message est prêt, mais le navigateur a bloqué l'ouverture de l'application de messagerie.",
            { autoClose: 8000 },
          );
        }
      } else if (result.delivery?.status === 'sent') {
        toast.success(
          `Rapport envoyé à ${recipients.join(', ') || 'la passerelle configurée'}.`,
        );
      } else {
        toast.error(
          `Envoi impossible : ${result.delivery?.error ?? result.error ?? 'passerelle injoignable'}. Le rapport reste consultable et exportable hors ligne.`,
          { autoClose: 10000 },
        );
      }

      setIsSendOpen(false);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "L'envoi du rapport a échoué.", {
        autoClose: 10000,
      });
    } finally {
      setIsSending(false);
    }
  };

  /* --------------------------------- Dérivés ------------------------------- */

  const hasFilters = Boolean(productId || customerId || supplierId || paymentStatus);

  const resetFilters = () => {
    setProductId('');
    setCustomerId('');
    setSupplierId('');
    setPaymentStatus('');
  };

  const applyPeriod = (key: Exclude<PeriodKey, 'custom'>) => {
    const range = periodRange(key);
    setFrom(range.from);
    setTo(range.to);
    setPeriodKey(key);
  };

  const activeFilterCount = [productId, customerId, supplierId, paymentStatus].filter(Boolean).length;

  const topProductsChartData = useMemo(
    () =>
      (report?.soldByProduct ?? []).slice(0, 8).map((item) => ({
        productName: item.productName,
        amount: item.revenue,
      })),
    [report],
  );

  const hasActivity = Boolean(
    report && (report.summary.salesCount > 0 || report.summary.revenueTtc > 0),
  );

  const manualMode =
    settings.reportFrequency === 'manual' || !String(settings.reportProviderConfig ?? '').trim();

  // Style d'impression : seul le document du rapport reste visible (§11).
  const historyColumns = useMemo<Column<RapportDeliveryRow>[]>(
    () => [
      {
        key: 'sentAt',
        label: 'Date',
        primary: true,
        render: (row) => (
          <span className="whitespace-nowrap text-sm">
            {row.sentAt ? formatDateTime(row.sentAt) : '—'}
          </span>
        ),
      },
      {
        key: 'period',
        label: 'Période',
        render: (row) => (
          <div className="space-y-1">
            <Badge tone="info">{PERIOD_LABELS[row.period] ?? row.period}</Badge>
            <div className="text-xs text-base-content/60">
              {formatDateShort(row.fromDate)} → {formatDateShort(row.toDate)}
            </div>
          </div>
        ),
      },
      {
        key: 'channel',
        label: 'Canal',
        render: (row) => <Badge tone="neutral">{CHANNEL_LABELS[row.channel] ?? row.channel}</Badge>,
      },
      {
        key: 'recipients',
        label: 'Destinataires',
        render: (row) => (
          <span className="text-sm text-base-content/70">
            {row.recipients.length > 0 ? row.recipients.join(', ') : '—'}
          </span>
        ),
      },
      {
        key: 'status',
        label: 'Statut',
        render: (row) => (
          <div className="space-y-1">
            {row.status === 'failed' ? (
              <Badge tone="error">Échec d&apos;envoi</Badge>
            ) : row.triggeredBy === 'manual' ? (
              <Badge tone="info">Message préparé (manuel)</Badge>
            ) : (
              <Badge tone="success">Envoyé (automatique)</Badge>
            )}
            {row.error && (
              <div className="max-w-xs text-xs text-error" title={row.error}>
                {row.error}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'triggeredBy',
        label: 'Déclencheur',
        render: (row) => (
          <Badge tone={row.triggeredBy === 'auto' ? 'primary' : 'neutral'}>
            {row.triggeredBy === 'auto' ? 'Automatique' : 'Manuel'}
          </Badge>
        ),
      },
      {
        key: 'userName',
        label: 'Utilisateur',
        hideOnMobile: true,
        render: (row) => (
          <span className="text-sm text-base-content/70">{row.userName ?? 'Système'}</span>
        ),
      },
    ],
    [],
  );

  /* ---------------------------------- Rendu -------------------------------- */

  const summaryCards = report ? (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <StatCardDelta
        label="Chiffre d'affaires"
        value={<MoneyText value={report.summary.revenueTtc} currency={currency} />}
        delta={report.comparison.revenue.deltaPercent}
        hint={`${formatNumber(report.summary.salesCount)} vente${
          report.summary.salesCount > 1 ? 's' : ''
        }`}
      />
      <StatCardDelta
        label="Bénéfice net"
        tone={report.summary.netProfit >= 0 ? 'success' : 'error'}
        value={<MoneyText value={report.summary.netProfit} currency={currency} colored />}
        hint="Après dépenses et main-d'œuvre"
      />
      <StatCardDelta
        label="Marge brute"
        tone="info"
        value={<MoneyText value={report.netProfit.grossProfit} currency={currency} />}
        delta={report.comparison.margin.deltaPercent}
        hint={`Taux : ${formatNumber(report.netProfit.grossMarginPercent, 1)} %`}
      />
      <StatCardDelta
        label="Encaissé"
        tone="success"
        value={<MoneyText value={report.summary.collected} currency={currency} />}
        hint="Règlements reçus sur la période"
      />
      <StatCardDelta
        label="Restant dû"
        tone="warning"
        value={<MoneyText value={report.summary.outstanding} currency={currency} />}
        hint="Documents émis sur la période"
      />
      <StatCardDelta
        label="Dépenses"
        tone="error"
        value={<MoneyText value={report.summary.expenses} currency={currency} />}
        hint={`${formatNumber(report.expenses.count)} écriture${
          report.expenses.count > 1 ? 's' : ''
        }`}
      />
    </div>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Pilotage"
        title="Rapports"
        description="Ventes, marges, créances, dettes, stock et trésorerie sur une période — avec comparaison à la période précédente, exports et envoi WhatsApp / SMS."
        actions={
          <>
            <ExportDropdown
              onExportPDF={handleExportPDF}
              onExportImage={handleExportImage}
              onShareWhatsApp={handleShareWhatsApp}
              label="Exporter"
            />
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              onClick={openSendModal}
              disabled={!report || isLoading}
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
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
              Envoyer le rapport
            </button>
          </>
        }
      />

      <DataToolbar
        filters={
          <>
            <div className="w-full sm:w-44">
              <FilterSelect
                value={paymentStatus}
                onChange={(value) => setPaymentStatus(value)}
                options={PAYMENT_STATUS_OPTIONS}
                placeholder="Tous les statuts"
              />
            </div>
          </>
        }
        secondaryFilters={
          <div className="w-full space-y-3">
            <div className="flex flex-wrap gap-2">
              {PERIOD_SHORTCUTS.map((shortcut) => {
                const isActive = periodKey === shortcut.key;

                return (
                  <button
                    key={shortcut.key}
                    type="button"
                    disabled={isPeriodLocked && shortcut.key !== 'day'}
                    title={
                      isPeriodLocked && shortcut.key !== 'day'
                        ? "Votre rôle donne accès au rapport du jour uniquement"
                        : undefined
                    }
                    onClick={() => applyPeriod(shortcut.key)}
                    className={`btn btn-sm min-h-11 sm:min-h-0 ${
                      isActive ? 'btn-primary' : 'btn-ghost border border-base-300'
                    }`}
                  >
                    {shortcut.label}
                  </button>
                );
              })}
            </div>

            {isPeriodLocked && (
              <p className="text-xs text-base-content/60">
                Votre rôle donne accès au <strong>rapport du jour</strong>. Les autres périodes
                demandent la permission « Voir tous les rapports ».
              </p>
            )}

            <div className="grid grid-cols-1 gap-3 sm:w-96 sm:grid-cols-2">
              <div>
                <span className="mb-1 block text-xs text-base-content/60">Du</span>
                <DatePicker
                  value={from}
                  onChange={(value) => {
                    if (!value) return;
                    setFrom(value);
                    setPeriodKey('custom');
                  }}
                  placeholder="jj/mm/aaaa"
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
                  placeholder="jj/mm/aaaa"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <span className="mb-1 block text-xs text-base-content/60">Produit</span>
                <FilterSelect
                  value={productId}
                  onChange={(value) => setProductId(value)}
                  options={productOptions}
                  placeholder="Tous les produits"
                />
              </div>
              <div>
                <span className="mb-1 block text-xs text-base-content/60">Client</span>
                <FilterSelect
                  value={customerId}
                  onChange={(value) => setCustomerId(value)}
                  options={customerOptions}
                  placeholder="Tous les clients"
                />
              </div>
              <div>
                <span className="mb-1 block text-xs text-base-content/60">Fournisseur</span>
                <FilterSelect
                  value={supplierId}
                  onChange={(value) => setSupplierId(value)}
                  options={supplierOptions}
                  placeholder="Tous les fournisseurs"
                />
              </div>
            </div>
          </div>
        }
        secondaryCount={activeFilterCount + 2}
        actions={
          <>
            {hasFilters && (
              <ToolbarButton onClick={resetFilters} title="Revenir à tous les produits et clients">
                Effacer les filtres ({activeFilterCount})
              </ToolbarButton>
            )}
            <ToolbarButton
              onClick={handleExportCsv}
              disabled={!report}
              title="Exporter le jeu de données affiché en CSV (Excel, séparateur « ; »)"
            >
              Export CSV
            </ToolbarButton>
            <ToolbarButton onClick={refresh} title="Recalculer le rapport">
              Actualiser
            </ToolbarButton>
          </>
        }
      />

      {/* ── 5 états : chargement, erreur, vide, nominal, feedback ─────────── */}
      {isLoading ? (
        <div className="space-y-6">
          <SkeletonCards count={6} />
          <SkeletonTable rows={6} cols={5} />
        </div>
      ) : error ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title="Impossible de charger le rapport"
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
          {!hasActivity && (
            <div className="alert border border-info/40 bg-info/10 text-sm">
              <span>
                Aucune vente facturée sur la période <strong>{report.period.label}</strong>. Les
                sections ci-dessous restent calculées : elles montrent les créances, les dettes et
                l&apos;état du stock au jour du rapport.
              </span>
            </div>
          )}

          <RapportDecisionSummary sentences={report.decisionSummary} label={report.period.label} />

          {summaryCards}

          <RapportComparisonPanel
            comparison={report.comparison}
            period={report.period}
            previousPeriod={report.previousPeriod}
            currency={currency}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Évolution sur 12 mois</h3>
              <MonthlyEvolutionChart data={report.monthlyData} />
            </Card>
            <Card>
              <h3 className="mb-3 text-sm font-semibold">
                Répartition du chiffre d&apos;affaires par produit
              </h3>
              {topProductsChartData.length > 0 ? (
                <TopProductsChart data={topProductsChartData} />
              ) : (
                <EmptyState
                  title="Aucun produit vendu"
                  description="Le graphique apparaîtra dès la première vente de la période."
                />
              )}
            </Card>
          </div>

          <PageSection
            title="Produits vendus"
            subtitle="Quantités et chiffre d'affaires par produit sur la période"
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <SoldByProductTable rows={report.soldByProduct} currency={currency} />
              </div>
            </Card>
          </PageSection>

          <PageSection
            title="Marges par produit"
            subtitle="Chiffre d'affaires, coût d'achat et marge cumulée"
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <ProductMarginsTable rows={report.productMargins} currency={currency} />
              </div>
            </Card>
          </PageSection>

          <PageSection
            title="Meilleurs clients"
            subtitle="Classement par chiffre d'affaires sur la période"
          >
            <Card padded={false} className="overflow-hidden">
              <div className="p-2">
                <TopCustomersTable rows={report.topCustomers} currency={currency} />
              </div>
            </Card>
          </PageSection>

          <div className="grid gap-4 xl:grid-cols-2">
            <ReceivablesTable data={report.receivables} currency={currency} />
            <PayablesTable data={report.payables} currency={currency} />
          </div>

          <StockInsightsPanel data={report.stockInsights} currency={currency} />

          {/*
            * Deux colonnes seulement à partir de `xl` (1280 px).
            *
            * En `lg` (1024 px), la colonne « Bénéfice net » ne faisait plus que
            * ~90 px utiles : le montant (« 1 660 000 GNF ») débordait du cadre
            * et faisait défiler toute la page horizontalement. Mesuré : +8 px
            * sur /rapports à 1024 px, corrigé ici.
            */}
          <div className="grid gap-4 xl:grid-cols-4">
            <div className="xl:col-span-3">
              <CashAndExpensesPanel
                summary={report.summary}
                expenses={report.expenses}
                jobCosts={report.jobCosts}
                currency={currency}
              />
            </div>
            <NetProfitPanel netProfit={report.netProfit} currency={currency} />
          </div>

          {/* ── Document du rapport : cible des exports PDF / image / WhatsApp ── */}
          <PageSection
            title="Document du rapport"
            subtitle="C'est ce document qui est exporté en PDF, en image ou partagé sur WhatsApp."
          >
            <RapportExportDocument
              id={DOCUMENT_ID}
              report={report}
              company={exportCompany}
              className="print-area"
            />
          </PageSection>
        </>
      )}

      {/* ── Historique des envois ────────────────────────────────────────── */}
      <PageSection
        title="Historique des envois"
        subtitle="Chaque ligne décrit ce qui s'est réellement passé : préparé, envoyé ou en échec."
      >
        <Card padded={false} className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-2.5">
            <h3 className="text-sm font-semibold">
              {isHistoryLoading
                ? 'Chargement…'
                : `${formatNumber(historyTotal)} envoi${historyTotal > 1 ? 's' : ''} enregistré${
                    historyTotal > 1 ? 's' : ''
                  }`}
            </h3>
            <span className="text-xs text-base-content/60">
              Mode {manualMode ? 'manuel (hors ligne)' : 'automatique'} — paramétrable dans
              les paramètres
            </span>
          </div>

          {isHistoryLoading ? (
            <div className="p-3">
              <SkeletonTable rows={4} cols={5} />
            </div>
          ) : historyError ? (
            <ErrorState
              title="Impossible de charger l'historique"
              description={historyError}
              onRetry={refresh}
            />
          ) : history.length === 0 ? (
            <EmptyState
              title="Aucun rapport envoyé"
              description="Le bouton « Envoyer le rapport » prépare le message et l'enregistre ici, avec son statut réel."
              action={
                <button
                  type="button"
                  className="btn btn-primary min-h-11"
                  onClick={openSendModal}
                  disabled={!report}
                >
                  Envoyer le rapport
                </button>
              }
            />
          ) : (
            <div className="p-2">
              <ResponsiveTable
                columns={historyColumns}
                data={history}
                getRowKey={(row) => row.id}
                tableClassName="table-sm"
              />
            </div>
          )}
        </Card>

        <Pagination
          currentPage={historyPage}
          totalPages={historyTotalPages}
          onPageChange={setHistoryPage}
        />
      </PageSection>

      {/* ── Modale d'envoi (un état booléen, jamais un « mode » en chaîne) ── */}
      <Modal
        isOpen={isSendOpen}
        onClose={() => setIsSendOpen(false)}
        title="Envoyer le rapport"
        size="lg"
        fullScreenMobile
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-base-200 bg-base-200/50 p-3 text-sm">
            <p className="font-medium">
              {report ? `Rapport ${report.period.label}` : 'Rapport'}
            </p>
            <p className="mt-1 text-xs text-base-content/70">
              {manualMode
                ? "Mode manuel : l'application prépare le message et ouvre WhatsApp / SMS avec le texte prêt. Cela fonctionne sans Internet — vous validez l'envoi."
                : "Mode automatique : le message est transmis à la passerelle configurée. Sans Internet, l'échec est enregistré et affiché, jamais masqué."}
            </p>
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium">Canal</span>
            <div className="flex flex-wrap gap-2">
              {(['whatsapp', 'sms'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setChannel(option)}
                  className={`btn btn-sm min-h-11 sm:min-h-0 ${
                    channel === option ? 'btn-primary' : 'btn-ghost border border-base-300'
                  }`}
                >
                  {CHANNEL_LABELS[option]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="rapport-recipients">
              Destinataires
            </label>
            <textarea
              id="rapport-recipients"
              className="textarea textarea-bordered field-rounded w-full"
              rows={3}
              value={recipientsText}
              onChange={(event) => setRecipientsText(event.target.value)}
              placeholder="+224 620 00 00 00, +224 622 00 00 00"
            />
            <p className="mt-1 text-xs text-base-content/50">
              Séparés par une virgule. Pré-remplis depuis les paramètres
              (<span className="tabular">{settings.reportRecipients?.length ?? 0}</span>{' '}
              destinataire{(settings.reportRecipients?.length ?? 0) > 1 ? 's' : ''} enregistré
              {(settings.reportRecipients?.length ?? 0) > 1 ? 's' : ''}).
            </p>
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-base-200 pt-3">
            <button
              type="button"
              className="btn btn-ghost min-h-11 sm:min-h-0"
              onClick={() => setIsSendOpen(false)}
              disabled={isSending}
            >
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              onClick={handleSendReport}
              disabled={isSending || !report}
            >
              {isSending
                ? 'Traitement…'
                : manualMode
                  ? 'Préparer le message'
                  : 'Envoyer maintenant'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Le bandeau d'export signale l'état d'une génération en cours. */}
      {isExporting && (
        <div className="fixed bottom-4 right-4 z-50 rounded-xl border border-base-200 bg-base-100 px-3 py-2 text-sm shadow-lg no-print">
          Génération du document…
        </div>
      )}
    </div>
  );
}
