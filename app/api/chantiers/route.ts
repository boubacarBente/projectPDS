import { NextRequest } from 'next/server';
import {
  fail,
  ok,
  parsePagination,
  readJson,
  requireAction,
  toNumber,
} from '@/lib/api';
import {
  createServiceJob,
  getJobsSummary,
  isJobCategory,
  isJobStatus,
  isQuoteStatus,
  listServiceJobs,
} from '@/lib/jobs';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/chantiers — liste paginée des prestations (§27.2).
 *
 * Filtres : `search`, `category`, `status`, `quoteStatus`, `customerId`,
 * `from`, `to`, `page`, `limit`.
 *
 * `?stats=1` renvoie la synthèse (`getJobsSummary`) au lieu de la liste : les
 * cartes de la page `/chantiers` ne peuvent pas se déduire de la page courante,
 * et ce module n'a pas de route `/stats` dédiée.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('jobs.view');

    const params = request.nextUrl.searchParams;

    if (params.get('stats') === '1' || params.get('stats') === 'true') {
      const summary = await getJobsSummary({
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
      });
      return ok({ summary });
    }

    const { page, limit } = parsePagination(params);

    const result = await listServiceJobs({
      search: params.get('search')?.trim() || undefined,
      category: params.get('category') ?? undefined,
      status: params.get('status') ?? undefined,
      quoteStatus: params.get('quoteStatus') ?? undefined,
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

/** POST /api/chantiers — création d'un chantier (devis ou prestation directe). */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('jobs.create');
    const body = await readJson<any>(request);

    const job = await createServiceJob({
      customerId: toNumber(body.customerId, 0),
      category: isJobCategory(body.category) ? body.category : undefined,
      title: body.title ?? null,
      siteAddress: body.siteAddress ?? null,
      description: body.description ?? null,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      status: isJobStatus(body.status) ? body.status : undefined,
      quoteStatus: isQuoteStatus(body.quoteStatus) ? body.quoteStatus : undefined,
      quoteMaterials: toNumber(body.quoteMaterials, 0),
      quoteLabor: toNumber(body.quoteLabor, 0),
      notes: body.notes ?? null,
      userId: user.id,
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
        quoteTotal: job.quoteTotal,
      },
    });

    return ok(job, 201);
  } catch (error) {
    return fail(error);
  }
}
