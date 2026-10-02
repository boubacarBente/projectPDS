import { NextRequest } from 'next/server';
import { NotFoundError, ValidationError, fail, ok, requireAction, toInt } from '@/lib/api';
import { getStore } from '@/lib/stores';
import { listStockProducts } from '@/lib/stock';

/**
 * GET /api/transferts/disponible?source=<id>&search=&limit=
 *
 * Quantités **disponibles au magasin source**, pour préparer une demande de
 * transfert. Pourquoi une route dédiée : celui qui demande travaille le plus
 * souvent dans le magasin **destinataire** et n'a pas accès au stock du magasin
 * source (`GET /api/stocks?store=<source>` lui renvoie 403). Il a pourtant
 * besoin de savoir ce qu'il peut demander.
 *
 * La réponse est volontairement réduite : produit, unité, quantité disponible —
 * ni prix d'achat, ni valeur de stock. Le blocage réel (stock insuffisant) se
 * fait à l'expédition, par le magasin source.
 *
 * Réponse : `[{ id, name, unit, barcode, available }]`.
 * Permission : `transfers.create`.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAction('transfers.create');
    const params = request.nextUrl.searchParams;
    const sourceId = toInt(params.get('source') ?? '', 0);
    if (sourceId <= 0) throw new ValidationError('Choisissez le magasin source');

    const source = await getStore(sourceId);
    if (!source || source.status === 'archived') throw new NotFoundError('Magasin source introuvable');

    const result = await listStockProducts({
      scope: [sourceId],
      search: params.get('search')?.trim() || undefined,
      sort: 'name',
      page: 1,
      // La page de création charge le catalogue une fois par magasin source et filtre sur place.
      limit: Math.min(500, Math.max(1, toInt(params.get('limit') ?? '', 500))),
    });

    return ok(
      result.data.map((p) => ({
        id: p.id,
        name: p.name,
        unit: p.unit,
        barcode: p.barcode,
        available: p.stock,
      })),
    );
  } catch (error) {
    return fail(error);
  }
}
