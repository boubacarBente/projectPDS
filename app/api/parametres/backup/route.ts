import { fail, requireAction } from '@/lib/api';
import { createBackup } from '@/lib/backup';
import { writeAudit } from '@/lib/audit';
import fs from 'fs';

/**
 * GET /api/parametres/backup — télécharge une sauvegarde complète.
 *
 * Le fichier est produit par `VACUUM INTO` : la copie est **cohérente** et
 * contient les transactions encore présentes dans le journal WAL. Une simple
 * copie de `database.db` ne l'aurait pas garanti.
 */
export async function GET() {
  try {
    const user = await requireAction('backup.manage');

    const { path: backupPath, size } = await createBackup();
    const buffer = fs.readFileSync(backupPath);

    // La sauvegarde temporaire a rempli son rôle : on ne la conserve pas.
    // (Les sauvegardes automatiques et manuelles passent par `createBackup()`
    //  avec un chemin explicite dans `backups/`.)
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      /* sans conséquence */
    }

    await writeAudit({
      user,
      action: 'backup',
      entity: 'database',
      details: { size },
    });

    const stamp = new Date().toISOString().slice(0, 10);

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="planete-deco-sauvegarde-${stamp}.db"`,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return fail(error);
  }
}
