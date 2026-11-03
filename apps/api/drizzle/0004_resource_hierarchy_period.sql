ALTER TABLE `env_slots` ADD `start_at` integer;--> statement-breakpoint
ALTER TABLE `env_slots` ADD `end_at` integer;--> statement-breakpoint
ALTER TABLE `env_slots` ADD `renew_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `env_slots` ADD `updated_at` integer;--> statement-breakpoint
CREATE INDEX `idx_env_slots_period` ON `env_slots` (`start_at`,`end_at`);--> statement-breakpoint
ALTER TABLE `resources` ADD `parent_id` integer REFERENCES resources(id);--> statement-breakpoint
ALTER TABLE `resources` ADD `demand_amount` real;--> statement-breakpoint
CREATE INDEX `idx_resources_parent` ON `resources` (`parent_id`);