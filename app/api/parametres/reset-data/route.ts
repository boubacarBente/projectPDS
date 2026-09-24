import { fail, ok, requireAction } from '@/lib/api';
import { createBackup, resetBusinessData } from '@/lib/backup';
import { writeAudit } from '@/lib/audit';
import { resetDeviceIdCache } from '@/lib/sync';

/**
 * POST /api/parametres/reset-data — réinitialise les données métier.
 *
 * Les paramètres de l'entreprise et les comptes utilisateurs sont **conservés**
 * (voir `lib/backup.ts`) : une réinitialisation ne doit pas rendre
 * l'application inaccessible. Une copie de sécurité est créée avant l'effacement.
 */
export async function POST() {
  try {
    const user = await requireAction('settings.critical');

    const { path: safetyBackup } = await createBackup();
    const result = await resetBusinessData();

    resetDeviceIdCache();

    await writeAudit({
      user,
      action: 'reset',
      entity: 'database',
      details: { tables: result.tables.length, safetyBackup },
    });

    return ok({
      success: true,
      tablesCleared: result.tables.length,
      safetyBackup,
      message:
        'Données réinitialisées. Les paramètres et les comptes utilisateurs ont été conservés.',
    });
  } catch (error) {
    return fail(error);
  }
}
