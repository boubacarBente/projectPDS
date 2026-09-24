import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  requireAction,
  toBool,
  toNumber,
} from '@/lib/api';
import {
  createFurnitureOrder,
  getWorkshopSummary,
  isFurnitureStage,
  listFurnitureOrders,
} from '@/lib/furniture';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/atelier/commandes — liste paginée des commandes d'atelier (§21).
 *
 * Filtres : `search`, `stage`, `customerId`, `lateOnly`, `from`, `to`,
 * `includeCancelled`. `?summary=1` renvoie en plus la synthèse de la période
 * (`{ ...paginated, summary }`), ce qui évite un second aller-retour pour les
 * cartes de tête.
 *
 * Tri : `?sort=recent` (défaut) = dernière commande enregistrée, comme toutes
 * les listes ; `?sort=promised` = planning d'atelier (date promise la plus
 * proche d'abord).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('furniture.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const stage = params.get('stage');
    const customerId = toNumber(params.get('customerId'), 0);
    const from = params.get('from')?.slice(0, 10) || undefined;
    const to = params.get('to')?.slice(0, 10) || undefined;

    const result = await listFurnitureOrders({
      search: params.get('search')?.trim() || undefined,
      stage: isFurnitureStage(stage) ? stage : undefined,
      customerId: customerId > 0 ? customerId : undefined,
      lateOnly: toBool(params.get('lateOnly'), false),
      includeCancelled: toBool(params.get('includeCancelled'), false),
      from,
      to,
      page,
      limit,
      sort: params.get('sort') === 'promised' ? 'promised' : 'recent',
    });

    if (toBool(params.get('summary'), false)) {
      return ok({ ...result, summary: await getWorkshopSummary({ from, to }) });
    }

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/atelier/commandes — création d'une commande.
 *
 * Si `modelId` est fourni et que la commande est standard, la nomenclature du
 * modèle **préremplit les matériaux** (× la quantité) dans `lib/furniture.ts` :
 * la route reste mince et ne calcule rien elle-même (§3).
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('furniture.create');
    const body = await readJson<any>(request);

    const isCustom = toBool(body.isCustom, false);
    const customerId = toNumber(body.customerId, 0);
    const modelId = toNumber(body.modelId, 0);
    const productId = toNumber(body.productId, 0);

    const created = await createFurnitureOrder({
      customerId: customerId > 0 ? customerId : null,
      customerName: body.customerName ?? null,
      modelId: modelId > 0 ? modelId : null,
      modelName: body.modelName ?? null,
      isCustom,
      dimensions: body.dimensions ?? null,
      finish: body.finish ?? null,
      quantity: toNumber(body.quantity, 1) || 1,
      startDate: body.startDate ?? null,
      promisedDate: body.promisedDate ?? null,
      deliveryDate: body.deliveryDate ?? null,
      agreedPrice: toNumber(body.agreedPrice, 0),
      amountPaid: toNumber(body.amountPaid, 0),
      productId: productId > 0 ? productId : null,
      userId: user.id,
      notes: body.notes ?? null,
      bomQuantity: toNumber(body.bomQuantity, 0) || undefined,
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'furniture_order',
      entityId: created.order.id,
      details: {
        orderNumber: created.order.orderNumber,
        customerName: created.order.customerName,
        modelName: created.order.modelName,
        isCustom,
        quantity: created.order.quantity,
        prefilledMaterials: created.materials.length,
      },
    });

    return ok(created, 201);
  } catch (error) {
    return fail(error);
  }
}
