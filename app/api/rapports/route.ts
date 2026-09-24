import { NextRequest } from 'next/server';
import {
  ValidationError,
  businessDate,
  fail,
  ok,
  requireAction,
  toInt,
} from '@/lib/api';
import { can } from '@/lib/permissions';
import { today } from '@/lib/format';
import { getRapportData } from '@/lib/rapports';

/**
 * GET /api/rapports (README §27.2).
 *
 * `?from=&to=&previousFrom=&previousTo=&productId=&customerId=&supplierId=&paymentStatus=`
 * → `{ report: RapportData }`. Permission **`reports.view`**.
 *
 * Handler **mince** (CONVENTIONS §3) : permission → parsing → fonction de
 * `lib/` → réponse. Aucune requête Drizzle ici.
 *
 * ── Restriction de période pour un vendeur ────────────────────────────────
 * Un utilisateur qui n'a pas `reports.viewAll` (le rôle `seller` a
 * `reports.view` mais pas `reports.viewAll`, `lib/permissions.ts`) ne peut
 * consulter que le **rapport du jour**. On **refuse** explicitement
 * (`ValidationError`, 400, message en français) toute autre période plutôt que
 * de la ramener silencieusement à aujourd'hui : renvoyer des chiffres d'un
 * autre jour que celui demandé serait un mensonge à l'écran. La page verrouille
 * d'ailleurs le sélecteur de période pour ces rôles, ce refus est donc un
 * filet de sécurité serveur — masquer n'est pas protéger (§9 des CONVENTIONS).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('reports.view');

    const params = request.nextUrl.searchParams;
    const reference = today();

    const from = businessDate(params.get('from'), 'date de début', reference);
    const to = businessDate(params.get('to'), 'date de fin', reference);

    if (from > to) {
      throw new ValidationError('La date de début doit précéder la date de fin');
    }

    if (!can(user, 'reports.viewAll') && (from !== reference || to !== reference)) {
      throw new ValidationError(
        "Votre rôle ne permet de consulter que le rapport du jour. Sélectionnez la période « Aujourd'hui », ou demandez la permission « Voir tous les rapports ».",
      );
    }

    const previousFrom = params.get('previousFrom');
    const previousTo = params.get('previousTo');

    const productId = toInt(params.get('productId'), 0);
    const customerId = toInt(params.get('customerId'), 0);
    const supplierId = toInt(params.get('supplierId'), 0);
    const paymentStatus = params.get('paymentStatus');

    const report = await getRapportData({
      from,
      to,
      previousFrom: previousFrom ? businessDate(previousFrom, 'date de début de comparaison') : null,
      previousTo: previousTo ? businessDate(previousTo, 'date de fin de comparaison') : null,
      productId: productId > 0 ? productId : null,
      customerId: customerId > 0 ? customerId : null,
      supplierId: supplierId > 0 ? supplierId : null,
      paymentStatus: paymentStatus && paymentStatus.trim() ? paymentStatus.trim() : null,
    });

    return ok({ report });
  } catch (error) {
    return fail(error);
  }
}
