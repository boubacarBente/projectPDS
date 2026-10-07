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
	FOREIGN KEY (`model_id`) REFERENCES `furniture_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_model_materials_sync_id_unique` ON `furniture_model_materials` (`sync_id`);--> statement-breakpoint
CREATE INDEX `furniture_model_materials_model_idx` ON `furniture_model_materials` (`model_id`);--> statement-breakpoint
CREATE TABLE `furniture_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`standard_dimensions` text,
	`labor_hours` real DEFAULT 0 NOT NULL,
	`sale_price` real DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
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
CREATE UNIQUE INDEX `furniture_models_sync_id_unique` ON `furniture_models` (`sync_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_models_store_code_unique` ON `furniture_models` (`store_id`,`code`);--> statement-breakpoint
CREATE TABLE `furniture_order_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`product_id` integer,
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
	FOREIGN KEY (`order_id`) REFERENCES `furniture_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_order_materials_sync_id_unique` ON `furniture_order_materials` (`sync_id`);--> statement-breakpoint
CREATE INDEX `furniture_order_materials_order_idx` ON `furniture_order_materials` (`order_id`);--> statement-breakpoint
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
	FOREIGN KEY (`order_id`) REFERENCES `furniture_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_order_workers_sync_id_unique` ON `furniture_order_workers` (`sync_id`);--> statement-breakpoint
CREATE INDEX `furniture_order_workers_order_idx` ON `furniture_order_workers` (`order_id`);--> statement-breakpoint
CREATE TABLE `furniture_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`order_number` text NOT NULL,
	`purpose` text DEFAULT 'customer' NOT NULL,
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
	`status` text DEFAULT 'active' NOT NULL,
	`cancel_reason` text,
	`cancelled_by` integer,
	`cancelled_at` integer,
	`total` real DEFAULT 0 NOT NULL,
	`amount_paid` real DEFAULT 0 NOT NULL,
	`remaining_amount` real DEFAULT 0 NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`product_id` integer,
	`user_id` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_id`) REFERENCES `furniture_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_orders_order_number_unique` ON `furniture_orders` (`order_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `furniture_orders_sync_id_unique` ON `furniture_orders` (`sync_id`);--> statement-breakpoint
CREATE INDEX `furniture_orders_store_idx` ON `furniture_orders` (`store_id`);--> statement-breakpoint
CREATE INDEX `furniture_orders_customer_idx` ON `furniture_orders` (`customer_id`);