import { NextRequest } from 'next/server';
import { fail, ok, requireAction, ValidationError } from '@/lib/api';
import { getBrickReports } from '@/lib/brick-analytics';
import { startOfMonth, today } from '@/lib/format';

/**
 * GET /api/briqueterie/rapports?from=AAAA-MM-JJ&to=AAAA-MM-JJ
 *
 * Tout le rapport de la briqueterie en une requête (§20, point 9) : production
 * par jour et par type, dépenses par lot et dépenses générales par catégorie,
 * ventes par période / produit / client, créances, paiements encaissés, état des
 * stocks, pertes et casses, rentabilité par produit et rentabilité globale.
 *
 * Bornes **inclusives** sur la date métier (§6.5 règle 2). Par défaut : le mois
 * en cours jusqu'à aujourd'hui.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('brick.view');

    const params = request.nextUrl.searchParams;
    const todayDate = today();

    const rawFrom = params.get('from');
    const rawTo = params.get('to');

    const from = rawFrom && /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) ? rawFrom : startOfMonth(todayDate);
    const to = rawTo && /^\d{4}-\d{2}-\d{2}$/.test(rawTo) ? rawTo : todayDate;

    if (from > to) {
      throw new ValidationError('La date de début doit précéder la date de fin');
    }

    return ok(await getBrickReports(from, to));
  } catch (error) {
    return fail(error);
  }
}
