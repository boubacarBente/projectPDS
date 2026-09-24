CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`user_name` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer,
	`details` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_logs_sync_id_unique` ON `audit_logs` (`sync_id`);--> statement-breakpoint
CREATE TABLE `brick_production_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`production_id` integer NOT NULL,
	`product_id` integer,
	`product_code` text NOT NULL,
	`product_name` text NOT NULL,
	`unit` text DEFAULT 'kg' NOT NULL,
	`quantity` real NOT NULL,
	`unit_cost` real DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`production_id`) REFERENCES `brick_productions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_production_materials_sync_id_unique` ON `brick_production_materials` (`sync_id`);--> statement-breakpoint
CREATE TABLE `brick_production_workers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`production_id` integer NOT NULL,
	`worker_id` integer,
	`worker_name` text NOT NULL,
	`role` text,
	`days` real DEFAULT 0 NOT NULL,
	`daily_rate` real DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`production_id`) REFERENCES `brick_productions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_production_workers_sync_id_unique` ON `brick_production_workers` (`sync_id`);--> statement-breakpoint
CREATE TABLE `brick_productions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_number` text NOT NULL,
	`brick_type_id` integer NOT NULL,
	`planned_quantity` real DEFAULT 0 NOT NULL,
	`produced_quantity` real DEFAULT 0 NOT NULL,
	`broken_quantity` real DEFAULT 0 NOT NULL,
	`start_date` text,
	`end_date` text,
	`stage` text DEFAULT 'molding' NOT NULL,
	`material_cost` real DEFAULT 0 NOT NULL,
	`labor_cost` real DEFAULT 0 NOT NULL,
	`total_cost` real DEFAULT 0 NOT NULL,
	`user_id` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`brick_type_id`) REFERENCES `brick_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_productions_batch_number_unique` ON `brick_productions` (`batch_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `brick_productions_sync_id_unique` ON `brick_productions` (`sync_id`);--> statement-breakpoint
CREATE TABLE `brick_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`name` text NOT NULL,
	`shape` text DEFAULT 'solid' NOT NULL,
	`dimensions` text,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_types_sync_id_unique` ON `brick_types` (`sync_id`);--> statement-breakpoint
CREATE TABLE `cash_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`amount` real NOT NULL,
	`payment_method` text DEFAULT 'Espèces' NOT NULL,
	`motif` text NOT NULL,
	`reference_type` text,
	`reference_id` integer,
	`session_id` integer,
	`balance_after` real DEFAULT 0 NOT NULL,
	`date` text NOT NULL,
	`user_id` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `cash_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_movements_sync_id_unique` ON `cash_movements` (`sync_id`);--> statement-breakpoint
CREATE TABLE `cash_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` integer NOT NULL,
	`opened_by` integer,
	`opening_amount` real DEFAULT 0 NOT NULL,
	`closed_at` integer,
	`closed_by` integer,
	`theoretical_amount` real,
	`counted_amount` real,
	`difference` real,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`opened_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_sessions_sync_id_unique` ON `cash_sessions` (`sync_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'finished' NOT NULL,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_sync_id_unique` ON `categories` (`sync_id`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`address` text,
	`notes` text,
	`credit_limit` real DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_sync_id_unique` ON `customers` (`sync_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`name` text NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`last_push_at` integer,
	`last_pull_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_device_id_unique` ON `devices` (`device_id`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`amount` real NOT NULL,
	`description` text,
	`payment_method` text DEFAULT 'Espèces' NOT NULL,
	`reference_type` text,
	`reference_id` integer,
	`beneficiary` text,
	`date` text NOT NULL,
	`user_id` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_sync_id_unique` ON `expenses` (`sync_id`);--> statement-breakpoint
CREATE TABLE `furniture_model_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`model_id`) REFERENCES `furniture_models`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_model_materials_sync_id_unique` ON `furniture_model_materials` (`sync_id`);--> statement-breakpoint
CREATE TABLE `furniture_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`standard_dimensions` text,
	`labor_hours` real DEFAULT 0 NOT NULL,
	`sale_price` real DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_models_code_unique` ON `furniture_models` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_models_sync_id_unique` ON `furniture_models` (`sync_id`);--> statement-breakpoint
CREATE TABLE `furniture_order_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`product_id` integer,
	`product_code` text NOT NULL,
	`product_name` text NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`quantity` real NOT NULL,
	`wastage_quantity` real DEFAULT 0 NOT NULL,
	`unit_cost` real DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`order_id`) REFERENCES `furniture_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_order_materials_sync_id_unique` ON `furniture_order_materials` (`sync_id`);--> statement-breakpoint
CREATE TABLE `furniture_order_workers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`worker_id` integer,
	`worker_name` text NOT NULL,
	`role` text,
	`days` real DEFAULT 0 NOT NULL,
	`daily_rate` real DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`order_id`) REFERENCES `furniture_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_order_workers_sync_id_unique` ON `furniture_order_workers` (`sync_id`);--> statement-breakpoint
CREATE TABLE `furniture_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_number` text NOT NULL,
	`customer_id` integer,
	`customer_name` text,
	`model_id` integer,
	`model_name` text,
	`is_custom` integer DEFAULT false NOT NULL,
	`dimensions` text,
	`finish` text,
	`quantity` real DEFAULT 1 NOT NULL,
	`start_date` text,
	`promised_date` text,
	`delivery_date` text,
	`stage` text DEFAULT 'cutting' NOT NULL,
	`material_cost` real DEFAULT 0 NOT NULL,
	`labor_cost` real DEFAULT 0 NOT NULL,
	`total_cost` real DEFAULT 0 NOT NULL,
	`agreed_price` real DEFAULT 0 NOT NULL,
	`amount_paid` real DEFAULT 0 NOT NULL,
	`product_id` integer,
	`user_id` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_id`) REFERENCES `furniture_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_orders_order_number_unique` ON `furniture_orders` (`order_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_orders_sync_id_unique` ON `furniture_orders` (`sync_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`receipt_number` text NOT NULL,
	`type` text NOT NULL,
	`reference_id` integer NOT NULL,
	`amount` real NOT NULL,
	`payment_method` text DEFAULT 'Espèces' NOT NULL,
	`payment_label` text DEFAULT 'full' NOT NULL,
	`date` text NOT NULL,
	`notes` text,
	`user_id` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_receipt_number_unique` ON `payments` (`receipt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_sync_id_unique` ON `payments` (`sync_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`category_id` integer,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`purchase_price` real DEFAULT 0 NOT NULL,
	`sale_price` real DEFAULT 0 NOT NULL,
	`stock` real DEFAULT 0 NOT NULL,
	`stock_min` real DEFAULT 0 NOT NULL,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_code_unique` ON `products` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_sync_id_unique` ON `products` (`sync_id`);--> statement-breakpoint
CREATE TABLE `purchase_invoice_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`product_id` integer,
	`product_code` text NOT NULL,
	`product_name` text NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`quantity` real NOT NULL,
	`unit_price` real NOT NULL,
	`amount` real NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `purchase_invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_invoice_items_sync_id_unique` ON `purchase_invoice_items` (`sync_id`);--> statement-breakpoint
CREATE TABLE `purchase_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reference` text NOT NULL,
	`supplier_reference` text,
	`supplier_id` integer,
	`user_id` integer,
	`date` text NOT NULL,
	`due_date` text,
	`total` real DEFAULT 0 NOT NULL,
	`amount_paid` real DEFAULT 0 NOT NULL,
	`remaining_amount` real DEFAULT 0 NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`payment_method` text DEFAULT 'Espèces' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cancel_reason` text,
	`cancelled_by` integer,
	`cancelled_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_invoices_reference_unique` ON `purchase_invoices` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_invoices_sync_id_unique` ON `purchase_invoices` (`sync_id`);--> statement-breakpoint
CREATE TABLE `report_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period` text DEFAULT 'day' NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`channel` text DEFAULT 'whatsapp' NOT NULL,
	`recipients` text NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`error` text,
	`triggered_by` text DEFAULT 'manual' NOT NULL,
	`user_id` integer,
	`sent_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_deliveries_sync_id_unique` ON `report_deliveries` (`sync_id`);--> statement-breakpoint
CREATE TABLE `sales_invoice_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`product_id` integer,
	`product_code` text NOT NULL,
	`product_name` text NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`quantity` real NOT NULL,
	`unit_price` real NOT NULL,
	`discount` real DEFAULT 0 NOT NULL,
	`amount` real NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `sales_invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_invoice_items_sync_id_unique` ON `sales_invoice_items` (`sync_id`);--> statement-breakpoint
CREATE TABLE `sales_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_number` text NOT NULL,
	`customer_id` integer,
	`customer_name` text NOT NULL,
	`user_id` integer,
	`date` text NOT NULL,
	`due_date` text,
	`sub_total` real DEFAULT 0 NOT NULL,
	`discount` real DEFAULT 0 NOT NULL,
	`total_ht` real DEFAULT 0 NOT NULL,
	`tax_rate` real DEFAULT 0 NOT NULL,
	`tax_amount` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`amount_paid` real DEFAULT 0 NOT NULL,
	`remaining_amount` real DEFAULT 0 NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`payment_method` text DEFAULT 'Espèces' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cancel_reason` text,
	`cancelled_by` integer,
	`cancelled_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_invoices_invoice_number_unique` ON `sales_invoices` (`invoice_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_invoices_sync_id_unique` ON `sales_invoices` (`sync_id`);--> statement-breakpoint
CREATE TABLE `service_job_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`product_id` integer,
	`product_code` text NOT NULL,
	`product_name` text NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`quantity` real NOT NULL,
	`unit_cost` real DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `service_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_job_materials_sync_id_unique` ON `service_job_materials` (`sync_id`);--> statement-breakpoint
CREATE TABLE `service_job_workers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`worker_id` integer,
	`worker_name` text NOT NULL,
	`role` text,
	`days` real DEFAULT 0 NOT NULL,
	`daily_rate` real DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `service_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_job_workers_sync_id_unique` ON `service_job_workers` (`sync_id`);--> statement-breakpoint
CREATE TABLE `service_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reference` text NOT NULL,
	`customer_id` integer NOT NULL,
	`category` text DEFAULT 'placo' NOT NULL,
	`title` text,
	`site_address` text,
	`description` text,
	`start_date` text,
	`end_date` text,
	`status` text DEFAULT 'quote' NOT NULL,
	`quote_status` text DEFAULT 'draft' NOT NULL,
	`quote_materials` real DEFAULT 0 NOT NULL,
	`quote_labor` real DEFAULT 0 NOT NULL,
	`quote_total` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`amount_paid` real DEFAULT 0 NOT NULL,
	`remaining_amount` real DEFAULT 0 NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`user_id` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_jobs_reference_unique` ON `service_jobs` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_jobs_sync_id_unique` ON `service_jobs` (`sync_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_sync_id_unique` ON `settings` (`sync_id`);--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`type` text NOT NULL,
	`quantity` real NOT NULL,
	`motif` text NOT NULL,
	`stock_before` real NOT NULL,
	`stock_after` real NOT NULL,
	`reference_type` text,
	`reference_id` integer,
	`user_id` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_movements_sync_id_unique` ON `stock_movements` (`sync_id`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`address` text,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppliers_sync_id_unique` ON `suppliers` (`sync_id`);--> statement-breakpoint
CREATE TABLE `sync_conflicts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_name` text NOT NULL,
	`sync_id` text NOT NULL,
	`local_payload` text NOT NULL,
	`remote_payload` text NOT NULL,
	`resolution` text DEFAULT 'pending' NOT NULL,
	`resolved_at` integer,
	`resolved_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_name` text NOT NULL,
	`sync_id` text NOT NULL,
	`operation` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_pending` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_name` text NOT NULL,
	`sync_id` text NOT NULL,
	`payload` text NOT NULL,
	`missing_parent` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_state_key_unique` ON `sync_state` (`key`);--> statement-breakpoint
CREATE TABLE `user_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`action` text NOT NULL,
	`effect` text NOT NULL,
	`granted_by` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_permissions_sync_id_unique` ON `user_permissions` (`sync_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_permissions_user_action_unique` ON `user_permissions` (`user_id`,`action`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'seller' NOT NULL,
	`phone` text,
	`is_active` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_sync_id_unique` ON `users` (`sync_id`);--> statement-breakpoint
CREATE TABLE `workers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`role` text DEFAULT 'worker' NOT NULL,
	`specialty` text,
	`daily_rate` real DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workers_sync_id_unique` ON `workers` (`sync_id`);