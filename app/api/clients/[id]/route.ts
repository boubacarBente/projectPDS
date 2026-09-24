import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  toNumber,
  toBool,
  requireAction,
  NotFoundError,
} from '@/lib/api';
import { deactivateCustomer, getCustomerStats, reactivateCustomer, updateCustomer } from '@/lib/customers';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/clients/[id] — fiche + statistiques + dernières factures. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('customers.view');
    const { id } = await params;

    const stats = await getCustomerStats(parseId(id));
    if (!stats) throw new NotFoundError('Client introuvable');

    return ok(stats);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/clients/[id] */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('customers.update');
    const { id } = await params;
    const customerId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.address !== undefined) patch.address = body.address;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.creditLimit !== undefined) patch.creditLimit = toNumber(body.creditLimit, 0);
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);

    const customer = await updateCustomer(customerId, patch as any);

    await writeAudit({
      user,
      action: 'update',
      entity: 'customer',
      entityId: customerId,
      details: patch,
    });

    return ok(customer);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/clients/[id] — **désactivation**, pas de suppression physique.
 *
 * Une facture ancienne doit rester rattachée à son client, et une suppression
 * réelle ferait ressusciter la ligne au prochain pull de synchronisation
 * (README §26.13). `?reactivate=true` réactive la fiche.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('customers.delete');
    const { id } = await params;
    const customerId = parseId(id);

    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';

    if (reactivate) {
      await reactivateCustomer(customerId);
    } else {
      await deactivateCustomer(customerId);
    }

    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'customer',
      entityId: customerId,
      details: { reactivated: reactivate },
    });

    return ok({ success: true, deactivated: !reactivate });
  } catch (error) {
    return fail(error);
  }
}
