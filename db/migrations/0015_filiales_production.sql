CREATE TABLE `production_branch_customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`branch_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`user_id` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`branch_id`) REFERENCES `production_branches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_branch_customers_sync_id_unique` ON `production_branch_customers` (`sync_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `production_branch_customers_unique` ON `production_branch_customers` (`branch_id`,`customer_id`);--> statement-breakpoint
CREATE TABLE `production_branch_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`branch_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`level` text DEFAULT 'edit' NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`branch_id`) REFERENCES `production_branches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_branch_users_sync_id_unique` ON `production_branch_users` (`sync_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `production_branch_users_unique` ON `production_branch_users` (`branch_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `production_branches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`activity` text DEFAULT 'other' NOT NULL,
	`description` text,
	`store_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`stages` text DEFAULT '[{"key":"in_progress","label":"En cours"}]' NOT NULL,
	`loss_label` text DEFAULT 'Pertes' NOT NULL,
	`batch_prefix` text DEFAULT 'PRD' NOT NULL,
	`order_prefix` text DEFAULT 'CMD' NOT NULL,
	`access_mode` text DEFAULT 'all' NOT NULL,
	`customer_mode` text DEFAULT 'all' NOT NULL,
	`user_id` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_branches_sync_id_unique` ON `production_branches` (`sync_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `production_branches_name_unique` ON `production_branches` (`name`);--> statement-breakpoint
ALTER TABLE `brick_orders` ADD `branch_id` integer REFERENCES production_branches(id);--> statement-breakpoint
CREATE INDEX `brick_orders_branch_idx` ON `brick_orders` (`branch_id`);--> statement-breakpoint
ALTER TABLE `brick_productions` ADD `branch_id` integer REFERENCES production_branches(id);--> statement-breakpoint
CREATE INDEX `brick_productions_branch_idx` ON `brick_productions` (`branch_id`);--> statement-breakpoint
ALTER TABLE `brick_types` ADD `branch_id` integer REFERENCES production_branches(id);--> statement-breakpoint
ALTER TABLE `brick_types` ADD `category` text;--> statement-breakpoint
ALTER TABLE `brick_types` ADD `production_unit` text;--> statement-breakpoint
ALTER TABLE `brick_types` ADD `length` real;--> statement-breakpoint
ALTER TABLE `brick_types` ADD `width` real;--> statement-breakpoint
ALTER TABLE `brick_types` ADD `height` real;--> statement-breakpoint
ALTER TABLE `brick_types` ADD `thickness` real;--> statement-breakpoint
ALTER TABLE `brick_types` ADD `alert_threshold` real;--> statement-breakpoint
CREATE INDEX `brick_types_branch_idx` ON `brick_types` (`branch_id`);--> statement-breakpoint
ALTER TABLE `sales_invoices` ADD `production_branch_id` integer REFERENCES production_branches(id);--> statement-breakpoint
-- Reprise de la briqueterie (README §31.6) : elle devient la filiale « Briqueterie »,
-- ouverte à tous les magasins et à tous les comptes qui avaient déjà accès au module.
-- Ses étapes et ses préfixes de numéros (BRI, BCM) restent ceux de la v2.
INSERT INTO `production_branches` (`name`, `activity`, `description`, `status`, `color`, `sort_order`, `unit`, `stages`, `loss_label`, `batch_prefix`, `order_prefix`, `access_mode`, `customer_mode`, `created_at`, `sync_id`, `updated_at`)
SELECT 'Briqueterie', 'bricks', 'Fabrication et vente de briques.', 'active', 'warning', 1, 'pièce',
       '[{"key":"molding","label":"Moulage"},{"key":"drying","label":"Séchage"},{"key":"firing","label":"Cuisson"}]',
       'Cassées', 'BRI', 'BCM', 'all', 'all', unixepoch(),
       lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       unixepoch()
 WHERE NOT EXISTS (SELECT 1 FROM `production_branches` WHERE `name` = 'Briqueterie');--> statement-breakpoint
UPDATE `brick_types` SET `branch_id` = (SELECT `id` FROM `production_branches` WHERE `name` = 'Briqueterie'),
       `category` = CASE `shape` WHEN 'hollow' THEN 'Creuse' WHEN 'block' THEN 'Parpaing' ELSE 'Pleine' END
 WHERE `branch_id` IS NULL;--> statement-breakpoint
UPDATE `brick_productions` SET `branch_id` = (SELECT `id` FROM `production_branches` WHERE `name` = 'Briqueterie') WHERE `branch_id` IS NULL;--> statement-breakpoint
UPDATE `brick_orders` SET `branch_id` = (SELECT `id` FROM `production_branches` WHERE `name` = 'Briqueterie') WHERE `branch_id` IS NULL;--> statement-breakpoint
UPDATE `sales_invoices` SET `production_branch_id` = (SELECT `id` FROM `production_branches` WHERE `name` = 'Briqueterie')
 WHERE `channel` = 'brick' AND `production_branch_id` IS NULL;
