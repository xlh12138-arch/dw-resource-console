import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { db } from './index.js';
import { runPostgresMigrations } from './postgres-migrate.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 启动时自动执行迁移：两种驱动使用各自的原生迁移目录。 */
export async function runMigrations(): Promise<void> {
  if (!config.autoMigrate) return;
  await runAllMigrations();
}

/** 显式迁移入口：不受 AUTO_MIGRATE 影响，供 db-init 和命令行使用。 */
export async function runAllMigrations(): Promise<void> {
  if (config.db.driver === 'postgres') {
    await runPostgresMigrations(resolve(here, '../../drizzle-pg'));
    return;
  }
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  await migrate(db, { migrationsFolder: resolve(here, '../../drizzle') });
}
