CREATE TABLE `project_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`project_code` text NOT NULL,
	`project_name` text NOT NULL,
	`payload` text NOT NULL,
	`closed_at` integer NOT NULL,
	`created_by_id` integer,
	`created_by_name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_snapshots_project` ON `project_snapshots` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_snapshots_closed` ON `project_snapshots` (`closed_at`);--> statement-breakpoint
ALTER TABLE `projects` ADD `closed_at` integer;
