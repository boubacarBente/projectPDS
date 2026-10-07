import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, requireActiveStore, toNumber } from '@/lib/api';
import { getBrickOrder } from '@/lib/brick-orders';
import { createPayment } from '@/lib/payments';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/briqueterie/commandes/[id]/paiements — acompte ou solde sur la
 * commande : même moteur qu'une vente (`lib/payments.ts` : reçu, caisse du
 * magasin, reste recalculé). Refusé sur un brouillon, une commande annulée ou
 * déjà facturée, et depuis un autre magasin.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('payments.create');
    await requireAction('brick.update');
    const { id } = await params;
    const orderId = parseId(id);
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
      details: { orderNumber: detail?.order.orderNumber ?? null, amount: payment.amount, receipt: payment.receiptNumber },
    });
    return ok({ ...detail, payment }, 201);
  } catch (error) {
    return fail(error);
  }
}
