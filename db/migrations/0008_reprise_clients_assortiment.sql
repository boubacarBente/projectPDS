/*
 * Reprise des données pour le cloisonnement par magasin (README §28.5).
 * Migration distincte de 0007 (colonnes seules), déjà appliquée sur des bases
 * de développement : une migration appliquée n'est jamais rejouée.
 *
 * Tout est déterministe : chaque poste calcule la même valeur, la
 * synchronisation ne crée donc aucun conflit.
 *
 * Client : magasin où il a le plus de documents (ventes, chantiers, devis,
 * demandes), à égalité le plus ancien magasin ; sans document, le siège (ou
 * le premier magasin).
 */
UPDATE `customers` SET `store_id` = COALESCE(
  (SELECT d.store_id FROM (
      SELECT store_id FROM sales_invoices WHERE customer_id = customers.id AND store_id IS NOT NULL
      UNION ALL SELECT store_id FROM service_jobs WHERE customer_id = customers.id AND store_id IS NOT NULL
      UNION ALL SELECT store_id FROM quotes WHERE customer_id = customers.id
      UNION ALL SELECT store_id FROM service_requests WHERE customer_id = customers.id
    ) d GROUP BY d.store_id ORDER BY COUNT(*) DESC, d.store_id ASC LIMIT 1),
  (SELECT id FROM stores ORDER BY (kind = 'headquarters') DESC, id ASC LIMIT 1)
) WHERE `store_id` IS NULL;
--> statement-breakpoint
/* Fournisseur : même règle (achats, sous-traitance de chantier). */
UPDATE `suppliers` SET `store_id` = COALESCE(
  (SELECT d.store_id FROM (
      SELECT store_id FROM purchase_invoices WHERE supplier_id = suppliers.id AND store_id IS NOT NULL
      UNION ALL SELECT j.store_id FROM job_subcontracts js JOIN service_jobs j ON j.id = js.job_id
        WHERE js.supplier_id = suppliers.id AND j.store_id IS NOT NULL
    ) d GROUP BY d.store_id ORDER BY COUNT(*) DESC, d.store_id ASC LIMIT 1),
  (SELECT id FROM stores ORDER BY (kind = 'headquarters') DESC, id ASC LIMIT 1)
) WHERE `store_id` IS NULL;
--> statement-breakpoint
/*
 * Assortiment : en réseau (plus d'un magasin), un magasin ne garde que les
 * produits qu'il a réellement eus (un mouvement de stock, un stock non nul ou
 * un réglage local). Un magasin unique garde tout le catalogue.
 */
UPDATE `product_stocks` SET `is_listed` = 0
 WHERE (SELECT COUNT(*) FROM stores) > 1
   AND quantity = 0 AND stock_min IS NULL AND sale_price IS NULL
   AND NOT EXISTS (SELECT 1 FROM stock_movements m
                    WHERE m.store_id = product_stocks.store_id AND m.product_id = product_stocks.product_id);
--> statement-breakpoint
/* Un produit qu'aucun magasin ne propose reste au moins dans l'assortiment du siège. */
UPDATE `product_stocks` SET `is_listed` = 1
 WHERE store_id = (SELECT id FROM stores ORDER BY (kind = 'headquarters') DESC, id ASC LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM product_stocks o WHERE o.product_id = product_stocks.product_id AND o.is_listed = 1);
