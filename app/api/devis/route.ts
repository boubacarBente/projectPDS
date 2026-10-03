import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  requireAction,
  requireActiveStore,
  scopeFromRequest,
  toNumber,
} from '@/lib/api';
import { createQuote, getQuotesSummary, listQuotes, parseQuoteItems } from '@/lib/quotes';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/devis — devis de prestation (README §19.3).
 * Filtres : `search`, `status` (dont `expired` et `pending`), `customerId`,
 * `from`, `to`. `?stats=1` = synthèse des cartes.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('jobs.view');
    const params = request.nextUrl.searchParams;
    const scope = scopeFromRequest(user, request);

    if (params.get('stats') === '1') {
      return ok({
        summary: await getQuotesSummary(scope, params.get('from') ?? undefined, params.get('to') ?? undefined),
      });
    }

    const { page, limit } = parsePagination(params);
    return ok(
      await listQuotes({
        scope,
        search: params.get('search') ?? undefined,
        status: params.get('status') ?? undefined,
        customerId: toNumber(params.get('customerId'), 0) || undefined,
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
        page,
        limit,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/devis — nouveau devis **dans le magasin actif**. */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('jobs.create');
    const storeId = await requireActiveStore(user);
    const body = await readJson<any>(request);

    const quote = await createQuote({
      storeId,
      userId: user.id,
      customerId: toNumber(body.customerId, 0),
      requestId: body.requestId ? toNumber(body.requestId, 0) : null,
      date: body.date ?? null,
      validUntil: body.validUntil ?? null,
      category: body.category ?? null,
      title: body.title ?? null,
      siteAddress: body.siteAddress ?? null,
      description: body.description ?? null,
      notes: body.notes ?? null,
      items: parseQuoteItems(body.items),
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'quote',
      entityId: quote.id,
      details: { reference: quote.reference, customer: quote.customerName, total: quote.total, lines: quote.itemsCount },
    });
    return ok(quote, 201);
  } catch (error) {
    return fail(error);
  }
}
