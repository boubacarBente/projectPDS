import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, readJson, required, toBool, toNumber, requireAction } from '@/lib/api';
import { createCustomer, listCustomers } from '@/lib/customers';
import { writeAudit } from '@/lib/audit';

/** GET /api/clients — liste paginée, filtrable, avec soldes calculés. */
export async function GET(request: NextRequest) {
  try {
    await requireAction('customers.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const result = await listCustomers({
      search: params.get('search') ?? undefined,
      page,
      limit,
      debtorsOnly: toBool(params.get('debtors'), false),
      includeInactive: toBool(params.get('includeInactive'), false),
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
    const body = await readJson<any>(request);

    const customer = await createCustomer({
      name: required(body.name, 'Nom'),
      phone: body.phone ?? null,
      address: body.address ?? null,
      notes: body.notes ?? null,
      creditLimit: toNumber(body.creditLimit, 0),
      isActive: toBool(body.isActive, true),
    });

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
