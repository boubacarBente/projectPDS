import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  required,
  requireAction,
  requireActiveStore,
  requireUser,
  scopeFromRequest,
  toBool,
  toNumber,
} from '@/lib/api';
import { createWorker, isWorkerRole, listWorkerTeams, listWorkers } from '@/lib/workers';
import { writeAudit } from '@/lib/audit';
import { parseListSort } from '@/lib/list-sort';

/**
 * GET /api/workers — liste paginée du référentiel de main-d'œuvre.
 *
 * Lecture ouverte à tout utilisateur authentifié : les chantiers
 * (`jobs.view`) doivent pouvoir désigner un ouvrier dans une équipe. **Seules les écritures** sont
 * gardées par `workers.manage` — masquer n'est pas protéger, mais ici la
 * lecture n'est pas une opération sensible (nom, téléphone, tarif journalier).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    /*
     * Ouvriers du magasin actif (ou des magasins demandés par `?store=`) **et**
     * ouvriers communs : un magasin ne voit pas l'équipe d'un autre (cahier §11).
     */
    const scope = scopeFromRequest(user, request);

    if (params.get('teams') === '1') return ok({ teams: await listWorkerTeams(scope) });

    const result = await listWorkers({
      scope,
      team: params.get('team') ?? undefined,
      search: params.get('search')?.trim() || undefined,
      role: params.get('role') ?? undefined,
      includeInactive: toBool(params.get('includeInactive'), false),
      page,
      limit,
      sort: parseListSort(params.get('sort'), ['recent', 'name']),
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/workers — création d'un ouvrier, toujours dans le magasin actif (README §28.5). */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('workers.manage');
    const storeId = await requireActiveStore(user);
    const body = await readJson<any>(request);

    const worker = await createWorker({
      name: required(body.name, 'Nom'),
      phone: body.phone ?? null,
      role: isWorkerRole(body.role) ? body.role : 'worker',
      specialty: body.specialty ?? null,
      dailyRate: toNumber(body.dailyRate, 0),
      isActive: toBool(body.isActive, true),
      team: body.team ?? null,
      // Chaque magasin a ses propres ouvriers : plus d'ouvrier « commun ».
      storeId,
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'worker',
      entityId: worker.id,
      details: { name: worker.name, role: worker.role, dailyRate: worker.dailyRate },
    });

    return ok(worker, 201);
  } catch (error) {
    return fail(error);
  }
}
