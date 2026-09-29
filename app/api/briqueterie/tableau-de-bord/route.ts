import { NextRequest } from 'next/server';
import { fail, ok, requireAction } from '@/lib/api';
import { getBrickDashboard } from '@/lib/brick-analytics';
import { today } from '@/lib/format';

/**
 * GET /api/briqueterie/tableau-de-bord — tout le tableau de bord en une requête.
 *
 * Pourquoi une seule route plutôt que six : l'écran affiche une douzaine
 * d'indicateurs issus des mêmes tables. Six appels concurrents sur SQLite
 * local se marcheraient dessus pour rien ; un seul aller-retour garantit aussi
 * que tous les chiffres affichés appartiennent au **même instant**.
 *
 * `?date=AAAA-MM-JJ` permet de consulter le tableau de bord d'un autre jour
 * (bornes « aujourd'hui / semaine / mois / année » relatives à cette date).
 *
 * Aucun total n'est stocké : tout est agrégé à la lecture (§6.5 règle 6).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('brick.view');

    const reference = request.nextUrl.searchParams.get('date');
    const dashboard = await getBrickDashboard(
      reference && /^\d{4}-\d{2}-\d{2}$/.test(reference) ? reference : today(),
    );

    return ok(dashboard);
  } catch (error) {
    return fail(error);
  }
}
