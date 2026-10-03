import { NextRequest } from 'next/server';
import {
  assertStoreVisible,
  fail,
  NotFoundError,
  ok,
  parseId,
  readJson,
  requireAction,
  requireActiveStore,
  toNumber,
} from '@/lib/api';
import { getServiceDetail, updateService } from '@/lib/services';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/prestations/[id] — fiche : prix, historique des prix, chantiers. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.view');
    const { id } = await params;
    const detail = await getServiceDetail(parseId(id));
    if (!detail) throw new NotFoundError('Prestation introuvable');
    // Un gérant du magasin A ne lit pas le catalogue du magasin B (cahier §19).
    assertStoreVisible(user, detail.service.storeId);
    return ok(detail);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/prestations/[id] — modification (depuis le magasin de la prestation). */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('services.manage');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    for (const key of ['code', 'name', 'category', 'description', 'unit'] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.unitPrice !== undefined) patch.unitPrice = toNumber(body.unitPrice, 0);

    const { service, changes } = await updateService(parseId(id), patch, {
      storeId,
      userId: user.id,
      userName: user.name,
    });

    if (Object.keys(changes).length > 0) {
      await writeAudit({
        user,
        action: 'update',
        entity: 'service',
        entityId: service.id,
        details: { code: service.code, name: service.name, changes },
      });
    }
    return ok(service);
  } catch (error) {
    return fail(error);
  }
}
