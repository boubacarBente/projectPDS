import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  required,
  toBool,
  requireAction,
} from '@/lib/api';
import { createSupplier, listSuppliers } from '@/lib/suppliers';
import { writeAudit } from '@/lib/audit';
import { parseListSort } from '@/lib/list-sort';

/** GET /api/fournisseurs — liste paginée, filtrable, avec dettes calculées. */
export async function GET(request: NextRequest) {
  try {
    await requireAction('suppliers.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const result = await listSuppliers({
      search: params.get('search') ?? undefined,
      page,
      limit,
      debtorsOnly: toBool(params.get('debtors'), false),
      includeInactive: toBool(params.get('includeInactive'), false),
      inactiveOnly: toBool(params.get('inactive'), false),
      // `recent` par défaut : le dernier fournisseur enregistré en premier.
      sort: parseListSort(params.get('sort')),
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/fournisseurs */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('suppliers.create');
    const body = await readJson<any>(request);

    const supplier = await createSupplier({
      name: required(body.name, 'Nom'),
      phone: body.phone ?? null,
      address: body.address ?? null,
      notes: body.notes ?? null,
      isActive: toBool(body.isActive, true),
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'supplier',
      entityId: supplier.id,
      details: { name: supplier.name },
    });

    return ok(supplier, 201);
  } catch (error) {
    return fail(error);
  }
}
