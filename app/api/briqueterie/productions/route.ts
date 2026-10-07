import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireAction, requireActiveStore, scopeFromRequest, toNumber } from '@/lib/api';
import {
  createBrickProduction,
  getBrickSummary,
  hideProductionCosts,
  isBrickProductionStatus,
  isBrickStage,
  listBrickProductions,
} from '@/lib/brick';
import { canViewSalesProfit } from '@/lib/sales';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/briqueterie/productions — lots de la portée (README §30).
 * `?stats=1` : synthèse fabriquées / cassées / vendues. Coûts `null` sans
 * `balances.view` (invariant 13).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('brick.view');
    const params = request.nextUrl.searchParams;
    const scope = scopeFromRequest(user, request);
    const withCosts = await canViewSalesProfit(user);

    if (params.get('stats') === '1' || params.get('stats') === 'true') {
      const summary = await getBrickSummary({ scope, from: params.get('from') ?? undefined, to: params.get('to') ?? undefined });
      return ok({
        summary: withCosts
          ? summary
          : {
              ...summary,
              laborCost: null,
              expensesCost: null,
              totalCost: null,
              averageUnitCost: null,
              byType: summary.byType.map((t) => ({ ...t, unitCost: null })),
            },
      });
    }

    const { page, limit } = parsePagination(params);
    const status = params.get('status');
    const result = await listBrickProductions({
      scope,
      search: params.get('search')?.trim() || undefined,
      brickTypeId: toNumber(params.get('brickTypeId'), 0) || undefined,
      stage: isBrickStage(params.get('stage')) ? (params.get('stage') as string) : undefined,
      status: isBrickProductionStatus(status) ? status : undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      page,
      limit,
    });
    return ok(withCosts ? result : { ...result, data: result.data.map(hideProductionCosts) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/briqueterie/productions — lancement d'un lot dans le magasin actif. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('brick.create');
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const production = await createBrickProduction({
      storeId,
      brickTypeId: toNumber(body.brickTypeId, 0),
      plannedQuantity: toNumber(body.plannedQuantity, 0),
      producedQuantity: toNumber(body.producedQuantity, 0),
      brokenQuantity: toNumber(body.brokenQuantity, 0),
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      team: body.team ?? null,
      notes: body.notes ?? null,
      userId: user.id,
    });
    await writeAudit({
      user,
      action: 'create',
      entity: 'brick_production',
      entityId: production.id,
      details: { batchNumber: production.batchNumber, brickType: production.brickTypeName, planned: production.plannedQuantity },
    });
    return ok(production, 201);
  } catch (error) {
    return fail(error);
  }
}
