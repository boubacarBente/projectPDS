import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireActiveStore, scopeFromRequest, toNumber } from '@/lib/api';
import {
  createBrickProduction,
  getBrickSummary,
  hideProductionCosts,
  isBrickProductionStatus,
  listBrickProductions,
} from '@/lib/brick';
import { requireBranch } from '@/lib/branches';
import { canViewSalesProfit } from '@/lib/sales';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ branchId: string }> };

/**
 * GET /api/filiales/[branchId]/productions — productions de la filiale dans la
 * portée (README §31). `?stats=1` : synthèse fabriquées / perdues / vendues.
 * Coûts `null` sans `balances.view` (invariant 13).
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.view');
    const search = request.nextUrl.searchParams;
    const scope = scopeFromRequest(user, request);
    const withCosts = await canViewSalesProfit(user);

    if (search.get('stats') === '1' || search.get('stats') === 'true') {
      const summary = await getBrickSummary({
        scope,
        branchIds: [branch.id],
        from: search.get('from') ?? undefined,
        to: search.get('to') ?? undefined,
      });
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

    const { page, limit } = parsePagination(search);
    const status = search.get('status');
    const stage = search.get('stage');
    const result = await listBrickProductions({
      scope,
      branchIds: [branch.id],
      search: search.get('search')?.trim() || undefined,
      brickTypeId: toNumber(search.get('brickTypeId'), 0) || undefined,
      stage: stage && branch.flow.some((s) => s.key === stage) ? stage : undefined,
      status: isBrickProductionStatus(status) ? status : undefined,
      from: search.get('from') ?? undefined,
      to: search.get('to') ?? undefined,
      page,
      limit,
    });
    return ok(withCosts ? result : { ...result, data: result.data.map(hideProductionCosts) });
  } catch (error) {
    return fail(error);
  }
}

/** POST — lancement d'une production de la filiale dans le magasin actif. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { user, branch } = await requireBranch((await params).branchId, 'brick.create', { write: true });
    const body = await readJson<any>(request);
    const storeId = await requireActiveStore(user);
    const production = await createBrickProduction({
      storeId,
      branch,
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
      details: { branch: branch.name, batchNumber: production.batchNumber, model: production.brickTypeName, planned: production.plannedQuantity },
    });
    return ok(production, 201);
  } catch (error) {
    return fail(error);
  }
}
