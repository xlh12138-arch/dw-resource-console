import type { CapacityPeak as CapacityPeakDto, ResourceDto, ResourceType } from '@dw/shared';
import { getTypeMeta } from '../dict/validator.js';
import { projectEnvRepository, projectRepository } from '../projects/repository.js';
import type { ResourceRow } from '../../db/schema.js';

/** 一次性取回项目 / 项目环境名称，避免逐行查库 */
export async function loadProjectLabels() {
  const [projectRows, envRows] = await Promise.all([
    projectRepository.listAll(),
    projectEnvRepository.listAll(),
  ]);
  return {
    projects: new Map(projectRows.map((p) => [p.id, p.name])),
    envs: new Map(envRows.map((e) => [e.id, e.name])),
  };
}

export type ProjectLabelMaps = Awaited<ReturnType<typeof loadProjectLabels>>;

export function labelsOf(row: ResourceRow, maps: ProjectLabelMaps): ProjectLabels {
  return {
    projectName: row.projectId ? (maps.projects.get(row.projectId) ?? null) : null,
    projectEnvName: row.projectEnvId ? (maps.envs.get(row.projectEnvId) ?? null) : null,
  };
}

/** 项目 / 项目环境名称，避免列表接口里逐个查库 */
export interface ProjectLabels {
  projectName?: string | null;
  projectEnvName?: string | null;
}

/** 资源容量占用快照：allocated = 槽位申请 + 子资源申请；slotCount 为引用槽位数 */
export interface CapacityUsage {
  allocated: number;
  slotCount: number;
  slotAllocated: number;
  childAllocated: number;
}

/** 父资源与子资源信息：避免列表接口里逐行查库 */
export interface HierarchyLabels {
  parentCode?: string | null;
  parentName?: string | null;
  childCount?: number;
  childAllocated?: number;
}

/** 数据库行 → 对外 DTO（时间统一转 ISO 字符串，attrs 保证是对象） */
export function toResourceDto(
  row: ResourceRow,
  labels: ProjectLabels = {},
  usage?: CapacityUsage,
  hierarchy: HierarchyLabels = {},
  /** 按时间段核算的峰值占用（由列表批量计算后传入，与详情 capacity.peak 同口径） */
  peakAmount: number | null = null,
): ResourceDto {
  const allocated = usage?.allocated ?? 0;
  const total = row.capacityTotal ?? null;
  const peak = total === null ? null : round2(peakAmount ?? 0);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    environment: row.environment,
    status: row.status,
    datacenter: row.datacenter ?? null,
    owner: row.owner ?? null,
    projectId: row.projectId ?? null,
    projectName: row.projectId ? (labels.projectName ?? null) : null,
    projectEnvId: row.projectEnvId ?? null,
    projectEnvName: row.projectEnvId ? (labels.projectEnvName ?? null) : null,
    tags: row.tags ?? [],
    remark: row.remark ?? null,
    attrs: (row.attrs ?? {}) as Record<string, unknown>,
    parentId: row.parentId ?? null,
    parentCode: row.parentId ? (hierarchy.parentCode ?? null) : null,
    parentName: row.parentId ? (hierarchy.parentName ?? null) : null,
    demandAmount: row.demandAmount ?? null,
    childCount: hierarchy.childCount ?? 0,
    childAllocated: round2(hierarchy.childAllocated ?? 0),
    capacityTotal: total,
    capacityUnit: row.capacityUnit ?? null,
    capacityAllocated: round2(allocated),
    capacityAvailable: total === null ? null : round2(total - allocated),
    capacityPeak: peak,
    capacityPeakAvailable: total === null || peak === null ? null : round2(total - peak),
    slotRefCount: usage?.slotCount ?? 0,
    createdBy: row.createdByName ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** 容量计算保留两位小数，避免浮点误差（0.1 + 0.2 之类） */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 组装资源的容量明细（未设容量时返回 null） */
export function capacityDetailOf(
  row: ResourceRow,
  usage?: CapacityUsage,
  /** 按时间段计算的峰值占用（由 resources/service 计算后传入） */
  peak?: CapacityPeakDto | null,
) {
  const total = row.capacityTotal ?? null;
  if (total === null) return null;
  const allocated = usage?.allocated ?? 0;
  return {
    total,
    unit: row.capacityUnit ?? null,
    allocated: round2(allocated),
    available: round2(total - allocated),
    usage: total > 0 ? round2((allocated / total) * 100) : null,
    remark: row.capacityRemark ?? null,
    childAllocated: round2(usage?.childAllocated ?? 0),
    slotAllocated: round2(usage?.slotAllocated ?? 0),
    peak: peak ?? null,
    peakAvailable: peak ? round2(total - peak.amount) : null,
  };
}

/**
 * 各类型中承载 IP 的字段：以字典字段定义（isIp 或 fieldType=IP）为准；
 * 字典尚未初始化时才回退到内置映射（与生产库资源类型字典一致）。
 */
const FALLBACK_IP_FIELDS: Record<string, string[]> = {
  ETL_SERVER: ['IP'],
  FUNCTION_SERVER: ['IP'],
  GDS_SERVER: ['IP'],
  ORACLE: ['IP'],
  DWS_DB: ['IP'],
  ARGODB: ['IP'],
  DCE: [],
  IDEAL: [],
  DSSP: [],
  MRS: [],
  NAS: [],
};

/** 按 IP+端口判重还是只按 IP 判重（字典未初始化时的回退值，与生产库 ip_unique_by_port 一致） */
const FALLBACK_IP_UNIQUE_BY_PORT: Record<string, boolean> = {};

export function ipFieldFallbackOf(type: string): string[] {
  return FALLBACK_IP_FIELDS[type] ?? [];
}

export function ipUniqueByPortFallbackOf(type: string): boolean {
  return FALLBACK_IP_UNIQUE_BY_PORT[type] ?? false;
}

export function extractIps(
  attrs: Record<string, unknown>,
  ipFields: string[],
): { field: string; value: string }[] {
  return ipFields
    .map((field) => ({ field, value: attrs[field] }))
    .filter(
      (x): x is { field: string; value: string } =>
        typeof x.value === 'string' && x.value.length > 0,
    );
}

/** 取某类型参与 IP 占用检测的字段（仅 isIp=true；fieldType=IP 只负责格式校验） */
export async function ipFieldsOf(type: string): Promise<string[]> {
  const meta = await getTypeMeta(type);
  if (!meta.exists) return ipFieldFallbackOf(type);
  return meta.ipFields;
}

/** 平台地址类资源按 IP+端口判重，主机类按 IP 判重（取自字典 ipUniqueByPort） */
export async function ipUniqueByPortOf(type: string): Promise<boolean> {
  const meta = await getTypeMeta(type);
  if (meta.fields.length > 0 || meta.exists) return meta.ipUniqueByPort;
  return ipUniqueByPortFallbackOf(type);
}

export function attrsOf(
  type: ResourceType,
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  return attrs;
}
