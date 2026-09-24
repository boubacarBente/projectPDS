import { NextRequest } from 'next/server';
import {
  ValidationError,
  fail,
  ok,
  parsePagination,
  readJson,
  required,
  requireAction,
  toBool,
} from '@/lib/api';
import { createUser, getUserStats, listUsersPage } from '@/lib/users';
import { writeAudit } from '@/lib/audit';
import { isRole } from '@/lib/permissions';
import { parseListSort } from '@/lib/list-sort';

/**
 * GET /api/users — liste paginée, filtrable (README §27.2).
 *
 * Deux usages, sur la même route :
 *  - `?stats=true` → compteurs de l'en-tête de page
 *    `{ totalUsers, activeUsers, inactiveUsers, administrators, byRole }` ;
 *  - `?options=true` → liste réduite (`id`, `name`, `username`) pour alimenter
 *    un filtre « utilisateur » sans exposer le reste de la fiche ;
 *  - sinon → enveloppe paginée `{ data, total, page, limit, totalPages }`.
 *
 * Permission : `users.manage` — le README §17.2 réserve la gestion des
 * utilisateurs à l'administrateur, **y compris la lecture**.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('users.manage');

    const params = request.nextUrl.searchParams;

    if (toBool(params.get('stats'), false)) {
      return ok(await getUserStats());
    }

    const { page, limit } = parsePagination(params);
    const role = params.get('role') ?? undefined;

    if (toBool(params.get('options'), false)) {
      /*
       * Liste d'un **filtre** (§27.1 `/utilisateurs/historique`) : l'ordre
       * alphabétique est celui qu'on attend d'un menu déroulant de noms, et il
       * ne dépend pas de la règle « dernière insertion » des listes de gestion.
       */
      const all = await listUsersPage({
        includeInactive: true,
        role,
        limit: 200,
        page: 1,
        sort: parseListSort(params.get('sort'), ['recent', 'name'], 'name'),
      });
      return ok(all.data.map((user) => ({ id: user.id, name: user.name, username: user.username })));
    }

    const result = await listUsersPage({
      search: params.get('search') ?? undefined,
      role,
      inactiveOnly: toBool(params.get('inactive'), false),
      includeInactive: toBool(params.get('includeInactive'), false),
      page,
      limit,
      // `recent` par défaut : le dernier compte créé en premier.
      sort: parseListSort(params.get('sort'), ['recent', 'name']),
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/users — création d'un compte (§17.1).
 *
 * Le mot de passe traverse la requête mais n'est **jamais** renvoyé, journalisé
 * ou synchronisé : `lib/users.ts` le hache en scrypt immédiatement.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('users.manage');
    const body = await readJson<any>(request);

    if (!isRole(body.role)) {
      throw new ValidationError('Rôle invalide : choisissez l’un des six rôles proposés');
    }

    const created = await createUser({
      name: required(body.name, 'Nom'),
      username: required(body.username, 'Identifiant'),
      password: required(body.password, 'Mot de passe'),
      role: body.role,
      phone: body.phone ?? null,
    });

    await writeAudit({
      user,
      action: 'create',
      entity: 'user',
      entityId: created.id,
      // Jamais de mot de passe (ni de hachage) dans le journal.
      details: { name: created.name, username: created.username, role: created.role },
    });

    return ok(created, 201);
  } catch (error) {
    return fail(error);
  }
}
