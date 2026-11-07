import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../config/env.js';
import { getPostgresPool } from './index.js';

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error(`非法 schema 名称：${value}`);
  return `"${value}"`;
}

function rewriteSchema(sql: string, sourceSchema: string, targetSchema: string): string {
  const source = quoteIdentifier(sourceSchema);
  const target = quoteIdentifier(targetSchema);
  let next = sql.split(`${source}.`).join(`${target}.`);
  next = next.replace(
    new RegExp(`(^|[^A-Za-z0-9_])${sourceSchema}\\.`, 'gm'),
    (_match, prefix: string) => `${prefix}${target}.`,
  );
  return next;
}

async function main(): Promise<void> {
  const schema = quoteIdentifier(config.db.schema);
  const file = process.env.DB_IMPORT_FILE || '/import/data.sql';
  const format = (process.env.DB_IMPORT_FORMAT || 'auto').toLowerCase();
  const sourceSchema = process.env.DB_IMPORT_SOURCE_SCHEMA || 'public';
  quoteIdentifier(sourceSchema);

  if (format !== 'sql' && !(format === 'auto' && file.toLowerCase().endsWith('.sql'))) {
    throw new Error('Docker 内置导入器仅支持 PostgreSQL 普通 SQL 文件');
  }

  const content = readFileSync(file, 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  const fileName = file.split(/[\\/]/).pop() || 'data.sql';
  const rewritten = rewriteSchema(content, sourceSchema, schema.slice(1, -1));
  const client = await getPostgresPool().connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.${quoteIdentifier('__dw_data_imports')} (` +
        'file_hash text PRIMARY KEY NOT NULL, file_name text NOT NULL, ' +
        'imported_at timestamp with time zone NOT NULL DEFAULT now())',
    );
    const existing = await client.query(
      `SELECT 1 FROM ${schema}.${quoteIdentifier('__dw_data_imports')} WHERE file_hash = $1 LIMIT 1`,
      [hash],
    );
    const force = ['1', 'true', 'yes', 'on'].includes(String(process.env.DB_IMPORT_FORCE || '').toLowerCase());
    if (existing.rowCount && !force) {
      await client.query('ROLLBACK');
      console.log(`[db-import] 文件 ${fileName} 已导入过，跳过`);
      return;
    }

    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(rewritten);
    await client.query(
      `INSERT INTO ${schema}.${quoteIdentifier('__dw_data_imports')} (file_hash, file_name) ` +
        'VALUES ($1, $2) ON CONFLICT (file_hash) DO UPDATE SET file_name = EXCLUDED.file_name, imported_at = now()',
      [hash, fileName],
    );
    await client.query('COMMIT');
    console.log(`[db-import] 数据导入完成：${fileName}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

await main();
