import { NextRequest } from 'next/server';
import { fail, ok, readJson, requireAction, ValidationError } from '@/lib/api';
import {
  getBrickDataSummary,
  resetBrickData,
  seedBrickDemoData,
} from '@/lib/brick-seed';
import { writeAudit } from '@/lib/audit';

/**
 * GET|POST /api/parametres/briqueterie — données de démonstration de la
 * briqueterie (README §20.5).
 *
 * Deux boutons dans `/parametres`, donc deux actions :
 *  - `seed` : **pré-remplit** une année d'activité (lots, dépenses rattachées,
 *    ventes du canal `brick`, commandes), répartie sur la semaine, le mois et
 *    l'année en cours. L'opération **ajoute** : les données existantes sont
 *    conservées, c'est à l'utilisateur de réinitialiser d'abord s'il veut
 *    repartir de zéro.
 *  - `reset` : **efface l'activité de la briqueterie** (lots, dépenses, ventes,
 *    commandes, mouvements) sans toucher au référentiel (types de briques,
 *    produits), aux clients, aux paramètres ni au journal d'actions.
 *
 * Permission : `settings.critical` — les deux opérations écrivent en masse des
 * données métier, et `reset` **supprime physiquement** des lignes (la seule
 * exception assumée à la règle « aucune suppression », avec la réinitialisation
 * générale). Une copie de sécurité de la base est créée avant l'effacement.
 *
 * Le `GET` sert à l'écran : il affiche ce qui existe avant qu'on appuie.
 */
export async function GET() {
  try {
    await requireAction('settings.critical');
    return ok(await getBrickDataSummary());
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('settings.critical');
    const body = await readJson<any>(request);
    const action = body?.action;

    if (action === 'seed') {
      const counts = await seedBrickDemoData({ userId: user.id });

      await writeAudit({
        user,
        action: 'seed',
        entity: 'briqueterie',
        details: counts,
      });

      return ok({
        success: true,
        action: 'seed',
        counts,
        message:
          'Données de démonstration créées : lots, dépenses rattachées, ventes et commandes répartis sur la semaine, le mois et l’année.',
      });
    }

    if (action === 'reset') {
      const report = await resetBrickData({ userId: user.id });

      await writeAudit({
        user,
        action: 'reset',
        entity: 'briqueterie',
        details: {
          productions: report.productions,
          expenses: report.expenses,
          sales: report.sales,
          orders: report.orders,
          stockMovements: report.stockMovements,
          cashMovements: report.cashMovements,
          productsZeroed: report.productsZeroed,
          quantityZeroed: report.quantityZeroed,
          safetyBackup: report.safetyBackup,
        },
      });

      return ok({
        success: true,
        action: 'reset',
        report,
        message:
          'Activité de la briqueterie effacée et stocks des produits de briques remis à zéro. Les types de briques, les produits, les clients et le journal d’actions sont conservés.',
      });
    }

    throw new ValidationError('Action attendue : « seed » ou « reset »');
  } catch (error) {
    return fail(error);
  }
}
