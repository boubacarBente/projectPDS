import { NextRequest } from 'next/server';
import { fail, ok, requireAction, ValidationError } from '@/lib/api';
import { applySyncPackage, retryQuarantine, validateSyncPackage, SyncPackageError } from '@/lib/sync-export';
import { writeAudit } from '@/lib/audit';
import { rawRun } from '@/db';

/**
 * POST /api/sync/import — import manuel d'un paquet `.json` (§23.10).
 *
 * Le fichier est **validé structurellement** avant toute écriture (marqueur
 * `planete-deco-sync`, version de format, tables connues), puis appliqué
 * **dans l'ordre topologique**, table par table :
 *
 *  - une référence parente manquante envoie la ligne en **quarantaine** dans
 *    `sync_pending` — jamais perdue, rejouable au lot suivant ;
 *  - une ligne déjà présente est mise à jour **seulement** si la version reçue
 *    n'est pas plus ancienne que la version locale ;
 *  - sinon un **conflit** est créé dans `sync_conflicts` : aucune donnée
 *    existante n'est écrasée sans arbitrage humain ;
 *  - rien n'est jamais supprimé physiquement (les tombstones `deleted_at` sont
 *    appliqués tels quels).
 *
 * `?retryQuarantine=true` rejoue d'abord la quarantaine locale : un parent
 * arrivé entre-temps débloque ses enfants sans redemander le fichier.
 *
 * Réponse : `{ tablesImported, rowsInserted, rowsUpdated, quarantined,
 * conflicts, errors }`.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('sync.manage');

    const form = await request.formData().catch(() => null);
    if (!form) {
      throw new ValidationError('Requête invalide : un fichier de paquet est attendu');
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new ValidationError('Aucun fichier de paquet reçu');
    }

    if (file.size === 0) throw new ValidationError('Le fichier reçu est vide');
    if (file.size > 200_000_000) {
      throw new ValidationError('Fichier trop volumineux (200 Mo maximum)');
    }

    const text = await file.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SyncPackageError('Le fichier n’est pas un JSON valide');
    }

    const pkg = validateSyncPackage(parsed);

    const retryFirst = request.nextUrl.searchParams.get('retryQuarantine') === 'true';
    const retried = retryFirst ? await retryQuarantine() : null;

    const report = await applySyncPackage(pkg);

    // Les enfants précédemment en quarantaine peuvent désormais trouver leur
    // parent, tout juste importé : on les rejoue systématiquement.
    const replayed = retried ?? (await retryQuarantine());

    await rememberImport(pkg.exportedAt, report);

    await writeAudit({
      user,
      action: 'restore',
      entity: 'sync',
      details: {
        action: 'import',
        originalName: file.name,
        exportedAt: pkg.exportedAt,
        sourceDevice: pkg.deviceId,
        tablesImported: report.tablesImported,
        rowsInserted: report.rowsInserted,
        rowsUpdated: report.rowsUpdated,
        quarantined: report.quarantined,
        conflicts: report.conflicts,
        errors: report.errors.slice(0, 10),
        replayed: {
          inserted: replayed.rowsInserted,
          updated: replayed.rowsUpdated,
          quarantined: replayed.quarantined,
        },
      },
    });

    return ok({
      success: true,
      tablesImported: report.tablesImported,
      rowsInserted: report.rowsInserted,
      rowsUpdated: report.rowsUpdated,
      quarantined: report.quarantined,
      conflicts: report.conflicts,
      errors: report.errors,
      perTable: report.perTable,
      replay: {
        inserted: replayed.rowsInserted,
        updated: replayed.rowsUpdated,
        quarantined: replayed.quarantined,
        errors: replayed.errors,
      },
      source: {
        deviceId: pkg.deviceId,
        deviceName: pkg.deviceName,
        exportedAt: pkg.exportedAt,
        totalRows: pkg.totalRows,
      },
      message: buildMessage(report),
    });
  } catch (error) {
    return fail(error);
  }
}

function buildMessage(report: {
  rowsInserted: number;
  rowsUpdated: number;
  quarantined: number;
  conflicts: number;
}): string {
  if (report.rowsInserted === 0 && report.rowsUpdated === 0 && report.quarantined === 0) {
    return 'Paquet appliqué : aucune donnée nouvelle à importer sur ce poste.';
  }

  const parts = [
    `${report.rowsInserted} ligne(s) ajoutée(s)`,
    `${report.rowsUpdated} ligne(s) mise(s) à jour`,
  ];

  if (report.quarantined > 0) parts.push(`${report.quarantined} en quarantaine (parent manquant)`);
  if (report.conflicts > 0) parts.push(`${report.conflicts} conflit(s) à trancher sur l’écran Synchronisation`);

  return `${parts.join(' · ')}.`;
}

/** Horodate l'import dans `sync_state`, sans jamais lever. */
async function rememberImport(
  exportedAt: string,
  report: { rowsInserted: number; rowsUpdated: number },
): Promise<void> {
  const at = new Date();
  try {
    await rawRun(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['last_import_at', at.toISOString(), at.getTime()],
    );
    await rawRun(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['last_import_source', exportedAt, at.getTime()],
    );
    await rawRun(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['last_import_rows', String(report.rowsInserted + report.rowsUpdated), at.getTime()],
    );
  } catch {
    /* la journalisation est annexe : l'import a réussi */
  }
}
