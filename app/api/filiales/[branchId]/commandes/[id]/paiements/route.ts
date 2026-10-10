import { NextRequest } from 'next/server';
import { fail, NotFoundError, ok, parseId, readJson, requireAction, requireActiveStore, toNumber } from '@/lib/api';
import { getBrickOrder, getBrickOrderRow } from '@/lib/brick-orders';
import { requireBranch } from '@/lib/branches';
import { createPayment } from '@/lib/payments';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ branchId: string; id: string }> };

/**
 * POST /api/filiales/[branchId]/commandes/[id]/paiements — acompte ou solde sur
 * la commande : même moteur qu'une vente (`lib/payments.ts` : reçu, caisse du
 * magasin, reste recalculé). Refusé sur un brouillon, une commande annulée ou
 * déjà facturée, depuis un autre magasin, et pour une commande d'une autre filiale.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { branchId, id } = await params;
    const { user, branch } = await requireBranch(branchId, 'brick.update', { write: true });
    await requireAction('payments.create');
    const orderId = parseId(id);
    const order = await getBrickOrderRow(orderId);
    if (!order || order.branchId !== branch.id) throw new NotFoundError('Commande introuvable dans cette filiale');
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const payment = await createPayment({
      storeId,
      type: 'brick_order',
      referenceId: orderId,
      amount: toNumber(body.amount, 0),
      paymentMethod: body.paymentMethod ?? undefined,
      date: body.date ?? undefined,
      notes: body.notes ?? null,
      userId: user.id,
    });
    const detail = await getBrickOrder(orderId);
    await writeAudit({
      user,
      action: 'payment',
      entity: 'brick_order',
      entityId: orderId,
      details: { branch: branch.name, orderNumber: detail?.order.orderNumber ?? null, amount: payment.amount, receipt: payment.receiptNumber },
    });
    return ok({ ...detail, payment }, 201);
  } catch (error) {
    return fail(error);
  }
}
