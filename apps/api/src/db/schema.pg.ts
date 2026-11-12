import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  pgSchema,
  serial,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { config } from '../config/env.js';

/**
 * PostgreSQL schema 与 SQLite schema 保持相同的表名、列名和业务类型。
 * 时间统一存 Unix 毫秒，避免两种驱动之间出现 Date/number 口径差异。
 */
const appSchema = config.db.schema === 'public' ? null : pgSchema(config.db.schema);
const appTable = (appSchema ? appSchema.table.bind(appSchema) : pgTable) as typeof pgTable;

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
} as const;

export const resourceTypes = appTable('resource_types', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  prefix: text('prefix').notNull(),
  description: text('description'),
  ipUniqueByPort: boolean('ip_unique_by_port').notNull().default(false),
  listColumns: jsonb('list_columns')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  enabled: boolean('enabled').notNull().default(true),
  builtin: boolean('builtin').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});

export const resourceTypeFields = appTable(
  'resource_type_fields',
  {
    id: serial('id').primaryKey(),
    typeCode: text('type_code')
      .notNull()
      .references(() => resourceTypes.code, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    fieldType: text('field_type').notNull().default('TEXT'),
    required: boolean('required').notNull().default(false),
    options: jsonb('options')
      .$type<{ value: string; label: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    defaultValue: text('default_value'),
    placeholder: text('placeholder'),
    unit: text('unit'),
    isIp: boolean('is_ip').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    uniqueIndex('uq_type_field').on(t.typeCode, t.key),
    index('idx_type_field_type').on(t.typeCode),
  ],
);

export const environmentDict = appTable('environments', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  tone: text('tone').notNull().default('gray'),
  color: text('color'),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(true),
  builtin: boolean('builtin').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});

export const projects = appTable(
  'projects',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    owner: text('owner'),
    status: text('status', { enum: ['ACTIVE', 'ARCHIVED'] })
      .notNull()
      .default('ACTIVE'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdById: integer('created_by_id'),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_projects_code').on(t.code),
    index('idx_projects_status').on(t.status),
    index('idx_projects_updated').on(t.updatedAt),
  ],
);

/** 项目结项快照：保存结项时点的项目、环境、槽位与资源信息 */
export const projectSnapshots = appTable(
  'project_snapshots',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id').notNull(),
    projectCode: text('project_code').notNull(),
    projectName: text('project_name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdById: integer('created_by_id'),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_project_snapshots_project').on(t.projectId),
    index('idx_project_snapshots_closed').on(t.closedAt),
  ],
);

export const envTemplates = appTable(
  'env_templates',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    builtin: boolean('builtin').notNull().default(false),
    createdById: integer('created_by_id'),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_env_templates_code').on(t.code),
    index('idx_env_templates_updated').on(t.updatedAt),
  ],
);

export const envTemplateItems = appTable(
  'env_template_items',
  {
    id: serial('id').primaryKey(),
    templateId: integer('template_id')
      .notNull()
      .references(() => envTemplates.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').notNull(),
    slotRole: text('slot_role').notNull(),
    quantity: integer('quantity').notNull().default(1),
    required: boolean('required').notNull().default(true),
    remark: text('remark'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('idx_template_items_template').on(t.templateId)],
);

export const projectEnvironments = appTable(
  'project_environments',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    environment: text('environment').notNull(),
    status: text('status', { enum: ['PLANNING', 'BUILDING', 'RUNNING', 'OFFLINE'] })
      .notNull()
      .default('PLANNING'),
    templateId: integer('template_id').references(() => envTemplates.id, { onDelete: 'set null' }),
    owner: text('owner'),
    description: text('description'),
    createdById: integer('created_by_id'),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_project_env').on(t.projectId, t.name),
    index('idx_project_env_project').on(t.projectId),
  ],
);

export const users = appTable(
  'users',
  {
    id: serial('id').primaryKey(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['ADMIN', 'USER', 'READONLY'] })
      .notNull()
      .default('READONLY'),
    status: text('status', { enum: ['ACTIVE', 'DISABLED'] })
      .notNull()
      .default('ACTIVE'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_users_username').on(t.username)],
);

export const refreshTokens = appTable(
  'refresh_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_refresh_token_hash').on(t.tokenHash),
    index('idx_refresh_user').on(t.userId),
  ],
);

export const resources = appTable(
  'resources',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    environment: text('environment').notNull(),
    status: text('status', {
      enum: ['IN_USE', 'IDLE', 'RESERVED', 'MAINTAINING', 'RETIRED'],
    })
      .notNull()
      .default('IN_USE'),
    datacenter: text('datacenter'),
    owner: text('owner'),
    tags: jsonb('tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    remark: text('remark'),
    attrs: jsonb('attrs').$type<Record<string, unknown>>().notNull(),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    projectEnvId: integer('project_env_id').references(() => projectEnvironments.id, {
      onDelete: 'set null',
    }),
    capacityTotal: doublePrecision('capacity_total'),
    capacityUnit: text('capacity_unit'),
    capacityRemark: text('capacity_remark'),
    parentId: integer('parent_id').references((): AnyPgColumn => resources.id, {
      onDelete: 'set null',
    }),
    demandAmount: doublePrecision('demand_amount'),
    createdById: integer('created_by_id'),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_resources_code').on(t.code),
    index('idx_resources_type').on(t.type),
    index('idx_resources_status').on(t.status),
    index('idx_resources_env').on(t.environment),
    index('idx_resources_project').on(t.projectId),
    index('idx_resources_project_env').on(t.projectEnvId),
    index('idx_resources_updated').on(t.updatedAt),
    index('idx_resources_parent').on(t.parentId),
  ],
);

export const envSlots = appTable(
  'env_slots',
  {
    id: serial('id').primaryKey(),
    environmentId: integer('environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').notNull(),
    slotRole: text('slot_role').notNull(),
    resourceId: integer('resource_id').references(() => resources.id, { onDelete: 'set null' }),
    demandAmount: doublePrecision('demand_amount'),
    startAt: timestamp('start_at', { withTimezone: true, mode: 'date' }),
    endAt: timestamp('end_at', { withTimezone: true, mode: 'date' }),
    renewCount: integer('renew_count').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    remark: text('remark'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('idx_env_slots_env').on(t.environmentId),
    index('idx_env_slots_resource').on(t.resourceId),
    index('idx_env_slots_period').on(t.startAt, t.endAt),
  ],
);

export const auditLogs = appTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    actorId: integer('actor_id'),
    actorName: text('actor_name').notNull(),
    action: text('action', {
      enum: ['CREATE', 'UPDATE', 'DELETE', 'IMPORT', 'LOGIN', 'LOGOUT'],
    }).notNull(),
    targetType: text('target_type', {
      enum: [
        'RESOURCE',
        'USER',
        'AUTH',
        'PROJECT',
        'ENVIRONMENT',
        'TEMPLATE',
        'DICT',
        'SLOT_PERIOD',
      ],
    }).notNull(),
    targetId: text('target_id'),
    targetName: text('target_name'),
    changes:
      jsonb('changes').$type<{ field: string; label?: string; from: unknown; to: unknown }[]>(),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_audit_target').on(t.targetType, t.targetId),
    index('idx_audit_created').on(t.createdAt),
  ],
);
