import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, required, toBool, toNumber, requireAction, requireActiveStore, scopeFromRequest } from '@/lib/api';
import { createCustomer, listCustomers } from '@/lib/customers';
import { writeAudit } from '@/lib/audit';
import { parseListSort } from '@/lib/list-sort';

/** GET /api/clients — liste paginée, filtrable, avec soldes calculés. */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('customers.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const result = await listCustomers({
      scope: scopeFromRequest(user, request),
      search: params.get('search') ?? undefined,
      page,
      limit,
      debtorsOnly: toBool(params.get('debtors'), false),
      includeInactive: toBool(params.get('includeInactive'), false),
      // `recent` par défaut : le dernier client enregistré en premier.
      sort: parseListSort(params.get('sort')),
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/clients */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('customers.create');
    // Le client appartient au magasin actif de la session (README §28.5).
    const storeId = await requireActiveStore(user);
    const body = await readJson<any>(request);

    const customer = await createCustomer({
      name: required(body.name, 'Nom'),
      phone: body.phone ?? null,
      address: body.address ?? null,
      notes: body.notes ?? null,
      creditLimit: toNumber(body.creditLimit, 0),
      isActive: toBool(body.isActive, true),
    }, storeId);

    await writeAudit({
      user,
      action: 'create',
      entity: 'customer',
      entityId: customer.id,
      details: { name: customer.name },
    });

    return ok(customer, 201);
  } catch (error) {
    return fail(error);
  }
}
