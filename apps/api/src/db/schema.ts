import { config } from '../config/env.js';
import type * as sqliteSchema from './schema.sqlite.js';

/**
 * 业务层只依赖这一份 schema 导出。
 *
 * 两个 schema 的表名、列名和值类型保持一致，但 Drizzle 的 SQLite/PG 表格
 * 类型无法直接合并。因此这里使用 SQLite 的编译期类型作为业务层规范类型，
 * 运行时则返回当前 DB_DRIVER 对应的真实表对象。查询构造器仍由实际连接的
 * Drizzle 方言执行，不会把 SQLite SQL 发给 PostgreSQL。
 */
const selected = (config.db.driver === 'postgres'
  ? await import('./schema.pg.js')
  : await import('./schema.sqlite.js')) as unknown as typeof sqliteSchema;

export const resourceTypes = selected.resourceTypes as unknown as typeof sqliteSchema.resourceTypes;
export const resourceTypeFields =
  selected.resourceTypeFields as unknown as typeof sqliteSchema.resourceTypeFields;
export const environmentDict =
  selected.environmentDict as unknown as typeof sqliteSchema.environmentDict;
export const projects = selected.projects as unknown as typeof sqliteSchema.projects;
export const projectSnapshots =
  selected.projectSnapshots as unknown as typeof sqliteSchema.projectSnapshots;
export const envTemplates = selected.envTemplates as unknown as typeof sqliteSchema.envTemplates;
export const envTemplateItems =
  selected.envTemplateItems as unknown as typeof sqliteSchema.envTemplateItems;
export const projectEnvironments =
  selected.projectEnvironments as unknown as typeof sqliteSchema.projectEnvironments;
export const users = selected.users as unknown as typeof sqliteSchema.users;
export const refreshTokens = selected.refreshTokens as unknown as typeof sqliteSchema.refreshTokens;
export const resources = selected.resources as unknown as typeof sqliteSchema.resources;
export const envSlots = selected.envSlots as unknown as typeof sqliteSchema.envSlots;
export const auditLogs = selected.auditLogs as unknown as typeof sqliteSchema.auditLogs;

export type UserRow = typeof sqliteSchema.users.$inferSelect;
export type ResourceRow = typeof sqliteSchema.resources.$inferSelect;
export type AuditLogRow = typeof sqliteSchema.auditLogs.$inferSelect;
export type NewResourceRow = typeof sqliteSchema.resources.$inferInsert;
export type ProjectRow = typeof sqliteSchema.projects.$inferSelect;
export type ProjectSnapshotRow = typeof sqliteSchema.projectSnapshots.$inferSelect;
export type EnvTemplateRow = typeof sqliteSchema.envTemplates.$inferSelect;
export type EnvTemplateItemRow = typeof sqliteSchema.envTemplateItems.$inferSelect;
export type ProjectEnvRow = typeof sqliteSchema.projectEnvironments.$inferSelect;
export type EnvSlotRow = typeof sqliteSchema.envSlots.$inferSelect;
export type ResourceTypeRow = typeof sqliteSchema.resourceTypes.$inferSelect;
export type ResourceTypeFieldRow = typeof sqliteSchema.resourceTypeFields.$inferSelect;
export type EnvironmentRow = typeof sqliteSchema.environmentDict.$inferSelect;
