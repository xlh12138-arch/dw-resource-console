import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { db } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 启动时自动执行迁移：开发环境开箱即用；生产建议单独执行 npm run db:migrate */
export async function runMigrations(): Promise<void> {
  if (!config.autoMigrate) return;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  // src/db → apps/api/drizzle（编译后 dist/db → apps/api/drizzle）
  migrate(db, { migrationsFolder: resolve(here, '../../drizzle') });
}
