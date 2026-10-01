DROP TABLE `brick_order_items`;--> statement-breakpoint
DROP TABLE `brick_orders`;--> statement-breakpoint
DROP TABLE `brick_production_materials`;--> statement-breakpoint
DROP TABLE `brick_production_workers`;--> statement-breakpoint
DROP TABLE `brick_productions`;--> statement-breakpoint
DROP TABLE `brick_types`;--> statement-breakpoint
DROP TABLE `furniture_model_materials`;--> statement-breakpoint
DROP TABLE `furniture_models`;--> statement-breakpoint
DROP TABLE `furniture_order_materials`;--> statement-breakpoint
DROP TABLE `furniture_order_workers`;--> statement-breakpoint
DROP TABLE `furniture_orders`;--> statement-breakpoint
UPDATE `sales_invoices` SET `channel` = 'general' WHERE `channel` = 'brick';--> statement-breakpoint
UPDATE `users` SET `role` = 'storekeeper' WHERE `role` IN ('carpenter', 'brickmaker');--> statement-breakpoint
DELETE FROM `user_permissions` WHERE `action` LIKE 'brick.%' OR `action` LIKE 'furniture.%';--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('brick_prefix', 'brick_order_prefix', 'furniture_prefix');
