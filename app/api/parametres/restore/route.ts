import { NextRequest } from 'next/server';
import { fail, ok, requireAction, ValidationError } from '@/lib/api';
import { restoreBackup } from '@/lib/backup';
import { writeAudit } from '@/lib/audit';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * POST /api/parametres/restore — restaure une sauvegarde téléversée.
 *
 * Le fichier reçu est écrit dans un répertoire temporaire **avant** toute
 * validation : le chemin utilisé pour `ATTACH DATABASE` n'est donc jamais
 * dérivé du nom fourni par le client.
 */
export async function POST(request: NextRequest) {
  let tempPath: string | null = null;

  try {
    const user = await requireAction('backup.manage');

    const form = await request.formData().catch(() => null);
    if (!form) throw new ValidationError('Requête invalide : un fichier est attendu');

    const file = form.get('file');
    if (!(file instanceof File)) throw new ValidationError('Aucun fichier de sauvegarde reçu');

    if (file.size === 0) throw new ValidationError('Le fichier de sauvegarde est vide');
    if (file.size > 2_000_000_000) throw new ValidationError('Fichier trop volumineux');

    const dir = path.join(os.tmpdir(), 'planete-deco-uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Nom entièrement construit par le serveur : rien du client n'y entre.
    tempPath = path.join(dir, `upload-${Date.now()}.db`);
    fs.writeFileSync(tempPath, Buffer.from(await file.arrayBuffer()));

    const report = await restoreBackup(tempPath);

    await writeAudit({
      user,
      action: 'restore',
      entity: 'database',
      details: {
        tablesRestored: report.tablesRestored.length,
        totalRows: report.totalRows,
        safetyBackup: report.safetyBackup,
        warnings: report.warnings,
        originalName: file.name,
      },
    });

    return ok({
      success: true,
      ...report,
      message:
        'Sauvegarde restaurée. Une copie de sécurité de la base précédente a été créée avant l’opération.',
    });
  } catch (error) {
    return fail(error);
  } finally {
    if (tempPath) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        /* sans conséquence */
      }
    }
  }
}
