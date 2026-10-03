'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge, Card, ErrorState, FormField, InfoRow, PageSection, SkeletonCards, StageTracker } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { formatDateShort } from '@/lib/date-format';
import {
  HistoryTimeline,
  REQUEST_STAGES,
  RequestStatusBadge,
  readApiError,
  type RequestStatus,
  type ServiceRequestRow,
} from '@/components/prestations/shared';
import { RequestFormModal } from '@/components/prestations/request-modal';

/* ==================================================================
 * Fiche d'une demande : besoin, prestations souhaitées, avancement, et les
 * suites données (devis, chantier).
 * ================================================================== */

const MANUAL: { status: RequestStatus; label: string }[] = [
  { status: 'study', label: 'Mettre à l’étude' },
  { status: 'visit', label: 'Visite prévue' },
  { status: 'quote_to_prepare', label: 'Devis à préparer' },
];

export default function DemandeDetailPage() {
  const params = useParams<{ id: string }>();
  const requestId = Number(params?.id);
  const canUpdate = usePermission('jobs.update');
  const canCreate = usePermission('jobs.create');
  const { activeStoreId } = useAuth();

  const [request, setRequest] = useState<ServiceRequestRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [isWorking, setIsWorking] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isRefuseOpen, setIsRefuseOpen] = useState(false);
  const [refuseNote, setRefuseNote] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch(`/api/demandes/${requestId}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        setHttpStatus(response.status);
        if (!response.ok) throw new Error(await readApiError(response, 'La demande n’a pas pu être chargée.'));
        return (await response.json()) as ServiceRequestRow;
      })
      .then(setRequest)
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'La demande n’a pas pu être chargée.');
      });
    return () => controller.abort();
  }, [requestId, reloadToken]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  async function setStatus(status: RequestStatus, note?: string) {
    setIsWorking(true);
    try {
      const response = await fetch(`/api/demandes/${requestId}/statut`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ status, note }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Le statut n’a pas pu être changé.'));
      toast.success('Demande mise à jour.');
      refresh();
      return true;
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Le statut n’a pas pu être changé.');
      return false;
    } finally {
      setIsWorking(false);
    }
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Demandes" title="Demande" description="Demande de prestation." />
        <Card>
          <ErrorState
            title={httpStatus === 404 ? 'Demande introuvable' : httpStatus === 403 ? 'Demande d’un autre magasin' : 'Chargement impossible'}
            description={error}
            onRetry={httpStatus === 404 || httpStatus === 403 ? undefined : refresh}
          />
        </Card>
        <div className="flex justify-center">
          <Link href="/chantiers/demandes" className="btn btn-ghost min-h-11">
            Retour aux demandes
          </Link>
        </div>
      </div>
    );
  }
  if (!request) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Demandes" title="Demande" description="Chargement…" />
        <SkeletonCards count={2} />
      </div>
    );
  }

  const own = request.storeId === activeStoreId;
  const closed = request.status === 'converted' || request.status === 'refused';

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Demandes"
        title={`Demande ${request.reference}`}
        description={`${request.customerName} · reçue le ${formatDateShort(request.date)}`}
        actions={
          own && !closed ? (
            <>
              {canUpdate && (
                <button type="button" className="btn btn-outline min-h-11" onClick={() => setIsEditOpen(true)}>
                  Modifier
                </button>
              )}
              {canCreate && !request.quoteId && (
                <Link href={`/chantiers/devis/nouveau?demande=${request.id}`} className="btn btn-primary min-h-11">
                  Établir le devis
                </Link>
              )}
            </>
          ) : undefined
        }
      />

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Avancement</h2>
            <p className="text-xs text-base-content/55">
              Les étapes « devis envoyé », « acceptée » et « chantier » se mettent à jour d’elles-mêmes avec le devis.
            </p>
          </div>
          <RequestStatusBadge status={request.status} />
        </div>
        {request.status === 'refused' ? (
          <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            Demande refusée — sans suite. Elle reste consultable.
          </div>
        ) : (
          <StageTracker stages={REQUEST_STAGES} current={request.status} />
        )}
        {own && canUpdate && !closed && (
          <div className="flex flex-wrap gap-2">
            {MANUAL.filter((action) => action.status !== request.status).map((action) => (
              <button
                key={action.status}
                type="button"
                className="btn btn-ghost min-h-11 border border-base-300"
                disabled={isWorking}
                onClick={() => void setStatus(action.status)}
              >
                {action.label}
              </button>
            ))}
            <button type="button" className="btn btn-ghost min-h-11 text-error" disabled={isWorking} onClick={() => setIsRefuseOpen(true)}>
              Sans suite
            </button>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-3 lg:col-span-2">
          <h2 className="text-sm font-semibold">Besoin du client</h2>
          <p className="whitespace-pre-line rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm">{request.need}</p>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-base-content/55">Prestations envisagées</p>
            {request.services.length === 0 ? (
              <p className="text-sm text-base-content/60">Aucune prestation précisée.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {request.services.map((service, index) => (
                  <Badge key={index} tone="primary">
                    {service.serviceName}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          {request.notes && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-base-content/55">Notes</p>
              <p className="whitespace-pre-line text-sm text-base-content/75">{request.notes}</p>
            </div>
          )}
        </Card>
        <Card className="space-y-1">
          <h2 className="mb-2 text-sm font-semibold">Informations</h2>
          <InfoRow label="Client">{request.customerName}</InfoRow>
          <InfoRow label="Téléphone">
            <span className="tabular">{request.customerPhone ?? '—'}</span>
          </InfoRow>
          <InfoRow label="Adresse">{request.siteAddress ?? '—'}</InfoRow>
          <InfoRow label="Date souhaitée">{formatDateShort(request.desiredDate)}</InfoRow>
          <InfoRow label="Magasin">{request.storeName ?? '—'}</InfoRow>
          <InfoRow label="Saisie par">{request.userName ?? '—'}</InfoRow>
          <div className="space-y-2 border-t border-base-200 pt-3">
            {request.quoteId ? (
              <Link href={`/chantiers/devis/${request.quoteId}`} className="btn btn-ghost btn-sm min-h-11 w-full justify-between border border-base-300">
                Devis <span className="font-semibold">{request.quoteReference}</span>
              </Link>
            ) : (
              <p className="text-xs text-base-content/55">Aucun devis établi.</p>
            )}
            {request.jobId && (
              <Link href={`/chantiers/${request.jobId}`} className="btn btn-success btn-sm min-h-11 w-full justify-between">
                Chantier <span className="font-semibold">{request.jobReference}</span>
              </Link>
            )}
          </div>
        </Card>
      </div>

      <PageSection title="Historique" subtitle="Saisie, changements d’étape, refus.">
        <Card>
          <HistoryTimeline entity="service_request" id={request.id} />
        </Card>
      </PageSection>

      <RequestFormModal isOpen={isEditOpen} onClose={() => setIsEditOpen(false)} request={request} onSaved={refresh} />
      <ConfirmDialog
        isOpen={isRefuseOpen}
        onClose={() => setIsRefuseOpen(false)}
        title="Classer la demande sans suite ?"
        message="La demande reste consultable, mais ne pourra plus donner de devis."
        confirmLabel="Classer sans suite"
        isSubmitting={isWorking}
        onConfirm={async () => {
          if (await setStatus('refused', refuseNote.trim() || undefined)) {
            setIsRefuseOpen(false);
            setRefuseNote('');
          }
        }}
      >
        <FormField label="Raison (facultatif)" htmlFor="request-refuse-note">
          <input
            id="request-refuse-note"
            type="text"
            className="input input-bordered min-h-11 w-full"
            value={refuseNote}
            onChange={(event) => setRefuseNote(event.target.value)}
            placeholder="Ex. budget insuffisant, hors de nos métiers…"
          />
        </FormField>
      </ConfirmDialog>
    </div>
  );
}
