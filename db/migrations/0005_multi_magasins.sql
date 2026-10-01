CREATE TABLE `doc_sequences` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inventories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reference` text NOT NULL,
	`store_id` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`category_id` integer,
	`opened_by` integer,
	`validated_by` integer,
	`validated_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opened_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`validated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventories_reference_unique` ON `inventories` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventories_sync_id_unique` ON `inventories` (`sync_id`);--> statement-breakpoint
CREATE INDEX `inventories_store_idx` ON `inventories` (`store_id`,`status`);--> statement-breakpoint
CREATE TABLE `inventory_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`inventory_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`expected_quantity` real DEFAULT 0 NOT NULL,
	`counted_quantity` real,
	`justification` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`inventory_id`) REFERENCES `inventories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_sync_id_unique` ON `inventory_items` (`sync_id`);--> statement-breakpoint
CREATE INDEX `inventory_items_inventory_idx` ON `inventory_items` (`inventory_id`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`username` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_failure_at` integer
);
--> statement-breakpoint
CREATE TABLE `product_stocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	`stock_min` real,
	`sale_price` real,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_stocks_sync_id_unique` ON `product_stocks` (`sync_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_stocks_store_product_unique` ON `product_stocks` (`store_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `product_stocks_product_idx` ON `product_stocks` (`product_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`store_id` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stock_transfer_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transfer_id` integer NOT NULL,
	`event` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`store_id` integer,
	`user_id` integer,
	`user_name` text,
	`note` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_transfer_events_sync_id_unique` ON `stock_transfer_events` (`sync_id`);--> statement-breakpoint
CREATE INDEX `stock_transfer_events_transfer_idx` ON `stock_transfer_events` (`transfer_id`);--> statement-breakpoint
CREATE TABLE `stock_transfer_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transfer_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`quantity_requested` real NOT NULL,
	`quantity_shipped` real DEFAULT 0 NOT NULL,
	`quantity_received` real DEFAULT 0 NOT NULL,
	`discrepancy_note` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_transfer_items_sync_id_unique` ON `stock_transfer_items` (`sync_id`);--> statement-breakpoint
CREATE INDEX `stock_transfer_items_transfer_idx` ON `stock_transfer_items` (`transfer_id`);--> statement-breakpoint
CREATE TABLE `stock_transfers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reference` text NOT NULL,
	`source_store_id` integer NOT NULL,
	`destination_store_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`reason` text,
	`requested_date` text,
	`requested_by` integer,
	`approved_by` integer,
	`approved_at` integer,
	`shipped_by` integer,
	`shipped_at` integer,
	`received_by` integer,
	`received_at` integer,
	`closed_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`source_store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shipped_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_transfers_reference_unique` ON `stock_transfers` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `stock_transfers_sync_id_unique` ON `stock_transfers` (`sync_id`);--> statement-breakpoint
CREATE INDEX `stock_transfers_source_idx` ON `stock_transfers` (`source_store_id`,`status`);--> statement-breakpoint
CREATE INDEX `stock_transfers_destination_idx` ON `stock_transfers` (`destination_store_id`,`status`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'store' NOT NULL,
	`address` text,
	`phone` text,
	`email` text,
	`manager_user_id` integer,
	`opening_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`opening_hours` text,
	`receipt_footer` text,
	`settings` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`manager_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stores_code_unique` ON `stores` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `stores_sync_id_unique` ON `stores` (`sync_id`);--> statement-breakpoint
CREATE TABLE `sync_changes` (
	`table_name` text NOT NULL,
	`sync_id` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`change_seq` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	PRIMARY KEY(`table_name`, `sync_id`)
);
--> statement-breakpoint
CREATE TABLE `user_stores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`store_id` integer NOT NULL,
	`is_manager` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`starts_at` text,
	`ends_at` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_stores_sync_id_unique` ON `user_stores` (`sync_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_stores_user_store_unique` ON `user_stores` (`user_id`,`store_id`);--> statement-breakpoint
DROP TABLE `sync_outbox`;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `store_id` integer;--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_store_idx` ON `audit_logs` (`store_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity`,`entity_id`);--> statement-breakpoint
ALTER TABLE `cash_movements` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
CREATE INDEX `cash_movements_store_date_idx` ON `cash_movements` (`store_id`,`date`);--> statement-breakpoint
CREATE INDEX `cash_movements_session_idx` ON `cash_movements` (`session_id`);--> statement-breakpoint
ALTER TABLE `cash_sessions` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
CREATE INDEX `cash_sessions_store_status_idx` ON `cash_sessions` (`store_id`,`status`);--> statement-breakpoint
ALTER TABLE `expenses` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
ALTER TABLE `expenses` ADD `approval_status` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` ADD `approved_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `expenses` ADD `approved_at` integer;--> statement-breakpoint
CREATE INDEX `expenses_store_date_idx` ON `expenses` (`store_id`,`date`);--> statement-breakpoint
ALTER TABLE `payments` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
CREATE INDEX `payments_reference_idx` ON `payments` (`type`,`reference_id`);--> statement-breakpoint
CREATE INDEX `payments_store_date_idx` ON `payments` (`store_id`,`date`);--> statement-breakpoint
ALTER TABLE `products` ADD `barcode` text;--> statement-breakpoint
ALTER TABLE `purchase_invoices` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
CREATE INDEX `purchase_invoices_store_date_idx` ON `purchase_invoices` (`store_id`,`date`);--> statement-breakpoint
CREATE INDEX `purchase_invoices_supplier_idx` ON `purchase_invoices` (`supplier_id`);--> statement-breakpoint
ALTER TABLE `report_deliveries` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
ALTER TABLE `sales_invoices` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
CREATE INDEX `sales_invoices_store_date_idx` ON `sales_invoices` (`store_id`,`date`);--> statement-breakpoint
CREATE INDEX `sales_invoices_customer_idx` ON `sales_invoices` (`customer_id`);--> statement-breakpoint
ALTER TABLE `service_jobs` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
CREATE INDEX `service_jobs_store_idx` ON `service_jobs` (`store_id`);--> statement-breakpoint
CREATE INDEX `service_jobs_customer_idx` ON `service_jobs` (`customer_id`);--> statement-breakpoint
ALTER TABLE `stock_movements` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
CREATE INDEX `stock_movements_store_product_idx` ON `stock_movements` (`store_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_reference_idx` ON `stock_movements` (`reference_type`,`reference_id`);--> statement-breakpoint
CREATE INDEX `purchase_invoice_items_invoice_idx` ON `purchase_invoice_items` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `sales_invoice_items_invoice_idx` ON `sales_invoice_items` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `sales_invoice_items_product_idx` ON `sales_invoice_items` (`product_id`);--> statement-breakpoint
CREATE INDEX `service_job_materials_job_idx` ON `service_job_materials` (`job_id`);--> statement-breakpoint
CREATE INDEX `service_job_workers_job_idx` ON `service_job_workers` (`job_id`);--> statement-breakpoint
-- Migration des données existantes (§18) : un poste déjà en service devient
-- le « Magasin principal ». Une installation neuve (aucun utilisateur) ne crée
-- rien : son premier magasin est créé à l'installation, ou reçu du serveur.
INSERT INTO `stores` (`code`, `name`, `kind`, `address`, `phone`, `email`, `status`, `created_at`, `sync_id`, `updated_at`)
SELECT 'PRINC',
       'Magasin principal',
       'store',
       NULLIF((SELECT `value` FROM `settings` WHERE `key` = 'company_address'), ''),
       NULLIF((SELECT `value` FROM `settings` WHERE `key` = 'company_phone'), ''),
       NULLIF((SELECT `value` FROM `settings` WHERE `key` = 'company_email'), ''),
       'active', unixepoch(), lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), unixepoch()
WHERE EXISTS (SELECT 1 FROM `users`);
--> statement-breakpoint
UPDATE `audit_logs` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `cash_movements` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `cash_sessions` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `expenses` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `payments` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `purchase_invoices` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `report_deliveries` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `sales_invoices` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `service_jobs` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
UPDATE `stock_movements` SET `store_id` = (SELECT `id` FROM `stores` WHERE `code` = 'PRINC') WHERE `store_id` IS NULL;
--> statement-breakpoint
-- Invariant « stock = somme des mouvements » : un éventuel écart historique est
-- régularisé par un mouvement d'ajustement explicite, pour que le recalcul du
-- stock depuis les mouvements (synchronisation) retombe exactement sur le stock
-- actuel.
INSERT INTO `stock_movements` (`store_id`, `product_id`, `type`, `quantity`, `motif`, `stock_before`, `stock_after`, `reference_type`, `created_at`, `sync_id`, `updated_at`)
SELECT s.`id`, p.`id`, 'adjustment',
       p.`stock` - COALESCE((SELECT SUM(CASE m.`type` WHEN 'exit' THEN -m.`quantity` ELSE m.`quantity` END) FROM `stock_movements` m WHERE m.`product_id` = p.`id`), 0),
       'Reprise du stock existant (passage au multi-magasins)',
       COALESCE((SELECT SUM(CASE m.`type` WHEN 'exit' THEN -m.`quantity` ELSE m.`quantity` END) FROM `stock_movements` m WHERE m.`product_id` = p.`id`), 0),
       p.`stock`, 'inventory', unixepoch(),
       lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       unixepoch()
FROM `products` p CROSS JOIN `stores` s
WHERE s.`code` = 'PRINC'
  AND abs(p.`stock` - COALESCE((SELECT SUM(CASE m.`type` WHEN 'exit' THEN -m.`quantity` ELSE m.`quantity` END) FROM `stock_movements` m WHERE m.`product_id` = p.`id`), 0)) > 0.0005;
--> statement-breakpoint
INSERT INTO `product_stocks` (`store_id`, `product_id`, `quantity`, `created_at`, `sync_id`, `updated_at`)
SELECT s.`id`, p.`id`, p.`stock`, unixepoch(), 'ps-' || s.`sync_id` || '-' || p.`sync_id`, unixepoch()
FROM `products` p CROSS JOIN `stores` s WHERE s.`code` = 'PRINC';
--> statement-breakpoint
INSERT INTO `user_stores` (`user_id`, `store_id`, `is_manager`, `is_active`, `created_at`, `sync_id`, `updated_at`)
SELECT u.`id`, s.`id`, CASE WHEN u.`role` = 'manager' THEN 1 ELSE 0 END, 1, unixepoch(), 'us-' || u.`sync_id` || '-' || s.`sync_id`, unixepoch()
FROM `users` u CROSS JOIN `stores` s WHERE s.`code` = 'PRINC';
--> statement-breakpoint
UPDATE `stores` SET `manager_user_id` = (SELECT `id` FROM `users` WHERE `role` = 'manager' AND `is_active` = 1 ORDER BY `id` LIMIT 1) WHERE `code` = 'PRINC';
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `stock`;
