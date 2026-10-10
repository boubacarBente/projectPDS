import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireActiveStore, scopeFromRequest, toBool, toInt } from '@/lib/api';
import { createBrickOrder, isBrickOrderStatus, listBrickOrders, readOrderItems as readItems } from '@/lib/brick-orders';
import { requireBranch } from '@/lib/branches';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/commandes — commandes de la filiale dans la
 * portée (README §31). La commande ne touche ni le stock ni la caisse : elle se
 * facture (`action: 'invoice'`), ses acomptes passent par `…/commandes/[id]/paiements`.
 * `?status=invoiced` : commandes facturées.
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    const search = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(search);
    const customerId = search.get('customerId');
    return ok(
      await listBrickOrders({
        scope: scopeFromRequest(user, request),
        branchIds: [branch.id],
        search: search.get('search') ?? undefined,
        status: search.get('status') ?? undefined,
        customerId: customerId ? toInt(customerId, 0) || undefined : undefined,
        from: search.get('from') ?? undefined,
        to: search.get('to') ?? undefined,
        includeCancelled: toBool(search.get('includeCancelled'), false),
        page,
        limit,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

/** POST — nouvelle commande de la filiale dans le magasin actif (brouillon ou confirmée). */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.create', { write: true });
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const detail = await createBrickOrder({
      storeId,
      branch,
      customerId: body.customerId ? toInt(body.customerId, 0) : null,
      customerName: body.customerName ?? null,
      date: body.date,
      dueDate: body.dueDate ?? null,
      promisedDate: body.promisedDate ?? null,
      discount: Number(body.discount ?? 0) || 0,
      notes: body.notes ?? null,
      status: isBrickOrderStatus(body.status) && body.status === 'confirmed' ? 'confirmed' : 'draft',
      items: readItems(body),
      userId: user.id,
    });
    await writeAudit({
      user,
      action: 'create',
      entity: 'brick_order',
      entityId: detail.order.id,
      details: { branch: branch.name, orderNumber: detail.order.orderNumber, customer: detail.order.customerName, total: detail.order.total },
    });
    return ok(detail, 201);
  } catch (error) {
    return fail(error);
  }
}
