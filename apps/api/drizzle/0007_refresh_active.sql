ALTER TABLE `refresh_tokens` ADD `last_used_at` integer DEFAULT (unixepoch() * 1000) NOT NULL;
