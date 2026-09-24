import { NextRequest } from 'next/server';
import { fail, ok, parseId, readJson, requireAction, ValidationError } from '@/lib/api';
import { isQuoteStatus, updateQuoteStatus } from '@/lib/jobs';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/**
 * PUT /api/chantiers/[id]/devis — statut du devis
 * (`draft` → `sent` → `accepted` / `refused`).
 *
 * Le devis n'est **pas** une table séparée (§6.6) : il vit dans `service_jobs`
 * (`quote_*` + `quote_status`). Cette route ne touche donc que le statut ;
 * les montants passent par `PUT /api/chantiers/[id]`.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const { id } = await params;
    const jobId = parseId(id);
    const body = await readJson<any>(request);

    if (!isQuoteStatus(body.quoteStatus)) {
      throw new ValidationError('Statut de devis invalide (draft, sent, accepted ou refused)');
    }

    const job = await updateQuoteStatus(jobId, body.quoteStatus);

    await writeAudit({
      user,
      action: 'update',
      entity: 'service_job',
      entityId: jobId,
      details: { reference: job.reference, quoteStatus: job.quoteStatus, status: job.status },
    });

    return ok(job);
  } catch (error) {
    return fail(error);
  }
}
