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
  ValidationError,
} from '@/lib/api';
import { addJobMaterial, getServiceJobRow, listJobMaterials, removeJobMaterial } from '@/lib/jobs';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/chantiers/[id]/materiaux — lignes de matériaux du chantier. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.view');
    const { id } = await params;
    // Cloisonnement : pas de lecture des matériaux d'un chantier d'un autre magasin.
    const job = await getServiceJobRow(parseId(id));
    if (!job) throw new NotFoundError('Chantier introuvable');
    assertStoreVisible(user, job.storeId);

    return ok({ data: await listJobMaterials(parseId(id)) });
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/chantiers/[id]/materiaux — ajout d'un matériau.
 *
 * La déduction de stock (`exit`, `reference_type = 'service_job'`) est faite
 * par `lib/jobs.ts` via le moteur de stock ; un stock insuffisant remonte en
 * 400 avec un message lisible.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const { id } = await params;
    const jobId = parseId(id);
    const body = await readJson<any>(request);

    const storeId = await requireActiveStore(user);
    const material = await addJobMaterial(jobId, {
      storeId,
      productId: toNumber(body.productId, 0),
      quantity: toNumber(body.quantity, 0),
      unitCost: body.unitCost === undefined || body.unitCost === null ? null : toNumber(body.unitCost, 0),
      userId: user.id,
    });

    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: {
        addedMaterial: material.productName,
        quantity: material.quantity,
        unitCost: material.unitCost,
        amount: material.amount,
      },
    });

    return ok(material, 201);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/chantiers/[id]/materiaux?materialId=12 — retrait d'une ligne.
 *
 * C'est une **suppression physique assumée** (la seule du module) : corriger
 * une saisie erronée doit rendre la matière au magasin. Le stock est
 * ré-incrémenté par un mouvement `entry` motivé, et l'opération est tracée.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const { id } = await params;
    const jobId = parseId(id);

    const body = await readJson<any>(request).catch(() => ({}) as any);
    const materialId =
      toNumber(body?.materialId, 0) || toNumber(request.nextUrl.searchParams.get('materialId'), 0);

    if (!materialId) throw new ValidationError('La ligne de matériau à retirer est obligatoire');

    const storeId = await requireActiveStore(user);
    const job = await removeJobMaterial(jobId, materialId, storeId);

    await writeAudit({
      user,
      action: 'delete',
      entity: 'service_job',
      entityId: jobId,
      details: {
        removedMaterialId: materialId,
        reference: job.reference,
        stockReturned: true,
        note: 'Correction de saisie : la matière est rendue au stock par un mouvement « entry ».',
      },
    });

    return ok(job);
  } catch (error) {
    return fail(error);
  }
}
