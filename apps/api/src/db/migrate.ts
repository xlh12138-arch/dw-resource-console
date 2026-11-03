/**
 * 迁移入口：npm run db:migrate
 * 迁移文件由 drizzle-kit 生成（db:generate），可回滚版本化，禁止手工改库。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const folder = resolve(here, '../../drizzle');

migrate(db, { migrationsFolder: folder });
// eslint-disable-next-line no-console
console.log('[db] 迁移完成');
process.exit(0);
