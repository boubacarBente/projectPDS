import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, requireActiveStore, toNumber } from '@/lib/api';
import { convertQuoteToJob } from '@/lib/quotes';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/devis/[id]/convertir — ouvre le chantier d'un devis **accepté**.
 * Corps facultatif : `startDate`, `endDate` (prévues), `responsibleUserId`,
 * `category`. Les lignes sont recopiées avec leurs prix figés.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.create');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const body = await readJson<any>(request).catch(() => ({}) as any);

    const { quote, job } = await convertQuoteToJob(parseId(id), {
      storeId,
      userId: user.id,
      startDate: body?.startDate || null,
      endDate: body?.endDate || null,
      responsibleUserId: body?.responsibleUserId ? toNumber(body.responsibleUserId, 0) : null,
      category: body?.category || null,
    });

    await writeAudit({
      user,
      action: 'validate',
      entity: 'quote',
      entityId: quote.id,
      details: { reference: quote.reference, convertedTo: job.reference },
    });
    await writeAudit({
      user,
      action: 'create',
      entity: 'service_job',
      entityId: job.id,
      details: { reference: job.reference, fromQuote: quote.reference, customer: job.customerName, total: job.total },
    });
    return ok({ quote, job }, 201);
  } catch (error) {
    return fail(error);
  }
}
