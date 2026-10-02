import { NextRequest } from 'next/server';
import { fail, ok, parsePagination, requireAction, scopeFromRequest, toInt } from '@/lib/api';
import { listAuditLogs } from '@/lib/audit';

/**
 * GET /api/audit — journal des actions, paginé et filtrable (README §27.2).
 *
 * `?page=&limit=&userId=&action=&entity=&from=&to=&search=&store=&central=`
 *
 * `central=false` exclut les actions sans magasin (comptes, paramètres…) : la
 * fiche d'un magasin n'affiche ainsi que l'activité de ce magasin.
 *
 * La logique vit déjà entièrement dans `listAuditLogs` de `lib/audit.ts`
 * (pagination, bornes de période incluses, recherche sur l'utilisateur,
 * l'entité et le détail) : cette route ne fait que parser et déléguer, comme
 * l'exige la règle « pas de requête Drizzle dans un Route Handler ».
 *
 * Permission : `audit.view` (administrateur et gérant, README §17.2).
 * La lecture du journal est un **audit** : elle n'est elle-même pas journalisée,
 * sinon consulter l'historique noierait l'historique.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAction('audit.view');

    const params = request.nextUrl.searchParams;
    const { page, limit } = parsePagination(params);

    const userId = toInt(params.get('userId') ?? '', 0);
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';

    const result = await listAuditLogs({
      // `?store=all|<id>` ; les actions centrales (sans magasin) ne sont visibles
      // que d'un compte multi-magasins.
      storeIds: scopeFromRequest(user, request),
      includeCentral: user.allStores && params.get('central') !== 'false',
      page,
      limit,
      userId: userId > 0 ? userId : undefined,
      action: params.get('action') || undefined,
      entity: params.get('entity') || undefined,
      from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : undefined,
      to: /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : undefined,
      search: params.get('search')?.trim() || undefined,
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
