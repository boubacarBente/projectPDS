import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  paginated,
  readJson,
  required,
  requireAction,
  toBool,
} from '@/lib/api';
import { createCategory, listCategories } from '@/lib/products';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/produits/categories — catégories du catalogue (README §27.2).
 * `?includeInactive=true` renvoie aussi les catégories désactivées.
 *
 * La réponse respecte l'enveloppe paginée imposée à **toutes** les listes :
 * `{ data, total, page, limit, totalPages }`.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('products.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const all = await listCategories({ includeInactive: toBool(params.get('includeInactive'), false) });

    const start = (page - 1) * limit;
    const data = all.slice(start, start + limit);

    return ok(paginated(data, all.length, page, limit));
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/produits/categories — création.
 * Le **type** (`finished` | `raw_material` | `service`) appartient à la
 * catégorie, pas au produit : c'est le seul endroit à paramétrer.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('products.create');
    const body = await readJson<any>(request);

    const category = await createCategory({
      name: required(body.name, 'Nom'),
      // La validation du type appartient à `lib/products.ts` (message unique).
      kind: body.kind ?? 'finished',
      description: body.description ?? null,
      isActive: toBool(body.isActive, true),
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'category',
      entityId: category.id,
      details: { name: category.name, kind: category.kind },
    });

    return ok(category, 201);
  } catch (error) {
    return fail(error);
  }
}
