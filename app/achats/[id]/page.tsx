'use client';

/**
 * Bon d'achat : détail, impression, exports et annulation (README §7.5, §11, §14).
 *
 * ⚠️ **On n'exporte jamais la page affichée** (§11 quater). Ses couleurs viennent
 * de Tailwind 4 et DaisyUI 5, donc d'`oklch()` et de `color-mix()` : le moteur de
 * capture ne sait pas les lire et l'export échoue. `renderExportDocument()`
 * construit un document HTML **autonome** en couleurs hexadécimales ; c'est lui
 * qui part au PDF, à l'image et à WhatsApp — jamais `element.outerHTML`.
 *
 * L'impression, elle, utilise `.print-area` (la page affichée) : c'est le
 * navigateur qui imprime, pas un moteur de capture. Tout le reste est `no-print`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ExportDropdown, shareOnWhatsApp } from '@/components/export-dropdown';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
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
import { useSettings } from '@/app/parametres/page';
import { PurchaseDocument } from '@/components/achats/purchase-document';
import {
  CancelPurchaseDialog,
  PurchaseDetailModal,
  PurchasePaymentModal,
  companyFromSettings,
  normalizePaymentRow,
  normalizePurchaseItemRow,
  normalizePurchaseRow,
  readApiError,
  toDocumentItems,
  toPurchaseDocument,
  useSupplierContact,
  type DetailLazyState,
  type PaymentRow,
  type PaymentSchedule,
  type PurchaseInvoiceItemRow,
  type PurchaseInvoiceRow,
} from '@/components/achats/achats-modals';
import {
  exportCompanyFromSettings,
  exportDocumentAsImage,
  exportDocumentAsPDF,
  renderExportDocument,
} from '@/lib/export-document';
import { formatDateShort, formatDateTime } from '@/lib/date-format';
import { formatCurrency, formatNumber, formatQuantity } from '@/lib/format';

const DOCUMENT_ID = 'purchase-document';

type LoadedPurchase = {
  invoice: PurchaseInvoiceRow;
  items: PurchaseInvoiceItemRow[];
  payments: PaymentRow[];
  schedule: PaymentSchedule;
};

export default function AchatDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const rawId = Array.isArray(params?.id) ? params?.id[0] : params?.id;
  const purchaseId = Number(rawId);

  const { settings } = useSettings();
  const canPay = usePermission('payments.create');
  const canUpdate = usePermission('purchases.update');
  const canCancel = usePermission('purchases.delete');

  const [data, setData] = useState<LoadedPurchase | null>(null);
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
      if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        setError("Identifiant d'achat invalide.");
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const response = await fetch(`/api/achats/${purchaseId}`, {
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
          throw new Error(await readApiError(response, "L'achat n'a pas pu être chargé."));
        }

        const payload = (await response.json()) as {
          invoice?: unknown;
          items?: unknown;
          payments?: unknown;
          schedule?: PaymentSchedule | null;
        };

        const invoice = normalizePurchaseRow(payload.invoice);
        const items = Array.isArray(payload.items)
          ? payload.items.map(normalizePurchaseItemRow)
          : [];
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
        setError(caught instanceof Error ? caught.message : "L'achat n'a pas pu être chargé.");
      } finally {
        setIsLoading(false);
      }
    },
    [purchaseId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const company = useMemo(() => companyFromSettings(settings), [settings]);

  const documentInvoice = useMemo(
    () => (data ? toPurchaseDocument(data.invoice) : null),
    [data],
  );
  const documentItems = useMemo(() => (data ? toDocumentItems(data.items) : []), [data]);

  /* Coordonnées du fournisseur pour le document (téléphone, adresse) : appel
     tolérant, un échec laisse simplement le bloc sans coordonnées. */
  const supplierContact = useSupplierContact(data?.invoice.supplierId ?? null, Boolean(data));

  const documentSupplier = useMemo(
    () => ({
      name: data?.invoice.supplierName ?? '',
      phone: supplierContact?.phone ?? null,
      address: supplierContact?.address ?? null,
      reference: data?.invoice.supplierReference ?? null,
    }),
    [data, supplierContact],
  );

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

  const fileBase = data ? `achat-${data.invoice.reference}` : 'achat';

  const handlePrint = () => {
    if (!document.getElementById(DOCUMENT_ID)) {
      toast.error('Document introuvable à l’impression.');
      return;
    }
    window.print();
  };

  /* ------------------------------------------------------------------ *
   * Export — le même document HTML pour le PDF, l'image et WhatsApp
   * ------------------------------------------------------------------ */

  const exportHtml = useMemo(() => {
    if (!data) return null;

    const { invoice, items } = data;
    const statusLabels: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
      paid: { label: 'Payé', tone: 'success' },
      partial: { label: 'Partiellement payé', tone: 'warning' },
      unpaid: { label: 'À payer', tone: 'danger' },
    };
    const badge = statusLabels[invoice.paymentStatus] ?? {
      label: invoice.paymentStatus,
      tone: 'warning' as const,
    };

    return renderExportDocument({
      documentTitle: "BON D'ACHAT",
      documentNumber: invoice.reference,
      documentDate: `Date : ${formatDateShort(invoice.date)}`,
      badge: invoice.status === 'cancelled' ? { label: 'ANNULÉ', tone: 'danger' } : badge,
      company: exportCompanyFromSettings(settings),
      meta: [
        ['Fournisseur', invoice.supplierName || '—'],
        ['Réf. fournisseur', invoice.supplierReference || '—'],
        ['Règlement', invoice.paymentMethod || '—'],
        ['Statut', badge.label],
        ...(invoice.dueDate
          ? ([['Échéance', formatDateShort(invoice.dueDate)]] as [string, string][])
          : []),
        ...(invoice.status === 'cancelled' && invoice.cancelReason
          ? ([["Motif d'annulation", invoice.cancelReason]] as [string, string][])
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
            { label: "Prix d'achat" },
            { label: 'Montant' },
          ],
          // Colonnes numériques : quantité, prix d'achat, montant.
          numeric: [2, 4, 5],
          rows: items.map((item, index) => [
            String(index + 1),
            item.productName,
            formatQuantity(item.quantity, ''),
            item.unit ?? '',
            formatCurrency(item.unitPrice, company.currency),
            formatCurrency(item.amount, company.currency),
          ]),
        },
        {
          kind: 'totals',
          rows: [
            {
              label: "Total de l'achat",
              value: formatCurrency(invoice.total, company.currency),
              tone: 'strong' as const,
            },
            {
              label: 'Montant payé',
              value: formatCurrency(invoice.amountPaid, company.currency),
              tone: 'success' as const,
            },
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
      `Bon d'achat ${invoice.reference} du ${formatDateShort(invoice.date)}`,
      `Fournisseur : ${invoice.supplierName || '—'}`,
      `Total : ${formatCurrency(invoice.total, company.currency)}`,
      `Payé : ${formatCurrency(invoice.amountPaid, company.currency)}`,
      `Reste à payer : ${formatCurrency(invoice.remainingAmount, company.currency)}`,
    ].join('\n');

    setIsExporting(true);
    try {
      // On partage le **même** document HTML que le PDF et l'image : passer
      // `element.outerHTML` enverrait les classes Tailwind sans leur feuille de
      // styles, donc une image non stylée.
      await shareOnWhatsApp(exportHtml, message, `${fileBase}.png`, "Bon d'achat");
    } catch (error: any) {
      toast.error(error?.message ?? 'Le partage WhatsApp n’a pas pu être effectué.', {
        autoClose: 10000,
      });
    } finally {
      setIsExporting(false);
    }
  };

  /* ------------------------------------------------------------------ *
   * Annulation motivée — jamais une suppression physique (§14)
   * ------------------------------------------------------------------ */

  const handleCancel = async (reason: string) => {
    if (!data) return;
    setIsCancelling(true);

    try {
      const response = await fetch(`/api/achats/${data.invoice.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, "L'achat n'a pas pu être annulé."));
      }

      toast.success(`Achat ${data.invoice.reference} annulé.`);
      setShowCancelModal(false);
      refresh();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "L'achat n'a pas pu être annulé.",
        { autoClose: 8000 },
      );
    } finally {
      setIsCancelling(false);
    }
  };

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

  /* ------------------------------------------------------------------ *
   * Les 5 états : chargement, erreur, introuvable, nominal, feedback
   * ------------------------------------------------------------------ */

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <PageHeader
          eyebrow="Commercial"
          title="Achat"
          description="Chargement de l’achat, de ses lignes et de son échéancier…"
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
          title="Achat"
          description="Détail, impression et exports d’un achat fournisseur."
        />
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title={notFound ? 'Achat introuvable' : "Impossible de charger l'achat"}
            description={
              notFound
                ? "Cet achat n'existe pas ou a été retiré de ce poste."
                : (error ?? "L'achat n'a pas pu être chargé.")
            }
            onRetry={notFound ? undefined : refresh}
          />
        </div>
        <div className="flex justify-center">
          <Link href="/achats" className="btn btn-ghost min-h-11 sm:min-h-0">
            Retour à la liste des achats
          </Link>
        </div>
      </div>
    );
  }

  const { invoice, items, payments, schedule } = data;
  const isCancelled = invoice.status === 'cancelled';
  const canSettle = canPay && !isCancelled && schedule.remaining > 0.001;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      {/* En-tête et actions : masqués à l'impression (`no-print`, globals.css). */}
      <div className="no-print space-y-4">
        <PageHeader
          eyebrow="Commercial"
          title={`Achat ${invoice.reference}`}
          description="Détail, impression, export PDF / image / WhatsApp et annulation motivée."
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
              {canSettle && (
                <button
                  type="button"
                  className="btn btn-primary min-h-11 sm:min-h-0"
                  onClick={() => setShowPaymentModal(true)}
                >
                  Enregistrer un paiement
                </button>
              )}
              {canUpdate && !isCancelled && (
                <button
                  type="button"
                  className="btn btn-outline min-h-11 sm:min-h-0"
                  onClick={() => router.push(`/achats/nouvelle?edit=${invoice.id}`)}
                  title="Corriger cet achat : stock ajusté par différence"
                >
                  Modifier
                </button>
              )}
              {canCancel && !isCancelled && (
                <button
                  type="button"
                  className="btn btn-error min-h-11 sm:min-h-0"
                  onClick={() => setShowCancelModal(true)}
                >
                  Annuler l&apos;achat
                </button>
              )}
            </>
          }
        />

        {isCancelled && (
          <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm text-error">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Achat annulé</span>
              <StatusBadge status="cancelled" kind="invoice" />
            </div>
            <p className="mt-1.5 break-words">
              <strong>Motif :</strong> {invoice.cancelReason || 'non renseigné'}
            </p>
            <p className="mt-1 text-xs text-error/80">
              Annulé par {invoice.userName || 'un utilisateur'} — les entrées de stock ont été
              inversées et le décaissement contre-passé. Cet achat n&apos;est pas supprimé : il reste
              consultable et réimprimable.
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

      {/* ── Bon d'achat (zone d'impression) ─────────────────────────────── */}
      <PurchaseDocument
        id={DOCUMENT_ID}
        company={company}
        invoice={documentInvoice}
        items={documentItems}
        supplier={documentSupplier}
        width="48rem"
        className="print-area"
      />

      {/* ── Échéancier + historique des règlements ──────────────────────── */}
      <div className="no-print grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="space-y-1 lg:col-span-1">
          <h2 className="mb-2 text-sm font-semibold">Échéancier</h2>
          <InfoRow label="Total acheté">
            <MoneyText value={schedule.total} />
          </InfoRow>
          <InfoRow label="Montant payé">
            <MoneyText value={schedule.paid} />
          </InfoRow>
          <InfoRow label="Restant dû">
            <MoneyText value={schedule.remaining} colored bold />
          </InfoRow>
          <InfoRow label="Date de l'achat">
            <span className="tabular">
              {formatDateShort(schedule.documentDate ?? invoice.date)}
            </span>
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
            Un reçu est émis pour chaque règlement ; les montants sont recalculés à la lecture,
            jamais stockés. Le reste à payer alimente la dette fournisseur (§15).
          </p>
        </Card>

        <Card padded={false} className="overflow-hidden lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-2.5">
            <h2 className="text-sm font-semibold">
              Historique des paiements
              {payments.length > 0 ? ` (${formatNumber(payments.length)})` : ''}
            </h2>
            {canSettle && (
              <button
                type="button"
                className="btn btn-primary btn-sm min-h-11 sm:min-h-0"
                onClick={() => setShowPaymentModal(true)}
              >
                Payer
              </button>
            )}
          </div>

          {payments.length === 0 ? (
            <EmptyState
              title="Aucun règlement"
              description={
                isCancelled
                  ? 'Cet achat a été annulé : son décaissement éventuel a été contre-passé.'
                  : 'Aucun règlement n’a encore été enregistré sur cet achat.'
              }
              action={
                canSettle ? (
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
                emptyMessage="Aucun règlement pour cet achat."
              />
            </div>
          )}
        </Card>
      </div>

      {/* ── Traçabilité ─────────────────────────────────────────────────── */}
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
            <InfoRow label="Saisi par">
              <span>{invoice.userName || '—'}</span>
            </InfoRow>
            <InfoRow label="Réf. fournisseur">
              <span className="tabular">{invoice.supplierReference || '—'}</span>
            </InfoRow>
            <InfoRow label="Créé le">
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
      <PurchaseDetailModal
        isOpen={showDetailModal}
        onClose={() => setShowDetailModal(false)}
        invoice={invoice}
        detail={pageDetail}
        onOpenPayment={canSettle ? () => setShowPaymentModal(true) : undefined}
        showDocumentLink={false}
      />

      <PurchasePaymentModal
        isOpen={showPaymentModal}
        onClose={() => setShowPaymentModal(false)}
        invoiceId={invoice.id}
        documentNumber={invoice.reference}
        supplierName={invoice.supplierName}
        remainingAmount={schedule.remaining}
        onRecorded={(payment) => {
          toast.success(`Règlement enregistré — reçu ${payment.receiptNumber}.`);
          refresh();
        }}
      />

      <CancelPurchaseDialog
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
