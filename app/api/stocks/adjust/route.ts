import { NextRequest } from 'next/server';
import {
  NotFoundError,
  ValidationError,
  fail,
  ok,
  readJson,
  requireAction,
  required,
  toNumber,
} from '@/lib/api';
import { adjustStock } from '@/lib/stock';
import { writeAudit } from '@/lib/audit';

/**
 * POST /api/stocks/adjust — correction d'inventaire (§12).
 *
 * Corps attendu : `{ productId, delta, motif }` où `delta` est un **écart
 * signé**, jamais une valeur absolue : `delta > 0` = on a trouvé plus que le
 * stock théorique, `delta < 0` = moins. C'est ce qui préserve l'invariant
 * `products.stock` = somme algébrique des mouvements (§6.5 règle 3).
 *
 * `adjustStock()` ne descend jamais sous 0 : si l'écart rendrait le stock
 * négatif, `InsufficientStockError` remonte et `fail()` la traduit en HTTP 400.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('stock.adjust');
    const body = await readJson<any>(request);

    const productId = Number(body.productId);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new ValidationError('Produit invalide : sélectionnez un produit');
    }

    const delta = toNumber(body.delta, 0);
    if (!Number.isFinite(delta) || delta === 0) {
      throw new ValidationError("L'écart d'ajustement doit être un nombre non nul");
    }

    const motif = required(body.motif, 'Motif');

    const result = await adjustStock(productId, delta, motif, { userId: user.id });

    await writeAudit({
      user,
      action: 'stock_adjust',
      entity: 'stock',
      entityId: productId,
      details: {
        delta,
        motif,
        stockBefore: result.stockBefore,
        stockAfter: result.stockAfter,
      },
    });

    return ok({ stockBefore: result.stockBefore, stockAfter: result.stockAfter });
  } catch (error) {
    // `adjustStock()` lève un `Error('Produit introuvable')` : on le traduit en
    // 404 pour que l'interface affiche un message utile plutôt qu'un 500.
    if (error instanceof Error && error.message === 'Produit introuvable') {
      return fail(new NotFoundError('Produit introuvable'));
    }
    return fail(error);
  }
}
