CREATE TABLE `production_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`production_id` integer NOT NULL,
	`product_id` integer,
	`product_name` text NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`quantity` real NOT NULL,
	`wastage_quantity` real DEFAULT 0 NOT NULL,
	`unit_cost` real DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`user_id` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`production_id`) REFERENCES `brick_productions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_materials_sync_id_unique` ON `production_materials` (`sync_id`);--> statement-breakpoint
CREATE INDEX `production_materials_production_idx` ON `production_materials` (`production_id`);--> statement-breakpoint
CREATE TABLE `production_model_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`model_id`) REFERENCES `brick_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_model_materials_sync_id_unique` ON `production_model_materials` (`sync_id`);--> statement-breakpoint
CREATE INDEX `production_model_materials_model_idx` ON `production_model_materials` (`model_id`);--> statement-breakpoint
ALTER TABLE `brick_types` ADD `furniture_model_id` integer REFERENCES furniture_models(id);--> statement-breakpoint
ALTER TABLE `cash_movements` ADD `production_branch_id` integer REFERENCES production_branches(id);--> statement-breakpoint
CREATE INDEX `cash_movements_branch_idx` ON `cash_movements` (`production_branch_id`);--> statement-breakpoint
ALTER TABLE `expenses` ADD `production_branch_id` integer REFERENCES production_branches(id);--> statement-breakpoint
CREATE INDEX `expenses_branch_idx` ON `expenses` (`production_branch_id`);--> statement-breakpoint
ALTER TABLE `furniture_models` ADD `branch_id` integer REFERENCES production_branches(id);--> statement-breakpoint
ALTER TABLE `furniture_orders` ADD `branch_id` integer REFERENCES production_branches(id);--> statement-breakpoint
ALTER TABLE `inventories` ADD `production_branch_id` integer REFERENCES production_branches(id);--> statement-breakpoint
ALTER TABLE `production_branches` ADD `icon` text DEFAULT 'factory' NOT NULL;
--> statement-breakpoint
-- Reprise de l'atelier de meubles (README §31.9) : il devient la filiale « Meuble ».
-- Ses anciennes commandes et ses modèles restent dans leurs tables (aucune suppression,
-- invariant 1) et se consultent depuis l'onglet « Atelier (historique) » de la filiale.
INSERT INTO `production_branches` (`name`, `activity`, `description`, `status`, `color`, `icon`, `sort_order`, `unit`, `stages`, `loss_label`, `batch_prefix`, `order_prefix`, `access_mode`, `customer_mode`, `created_at`, `sync_id`, `updated_at`)
SELECT 'Meuble', 'furniture', 'Fabrication et vente de meubles (reprise de l''atelier de meubles).', 'active', 'secondary', 'furniture',
       COALESCE((SELECT MAX(`sort_order`) FROM `production_branches`), 0) + 1, 'pièce',
       '[{"key":"cutting","label":"Découpe"},{"key":"assembly","label":"Assemblage"},{"key":"sanding","label":"Ponçage"},{"key":"painting","label":"Peinture / vernis"},{"key":"finishing","label":"Finition"}]',
       'Rebuts', 'MBL', 'MCM', 'all', 'all', unixepoch(),
       lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       unixepoch()
 WHERE NOT EXISTS (SELECT 1 FROM `production_branches` WHERE `activity` = 'furniture');--> statement-breakpoint
UPDATE `furniture_models` SET `branch_id` = (SELECT `id` FROM `production_branches` WHERE `activity` = 'furniture' ORDER BY `id` LIMIT 1) WHERE `branch_id` IS NULL;--> statement-breakpoint
UPDATE `furniture_orders` SET `branch_id` = (SELECT `id` FROM `production_branches` WHERE `activity` = 'furniture' ORDER BY `id` LIMIT 1) WHERE `branch_id` IS NULL;--> statement-breakpoint
-- Dépenses de production déjà saisies : elles portent la filiale de leur lot.
UPDATE `expenses` SET `production_branch_id` = (SELECT `branch_id` FROM `brick_productions` p WHERE p.`id` = `expenses`.`reference_id`)
 WHERE `reference_type` = 'brick_production' AND `production_branch_id` IS NULL;--> statement-breakpoint
-- Caisse (option B : caisse générale, chaque mouvement porte sa filiale).
UPDATE `cash_movements` SET `production_branch_id` = (SELECT e.`production_branch_id` FROM `expenses` e WHERE e.`id` = `cash_movements`.`reference_id`)
 WHERE `reference_type` = 'expense' AND `production_branch_id` IS NULL;--> statement-breakpoint
UPDATE `cash_movements` SET `production_branch_id` = (SELECT v.`production_branch_id` FROM `sales_invoices` v WHERE v.`id` = `cash_movements`.`reference_id`)
 WHERE `reference_type` = 'sale' AND `production_branch_id` IS NULL;--> statement-breakpoint
-- Encaissements : le mouvement cite le reçu (« … — reçu REC-… ») ; le reçu donne le document.
UPDATE `cash_movements` SET `production_branch_id` = (
  SELECT CASE p.`type`
           WHEN 'sale' THEN (SELECT v.`production_branch_id` FROM `sales_invoices` v WHERE v.`id` = p.`reference_id`)
           WHEN 'brick_order' THEN (SELECT o.`branch_id` FROM `brick_orders` o WHERE o.`id` = p.`reference_id`)
           WHEN 'furniture_order' THEN (SELECT f.`branch_id` FROM `furniture_orders` f WHERE f.`id` = p.`reference_id`)
         END
    FROM `payments` p
   WHERE p.`store_id` = `cash_movements`.`store_id` AND p.`reference_id` = `cash_movements`.`reference_id`
     AND `cash_movements`.`motif` LIKE '%reçu ' || p.`receipt_number`
   LIMIT 1)
 WHERE `reference_type` = 'payment' AND `production_branch_id` IS NULL;--> statement-breakpoint
-- Icône du menu selon l'activité des filiales existantes.
UPDATE `production_branches` SET `icon` = CASE `activity` WHEN 'bricks' THEN 'bricks' WHEN 'furniture' THEN 'furniture' WHEN 'glass' THEN 'glass' ELSE 'factory' END;
