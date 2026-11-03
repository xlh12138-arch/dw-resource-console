CREATE TABLE `env_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`environment_id` integer NOT NULL,
	`resource_type` text NOT NULL,
	`slot_role` text NOT NULL,
	`resource_id` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`remark` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `project_environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_env_slots_env` ON `env_slots` (`environment_id`);--> statement-breakpoint
CREATE INDEX `idx_env_slots_resource` ON `env_slots` (`resource_id`);--> statement-breakpoint
CREATE TABLE `env_template_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_id` integer NOT NULL,
	`resource_type` text NOT NULL,
	`slot_role` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`remark` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `env_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_template_items_template` ON `env_template_items` (`template_id`);--> statement-breakpoint
CREATE TABLE `env_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`builtin` integer DEFAULT false NOT NULL,
	`created_by_id` integer,
	`created_by_name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_env_templates_code` ON `env_templates` (`code`);--> statement-breakpoint
CREATE TABLE `project_environments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`environment` text NOT NULL,
	`status` text DEFAULT 'PLANNING' NOT NULL,
	`template_id` integer,
	`owner` text,
	`description` text,
	`created_by_id` integer,
	`created_by_name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `env_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_env` ON `project_environments` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_project_env_project` ON `project_environments` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`owner` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`created_by_id` integer,
	`created_by_name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_projects_code` ON `projects` (`code`);--> statement-breakpoint
CREATE INDEX `idx_projects_status` ON `projects` (`status`);--> statement-breakpoint
ALTER TABLE `resources` ADD `project_id` integer REFERENCES projects(id);--> statement-breakpoint
ALTER TABLE `resources` ADD `project_env_id` integer REFERENCES project_environments(id);--> statement-breakpoint
CREATE INDEX `idx_resources_project` ON `resources` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_resources_project_env` ON `resources` (`project_env_id`);