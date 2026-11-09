import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config/env.js';
import type * as sqliteSchema from './schema.sqlite.js';

export type Db = BetterSQLite3Database<typeof sqliteSchema>;

function resolveSqlitePath(url: string): string {
  const path = resolve(process.cwd(), url);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

let sqliteClient: import('better-sqlite3').Database | null = null;
let pgPool: Pool | null = null;

async function createSqliteDatabase(schema: typeof sqliteSchema): Promise<Db> {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle: drizzleSqlite } = await import('drizzle-orm/better-sqlite3');
  const file = resolveSqlitePath(config.db.url);
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqliteClient = sqlite;
  return drizzleSqlite(sqlite, { schema }) as unknown as Db;
}

export function getPostgresPool(): Pool {
  if (!pgPool) throw new Error('PostgreSQL 连接池尚未初始化');
  return pgPool;
}

function createPostgresDatabase(schema: typeof import('./schema.pg.js')): Db {
  pgPool = new Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    connectionTimeoutMillis: 5000,
    // DWS/PostgreSQL 的搜索路径必须与 Drizzle 动态表 schema 保持一致，
    // 这样少量原生 SQL 里未加 schema 前缀的表名也能正确解析。
    options: `-c search_path=${config.db.schema}`,
    ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
  });
  return drizzlePostgres(pgPool, { schema }) as unknown as Db;
}

const rootDb =
  config.db.driver === 'postgres'
    ? createPostgresDatabase(await import('./schema.pg.js'))
    : await createSqliteDatabase(await import('./schema.sqlite.js'));

/**
 * PostgreSQL 的 transaction 支持异步回调；SQLite 的 better-sqlite3 不支持。
 * 业务仓储统一从 AsyncLocalStorage 取当前事务连接，因此服务层无需区分驱动。
 */
const transactionStorage = new AsyncLocalStorage<Db>();

export function getDb(): Db {
  return transactionStorage.getStore() ?? rootDb;
}

/** 跨驱动执行“最多取一行”的查询。 */
export async function firstRow<T>(query: unknown): Promise<T | undefined> {
  if (config.db.driver === 'postgres') {
    const rows = await (query as PromiseLike<T[]>);
    return rows[0];
  }
  return (query as { get(): T | undefined }).get();
}

/** 跨驱动执行原生 SQL，并尽力返回受影响行数。 */
export async function execSql(statement: SQL): Promise<{ changes: number }> {
  if (config.db.driver === 'postgres') {
    const result = await (
      db as unknown as { execute(query: SQL): Promise<{ rowCount: number | null }> }
    ).execute(statement);
    return { changes: result.rowCount ?? 0 };
  }
  return (await db.run(statement)) as unknown as { changes: number };
}

/**
 * 外层只暴露一个稳定的 Db 类型。实际运行时它是当前驱动的 Drizzle 实例，
 * 查询方言由实例内部决定，而不是由 TypeScript 类型决定。
 */
export const db = new Proxy({} as Db, {
  get(_target, property) {
    const active = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = active[property];
    return typeof value === 'function' ? value.bind(active) : value;
  },
});

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const sqliteTransactionMutex = new AsyncMutex();

interface AsyncTransactionRunner {
  transaction<T>(callback: (tx: Db) => Promise<T> | T): Promise<T>;
}

/**
 * 原子事务入口。所有包含“多表写入 + 审计”的写操作都应从这里进入。
 *
 * - PostgreSQL：使用连接池中的真实事务连接。
 * - SQLite：单连接执行 BEGIN IMMEDIATE / COMMIT / ROLLBACK，并用互斥锁
 *   防止其它事务请求加入同一连接。SQLite 驱动只适用于单进程部署。
 */
export async function withTransaction<T>(fn: () => Promise<T> | T): Promise<T> {
  if (transactionStorage.getStore()) return fn();

  if (config.db.driver === 'postgres') {
    const runner = rootDb as unknown as AsyncTransactionRunner;
    return runner.transaction((tx) => transactionStorage.run(tx, fn));
  }

  return sqliteTransactionMutex.run(async () => {
    await rootDb.run(sql`BEGIN IMMEDIATE`);
    try {
      const result = await transactionStorage.run(rootDb, async () => fn());
      await rootDb.run(sql`COMMIT`);
      return result;
    } catch (error) {
      await rootDb.run(sql`ROLLBACK`);
      throw error;
    }
  });
}

export async function closeDatabase(): Promise<void> {
  if (pgPool) {
    const pool = pgPool;
    pgPool = null;
    await pool.end();
  }
  if (sqliteClient) {
    const sqlite = sqliteClient;
    sqliteClient = null;
    sqlite.close();
  }
}
