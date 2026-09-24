import { fail, ok, requireAction } from '@/lib/api';
import { db, rawRun } from '@/db';
import { syncOutbox } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getDeviceId } from '@/lib/sync';
import { getSettings } from '@/lib/settings';
import { writeAudit } from '@/lib/audit';

/**
 * POST /api/sync/now — tente une synchronisation (§23.10).
 *
 * ⚠️ **Le service PostgreSQL en ligne n'existe pas.** Cette route ne simule
 * donc **jamais** un succès : elle répond toujours `200` avec un résultat
 * **honnête**, et n'échoue jamais du point de vue de l'application — aucune
 * opération métier ne dépend de la synchronisation (§11 règle 4).
 *
 * Trois cas, dans cet ordre :
 *
 *  1. `sync_mode = 'off'` → `{ skipped: true, reason: 'Synchronisation désactivée' }`.
 *     Rien n'est tenté, rien n'est incrémenté : la file reste telle quelle.
 *  2. `sync_api_url` vide → `{ status: 'error', error: 'Aucune adresse de
 *     synchronisation configurée' }`, et `attempts` est incrémenté sur les
 *     lignes en attente, avec `last_error` renseigné.
 *  3. Adresse configurée → aucun service n'étant déployé, l'envoi ne peut pas
 *     aboutir. On **ne fait pas** de requête réseau sortante vers une adresse
 *     saisie par l'utilisateur : il n'y a rien à joindre, et le poste ne doit
 *     pas devenir un vecteur de requêtes arbitraires. La route répond
 *     `{ status: 'error', error: '…aucun service n’est déployé…' }` et
 *     incrémente `attempts`.
 *
 * `attempts` est le compteur d'essais lu par l'écran (au-delà de 5, la ligne
 * est comptée « en échec ») ; les lignes de `sync_outbox` ne sont **jamais**
 * supprimées et aucune donnée locale n'est modifiée.
 */
export async function POST() {
  try {
    const user = await requireAction('sync.manage');
    const settings = await getSettings();

    /* 1. Synchronisation désactivée — on ne touche à rien. */
    if (settings.syncMode === 'off') {
      await writeAudit({
        user,
        action: 'settings',
        entity: 'sync',
        details: { action: 'sync_now', skipped: true, reason: 'sync_mode=off' },
      });

      return ok({
        skipped: true,
        reason: 'Synchronisation désactivée',
        mode: settings.syncMode,
        pending: 0,
        message:
          'La synchronisation est désactivée : l’application fonctionne normalement, en local. Aucune donnée n’a été envoyée.',
      });
    }

    const queued = await db.select().from(syncOutbox).orderBy(syncOutbox.id);
    const deviceId = await getDeviceId();

    /* 2. Aucune adresse configurée — l'erreur la plus fréquente, la plus utile. */
    if (!settings.syncApiUrl?.trim()) {
      const error = 'Aucune adresse de synchronisation configurée';
      const attempts = await markAttempts(queued, error);
      await rememberFailure(error);

      await writeAudit({
        user,
        action: 'settings',
        entity: 'sync',
        details: { action: 'sync_now', status: 'error', reason: error, attempted: attempts },
      });

      return ok({
        status: 'error',
        error,
        mode: settings.syncMode,
        pending: queued.length,
        attempted: attempts,
        deviceId,
        message:
          'Renseignez l’adresse de l’API dans les paramètres. En attendant, tout reste dans la file locale : aucune donnée n’est perdue.',
      });
    }

    /* 3. Adresse configurée : il n'y a pas de service à joindre. */
    const error = 'Aucun service de synchronisation n’est déployé à cette adresse — envoi impossible';
    const attempts = await markAttempts(queued, error);
    await rememberFailure(error);

    await writeAudit({
      user,
      action: 'settings',
      entity: 'sync',
      details: { action: 'sync_now', status: 'error', reason: error, attempted: attempts },
    });

    return ok({
      status: 'error',
      error,
      mode: settings.syncMode,
      pending: queued.length,
      attempted: attempts,
      deviceId,
      message:
        'Le service PostgreSQL en ligne n’est pas déployé : rien n’a été envoyé. Utilisez l’export / import manuel pour transporter les données.',
    });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Incrémente `attempts` sur les lignes en attente.
 *
 * Chaque ligne est mise à jour individuellement : une seule requête SQL
 * « UPDATE … WHERE id IN (…) » fonctionnerait aussi, mais avec 30 tables et des
 * files courtes, la lisibilité de la boucle et l'usage de l'ORM valent mieux
 * qu'un gain négligeable. Aucune ligne n'est supprimée.
 */
async function markAttempts(
  rows: { id: number; attempts: number }[],
  error: string,
): Promise<number> {
  let count = 0;

  for (const row of rows) {
    count += 1;
    await db
      .update(syncOutbox)
      .set({ attempts: row.attempts + 1, lastAttemptAt: new Date(), lastError: error })
      .where(idEquals(row.id));
  }

  return count;
}

/** Égalité Drizzle sur `sync_outbox.id`, isolée pour rester lisible. */
function idEquals(id: number) {
  return eq(syncOutbox.id, id);
}

/** Horodate l'échec dans `sync_state`, sans jamais lever. */
async function rememberFailure(message: string): Promise<void> {
  const at = new Date();
  try {
    await rawRun(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['last_sync_error', message, at.getTime()],
    );
    await rawRun(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['last_sync_attempt_at', at.toISOString(), at.getTime()],
    );
  } catch {
    /* `sync_state` absente : l'échec de journalisation ne doit rien casser */
  }
}
