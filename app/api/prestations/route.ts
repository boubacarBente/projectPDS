import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  requireAction,
  requireActiveStore,
  scopeFromRequest,
  toNumber,
} from '@/lib/api';
import { createService, getServicesSummary, listServices } from '@/lib/services';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/prestations — catalogue des prestations (README §19.1).
 *
 * Portée : magasin actif par défaut, `?store=all|<id>` borné au périmètre.
 * Filtres : `search`, `category`, `status`, `sort`, `page`, `limit`.
 * `?stats=1` renvoie la synthèse des cartes au lieu de la liste.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('jobs.view');
    const params = request.nextUrl.searchParams;
    const scope = scopeFromRequest(user, request);

    if (params.get('stats') === '1') {
      return ok({ summary: await getServicesSummary(scope) });
    }

    const { page, limit } = parsePagination(params);
    return ok(
      await listServices({
        scope,
        search: params.get('search') ?? undefined,
        category: params.get('category') ?? undefined,
        status: params.get('status') ?? undefined,
        sort: params.get('sort') ?? undefined,
        page,
        limit,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/prestations — nouvelle prestation **dans le magasin actif**. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('services.manage');
    const storeId = await requireActiveStore(user);
    const body = await readJson<any>(request);

    const service = await createService({
      storeId,
      userId: user.id,
      code: body.code ?? null,
      name: String(body.name ?? ''),
      category: String(body.category ?? ''),
      description: body.description ?? null,
      unit: body.unit ?? null,
      unitPrice: toNumber(body.unitPrice, 0),
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'service',
      entityId: service.id,
      details: { code: service.code, name: service.name, unitPrice: service.unitPrice, unit: service.unit },
    });

    return ok(service, 201);
  } catch (error) {
    return fail(error);
  }
}
