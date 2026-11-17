export type DbCompatMode = 'postgres' | 'dws';

export type DwsObjectCheck =
  { kind: 'index'; name: string } | { kind: 'column'; table: string; name: string };

/**
 * DWS 非复制表的主键/唯一约束必须包含分布列。
 * 管理控制台数据量较小，因此配置表以及带二级唯一约束的表统一使用复制表。
 * 审计日志和槽位表写入量更大，且没有二级唯一约束，继续使用默认分布。
 */
export const DWS_REPLICATION_TABLES = new Set([
  'users',
  'resource_types',
  'resource_type_fields',
  'environments',
  'env_templates',
  'env_template_items',
  'projects',
  'project_environments',
  'project_snapshots',
  'resources',
  'refresh_tokens',
]);

/**
 * DWS 不同版本对部分 PostgreSQL DDL 语法支持不完整。
 * DWS 模式只保留普通 PostgreSQL 也能执行的等价写法。
 */
export function transformMigrationStatement(
  statement: string,
  mode: DbCompatMode,
): { sql: string | null; skipped?: 'foreign-key' } {
  if (mode !== 'dws') return { sql: statement };

  if (/\bFOREIGN KEY\b/i.test(statement)) {
    return { sql: null, skipped: 'foreign-key' };
  }

  const sql = statement
    .replace(/\s+USING\s+btree\b/gi, '')
    .replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');

  const tableName = /^CREATE TABLE IF NOT EXISTS "([^"]+)"/i.exec(sql)?.[1];
  if (tableName && DWS_REPLICATION_TABLES.has(tableName) && !/\bDISTRIBUTE\s+BY\b/i.test(sql)) {
    return {
      sql: sql.replace(/;(\s*)$/, ' DISTRIBUTE BY REPLICATION;$1'),
    };
  }

  return { sql };
}

/** DWS 8.2.1 不支持索引/列级 IF NOT EXISTS，因此通过系统表判断后跳过。 */
export function dwsObjectCheck(statement: string): DwsObjectCheck | null {
  const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/i.exec(statement);
  if (index?.[1]) return { kind: 'index', name: index[1] };

  const column = /^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"/i.exec(statement);
  if (column?.[1] && column[2]) {
    return { kind: 'column', table: column[1], name: column[2] };
  }

  return null;
}

/** 清理 pg_dump 头部 DWS 不支持的会话参数；数据语句本身保持不变。 */
export function sanitizeImportSql(sql: string, mode: DbCompatMode): string {
  if (mode !== 'dws') return sql;

  return sql
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^SELECT\s+pg_catalog\.set_config\(\s*'search_path'/i.test(trimmed)) return false;
      if (/^SET\s+/i.test(trimmed)) {
        return /^SET\s+(client_encoding|standard_conforming_strings)\b/i.test(trimmed);
      }
      return true;
    })
    .join('\n');
}
