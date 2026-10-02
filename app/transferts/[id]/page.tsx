'use client';

/**
 * Fiche d'un transfert (cahier des charges §8 ; guide §6.15).
 *
 * N'affiche **que** les boutons renvoyés par l'API dans `actions` : ils sont
 * calculés côté serveur selon le statut, les permissions et le **magasin actif**
 * (`lib/transfer-actions.ts`). Le serveur revérifie chaque action.
 *
 * Mouvements de stock : sortie du magasin source à l'**expédition**, entrée au
 * magasin destinataire à la **réception**. Entre les deux, « en transit ».
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Card,
  ErrorState,
  FormField,
  InfoRow,
  PageSection,
  SkeletonCards,
  StageTracker,
  StatCardDelta,
} from '@/components/design-system';
import { useAuth } from '@/components/auth-provider';
import {
  TRANSFER_EVENT_LABELS,
  TRANSFER_STAGES,
  TRANSFER_STATUS,
  TransferStatusBadge,
  readApiError,
  transferStage,
  type TransferAction,
  type TransferDetailRecord,
} from '@/components/transferts/transfer-ui';
import { formatQuantity } from '@/lib/format';
import { formatDateShort, formatDateWithTime } from '@/lib/date-format';

/** Action simple : confirmation + note (obligatoire ou non). */
type NoteAction = 'submit' | 'approve' | 'refuse' | 'prepare' | 'resolve' | 'cancel';

const NOTE_ACTIONS: Record<
  NoteAction,
  { title: string; confirm: string; message: string; noteLabel?: string; required?: boolean; tone: 'success' | 'warning' | 'error' | 'primary' }
> = {
  submit: {
    title: 'Envoyer la demande',
    confirm: 'Envoyer',
    message: 'La demande sera transmise pour validation. Vous pourrez encore la modifier tant qu’elle n’est pas validée.',
    tone: 'primary',
  },
  approve: {
    title: 'Valider le transfert',
    confirm: 'Valider',
    message: 'Le magasin source pourra préparer et expédier la marchandise.',
    noteLabel: 'Commentaire (facultatif)',
    tone: 'success',
  },
  refuse: {
    title: 'Refuser le transfert',
    confirm: 'Refuser',
    message: 'La demande sera close sans aucun mouvement de stock.',
    noteLabel: 'Motif du refus',
    required: true,
    tone: 'error',
  },
  prepare: {
    title: 'Commencer la préparation',
    confirm: 'Commencer',
    message: 'Le transfert passe « en préparation » : le magasin destinataire sait que sa commande est en cours.',
    tone: 'primary',
  },
  resolve: {
    title: 'Clôturer le litige',
    confirm: 'Clôturer',
    message:
      'L’écart entre l’expédié et le reçu sera constaté comme une perte (casse, vol, erreur). Le transfert passera « Reçu ».',
    noteLabel: 'Constat (ce qui s’est passé)',
    required: true,
    tone: 'warning',
  },
  cancel: {
    title: 'Annuler le transfert',
    confirm: 'Annuler le transfert',
    message: 'Le transfert sera abandonné. Aucun stock n’a encore bougé : rien n’est à corriger.',
    noteLabel: 'Motif de l’annulation',
    required: true,
    tone: 'error',
  },
};

const ACTION_BUTTONS: { action: TransferAction; label: string; className: string }[] = [
  { action: 'approve', label: 'Valider', className: 'btn-success' },
  { action: 'refuse', label: 'Refuser', className: 'btn-outline btn-error' },
  { action: 'submit', label: 'Envoyer la demande', className: 'btn-primary' },
  { action: 'prepare', label: 'Commencer la préparation', className: 'btn-outline' },
  { action: 'ship', label: 'Expédier', className: 'btn-primary' },
  { action: 'receive', label: 'Réceptionner', className: 'btn-primary' },
  { action: 'resolve', label: 'Clôturer le litige', className: 'btn-warning' },
  { action: 'cancel', label: 'Annuler', className: 'btn-ghost text-error' },
];

const parseQty = (value: string) => Number(value.replace(',', '.'));

export default function TransfertFichePage() {
  const params = useParams<{ id: string }>();
  const transferId = Number(params.id);
  const { activeStore, stores } = useAuth();

  const [detail, setDetail] = useState<TransferDetailRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [noteAction, setNoteAction] = useState<NoteAction | null>(null);
  const [note, setNote] = useState('');
  const [showShip, setShowShip] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [discrepancies, setDiscrepancies] = useState<Record<number, string>>({});
  const [closeReception, setCloseReception] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/transferts/${transferId}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(await readApiError(response, 'Le transfert n’a pas pu être chargé.'));
      setDetail(await response.json());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Le transfert n’a pas pu être chargé.');
    }
  }, [transferId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (body: Record<string, unknown>, success: string) => {
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/transferts/${transferId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Action impossible.'));
      setDetail(await response.json());
      toast.success(success);
      setNoteAction(null);
      setShowShip(false);
      setShowReceive(false);
      setNote('');
      return true;
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Action impossible.', { autoClose: 9000 });
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  if (error) {
    return (
      <Card>
        <ErrorState description={error} onRetry={() => void load()} />
      </Card>
    );
  }
  if (!detail) return <SkeletonCards count={4} />;

  const { transfer, items, events, actions } = detail;
  const statusInfo = TRANSFER_STATUS[transfer.status];

  const openShip = () => {
    setQuantities(
      Object.fromEntries(items.map((i) => [i.id, String(Math.max(0, i.quantityRequested - i.quantityShipped))])),
    );
    setNote('');
    setShowShip(true);
  };
  const openReceive = () => {
    setQuantities(Object.fromEntries(items.map((i) => [i.id, String(Math.max(0, i.inTransit))])));
    setDiscrepancies(Object.fromEntries(items.map((i) => [i.id, ''])));
    setCloseReception(false);
    setNote('');
    setShowReceive(true);
  };

  const onAction = (action: TransferAction) => {
    if (action === 'edit') return;
    if (action === 'ship') return openShip();
    if (action === 'receive') return openReceive();
    setNote('');
    setNoteAction(action as NoteAction);
  };

  const confirmNoteAction = () => {
    if (!noteAction) return;
    const config = NOTE_ACTIONS[noteAction];
    if (config.required && !note.trim()) {
      toast.error('Ce champ est obligatoire.');
      return;
    }
    const body: Record<string, unknown> = { action: noteAction };
    if (noteAction === 'cancel') body.reason = note.trim();
    else if (note.trim()) body.note = note.trim();
    void run(body, `${config.title} : fait`);
  };

  const confirmShip = () => {
    const payload: Record<number, number> = {};
    for (const item of items) {
      const value = parseQty(quantities[item.id] ?? '0');
      if (!Number.isFinite(value) || value < 0) {
        toast.error(`Quantité invalide pour « ${item.productName} ».`);
        return;
      }
      payload[item.id] = value;
    }
    void run({ action: 'ship', quantities: payload, note: note.trim() || undefined }, 'Marchandise expédiée : elle est maintenant en transit.');
  };

  const confirmReceive = () => {
    const payload: Record<number, number> = {};
    const notes: Record<number, string> = {};
    for (const item of items) {
      const value = parseQty(quantities[item.id] ?? '0');
      if (!Number.isFinite(value) || value < 0) {
        toast.error(`Quantité invalide pour « ${item.productName} ».`);
        return;
      }
      payload[item.id] = value;
      if (discrepancies[item.id]?.trim()) notes[item.id] = discrepancies[item.id].trim();
    }
    void run(
      { action: 'receive', quantities: payload, discrepancies: notes, close: closeReception, note: note.trim() || undefined },
      'Réception enregistrée : la marchandise est entrée en stock.',
    );
  };

  /** Explication quand aucune action n'est possible ici (souvent : mauvais magasin actif). */
  const waitingHelp = (() => {
    if (actions.length > 0) return null;
    const mine = (id: number) => stores.some((s) => s.id === id);
    switch (transfer.status) {
      case 'pending':
        return 'En attente de validation par un gérant.';
      case 'approved':
      case 'preparing':
        return `En attente d’expédition par « ${transfer.sourceStoreName} ». La sortie de stock se fait depuis le magasin source${
          mine(transfer.sourceStoreId) && activeStore?.id !== transfer.sourceStoreId
            ? ' : choisissez ce magasin comme magasin actif (barre latérale) pour expédier.'
            : '.'
        }`;
      case 'in_transit':
      case 'partially_received':
        return `En attente de réception par « ${transfer.destinationStoreName} »${
          mine(transfer.destinationStoreId) && activeStore?.id !== transfer.destinationStoreId
            ? ' : choisissez ce magasin comme magasin actif (barre latérale) pour réceptionner.'
            : '.'
        }`;
      case 'disputed':
        return 'Litige en cours : un gérant doit constater l’écart et clôturer le transfert.';
      default:
        return null;
    }
  })();

  const totalShipped = items.reduce((sum, i) => sum + i.quantityShipped, 0);
  const totalReceived = items.reduce((sum, i) => sum + i.quantityReceived, 0);
  const totalInTransit = items.reduce((sum, i) => sum + i.inTransit, 0);
  const totalRequested = items.reduce((sum, i) => sum + i.quantityRequested, 0);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/transferts" className="hover:underline">
            Transferts
          </Link>
        }
        title={transfer.reference}
        description={`${transfer.sourceStoreName} → ${transfer.destinationStoreName}`}
        actions={
          <>
            {actions.includes('edit') && (
              <Link href={`/transferts/nouveau?edit=${transfer.id}`} className="btn btn-outline min-h-11 sm:min-h-0">
                Modifier
              </Link>
            )}
            {ACTION_BUTTONS.filter((b) => actions.includes(b.action)).map((b) => (
              <button
                key={b.action}
                type="button"
                className={`btn min-h-11 sm:min-h-0 ${b.className}`}
                disabled={isSubmitting}
                onClick={() => onAction(b.action)}
              >
                {b.label}
              </button>
            ))}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <TransferStatusBadge status={transfer.status} />
          <span className="text-sm text-base-content/65">{statusInfo?.hint}</span>
        </div>
        {!['refused', 'cancelled'].includes(transfer.status) && (
          <StageTracker className="mt-4" stages={TRANSFER_STAGES} current={transferStage(transfer.status)} />
        )}
        {waitingHelp && (
          <p className="mt-4 rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">{waitingHelp}</p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCardDelta
          label="Demandé"
          value={formatQuantity(totalRequested)}
          hint={`${items.length} produit(s)`}
          tooltip="Quantité totale demandée par le magasin destinataire, tous produits confondus."
        />
        <StatCardDelta
          label="Expédié"
          value={formatQuantity(totalShipped)}
          tone="info"
          hint={transfer.shippedAt ? `le ${formatDateShort(transfer.shippedAt)}` : 'Pas encore expédié'}
          tooltip="Quantité réellement sortie du stock du magasin source. Elle peut être inférieure à la demande si le stock manquait."
        />
        <StatCardDelta
          label="En transit"
          value={formatQuantity(totalInTransit)}
          tone={totalInTransit > 0 ? 'warning' : 'neutral'}
          hint="Expédié, pas encore reçu"
          tooltip="Marchandise sortie du magasin source mais pas encore entrée au magasin destinataire. Elle n’appartient à aucun des deux stocks tant qu’elle n’est pas reçue."
        />
        <StatCardDelta
          label="Reçu"
          value={formatQuantity(totalReceived)}
          tone="success"
          hint={transfer.receivedAt ? `le ${formatDateShort(transfer.receivedAt)}` : 'Rien de reçu pour l’instant'}
          tooltip="Quantité entrée dans le stock du magasin destinataire, après comptage à l’arrivée."
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <PageSection title="Produits" className="lg:col-span-2">
          <Card padded={false}>
            <ul className="divide-y divide-base-200">
              {items.map((item) => (
                <li key={item.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{item.productName}</span>
                    <span className="tabular text-sm text-base-content/70">
                      Demandé {formatQuantity(item.quantityRequested, item.unit)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/60">
                    <span>Expédié : {formatQuantity(item.quantityShipped, item.unit)}</span>
                    <span>Reçu : {formatQuantity(item.quantityReceived, item.unit)}</span>
                    {item.inTransit > 0 && (
                      <span className="font-medium text-warning">
                        {transfer.status === 'disputed' ? 'Manquant' : 'En transit'} : {formatQuantity(item.inTransit, item.unit)}
                      </span>
                    )}
                    {transfer.status === 'received' && item.quantityShipped - item.quantityReceived > 0.0001 && (
                      <span className="font-medium text-error">
                        Perte constatée : {formatQuantity(item.quantityShipped - item.quantityReceived, item.unit)}
                      </span>
                    )}
                  </div>
                  {item.discrepancyNote && (
                    <p className="mt-1 text-xs text-error">Écart signalé : {item.discrepancyNote}</p>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </PageSection>

        <PageSection title="Informations">
          <Card>
            <InfoRow label="Magasin source">{transfer.sourceStoreName}</InfoRow>
            <InfoRow label="Magasin destinataire">{transfer.destinationStoreName}</InfoRow>
            <InfoRow label="Demandé par">{transfer.requestedByName ?? '—'}</InfoRow>
            <InfoRow label="Créé le">{formatDateWithTime(transfer.createdAt)}</InfoRow>
            <InfoRow label="Date souhaitée">{transfer.requestedDate ? formatDateShort(transfer.requestedDate) : '—'}</InfoRow>
            <InfoRow label="Validé par">{transfer.approvedByName ?? '—'}</InfoRow>
            <InfoRow label="Motif">{transfer.reason || '—'}</InfoRow>
            {transfer.notes && (
              <p className="mt-2 whitespace-pre-line border-t border-base-200 pt-2 text-sm text-base-content/70">{transfer.notes}</p>
            )}
          </Card>
        </PageSection>
      </div>

      <PageSection title="Historique" subtitle="Chaque étape, avec qui l’a faite et où.">
        <Card padded={false}>
          <ol className="divide-y divide-base-200">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 text-sm">
                <span className="tabular text-xs text-base-content/55">{formatDateWithTime(event.createdAt)}</span>
                <span className="font-medium">{TRANSFER_EVENT_LABELS[event.event] ?? event.event}</span>
                <span className="text-base-content/65">
                  {event.userName ?? '—'}
                  {event.storeName ? ` · ${event.storeName}` : ''}
                </span>
                {event.note && <span className="basis-full text-xs text-base-content/60">« {event.note} »</span>}
              </li>
            ))}
          </ol>
        </Card>
      </PageSection>

      {/* ---------------------------- Modales ---------------------------- */}

      <ConfirmDialog
        isOpen={noteAction !== null}
        onClose={() => {
          if (!isSubmitting) setNoteAction(null);
        }}
        onConfirm={confirmNoteAction}
        title={noteAction ? NOTE_ACTIONS[noteAction].title : ''}
        confirmLabel={noteAction ? NOTE_ACTIONS[noteAction].confirm : undefined}
        tone={noteAction ? NOTE_ACTIONS[noteAction].tone : 'primary'}
        isSubmitting={isSubmitting}
        message={noteAction ? NOTE_ACTIONS[noteAction].message : ''}
      >
        {noteAction && NOTE_ACTIONS[noteAction].noteLabel && (
          <FormField label={NOTE_ACTIONS[noteAction].noteLabel!} required={NOTE_ACTIONS[noteAction].required} className="mb-4">
            <textarea className="textarea textarea-bordered w-full" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
        )}
      </ConfirmDialog>

      <Modal
        isOpen={showShip}
        onClose={() => {
          if (!isSubmitting) setShowShip(false);
        }}
        title="Expédier la marchandise"
        size="lg"
        fullScreenMobile
        footer={
          <div className="flex justify-end gap-3 border-t border-base-200 pt-4">
            <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" disabled={isSubmitting} onClick={() => setShowShip(false)}>
              Annuler
            </button>
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" disabled={isSubmitting} onClick={confirmShip}>
              {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : 'Confirmer l’expédition'}
            </button>
          </div>
        }
      >
        <p className="mb-4 text-sm text-base-content/70">
          Indiquez ce qui part réellement. Ces quantités <strong>sortent du stock de {transfer.sourceStoreName}</strong> dès
          la confirmation. Mettez 0 pour un produit que vous n’envoyez pas.
        </p>
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id} className="grid gap-2 rounded-xl border border-base-200 p-3 sm:grid-cols-[1fr_9rem] sm:items-center">
              <div>
                <div className="font-medium">{item.productName}</div>
                <div className="text-xs text-base-content/55">
                  Demandé {formatQuantity(item.quantityRequested, item.unit)} · déjà expédié {formatQuantity(item.quantityShipped, item.unit)}
                </div>
              </div>
              <input
                className="input input-bordered min-h-11 w-full tabular"
                inputMode="decimal"
                value={quantities[item.id] ?? ''}
                onChange={(e) => setQuantities((q) => ({ ...q, [item.id]: e.target.value }))}
                aria-label={`Quantité expédiée de ${item.productName}`}
              />
            </li>
          ))}
        </ul>
        <FormField label="Note (facultatif)" className="mt-4">
          <input className="input input-bordered min-h-11 w-full" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. transporteur, véhicule…" />
        </FormField>
      </Modal>

      <Modal
        isOpen={showReceive}
        onClose={() => {
          if (!isSubmitting) setShowReceive(false);
        }}
        title="Réceptionner la marchandise"
        size="lg"
        fullScreenMobile
        footer={
          <div className="flex justify-end gap-3 border-t border-base-200 pt-4">
            <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" disabled={isSubmitting} onClick={() => setShowReceive(false)}>
              Annuler
            </button>
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" disabled={isSubmitting} onClick={confirmReceive}>
              {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : 'Confirmer la réception'}
            </button>
          </div>
        }
      >
        <p className="mb-4 text-sm text-base-content/70">
          Comptez ce qui est <strong>réellement arrivé</strong>. Ces quantités entrent dans le stock de{' '}
          {transfer.destinationStoreName}. S’il manque quelque chose ou si c’est abîmé, notez-le sur la ligne.
        </p>
        <ul className="space-y-3">
          {items
            .filter((item) => item.inTransit > 0)
            .map((item) => (
              <li key={item.id} className="space-y-2 rounded-xl border border-base-200 p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_9rem] sm:items-center">
                  <div>
                    <div className="font-medium">{item.productName}</div>
                    <div className="text-xs text-base-content/55">En transit : {formatQuantity(item.inTransit, item.unit)}</div>
                  </div>
                  <input
                    className="input input-bordered min-h-11 w-full tabular"
                    inputMode="decimal"
                    value={quantities[item.id] ?? ''}
                    onChange={(e) => setQuantities((q) => ({ ...q, [item.id]: e.target.value }))}
                    aria-label={`Quantité reçue de ${item.productName}`}
                  />
                </div>
                <input
                  className="input input-bordered input-sm min-h-11 w-full sm:min-h-0"
                  value={discrepancies[item.id] ?? ''}
                  onChange={(e) => setDiscrepancies((d) => ({ ...d, [item.id]: e.target.value }))}
                  placeholder="Écart ou dommage (facultatif) : ex. 2 cartons abîmés"
                  aria-label={`Écart constaté sur ${item.productName}`}
                />
              </li>
            ))}
        </ul>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-base-200 p-3 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-sm mt-0.5"
            checked={closeReception}
            onChange={(e) => setCloseReception(e.target.checked)}
          />
          <span>
            <strong>Clôturer la réception</strong> : rien d’autre n’arrivera. S’il manque de la marchandise, le
            transfert passe <em>en litige</em> pour qu’un gérant constate la perte. Sans cette case, le reste
            demeure « en transit » et pourra être reçu plus tard.
          </span>
        </label>
        <FormField label="Note (facultatif)" className="mt-4">
          <input className="input input-bordered min-h-11 w-full" value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </Modal>
    </div>
  );
}
