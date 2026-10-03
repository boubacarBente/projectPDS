'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ExportDropdown } from '@/components/export-dropdown';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Modal } from '@/components/modal';
import { DatePicker } from '@/components/date-picker';
import { Card, ErrorState, FormField, MoneyText, PageSection, SkeletonCards, StageTracker } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { renderExportDocument } from '@/lib/export-document';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency, today } from '@/lib/format';
import type { StoreLetterheadView } from '@/lib/settings-schema';
import {
  HistoryTimeline,
  QUOTE_LABELS,
  QUOTE_TONES,
  QuoteStatusBadge,
  readApiError,
  useResponsibles,
  type QuoteItemRow,
  type QuoteRow,
} from '@/components/prestations/shared';
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
 * Devis — document client et suivi commercial (cahier « Prestations » §9).
 *
 * Le document ne montre **que** les prestations au prix de vente : aucun coût
 * interne (matériaux au prix d'achat, tarif des ouvriers) ne sort d'ici —
 * c'était le défaut de l'ancien devis, imprimé depuis la fiche chantier.
 * ================================================================== */

const DOCUMENT_ID = 'devis-document';

type Detail = { quote: QuoteRow; items: QuoteItemRow[]; store?: StoreLetterheadView };

const STAGES = [
  { key: 'draft', label: 'Brouillon' },
  { key: 'sent', label: 'Envoyé' },
  { key: 'accepted', label: 'Accepté' },
  { key: 'converted', label: 'Chantier ouvert' },
];

export default function DevisDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const quoteId = Number(params?.id);
  const canUpdate = usePermission('jobs.update');
  const canCreate = usePermission('jobs.create');
  const canCancel = usePermission('jobs.delete');
  const { activeStoreId } = useAuth();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [isWorking, setIsWorking] = useState(false);
  const [isConvertOpen, setIsConvertOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch(`/api/devis/${quoteId}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        setHttpStatus(response.status);
        if (!response.ok) throw new Error(await readApiError(response, 'Le devis n’a pas pu être chargé.'));
        return (await response.json()) as Detail;
      })
      .then(setDetail)
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Le devis n’a pas pu être chargé.');
      });
    return () => controller.abort();
  }, [quoteId, reloadToken]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const { company, exportCompany } = useDocumentCompany(detail?.store);

  const quote = detail?.quote ?? null;
  const lines: DocumentLine[] = useMemo(
    () =>
      (detail?.items ?? []).map((item) => ({
        name: item.serviceName,
        code: item.serviceCode,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent,
        amount: item.amount,
      })),
    [detail],
  );
  const gross = (detail?.items ?? []).reduce((sum, item) => sum + item.grossAmount, 0);
  const discount = quote ? Math.max(0, gross - quote.total) : 0;

  const exportHtml = useMemo(() => {
    if (!quote) return null;
    const money = (value: number) => formatCurrency(value, company.currency);
    const tone = { draft: 'neutral', sent: 'warning', accepted: 'success', refused: 'danger', cancelled: 'danger', expired: 'warning' } as const;
    return renderExportDocument({
      documentTitle: 'Devis',
      documentNumber: quote.reference,
      documentDate: `Du ${formatDateShort(quote.date)}${quote.validUntil ? ` — valable jusqu’au ${formatDateShort(quote.validUntil)}` : ''}`,
      badge: { label: QUOTE_LABELS[quote.displayStatus], tone: tone[quote.displayStatus] },
      company: exportCompany,
      meta: [
        ['Client', quote.customerName],
        ['Téléphone', quote.customerPhone ?? '—'],
        ['Chantier', quote.siteAddress ?? '—'],
        ['Objet', quote.title ?? quote.category ?? '—'],
      ],
      blocks: [
        ...(quote.description ? [{ kind: 'paragraph' as const, title: 'Description des travaux', text: quote.description }] : []),
        exportLinesBlock(lines, company.currency),
        {
          kind: 'totals',
          rows: [
            ...(discount > 0.5 ? [{ label: 'Total avant remise', value: money(gross) }, { label: 'Remises', value: `− ${money(discount)}` }] : []),
            { label: 'TOTAL DU DEVIS', value: money(quote.total), tone: 'strong' as const },
          ],
        },
      ],
      notes: quote.notes,
      footer: `Devis valable${quote.validUntil ? ` jusqu’au ${formatDateShort(quote.validUntil)}` : ''} — ${company.name}`,
    });
  }, [quote, lines, gross, discount, company, exportCompany]);

  const exports = useDocumentExports(
    exportHtml,
    quote ? `devis-${quote.reference}` : 'devis',
    quote
      ? [`*${company.name}*`, `Devis ${quote.reference} du ${formatDateShort(quote.date)}`, `Client : ${quote.customerName}`, `Montant : ${formatCurrency(quote.total, company.currency)}`].join('\n')
      : '',
    'Devis',
  );

  async function post(path: string, body: unknown, success: string) {
    setIsWorking(true);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'L’action n’a pas pu être effectuée.'));
      toast.success(success);
      return await response.json();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'L’action n’a pas pu être effectuée.', { autoClose: 8000 });
      return null;
    } finally {
      setIsWorking(false);
    }
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Devis" title="Devis" description="Devis de prestation." />
        <Card>
          <ErrorState
            title={httpStatus === 404 ? 'Devis introuvable' : httpStatus === 403 ? 'Devis d’un autre magasin' : 'Chargement impossible'}
            description={error}
            onRetry={httpStatus === 404 || httpStatus === 403 ? undefined : refresh}
          />
        </Card>
        <div className="flex justify-center">
          <Link href="/chantiers/devis" className="btn btn-ghost min-h-11">
            Retour aux devis
          </Link>
        </div>
      </div>
    );
  }
  if (!quote || !detail) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Devis" title="Devis" description="Chargement du devis…" />
        <SkeletonCards count={3} />
      </div>
    );
  }

  const own = quote.storeId === activeStoreId;
  const pending = quote.status === 'draft' || quote.status === 'sent';
  const expired = quote.displayStatus === 'expired';
  const stage = quote.jobId ? 'converted' : quote.status;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <div className="no-print space-y-4">
        <PageHeader
          eyebrow="Devis"
          title={`Devis ${quote.reference}`}
          description={`${quote.customerName}${quote.title ? ` · ${quote.title}` : ''}`}
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
              {own && canUpdate && pending && (
                <Link href={`/chantiers/devis/nouveau?modifier=${quote.id}`} className="btn btn-outline min-h-11">
                  Modifier
                </Link>
              )}
              {own && canCreate && (
                <button
                  type="button"
                  className="btn btn-ghost min-h-11 border border-base-300"
                  disabled={isWorking}
                  onClick={async () => {
                    const copy = await post(`/api/devis/${quote.id}/dupliquer`, {}, 'Nouvelle version créée au prix du jour.');
                    if (copy?.id) router.push(`/chantiers/devis/${copy.id}`);
                  }}
                >
                  Nouvelle version
                </button>
              )}
              {own && canCancel && quote.status !== 'cancelled' && !quote.jobId && (
                <button type="button" className="btn btn-ghost min-h-11 text-error" onClick={() => setIsCancelOpen(true)}>
                  Annuler
                </button>
              )}
            </>
          }
        />

        <Card className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Suivi du devis</h2>
              <p className="text-xs text-base-content/55">
                {quote.requestReference ? (
                  <>
                    Issu de la demande{' '}
                    <Link href={`/chantiers/demandes/${quote.requestId}`} className="link">
                      {quote.requestReference}
                    </Link>
                    .{' '}
                  </>
                ) : null}
                {quote.validUntil ? `Valable jusqu’au ${formatDateShort(quote.validUntil)}.` : ''}
              </p>
            </div>
            <QuoteStatusBadge status={quote.displayStatus} />
          </div>

          {quote.status === 'cancelled' || quote.status === 'refused' ? (
            <div className={`rounded-xl border px-4 py-3 text-sm ${quote.status === 'cancelled' ? 'border-error/30 bg-error/10 text-error' : 'border-warning/30 bg-warning/10'}`}>
              {quote.status === 'cancelled'
                ? `Devis annulé — motif : ${quote.cancelReason ?? 'non précisé'}. Il reste consultable.`
                : 'Le client a refusé ce devis. Vous pouvez en faire une nouvelle version au prix du jour.'}
            </div>
          ) : (
            <StageTracker stages={STAGES} current={stage} />
          )}

          {expired && (
            <p className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
              Ce devis a dépassé sa date de validité. Pour qu’il soit accepté, <strong>modifiez-le</strong> et repoussez la
              date de validité, ou faites une <strong>nouvelle version</strong> au prix du jour.
            </p>
          )}

          {own && canUpdate && quote.status !== 'cancelled' && !quote.jobId && (
            <div className="flex flex-wrap gap-2">
              {quote.status === 'draft' && (
                <button
                  type="button"
                  className="btn btn-primary min-h-11"
                  disabled={isWorking}
                  onClick={async () => (await post(`/api/devis/${quote.id}/statut`, { status: 'sent' }, 'Devis marqué envoyé.')) && refresh()}
                >
                  Marquer « envoyé au client »
                </button>
              )}
              {quote.status !== 'accepted' && !expired && (
                <button
                  type="button"
                  className="btn btn-success min-h-11"
                  disabled={isWorking}
                  onClick={async () => (await post(`/api/devis/${quote.id}/statut`, { status: 'accepted' }, 'Devis accepté par le client.')) && refresh()}
                >
                  Le client accepte
                </button>
              )}
              {quote.status !== 'refused' && (
                <button
                  type="button"
                  className="btn btn-ghost min-h-11 border border-base-300 text-error"
                  disabled={isWorking}
                  onClick={async () => (await post(`/api/devis/${quote.id}/statut`, { status: 'refused' }, 'Devis marqué refusé.')) && refresh()}
                >
                  Le client refuse
                </button>
              )}
              {quote.status === 'accepted' && canCreate && (
                <button type="button" className="btn btn-primary min-h-11" disabled={isWorking} onClick={() => setIsConvertOpen(true)}>
                  Ouvrir le chantier
                </button>
              )}
            </div>
          )}

          {quote.jobId && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm">
              <span>
                Chantier ouvert : <strong>{quote.jobReference}</strong> — il facture exactement les prestations de ce devis.
              </span>
              <Link href={`/chantiers/${quote.jobId}`} className="btn btn-success btn-sm min-h-11">
                Voir le chantier
              </Link>
            </div>
          )}
        </Card>
      </div>

      <DocumentShell
        id={DOCUMENT_ID}
        company={company}
        title="Devis"
        number={quote.reference}
        dateLines={[`Établi le ${formatDateShort(quote.date)}`, ...(quote.validUntil ? [`Valable jusqu’au ${formatDateShort(quote.validUntil)}`] : [])]}
        badge={{ label: QUOTE_LABELS[quote.displayStatus], tone: QUOTE_TONES[quote.displayStatus] }}
        footer={company.footerNote || `Devis valable sous réserve d’acceptation dans le délai indiqué.`}
      >
        <PartiesBlock
          customerName={quote.customerName}
          customerPhone={quote.customerPhone}
          rightTitle="Chantier"
          rightLines={[quote.title ?? quote.category ?? 'Prestations', quote.category && quote.title ? quote.category : null, quote.siteAddress]}
        />
        {quote.description ? (
          <div className="mb-5 rounded-xl border border-base-200 bg-base-200/40 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/45">Description des travaux</p>
            <p className="mt-1 whitespace-pre-line text-sm">{quote.description}</p>
          </div>
        ) : null}
        <LinesBlock lines={lines} />
        <TotalsBlock
          rows={[
            ...(discount > 0.5
              ? [
                  { label: 'Total avant remise', value: <MoneyText value={gross} /> },
                  { label: 'Remises', value: <span className="text-success">− <MoneyText value={discount} /></span> },
                ]
              : []),
            { label: 'Total du devis', value: <MoneyText value={quote.total} bold className="text-lg" />, strong: true },
          ]}
        />
        {quote.notes ? (
          <div className="mt-5 rounded-xl border border-base-200 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/45">Conditions</p>
            <p className="mt-1 whitespace-pre-line text-sm">{quote.notes}</p>
          </div>
        ) : null}
      </DocumentShell>

      <div className="no-print">
        <PageSection title="Historique" subtitle="Établissement, envois, réponses du client, conversion.">
          <Card>
            <HistoryTimeline entity="quote" id={quote.id} />
          </Card>
        </PageSection>
      </div>

      <ConvertModal
        isOpen={isConvertOpen}
        onClose={() => setIsConvertOpen(false)}
        quote={quote}
        onConverted={(jobId) => router.push(`/chantiers/${jobId}`)}
      />

      <ConfirmDialog
        isOpen={isCancelOpen}
        onClose={() => setIsCancelOpen(false)}
        title={`Annuler le devis ${quote.reference} ?`}
        message="Le devis n’est pas supprimé : il reste consultable avec son motif d’annulation, mais ne peut plus évoluer."
        confirmLabel="Annuler le devis"
        isSubmitting={isWorking}
        onConfirm={async () => {
          if (!cancelReason.trim()) {
            toast.error('Le motif est obligatoire.');
            return;
          }
          setIsWorking(true);
          try {
            const response = await fetch(`/api/devis/${quote.id}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ reason: cancelReason.trim() }),
            });
            if (!response.ok) throw new Error(await readApiError(response, 'Le devis n’a pas pu être annulé.'));
            toast.success('Devis annulé.');
            setIsCancelOpen(false);
            setCancelReason('');
            refresh();
          } catch (caught) {
            toast.error(caught instanceof Error ? caught.message : 'Le devis n’a pas pu être annulé.');
          } finally {
            setIsWorking(false);
          }
        }}
      >
        <FormField label="Motif" htmlFor="quote-cancel-reason" required>
          <textarea
            id="quote-cancel-reason"
            className="textarea textarea-bordered min-h-20 w-full"
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            placeholder="Ex. saisi en double, client injoignable…"
          />
        </FormField>
      </ConfirmDialog>
    </div>
  );
}

/** Ouverture du chantier d'un devis accepté : dates prévues et responsable. */
function ConvertModal({
  isOpen,
  onClose,
  quote,
  onConverted,
}: {
  isOpen: boolean;
  onClose: () => void;
  quote: QuoteRow;
  onConverted: (jobId: number) => void;
}) {
  const people = useResponsibles(isOpen);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [responsible, setResponsible] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStartDate(today());
    setEndDate('');
    setResponsible('');
    setFormError(null);
  }, [isOpen]);

  async function submit() {
    if (endDate && startDate && endDate < startDate) return setFormError('La fin prévue ne peut pas précéder le début.');
    setIsSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch(`/api/devis/${quote.id}/convertir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ startDate: startDate || null, endDate: endDate || null, responsibleUserId: responsible ? Number(responsible) : null }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Le chantier n’a pas pu être ouvert.'));
      const payload = (await response.json()) as { job: { id: number; reference: string } };
      toast.success(`Chantier ${payload.job.reference} ouvert.`);
      onConverted(payload.job.id);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'Le chantier n’a pas pu être ouvert.');
      setIsSubmitting(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => !isSubmitting && onClose()} title="Ouvrir le chantier" size="md" fullScreenMobile>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          Le chantier reprend les <strong>{quote.itemsCount} prestation(s)</strong> du devis au prix accepté par le client (
          <MoneyText value={quote.total} bold />
          ). Vous pourrez ensuite planifier les étapes, affecter l’équipe et suivre les dépenses.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Début prévu">
            <DatePicker value={startDate} onChange={setStartDate} placeholder="Début" />
          </FormField>
          <FormField label="Fin prévue" hint="Sert à repérer un chantier en retard.">
            <DatePicker value={endDate} onChange={setEndDate} placeholder="Fin" />
          </FormField>
        </div>
        <FormField label="Responsable du chantier" htmlFor="convert-responsible">
          <select
            id="convert-responsible"
            className="select select-bordered min-h-11 w-full"
            value={responsible}
            onChange={(event) => setResponsible(event.target.value)}
          >
            <option value="">— À désigner plus tard —</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
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
            {isSubmitting ? <span className="loading loading-spinner loading-sm" aria-hidden /> : 'Ouvrir le chantier'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
