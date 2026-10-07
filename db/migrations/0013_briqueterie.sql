CREATE TABLE `brick_order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`brick_type_id` integer,
	`product_id` integer,
	`product_name` text NOT NULL,
	`unit` text DEFAULT 'pièce' NOT NULL,
	`quantity` real NOT NULL,
	`unit_price` real DEFAULT 0 NOT NULL,
	`discount` real DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`delivered_quantity` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`order_id`) REFERENCES `brick_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`brick_type_id`) REFERENCES `brick_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_order_items_sync_id_unique` ON `brick_order_items` (`sync_id`);--> statement-breakpoint
CREATE INDEX `brick_order_items_order_idx` ON `brick_order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `brick_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`order_number` text NOT NULL,
	`customer_id` integer,
	`customer_name` text NOT NULL,
	`user_id` integer,
	`date` text NOT NULL,
	`due_date` text,
	`delivery_date` text,
	`promised_date` text,
	`sub_total` real DEFAULT 0 NOT NULL,
	`discount` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`amount_paid` real DEFAULT 0 NOT NULL,
	`remaining_amount` real DEFAULT 0 NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sales_invoice_id` integer,
	`cancel_reason` text,
	`cancelled_by` integer,
	`cancelled_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sales_invoice_id`) REFERENCES `sales_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_orders_order_number_unique` ON `brick_orders` (`order_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `brick_orders_sync_id_unique` ON `brick_orders` (`sync_id`);--> statement-breakpoint
CREATE INDEX `brick_orders_store_idx` ON `brick_orders` (`store_id`);--> statement-breakpoint
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
	FOREIGN KEY (`production_id`) REFERENCES `brick_productions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_production_workers_sync_id_unique` ON `brick_production_workers` (`sync_id`);--> statement-breakpoint
CREATE INDEX `brick_production_workers_production_idx` ON `brick_production_workers` (`production_id`);--> statement-breakpoint
CREATE TABLE `brick_productions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`batch_number` text NOT NULL,
	`brick_type_id` integer NOT NULL,
	`planned_quantity` real DEFAULT 0 NOT NULL,
	`produced_quantity` real DEFAULT 0 NOT NULL,
	`broken_quantity` real DEFAULT 0 NOT NULL,
	`start_date` text,
	`end_date` text,
	`stage` text DEFAULT 'molding' NOT NULL,
	`status` text DEFAULT 'registered' NOT NULL,
	`team` text,
	`cancel_reason` text,
	`cancelled_at` integer,
	`cancelled_by` integer,
	`user_id` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`brick_type_id`) REFERENCES `brick_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_productions_batch_number_unique` ON `brick_productions` (`batch_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `brick_productions_sync_id_unique` ON `brick_productions` (`sync_id`);--> statement-breakpoint
CREATE INDEX `brick_productions_store_idx` ON `brick_productions` (`store_id`);--> statement-breakpoint
CREATE TABLE `brick_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`name` text NOT NULL,
	`shape` text DEFAULT 'solid' NOT NULL,
	`dimensions` text,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`user_id` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_types_sync_id_unique` ON `brick_types` (`sync_id`);--> statement-breakpoint
CREATE INDEX `brick_types_store_idx` ON `brick_types` (`store_id`);