import { fail, ok, requireAction } from '@/lib/api';
import { resetSyncWatermarks } from '@/lib/sync-export';
import { writeAudit } from '@/lib/audit';

/**
 * POST /api/sync/reset — « Renvoyer tout » (§23.10).
 *
 * ⚠️ Ce que cette route fait, et ce qu'elle ne fait **pas** :
 *
 *  - elle **réinitialise les watermarks** de `sync_state` (`last_pulled_at:*`
 *    repassent à `NULL` : la prochaine réception redemandera tout depuis le
 *    début) ;
 *  - elle **remet `attempts` à zéro** dans `sync_outbox`, et efface
 *    `last_error` / `last_attempt_at` : les lignes redeviennent « à envoyer » ;
 *  - elle **ne supprime rien** — aucune donnée métier, aucune ligne de
 *    `sync_outbox`, aucun conflit déjà tranché. Les conflits en attente sont
 *    eux aussi conservés : ils demandent un arbitrage humain, pas un effacement.
 *
 * Autrement dit : « tout est de nouveau à envoyer », et non « on efface la
 * file ». Aucune opération métier ne dépend de cette route.
 */
export async function POST() {
  try {
    const user = await requireAction('sync.manage');

    const result = await resetSyncWatermarks();

    await writeAudit({
      user,
      action: 'reset',
      entity: 'sync',
      details: {
        action: 'reset_watermarks',
        tables: result.tables.length,
        outboxReset: result.outboxReset,
        conflictsPreserved: result.conflicts,
        deleted: 0,
      },
    });

    return ok({
      success: true,
      ...result,
      message:
        'Watermarks réinitialisés et compteurs d’essais remis à zéro. Aucune donnée n’a été supprimée : tout sera renvoyé au prochain envoi.',
    });
  } catch (error) {
    return fail(error);
  }
}
