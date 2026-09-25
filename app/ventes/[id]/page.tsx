'use client';

/**
 * Facture de vente — détail, impression, exports et annulation (README §11).
 *
 * `GET /api/ventes/[id]` renvoie `{ invoice, items, payments, schedule }`.
 * Le document imprimable est `components/ventes/invoice-document.tsx`, le même
 * composant que celui capturé par les exports PDF / image (`lib/export-document.ts`
 * vise son `id` DOM) — aucune divergence possible entre l'écran, le papier et le
 * fichier exporté.
 *
 * Une facture annulée n'expose **aucune action d'écriture** : elle reste
 * consultable et réimprimable indéfiniment, avec son motif, son auteur et sa
 * date d'annulation (§10.6, CONVENTIONS §7).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ExportDropdown } from '@/components/export-dropdown';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Tooltip } from '@/components/tooltip';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  InfoRow,
  MiniStat,
  MoneyText,
  SkeletonCards,
  SkeletonTable,
  StatusBadge,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { InvoiceDocument } from '@/components/ventes/invoice-document';
import {
  CancelSaleDialog,
  InvoiceDetailModal,
  SalePaymentModal,
  companyFromSettings,
  normalizeInvoiceRow,
  normalizeItemRow,
  normalizePaymentRow,
  readApiError,
  toDocumentItems,
  toInvoiceDocument,
  type DetailLazyState,
  type PaymentRow,
  type PaymentSchedule,
  type SalesInvoiceItemRow,
  type SalesInvoiceRow,
} from '@/components/ventes/ventes-modals';
import { useSettings } from '@/app/parametres/page';
import {
  exportCompanyFromSettings,
  exportDocumentAsImage,
  exportDocumentAsPDF,
  renderExportDocument,
} from '@/lib/export-document';
import { shareOnWhatsApp } from '@/components/export-dropdown';
import { formatDateShort, formatDateTime } from '@/lib/date-format';
import { formatCurrency, formatNumber, formatQuantity } from '@/lib/format';
const DOCUMENT_ID = 'vente-invoice-document';

type LoadedInvoice = {
  invoice: SalesInvoiceRow;
  items: SalesInvoiceItemRow[];
  payments: PaymentRow[];
  schedule: PaymentSchedule;
};

export default function VenteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const invoiceId = Number(params?.id);

  const { settings } = useSettings();
  const canPay = usePermission('payments.create');
  const canCancel = usePermission('sales.cancel');
  const canUpdate = usePermission('sales.update');

  const [data, setData] = useState<LoadedInvoice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  /* Un état booléen par modale (§8.3 règle 1). */
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        setError('Identifiant de facture invalide.');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const response = await fetch(`/api/ventes/${invoiceId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        });

        if (response.status === 404) {
          setNotFound(true);
          setData(null);
          return;
        }

        if (!response.ok) {
          throw new Error(await readApiError(response, 'La facture n’a pas pu être chargée.'));
        }

        const payload = (await response.json()) as {
          invoice?: unknown;
          items?: unknown;
          payments?: unknown;
          schedule?: PaymentSchedule | null;
        };

        const invoice = normalizeInvoiceRow(payload.invoice);
        const items = Array.isArray(payload.items) ? payload.items.map(normalizeItemRow) : [];
        const payments = Array.isArray(payload.payments)
          ? payload.payments.map(normalizePaymentRow)
          : [];

        // L'échéancier est recalculé s'il manque : jamais de trou d'affichage.
        const schedule: PaymentSchedule = payload.schedule ?? {
          total: invoice.total,
          paid: invoice.amountPaid,
          remaining: invoice.remainingAmount,
          paymentStatus: invoice.paymentStatus,
          dueDate: invoice.dueDate,
          documentDate: invoice.date,
          isOverdue: Boolean(invoice.dueDate) && invoice.remainingAmount > 0.001,
        };

        setData({ invoice, items, payments, schedule });
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setData(null);
        setError(
          caught instanceof Error ? caught.message : 'La facture n’a pas pu être chargée.',
        );
      } finally {
        setIsLoading(false);
      }
    },
    [invoiceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const company = useMemo(() => companyFromSettings(settings), [settings]);

  const documentInvoice = useMemo(
    () => (data ? toInvoiceDocument(data.invoice) : null),
    [data],
  );
  const documentItems = useMemo(() => (data ? toDocumentItems(data.items) : []), [data]);

  /**
   * La page a déjà tout chargé : la modale de détail reçoit les données sans
   * refaire d'appel réseau (aucun double `GET /api/ventes/[id]`).
   */
  const pageDetail = useMemo<DetailLazyState>(
    () => ({
      items: data?.items ?? [],
      payments: data?.payments ?? [],
      schedule: data?.schedule ?? null,
      isLoading: false,
      error: null,
    }),
    [data],
  );

  /* ------------------------------------------------------------------
   * Exports et impression
   * ------------------------------------------------------------------ */

  const fileBase = data ? `facture-${data.invoice.invoiceNumber}` : 'facture';

  /**
   * Document HTML **autonome** utilisé par les trois exports (PDF, image,
   * WhatsApp).
   *
   * ⚠️ On ne capture plus la page affichée. Ses couleurs viennent de Tailwind 4
   * et DaisyUI 5, donc d'`oklch()` et de `color-mix()` : le moteur de capture ne
   * sait pas les lire et l'export échouait (« L'image n'a pas pu être
   * générée »). Ce gabarit n'utilise que des couleurs hexadécimales — c'est
   * l'approche du projet Gaz, et la seule qui fonctionne. Détail complet dans
   * `lib/export-document.ts`.
   */
  const exportHtml = useMemo(() => {
    if (!data) return null;

    const { invoice, items } = data;
    const statusLabels: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
      paid: { label: 'Payée', tone: 'success' },
      partial: { label: 'Partiellement payée', tone: 'warning' },
      unpaid: { label: 'Impayée', tone: 'danger' },
    };
    const badge = statusLabels[invoice.paymentStatus] ?? {
      label: invoice.paymentStatus,
      tone: 'warning' as const,
    };

    return renderExportDocument({
      documentTitle: 'Facture',
      documentNumber: invoice.invoiceNumber,
      documentDate: `Date : ${formatDateShort(invoice.date)}`,
      badge: invoice.status === 'cancelled' ? { label: 'ANNULÉE', tone: 'danger' } : badge,
      company: exportCompanyFromSettings(settings),
      meta: [
        ['Client', invoice.customerName || 'Client comptoir'],
        ['Règlement', invoice.paymentMethod || '—'],
        ['Statut', badge.label],
        ...(invoice.dueDate ? ([['Échéance', formatDateShort(invoice.dueDate)]] as [string, string][]) : []),
        ...(invoice.status === 'cancelled' && invoice.cancelReason
          ? ([['Motif d’annulation', invoice.cancelReason]] as [string, string][])
          : []),
      ],
      blocks: [
        {
          kind: 'table',
          columns: [
            { label: '#' },
            { label: 'Désignation' },
            { label: 'Qté', align: 'right' },
            { label: 'Unité' },
            { label: 'Prix unit.' },
            { label: 'Remise' },
            { label: 'Montant' },
          ],
          numeric: [2, 4, 5, 6],
          rows: items.map((item, index) => [
            String(index + 1),
            item.productName,
            formatQuantity(item.quantity, ''),
            item.unit ?? '',
            formatCurrency(item.unitPrice, company.currency),
            item.discount ? formatCurrency(item.discount, company.currency) : '—',
            formatCurrency(item.amount, company.currency),
          ]),
        },
        {
          kind: 'totals',
          rows: [
            { label: 'Sous-total', value: formatCurrency(invoice.subTotal, company.currency) },
            ...(invoice.discount
              ? [{ label: 'Remise', value: `− ${formatCurrency(invoice.discount, company.currency)}` }]
              : []),
            { label: 'Total HT', value: formatCurrency(invoice.totalHt, company.currency) },
            ...(invoice.taxRate
              ? [
                  {
                    label: `TVA ${formatNumber(invoice.taxRate, 0)} %`,
                    value: formatCurrency(invoice.taxAmount, company.currency),
                  },
                ]
              : []),
            { label: 'Total à payer', value: formatCurrency(invoice.total, company.currency), tone: 'strong' as const },
            { label: 'Montant payé', value: formatCurrency(invoice.amountPaid, company.currency), tone: 'success' as const },
            {
              label: 'Reste à payer',
              value: formatCurrency(invoice.remainingAmount, company.currency),
              tone: invoice.remainingAmount > 0 ? ('warning' as const) : ('normal' as const),
            },
          ],
        },
      ],
      notes: invoice.notes,
      footer: settings.invoiceFooterNote || undefined,
    });
  }, [data, settings, company.currency]);

  const handleExportPDF = async () => {
    if (!exportHtml) return;
    setIsExporting(true);
    try {
      await exportDocumentAsPDF(exportHtml, fileBase);
      toast.success('PDF généré.');
    } catch (error: any) {
      // On affiche la cause réelle : un message générique rend un échec
      // d'export indiagnosticable (c'est ce qui a masqué le problème de
      // couleurs `oklch` pendant tout le développement).
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
      toast.success('Image générée.');
    } catch (error: any) {
      toast.error(error?.message ?? "L'image n'a pas pu être générée.", { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };

  const handleShareWhatsApp = async () => {
    if (!data || !exportHtml) return;

    const { invoice } = data;
    const message = [
      `*${company.companyName}*`,
      `Facture ${invoice.invoiceNumber} du ${formatDateShort(invoice.date)}`,
      `Client : ${invoice.customerName || 'Client comptoir'}`,
      `Total : ${formatCurrency(invoice.total, company.currency)}`,
      `Payé : ${formatCurrency(invoice.amountPaid, company.currency)}`,
      `Reste à payer : ${formatCurrency(invoice.remainingAmount, company.currency)}`,
    ].join('\n');

    setIsExporting(true);
    try {
      // On partage le **même** document HTML que le PDF et l'image. Passer
      // `element.outerHTML` (l'ancien comportement) envoyait les classes
      // Tailwind sans leur feuille de styles : l'image reçue était non stylée.
      await shareOnWhatsApp(exportHtml, message, `${fileBase}.png`, 'Facture');
    } catch (error: any) {
      toast.error(error?.message ?? 'Le partage WhatsApp n’a pas pu être effectué.', {
        autoClose: 10000,
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handlePrint = () => {
    if (!document.getElementById(DOCUMENT_ID)) {
      toast.error('Document introuvable à l’impression.');
      return;
    }
    window.print();
  };

  /* ------------------------------------------------------------------
   * Annulation avec motif obligatoire (§10.6)
   * ------------------------------------------------------------------ */

  const handleCancel = async (reason: string) => {
    if (!data) return;
    setIsCancelling(true);

    try {
      let response = await fetch(`/api/ventes/${data.invoice.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason }),
      });

      if (response.status === 404 || response.status === 405) {
        response = await fetch(`/api/ventes/${data.invoice.id}/annuler`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ reason }),
        });
      }

      if (!response.ok) {
        throw new Error(await readApiError(response, "La vente n'a pas pu être annulée."));
      }

      toast.success(`Vente ${data.invoice.invoiceNumber} annulée.`);
      setShowCancelModal(false);
      refresh();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "La vente n'a pas pu être annulée.",
        { autoClose: 8000 },
      );
    } finally {
      setIsCancelling(false);
    }
  };

  /* ------------------------------------------------------------------
   * Rendu
   * ------------------------------------------------------------------ */

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <PageHeader
          eyebrow="Commercial"
          title="Facture"
          description="Chargement de la facture, de ses lignes et de son échéancier…"
        />
        <SkeletonCards count={4} />
        <SkeletonTable rows={5} cols={6} />
      </div>
    );
  }

  if (error || notFound || !data || !documentInvoice) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <PageHeader
          eyebrow="Commercial"
          title="Facture"
          description="Détail, impression et exports d’une facture de vente."
        />
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title={notFound ? 'Facture introuvable' : 'Impossible de charger la facture'}
            description={
              notFound
                ? 'Cette facture n’existe pas ou a été retirée de ce poste.'
                : (error ?? 'La facture n’a pas pu être chargée.')
            }
            onRetry={notFound ? undefined : refresh}
          />
        </div>
        <div className="flex justify-center">
          <Link href="/ventes" className="btn btn-ghost min-h-11 sm:min-h-0">
            Retour à la liste des ventes
          </Link>
        </div>
      </div>
    );
  }

  const { invoice, items, payments, schedule } = data;
  const isCancelled = invoice.status === 'cancelled';
  const canCollect = canPay && !isCancelled && schedule.remaining > 0.001;

  const paymentColumns = [
    {
      key: 'receiptNumber',
      label: 'Reçu',
      primary: true,
      render: (payment: PaymentRow) => (
        <Link
          href={`/recus/${payment.id}`}
          className="font-semibold text-primary hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {payment.receiptNumber}
        </Link>
      ),
    },
    {
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (payment: PaymentRow) => (
        <span className="tabular text-base-content/70">{formatDateShort(payment.date)}</span>
      ),
    },
    {
      key: 'paymentMethod',
      label: 'Moyen',
      render: (payment: PaymentRow) => <span>{payment.paymentMethod || '—'}</span>,
    },
    {
      key: 'userName',
      label: 'Caissier',
      hideOnMobile: true,
      render: (payment: PaymentRow) => (
        <span className="text-base-content/70">{payment.userName || '—'}</span>
      ),
    },
    {
      key: 'notes',
      label: 'Note',
      hideOnMobile: true,
      render: (payment: PaymentRow) => (
        <span className="text-base-content/60">{payment.notes || '—'}</span>
      ),
    },
    {
      key: 'amount',
      label: 'Montant',
      className: 'text-right whitespace-nowrap',
      render: (payment: PaymentRow) => <MoneyText value={payment.amount} bold />,
    },
  ] satisfies Column<PaymentRow>[];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      {/* En-tête et actions : masqués à l'impression (globals.css, `print:`). */}
      <div className="no-print space-y-4">
        <PageHeader
          eyebrow="Commercial"
          title={`Facture ${invoice.invoiceNumber}`}
          description="Détail, impression, export PDF / image et annulation motivée."
          actions={
            <>
              <ExportDropdown
                onExportPDF={() => void handleExportPDF()}
                onExportImage={() => void handleExportImage()}
                onShareWhatsApp={() => void handleShareWhatsApp()}
                label="Exporter"
              />
              <button
                type="button"
                className="btn btn-ghost min-h-11 sm:min-h-0"
                onClick={handlePrint}
                disabled={isExporting}
              >
                Imprimer
              </button>
              {canCollect && (
                <button
                  type="button"
                  className="btn btn-primary min-h-11 sm:min-h-0"
                  onClick={() => setShowPaymentModal(true)}
                >
                  Enregistrer un paiement
                </button>
              )}
              {canUpdate && !isCancelled && (
                <Tooltip label="Corriger cette vente : ouvrir le formulaire de création prérempli">
                  <button
                    type="button"
                    className="btn btn-outline min-h-11 sm:min-h-0"
                    onClick={() => router.push('/ventes/nouvelle')}
                  >
                    Corriger
                  </button>
                </Tooltip>
              )}
              {canCancel && !isCancelled && (
                <button
                  type="button"
                  className="btn btn-error min-h-11 sm:min-h-0"
                  onClick={() => setShowCancelModal(true)}
                >
                  Annuler la vente
                </button>
              )}
            </>
          }
        />

        {/* Bandeau d'annulation : aucun doute sur l'état de la facture. */}
        {isCancelled && (
          <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm text-error">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Facture annulée</span>
              <StatusBadge status="cancelled" kind="invoice" />
            </div>
            <p className="mt-1.5 break-words">
              <strong>Motif :</strong> {invoice.cancelReason || 'non renseigné'}
            </p>
            <p className="mt-1 text-xs text-error/80">
              Annulée par {invoice.userName || 'un utilisateur'} — les mouvements de stock ont été
              inversés et l&apos;encaissement contre-passé. Cette facture n&apos;est pas supprimée :
              elle reste consultable et réimprimable.
            </p>
          </div>
        )}

        {schedule.isOverdue && !isCancelled && (
          <div className="rounded-2xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="error">En retard</Badge>
              <span>
                Échéance dépassée ({formatDateShort(schedule.dueDate)}) — reste à payer{' '}
                <MoneyText value={schedule.remaining} bold />
              </span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MiniStat label="Total" value={<MoneyText value={invoice.total} />} />
          <MiniStat label="Payé" tone="success" value={<MoneyText value={schedule.paid} />} />
          <MiniStat
            label="Reste"
            tone={schedule.remaining > 0.001 ? 'error' : 'success'}
            value={<MoneyText value={schedule.remaining} colored bold />}
          />
          <MiniStat
            label={invoice.dueDate ? 'Échéance' : 'Règlement'}
            tone={schedule.isOverdue ? 'error' : 'neutral'}
            value={
              <span className="tabular text-sm">
                {invoice.dueDate ? formatDateShort(invoice.dueDate) : invoice.paymentMethod}
              </span>
            }
          />
        </div>
      </div>

      {/* ── Document facture (zone d'impression) ────────────────────────── */}
      <InvoiceDocument
        id={DOCUMENT_ID}
        company={company}
        invoice={documentInvoice}
        items={documentItems}
        customer={{
          name: invoice.customerName,
          phone: null,
          address: null,
        }}
        width="48rem"
        className="print-area"
      />

      {/* ── Échéancier et historique des paiements ─────────────────────── */}
      <div className="no-print grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="space-y-1 lg:col-span-1">
          <h2 className="mb-2 text-sm font-semibold">Échéancier</h2>
          <InfoRow label="Total facturé">
            <MoneyText value={schedule.total} />
          </InfoRow>
          <InfoRow label="Montant payé">
            <MoneyText value={schedule.paid} />
          </InfoRow>
          <InfoRow label="Restant dû">
            <MoneyText value={schedule.remaining} colored bold />
          </InfoRow>
          <InfoRow label="Date de la facture">
            <span className="tabular">{formatDateShort(schedule.documentDate ?? invoice.date)}</span>
          </InfoRow>
          <InfoRow label="Échéance">
            <span className="tabular">
              {schedule.dueDate ? formatDateShort(schedule.dueDate) : 'Comptant (sans échéance)'}
            </span>
          </InfoRow>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <StatusBadge status={schedule.paymentStatus} kind="payment" />
            {schedule.isOverdue && <Badge tone="error">En retard</Badge>}
          </div>
          <p className="pt-1 text-xs text-base-content/50">
            Un reçu est émis pour chaque encaissement ; les montants sont recalculés à la lecture,
            jamais stockés.
          </p>
        </Card>

        <Card padded={false} className="overflow-hidden lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-2.5">
            <h2 className="text-sm font-semibold">
              Historique des paiements
              {payments.length > 0 ? ` (${formatNumber(payments.length)})` : ''}
            </h2>
            {canCollect && (
              <button
                type="button"
                className="btn btn-primary btn-sm min-h-11 sm:min-h-0"
                onClick={() => setShowPaymentModal(true)}
              >
                Encaisser
              </button>
            )}
          </div>

          {payments.length === 0 ? (
            <EmptyState
              title="Aucun encaissement"
              description={
                isCancelled
                  ? 'Cette facture a été annulée : son encaissement éventuel a été contre-passé.'
                  : 'Aucun règlement n’a encore été enregistré sur cette facture.'
              }
              action={
                canCollect ? (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11 sm:min-h-0"
                    onClick={() => setShowPaymentModal(true)}
                  >
                    Enregistrer un paiement
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="p-2">
              <ResponsiveTable
                columns={paymentColumns}
                data={payments}
                getRowKey={(payment) => payment.id}
                tableClassName="table-sm"
                emptyMessage="Aucun encaissement pour cette facture."
              />
            </div>
          )}
        </Card>
      </div>

      {/* ── Traçabilité (repli utile si le document est masqué) ─────────── */}
      <div className="no-print">
        <Card padded={false} className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-2.5">
            <h2 className="text-sm font-semibold">Traçabilité</h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm min-h-11 sm:min-h-0"
              onClick={() => setShowDetailModal(true)}
            >
              Détail des lignes et règlements
            </button>
          </div>
          <div className="px-4 py-2">
            <InfoRow label="Vendeur">
              <span>{invoice.userName || '—'}</span>
            </InfoRow>
            <InfoRow label="Créée le">
              <span className="tabular">{formatDateTime(invoice.createdAt)}</span>
            </InfoRow>
            <InfoRow label="Nombre de lignes">
              <span className="tabular">{formatNumber(items.length)}</span>
            </InfoRow>
            <InfoRow label="Quantité totale">
              <span className="tabular">
                {formatQuantity(items.reduce((sum, item) => sum + item.quantity, 0))}
              </span>
            </InfoRow>
            <InfoRow label="Statut du document">
              <StatusBadge status={invoice.status} kind="invoice" />
            </InfoRow>
          </div>
        </Card>
      </div>

      {/* Modales — une par état booléen (§8.3 règle 1). */}
      <InvoiceDetailModal
        isOpen={showDetailModal}
        onClose={() => setShowDetailModal(false)}
        invoice={invoice}
        detail={pageDetail}
        onOpenPayment={canCollect ? () => setShowPaymentModal(true) : undefined}
        showPrintLink={false}
      />

      <SalePaymentModal
        isOpen={showPaymentModal}
        onClose={() => setShowPaymentModal(false)}
        invoiceId={invoice.id}
        documentNumber={invoice.invoiceNumber}
        customerName={invoice.customerName}
        remainingAmount={schedule.remaining}
        onRecorded={(payment) => {
          toast.success(`Paiement enregistré — reçu ${payment.receiptNumber}.`);
          refresh();
        }}
      />

      <CancelSaleDialog
        isOpen={showCancelModal}
        onClose={() => {
          if (!isCancelling) setShowCancelModal(false);
        }}
        onConfirm={handleCancel}
        invoice={invoice}
        isSubmitting={isCancelling}
      />
    </div>
  );
}
