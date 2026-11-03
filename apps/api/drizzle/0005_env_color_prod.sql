ALTER TABLE `environments` ADD `color` text;--> statement-breakpoint
UPDATE `environments` SET `color` = '#2563eb' WHERE `code` = 'DEV' AND `color` IS NULL;--> statement-breakpoint
UPDATE `environments` SET `color` = '#d97706' WHERE `code` = 'PT' AND `color` IS NULL;--> statement-breakpoint
UPDATE `environments` SET `color` = '#7c3aed' WHERE `code` = 'UAT' AND `color` IS NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `environments` (`code`, `label`, `tone`, `color`, `description`, `enabled`, `builtin`, `sort_order`) VALUES ('PROD', '生产', 'green', '#dc2626', '生产环境，直接承载线上业务，变更需走审批与变更窗口', 1, 1, 3);
