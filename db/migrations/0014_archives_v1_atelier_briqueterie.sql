-- Archives de la v1 de l'atelier de meubles et de la briqueterie (README §29, §30).
-- Les tables v1 ont été supprimées par 0004 mais des lignes y faisaient encore
-- référence (dépenses rattachées aux lots, mouvements de stock, acomptes). Les
-- nouvelles tables 0012 / 0013 repartent à l'identifiant 1 : sans ce renommage,
-- le nouveau lot n° 1 hériterait des dépenses de l'ancien lot n° 1. Une ligne est
-- ancienne si aucune ligne nouvelle de même identifiant n'existait avant elle.
UPDATE `expenses` SET `reference_type` = 'brick_production_v1'
 WHERE `reference_type` = 'brick_production'
   AND NOT EXISTS (SELECT 1 FROM `brick_productions` p WHERE p.`id` = `expenses`.`reference_id` AND p.`created_at` <= `expenses`.`created_at`);--> statement-breakpoint
UPDATE `stock_movements` SET `reference_type` = 'brick_production_v1'
 WHERE `reference_type` = 'brick_production'
   AND NOT EXISTS (SELECT 1 FROM `brick_productions` p WHERE p.`id` = `stock_movements`.`reference_id` AND p.`created_at` <= `stock_movements`.`created_at`);--> statement-breakpoint
UPDATE `stock_movements` SET `reference_type` = 'furniture_order_v1'
 WHERE `reference_type` = 'furniture_order'
   AND NOT EXISTS (SELECT 1 FROM `furniture_orders` o WHERE o.`id` = `stock_movements`.`reference_id` AND o.`created_at` <= `stock_movements`.`created_at`);--> statement-breakpoint
UPDATE `payments` SET `type` = 'brick_order_v1'
 WHERE `type` = 'brick_order'
   AND NOT EXISTS (SELECT 1 FROM `brick_orders` b WHERE b.`id` = `payments`.`reference_id` AND b.`created_at` <= `payments`.`created_at`);
