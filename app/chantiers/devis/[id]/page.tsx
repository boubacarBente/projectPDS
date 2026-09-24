'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ExportDropdown, shareOnWhatsApp } from '@/components/export-dropdown';
import { Card, ErrorState, SkeletonCards, SkeletonTable } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useSettings } from '@/app/parametres/page';
import {
  exportCompanyFromSettings,
  exportDocumentAsImage,
  exportDocumentAsPDF,
  renderExportDocument,
} from '@/lib/export-document';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency, formatQuantity } from '@/lib/format';
import {
  DevisDocument,
  companyFromSettings,
  quoteStatusLabel,
  readApiError,
  type QuoteStatus,
  type ServiceJobDetail,
} from '@/components/chantiers/chantiers-modals';

/* ==================================================================
 * Devis d'un chantier — document imprimable et exportable (README §19).
 *
 * Le devis n'est **pas** un document séparé : il vit dans `service_jobs`
 * (`quote_*` + `quote_status`). Cette page l'imprime, l'exporte en PDF / image,
 * le partage par WhatsApp et permet de faire évoluer son statut d'acceptation.
 *
 * `DOCUMENT_ID` est l'ancre DOM capturée par `lib/export-document.ts` : écran,
 * papier et fichier exporté ne peuvent pas diverger.
 * ================================================================== */

const DOCUMENT_ID = 'chantier-devis-document';

/** Statuts proposés depuis le devis, dans l'ordre du cycle commercial. */
const QUOTE_ACTIONS: { status: QuoteStatus; label: string; variant: string }[] = [
  { status: 'sent', label: 'Marquer « Envoyé »', variant: 'btn-ghost border border-base-300' },
  { status: 'accepted', label: 'Marquer « Accepté »', variant: 'btn-success' },
  { status: 'refused', label: 'Marquer « Refusé »', variant: 'btn-error' },
];

export default function ChantierDevisPage() {
  const params = useParams<{ id: string }>();
  const jobId = Number(params?.id);

  const { settings } = useSettings();
  const canUpdate = usePermission('jobs.update');

  const [detail, setDetail] = useState<ServiceJobDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!Number.isInteger(jobId) || jobId <= 0) {
        setError('Identifiant de devis invalide.');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const response = await fetch(`/api/chantiers/${jobId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        });

        if (response.status === 404) {
          setNotFound(true);
          setDetail(null);
          return;
        }
        if (!response.ok) {
          throw new Error(await readApiError(response, 'Le devis n’a pas pu être chargé.'));
        }

        setDetail((await response.json()) as ServiceJobDetail);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setDetail(null);
        setError(caught instanceof Error ? caught.message : 'Le devis n’a pas pu être chargé.');
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [jobId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const company = useMemo(() => companyFromSettings(settings), [settings]);

  const job = detail?.job ?? null;
  const fileBase = job ? `devis-${job.reference}` : 'devis';

  /* ------------------------------------------------------------------
   * Exports, impression, partage
   * ------------------------------------------------------------------ */

  /**
   * Document HTML autonome (couleurs hexadécimales uniquement) utilisé par les
   * trois exports. Capturer la page affichée échouait : ses couleurs Tailwind
   * (`oklch`, `color-mix`) sont illisibles pour le moteur de capture. Voir
   * `lib/export-document.ts`.
   */
  const exportHtml = useMemo(() => {
    if (!detail || !job) return null;

    const money = (value: number) => formatCurrency(value, company.currency);
    const quoteLabels: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
      draft: { label: 'Brouillon', tone: 'neutral' },
      sent: { label: 'Devis envoyé', tone: 'warning' },
      accepted: { label: 'Devis accepté', tone: 'success' },
      refused: { label: 'Devis refusé', tone: 'danger' },
    };

    return renderExportDocument({
      documentTitle: 'Devis',
      documentNumber: job.reference,
      documentDate: job.startDate ? `Début prévu : ${formatDateShort(job.startDate)}` : null,
      badge: quoteLabels[job.quoteStatus] ?? { label: job.quoteStatus, tone: 'neutral' },
      company: exportCompanyFromSettings(settings),
      meta: [
        ['Client', job.customerName],
        ['Téléphone', job.customerPhone ?? '—'],
        ['Chantier', job.siteAddress ?? '—'],
        ['Prestation', job.title ?? job.category],
      ],
      blocks: [
        ...(job.description
          ? [{ kind: 'paragraph' as const, title: 'Description des travaux', text: job.description }]
          : []),
        {
          kind: 'table',
          title: 'Matériaux',
          columns: [
            { label: 'Code' },
            { label: 'Désignation' },
            { label: 'Qté', align: 'right' as const },
            { label: 'Unité' },
            { label: 'Prix unit.', align: 'right' as const },
            { label: 'Montant', align: 'right' as const },
          ],
          numeric: [2, 4, 5],
          rows: detail.materials.map((material) => [
            material.productCode,
            material.productName,
            formatQuantity(material.quantity, ''),
            material.unit,
            money(material.unitCost),
            money(material.amount),
          ]),
        },
        {
          kind: 'table',
          title: 'Main-d’œuvre',
          columns: [
            { label: 'Ouvrier' },
            { label: 'Rôle' },
            { label: 'Jours', align: 'right' as const },
            { label: 'Tarif/jour', align: 'right' as const },
            { label: 'Montant', align: 'right' as const },
          ],
          numeric: [2, 3, 4],
          rows: detail.workers.map((worker) => [
            worker.workerName,
            worker.role ?? '—',
            formatQuantity(worker.days, ''),
            money(worker.dailyRate),
            money(worker.amount),
          ]),
        },
        {
          kind: 'totals',
          rows: [
            { label: 'Total matériaux', value: money(job.quoteMaterials) },
            { label: 'Total main-d’œuvre', value: money(job.quoteLabor) },
            { label: 'TOTAL DU DEVIS', value: money(job.quoteTotal || job.total), tone: 'strong' },
            ...(job.amountPaid
              ? [{ label: 'Déjà réglé', value: money(job.amountPaid), tone: 'success' as const }]
              : []),
            ...(job.remainingAmount
              ? [{ label: 'Reste à payer', value: money(job.remainingAmount), tone: 'warning' as const }]
              : []),
          ],
        },
      ],
      notes: job.notes,
      footer: `Devis valable sous réserve d’acceptation — ${company.name}`,
    });
  }, [detail, job, settings, company.currency, company.name]);

  const handleExportPDF = async () => {
    if (!exportHtml) return;
    setIsExporting(true);
    try {
      await exportDocumentAsPDF(exportHtml, fileBase);
      toast.success('PDF généré.');
    } catch (error: any) {
      toast.error(error?.message ?? 'Le PDF n’a pas pu être généré.', { autoClose: 10000 });
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
      toast.error(error?.message ?? 'L’image n’a pas pu être générée.', { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };

  const handleShareWhatsApp = async () => {
    if (!detail || !job || !exportHtml) return;

    const message = [
      `*${company.name}*`,
      `Devis ${job.reference} du ${formatDateShort(job.createdAt ?? job.startDate)}`,
      `Client : ${job.customerName}`,
      `Chantier : ${job.siteAddress || '—'}`,
      `Total du devis : ${formatCurrency(job.total, company.currency)}`,
    ].join('\n');

    setIsExporting(true);
    try {
      // Même document que le PDF et l'image : partager `element.outerHTML`
      // enverrait des classes Tailwind sans leur feuille de styles.
      await shareOnWhatsApp(exportHtml, message, `${fileBase}.png`, 'Devis');
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
   * Statut du devis
   * ------------------------------------------------------------------ */

  const updateQuoteStatus = async (quoteStatus: QuoteStatus) => {
    if (!job) return;
    setIsUpdatingStatus(true);
    try {
      const response = await fetch(`/api/chantiers/${job.id}/devis`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ quoteStatus }),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Le statut du devis n’a pas pu être modifié.'));
      }
      toast.success(`Devis ${job.reference} : ${quoteStatusLabel(quoteStatus).toLowerCase()}.`);
      refresh();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : 'Le statut du devis n’a pas pu être modifié.',
      );
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  /* ------------------------------------------------------------------
   * Les 5 états
   * ------------------------------------------------------------------ */

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader
          eyebrow="Production"
          title="Devis"
          description="Chargement du devis, de ses matériaux et de sa main-d’œuvre…"
        />
        <SkeletonCards count={3} />
        <SkeletonTable rows={6} cols={5} />
      </div>
    );
  }

  if (error || notFound || !detail || !job) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader
          eyebrow="Production"
          title="Devis"
          description="Devis imprimable d’une prestation : matériaux, main-d’œuvre et total."
        />
        <Card>
          <ErrorState
            title={notFound ? 'Devis introuvable' : 'Impossible de charger le devis'}
            description={
              notFound
                ? 'Ce devis n’existe pas ou a été retiré de ce poste.'
                : (error ?? 'Le devis n’a pas pu être chargé.')
            }
            onRetry={notFound ? undefined : refresh}
          />
        </Card>
        <div className="flex justify-center">
          <Link href="/chantiers" className="btn btn-ghost min-h-11">
            Retour à la liste des chantiers
          </Link>
        </div>
      </div>
    );
  }

  const isCancelled = job.status === 'cancelled';

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <div className="no-print space-y-4">
        <PageHeader
          eyebrow="Production"
          title={`Devis ${job.reference}`}
          description="Devis imprimable et exportable — matériaux, main-d’œuvre et total."
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
                className="btn btn-ghost min-h-11 border border-base-300"
                onClick={handlePrint}
                disabled={isExporting}
              >
                Imprimer
              </button>
              <Link href={`/chantiers/${job.id}`} className="btn btn-outline min-h-11">
                Fiche du chantier
              </Link>
            </>
          }
        />

        {isCancelled && (
          <div className="rounded-2xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            Ce chantier a été <strong>annulé</strong> : son devis reste consultable et réimprimable,
            mais il ne peut plus évoluer.
          </div>
        )}

        {canUpdate && !isCancelled && (
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Statut du devis</h2>
                <p className="text-xs text-base-content/55">
                  Actuellement : <strong>{quoteStatusLabel(job.quoteStatus)}</strong>. Un devis
                  accepté fait passer un chantier encore au stade « devis » en « en attente ».
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {QUOTE_ACTIONS.filter((action) => action.status !== job.quoteStatus).map((action) => (
                  <button
                    key={action.status}
                    type="button"
                    className={`btn min-h-11 ${action.variant}`}
                    disabled={isUpdatingStatus}
                    onClick={() => void updateQuoteStatus(action.status)}
                  >
                    {isUpdatingStatus ? (
                      <span className="loading loading-spinner loading-sm" aria-hidden />
                    ) : (
                      action.label
                    )}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* Zone d'impression */}
      <DevisDocument
        id={DOCUMENT_ID}
        company={company}
        job={job}
        materials={detail.materials}
        workers={detail.workers}
        className="print-area"
      />

      <div className="no-print flex justify-center">
        <Link href="/chantiers" className="btn btn-ghost min-h-11">
          Retour à la liste des chantiers
        </Link>
      </div>
    </div>
  );
}
