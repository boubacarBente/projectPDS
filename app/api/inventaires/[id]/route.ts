import { NextRequest } from 'next/server';
import {
  NotFoundError,
  ValidationError,
  assertStoreVisible,
  fail,
  ok,
  parseId,
  readJson,
  requireAction,
  requireUser,
} from '@/lib/api';
import { can, requirePermission } from '@/lib/permissions';
import { cancelInventory, getInventory, recordCounts, validateInventory } from '@/lib/inventories';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/inventaires/[id] — fiche : en-tête, lignes (théorique, compté,
 * écart, valeur) et actions possibles (`actions`).
 * Permission : `inventory.view` + magasin visible.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const user = await requireAction('inventory.view');
    const { id } = await params;
    const detail = await getInventory(parseId(id));
    if (!detail) throw new NotFoundError('Inventaire introuvable');
    assertStoreVisible(user, detail.inventory.storeId);

    const actions: string[] = [];
    if (detail.inventory.status === 'open' && user.storeId === detail.inventory.storeId) {
      if (can(user, 'inventory.manage', user.permissions)) actions.push('count', 'cancel');
      if (can(user, 'inventory.validate', user.permissions)) actions.push('validate');
    }
    return ok({ ...detail, actions });
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/inventaires/[id] — `{ action, ... }` :
 *  - `count`    `{ counts: [{ itemId, countedQuantity (null = effacer), justification? }] }`
 *               (`inventory.manage`) — enregistre les comptages, plusieurs passages possibles ;
 *  - `validate` (`inventory.validate`) — crée un ajustement de stock pour chaque écart
 *               et clôture l'inventaire ;
 *  - `cancel`   `{ reason }` (`inventory.manage`) — abandonne sans toucher au stock.
 * Toujours depuis le magasin de l'inventaire (magasin actif).
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const inventoryId = parseId(id);
    const body = await readJson<any>(request);

    switch (body.action) {
      case 'count': {
        requirePermission(user, 'inventory.manage', user.permissions);
        if (!Array.isArray(body.counts)) throw new ValidationError('Aucun comptage reçu');
        await recordCounts(
          inventoryId,
          body.counts.map((c: any) => ({
            itemId: Number(c.itemId),
            countedQuantity:
              c.countedQuantity === null || c.countedQuantity === '' || c.countedQuantity === undefined
                ? null
                : Number(c.countedQuantity),
            justification: c.justification ?? null,
          })),
          user,
        );
        break;
      }
      case 'validate': {
        requirePermission(user, 'inventory.validate', user.permissions);
        const result = await validateInventory(inventoryId, user);
        return ok({ ...(await getInventory(inventoryId)), result });
      }
      case 'cancel':
        requirePermission(user, 'inventory.manage', user.permissions);
        await cancelInventory(inventoryId, user, String(body.reason ?? ''));
        break;
      default:
        throw new ValidationError('Action inconnue');
    }

    return ok(await getInventory(inventoryId));
  } catch (error) {
    return fail(error);
  }
}
