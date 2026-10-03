CREATE TABLE `job_stages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`name` text NOT NULL,
	`service_id` integer,
	`responsible` text,
	`planned_date` text,
	`actual_date` text,
	`progress` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`comment` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `service_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_stages_sync_id_unique` ON `job_stages` (`sync_id`);--> statement-breakpoint
CREATE INDEX `job_stages_job_idx` ON `job_stages` (`job_id`);--> statement-breakpoint
CREATE TABLE `job_subcontracts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`supplier_id` integer NOT NULL,
	`work` text NOT NULL,
	`agreed_amount` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`user_id` integer,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `service_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_subcontracts_sync_id_unique` ON `job_subcontracts` (`sync_id`);--> statement-breakpoint
CREATE INDEX `job_subcontracts_job_idx` ON `job_subcontracts` (`job_id`);--> statement-breakpoint
CREATE TABLE `quote_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quote_id` integer NOT NULL,
	`service_id` integer,
	`service_name` text NOT NULL,
	`unit` text NOT NULL,
	`quantity` real NOT NULL,
	`unit_price` real NOT NULL,
	`discount_percent` real DEFAULT 0 NOT NULL,
	`amount` real NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quote_items_sync_id_unique` ON `quote_items` (`sync_id`);--> statement-breakpoint
CREATE INDEX `quote_items_quote_idx` ON `quote_items` (`quote_id`);--> statement-breakpoint
CREATE TABLE `quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`reference` text NOT NULL,
	`customer_id` integer NOT NULL,
	`request_id` integer,
	`date` text NOT NULL,
	`valid_until` text,
	`category` text,
	`title` text,
	`site_address` text,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
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
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `service_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_reference_unique` ON `quotes` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_sync_id_unique` ON `quotes` (`sync_id`);--> statement-breakpoint
CREATE INDEX `quotes_store_date_idx` ON `quotes` (`store_id`,`date`);--> statement-breakpoint
CREATE INDEX `quotes_customer_idx` ON `quotes` (`customer_id`);--> statement-breakpoint
CREATE TABLE `service_job_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`service_id` integer,
	`service_name` text NOT NULL,
	`unit` text NOT NULL,
	`quantity` real NOT NULL,
	`unit_price` real NOT NULL,
	`discount_percent` real DEFAULT 0 NOT NULL,
	`amount` real NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `service_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_job_items_sync_id_unique` ON `service_job_items` (`sync_id`);--> statement-breakpoint
CREATE INDEX `service_job_items_job_idx` ON `service_job_items` (`job_id`);--> statement-breakpoint
CREATE TABLE `service_price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`old_price` real NOT NULL,
	`new_price` real NOT NULL,
	`user_id` integer,
	`user_name` text,
	`date` text NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_price_history_sync_id_unique` ON `service_price_history` (`sync_id`);--> statement-breakpoint
CREATE INDEX `service_price_history_service_idx` ON `service_price_history` (`service_id`);--> statement-breakpoint
CREATE TABLE `service_request_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`service_id` integer,
	`service_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`request_id`) REFERENCES `service_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_request_items_sync_id_unique` ON `service_request_items` (`sync_id`);--> statement-breakpoint
CREATE INDEX `service_request_items_request_idx` ON `service_request_items` (`request_id`);--> statement-breakpoint
CREATE TABLE `service_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`reference` text NOT NULL,
	`customer_id` integer NOT NULL,
	`date` text NOT NULL,
	`need` text NOT NULL,
	`site_address` text,
	`desired_date` text,
	`status` text DEFAULT 'new' NOT NULL,
	`user_id` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`sync_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`origin_device_id` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_requests_reference_unique` ON `service_requests` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_requests_sync_id_unique` ON `service_requests` (`sync_id`);--> statement-breakpoint
CREATE INDEX `service_requests_store_idx` ON `service_requests` (`store_id`,`date`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`description` text,
	`unit` text DEFAULT 'forfait' NOT NULL,
	`unit_price` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
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
CREATE UNIQUE INDEX `services_sync_id_unique` ON `services` (`sync_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `services_store_code_unique` ON `services` (`store_id`,`code`);--> statement-breakpoint
CREATE INDEX `services_store_status_idx` ON `services` (`store_id`,`status`);--> statement-breakpoint
ALTER TABLE `service_jobs` ADD `responsible_user_id` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `service_jobs` ADD `actual_start_date` text;--> statement-breakpoint
ALTER TABLE `service_jobs` ADD `actual_end_date` text;--> statement-breakpoint
ALTER TABLE `service_jobs` ADD `progress` integer;--> statement-breakpoint
ALTER TABLE `service_jobs` ADD `quote_id` integer REFERENCES quotes(id);--> statement-breakpoint
ALTER TABLE `service_jobs` ADD `request_id` integer REFERENCES service_requests(id);--> statement-breakpoint
ALTER TABLE `suppliers` ADD `is_subcontractor` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `specialty` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
ALTER TABLE `workers` ADD `team` text;