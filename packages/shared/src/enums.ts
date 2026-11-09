/**
 * 领域枚举与中文标签：前后端共用，保证下拉框、表格、表单文案一致。
 */

export const RESOURCE_TYPES = [
  'ETL_SERVER',
  'ORACLE',
  'DWS_DB',
  'ARGODB',
  'MRS',
  'DCE',
  'IDEAL',
  'DSSP',
  'NAS',
  'GDS_SERVER',
  'FUNCTION_SERVER',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  ETL_SERVER: 'ETL服务器',
  ORACLE: 'ORACLE数据库',
  DWS_DB: 'DWS数据库',
  ARGODB: 'ARGO数据库',
  MRS: 'MRS',
  DCE: '采集交换平台',
  IDEAL: '理想调度平台',
  DSSP: '源启调度平台',
  NAS: 'NAS',
  GDS_SERVER: 'GDS服务器',
  FUNCTION_SERVER: '功能服务器',
};

/** 资源编码前缀，用于自动生成 ETL-0001 之类的业务唯一编码 */
export const RESOURCE_TYPE_PREFIX: Record<ResourceType, string> = {
  ETL_SERVER: 'ETL',
  ORACLE: 'ORACLE',
  DWS_DB: 'DWS',
  ARGODB: 'ARGODB',
  MRS: 'MRS',
  DCE: 'DCE',
  IDEAL: 'IDEAL',
  DSSP: 'DSSP',
  NAS: 'NAS',
  GDS_SERVER: 'GDS',
  FUNCTION_SERVER: 'FUNCTION',
};

/** 历史环境编码：仅用于类型兼容，实际字典以数据库配置为准 */
export const ENVIRONMENTS = ['DEV', 'PT', 'UAT', 'PRD'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
/** 生产类环境编码：字典里仍可存在，但演示种子数据不会自动创建它们 */
export const PRODUCTION_ENVIRONMENTS: readonly Environment[] = ['PRD'];
export const ENVIRONMENT_LABELS: Record<Environment, string> = {
  DEV: '开发',
  PT: '产品测试',
  UAT: '用户测试',
  PRD: '生产',
};
/** 预设色调：仅在环境未设置自定义标识色时作为 Badge 兜底 */
export const ENVIRONMENT_TONES: Record<Environment, string> = {
  DEV: 'gray',
  PT: 'gray',
  UAT: 'gray',
  PRD: 'gray',
};
/** 历史环境编码的默认标识色（十六进制，前端调色板与徽标共用） */
export const ENVIRONMENT_COLORS: Record<Environment, string> = {
  DEV: '#16a34a',
  PT: '#2563eb',
  UAT: '#d97706',
  PRD: '#dc2626',
};
export const ENVIRONMENT_DESCRIPTIONS: Record<Environment, string> = {
  DEV: '开发环境，供研发自测联调使用',
  PT: '产品测试环境，供产品与测试同学验证需求',
  UAT: '用户测试环境，上线前的用户验收环境',
  PRD: '生产环境，直接承载线上业务，变更需走审批与变更窗口',
};

/** 调色板预设：常用环境色，点一下即可套用（也可自行输入 RGB） */
export const ENVIRONMENT_PALETTE = [
  '#dc2626',
  '#ea580c',
  '#d97706',
  '#ca8a04',
  '#16a34a',
  '#0d9488',
  '#0891b2',
  '#2563eb',
  '#4f46e5',
  '#7c3aed',
  '#c026d3',
  '#db2777',
  '#475569',
  '#0f172a',
] as const;

/** 校验并规范化十六进制颜色：支持 #RGB / #RRGGBB / RRGGBB，统一输出小写 #rrggbb */
export function normalizeHexColor(input: string): string | null {
  const raw = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw
      .split('')
      .map((c) => c + c)
      .join('')
      .toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

/** RGB 三元组 → 十六进制；非法输入返回 null */
export function rgbToHex(r: number, g: number, b: number): string | null {
  const valid = [r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255);
  if (!valid) return null;
  const hex = [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

/** 十六进制 → RGB 三元组；非法输入返回 null */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

/**
 * 解析用户输入的任意颜色写法：`#2563eb` / `2563eb` / `rgb(37, 99, 235)` / `37,99,235`
 * 返回规范化的 #rrggbb，无法识别时返回 null
 */
export function parseColorInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const rgbMatch = text.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i);
  if (rgbMatch) return rgbToHex(Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3]));
  const triple = text.match(/^(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})$/);
  if (triple) return rgbToHex(Number(triple[1]), Number(triple[2]), Number(triple[3]));
  return normalizeHexColor(text);
}

export const RESOURCE_STATUSES = ['IN_USE', 'IDLE', 'RESERVED', 'MAINTAINING', 'RETIRED'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];
export const RESOURCE_STATUS_LABELS: Record<ResourceStatus, string> = {
  IN_USE: '在用',
  IDLE: '空闲',
  RESERVED: '预留',
  MAINTAINING: '维护中',
  RETIRED: '已下线',
};

/** 需求项目状态：在建/在用 vs 已归档（归档项目不参与新建环境） */
export const PROJECT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  ACTIVE: '进行中',
  ARCHIVED: '已归档',
};

/**
 * 项目环境运行状态：
 * PLANNING 规划中 / BUILDING 搭建中 / RUNNING 运行中 / OFFLINE 已下线
 */
export const ENV_RUN_STATUSES = ['PLANNING', 'BUILDING', 'RUNNING', 'OFFLINE'] as const;
export type EnvRunStatus = (typeof ENV_RUN_STATUSES)[number];
export const ENV_RUN_STATUS_LABELS: Record<EnvRunStatus, string> = {
  PLANNING: '规划中',
  BUILDING: '搭建中',
  RUNNING: '运行中',
  OFFLINE: '已下线',
};

/** 环境槽位填充状态（由是否有绑定资源推导，不落库） */
export const SLOT_STATUSES = ['EMPTY', 'FILLED'] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];
export const SLOT_STATUS_LABELS: Record<SlotStatus, string> = {
  EMPTY: '待分配',
  FILLED: '已分配',
};

/**
 * 槽位占用状态（由绑定的起止时间与服务端当前时间推导，不落库）：
 * ACTIVE 占用中（含「开始时间在未来」的预约占用，容量已扣除）/ EXPIRED 已超期（仍保留占用，需续期或释放）
 *
 * 注意：不再有「未生效」态——只要槽位申请了资源，无论开始时间是否到达，容量都算已占用；
 * 未来的开始时间通过 notStarted 字段单独标注。
 */
export const SLOT_OCCUPANCY_STATES = ['ACTIVE', 'EXPIRED'] as const;
export type SlotOccupancyState = (typeof SLOT_OCCUPANCY_STATES)[number];
export const SLOT_OCCUPANCY_STATE_LABELS: Record<SlotOccupancyState, string> = {
  ACTIVE: '占用中',
  EXPIRED: '已超期',
};
export const SLOT_OCCUPANCY_STATE_TONES: Record<SlotOccupancyState, 'gray' | 'green' | 'red'> = {
  ACTIVE: 'green',
  EXPIRED: 'red',
};

/**
 * 角色收敛为三种：
 * - ADMIN 管理员：全权（含用户管理与变更审计）
 * - USER 普通用户：除「用户管理」「变更审计」外与管理员一致（可增删改）
 * - READONLY 只读用户：可见范围与普通用户相同，但只能查看
 * 早期的 OPERATOR / VIEWER 已废弃，历史数据在启动时归一（OPERATOR → USER，VIEWER → READONLY）。
 */
export const ROLES = ['ADMIN', 'USER', 'READONLY'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: '管理员',
  USER: '普通用户',
  READONLY: '只读用户',
};

/** 角色 → 可执行的操作，前端据此隐藏按钮，后端据此鉴权（双重校验） */
export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  ADMIN: ['resource:read', 'resource:write', 'resource:delete', 'user:manage', 'audit:read'],
  // 普通用户 = 管理员去掉「用户管理」「变更审计」
  USER: ['resource:read', 'resource:write', 'resource:delete'],
  READONLY: ['resource:read'],
};
export function can(role: Role, permission: string): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const AUDIT_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'IMPORT', 'LOGIN', 'LOGOUT'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  CREATE: '新增',
  UPDATE: '修改',
  DELETE: '删除',
  IMPORT: '批量导入',
  LOGIN: '登录',
  LOGOUT: '登出',
};

export const AUDIT_TARGET_TYPES = [
  'RESOURCE',
  'USER',
  'AUTH',
  'PROJECT',
  'ENVIRONMENT',
  'TEMPLATE',
  'DICT',
  'SLOT_PERIOD',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];
export const AUDIT_TARGET_TYPE_LABELS: Record<AuditTargetType, string> = {
  RESOURCE: '资源',
  USER: '用户',
  AUTH: '认证',
  PROJECT: '项目',
  ENVIRONMENT: '项目环境',
  TEMPLATE: '环境模板',
  DICT: '字典配置',
  SLOT_PERIOD: '资源占用期限',
};

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: '启用',
  DISABLED: '停用',
};

/** 业务错误码：前端按 code 映射友好文案，避免直接暴露后端堆栈 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  BAD_REQUEST: 'BAD_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
