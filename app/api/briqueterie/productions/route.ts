import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireAction, toNumber } from '@/lib/api';
import { createBrickProduction, getBrickSummary, isBrickStage, listBrickProductions } from '@/lib/brick';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/briqueterie/productions — lots de fabrication paginés.
 *
 * Filtres : `search`, `brickTypeId`, `stage`, `from`, `to`, `page`, `limit`.
 * `?stats=1` renvoie le rapport fabriquées / cassées / vendues de la période
 * (les cartes de la page ne se déduisent pas de la page courante).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('brick.view');

    const params = request.nextUrl.searchParams;

    if (params.get('stats') === '1' || params.get('stats') === 'true') {
      const summary = await getBrickSummary({
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
      });
      return ok({ summary });
    }

    const { page, limit } = parsePagination(params);

    const result = await listBrickProductions({
      search: params.get('search')?.trim() || undefined,
      brickTypeId: toNumber(params.get('brickTypeId'), 0) || undefined,
      stage: isBrickStage(params.get('stage')) ? (params.get('stage') as string) : undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      page,
      limit,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/briqueterie/productions — lancement d'une fabrication (`BRI-…`). */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('brick.create');
    const body = await readJson<any>(request);

    const production = await createBrickProduction({
      brickTypeId: toNumber(body.brickTypeId, 0),
      plannedQuantity: toNumber(body.plannedQuantity, 0),
      producedQuantity: toNumber(body.producedQuantity, 0),
      brokenQuantity: toNumber(body.brokenQuantity, 0),
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      notes: body.notes ?? null,
      userId: user.id,
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'brick_production',
      entityId: production.id,
      details: {
        batchNumber: production.batchNumber,
        brickType: production.brickTypeName,
        plannedQuantity: production.plannedQuantity,
        stage: production.stage,
      },
    });

    return ok(production, 201);
  } catch (error) {
    return fail(error);
  }
}
