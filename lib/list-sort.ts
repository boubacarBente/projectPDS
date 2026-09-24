/**
 * Tri des listes — **la dernière insertion d'abord, partout**.
 *
 * Règle de produit (demande explicite du client) : quand aucun tri n'est
 * demandé, une liste montre **ce qui vient d'être enregistré** en premier.
 * C'est ce qu'on attend d'un logiciel de caisse : le client qu'on vient de
 * créer, la vente qu'on vient de saisir, le produit qu'on vient d'ajouter.
 *
 * Pourquoi `created_at DESC, id DESC` et pas seulement `id DESC` :
 *  - `created_at` est la donnée métier (« dernière insertion ») ;
 *  - `id` (auto-incrément) **départage** deux lignes créées dans la même
 *    seconde — sans lui, SQLite renverrait un ordre non déterministe, et une
 *    ligne pourrait changer de page entre deux affichages.
 *
 * Les tris `name` (alphabétique) et `balance` (solde/dette décroissant)
 * restent disponibles : ils sont **explicites**, jamais par défaut.
 *
 * ⚠️ Le tri est fait **en SQL**, côté serveur. Un tri en JavaScript ne
 * trierait que la page courante : sur 3 pages de clients, « solde
 * décroissant » afficherait le plus gros solde de la page 1, pas de la base.
 * C'est le défaut qui existait sur l'écran Clients (§« page /clients »).
 */

/** Tris acceptés par les listes. `balance` n'a de sens que sur clients/fournisseurs. */
export const LIST_SORTS = ['recent', 'name', 'balance'] as const;

export type ListSort = (typeof LIST_SORTS)[number];

/** Tri appliqué quand la liste n'en demande aucun. */
export const DEFAULT_LIST_SORT: ListSort = 'recent';

export function isListSort(value: unknown): value is ListSort {
  return typeof value === 'string' && (LIST_SORTS as readonly string[]).includes(value);
}

/**
 * Lit le tri demandé dans une query string (`?sort=`).
 *
 * Une valeur inconnue ou absente retombe sur `fallback` (`recent` par défaut) :
 * l'API ne doit jamais renvoyer 400 pour un tri, et un ancien lien ne doit pas
 * casser.
 *
 * `fallback` existe pour les listes qui ne sont **pas** des listes de gestion :
 * le filtre « utilisateur » de `/utilisateurs/historique` reste alphabétique,
 * parce qu'un menu déroulant de noms se parcourt par ordre alphabétique.
 */
export function parseListSort(
  value: string | null | undefined,
  allowed: readonly ListSort[] = LIST_SORTS,
  fallback: ListSort = DEFAULT_LIST_SORT,
): ListSort {
  if (isListSort(value) && allowed.includes(value)) return value;
  if (allowed.includes(fallback)) return fallback;
  return allowed[0] ?? DEFAULT_LIST_SORT;
}

/**
 * Construit la clause `ORDER BY` d'une requête SQL écrite à la main.
 *
 * @param sort   tri demandé ;
 * @param alias  alias de la table dans la requête (`'c'`, `'p'`…). Passer une
 *               chaîne vide quand la requête interroge une sous-requête :
 *               les colonnes y sont alors sans préfixe.
 * @param allowed tris réellement possibles sur cette table (une table sans
 *               colonne `balance` n'accepte pas `balance`).
 */
export function sqlOrderBy(
  sort: ListSort,
  alias = '',
  allowed: readonly ListSort[] = LIST_SORTS,
): string {
  const effective = allowed.includes(sort) ? sort : DEFAULT_LIST_SORT;
  const prefix = alias ? `${alias}.` : '';

  switch (effective) {
    case 'name':
      return `${prefix}name COLLATE NOCASE`;
    case 'balance':
      // Le solde est une colonne calculée par la requête : elle n'est pas
      // préfixée, même quand le reste l'est.
      return `${prefix}balance DESC, ${prefix}name COLLATE NOCASE`;
    case 'recent':
    default:
      return `${prefix}created_at DESC, ${prefix}id DESC`;
  }
}

/**
 * Même règle, mais en mémoire — pour les listes déjà chargées (utilisateurs,
 * quelques dizaines de lignes, filtrées en JavaScript dans `lib/users.ts`).
 */
export function compareByListSort<T>(
  a: T,
  b: T,
  sort: ListSort,
  get: { name: (row: T) => string; createdAt?: (row: T) => Date | null; id: (row: T) => number; balance?: (row: T) => number },
): number {
  switch (sort) {
    case 'name':
      return get.name(a).localeCompare(get.name(b), 'fr', { sensitivity: 'base' });
    case 'balance':
      if (get.balance) return get.balance(b) - get.balance(a);
      return get.name(a).localeCompare(get.name(b), 'fr', { sensitivity: 'base' });
    case 'recent':
    default: {
      const left = get.createdAt?.(a)?.getTime() ?? 0;
      const right = get.createdAt?.(b)?.getTime() ?? 0;
      if (right !== left) return right - left;
      return get.id(b) - get.id(a);
    }
  }
}
