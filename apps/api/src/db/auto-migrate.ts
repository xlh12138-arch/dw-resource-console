import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { db } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 启动时自动执行迁移：两种驱动使用各自的原生迁移目录。 */
export async function runMigrations(): Promise<void> {
  if (!config.autoMigrate) return;
  if (config.db.driver === 'postgres') {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(db as unknown as Parameters<typeof migrate>[0], {
      migrationsFolder: resolve(here, '../../drizzle-pg'),
    });
    return;
  }
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  await migrate(db, { migrationsFolder: resolve(here, '../../drizzle') });
}
