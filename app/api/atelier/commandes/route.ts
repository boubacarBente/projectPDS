import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  requireAction,
  requireActiveStore,
  scopeFromRequest,
  toBool,
  toNumber,
} from '@/lib/api';
import { createFurnitureOrder, getWorkshopSummary, hideOrderCosts, listFurnitureOrders } from '@/lib/furniture';
import { isFurnitureStage } from '@/lib/furniture-shared';
import { canViewSalesProfit } from '@/lib/sales';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/atelier/commandes — commandes de l'atelier de meubles (README §29).
 *
 * Portée : magasin actif, ou `?store=all|<id>` dans le périmètre de
 * l'utilisateur. Filtres : `search`, `stage`, `purpose`, `late=1`,
 * `customerId`, `from`, `to`, `includeCancelled`, `sort=promised`.
 * `?stats=1` renvoie la synthèse de la période. Coûts et marges : `null` sans
 * `balances.view` (invariant 13).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('furniture.view');
    const params = request.nextUrl.searchParams;
    const scope = scopeFromRequest(user, request);
    const withCosts = await canViewSalesProfit(user);

    if (params.get('stats') === '1') {
      const summary = await getWorkshopSummary({
        scope,
        from: params.get('from') || undefined,
        to: params.get('to') || undefined,
        withCosts,
      });
      return ok({ summary });
    }

    const { page, limit } = parsePagination(params);
    const stage = params.get('stage');
    const purpose = params.get('purpose');
    const result = await listFurnitureOrders({
      scope,
      search: params.get('search')?.trim() || undefined,
      stage: isFurnitureStage(stage) ? stage : undefined,
      purpose: purpose === 'stock' || purpose === 'customer' ? purpose : undefined,
      customerId: toNumber(params.get('customerId'), 0) || undefined,
      lateOnly: toBool(params.get('late'), false),
      includeCancelled: toBool(params.get('includeCancelled'), false),
      from: params.get('from') || undefined,
      to: params.get('to') || undefined,
      sort: params.get('sort') === 'promised' ? 'promised' : 'recent',
      page,
      limit,
    });
    return ok(withCosts ? result : { ...result, data: result.data.map(hideOrderCosts) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/atelier/commandes — nouvelle commande **dans le magasin actif**. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('furniture.create');
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);

    const order = await createFurnitureOrder({
      storeId,
      userId: user.id,
      purpose: body.purpose === 'stock' ? 'stock' : 'customer',
      customerId: toNumber(body.customerId, 0) || null,
      customerName: body.customerName ?? null,
      modelId: toNumber(body.modelId, 0) || null,
      modelName: body.modelName ?? null,
      isCustom: Boolean(body.isCustom),
      dimensions: body.dimensions ?? null,
      finish: body.finish ?? null,
      quantity: toNumber(body.quantity, 1),
      startDate: body.startDate ?? null,
      promisedDate: body.promisedDate ?? null,
      agreedPrice: toNumber(body.agreedPrice, 0),
      productId: toNumber(body.productId, 0) || null,
      notes: body.notes ?? null,
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'furniture_order',
      entityId: order.id,
      details: {
        orderNumber: order.orderNumber,
        purpose: order.purpose,
        customer: order.customerName,
        model: order.modelName,
        quantity: order.quantity,
        total: order.total,
      },
    });

    return ok(order, 201);
  } catch (error) {
    return fail(error);
  }
}
