import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, requireAction, scopeFromRequest } from '@/lib/api';
import { getInventory, listInventories, openInventory } from '@/lib/inventories';

/**
 * GET /api/inventaires — inventaires physiques, du plus récent au plus ancien.
 * `?store=all|<id>` (défaut : magasin actif), `?status=open|validated|cancelled|all`.
 * Permission : `inventory.view`.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('inventory.view');
    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);
    return ok(
      await listInventories({
        scope: scopeFromRequest(user, request),
        status: params.get('status') ?? undefined,
        page,
        limit,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/inventaires — ouvre un inventaire dans le **magasin actif**.
 * Corps : `{ categoryId?, notes? }` (sans catégorie = tous les produits actifs).
 * Un seul inventaire ouvert à la fois par magasin.
 * Permission : `inventory.manage`.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('inventory.manage');
    const body = await readJson<any>(request);
    const id = await openInventory(
      { categoryId: body.categoryId ? Number(body.categoryId) : null, notes: body.notes ?? null },
      user,
    );
    return ok(await getInventory(id), 201);
  } catch (error) {
    return fail(error);
  }
}
