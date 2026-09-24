import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  required,
  requireAction,
  requireUser,
  toBool,
  toNumber,
} from '@/lib/api';
import { createWorker, isWorkerRole, listWorkers } from '@/lib/workers';
import { writeAudit } from '@/lib/audit';
import { parseListSort } from '@/lib/list-sort';

/**
 * GET /api/workers — liste paginée du référentiel de main-d'œuvre.
 *
 * Lecture ouverte à tout utilisateur authentifié : les chantiers
 * (`jobs.view`), la briqueterie (`brick.view`) et l'atelier doivent tous
 * pouvoir désigner un ouvrier dans une équipe. **Seules les écritures** sont
 * gardées par `workers.manage` — masquer n'est pas protéger, mais ici la
 * lecture n'est pas une opération sensible (nom, téléphone, tarif journalier).
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser();

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const result = await listWorkers({
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

/** POST /api/workers — création d'un ouvrier (table unique partagée). */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('workers.manage');
    const body = await readJson<any>(request);

    const worker = await createWorker({
      name: required(body.name, 'Nom'),
      phone: body.phone ?? null,
      role: isWorkerRole(body.role) ? body.role : 'worker',
      specialty: body.specialty ?? null,
      dailyRate: toNumber(body.dailyRate, 0),
      isActive: toBool(body.isActive, true),
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
