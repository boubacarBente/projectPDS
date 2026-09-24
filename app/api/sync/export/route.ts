import { getDeviceId } from '@/lib/sync';
import { buildSyncPackage } from '@/lib/sync-export';
import { getSettings } from '@/lib/settings';
import { fail, requireAction } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { rawRun } from '@/db';

/**
 * Export manuel d'un paquet `.json` (README §23.10, « dépannage sans réseau »).
 *
 * Le paquet contient les **30 tables métier** dans l'ordre **topologique** de
 * `SYNC_ORDER` (`lib/sync.ts`), plus les métadonnées (version de format,
 * appareil, horodatage, compteurs par table). Chaque ligne porte `sync_id`,
 * `updated_at`, `deleted_at` et `origin_device_id` (§23.4) ; les références
 * sortantes sont exprimées en `sync_id`, jamais en `id` local.
 *
 * `GET` et `POST` font exactement la même chose : `GET` sert au lien de
 * téléchargement direct, `POST` au bouton de l'écran (qui peut passer
 * `?download=true` pour forcer l'en-tête `Content-Disposition`).
 */
export async function GET() {
  return buildResponse(true);
}

export async function POST() {
  return buildResponse(true);
}

async function buildResponse(forceDownload: boolean) {
  try {
    const user = await requireAction('sync.manage');
    const settings = await getSettings();

    const pkg = await buildSyncPackage({ deviceName: settings.companyBranch || 'Poste local' });
    const deviceId = await getDeviceId();

    const body = JSON.stringify(pkg, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `planete-deco-sync-${stamp}.json`;

    await rememberExport(pkg.exportedAt, pkg.totalRows);

    await writeAudit({
      user,
      action: 'backup',
      entity: 'sync',
      details: {
        action: 'export',
        deviceId,
        totalRows: pkg.totalRows,
        tables: Object.keys(pkg.counts).length,
        filename,
      },
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      'Cache-Control': 'no-store',
    };

    if (forceDownload) {
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }

    return new Response(body, { status: 200, headers });
  } catch (error) {
    return fail(error);
  }
}

/** Horodate l'export dans `sync_state` (journal local de l'écran). */
async function rememberExport(exportedAt: string, totalRows: number): Promise<void> {
  try {
    await rawRun(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['last_export_at', exportedAt, Date.now()],
    );
    await rawRun(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['last_export_rows', String(totalRows), Date.now()],
    );
  } catch {
    /* `sync_state` absente : l'export a réussi, la journalisation est annexe */
  }
}
