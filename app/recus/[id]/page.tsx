'use client';

/**
 * Reçu de paiement (README §7.7, §11).
 *
 * `GET /api/paiements/[id]` renvoie `{ payment, documentLabel, documentNumber,
 * customerName, total, amountPaid, remainingAmount, documentDate, dueDate,
 * payments }`. Un reçu reste réimprimable indéfiniment : rien n'est purgé.
 *
 * Document court (§11) : numéro de reçu, facture liée, date, **montant reçu**,
 * reste dû, moyen de paiement, caissier, identité de l'entreprise avec logo.
 * Les 5 états sont couverts ; les exports PDF / image capturent le même nœud DOM
 * que l'impression, donc aucun écart entre l'écran et le papier.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ExportDropdown } from '@/components/export-dropdown';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Card,
  ErrorState,
  InfoRow,
  MiniStat,
  MoneyText,
  SkeletonCards,
  SkeletonTable,
  StatusBadge,
} from '@/components/design-system';
import { useSettings } from '@/app/parametres/page';
import {
  PAYMENT_LABEL_LABELS,
  normalizePaymentRow,
  readApiError,
  type PaymentRow,
} from '@/components/ventes/ventes-modals';
import {
  exportCompanyFromSettings,
  exportDocumentAsImage,
  exportDocumentAsPDF,
  renderExportDocument,
} from '@/lib/export-document';
import { shareOnWhatsApp } from '@/components/export-dropdown';
import { formatDateLong, formatDateShort } from '@/lib/date-format';
import { formatCurrency, formatNumber } from '@/lib/format';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';

const DOCUMENT_ID = 'receipt-document';

type ReceiptData = {
  payment: PaymentRow;
  documentLabel: string;
  documentNumber: string;
  customerName: string;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  documentDate: string | null;
  dueDate: string | null;
  payments: PaymentRow[];
};

export default function RecuPage() {
  const params = useParams<{ id: string }>();
  const paymentId = Number(params?.id);

  const { settings } = useSettings();

  const [data, setData] = useState<ReceiptData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!Number.isInteger(paymentId) || paymentId <= 0) {
        setError('Identifiant de reçu invalide.');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const response = await fetch(`/api/paiements/${paymentId}`, {
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
          throw new Error(await readApiError(response, 'Le reçu n’a pas pu être chargé.'));
        }

        const payload = (await response.json()) as {
          payment?: unknown;
          documentLabel?: string;
          documentNumber?: string;
          customerName?: string;
          total?: number;
          amountPaid?: number;
          remainingAmount?: number;
          documentDate?: string | null;
          dueDate?: string | null;
          payments?: unknown[];
        };

        if (!payload.payment) {
          setNotFound(true);
          setData(null);
          return;
        }

        setData({
          payment: normalizePaymentRow(payload.payment),
          documentLabel: String(payload.documentLabel ?? 'Facture de vente'),
          documentNumber: String(payload.documentNumber ?? '—'),
          customerName: String(payload.customerName ?? 'Client comptoir'),
          total: Number(payload.total ?? 0) || 0,
          amountPaid: Number(payload.amountPaid ?? 0) || 0,
          remainingAmount: Number(payload.remainingAmount ?? 0) || 0,
          documentDate: payload.documentDate ?? null,
          dueDate: payload.dueDate ?? null,
          payments: Array.isArray(payload.payments)
            ? payload.payments.map(normalizePaymentRow)
            : [],
        });
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setData(null);
        setError(caught instanceof Error ? caught.message : 'Le reçu n’a pas pu être chargé.');
      } finally {
        setIsLoading(false);
      }
    },
    [paymentId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const company = settings;
  const currency = company.currency || 'GNF';

  const fileBase = data ? `recu-${data.payment.receiptNumber}` : 'recu';

  /**
   * Document HTML autonome (couleurs hexadécimales uniquement) utilisé par les
   * trois exports. Capturer la page affichée échouait : ses couleurs Tailwind
   * (`oklch`, `color-mix`) sont illisibles pour le moteur de capture. Voir
   * `lib/export-document.ts`.
   */
  const exportHtml = useMemo(() => {
    if (!data) return null;

    const isPaid = data.remainingAmount <= 0.001;

    return renderExportDocument({
      documentTitle: 'Reçu de paiement',
      documentNumber: data.payment.receiptNumber,
      documentDate: `Date : ${formatDateShort(data.payment.date)}`,
      badge: {
        label: isPaid ? 'Soldée' : data.amountPaid > 0.001 ? 'Partiellement réglée' : 'Impayée',
        tone: isPaid ? 'success' : 'warning',
      },
      company: exportCompanyFromSettings(settings),
      meta: [
        ['Client', data.customerName || 'Client comptoir'],
        ['Document réglé', `${data.documentLabel} ${data.documentNumber}`],
        ['Moyen de paiement', data.payment.paymentMethod || '—'],
        ['Encaissé par', data.payment.userName || '—'],
      ],
      blocks: [
        {
          kind: 'totals',
          rows: [
            { label: 'Total du document', value: formatCurrency(data.total, currency) },
            { label: 'Total payé', value: formatCurrency(data.amountPaid, currency), tone: 'success' },
            {
              label: 'Reste à payer',
              value: formatCurrency(data.remainingAmount, currency),
              tone: data.remainingAmount > 0.001 ? 'warning' : 'normal',
            },
            {
              label: 'Montant reçu',
              value: formatCurrency(data.payment.amount, currency),
              tone: 'strong',
            },
          ],
        },
        ...(data.payments.length > 1
          ? [
              {
                kind: 'table' as const,
                title: 'Historique des règlements',
                columns: [
                  { label: 'Date' },
                  { label: 'N° de reçu' },
                  { label: 'Moyen' },
                  { label: 'Montant', align: 'right' as const },
                ],
                numeric: [3],
                rows: data.payments.map((payment) => [
                  formatDateShort(payment.date),
                  payment.receiptNumber,
                  payment.paymentMethod,
                  formatCurrency(payment.amount, currency),
                ]),
              },
            ]
          : []),
      ],
      notes: data.payment.notes,
      footer: `Reçu émis le ${formatDateShort(data.payment.date)} — conservez ce document comme preuve de paiement.`,
    });
  }, [data, settings, currency]);

  const handleExportPDF = async () => {
    if (!exportHtml) return;
    setIsExporting(true);
    try {
      await exportDocumentAsPDF(exportHtml, fileBase);
      toast.success('PDF généré.');
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
      toast.success('Image générée.');
    } catch (error: any) {
      toast.error(error?.message ?? "L'image n'a pas pu être générée.", { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };

  const handleShareWhatsApp = async () => {
    if (!data || !exportHtml) return;

    const message = [
      `*${company.companyName}*`,
      `Reçu ${data.payment.receiptNumber}`,
      `${data.documentLabel} ${data.documentNumber}`,
      `Montant reçu : ${formatCurrency(data.payment.amount, currency)}`,
      `Reste dû : ${formatCurrency(data.remainingAmount, currency)}`,
    ].join('\n');

    setIsExporting(true);
    try {
      // Même document que le PDF et l'image : partager `element.outerHTML`
      // enverrait des classes Tailwind sans leur feuille de styles.
      await shareOnWhatsApp(exportHtml, message, `${fileBase}.png`, 'Reçu de paiement');
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

  const historyColumns = useMemo(
    () =>
      [
        {
          key: 'receiptNumber',
          label: 'Reçu',
          primary: true,
          render: (payment: PaymentRow) => (
            <Link
              href={`/recus/${payment.id}`}
              className="font-semibold text-primary hover:underline"
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
          key: 'amount',
          label: 'Montant',
          className: 'text-right whitespace-nowrap',
          render: (payment: PaymentRow) => <MoneyText value={payment.amount} bold />,
        },
      ] satisfies Column<PaymentRow>[],
    [],
  );

  /* -------------------------------- Les 5 états ---------------------------- */

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <PageHeader
          eyebrow="Encaissements"
          title="Reçu de paiement"
          description="Chargement du reçu…"
        />
        <SkeletonCards count={3} />
        <SkeletonTable rows={4} cols={4} />
      </div>
    );
  }

  if (error || notFound || !data) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <PageHeader
          eyebrow="Encaissements"
          title="Reçu de paiement"
          description="Justificatif d’un encaissement enregistré."
        />
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState
            title={notFound ? 'Reçu introuvable' : 'Impossible de charger le reçu'}
            description={
              notFound
                ? 'Ce reçu n’existe pas ou a été retiré de ce poste.'
                : (error ?? 'Le reçu n’a pas pu être chargé.')
            }
            onRetry={notFound ? undefined : () => setReloadToken((token) => token + 1)}
          />
        </div>
        <div className="flex justify-center">
          <Link href="/ventes" className="btn btn-ghost min-h-11 sm:min-h-0">
            Retour aux ventes
          </Link>
        </div>
      </div>
    );
  }

  const { payment } = data;
  const paymentLabel = PAYMENT_LABEL_LABELS[payment.paymentLabel] ?? payment.paymentLabel;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div className="no-print space-y-4">
        <PageHeader
          eyebrow="Encaissements"
          title={`Reçu ${payment.receiptNumber}`}
          description="Justificatif de règlement — imprimable et exportable en PDF ou en image."
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
              <Link
                href={`/ventes/${payment.referenceId}`}
                className="btn btn-primary min-h-11 sm:min-h-0"
              >
                Voir la facture
              </Link>
            </>
          }
        />

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MiniStat label="Montant reçu" tone="success" value={<MoneyText value={payment.amount} bold />} />
          <MiniStat label="Total facture" value={<MoneyText value={data.total} />} />
          <MiniStat label="Total payé" value={<MoneyText value={data.amountPaid} />} />
          <MiniStat
            label="Reste dû"
            tone={data.remainingAmount > 0.001 ? 'error' : 'success'}
            value={<MoneyText value={data.remainingAmount} colored bold />}
          />
        </div>
      </div>

      {/* ── Document reçu (zone d'impression) ───────────────────────────── */}
      <article
        id={DOCUMENT_ID}
        style={{ width: '48rem' }}
        className="print-area mx-auto max-w-full rounded-2xl border border-base-200 bg-white p-4 text-[13px] text-black shadow-sm sm:p-6 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none"
      >
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-primary/70 pb-4">
          <div className="flex min-w-0 items-start gap-3">
            {/* Logo téléversé dans les paramètres ; à défaut, le logo livré avec
                l'application. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={company.companyLogo || DEFAULT_COMPANY_LOGO}
              alt={`Logo ${company.companyName}`}
              className="h-14 w-14 shrink-0 rounded-xl object-contain sm:h-16 sm:w-16"
            />
            <div className="min-w-0">
              <p className="text-base font-bold leading-tight break-words sm:text-lg">
                {company.companyName}
              </p>
              {company.companyBranch ? (
                <p className="text-xs text-base-content/70">{company.companyBranch}</p>
              ) : null}
              <div className="mt-1 space-y-0.5 text-[11px] leading-4 text-base-content/70">
                {company.companyAddress ? <p>{company.companyAddress}</p> : null}
                <p className="tabular">
                  {company.companyPhone ? `Tél. : ${company.companyPhone}` : null}
                  {company.companyPhone && company.companyEmail ? ' · ' : null}
                  {company.companyEmail ?? null}
                </p>
                {company.companyTaxId ? <p>NIF : {company.companyTaxId}</p> : null}
              </div>
            </div>
          </div>

          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
              Reçu de paiement
            </p>
            <p className="tabular text-lg font-bold leading-tight sm:text-xl">
              {payment.receiptNumber}
            </p>
            <p className="tabular mt-1 text-xs text-base-content/70">
              Date : {formatDateLong(payment.date)}
            </p>
          </div>
        </header>

        <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-base-200 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
              Reçu de
            </p>
            <p className="mt-0.5 text-sm font-semibold break-words">{data.customerName}</p>
            <p className="text-xs text-base-content/70">
              {data.documentLabel} <span className="tabular">{data.documentNumber}</span>
            </p>
            {data.documentDate ? (
              <p className="tabular text-xs text-base-content/70">
                Facture du {formatDateShort(data.documentDate)}
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-base-200 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
              Règlement
            </p>
            <p className="mt-0.5 text-sm font-semibold">{payment.paymentMethod || '—'}</p>
            <p className="text-xs text-base-content/70">{paymentLabel}</p>
            <p className="text-xs text-base-content/70">
              Caissier : {payment.userName || '—'}
            </p>
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-base-200 px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-semibold">Montant reçu</span>
            <span className="tabular text-xl font-bold sm:text-2xl">
              {formatCurrency(payment.amount, currency)}
            </span>
          </div>
          <div className="mt-3 space-y-1 text-sm">
            <div className="flex items-center justify-between gap-3 border-b border-base-200 py-1.5">
              <span className="text-base-content/60">Total de la facture</span>
              <span className="tabular font-medium">{formatCurrency(data.total, currency)}</span>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-base-200 py-1.5">
              <span className="text-base-content/60">Total payé à ce jour</span>
              <span className="tabular font-medium">
                {formatCurrency(data.amountPaid, currency)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 py-1.5">
              <span className="font-semibold">Reste dû</span>
              <span
                className={`tabular font-bold ${
                  data.remainingAmount > 0.001 ? 'text-error' : 'text-success'
                }`}
              >
                {formatCurrency(data.remainingAmount, currency)}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span className="text-base-content/60">Statut de la facture</span>
              <StatusBadge
                status={
                  data.remainingAmount <= 0.001
                    ? 'paid'
                    : data.amountPaid > 0.001
                      ? 'partial'
                      : 'unpaid'
                }
                kind="payment"
              />
            </div>
            {data.dueDate ? (
              <p className="tabular pt-1 text-xs text-base-content/60">
                Échéance de la facture : {formatDateShort(data.dueDate)}
              </p>
            ) : null}
          </div>
        </section>

        {payment.notes ? (
          <section className="mt-4 rounded-xl border border-base-200 px-3 py-2.5 text-xs">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
              Note
            </p>
            <p className="mt-0.5 break-words text-base-content/80">{payment.notes}</p>
          </section>
        ) : null}

        <footer className="mt-6 space-y-1 border-t border-base-200 pt-3 text-center text-[11px] text-base-content/60">
          {company.invoiceFooterNote ? (
            <p className="whitespace-pre-line break-words">{company.invoiceFooterNote}</p>
          ) : null}
          <p>Ce reçu justifie le règlement mentionné ci-dessus. Merci pour votre confiance.</p>
          <p className="font-semibold text-base-content/70">
            {company.companyName}
            {company.companyBranch ? ` — ${company.companyBranch}` : ''}
          </p>
        </footer>
      </article>

      {/* ── Règlements de la même facture ───────────────────────────────── */}
      <div className="no-print space-y-3">
        <Card padded={false} className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/60 px-4 py-2.5">
            <div>
              <h2 className="text-sm font-semibold">
                Règlements de la {data.documentLabel.toLowerCase()}{' '}
                <span className="tabular">{data.documentNumber}</span>
              </h2>
              <p className="text-xs text-base-content/50">
                {formatNumber(data.payments.length)} encaissement
                {data.payments.length > 1 ? 's' : ''} enregistré
                {data.payments.length > 1 ? 's' : ''} au total
              </p>
            </div>
            <Link
              href={`/ventes/${payment.referenceId}`}
              className="btn btn-ghost btn-sm min-h-11 sm:min-h-0"
            >
              Voir la facture
            </Link>
          </div>

          {data.payments.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-base-content/50">
              Aucun autre règlement enregistré sur ce document.
            </p>
          ) : (
            <div className="p-2">
              <ResponsiveTable
                columns={historyColumns}
                data={data.payments}
                getRowKey={(entry) => entry.id}
                tableClassName="table-sm"
                emptyMessage="Aucun règlement."
              />
            </div>
          )}
        </Card>

        <Card className="space-y-1">
          <h2 className="mb-1 text-sm font-semibold">Détail du document</h2>
          <InfoRow label="Type de document">{data.documentLabel}</InfoRow>
          <InfoRow label="Numéro">
            <span className="tabular">{data.documentNumber}</span>
          </InfoRow>
          <InfoRow label="Date de la facture">
            <span className="tabular">{formatDateShort(data.documentDate)}</span>
          </InfoRow>
          <InfoRow label="Montant total">
            <MoneyText value={data.total} />
          </InfoRow>
          <InfoRow label="Reste dû">
            <MoneyText value={data.remainingAmount} colored bold />
          </InfoRow>
        </Card>
      </div>
    </div>
  );
}
