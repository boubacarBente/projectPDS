import { NextRequest } from 'next/server';
import {
  ForbiddenStoreError,
  NotFoundError,
  ValidationError,
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  requireUser,
  toBool,
  type SessionUser,
} from '@/lib/api';
import { requirePermission, type Action } from '@/lib/permissions';
import {
  approveTransfer,
  canSeeTransfer,
  cancelTransfer,
  getTransfer,
  prepareTransfer,
  receiveTransfer,
  resolveTransferDispute,
  shipTransfer,
  submitTransfer,
  updateDraftTransfer,
  type TransferDetail,
} from '@/lib/transfers';
import { transferActionsFor, type TransferAction } from '@/lib/transfer-actions';

type Params = { params: Promise<{ id: string }> };

function withActions(user: SessionUser, detail: TransferDetail) {
  return { ...detail, actions: transferActionsFor(user, detail.transfer) };
}

/**
 * GET /api/transferts/[id] — fiche complète : en-tête, lignes (demandé,
 * expédié, reçu, en transit, écart), historique des étapes et **liste des
 * actions possibles** pour l'utilisateur (`actions`).
 * Permission : `transfers.view` + l'un des deux magasins dans le périmètre.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('transfers.view');
    const { id } = await params;
    const detail = await getTransfer(parseId(id));
    if (!detail) throw new NotFoundError('Transfert introuvable');
    if (!canSeeTransfer(user, detail.transfer)) throw new ForbiddenStoreError();
    return ok(withActions(user, detail));
  } catch (error) {
    return fail(error);
  }
}

/** Permission exigée par chaque action. */
const ACTION_PERMISSION: Record<TransferAction, Action> = {
  edit: 'transfers.create',
  submit: 'transfers.create',
  approve: 'transfers.approve',
  refuse: 'transfers.approve',
  prepare: 'transfers.ship',
  ship: 'transfers.ship',
  receive: 'transfers.receive',
  resolve: 'transfers.approve',
  cancel: 'transfers.view',
};

/**
 * POST /api/transferts/[id] — fait avancer le transfert.
 *
 * Corps : `{ action, ... }` :
 *  - `edit`    `{ reason?, requestedDate?, notes?, items? }` (brouillon / en attente)
 *  - `submit`  soumet un brouillon
 *  - `approve` `{ note? }` / `refuse` `{ note }` (motif obligatoire)
 *  - `prepare` passe « en préparation » (magasin source)
 *  - `ship`    `{ quantities?: { [itemId]: qté }, note? }` : sortie du stock source
 *  - `receive` `{ quantities: { [itemId]: qté }, discrepancies?: { [itemId]: texte },
 *               close?, note? }` : entrée au stock destinataire
 *  - `resolve` `{ note }` : clôture d'un litige (écart constaté)
 *  - `cancel`  `{ reason }` (impossible après l'expédition)
 *
 * Réponse : la fiche mise à jour, avec ses nouvelles `actions`.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const transferId = parseId(id);
    const body = await readJson<any>(request);
    const action = String(body.action ?? '') as TransferAction;

    if (!(action in ACTION_PERMISSION)) throw new ValidationError('Action inconnue');
    requirePermission(user, ACTION_PERMISSION[action], user.permissions);

    const current = await getTransfer(transferId);
    if (!current) throw new NotFoundError('Transfert introuvable');
    if (!canSeeTransfer(user, current.transfer)) throw new ForbiddenStoreError();
    if (!transferActionsFor(user, current.transfer).includes(action)) {
      throw new ValidationError(
        'Cette action n’est pas possible à cette étape ou depuis ce magasin (vérifiez votre magasin actif).',
      );
    }

    let detail: TransferDetail;
    switch (action) {
      case 'edit':
        detail = await updateDraftTransfer(
          transferId,
          {
            reason: body.reason,
            requestedDate: body.requestedDate,
            notes: body.notes,
            items: Array.isArray(body.items)
              ? body.items.map((i: any) => ({ productId: Number(i.productId), quantity: Number(i.quantity) }))
              : undefined,
          },
          user,
        );
        break;
      case 'submit':
        detail = await submitTransfer(transferId, user);
        break;
      case 'approve':
      case 'refuse':
        detail = await approveTransfer(transferId, action, user, body.note ?? null);
        break;
      case 'prepare':
        detail = await prepareTransfer(transferId, user);
        break;
      case 'ship':
        detail = await shipTransfer(transferId, user, { quantities: body.quantities, note: body.note });
        break;
      case 'receive':
        detail = await receiveTransfer(transferId, user, {
          quantities: body.quantities ?? {},
          discrepancies: body.discrepancies,
          close: toBool(body.close, false),
          note: body.note,
        });
        break;
      case 'resolve':
        detail = await resolveTransferDispute(transferId, user, String(body.note ?? ''));
        break;
      case 'cancel':
        detail = await cancelTransfer(transferId, user, String(body.reason ?? ''));
        break;
    }

    return ok(withActions(user, detail));
  } catch (error) {
    return fail(error);
  }
}
