import { fail, ok, requireAction } from '@/lib/api';
import { seedDemoData } from '@/lib/seed-data';
import { writeAudit } from '@/lib/audit';

/**
 * POST /api/parametres/seed-data — préremplit un catalogue de démonstration.
 * Outil de développement : la carte est masquée en production et en desktop.
 */
export async function POST() {
  try {
    const user = await requireAction('settings.critical');

    const report = await seedDemoData();

    await writeAudit({
      user,
      action: 'seed',
      entity: 'database',
      details: report,
    });

    return ok({ success: true, ...report });
  } catch (error) {
    return fail(error);
  }
}
