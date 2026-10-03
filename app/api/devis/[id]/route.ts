import { NextRequest } from 'next/server';
import {
  assertStoreVisible,
  fail,
  NotFoundError,
  ok,
  parseId,
  readJson,
  requireAction,
  requireActiveStore,
  toNumber,
} from '@/lib/api';
import { cancelQuote, getQuote, parseQuoteItems, updateQuote } from '@/lib/quotes';
import { getStoreLetterhead } from '@/lib/stores';
import { writeAudit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

/** GET /api/devis/[id] — devis et ses lignes, avec l'en-tête du magasin émetteur. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.view');
    const { id } = await params;
    const detail = await getQuote(parseId(id));
    if (!detail) throw new NotFoundError('Devis introuvable');
    assertStoreVisible(user, detail.quote.storeId);
    return ok({ ...detail, store: await getStoreLetterhead(detail.quote.storeId) });
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/devis/[id] — modification d'un devis en brouillon ou envoyé. */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.update');
    const storeId = await requireActiveStore(user);
    const { id } = await params;
    const quoteId = parseId(id);
    const body = await readJson<any>(request);

    const patch: Record<string, unknown> = {};
    if (body.customerId !== undefined) patch.customerId = toNumber(body.customerId, 0);
    for (const key of ['date', 'validUntil', 'category', 'title', 'siteAddress', 'description', 'notes'] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.items !== undefined) patch.items = parseQuoteItems(body.items);

    const quote = await updateQuote(quoteId, patch as any, storeId);
    await writeAudit({
      user,
      action: 'update',
      entity: 'quote',
      entityId: quoteId,
      details: { reference: quote.reference, total: quote.total, fields: Object.keys(patch) },
    });
    return ok(quote);
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/devis/[id] — **annulation motivée** `{ reason }`, jamais de suppression. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('jobs.delete');
    await requireActiveStore(user);
    const { id } = await params;
    const quoteId = parseId(id);
    const body = await readJson<any>(request).catch(() => ({}) as any);
    const quote = await cancelQuote(quoteId, String(body?.reason ?? ''), user);
    await writeAudit({
      user,
      action: 'cancel',
      entity: 'quote',
      entityId: quoteId,
      details: { reference: quote.reference, reason: quote.cancelReason },
    });
    return ok(quote);
  } catch (error) {
    return fail(error);
  }
}
