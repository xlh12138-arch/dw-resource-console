import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { config } from '../config/env.js';
import { db, withTransaction } from './index.js';

const MIGRATION_TABLE = '__dw_schema_migrations';

interface PgQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

async function executeRows<T>(statement: SQL): Promise<T[]> {
  const result = await (
    db as unknown as { execute(query: SQL): Promise<PgQueryResult<T>> }
  ).execute(statement);
  return result.rows;
}

async function execute(statement: SQL): Promise<PgQueryResult<unknown>> {
  return (db as unknown as { execute(query: SQL): Promise<PgQueryResult<unknown>> }).execute(statement);
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`非法 PostgreSQL schema：${value}`);
  }
  return `"${value}"`;
}

/**
 * PostgreSQL / DWS 迁移：
 * - 表建立在 DB_SCHEMA 指定的 schema；
 * - 兼容旧迁移文件中写死的 public 外键引用；
 * - 使用项目自己的迁移记录表，重复启动不会重复建表。
 */
export async function runPostgresMigrations(migrationsFolder: string): Promise<void> {
  const schema = quoteIdentifier(config.db.schema);
  const folder = resolve(migrationsFolder);
  const files = readdirSync(folder)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  if (config.db.createSchema) {
    await execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`));
  }

  await withTransaction(async () => {
    await execute(sql.raw(`SET LOCAL search_path TO ${schema}`));
    await execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS ${schema}.${quoteIdentifier(MIGRATION_TABLE)} (` +
          'name text PRIMARY KEY NOT NULL, applied_at timestamp with time zone NOT NULL DEFAULT now())',
      ),
    );

    const appliedRows = await executeRows<{ name: string }>(
      sql.raw(`SELECT name FROM ${schema}.${quoteIdentifier(MIGRATION_TABLE)}`),
    );
    const applied = new Set(appliedRows.map((row) => row.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const content = readFileSync(resolve(folder, file), 'utf8');
      const statements = content
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) {
        // Drizzle 旧迁移文件把外键目标固定写成 public，这里统一切换到配置 schema。
        const schemaAware = statement.split('"public".').join(`${schema}.`);
        await execute(sql.raw(schemaAware));
      }

      await execute(
        sql.raw(
          `INSERT INTO ${schema}.${quoteIdentifier(MIGRATION_TABLE)} (name) VALUES ('${file.replaceAll("'", "''")}')`,
        ),
      );
    }
  });
}
