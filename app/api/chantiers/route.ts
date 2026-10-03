import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  requireAction,
  requireActiveStore,
  scopeFromRequest,
  toBool,
  toNumber,
} from '@/lib/api';
import { createServiceJob, getJobsSummary, isJobStatus, listServiceJobs } from '@/lib/jobs';
import { canViewSalesProfit } from '@/lib/sales';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/chantiers — liste paginée des chantiers (README §19).
 *
 * Filtres : `search`, `category`, `status` (`open` = non clos), `late=1`,
 * `customerId`, `from`, `to`, `page`, `limit`.
 *
 * `?stats=1` renvoie la synthèse (`getJobsSummary`) au lieu de la liste. Les
 * coûts et la marge n'y figurent que pour qui détient `balances.view`
 * (invariant n° 13 : masquer une carte ne protège rien).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('jobs.view');

    const params = request.nextUrl.searchParams;
    const scope = scopeFromRequest(user, request);

    if (params.get('stats') === '1' || params.get('stats') === 'true') {
      const summary = await getJobsSummary({
        scope,
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
        category: params.get('category') ?? undefined,
      });
      const canSeeCosts = await canViewSalesProfit(user);
      return ok({
        summary: canSeeCosts
          ? summary
          : {
              ...summary,
              materialsCost: null,
              laborCost: null,
              subcontractCost: null,
              expensesCost: null,
              totalCost: null,
              margin: null,
              marginPercent: null,
            },
      });
    }

    const { page, limit } = parsePagination(params);

    const result = await listServiceJobs({
      scope,
      search: params.get('search')?.trim() || undefined,
      category: params.get('category') ?? undefined,
      status: params.get('status') ?? undefined,
      quoteStatus: params.get('quoteStatus') ?? undefined,
      late: toBool(params.get('late'), false),
      customerId: toNumber(params.get('customerId'), 0) || undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      page,
      limit,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/chantiers — ouverture d'un chantier **dans le magasin actif**
 * (sans devis préalable). `items` = lignes de prestations du catalogue du
 * magasin ; sans ligne, `amount` est le montant contractuel.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('jobs.create');
    const body = await readJson<any>(request);

    const storeId = await requireActiveStore(user);
    const job = await createServiceJob({
      storeId,
      customerId: toNumber(body.customerId, 0),
      category: typeof body.category === 'string' ? body.category : undefined,
      title: body.title ?? null,
      siteAddress: body.siteAddress ?? null,
      description: body.description ?? null,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      actualStartDate: body.actualStartDate ?? null,
      status: isJobStatus(body.status) ? body.status : undefined,
      amount: body.amount === undefined || body.amount === null || body.amount === '' ? null : toNumber(body.amount, 0),
      progress: body.progress ?? null,
      responsibleUserId: body.responsibleUserId ? toNumber(body.responsibleUserId, 0) : null,
      notes: body.notes ?? null,
      userId: user.id,
      items: Array.isArray(body.items)
        ? body.items.map((item: any) => ({
            serviceId: toNumber(item.serviceId, 0),
            quantity: toNumber(item.quantity, 0),
            unitPrice: item.unitPrice === undefined || item.unitPrice === '' ? null : toNumber(item.unitPrice, 0),
            discountPercent: toNumber(item.discountPercent, 0),
          }))
        : [],
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'service_job',
      entityId: job.id,
      details: {
        reference: job.reference,
        customer: job.customerName,
        category: job.category,
        siteAddress: job.siteAddress,
        total: job.total,
        lines: job.itemsCount,
      },
    });

    return ok(job, 201);
  } catch (error) {
    return fail(error);
  }
}
