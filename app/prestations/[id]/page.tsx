'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { ResponsiveTable } from '@/components/responsive-table';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  InfoRow,
  MoneyText,
  PageSection,
  SkeletonCards,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber, formatQuantity } from '@/lib/format';
import { JOB_STATUS_TONES, jobStatusLabel, type JobStatus } from '@/components/chantiers/chantiers-modals';
import {
  HistoryTimeline,
  ServiceStatusBadge,
  readApiError,
  type ServiceDetail,
} from '@/components/prestations/shared';
import { ServiceFormModal, changeServiceStatus } from '@/components/prestations/service-modals';

/* ==================================================================
 * Fiche d'une prestation (cahier « Prestations » §23) : prix, historique des
 * prix, chantiers qui l'utilisent, chiffre d'affaires généré, nombre de
 * réalisations, historique des modifications.
 * ================================================================== */

export default function PrestationDetailPage() {
  const params = useParams<{ id: string }>();
  const serviceId = Number(params?.id);
  const canManage = usePermission('services.manage');
  const { activeStoreId } = useAuth();

  const [detail, setDetail] = useState<ServiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch(`/api/prestations/${serviceId}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        setStatus(response.status);
        if (!response.ok) throw new Error(await readApiError(response, 'La prestation n’a pas pu être chargée.'));
        return (await response.json()) as ServiceDetail;
      })
      .then(setDetail)
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'La prestation n’a pas pu être chargée.');
      });
    return () => controller.abort();
  }, [serviceId, reloadToken]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  if (error) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Prestations" title="Prestation" description="Fiche d’une prestation du catalogue." />
        <Card>
          <ErrorState
            title={status === 404 ? 'Prestation introuvable' : status === 403 ? 'Prestation d’un autre magasin' : 'Chargement impossible'}
            description={error}
            onRetry={status === 404 || status === 403 ? undefined : refresh}
          />
        </Card>
        <div className="flex justify-center">
          <Link href="/prestations" className="btn btn-ghost min-h-11">
            Retour au catalogue
          </Link>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Prestations" title="Prestation" description="Chargement de la prestation…" />
        <SkeletonCards count={4} />
      </div>
    );
  }

  const { service, priceHistory, jobs, quotesCount } = detail;
  const own = canManage && service.storeId === activeStoreId;

  async function setServiceStatus(next: 'active' | 'inactive' | 'archived') {
    setIsWorking(true);
    const updated = await changeServiceStatus(service, next);
    setIsWorking(false);
    if (updated) {
      setIsArchiveOpen(false);
      refresh();
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Prestations"
        title={service.name}
        description={`${service.code} · ${service.category} · ${service.storeName ?? ''}`}
        actions={
          own ? (
            <>
              <button type="button" className="btn btn-outline min-h-11" onClick={() => setIsEditOpen(true)}>
                Modifier
              </button>
              {service.status === 'active' ? (
                <button
                  type="button"
                  className="btn btn-ghost min-h-11 border border-base-300 text-warning"
                  disabled={isWorking}
                  onClick={() => void setServiceStatus('inactive')}
                >
                  Désactiver
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-success min-h-11"
                  disabled={isWorking}
                  onClick={() => void setServiceStatus('active')}
                >
                  Réactiver
                </button>
              )}
              {service.status !== 'archived' && (
                <button type="button" className="btn btn-ghost min-h-11 border border-base-300" onClick={() => setIsArchiveOpen(true)}>
                  Archiver
                </button>
              )}
            </>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCardDelta
          label="Prix indicatif"
          tooltip="Prix proposé par défaut dans un nouveau devis. Il peut être négocié ligne par ligne ; les documents déjà établis gardent leur prix."
          tone="primary"
          value={<MoneyText value={service.unitPrice} />}
          hint={`par ${service.unit}`}
        />
        <StatCardDelta
          label="CA généré"
          tooltip="Total facturé pour cette prestation dans les chantiers en cours ou terminés (chantiers annulés exclus)."
          tone="success"
          value={<MoneyText value={service.revenue} />}
          hint="Chantiers non annulés"
        />
        <StatCardDelta
          label="Chantiers"
          tooltip="Nombre de chantiers qui facturent cette prestation, et nombre de devis qui la proposent."
          tone="info"
          value={formatNumber(service.jobsCount)}
          hint={`${formatNumber(quotesCount)} devis`}
        />
        <StatCardDelta
          label="Réalisé"
          tooltip="Quantité totale facturée dans les chantiers (mètres carrés posés, jours, forfaits…)."
          tone="warning"
          value={formatQuantity(service.quantity, service.unit)}
          hint="Cumul des chantiers"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-1">
          <h2 className="mb-2 text-sm font-semibold">Fiche</h2>
          <InfoRow label="Code">
            <span className="tabular">{service.code}</span>
          </InfoRow>
          <InfoRow label="Catégorie">
            <Badge tone="primary">{service.category}</Badge>
          </InfoRow>
          <InfoRow label="Magasin">{service.storeName ?? '—'}</InfoRow>
          <InfoRow label="Unité">{service.unit}</InfoRow>
          <InfoRow label="Statut">
            <ServiceStatusBadge status={service.status} />
          </InfoRow>
          {service.description && (
            <p className="mt-3 whitespace-pre-line rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm">
              {service.description}
            </p>
          )}
        </Card>

        <Card className="space-y-3 lg:col-span-2">
          <div>
            <h2 className="text-sm font-semibold">Historique des prix</h2>
            <p className="text-xs text-base-content/55">Chaque changement de prix, du plus récent au plus ancien.</p>
          </div>
          {priceHistory.length === 0 ? (
            <p className="rounded-xl border border-base-200 bg-base-200/30 px-4 py-3 text-sm text-base-content/60">
              Prix inchangé depuis la création.
            </p>
          ) : (
            <ul className="divide-y divide-base-200">
              {priceHistory.map((change) => {
                const up = change.newPrice > change.oldPrice;
                return (
                  <li key={change.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="tabular text-base-content/60">{formatDateShort(change.date)}</span>
                    <span className="flex items-center gap-2">
                      <MoneyText value={change.oldPrice} className="text-base-content/50 line-through" />
                      <span aria-hidden>→</span>
                      <MoneyText value={change.newPrice} bold />
                      <Badge tone={up ? 'warning' : 'info'}>{up ? 'Hausse' : 'Baisse'}</Badge>
                    </span>
                    <span className="w-full text-xs text-base-content/50 sm:w-auto">{change.userName ?? '—'}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <PageSection title="Chantiers utilisant cette prestation" subtitle="Quantité, prix figé dans le chantier et montant facturé.">
        {jobs.length === 0 ? (
          <Card>
            <EmptyState title="Aucun chantier" description="Cette prestation n’a encore été facturée sur aucun chantier." />
          </Card>
        ) : (
          <ResponsiveTable
            columns={[
              {
                key: 'date',
                label: 'Début',
                render: (job) => <span className="tabular text-base-content/70">{formatDateShort(job.startDate)}</span>,
              },
              {
                key: 'reference',
                label: 'Chantier',
                primary: true,
                render: (job) => (
                  <div className="min-w-0">
                    <Link href={`/chantiers/${job.jobId}`} className="font-semibold text-primary hover:underline">
                      {job.reference}
                    </Link>
                    <span className="block truncate text-xs text-base-content/55">{job.customerName}</span>
                  </div>
                ),
              },
              {
                key: 'status',
                label: 'Statut',
                render: (job) => (
                  <Badge tone={JOB_STATUS_TONES[job.status as JobStatus] ?? 'neutral'}>{jobStatusLabel(job.status)}</Badge>
                ),
              },
              {
                key: 'quantity',
                label: 'Quantité',
                hideOnMobile: true,
                render: (job) => (
                  <span className="block text-sm">
                    {formatQuantity(job.quantity, job.unit)}
                    <span className="block text-xs text-base-content/55">
                      à <MoneyText value={job.unitPrice} />
                    </span>
                  </span>
                ),
              },
              {
                key: 'amount',
                label: 'Montant',
                className: 'text-right whitespace-nowrap',
                render: (job) => <MoneyText value={job.amount} bold />,
              },
            ]}
            data={jobs}
            getRowKey={(job) => job.jobId}
          />
        )}
      </PageSection>

      <PageSection title="Historique des modifications" subtitle="Qui a créé, modifié, désactivé la prestation, et quand.">
        <Card>
          <HistoryTimeline entity="service" id={service.id} />
        </Card>
      </PageSection>

      <ServiceFormModal isOpen={isEditOpen} onClose={() => setIsEditOpen(false)} onSaved={refresh} service={service} />
      <ConfirmDialog
        isOpen={isArchiveOpen}
        onClose={() => setIsArchiveOpen(false)}
        onConfirm={() => setServiceStatus('archived')}
        title="Archiver la prestation ?"
        message={
          <>
            <strong>{service.name}</strong> disparaîtra du catalogue et ne sera plus proposée. Les devis et chantiers qui
            l’utilisent la gardent telle quelle. Vous pourrez la réactiver plus tard.
          </>
        }
        confirmLabel="Archiver"
        tone="warning"
        isSubmitting={isWorking}
      />
    </div>
  );
}
