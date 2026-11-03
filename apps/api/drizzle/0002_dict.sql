CREATE TABLE `environments` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`tone` text DEFAULT 'gray' NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resource_type_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type_code` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`field_type` text DEFAULT 'TEXT' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`default_value` text,
	`placeholder` text,
	`unit` text,
	`is_ip` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`type_code`) REFERENCES `resource_types`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_type_field` ON `resource_type_fields` (`type_code`,`key`);--> statement-breakpoint
CREATE INDEX `idx_type_field_type` ON `resource_type_fields` (`type_code`);--> statement-breakpoint
CREATE TABLE `resource_types` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`prefix` text NOT NULL,
	`description` text,
	`ip_unique_by_port` integer DEFAULT false NOT NULL,
	`list_columns` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
