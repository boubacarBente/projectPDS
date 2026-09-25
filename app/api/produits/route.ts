import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  required,
  requireAction,
  toBool,
  toNumber,
} from '@/lib/api';
import { createProduct, isCategoryKind, listProducts } from '@/lib/products';
import { writeAudit } from '@/lib/audit';
import { parseListSort } from '@/lib/list-sort';

/**
 * GET /api/produits — liste paginée du catalogue (README §27.2).
 * Filtres : `search`, `categoryId`, `kind`, `lowStock`, `outOfStock`, `includeInactive`.
 * Tri : `?sort=recent` (défaut, dernier produit enregistré) ou `?sort=name`.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('products.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const rawKind = params.get('kind');
    const categoryId = toNumber(params.get('categoryId') ?? params.get('category'), 0);

    const result = await listProducts({
      search: params.get('search')?.trim() || undefined,
      categoryId: categoryId > 0 ? categoryId : undefined,
      kind: isCategoryKind(rawKind) ? rawKind : undefined,
      lowStockOnly: toBool(params.get('lowStock'), false),
      outOfStockOnly: toBool(params.get('outOfStock'), false),
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

/** POST /api/produits — création ; le nom est l'identifiant du produit. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('products.create');
    const body = await readJson<any>(request);

    const categoryId = toNumber(body.categoryId, 0);

    const product = await createProduct(
      {
        name: required(body.name, 'Nom'),
        categoryId: categoryId > 0 ? categoryId : null,
        unit: body.unit ?? null,
        purchasePrice: toNumber(body.purchasePrice, 0),
        salePrice: toNumber(body.salePrice, 0),
        stock: toNumber(body.stock, 0),
        stockMin: toNumber(body.stockMin, 0),
        description: body.description ?? null,
        isActive: toBool(body.isActive, true),
      },
      { userId: user.id },
    );

    await writeAudit({
      user,
      action: 'create',
      entity: 'product',
      entityId: product.id,
      details: {
        name: product.name,
        unit: product.unit,
        categoryId: product.categoryId,
        purchasePrice: product.purchasePrice,
        salePrice: product.salePrice,
        stock: product.stock,
      },
    });

    return ok(product, 201);
  } catch (error) {
    return fail(error);
  }
}
