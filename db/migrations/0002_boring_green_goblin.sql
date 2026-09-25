DROP INDEX `products_code_unique`;--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `code`;--> statement-breakpoint
ALTER TABLE `brick_production_materials` DROP COLUMN `product_code`;--> statement-breakpoint
ALTER TABLE `furniture_order_materials` DROP COLUMN `product_code`;--> statement-breakpoint
ALTER TABLE `purchase_invoice_items` DROP COLUMN `product_code`;--> statement-breakpoint
ALTER TABLE `sales_invoice_items` DROP COLUMN `product_code`;--> statement-breakpoint
ALTER TABLE `service_job_materials` DROP COLUMN `product_code`;