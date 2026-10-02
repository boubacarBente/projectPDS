'use client';

/**
 * Briques partagées des écrans Transferts (`/transferts`, `/transferts/nouveau`,
 * `/transferts/[id]`).
 *
 * Les libellés sont **recopiés** de `lib/transfers.ts` : ce module est serveur
 * (il importe `@/db`), seul `import type` est permis côté client (AGENTS.md,
 * invariant 6). Toute modification des statuts doit être reportée ici.
 */

import { Badge, type BadgeTone } from '@/components/design-system';
import type { TransferDetail, TransferItemRow, TransferRow, TransferStatus } from '@/lib/transfers';
import type { TransferAction } from '@/lib/transfer-actions';

/** Dates sérialisées en chaînes ISO par `NextResponse.json`. */
export type TransferRecord = Omit<TransferRow, 'shippedAt' | 'receivedAt' | 'createdAt'> & {
  shippedAt: string | null;
  receivedAt: string | null;
  createdAt: string | null;
};
export type TransferEventRecord = Omit<TransferDetail['events'][number], 'createdAt'> & { createdAt: string | null };
export type TransferDetailRecord = {
  transfer: TransferRecord;
  items: TransferItemRow[];
  events: TransferEventRecord[];
  actions: TransferAction[];
};
export type { TransferAction, TransferStatus, TransferItemRow };

export const TRANSFER_STATUS: Record<TransferStatus, { label: string; tone: BadgeTone; hint: string }> = {
  draft: { label: 'Brouillon', tone: 'neutral', hint: 'Demande en préparation, pas encore envoyée.' },
  pending: { label: 'En attente de validation', tone: 'warning', hint: 'Un gérant doit accepter ou refuser la demande.' },
  approved: { label: 'Validé', tone: 'info', hint: 'Accepté : le magasin source peut préparer et expédier.' },
  preparing: { label: 'En préparation', tone: 'info', hint: 'Le magasin source rassemble la marchandise.' },
  in_transit: { label: 'En transit', tone: 'primary', hint: 'Marchandise sortie du magasin source, pas encore reçue.' },
  partially_received: { label: 'Partiellement reçu', tone: 'warning', hint: 'Une partie seulement est arrivée.' },
  received: { label: 'Reçu', tone: 'success', hint: 'Tout est arrivé : le transfert est terminé.' },
  disputed: { label: 'En litige', tone: 'error', hint: 'Il manque de la marchandise ou elle est abîmée : à régler.' },
  refused: { label: 'Refusé', tone: 'error', hint: 'La demande a été refusée.' },
  cancelled: { label: 'Annulé', tone: 'neutral', hint: 'Abandonné avant l’expédition : aucun stock n’a bougé.' },
};

export const TRANSFER_EVENT_LABELS: Record<string, string> = {
  created: 'Création',
  submitted: 'Soumission',
  approved: 'Validation',
  refused: 'Refus',
  preparing: 'Préparation',
  shipped: 'Expédition',
  received: 'Réception',
  partially_received: 'Réception partielle',
  disputed: 'Litige signalé',
  resolved: 'Litige clôturé',
  cancelled: 'Annulation',
  updated: 'Modification',
};

/** Badge de statut : libellé toujours présent (jamais la couleur seule). */
export function TransferStatusBadge({ status }: { status: TransferStatus }) {
  const entry = TRANSFER_STATUS[status] ?? TRANSFER_STATUS.draft;
  return (
    <span className={status === 'cancelled' ? 'line-through decoration-1' : ''}>
      <Badge tone={entry.tone}>{entry.label}</Badge>
    </span>
  );
}

/** Étape atteinte, pour le suivi « Demande → Validation → Préparation → Transit → Réception ». */
export function transferStage(status: TransferStatus): string {
  switch (status) {
    case 'draft':
      return 'request';
    case 'pending':
    case 'refused':
      return 'approval';
    case 'approved':
    case 'preparing':
      return 'preparation';
    case 'in_transit':
      return 'transit';
    case 'partially_received':
    case 'disputed':
      return 'reception';
    case 'received':
      return 'done';
    default:
      return 'request';
  }
}

export const TRANSFER_STAGES = [
  { key: 'request', label: 'Demande' },
  { key: 'approval', label: 'Validation' },
  { key: 'preparation', label: 'Préparation' },
  { key: 'transit', label: 'Transit' },
  { key: 'reception', label: 'Réception' },
  { key: 'done', label: 'Terminé' },
];

/** Lit `{ error }` d'une réponse d'API, sinon message générique. */
export async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const message = (payload as { error?: unknown }).error;
      if (typeof message === 'string' && message.trim()) return message;
    }
  } catch {
    /* corps illisible */
  }
  return fallback;
}
