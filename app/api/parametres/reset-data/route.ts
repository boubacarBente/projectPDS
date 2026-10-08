import { fail, ok, requireAction } from '@/lib/api';
import { createBackup, resetBusinessData } from '@/lib/backup';
import { writeAudit } from '@/lib/audit';

/**
 * POST /api/parametres/reset-data — vide toute la base.
 *
 * Seuls les comptes utilisateurs (et leurs droits), les paramètres et le magasin
 * principal sont **conservés** (voir `resetBusinessData` dans `lib/backup.ts`) :
 * une réinitialisation ne doit pas rendre l'application inaccessible. Une copie
 * de sécurité est créée avant l'effacement.
 */
export async function POST() {
  try {
    const user = await requireAction('settings.critical');

    const { path: safetyBackup } = await createBackup();
    const result = await resetBusinessData();

    await writeAudit({
      user,
      action: 'reset',
      entity: 'database',
      details: { tables: result.tables.length, mainStore: result.mainStore, safetyBackup },
    });

    return ok({
      success: true,
      tablesCleared: result.tables.length,
      safetyBackup,
      message: result.mainStore
        ? `Base vidée. Seuls les comptes utilisateurs, les paramètres et le magasin « ${result.mainStore} » ont été conservés.`
        : 'Base vidée. Seuls les comptes utilisateurs et les paramètres ont été conservés.',
    });
  } catch (error) {
    return fail(error);
  }
}
