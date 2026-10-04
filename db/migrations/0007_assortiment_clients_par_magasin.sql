ALTER TABLE `customers` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
CREATE INDEX `customers_store_idx` ON `customers` (`store_id`);--> statement-breakpoint
ALTER TABLE `product_stocks` ADD `is_listed` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `owner_store_id` integer REFERENCES stores(id);--> statement-breakpoint
ALTER TABLE `suppliers` ADD `store_id` integer REFERENCES stores(id);--> statement-breakpoint
CREATE INDEX `suppliers_store_idx` ON `suppliers` (`store_id`);