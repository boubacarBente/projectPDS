import { NextRequest } from 'next/server';
import { fail, ok, readJson, toNumber, requireAction } from '@/lib/api';
import { closeSession, getCashSummary, getOpenSession, listCashSessions, openSession } from '@/lib/caisse';
import { writeAudit } from '@/lib/audit';

/**
 * GET  /api/caisse/sessions — session ouverte + historique + résumé.
 * POST /api/caisse/sessions — ouverture (`{ openingAmount, notes }`).
 * PUT  /api/caisse/sessions — clôture, **comptage par moyen de paiement** :
 *   `{ sessionId, counted: { "Espèces": 23000000, "Mobile Money": … }, notes }`.
 *   `countedAmount` (comptage global) reste accepté pour les appels existants.
 */
export async function GET() {
  try {
    await requireAction('cash.view');

    const [session, history, summary] = await Promise.all([
      getOpenSession(),
      listCashSessions({ limit: 30 }),
      getCashSummary(),
    ]);

    return ok({ session, history, summary });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('cash.open');
    const body = await readJson<any>(request);

    const session = await openSession({
      openingAmount: toNumber(body.openingAmount, 0),
      userId: user.id,
      notes: body.notes ?? null,
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'cash_session',
      entityId: session.id,
      details: { openingAmount: session.openingAmount },
    });

    return ok(session, 201);
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await requireAction('cash.close');
    const body = await readJson<any>(request);

    /*
     * Comptage **par moyen** : on ne compte pas un tiroir avec l'argent d'un
     * téléphone. Chaque moyen présent dans la session reçoit son montant compté.
     */
    const countedByMethod =
      body?.counted && typeof body.counted === 'object' && !Array.isArray(body.counted)
        ? Object.fromEntries(
            Object.entries(body.counted as Record<string, unknown>).map(([method, value]) => [
              method,
              toNumber(value, 0),
            ]),
          )
        : null;

    const session = await closeSession({
      sessionId: toNumber(body.sessionId),
      countedByMethod,
      countedAmount: toNumber(body.countedAmount, 0),
      userId: user.id,
      notes: body.notes ?? null,
    });

    await writeAudit({
      user,
      action: 'update',
      entity: 'cash_session',
      entityId: session.id,
      details: {
        theoreticalAmount: session.theoreticalAmount,
        countedAmount: session.countedAmount,
        difference: session.difference,
        // Détail par moyen : conservé ici de façon structurée (et lisible dans la
        // note de la session), en attendant une table dédiée.
        counts: session.counts,
      },
    });

    return ok(session);
  } catch (error) {
    return fail(error);
  }
}
