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
	FOREIGN KEY (`order_id`) REFERENCES `brick_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brick_type_id`) REFERENCES `brick_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_order_items_sync_id_unique` ON `brick_order_items` (`sync_id`);--> statement-breakpoint
CREATE TABLE `brick_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brick_orders_order_number_unique` ON `brick_orders` (`order_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `brick_orders_sync_id_unique` ON `brick_orders` (`sync_id`);--> statement-breakpoint
ALTER TABLE `brick_productions` ADD `status` text DEFAULT 'registered' NOT NULL;--> statement-breakpoint
ALTER TABLE `brick_productions` ADD `team` text;--> statement-breakpoint
ALTER TABLE `brick_productions` ADD `expense_cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `brick_productions` ADD `cancel_reason` text;--> statement-breakpoint
ALTER TABLE `brick_productions` ADD `cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `brick_productions` ADD `cancelled_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `sales_invoices` ADD `channel` text DEFAULT 'general' NOT NULL;--> statement-breakpoint
UPDATE `brick_productions` SET `status` = 'finished' WHERE `stage` = 'stored';--> statement-breakpoint
UPDATE `brick_productions` SET `expense_cost` = 0, `total_cost` = `material_cost` + `labor_cost`;