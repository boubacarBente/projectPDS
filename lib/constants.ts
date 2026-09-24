/**
 * Constantes partagées entre le serveur et le navigateur.
 *
 * ⚠️ **Module client-safe** : aucune dépendance à `@/db`, `fs`, `path` ou
 * `next/headers`. Un composant client a besoin de ces valeurs pour valider un
 * formulaire avant l'envoi ; il ne doit pas pour autant tirer la chaîne de la
 * base de données dans le bundle navigateur.
 */

/** Longueur minimale d'un mot de passe, vérifiée côté client ET côté serveur. */
export const MIN_PASSWORD_LENGTH = 6;

/** Longueur minimale d'un identifiant de connexion. */
export const MIN_USERNAME_LENGTH = 3;

/** Motif d'un identifiant de connexion : minuscules, chiffres, `.`, `_`, `-`. */
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,}$/;

/** Taille de page par défaut des listes paginées. */
export const DEFAULT_PAGE_SIZE = 10;

/** Longueur maximale d'un motif d'annulation ou d'ajustement. */
export const MAX_REASON_LENGTH = 500;

/** Nombre maximal de lignes dans une facture (garde-fou d'interface). */
export const MAX_INVOICE_LINES = 200;

/** Seuil à partir duquel un montant est affiché en compact dans un graphique. */
export const COMPACT_CURRENCY_THRESHOLD = 1_000_000;
