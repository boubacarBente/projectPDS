/**
 * Boutons disponibles sur un transfert, pour un utilisateur donné.
 *
 * Calculé côté serveur (et renvoyé avec la fiche) pour que l'interface
 * n'affiche que les actions réellement possibles. Les fonctions de
 * `lib/transfers.ts` revérifient de toute façon chaque règle.
 */
import { can, type Action } from '@/lib/permissions';
import type { SessionUser } from '@/lib/api';
import type { TransferRow } from '@/lib/transfers';

export type TransferAction =
  | 'edit'
  | 'submit'
  | 'approve'
  | 'refuse'
  | 'prepare'
  | 'ship'
  | 'receive'
  | 'resolve'
  | 'cancel';

export function transferActionsFor(user: SessionUser, t: TransferRow): TransferAction[] {
  const has = (a: Action) => can(user, a, user.permissions);
  const atSource = user.storeId === t.sourceStoreId;
  const atDestination = user.storeId === t.destinationStoreId;
  const involved = user.storeIds.includes(t.sourceStoreId) || user.storeIds.includes(t.destinationStoreId);
  const actions: TransferAction[] = [];
  if (!involved) return actions;

  switch (t.status) {
    case 'draft':
      if (has('transfers.create')) actions.push('edit', 'submit', 'cancel');
      break;
    case 'pending':
      if (has('transfers.approve') && (atSource || user.allStores)) actions.push('approve', 'refuse');
      if (has('transfers.create')) actions.push('edit', 'cancel');
      break;
    case 'approved':
      if (has('transfers.ship') && atSource) actions.push('prepare', 'ship');
      if (has('transfers.create') || has('transfers.approve')) actions.push('cancel');
      break;
    case 'preparing':
      if (has('transfers.ship') && atSource) actions.push('ship');
      if (has('transfers.create') || has('transfers.approve')) actions.push('cancel');
      break;
    case 'in_transit':
      if (has('transfers.receive') && atDestination) actions.push('receive');
      break;
    case 'partially_received':
      if (has('transfers.receive') && atDestination) actions.push('receive');
      if (has('transfers.approve')) actions.push('resolve');
      break;
    case 'disputed':
      if (has('transfers.approve')) actions.push('resolve');
      break;
    default:
      break;
  }
  return actions;
}
