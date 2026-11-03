import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config/env.js';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>;

function resolveSqlitePath(url: string): string {
  const p = resolve(process.cwd(), url);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

function createDb() {
  if (config.db.driver !== 'sqlite') {
    throw new Error(
      '当前 Demo 内置 SQLite 驱动；如需 PostgreSQL，请安装 pg 并在 db/index.ts 中切换 drizzle-orm/node-postgres（其余代码无需改动）。',
    );
  }
  const file = resolveSqlitePath(config.db.url);
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return drizzle(sqlite, { schema });
}

export const db: Db = createDb();
export { schema };
