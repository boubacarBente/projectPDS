import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  required,
  toNumber,
  requireAction,
} from '@/lib/api';
import { createPayment, listPayments, type PaymentType } from '@/lib/payments';
import { writeAudit } from '@/lib/audit';

/** GET /api/paiements — liste paginée, filtrable par type, document, client, période. */
export async function GET(request: NextRequest) {
  try {
    await requireAction('payments.view');
    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const type = params.get('type') as PaymentType | null;

    const result = await listPayments({
      type: type ?? undefined,
      referenceId: params.get('referenceId') ? Number(params.get('referenceId')) : undefined,
      customerId: params.get('customerId') ? Number(params.get('customerId')) : undefined,
      supplierId: params.get('supplierId') ? Number(params.get('supplierId')) : undefined,
      paymentMethod: params.get('paymentMethod') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      search: params.get('search') ?? undefined,
      page,
      limit,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/paiements — encaissement (vente, prestation) ou décaissement (achat).
 * Génère un reçu numéroté et un mouvement de caisse (§7, §13).
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('payments.create');
    const body = await readJson<any>(request);

    const type = required(body.type, 'Type de paiement') as PaymentType;
    if (!['sale', 'purchase', 'service_job'].includes(type)) {
      return fail(new Error('Type de paiement invalide : attendu sale, purchase ou service_job'));
    }

    const payment = await createPayment({
      type,
      referenceId: toNumber(body.referenceId),
      amount: toNumber(body.amount),
      paymentMethod: body.paymentMethod ?? 'Espèces',
      paymentLabel: body.paymentLabel,
      date: body.date,
      notes: body.notes ?? null,
      userId: user.id,
    });

    await writeAudit({
      user,
      action: 'payment',
      entity: 'payment',
      entityId: payment.id,
      details: {
        receiptNumber: payment.receiptNumber,
        type: payment.type,
        referenceId: payment.referenceId,
        amount: payment.amount,
        paymentMethod: payment.paymentMethod,
        paymentLabel: payment.paymentLabel,
      },
    });

    return ok(payment, 201);
  } catch (error) {
    return fail(error);
  }
}
