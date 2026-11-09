import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
} as const;

/**
 * 资源类型字典：资源类型不再硬编码在代码里，可在页面维护。
 * code 为业务唯一键（被 resources / 模板条目 / 环境槽位引用），prefix 用于生成资源编码。
 * ipUniqueByPort = true 表示该类资源按「IP + 端口」判重（平台地址类），false 表示按 IP 判重（主机类）。
 */
export const resourceTypes = sqliteTable('resource_types', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  prefix: text('prefix').notNull(),
  description: text('description'),
  ipUniqueByPort: integer('ip_unique_by_port', { mode: 'boolean' }).notNull().default(false),
  /** 列表页展示的关键属性列（取自该类型的字段 key） */
  listColumns: text('list_columns', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});

/**
 * 资源类型的专属属性字段定义：新增类型时可自由配置需要填写哪些字段。
 * isIp = true 的字段会参与 IP 占用检测与冲突校验。
 */
export const resourceTypeFields = sqliteTable(
  'resource_type_fields',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    typeCode: text('type_code')
      .notNull()
      .references(() => resourceTypes.code, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    fieldType: text('field_type').notNull().default('TEXT'),
    required: integer('required', { mode: 'boolean' }).notNull().default(false),
    options: text('options', { mode: 'json' })
      .$type<{ value: string; label: string }[]>()
      .notNull()
      .default(sql`'[]'`),
    defaultValue: text('default_value'),
    placeholder: text('placeholder'),
    unit: text('unit'),
    isIp: integer('is_ip', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    uniqueIndex('uq_type_field').on(t.typeCode, t.key),
    index('idx_type_field_type').on(t.typeCode),
  ],
);

/** 环境字典：不再只有生产/准生产/开发测试，可在页面自定义 */
export const environmentDict = sqliteTable('environments', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  tone: text('tone').notNull().default('gray'),
  /** 自定义标识色（#rrggbb）；为空时回退到 tone 预设 */
  color: text('color'),
  description: text('description'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});

/**
 * 需求项目：数据仓库的需求/建设项目，一个项目下可有多套环境。
 * 资源通过 project_id 标注主归属项目，也可通过环境槽位被多环境共享引用。
 */
export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    owner: text('owner'),
    status: text('status', { enum: ['ACTIVE', 'ARCHIVED'] })
      .notNull()
      .default('ACTIVE'),
    createdById: integer('created_by_id'),
    createdByName: text('created_by_name'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('uq_projects_code').on(t.code), index('idx_projects_status').on(t.status)],
);

/**
 * 项目环境模板：定义一套环境需要哪些资源类型（可自由组合）。
 * items 里的 quantity 表示该类资源的槽位数量，建环境时展开成 env_slots。
 */
export const envTemplates = sqliteTable(
  'env_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
    createdById: integer('created_by_id'),
    createdByName: text('created_by_name'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('uq_env_templates_code').on(t.code)],
);

export const envTemplateItems = sqliteTable(
  'env_template_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    templateId: integer('template_id')
      .notNull()
      .references(() => envTemplates.id, { onDelete: 'cascade' }),
    /** 资源类型编码：取自 resource_types 字典，允许自定义扩展 */
    resourceType: text('resource_type').notNull(),
    slotRole: text('slot_role').notNull(),
    quantity: integer('quantity').notNull().default(1),
    required: integer('required', { mode: 'boolean' }).notNull().default(true),
    remark: text('remark'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('idx_template_items_template').on(t.templateId)],
);

/** 项目环境：项目 × 环境类型（DEV/PT/UAT/PRD），可由模板一键展开出资源槽位 */
export const projectEnvironments = sqliteTable(
  'project_environments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 环境编码：取自 environments 字典，允许自定义扩展 */
    environment: text('environment').notNull(),
    status: text('status', { enum: ['PLANNING', 'BUILDING', 'RUNNING', 'OFFLINE'] })
      .notNull()
      .default('PLANNING'),
    templateId: integer('template_id').references(() => envTemplates.id, { onDelete: 'set null' }),
    owner: text('owner'),
    description: text('description'),
    createdById: integer('created_by_id'),
    createdByName: text('created_by_name'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('uq_project_env').on(t.projectId, t.name),
    index('idx_project_env_project').on(t.projectId),
  ],
);

/** 用户与角色（RBAC） */
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['ADMIN', 'USER', 'READONLY'] })
      .notNull()
      .default('READONLY'),
    status: text('status', { enum: ['ACTIVE', 'DISABLED'] })
      .notNull()
      .default('ACTIVE'),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('uq_users_username').on(t.username)],
);

/** 刷新令牌：服务端可吊销，支持轮换与登出失效 */
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('uq_refresh_token_hash').on(t.tokenHash),
    index('idx_refresh_user').on(t.userId),
  ],
);

/**
 * 资源主表：所有资源类型共用一张表（公共字段 + attrs JSON 存放类型专属字段）。
 * 这样既能统一检索/分页/审计，又保留各类型的强类型校验（校验在边界处由 Zod 完成）。
 */
export const resources = sqliteTable(
  'resources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** 资源类型编码：取自 resource_types 字典，允许自定义扩展 */
    type: text('type').notNull(),
    /** 环境编码：取自 environments 字典，允许自定义扩展 */
    environment: text('environment').notNull(),
    status: text('status', {
      enum: ['IN_USE', 'IDLE', 'RESERVED', 'MAINTAINING', 'RETIRED'],
    })
      .notNull()
      .default('IN_USE'),
    datacenter: text('datacenter'),
    owner: text('owner'),
    tags: text('tags', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    remark: text('remark'),
    attrs: text('attrs', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** 主归属项目 / 项目环境：用于按项目检索与批量标注 */
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    projectEnvId: integer('project_env_id').references(() => projectEnvironments.id, {
      onDelete: 'set null',
    }),
    /**
     * 容量管理：capacity_total 为 null 表示该资源不纳入容量核算。
     * 各环境槽位引用该资源时会登记 demand_amount，子资源挂载时会登记申请量，
     * 两者之和不得超过总容量。
     */
    capacityTotal: real('capacity_total'),
    capacityUnit: text('capacity_unit'),
    capacityRemark: text('capacity_remark'),
    /**
     * 父子层级：子资源挂在父资源下，attrs 在继承父资源属性后可补充额外字段。
     * 子资源的 demandAmount 会占用父资源容量，父资源容量调整时同步校验。
     */
    parentId: integer('parent_id').references((): AnySQLiteColumn => resources.id, {
      onDelete: 'set null',
    }),
    /** 向父资源申请的容量（仅子资源有值） */
    demandAmount: real('demand_amount'),
    createdById: integer('created_by_id'),
    createdByName: text('created_by_name'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
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

/**
 * 环境槽位：模板展开后的「资源需求位置」。
 * 一个槽位绑定 0 或 1 个资源；同一资源可被多个环境的槽位引用（共享资源场景）。
 * 绑定资源时登记占用期限：start_at 起算，end_at 为空表示长期占用，
 * 到期未释放不会自动解除，页面提示超期天数并支持一键续期或释放。
 */
export const envSlots = sqliteTable(
  'env_slots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    environmentId: integer('environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    /** 资源类型编码：取自 resource_types 字典，允许自定义扩展 */
    resourceType: text('resource_type').notNull(),
    slotRole: text('slot_role').notNull(),
    resourceId: integer('resource_id').references(() => resources.id, { onDelete: 'set null' }),
    /** 该槽位向资源申请的容量（资源设置了总容量时必填，且不可超出剩余容量） */
    demandAmount: real('demand_amount'),
    /** 占用开始时间 */
    startAt: integer('start_at', { mode: 'timestamp_ms' }),
    /** 占用结束时间：null 表示长期占用（不限期限） */
    endAt: integer('end_at', { mode: 'timestamp_ms' }),
    /** 累计续期次数 */
    renewCount: integer('renew_count').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    remark: text('remark'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** 最近一次绑定/续期/释放时间（SQLite 的 ADD COLUMN 不支持非常量默认值，这里允许为空） */
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('idx_env_slots_env').on(t.environmentId),
    index('idx_env_slots_resource').on(t.resourceId),
    index('idx_env_slots_period').on(t.startAt, t.endAt),
  ],
);

/** 变更审计：所有写操作留痕，支持按资源回溯 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    changes: text('changes', { mode: 'json' }).$type<
      { field: string; label?: string; from: unknown; to: unknown }[]
    >(),
    requestId: text('request_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('idx_audit_target').on(t.targetType, t.targetId),
    index('idx_audit_created').on(t.createdAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type ResourceRow = typeof resources.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewResourceRow = typeof resources.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type EnvTemplateRow = typeof envTemplates.$inferSelect;
export type EnvTemplateItemRow = typeof envTemplateItems.$inferSelect;
export type ProjectEnvRow = typeof projectEnvironments.$inferSelect;
export type EnvSlotRow = typeof envSlots.$inferSelect;
export type ResourceTypeRow = typeof resourceTypes.$inferSelect;
export type ResourceTypeFieldRow = typeof resourceTypeFields.$inferSelect;
export type EnvironmentRow = typeof environmentDict.$inferSelect;
