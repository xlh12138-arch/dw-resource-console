import { z } from 'zod';
import {
  AUDIT_TARGET_TYPES,
  ENV_RUN_STATUSES,
  PROJECT_STATUSES,
  RESOURCE_STATUSES,
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
  SLOT_OCCUPANCY_STATES,
  type ResourceType,
} from './enums.js';

/* ------------------------------------------------------------------ *
 * 基础校验原语
 * ------------------------------------------------------------------ */

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export const ipv4 = z.string().trim().regex(IPV4_RE, 'IP 地址格式不正确').describe('IPv4 地址');

export const port = z.coerce.number().int().min(1).max(65535);

/**
 * 资源类型 / 环境编码：由字典表维护，可在页面新增，因此这里只做格式约束，
 * 取值范围在服务端按字典校验（见 /resource-types、/environments）。
 */
export const resourceTypeCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,39}$/, '资源类型编码需以大写字母开头，仅含大写字母、数字与下划线');
export const environmentCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,31}$/, '环境编码需以大写字母开头，仅含大写字母、数字与下划线');
export type ResourceTypeCode = string;
export type EnvironmentCode = string;
export const shortText = z.string().trim().min(1).max(64);
export const longText = z.string().trim().max(500);
export const tagList = z.array(z.string().trim().min(1).max(24)).max(10).default([]);

/* ------------------------------------------------------------------ *
 * 资源公共字段 + 创建 / 更新 DTO
 * ------------------------------------------------------------------ */

/** 项目归属：一个资源最多主属于一个项目 / 项目环境，另可通过环境槽位被多环境共享引用 */
const projectRefShape = {
  projectId: z.coerce.number().int().positive().nullable().optional().describe('所属项目'),
  projectEnvId: z.coerce.number().int().positive().nullable().optional().describe('所属项目环境'),
};

/** 容量设置：总容量为正数；置 null 表示取消容量核算（若仍有占用会被服务端拒绝） */
const capacityShape = {
  capacityTotal: z.coerce.number().positive().max(1e9).nullable().optional(),
  capacityUnit: z.string().trim().max(16).nullable().optional(),
  capacityRemark: z.string().trim().max(200).nullable().optional(),
};

const baseResourceShape = {
  ...projectRefShape,
  name: shortText.describe('资源名称'),
  environment: environmentCodeSchema.describe('所属环境'),
  status: z.enum(RESOURCE_STATUSES).default('IN_USE').describe('资源状态'),
  datacenter: shortText.optional().describe('机房/可用区'),
  owner: shortText.optional().describe('负责人'),
  tags: tagList.optional().describe('标签'),
  remark: longText.optional().describe('备注'),
  ...capacityShape,
};

/** 子资源：挂到父资源下，并向父资源申请一段容量（父资源必须设置了容量） */
const parentRefShape = {
  parentId: z.coerce.number().int().positive().nullable().optional().describe('父资源'),
  demandAmount: z.coerce
    .number()
    .min(0)
    .max(1e9)
    .nullable()
    .optional()
    .describe('向父资源申请的容量，可为 0'),
};

export const resourceCreateSchema = z.object({
  type: resourceTypeCodeSchema.describe('资源类型（取自资源类型字典）'),
  attrs: z.record(z.string(), z.unknown()).default({}).describe('类型专属属性'),
  ...parentRefShape,
  ...baseResourceShape,
});
export type ResourceCreateInput = z.infer<typeof resourceCreateSchema>;

export const resourceUpdateSchema = z
  .object({
    ...projectRefShape,
    ...parentRefShape,
    name: shortText.optional(),
    environment: environmentCodeSchema.optional(),
    status: z.enum(RESOURCE_STATUSES).optional(),
    datacenter: shortText.optional(),
    owner: shortText.optional(),
    tags: tagList.optional(),
    remark: longText.optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    ...capacityShape,
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要更新一个字段' });

export const resourceQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  type: resourceTypeCodeSchema.optional(),
  environment: environmentCodeSchema.optional(),
  status: z.enum(RESOURCE_STATUSES).optional(),
  datacenter: z.string().trim().max(64).optional(),
  owner: z.string().trim().max(64).optional(),
  /** 标签过滤：支持逗号分隔的多个标签，按「同时包含」匹配 */
  tag: z.string().trim().max(120).optional(),
  /** 按资源 id 精确定位（用于「从子资源跳到父资源」时只看该资源本身） */
  id: z.coerce.number().int().positive().optional(),
  /** 逗号分隔的 id 集合；台账勾选导出时按该集合精确取数，不再叠加其他筛选 */
  ids: z
    .string()
    .trim()
    .max(2000)
    .regex(/^\d+(,\d+)*$/, 'ids 必须是逗号分隔的正整数')
    .optional(),
  projectId: z.coerce.number().int().positive().optional(),
  projectEnvId: z.coerce.number().int().positive().optional(),
  /** 只看某个父资源下的子资源 */
  parentId: z.coerce.number().int().positive().optional(),
  /** 只看顶层资源（不含子资源） */
  rootOnly: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  /** 只看未标注项目的资源 */
  unassigned: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  /** 公共列或动态属性列（attr:<字段 key>） */
  sortBy: z
    .string()
    .regex(
      /^(updatedAt|createdAt|name|code|type|environment|status|datacenter|owner|attr:[A-Za-z][A-Za-z0-9_]*)$/,
      '不支持按该列排序',
    )
    .default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const resourceSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  type: resourceTypeCodeSchema,
  environment: environmentCodeSchema,
  status: z.enum(RESOURCE_STATUSES),
  datacenter: z.string().nullable(),
  owner: z.string().nullable(),
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  projectEnvId: z.number().int().nullable(),
  projectEnvName: z.string().nullable(),
  tags: z.array(z.string()),
  remark: z.string().nullable(),
  attrs: z.record(z.string(), z.unknown()),
  /** 父资源：子资源从父资源申请容量，容量约束沿父子链同步校验 */
  parentId: z.number().int().nullable(),
  parentCode: z.string().nullable(),
  parentName: z.string().nullable(),
  /** 向父资源申请的容量 */
  demandAmount: z.number().nullable(),
  /** 直接子资源数量与它们申请的容量合计 */
  childCount: z.number().int(),
  childAllocated: z.number(),
  /** 容量：capacityTotal 为 null 表示不纳入容量核算 */
  capacityTotal: z.number().nullable(),
  capacityUnit: z.string().nullable(),
  /** 已被各环境槽位申请 + 子资源申请的容量合计（不分时段） */
  capacityAllocated: z.number(),
  /** 剩余可用容量（未设容量时为 null，按合计口径） */
  capacityAvailable: z.number().nullable(),
  /**
   * 按时间段核算的峰值占用：不重叠的占用不累加，重叠才求和。
   * 与资源详情 `capacity.peak` 同一口径，台账据此展示，避免「合计 200%」的误读。
   */
  capacityPeak: z.number().nullable(),
  /** 峰值口径的剩余容量：总容量 - 峰值占用 */
  capacityPeakAvailable: z.number().nullable(),
  /** 被多少个环境槽位引用 */
  slotRefCount: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResourceDto = z.infer<typeof resourceSchema>;

/** 资源被哪些项目 / 项目环境 / 槽位引用（含各自申请的容量与占用期限） */
export const resourceReferenceSchema = z.object({
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  envId: z.number().int(),
  envName: z.string(),
  environment: environmentCodeSchema,
  environmentLabel: z.string(),
  slotId: z.number().int(),
  slotRole: z.string(),
  amount: z.number().nullable(),
  /** 占用起止：endAt 为 null 表示长期占用 */
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  /** 已超期天数（未超期为 0） */
  overdueDays: z.number().int(),
  occupancyState: z.enum(SLOT_OCCUPANCY_STATES),
  /** 占用尚未开始（开始时间在未来）：容量已计入占用，页面单独标注 */
  notStarted: z.boolean().default(false),
});
export type ResourceReference = z.infer<typeof resourceReferenceSchema>;

/** 子资源节点：用于详情里的父子层级与容量树展示 */
export const resourceChildSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  type: resourceTypeCodeSchema,
  typeLabel: z.string(),
  environment: environmentCodeSchema,
  environmentLabel: z.string(),
  status: z.enum(RESOURCE_STATUSES),
  demandAmount: z.number().nullable(),
  capacityTotal: z.number().nullable(),
  capacityAllocated: z.number(),
  slotRefCount: z.number().int(),
  childCount: z.number().int(),
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  attrs: z.record(z.string(), z.unknown()),
});
export type ResourceChild = z.infer<typeof resourceChildSchema>;

/**
 * 按时间段的容量占用峰值。
 * 同一资源可被多个项目在不同时间段占用：不重叠的时段各自可用满容量，重叠时段求和，
 * 因此「已占用」应取时间轴上的峰值而不是简单累加。
 */
export const capacityPeakSchema = z.object({
  /** 峰值占用量（含子资源申请这类恒定基线） */
  amount: z.number(),
  /** 峰值时刻来自时间段占用（环境槽位）的部分 */
  segmentAmount: z.number(),
  /** 恒定基线（子资源申请，任何时刻都占用） */
  constantAmount: z.number(),
  /** 峰值所在时间段，null 表示无界（长期） */
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  /** 峰值时刻同时生效的槽位数量 */
  slotCount: z.number().int(),
  /** 峰值时刻的占用明细 */
  items: z.array(
    z.object({
      slotId: z.number().int(),
      projectId: z.number().int().nullable(),
      projectName: z.string().nullable(),
      envName: z.string(),
      slotRole: z.string(),
      amount: z.number().nullable(),
      startAt: z.string().nullable(),
      endAt: z.string().nullable(),
    }),
  ),
  /** 时间轴上的占用曲线（相邻等值区间已合并），可用于画走势 */
  curve: z.array(
    z.object({
      startAt: z.string().nullable(),
      endAt: z.string().nullable(),
      amount: z.number(),
    }),
  ),
});
export type CapacityPeak = z.infer<typeof capacityPeakSchema>;

/** 资源详情：在主 DTO 之上补充容量明细、引用明细与父子层级 */
export const resourceDetailSchema = resourceSchema.extend({
  capacity: z
    .object({
      total: z.number().nullable(),
      unit: z.string().nullable(),
      allocated: z.number(),
      available: z.number().nullable(),
      usage: z.number().nullable(),
      remark: z.string().nullable(),
      /** 其中被直接子资源申请的容量 */
      childAllocated: z.number(),
      /** 其中被环境槽位占用的容量 */
      slotAllocated: z.number(),
      /**
       * 按时间段计算的峰值占用：不重叠的占用不累加，重叠的求和。
       * 这是判断「容量是否够用」的正确口径（allocated 为不分时段的合计）。
       */
      peak: capacityPeakSchema.nullable().default(null),
      /** 按峰值口径的剩余容量：总容量 - 峰值占用 */
      peakAvailable: z.number().nullable().default(null),
    })
    .nullable(),
  references: z.array(resourceReferenceSchema),
  /** 按项目聚合的占用情况，用于在台账里一眼看清容量去向 */
  capacityByProject: z.array(
    z.object({
      projectId: z.number().int().nullable(),
      projectName: z.string().nullable(),
      envCount: z.number().int(),
      slotCount: z.number().int(),
      amount: z.number(),
    }),
  ),
  /** 直接子资源（含各自申请量） */
  children: z.array(resourceChildSchema),
  /** 顶层祖先（用于从子资源跳回父资源） */
  ancestors: z.array(z.object({ id: z.number().int(), code: z.string(), name: z.string() })),
});
export type ResourceDetail = z.infer<typeof resourceDetailSchema>;

/** 资源占用时间轴：某资源被哪些项目/环境在什么时间段占用，以及重叠共用情况 */
export const resourceTimelineSchema = z.object({
  resource: z.object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    type: resourceTypeCodeSchema,
    typeLabel: z.string(),
    capacityTotal: z.number().nullable(),
    capacityUnit: z.string().nullable(),
  }),
  range: z.object({
    from: z.string(),
    to: z.string(),
    /** 与服务端当前日期的对齐（前端用于画「今天」参考线） */
    today: z.string(),
  }),
  entries: z.array(
    z.object({
      slotId: z.number().int(),
      envId: z.number().int(),
      envName: z.string(),
      projectId: z.number().int().nullable(),
      projectName: z.string().nullable(),
      environment: environmentCodeSchema,
      environmentLabel: z.string(),
      slotRole: z.string(),
      amount: z.number().nullable(),
      startAt: z.string(),
      endAt: z.string().nullable(),
      overdueDays: z.number().int(),
      occupancyState: z.enum(SLOT_OCCUPANCY_STATES),
      /** 占用尚未开始（开始时间在未来）：容量已计入占用，页面单独标注 */
      notStarted: z.boolean().default(false),
      /** 与其他占用区间有重叠（共用） */
      shared: z.boolean(),
    }),
  ),
  /** 超期占用明细，用于页面顶部的提醒条 */
  expiredCount: z.number().int(),
  /** 共用（时间区间重叠）的组合，便于快速判断资源是否被并发共用 */
  overlaps: z.array(
    z.object({
      a: z.number().int(),
      b: z.number().int(),
      from: z.string(),
      to: z.string().nullable(),
    }),
  ),
});
export type ResourceTimeline = z.infer<typeof resourceTimelineSchema>;

export const pagedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    meta: z.object({
      page: z.number().int(),
      pageSize: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  });

/* ------------------------------------------------------------------ *
 * 批量导入 / 导出
 * ------------------------------------------------------------------ */

export const resourceImportSchema = z.object({
  type: resourceTypeCodeSchema,
  csv: z.string().min(1).max(2_000_000),
  onConflict: z.enum(['skip', 'overwrite']).default('skip'),
});

export const importResultSchema = z.object({
  total: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(
    z.object({
      row: z.number().int(),
      message: z.string(),
      /** 出问题的具体字段（供 Excel 导入逐列提示）；无法定位到字段时为空数组 */
      fields: z
        .array(z.object({ field: z.string(), label: z.string(), message: z.string() }))
        .default([]),
    }),
  ),
});

/* ------------------------------------------------------------------ *
 * 认证 / 用户
 * ------------------------------------------------------------------ */

export const loginSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(8).max(128),
});

export const userSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(['ADMIN', 'USER', 'READONLY']),
  status: z.enum(['ACTIVE', 'DISABLED']),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof userSchema>;

export const authResultSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
  user: userSchema,
});
export type AuthResult = z.infer<typeof authResultSchema>;

export const createUserSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(32),
  role: z.enum(['ADMIN', 'USER', 'READONLY']),
});

export const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(32).optional(),
  role: z.enum(['ADMIN', 'USER', 'READONLY']).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

/** 管理员重置密码：服务端生成新口令并在响应中回显一次，便于转告用户 */
export const resetPasswordResultSchema = z.object({
  user: userSchema,
  /** 重置后的明文密码，仅本次响应返回，不落库、不写日志 */
  password: z.string(),
});
export type ResetPasswordResult = z.infer<typeof resetPasswordResultSchema>;

/* ------------------------------------------------------------------ *
 * 审计日志
 * ------------------------------------------------------------------ */

export const auditChangeSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  from: z.unknown().nullable(),
  to: z.unknown().nullable(),
});

export const auditLogSchema = z.object({
  id: z.number().int(),
  actorId: z.number().int().nullable(),
  actorName: z.string(),
  action: z.enum(['CREATE', 'UPDATE', 'DELETE', 'IMPORT', 'LOGIN', 'LOGOUT']),
  targetType: z.enum(AUDIT_TARGET_TYPES),
  targetId: z.string().nullable(),
  targetName: z.string().nullable(),
  changes: z.array(auditChangeSchema).nullable(),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditLogDto = z.infer<typeof auditLogSchema>;

export const auditQuerySchema = z.object({
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
  targetId: z.string().optional(),
  actor: z.string().optional(),
  action: z.enum(['CREATE', 'UPDATE', 'DELETE', 'IMPORT', 'LOGIN', 'LOGOUT']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

/* ------------------------------------------------------------------ *
 * 需求项目 / 项目环境 / 环境模板
 * ------------------------------------------------------------------ */

export const projectCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{2,32}$/, '项目编码仅允许字母、数字、下划线与短横线')
    .optional()
    .describe('项目编码（留空自动生成）'),
  name: shortText.describe('项目名称'),
  description: longText.optional().describe('项目说明'),
  owner: shortText.optional().describe('项目负责人'),
  status: z.enum(PROJECT_STATUSES).default('ACTIVE').describe('项目状态'),
});
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = z
  .object({
    name: shortText.optional(),
    description: longText.optional(),
    owner: shortText.optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要更新一个字段' });

export const projectQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const projectSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  owner: z.string().nullable(),
  status: z.enum(PROJECT_STATUSES),
  envCount: z.number().int(),
  resourceCount: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectDto = z.infer<typeof projectSchema>;

/** 项目环境：一个项目下可有多套（DEV / PT / UAT / PRD），每套由若干资源槽位组成 */
export const projectEnvCreateSchema = z.object({
  projectId: z.coerce.number().int().positive().describe('所属项目'),
  name: shortText.describe('环境名称'),
  environment: environmentCodeSchema.describe('环境类型'),
  templateId: z.coerce.number().int().positive().optional().describe('套用的环境模板'),
  description: longText.optional(),
  owner: shortText.optional(),
  status: z.enum(ENV_RUN_STATUSES).default('PLANNING'),
});
export type ProjectEnvCreateInput = z.infer<typeof projectEnvCreateSchema>;

export const projectEnvUpdateSchema = z
  .object({
    name: shortText.optional(),
    environment: environmentCodeSchema.optional(),
    description: longText.optional(),
    owner: shortText.optional(),
    status: z.enum(ENV_RUN_STATUSES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要更新一个字段' });

export const projectEnvSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  projectName: z.string(),
  name: z.string(),
  environment: environmentCodeSchema,
  /** 环境字典的显示名：由服务端按最新字典实时计算，改字典后无需前端缓存即生效 */
  environmentLabel: z.string(),
  templateId: z.number().int().nullable(),
  templateName: z.string().nullable(),
  status: z.enum(ENV_RUN_STATUSES),
  description: z.string().nullable(),
  owner: z.string().nullable(),
  slotTotal: z.number().int(),
  slotFilled: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectEnvDto = z.infer<typeof projectEnvSchema>;

/** 环境槽位：模板展开后的一个个「资源需求位置」，可绑定具体资源 */
export const envSlotSchema = z.object({
  id: z.number().int(),
  environmentId: z.number().int(),
  resourceType: resourceTypeCodeSchema,
  slotRole: z.string(),
  resourceId: z.number().int().nullable(),
  resourceCode: z.string().nullable(),
  resourceName: z.string().nullable(),
  resourceStatus: z.enum(RESOURCE_STATUSES).nullable(),
  /** 该槽位向资源申请的容量；资源设置了总容量时必填 */
  demandAmount: z.number().nullable(),
  /** 占用期限：startAt 缺省为绑定时刻，endAt 为 null 表示长期占用 */
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  /** 已超期天数：结束时间已过但占用未释放时大于 0，页面据此提示并支持一键续期 */
  overdueDays: z.number().int(),
  occupancyState: z.enum(SLOT_OCCUPANCY_STATES).nullable(),
  /** 占用尚未开始（开始时间在未来）：容量已计入占用，页面单独标注 */
  notStarted: z.boolean().default(false),
  /** 累计续期次数 */
  renewCount: z.number().int(),
  sortOrder: z.number().int(),
  remark: z.string().nullable(),
});
export type EnvSlotDto = z.infer<typeof envSlotSchema>;

export const envSlotCreateSchema = z.object({
  resourceType: resourceTypeCodeSchema,
  slotRole: z.string().trim().min(1).max(64),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
  remark: longText.optional(),
});

/** 编辑槽位基础信息；已绑定资源时不允许直接改变资源类型。 */
export const envSlotUpdateSchema = z
  .object({
    resourceType: resourceTypeCodeSchema.optional(),
    slotRole: z.string().trim().min(1).max(64).optional(),
    remark: longText.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要更新一个字段' });

/** 占用期限输入：endAt 传 null 表示长期占用（不限期限） */
const periodShape = {
  startAt: z.string().datetime({ offset: true }).or(z.string().date()).nullable().optional(),
  endAt: z.string().datetime({ offset: true }).or(z.string().date()).nullable().optional(),
};

/**
 * 槽位绑定资源：
 * - amount：该槽位申请的容量（资源设了总容量时必填，可为 0，且不能超过剩余容量）
 * - startAt / endAt：占用起止；endAt 为 null 表示长期占用
 * - acknowledge：已知悉「跨环境引用 / 已被其他项目占用 / 时间区间重叠」等提示，确认继续
 */
export const envSlotAssignSchema = z
  .object({
    resourceId: z.coerce.number().int().positive(),
    amount: z.coerce.number().min(0).max(1e9).nullable().optional(),
    acknowledge: z.coerce.boolean().default(false),
    ...periodShape,
  })
  .refine((v) => !v.startAt || !v.endAt || new Date(v.endAt) > new Date(v.startAt), {
    message: '结束时间必须晚于开始时间',
    path: ['endAt'],
  });
export type EnvSlotAssignInput = z.infer<typeof envSlotAssignSchema>;

/** 续期：直接给新的结束时间，或给 days 顺延天数；endAt=null 表示转为长期占用 */
export const envSlotRenewSchema = z
  .object({
    endAt: z.string().datetime({ offset: true }).or(z.string().date()).nullable().optional(),
    days: z.coerce.number().int().min(1).max(3650).optional(),
    remark: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.endAt !== undefined || v.days !== undefined, {
    message: '请提供新的结束时间或顺延天数',
  });

/** 调整占用期限（不改绑定关系） */
export const envSlotPeriodSchema = z
  .object({
    startAt: z.string().datetime({ offset: true }).or(z.string().date()).nullable().optional(),
    endAt: z.string().datetime({ offset: true }).or(z.string().date()).nullable().optional(),
  })
  .refine((v) => v.startAt !== undefined || v.endAt !== undefined, {
    message: '至少需要更新一个时间',
  })
  .refine((v) => !v.startAt || !v.endAt || new Date(v.endAt) > new Date(v.startAt), {
    message: '结束时间必须晚于开始时间',
    path: ['endAt'],
  });

/** 槽位绑定冲突时返回的提示明细（跨项目占用 / 跨环境引用 / 容量不足 / 时间重叠） */
export const slotAssignWarningSchema = z.object({
  code: z.enum([
    'CROSS_ENVIRONMENT',
    'USED_BY_OTHER_PROJECT',
    'CAPACITY_EXCEEDED',
    'CAPACITY_REQUIRED',
    'SELF_REFERENCE',
    'PERIOD_OVERLAP',
  ]),
  message: z.string(),
  /** 已被占用的明细（USED_BY_OTHER_PROJECT / PERIOD_OVERLAP） */
  references: z
    .array(
      z.object({
        projectId: z.number().int().nullable(),
        projectName: z.string().nullable(),
        envId: z.number().int(),
        envName: z.string(),
        environment: environmentCodeSchema,
        environmentLabel: z.string(),
        slotId: z.number().int(),
        slotRole: z.string(),
        amount: z.number().nullable(),
        startAt: z.string().nullable().default(null),
        endAt: z.string().nullable().default(null),
        overdueDays: z.number().int().default(0),
        occupancyState: z.enum(SLOT_OCCUPANCY_STATES).default('ACTIVE'),
        /** 占用尚未开始（开始时间在未来）：容量已计入占用，页面单独标注 */
        notStarted: z.boolean().default(false),
      }),
    )
    .default([]),
  /** 容量明细（CAPACITY_*） */
  capacity: z
    .object({
      total: z.number(),
      unit: z.string().nullable(),
      allocated: z.number(),
      available: z.number(),
      requested: z.number().nullable(),
    })
    .nullable()
    .default(null),
});
export type SlotAssignWarning = z.infer<typeof slotAssignWarningSchema>;

/** 槽位可分配资源候选：带上跨环境 / 已被占用 / 容量等提示，供前端展示 */
export const slotCandidateSchema = z.object({
  resource: z.object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    type: resourceTypeCodeSchema,
    typeLabel: z.string(),
    environment: environmentCodeSchema,
    environmentLabel: z.string(),
    status: z.enum(RESOURCE_STATUSES),
    statusLabel: z.string(),
    projectId: z.number().int().nullable(),
    projectName: z.string().nullable(),
    datacenter: z.string().nullable(),
    owner: z.string().nullable(),
    /** 子资源标记：绑定子资源会占用其父资源的容量 */
    parentId: z.number().int().nullable().default(null),
    parentName: z.string().nullable().default(null),
  }),
  /** 与当前项目环境不同环境（跨环境引用，允许但需提示） */
  crossEnvironment: z.boolean(),
  /** 已被其他项目的环境槽位引用 */
  usedByOtherProject: z.boolean(),
  /** 是否必须填写申请容量（资源设置了总容量） */
  demandRequired: z.boolean(),
  capacity: z
    .object({
      total: z.number(),
      unit: z.string().nullable(),
      allocated: z.number(),
      available: z.number(),
    })
    .nullable(),
  usedBy: z.array(
    z.object({
      projectId: z.number().int().nullable(),
      projectName: z.string().nullable(),
      envId: z.number().int(),
      envName: z.string(),
      environment: environmentCodeSchema,
      environmentLabel: z.string(),
      slotId: z.number().int(),
      slotRole: z.string(),
      amount: z.number().nullable(),
      startAt: z.string().nullable().default(null),
      endAt: z.string().nullable().default(null),
      overdueDays: z.number().int().default(0),
      occupancyState: z.enum(SLOT_OCCUPANCY_STATES).default('ACTIVE'),
      /** 占用尚未开始（开始时间在未来）：容量已计入占用，页面单独标注 */
      notStarted: z.boolean().default(false),
    }),
  ),
  warnings: z.array(slotAssignWarningSchema),
});
export type SlotCandidate = z.infer<typeof slotCandidateSchema>;

export const slotCandidatesSchema = z.object({
  slot: z.object({
    id: z.number().int(),
    slotRole: z.string(),
    resourceType: resourceTypeCodeSchema,
    resourceTypeLabel: z.string(),
    currentResourceId: z.number().int().nullable(),
    startAt: z.string().nullable(),
    endAt: z.string().nullable(),
  }),
  env: z.object({
    id: z.number().int(),
    name: z.string(),
    projectId: z.number().int(),
    projectName: z.string(),
    environment: environmentCodeSchema,
    environmentLabel: z.string(),
  }),
  items: z.array(slotCandidateSchema),
});
export type SlotCandidates = z.infer<typeof slotCandidatesSchema>;

export const projectEnvDetailSchema = projectEnvSchema.extend({
  slots: z.array(envSlotSchema),
  /** 本环境超期占用的槽位数，用于页面顶部提醒 */
  overdueCount: z.number().int().default(0),
});
export type ProjectEnvDetail = z.infer<typeof projectEnvDetailSchema>;

/** 项目环境的占用时间轴（Gantt 视图数据） */
export const envTimelineSchema = z.object({
  env: z.object({
    id: z.number().int(),
    name: z.string(),
    projectId: z.number().int(),
    projectName: z.string(),
    environment: environmentCodeSchema,
    environmentLabel: z.string(),
  }),
  range: z.object({ from: z.string(), to: z.string(), today: z.string() }),
  entries: z.array(
    z.object({
      slotId: z.number().int(),
      slotRole: z.string(),
      resourceId: z.number().int().nullable(),
      resourceCode: z.string().nullable(),
      resourceName: z.string().nullable(),
      amount: z.number().nullable(),
      startAt: z.string(),
      endAt: z.string().nullable(),
      overdueDays: z.number().int(),
      occupancyState: z.enum(SLOT_OCCUPANCY_STATES),
      /** 占用尚未开始（开始时间在未来）：容量已计入占用，页面单独标注 */
      notStarted: z.boolean().default(false),
      /** 同一资源被本环境或其他环境并行占用（共用） */
      shared: z.boolean(),
    }),
  ),
  expiredCount: z.number().int(),
});
export type EnvTimeline = z.infer<typeof envTimelineSchema>;

/** 项目环境下对资源的槽位引用，用于区分「主归属」与「槽位引用」两种来源 */
export const projectSlotRefSchema = z.object({
  resourceId: z.number().int(),
  /** 冗余资源展示信息，便于项目页直接列出「哪些资源超期」 */
  resourceCode: z.string().nullable().default(null),
  resourceName: z.string().nullable().default(null),
  resourceType: resourceTypeCodeSchema.nullable().default(null),
  resourceTypeLabel: z.string().nullable().default(null),
  envId: z.number().int(),
  envName: z.string(),
  environment: environmentCodeSchema.nullable().default(null),
  environmentLabel: z.string().nullable().default(null),
  slotId: z.number().int(),
  slotRole: z.string(),
  amount: z.number().nullable().default(null),
  startAt: z.string().nullable().default(null),
  endAt: z.string().nullable().default(null),
  overdueDays: z.number().int().default(0),
  occupancyState: z.enum(SLOT_OCCUPANCY_STATES).default('ACTIVE'),
  /** 占用尚未开始（开始时间在未来）：容量已计入占用，页面单独标注 */
  notStarted: z.boolean().default(false),
  renewCount: z.number().int().default(0),
});

export const projectDetailSchema = projectSchema.extend({
  environments: z.array(projectEnvSchema),
  byType: z.array(
    z.object({ type: resourceTypeCodeSchema, label: z.string(), count: z.number().int() }),
  ),
  /** 本项目所有环境槽位绑定的资源，前端据此判断资源为何出现在项目资源列表中 */
  slotRefs: z.array(projectSlotRefSchema),
  /** 项目下超期占用的槽位数 */
  overdueCount: z.number().int().default(0),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

/** 把资源从项目中移出：includeSlots=true 时一并解除该项目下所有槽位引用 */
export const projectDetachSchema = z.object({
  includeSlots: z.coerce.boolean().default(false),
});

export const projectDetachResultSchema = z.object({
  resourceId: z.number().int(),
  unlabeled: z.boolean(),
  unboundSlots: z.number().int(),
  remainingSlotRefs: z.number().int(),
});

/** 环境模板条目：自由组合资源类型 + 槽位名称 + 数量 */
export const templateItemSchema = z.object({
  resourceType: resourceTypeCodeSchema.describe('资源类型'),
  slotRole: z.string().trim().min(1).max(64).describe('槽位名称'),
  quantity: z.coerce.number().int().min(1).max(99).default(1).describe('需求数量'),
  required: z.coerce.boolean().default(true).describe('是否必需'),
  remark: z.string().trim().max(200).optional(),
});
export type TemplateItemInput = z.infer<typeof templateItemSchema>;

export const envTemplateCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{2,32}$/, '模板编码仅允许字母、数字、下划线与短横线')
    .optional(),
  name: shortText.describe('模板名称'),
  description: longText.optional(),
  items: z.array(templateItemSchema).min(1, '至少选择一个资源类型').max(50),
});
export type EnvTemplateCreateInput = z.infer<typeof envTemplateCreateSchema>;

export const envTemplateUpdateSchema = z
  .object({
    name: shortText.optional(),
    description: longText.optional(),
    items: z.array(templateItemSchema).min(1).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要更新一个字段' });

export const envTemplateQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const envTemplateItemSchema = templateItemSchema.extend({
  id: z.number().int(),
  templateId: z.number().int(),
  sortOrder: z.number().int(),
});

export const envTemplateSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  itemCount: z.number().int(),
  slotCount: z.number().int(),
  usageCount: z.number().int(),
  builtin: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EnvTemplateDto = z.infer<typeof envTemplateSchema>;

export const envTemplateDetailSchema = envTemplateSchema.extend({
  items: z.array(envTemplateItemSchema),
});
export type EnvTemplateDetail = z.infer<typeof envTemplateDetailSchema>;

/** 一步到位：直接基于模板在某个项目下创建环境 */
export const instantiateTemplateSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  name: shortText.describe('环境名称'),
  environment: environmentCodeSchema,
  owner: shortText.optional(),
  description: longText.optional(),
});

/** 资源批量标注项目（用于存量资源补标） */
export const bulkAssignSchema = z
  .object({
    ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
    projectId: z.coerce.number().int().positive().nullable(),
    projectEnvId: z.coerce.number().int().positive().nullable().optional(),
  })
  .refine((v) => v.projectId !== null || v.projectEnvId !== undefined, {
    message: 'projectId 与 projectEnvId 不能同时为空',
  });
export type BulkAssignInput = z.infer<typeof bulkAssignSchema>;

export const bulkAssignResultSchema = z.object({
  updated: z.number().int(),
  ids: z.array(z.number().int()),
});

/** 资源批量删除 */
export const bulkDeleteSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
});
export type BulkDeleteInput = z.infer<typeof bulkDeleteSchema>;

export const bulkDeleteResultSchema = z.object({
  deleted: z.number().int(),
  ids: z.array(z.number().int()),
});

/* ------------------------------------------------------------------ *
 * 统计概览
 * ------------------------------------------------------------------ */

/** 超期占用明细：结束时间已过但仍未释放的槽位（概览页统一展示） */
export const overdueSlotSchema = z.object({
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  envId: z.number().int(),
  envName: z.string(),
  environment: environmentCodeSchema,
  environmentLabel: z.string(),
  slotId: z.number().int(),
  slotRole: z.string(),
  resourceId: z.number().int(),
  resourceCode: z.string(),
  resourceName: z.string(),
  resourceType: resourceTypeCodeSchema,
  resourceTypeLabel: z.string(),
  amount: z.number().nullable(),
  startAt: z.string().nullable(),
  /** 超期槽位一定有结束时间（长期占用不会超期） */
  endAt: z.string(),
  overdueDays: z.number().int(),
  renewCount: z.number().int(),
});

/** 按项目分组的超期统计，用于概览页「哪些项目的哪些资源超期」 */
export const overdueProjectGroupSchema = z.object({
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  count: z.number().int(),
  maxOverdueDays: z.number().int(),
  items: z.array(overdueSlotSchema),
});

export const statsOverviewSchema = z.object({
  total: z.number().int(),
  byType: z.array(
    z.object({ type: resourceTypeCodeSchema, label: z.string(), count: z.number().int() }),
  ),
  byEnvironment: z.array(
    z.object({ environment: environmentCodeSchema, label: z.string(), count: z.number().int() }),
  ),
  byStatus: z.array(
    z.object({ status: z.enum(RESOURCE_STATUSES), label: z.string(), count: z.number().int() }),
  ),
  byDatacenter: z.array(z.object({ datacenter: z.string(), count: z.number().int() })),
  nasCapacity: z.object({
    count: z.number().int(),
    capacityGb: z.number(),
    usedGb: z.number(),
    usageRate: z.number(),
  }),
  ipConflict: z.object({ count: z.number().int(), samples: z.array(z.string()) }),
  createdLast7Days: z.number().int(),
  recentUpdated: z.array(resourceSchema),
  /** 按项目维度的资源分布（含未标注项目的数量） */
  byProject: z.array(
    z.object({ projectId: z.number().int().nullable(), name: z.string(), count: z.number().int() }),
  ),
  /** 按标签分布：点击标签可直接在台账中筛选 */
  byTag: z.array(z.object({ tag: z.string(), count: z.number().int() })),
  /** 父子资源层级概览 */
  hierarchy: z.object({
    rootCount: z.number().int(),
    childCount: z.number().int(),
    /** 带有子资源的父资源数量 */
    parentCount: z.number().int(),
  }),
  /** 占用期限概览：超期未释放的槽位 */
  slotPeriod: z.object({
    occupiedCount: z.number().int(),
    expiringSoonCount: z.number().int(),
    expiredCount: z.number().int(),
    longTermCount: z.number().int(),
  }),
  /** 超期占用明细：按超期天数倒序，供概览页统一展示 */
  overdueSlots: z.array(overdueSlotSchema),
  /** 按项目分组的超期情况 */
  overdueByProject: z.array(overdueProjectGroupSchema),
  projectSummary: z.object({
    projectCount: z.number().int(),
    envCount: z.number().int(),
    templateCount: z.number().int(),
    unassignedCount: z.number().int(),
  }),
});
export type StatsOverview = z.infer<typeof statsOverviewSchema>;

/* ------------------------------------------------------------------ *
 * IP 占用检测
 * ------------------------------------------------------------------ */

export const ipCheckResultSchema = z.object({
  ip: z.string(),
  available: z.boolean(),
  conflicts: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      type: resourceTypeCodeSchema,
      typeLabel: z.string(),
      field: z.string(),
    }),
  ),
});

/* ------------------------------------------------------------------ *
 * 动态表单字段定义（前端按资源类型渲染表单）
 * ------------------------------------------------------------------ */

export type AttrFieldDef = {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'switch';
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  unit?: string;
  options?: { value: string; label: string }[];
};

/** 资源类型 → 列表页展示的关键列 */
export const TYPE_COLUMNS: Record<ResourceType, string[]> = {
  ETL_SERVER: ['IP'],
  ORACLE: [],
  DWS_DB: [],
  ARGODB: [],
  MRS: [],
  DCE: ['WEB_URL'],
  IDEAL: [],
  DSSP: [],
  NAS: ['USEAGE'],
  GDS_SERVER: ['IP'],
  FUNCTION_SERVER: ['IP'],
};

export const RESOURCE_TYPE_ALIASES = RESOURCE_TYPES.map((t) => ({
  value: t,
  label: RESOURCE_TYPE_LABELS[t],
}));

export type {
  ResourceType,
  Environment,
  ResourceStatus,
  Role,
  AuditAction,
  AuditTargetType,
  ProjectStatus,
  EnvRunStatus,
  SlotStatus,
} from './enums.js';

/* ------------------------------------------------------------------ *
 * 字典配置：资源类型 / 环境（可在页面维护，被引用的对象支持一键同步）
 * ------------------------------------------------------------------ */

/** 属性字段的控件类型 */
export const FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'INTEGER',
  'IP',
  'PORT',
  'SELECT',
  'BOOLEAN',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  TEXT: '单行文本',
  TEXTAREA: '多行文本',
  NUMBER: '数字',
  INTEGER: '整数',
  IP: 'IP 地址',
  PORT: '端口',
  SELECT: '下拉选择',
  BOOLEAN: '是/否',
};

/** 字段：kind 用于前端渲染控件，与后端 fieldType 一一对应 */
export const FIELD_TYPE_KINDS: Record<FieldType, AttrFieldDef['kind']> = {
  TEXT: 'text',
  TEXTAREA: 'textarea',
  NUMBER: 'number',
  INTEGER: 'number',
  IP: 'text',
  PORT: 'number',
  SELECT: 'select',
  BOOLEAN: 'switch',
};

export const dictOptionSchema = z.object({
  value: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(32),
});

export const resourceTypeFieldInputSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  key: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/, '字段标识需以字母或下划线开头，仅含字母、数字与下划线'),
  label: shortText.describe('字段名称'),
  fieldType: z.enum(FIELD_TYPES).default('TEXT'),
  required: z.coerce.boolean().default(false),
  options: z.array(dictOptionSchema).max(50).default([]),
  defaultValue: z.string().trim().max(64).optional(),
  placeholder: z.string().trim().max(64).optional(),
  unit: z.string().trim().max(16).optional(),
  /** 标记为 IP 字段后，该资源会参与 IP 占用检测与冲突校验 */
  isIp: z.coerce.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});
export type ResourceTypeFieldInput = z.infer<typeof resourceTypeFieldInputSchema>;

export const resourceTypeFieldSchema = resourceTypeFieldInputSchema.extend({
  id: z.number().int(),
  typeCode: z.string(),
  defaultValue: z.string().nullable(),
  placeholder: z.string().nullable(),
  unit: z.string().nullable(),
});
export type ResourceTypeFieldDto = z.infer<typeof resourceTypeFieldSchema>;

export const resourceTypeCreateSchema = z.object({
  code: resourceTypeCodeSchema.describe('类型编码'),
  label: shortText.describe('类型名称'),
  prefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{2,12}$/, '编码前缀仅允许字母、数字与短横线（2-12 位）')
    .describe('资源编码前缀'),
  description: longText.optional(),
  ipUniqueByPort: z.coerce.boolean().default(false).describe('按 IP+端口判重'),
  listColumns: z.array(z.string().trim().min(1).max(40)).max(8).default([]).describe('列表关键列'),
  enabled: z.coerce.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  fields: z.array(resourceTypeFieldInputSchema).max(60).default([]),
});
export type ResourceTypeCreateInput = z.infer<typeof resourceTypeCreateSchema>;

export const resourceTypeUpdateSchema = z
  .object({
    /** 修改后的编码（留空表示不变）；改编码会影响所有引用该类型的对象 */
    code: resourceTypeCodeSchema.optional(),
    label: shortText.optional(),
    prefix: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{2,12}$/, '编码前缀仅允许字母、数字与短横线（2-12 位）')
      .optional(),
    description: longText.optional(),
    ipUniqueByPort: z.coerce.boolean().optional(),
    listColumns: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
    enabled: z.coerce.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    fields: z.array(resourceTypeFieldInputSchema).max(60).optional(),
    /** true = 同步更新所有已引用该类型的对象；false/缺省且存在引用时返回 409 提示 */
    sync: z.coerce.boolean().default(false),
    /** 字段标识重命名：把存量资源 attrs 中的旧 key 改成新 key */
    keyRenames: z
      .array(z.object({ from: z.string(), to: z.string() }))
      .max(60)
      .default([]),
    /** 是否清理存量资源中已不存在的字段 */
    dropUnknownFields: z.coerce.boolean().default(false),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要更新一个字段' });
export type ResourceTypeUpdateInput = z.infer<typeof resourceTypeUpdateSchema>;

export const resourceTypeSchema = z.object({
  code: z.string(),
  label: z.string(),
  prefix: z.string(),
  description: z.string().nullable(),
  ipUniqueByPort: z.boolean(),
  listColumns: z.array(z.string()),
  enabled: z.boolean(),
  builtin: z.boolean(),
  sortOrder: z.number().int(),
  fieldCount: z.number().int(),
  /** 被资源 / 模板条目 / 环境槽位引用的数量 */
  referenceCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResourceTypeDto = z.infer<typeof resourceTypeSchema>;

export const resourceTypeDetailSchema = resourceTypeSchema.extend({
  fields: z.array(resourceTypeFieldSchema),
});
export type ResourceTypeDetail = z.infer<typeof resourceTypeDetailSchema>;

/** 资源类型前缀同步：把历史自动编码统一到当前前缀 */
export const resourceTypeCodeSyncResultSchema = z.object({
  code: z.string(),
  prefix: z.string(),
  updated: z.number().int(),
});
export type ResourceTypeCodeSyncResult = z.infer<typeof resourceTypeCodeSyncResultSchema>;

/** 环境标识色：统一存 #rrggbb，前端调色板与 RGB 输入都会先规范化再提交 */
const envColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, '标识色需为 #RRGGBB 格式')
  .transform((v) => v.toLowerCase());

export const environmentDictCreateSchema = z.object({
  code: environmentCodeSchema.describe('环境编码'),
  label: shortText.describe('环境名称'),
  /** 兼容旧字段：仅在没有 color 时作为兜底色调 */
  tone: z.enum(['gray', 'green', 'blue', 'amber', 'red', 'purple']).default('gray'),
  color: envColorSchema.nullable().optional(),
  description: longText.optional(),
  enabled: z.coerce.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});
export type EnvironmentDictCreateInput = z.infer<typeof environmentDictCreateSchema>;

export const environmentDictUpdateSchema = z
  .object({
    code: environmentCodeSchema.optional(),
    label: shortText.optional(),
    tone: z.enum(['gray', 'green', 'blue', 'amber', 'red', 'purple']).optional(),
    color: envColorSchema.nullable().optional(),
    description: longText.optional(),
    enabled: z.coerce.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    /** true = 同步更新资源与项目环境中的环境编码 */
    sync: z.coerce.boolean().default(false),
    /** true = 把名称仍等于旧环境名称的项目环境一并改名（字典改名后保持一致） */
    syncNames: z.coerce.boolean().default(false),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要更新一个字段' });

export const environmentDictSchema = z.object({
  code: z.string(),
  label: z.string(),
  tone: z.string(),
  /** 自定义标识色（#rrggbb）；为空时前端按 tone 兜底 */
  color: z.string().nullable(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  builtin: z.boolean(),
  sortOrder: z.number().int(),
  referenceCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EnvironmentDto = z.infer<typeof environmentDictSchema>;

/** 引用明细：前端据此提示「已被 N 个对象引用」并展示样例 */
export const dictReferenceSchema = z.object({
  entity: z.enum(['RESOURCE', 'TEMPLATE_ITEM', 'ENV_SLOT', 'PROJECT_ENV']),
  label: z.string(),
  count: z.number().int(),
  samples: z.array(z.object({ id: z.string(), name: z.string(), extra: z.string().optional() })),
});
export type DictReference = z.infer<typeof dictReferenceSchema>;

export const dictReferencesSchema = z.object({
  code: z.string(),
  label: z.string(),
  kind: z.enum(['RESOURCE_TYPE', 'ENVIRONMENT']),
  total: z.number().int(),
  groups: z.array(dictReferenceSchema),
});
export type DictReferences = z.infer<typeof dictReferencesSchema>;

/** 删除字典项时把引用迁移到另一个字典项 */
export const dictDeleteSchema = z.object({
  migrateTo: resourceTypeCodeSchema.or(environmentCodeSchema).optional(),
});

export const dictSyncResultSchema = z.object({
  code: z.string(),
  previousCode: z.string().nullable(),
  updated: z.object({
    resource: z.number().int(),
    templateItem: z.number().int(),
    envSlot: z.number().int(),
    projectEnv: z.number().int(),
  }),
  /** 同步了属性字段的资源数 */
  attrSynced: z.number().int(),
  total: z.number().int(),
});
export type DictSyncResult = z.infer<typeof dictSyncResultSchema>;

/** 字典写操作的返回：既给最新字典，也带上同步结果与引用情况 */
export const resourceTypeMutationSchema = z.object({
  detail: resourceTypeDetailSchema,
  sync: dictSyncResultSchema.nullable(),
  /** 本次因前缀修改而更新的存量资源编码数量 */
  resourceCodeSynced: z.number().int().default(0),
  /** 存量资源中待同步属性字段的数量（>0 时前端提示可一键同步） */
  pendingAttrSync: z.number().int(),
  references: dictReferencesSchema.nullable(),
});

export const environmentMutationSchema = z.object({
  detail: environmentDictSchema,
  sync: dictSyncResultSchema.nullable(),
  references: dictReferencesSchema.nullable(),
  /** 名称仍等于旧环境名称的项目环境数量（>0 时前端提示可一键同步名称） */
  pendingNameSync: z.number().int(),
  /** 一键同步名称后更新的项目环境数 */
  nameSynced: z.number().int(),
});

/** 属性字段同步请求 */
export const dictSyncAttrsSchema = z.object({
  keyRenames: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .max(60)
    .default([]),
  dropUnknown: z.coerce.boolean().default(false),
});

export const dictSyncAttrsResultSchema = z.object({
  updated: z.number().int(),
  pending: z.number().int(),
});

export const dictQuerySchema = z.object({
  includeDisabled: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
});
