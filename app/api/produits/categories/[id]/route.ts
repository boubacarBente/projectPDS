import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  toBool,
  NotFoundError,
} from '@/lib/api';
import {
  deactivateCategory,
  getCategory,
  reactivateCategory,
  updateCategory,
} from '@/lib/products';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/produits/categories/[id] — une catégorie et ses compteurs de produits. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireAction('products.view');
    const { id } = await params;

    const category = await getCategory(parseId(id));
    if (!category) throw new NotFoundError('Catégorie introuvable');

    return ok(category);
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/produits/categories/[id] — renommage, changement de type, réactivation. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('products.update');
    const { id } = await params;
    const categoryId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    // La validation du type appartient à `lib/products.ts` (message unique).
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.description !== undefined) patch.description = body.description;
    if (body.isActive !== undefined) patch.isActive = toBool(body.isActive, true);

    const category = await updateCategory(categoryId, patch as any);

    await writeAudit({
      user,
      action: 'update',
      entity: 'category',
      entityId: categoryId,
      details: { ...patch, productCount: category.productCount },
    });

    return ok(category);
  } catch (error) {
    return fail(error);
  }
}

/**
 * DELETE /api/produits/categories/[id] — **désactivation**.
 *
 * Refusée tant que la catégorie contient des produits actifs (409) : le message
 * d'erreur explique quoi faire. `?reactivate=true` la remet en service — un
 * `DELETE` physique ferait ressusciter la ligne au prochain pull (§26.13).
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('products.delete');
    const { id } = await params;
    const categoryId = parseId(id);

    const reactivate = request.nextUrl.searchParams.get('reactivate') === 'true';

    if (reactivate) {
      await reactivateCategory(categoryId);
    } else {
      await deactivateCategory(categoryId);
    }

    await writeAudit({
      user,
      action: reactivate ? 'update' : 'delete',
      entity: 'category',
      entityId: categoryId,
      details: { reactivated: reactivate },
    });

    return ok({ success: true, deactivated: !reactivate });
  } catch (error) {
    return fail(error);
  }
}
