'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { ExportDropdown } from '@/components/export-dropdown';
import { Card, ErrorState, MoneyText, SkeletonCards, type BadgeTone } from '@/components/design-system';
import { renderExportDocument } from '@/lib/export-document';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency } from '@/lib/format';
import type { StoreLetterheadView } from '@/lib/settings-schema';
import { readApiError, type ServiceJobDetail } from '@/components/chantiers/chantiers-modals';
import {
  DocumentShell,
  LinesBlock,
  PartiesBlock,
  TotalsBlock,
  exportLinesBlock,
  useDocumentCompany,
  useDocumentExports,
  type DocumentLine,
} from '@/components/prestations/documents';

/* ==================================================================
 * Facture d'un chantier (cahier « Prestations » §14) — document client.
 *
 * Le chantier **est** le document facturable : son numéro, ses lignes de
 * prestations, ses encaissements. Aucune facture de vente n'est créée (le
 * chiffre d'affaires ne serait compté deux fois). Statut affiché, calculé :
 * payée / partiellement payée / émise (rien encaissé) / annulée.
 *
 * Aucun coût interne n'y figure (invariant n° 14) : ni matériaux au prix
 * d'achat, ni main-d'œuvre, ni marge.
 * ================================================================== */

const DOCUMENT_ID = 'facture-chantier';

type Detail = ServiceJobDetail & { store?: StoreLetterheadView };

export default function FactureChantierPage() {
  const params = useParams<{ id: string }>();
  const jobId = Number(params?.id);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/chantiers/${jobId}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Le chantier n’a pas pu être chargé.'));
        return (await response.json()) as Detail;
      })
      .then(setDetail)
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Le chantier n’a pas pu être chargé.');
      });
    return () => controller.abort();
  }, [jobId]);

  const { company, exportCompany } = useDocumentCompany(detail?.store);
  const job = detail?.job ?? null;

  const lines: DocumentLine[] = useMemo(() => {
    if (!detail || !job) return [];
    if (detail.items.length === 0) {
      // Chantier forfaitaire (ou d'avant la v2) : une seule ligne, sans coût interne.
      return [{ name: job.title || `Travaux — ${job.category}`, unit: 'forfait', quantity: 1, unitPrice: job.total, discountPercent: 0, amount: job.total }];
    }
    return detail.items.map((item) => ({
      name: item.serviceName,
      code: item.serviceCode,
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      amount: item.amount,
    }));
  }, [detail, job]);

  const state: { label: string; tone: BadgeTone; exportTone: 'success' | 'warning' | 'danger' | 'neutral' } = !job
    ? { label: '', tone: 'neutral', exportTone: 'neutral' }
    : job.status === 'cancelled'
      ? { label: 'Annulée', tone: 'error', exportTone: 'danger' }
      : job.remainingAmount <= 0.5
        ? { label: 'Payée', tone: 'success', exportTone: 'success' }
        : job.amountPaid > 0
          ? { label: 'Partiellement payée', tone: 'warning', exportTone: 'warning' }
          : { label: 'Émise', tone: 'info', exportTone: 'neutral' };

  const exportHtml = useMemo(() => {
    if (!job || !detail) return null;
    const money = (value: number) => formatCurrency(value, company.currency);
    return renderExportDocument({
      documentTitle: 'Facture',
      documentNumber: job.reference,
      documentDate: job.actualEndDate ? `Travaux terminés le ${formatDateShort(job.actualEndDate)}` : `Chantier débuté le ${formatDateShort(job.actualStartDate ?? job.startDate)}`,
      badge: { label: state.label, tone: state.exportTone },
      company: exportCompany,
      meta: [
        ['Client', job.customerName],
        ['Téléphone', job.customerPhone ?? '—'],
        ['Chantier', job.siteAddress ?? '—'],
        ['Objet', job.title ?? job.category],
      ],
      blocks: [
        exportLinesBlock(lines, company.currency),
        ...(detail.payments.length
          ? [
              {
                kind: 'table' as const,
                title: 'Paiements reçus',
                columns: [{ label: 'Date' }, { label: 'Reçu' }, { label: 'Moyen' }, { label: 'Montant', align: 'right' as const }],
                numeric: [3],
                rows: detail.payments.map((p) => [formatDateShort(p.date), p.receiptNumber, p.paymentMethod, money(p.amount)]),
              },
            ]
          : []),
        {
          kind: 'totals',
          rows: [
            { label: 'TOTAL', value: money(job.total), tone: 'strong' as const },
            { label: 'Déjà payé', value: money(job.amountPaid), tone: 'success' as const },
            ...(job.status !== 'cancelled' && job.remainingAmount > 0.5
              ? [{ label: 'Reste à payer', value: money(job.remainingAmount), tone: 'danger' as const }]
              : []),
          ],
        },
      ],
      notes: null,
      footer: `Facture du chantier ${job.reference} — ${company.name}`,
    });
  }, [job, detail, lines, company, exportCompany, state.label, state.exportTone]);

  const exports = useDocumentExports(
    exportHtml,
    job ? `facture-${job.reference}` : 'facture',
    job
      ? [`*${company.name}*`, `Facture du chantier ${job.reference}`, `Client : ${job.customerName}`, `Total : ${formatCurrency(job.total, company.currency)}`, `Reste à payer : ${formatCurrency(Math.max(job.remainingAmount, 0), company.currency)}`].join('\n')
      : '',
    'Facture',
  );

  if (error) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Chantiers" title="Facture" description="Facture d’un chantier." />
        <Card>
          <ErrorState title="Impossible de charger la facture" description={error} />
        </Card>
      </div>
    );
  }
  if (!job || !detail) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Chantiers" title="Facture" description="Chargement…" />
        <SkeletonCards count={2} />
      </div>
    );
  }

  // Chantier ouvert sans prix : pas de facture à 0 GNF (règle `assertJobPriced`, lib/jobs.ts).
  if (job.status !== 'cancelled' && !(job.total > 0.001)) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Chantiers" title={`Facture ${job.reference}`} description="Facture d’un chantier." />
        <Card>
          <ErrorState
            title="Montant à définir"
            description="Ce chantier n’a encore ni prestation ni montant forfaitaire : sa facture sera disponible dès qu’un prix sera saisi."
          />
        </Card>
        <div className="flex justify-center">
          <Link href={`/chantiers/${job.id}`} className="btn btn-primary min-h-11">
            Ajouter un prix depuis la fiche du chantier
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="no-print">
        <PageHeader
          eyebrow="Chantiers"
          title={`Facture ${job.reference}`}
          description="Document client : prestations, paiements reçus et reste à payer, au nom du magasin."
          actions={
            <>
              <ExportDropdown
                onExportPDF={() => void exports.exportPDF()}
                onExportImage={() => void exports.exportImage()}
                onShareWhatsApp={() => void exports.shareWhatsApp()}
                label="Exporter"
              />
              <button type="button" className="btn btn-ghost min-h-11 border border-base-300" onClick={() => window.print()} disabled={exports.isExporting}>
                Imprimer
              </button>
              <Link href={`/chantiers/${job.id}`} className="btn btn-outline min-h-11">
                Fiche du chantier
              </Link>
            </>
          }
        />
      </div>

      <DocumentShell
        id={DOCUMENT_ID}
        company={company}
        title="Facture"
        number={job.reference}
        dateLines={[
          job.actualEndDate ? `Travaux terminés le ${formatDateShort(job.actualEndDate)}` : `Début des travaux : ${formatDateShort(job.actualStartDate ?? job.startDate)}`,
        ]}
        badge={{ label: state.label, tone: state.tone }}
      >
        <PartiesBlock
          customerName={job.customerName}
          customerPhone={job.customerPhone}
          rightTitle="Chantier"
          rightLines={[job.title ?? job.category, job.title ? job.category : null, job.siteAddress, job.quoteReference ? `Selon devis ${job.quoteReference}` : null]}
        />
        <LinesBlock lines={lines} />
        {detail.payments.length > 0 && (
          <div className="mb-5">
            <p className="mb-2 text-sm font-semibold">Paiements reçus</p>
            <ul className="divide-y divide-base-200 rounded-xl border border-base-200">
              {detail.payments.map((payment) => (
                <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="tabular text-base-content/70">
                    {formatDateShort(payment.date)} · {payment.receiptNumber} · {payment.paymentMethod}
                  </span>
                  <MoneyText value={payment.amount} bold />
                </li>
              ))}
            </ul>
          </div>
        )}
        <TotalsBlock
          rows={[
            { label: 'Total', value: <MoneyText value={job.total} bold />, strong: true },
            { label: 'Déjà payé', value: <MoneyText value={job.amountPaid} className="text-success" /> },
            ...(job.status !== 'cancelled'
              ? [{ label: 'Reste à payer', value: <MoneyText value={job.remainingAmount} remaining bold className="text-lg" />, strong: true }]
              : []),
          ]}
        />
      </DocumentShell>
    </div>
  );
}
