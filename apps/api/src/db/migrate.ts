/**
 * 显式迁移入口：npm run db:migrate
 * PostgreSQL/DWS 使用 DB_SCHEMA；SQLite 继续使用 Drizzle 原生迁移。
 */
import { runAllMigrations } from './auto-migrate.js';

await runAllMigrations();
console.log('[db] 迁移完成');
process.exit(0);
