import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, toNumber } from '@/lib/api';
import { addBrickOrderPayment, getBrickOrder } from '@/lib/brick-orders';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/briqueterie/commandes/[id]/paiements — encaissement d'un acompte.
 *
 * Le paiement est un `payments` de type `brick_order` : **reçu numéroté**,
 * entrée en caisse, `amount_paid` / `remaining_amount` recalculés depuis les
 * paiements réels (jamais stockés). Toute la mécanique vit dans
 * `lib/payments.ts` — c'est exactement celle d'une vente, ce qui évite deux
 * vérités sur l'argent encaissé.
 *
 * Un brouillon et une commande annulée sont refusés par `createPayment`.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('brick.update');
    const { id } = await params;
    const orderId = parseId(id);
    const body = await readJson<any>(request);

    await addBrickOrderPayment(orderId, {
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
      details: {
        orderNumber: detail?.order.orderNumber ?? null,
        amount: toNumber(body.amount, 0),
        paymentMethod: body.paymentMethod ?? 'Espèces',
      },
    });

    return ok(detail, 201);
  } catch (error) {
    return fail(error);
  }
}
