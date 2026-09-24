import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  toBool,
  requireAction,
  NotFoundError,
} from '@/lib/api';
import {
  deactivateSupplier,
  getSupplier,
  getSupplierStats,
  reactivateSupplier,
  updateSupplier,
} from '@/lib/suppliers';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/fournisseurs/[id] — fiche + statistiques + derniers achats. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('suppliers.view');
    const { id } = await params;

    const stats = await getSupplierStats(parseId(id));
    if (!stats) throw new NotFoundError('Fournisseur introuvable');

    return ok(stats);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/fournisseurs/[id] */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('suppliers.update');
    const { id } = await params;
    const supplierId = parseId(id);

    // Vérification explicite : la fonction de `lib/` suit le patron de
    // `updateCustomer`, qui ne distingue pas « introuvable » (404) d'une erreur
    // serveur. C'est donc à la route de rendre un 404 lisible.
    const existing = await getSupplier(supplierId);
    if (!existing) throw new NotFoundError('Fournisseur introuvable');

    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.address !== undefined) patch.address = body.address;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);

    const supplier = await updateSupplier(supplierId, patch as any);

    await writeAudit({
      user,
      action: 'update',
      entity: 'supplier',
      entityId: supplierId,
      details: patch,
    });

    return ok(supplier);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/fournisseurs/[id] — **désactivation**, jamais de suppression
 * physique (README §26.13).
 *
 * Une facture d'achat ancienne doit rester rattachée à son fournisseur, et une
 * suppression réelle ferait ressusciter la ligne au prochain pull de
 * synchronisation. `?reactivate=true` réactive la fiche.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('suppliers.delete');
    const { id } = await params;
    const supplierId = parseId(id);

    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';

    if (reactivate) {
      await reactivateSupplier(supplierId);
    } else {
      await deactivateSupplier(supplierId);
    }

    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'supplier',
      entityId: supplierId,
      details: { reactivated: reactivate },
    });

    return ok({ success: true, deactivated: !reactivate });
  } catch (error) {
    return fail(error);
  }
}
