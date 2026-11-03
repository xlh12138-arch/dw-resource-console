import { RESOURCE_STATUS_LABELS, ipv4 } from '@dw/shared';
import type {
  CapacityPeak,
  ResourceChild,
  ResourceDetail,
  ResourceDto,
  ResourceReference,
  ResourceTimeline,
} from '@dw/shared';
import { peakOf, peakWithin, type CapacitySegment } from '../../lib/capacity.js';
import { conflict, notFound, validationError } from '../../lib/errors.js';
import { notStartedOf, overdueDaysOf, occupancyStateOf, overlapRange } from '../../lib/occupancy.js';
import { auditRepository, type AuditChange } from '../audit/repository.js';
import {
  projectEnvRepository,
  projectRepository,
  resourceProjectRepository,
  slotRepository,
} from '../projects/repository.js';
import { environmentRepository } from '../dict/repository.js';
import { dictGuard, environmentLabelOf } from '../dict/service.js';
import { getTypeMeta, type RuntimeField } from '../dict/validator.js';
import { parseCsv, toCsv } from './csv.js';
import { withTransaction } from '../../db/index.js';
import {
  capacityDetailOf,
  extractIps,
  ipFieldsOf,
  ipUniqueByPortOf,
  labelsOf,
  loadProjectLabels,
  round2,
  toResourceDto,
  type HierarchyLabels,
  type ProjectLabelMaps,
} from './mapper.js';
import {
  resourceRefRepository,
  resourceRepository,
  type ResourceQuery,
  type ResourceScope,
} from './repository.js';
import type { ResourceRow } from '../../db/schema.js';

export interface Actor {
  id: number | null;
  username: string;
}

/** 项目维度检索：主归属 ∪ 环境槽位引用 */
async function resolveScope(q: ResourceQuery): Promise<ResourceScope | undefined> {
  if (q.projectEnvId) return { slotResourceIds: await slotRepository.resourceIdsByEnv(q.projectEnvId) };
  if (q.projectId) {
    const envs = await projectEnvRepository.listByProject(q.projectId);
    return { slotResourceIds: await slotRepository.resourceIdsByEnvs(envs.map((e) => e.id)) };
  }
  return undefined;
}

/**
 * 解析并校验项目归属：
 * 只给 projectEnvId 时自动补全其所属项目；两者同时给出时必须一致。
 */
async function resolveProjectRef(input: { projectId?: number | null; projectEnvId?: number | null }) {
  let projectId = input.projectId ?? null;
  let projectEnvId = input.projectEnvId ?? null;

  if (projectEnvId !== null) {
    const env = await projectEnvRepository.findById(projectEnvId);
    if (!env) throw notFound(`项目环境 ${projectEnvId} 不存在`);
    if (projectId !== null && env.projectId !== projectId) {
      throw validationError('所选项目环境不属于指定的项目', {
        field: 'projectEnvId',
        projectId,
        projectEnvId,
        envProjectId: env.projectId,
      });
    }
    projectId = env.projectId;
  } else if (projectId !== null) {
    const project = await projectRepository.findById(projectId);
    if (!project) throw notFound(`项目 ${projectId} 不存在`);
  }
  return { projectId, projectEnvId };
}

/**
 * 按资源类型的字段定义动态校验 attrs（字段定义在字典里可维护），
 * 同时确认该类型存在且启用；失败时抛出结构化 422。
 */
async function validateAttrs(type: string, attrs: Record<string, unknown>, row?: number) {
  const meta = await dictGuard.assertType(type);
  const result = meta.schema.safeParse(attrs);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: `attrs.${i.path.join('.')}`,
      message: i.message,
    }));
    const summary = details
      .slice(0, 3)
      .map((d) => `${d.field.replace(/^attrs\./, '')}：${d.message}`)
      .join('；');
    const suffix = details.length > 3 ? ` 等 ${details.length} 项` : '';
    throw validationError(`${row ? `第 ${row} 行` : ''}资源属性校验失败：${summary}${suffix}`, details);
  }
  const value = { ...(result.data as Record<string, unknown>) };
  // 选填字段允许空串，落库前统一清掉，避免列表展示出空白值
  for (const [k, v] of Object.entries(value)) if (v === '' || v === undefined) delete value[k];
  return value;
}

/** 某资源被多少个子资源引用（用于删除前置校验与容量明细） */
async function childrenOf(parentId: number): Promise<ResourceRow[]> {
  return resourceRepository.listChildren(parentId);
}

/**
 * 占用快照：allocated = 环境槽位申请 + 直接子资源申请。
 * 子资源的申请量会同时占用父资源容量，因此父资源视角的 allocated 含 childAllocated。
 */
export async function capacityUsageOf(resourceId: number): Promise<{
  allocated: number;
  slotCount: number;
  slotAllocated: number;
  childAllocated: number;
  refs: Awaited<ReturnType<typeof resourceRefRepository.listByResource>>;
  children: ResourceRow[];
}> {
  const [usage, refs, children] = await Promise.all([
    resourceRepository.capacityUsageByResources([resourceId]),
    resourceRefRepository.listByResource(resourceId),
    childrenOf(resourceId),
  ]);
  const snapshot = usage.get(resourceId);
  return {
    allocated: snapshot?.allocated ?? 0,
    slotCount: refs.length,
    slotAllocated: snapshot?.slotAllocated ?? 0,
    childAllocated: snapshot?.childAllocated ?? 0,
    refs,
    children,
  };
}

/**
 * 把资源的占用记录折算成「按时间段的峰值占用」：
 * 槽位占用带起止时间（不重叠不累加、重叠求和），子资源申请为恒定基线。
 */
export function peakUsageOf(
  refs: Awaited<ReturnType<typeof resourceRefRepository.listByResource>>,
  childAmount: number,
): { peak: ReturnType<typeof peakOf>; segments: CapacitySegment[] } {
  const segments: CapacitySegment[] = refs.map((r) => ({
    id: r.slotId,
    amount: r.amount ?? 0,
    startAt: r.startAt ?? null,
    endAt: r.endAt ?? null,
  }));
  return { peak: peakOf(segments, childAmount), segments };
}

/**
 * 批量计算多个资源的「按时间段峰值占用」，供台账列表与详情共用同一口径。
 * 只查询设置了容量的资源，避免无关开销。
 */
async function peakAmountByResources(
  rows: { id: number; capacityTotal?: number | null }[],
  usage: Map<number, { childAllocated: number }>,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = rows.filter((r) => r.capacityTotal !== null && r.capacityTotal !== undefined).map((r) => r.id);
  if (ids.length === 0) return out;
  const refsMap = await resourceRefRepository.listByResources(ids);
  for (const id of ids) {
    const childAmount = usage.get(id)?.childAllocated ?? 0;
    const segments: CapacitySegment[] = (refsMap.get(id) ?? []).map((r) => ({
      id: r.slotId,
      amount: r.amount ?? 0,
      startAt: r.startAt ?? null,
      endAt: r.endAt ?? null,
    }));
    out.set(id, peakOf(segments, childAmount).amount);
  }
  return out;
}

/**
 * 调整容量前的校验：
 * - 取消容量核算：仍有槽位引用或子资源申请时拒绝
 * - 调小容量：新容量必须装得下「槽位占用 + 子资源申请」，冲突时返回占用明细
 * - 子资源自身容量：新容量必须 ≥ 已被其下级占用的部分
 */
async function assertCapacityAdjustable(
  row: ResourceRow,
  nextTotal: number | null,
  nextDemand?: number | null,
) {
  const unitSuffix = row.capacityUnit ? ` ${row.capacityUnit}` : '';
  const { allocated, slotCount, childAllocated, refs, children } = await capacityUsageOf(row.id);
  const childCount = children.length;

  if (nextTotal === null) {
    if (slotCount > 0 || childCount > 0) {
      const parts = [
        slotCount > 0 ? `${slotCount} 个环境槽位` : null,
        childCount > 0 ? `${childCount} 个子资源` : null,
      ].filter(Boolean);
      throw conflict(
        `资源 ${row.code} 仍被 ${parts.join('、')}引用（已占用 ${round2(allocated)}${unitSuffix}），请先解除引用再取消容量设置`,
        {
          field: 'capacityTotal',
          allocated,
          slotCount,
          childCount,
          reason: 'CAPACITY_STILL_ALLOCATED',
        },
      );
    }
    return;
  }

  if (allocated > nextTotal + 1e-9) {
    const maps = await loadProjectLabels();
    throw conflict(
      `调整后容量 ${round2(nextTotal)}${unitSuffix} 小于当前已占用 ${round2(allocated)}${unitSuffix}，请先释放 ${round2(allocated - nextTotal)}${unitSuffix} 的占用`,
      {
        field: 'capacityTotal',
        total: nextTotal,
        allocated: round2(allocated),
        slotAllocated: round2(allocated - childAllocated),
        childAllocated: round2(childAllocated),
        unit: row.capacityUnit ?? null,
        shortage: round2(allocated - nextTotal),
        references: slotReferenceDetails(refs, maps),
        children: children.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          demandAmount: c.demandAmount ?? 0,
        })),
        reason: 'CAPACITY_EXCEEDED',
      },
    );
  }

  // 子资源自身容量不得小于其下级已占用（槽位 + 孙资源）
  if (nextDemand !== undefined && nextDemand !== null && childCount > 0) {
    const selfSlotAllocated = refs.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    const occupiedBelow = selfSlotAllocated + childAllocated;
    if (nextDemand + 1e-9 < occupiedBelow) {
      throw conflict(
        `子资源 ${row.code} 下调后的申请量 ${round2(nextDemand)}${unitSuffix} 小于其下级已占用 ${round2(occupiedBelow)}${unitSuffix}，请先释放下级占用`,
        {
          field: 'demandAmount',
          demand: nextDemand,
          slotAllocated: round2(selfSlotAllocated),
          childAllocated: round2(childAllocated),
          unit: row.capacityUnit ?? null,
        },
      );
    }
  }
}

/** 槽位占用明细（容量冲突时回给前端） */
function slotReferenceDetails(
  refs: Awaited<ReturnType<typeof resourceRefRepository.listByResource>>,
  maps: ProjectLabelMaps,
) {
  return refs
    .filter((r) => (r.amount ?? 0) > 0)
    .map((r) => ({
      projectName: r.projectId ? (maps.projects.get(r.projectId) ?? null) : null,
      envName: r.envName,
      slotRole: r.slotRole,
      amount: r.amount,
    }));
}

/**
 * 校验子资源向父资源申请的容量：
 * 父资源必须已设置容量，且「父资源现有槽位占用 + 其它子资源申请 + 本次申请」不得超过父资源总容量。
 */
export async function assertParentCapacityAvailable(
  parent: ResourceRow,
  demand: number | null | undefined,
  excludeChildId?: number,
): Promise<void> {
  const unitSuffix = parent.capacityUnit ? ` ${parent.capacityUnit}` : '';
  if (parent.capacityTotal === null) {
    throw validationError(
      `父资源 ${parent.code} 未设置容量，无法创建子资源并申请容量。请先为父资源启用容量管理`,
      { field: 'parentId', code: 'PARENT_CAPACITY_REQUIRED', parentId: parent.id },
    );
  }
  if (demand === null || demand === undefined || demand <= 0) {
    throw validationError(`挂载到父资源 ${parent.code} 时必须填写申请的容量`, {
      field: 'demandAmount',
      code: 'DEMAND_REQUIRED',
      parentId: parent.id,
    });
  }

  const usage = (await resourceRepository.capacityUsageByResources([parent.id])).get(parent.id);
  const childRows = await childrenOf(parent.id);
  const siblingDemand = childRows
    .filter((c) => c.id !== excludeChildId)
    .reduce((sum, c) => sum + (c.demandAmount ?? 0), 0);
  const parentSlotAllocated = usage?.slotAllocated ?? 0;
  const used = round2(parentSlotAllocated + siblingDemand);
  const available = round2(parent.capacityTotal - used);

  if (demand > available + 1e-9) {
    throw conflict(
      `申请容量 ${demand}${unitSuffix} 超出父资源 ${parent.code} 的剩余可用容量 ${available}${unitSuffix}（总容量 ${parent.capacityTotal}${unitSuffix}，槽位已占 ${round2(parentSlotAllocated)}${unitSuffix}，其他子资源已占 ${round2(siblingDemand)}${unitSuffix}）`,
      {
        field: 'demandAmount',
        code: 'CAPACITY_EXCEEDED',
        requested: demand,
        available,
        total: parent.capacityTotal,
        slotAllocated: round2(parentSlotAllocated),
        siblingDemand: round2(siblingDemand),
        unit: parent.capacityUnit ?? null,
        parent: { id: parent.id, code: parent.code, name: parent.name },
      },
    );
  }
}

/**
 * 校验某个槽位对资源的容量申请：
 * - 资源未设容量 → 无需填写，也不做限制
 * - 资源设了容量 → 必须填写申请量，且「本次占用期间的已有峰值占用 + 本次申请」不得超过总容量
 *
 * 占用按**时间段**计算：与本次区间不重叠的历史占用可以复用同一份容量，
 * 只有时间上重叠的占用才相加（见 lib/capacity.ts）。未给时间段视为长期占用，与所有占用重叠。
 */
export async function assertCapacityAvailable(
  row: ResourceRow,
  slotId: number | null,
  amount: number | null | undefined,
  period?: { startAt: Date | null; endAt: Date | null },
): Promise<void> {
  if (row.capacityTotal === null) return;
  const unitSuffix = row.capacityUnit ? ` ${row.capacityUnit}` : '';
  const { refs, childAllocated } = await capacityUsageOf(row.id);
  const others = refs
    .filter((r) => r.slotId !== slotId)
    .map((r) => ({
      id: r.slotId,
      amount: r.amount ?? 0,
      startAt: r.startAt ?? null,
      endAt: r.endAt ?? null,
    }));
  // 本次占用区间内的已有峰值（不含自身），null 区间视为与全部占用重叠
  const peak = peakWithin(others, period?.startAt ?? null, period?.endAt ?? null, childAllocated);
  const allocatedExcludingSelf = round2(peak.amount);
  const available = round2(row.capacityTotal - allocatedExcludingSelf);
  const periodHint = formatPeriod(period?.startAt ?? null, period?.endAt ?? null);

  if (amount === null || amount === undefined || amount <= 0) {
    throw validationError(
      `资源 ${row.code} 已设置容量，请填写该槽位申请的容量（剩余可用 ${available}${unitSuffix}）`,
      {
        field: 'amount',
        code: 'CAPACITY_REQUIRED',
        available,
        unit: row.capacityUnit ?? null,
        childAllocated: round2(childAllocated),
      },
    );
  }
  if (amount > available + 1e-9) {
    throw conflict(
      `申请容量 ${amount}${unitSuffix} 超出资源 ${row.code}${periodHint}的剩余可用容量 ${available}${unitSuffix}`,
      {
        field: 'amount',
        code: 'CAPACITY_EXCEEDED',
        requested: amount,
        available,
        total: row.capacityTotal,
        allocated: allocatedExcludingSelf,
        childAllocated: round2(childAllocated),
        unit: row.capacityUnit ?? null,
        /** 峰值口径：未按时间段拆分时的合计（用于提示「错峰可复用容量」） */
        allocatedSum: round2(
          others.reduce((sum, r) => sum + r.amount, 0) + childAllocated,
        ),
        peak: {
          amount: peak.amount,
          startAt: peak.startAt ? peak.startAt.toISOString() : null,
          endAt: peak.endAt ? peak.endAt.toISOString() : null,
        },
      },
    );
  }
}

/** 占用区间的中文提示，用于容量报错里说明「按哪个时间段核算」 */
function formatPeriod(startAt: Date | null, endAt: Date | null): string {
  if (!startAt && !endAt) return '';
  const fmt = (d: Date | null) =>
    d ? d.toISOString().slice(0, 10) : '长期';
  return `在 ${fmt(startAt)} → ${fmt(endAt)} 期间`;
}

/** 资源被指定项目之外的其它项目占用的明细（跨项目共享引用需要提示） */
export async function otherProjectUsageOf(resourceId: number, excludeProjectId: number | null) {
  const refs = await resourceRefRepository.listByResource(resourceId);
  const maps = await loadProjectLabels();
  const out: {
    projectId: number | null;
    projectName: string | null;
    envId: number;
    envName: string;
    environment: string;
    environmentLabel: string;
    slotId: number;
    slotRole: string;
    amount: number | null;
    startAt: string | null;
    endAt: string | null;
    overdueDays: number;
    occupancyState: 'ACTIVE' | 'EXPIRED';
    notStarted: boolean;
  }[] = [];
  for (const r of refs) {
    if (r.projectId === excludeProjectId) continue;
    out.push({
      projectId: r.projectId,
      projectName: r.projectId ? (maps.projects.get(r.projectId) ?? null) : null,
      envId: r.envId,
      envName: r.envName,
      environment: r.environment,
      environmentLabel: await environmentLabelOf(r.environment),
      slotId: r.slotId,
      slotRole: r.slotRole,
      amount: r.amount,
      startAt: r.startAt ? new Date(r.startAt).toISOString() : null,
      endAt: r.endAt ? new Date(r.endAt).toISOString() : null,
      overdueDays: overdueDaysOf(r.endAt),
      occupancyState: occupancyStateOf(r.startAt, r.endAt) ?? 'ACTIVE',
      notStarted: notStartedOf(r.startAt),
    });
  }
  return out;
}

/** 批量取父资源 / 子资源信息，避免列表接口 N+1 */
async function loadHierarchy(rows: ResourceRow[]): Promise<Map<number, HierarchyLabels>> {
  const map = new Map<number, HierarchyLabels>();
  if (rows.length === 0) return map;

  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((id): id is number => id !== null))];
  const parents = await resourceRepository.findByIds(parentIds);
  const parentMap = new Map(parents.map((p) => [p.id, p]));

  const ids = rows.map((r) => r.id);
  const children = await resourceRepository.listChildrenByParents(ids);
  const childMap = new Map<number, ResourceRow[]>();
  for (const child of children) {
    if (child.parentId === null) continue;
    const list = childMap.get(child.parentId) ?? [];
    list.push(child);
    childMap.set(child.parentId, list);
  }

  for (const row of rows) {
    const parent = row.parentId ? parentMap.get(row.parentId) : undefined;
    const own = childMap.get(row.id) ?? [];
    map.set(row.id, {
      parentCode: parent?.code ?? null,
      parentName: parent?.name ?? null,
      childCount: own.length,
      childAllocated: own.reduce((sum, c) => sum + (c.demandAmount ?? 0), 0),
    });
  }
  return map;
}

/**
 * IP 占用校验：
 * - 主机类资源按 IP 判重
 * - 平台地址类资源按 IP + 端口判重
 * 仅与「在用 / 预留」状态的资源比较。
 */
async function assertNoIpConflict(
  type: string,
  attrs: Record<string, unknown>,
  environment: string,
  excludeId?: number,
) {
  const ips = extractIps(attrs, await ipFieldsOf(type));
  if (ips.length === 0) return;
  const byPort = await ipUniqueByPortOf(type);
  const port = typeof attrs['port'] === 'number' ? (attrs['port'] as number) : Number(attrs['port']);

  for (const { field, value } of ips) {
    const candidates = await resourceRepository.findByIp(value);
    let hit: (typeof candidates)[number] | undefined;
    for (const c of candidates) {
      if (excludeId && c.id === excludeId) continue;
      // 子资源的 IP 继承自父资源，不构成独立占用：既不参与冲突检测，也不作为冲突来源
      if (c.parentId !== null) continue;
      if (c.environment !== environment) continue;
      if (!['IN_USE', 'RESERVED'].includes(c.status)) continue;
      const cAttrs = (c.attrs ?? {}) as Record<string, unknown>;
      const cIps = extractIps(cAttrs, await ipFieldsOf(c.type));
      if (!cIps.some((x) => x.value === value)) continue;
      if (!byPort) {
        hit = c;
        break;
      }
      const cPort = Number(cAttrs['port']);
      if (Number.isFinite(cPort) && Number.isFinite(port) ? cPort === port : true) {
        hit = c;
        break;
      }
    }
    if (hit) {
      throw conflict(`IP ${value} 已被资源 ${hit.code}（${hit.name}）占用`, {
        field,
        ip: value,
        conflictWith: { code: hit.code, name: hit.name, type: hit.type },
      });
    }
  }
}

function diffChanges(
  before: ResourceRow,
  after: ResourceRow,
  maps?: ProjectLabelMaps,
): AuditChange[] {
  const baseLabels: Record<string, string> = {
    name: '资源名称',
    environment: '环境',
    status: '状态',
    datacenter: '机房',
    owner: '负责人',
    tags: '标签',
    remark: '备注',
    projectId: '所属项目',
    projectEnvId: '所属项目环境',
    parentId: '父资源',
    demandAmount: '申请容量',
    capacityTotal: '总容量',
    capacityUnit: '容量单位',
  };
  const changes: AuditChange[] = [];
  const push = (field: string, label: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) === JSON.stringify(to)) return;
    changes.push({ field, label, from: from ?? null, to: to ?? null });
  };
  for (const [field, label] of Object.entries(baseLabels)) {
    push(field, label, before[field as keyof ResourceRow], after[field as keyof ResourceRow]);
  }
  if (before.status !== after.status) {
    const last = changes.find((c) => c.field === 'status');
    if (last) {
      last.from = RESOURCE_STATUS_LABELS[before.status];
      last.to = RESOURCE_STATUS_LABELS[after.status];
    }
  }
  // 项目归属用名称展示，审计日志里不出现裸 id
  for (const [field, map] of [
    ['projectId', maps?.projects],
    ['projectEnvId', maps?.envs],
  ] as const) {
    const change = changes.find((c) => c.field === field);
    if (change && map) {
      change.from = change.from ? (map.get(Number(change.from)) ?? String(change.from)) : null;
      change.to = change.to ? (map.get(Number(change.to)) ?? String(change.to)) : null;
    }
  }
  const beforeAttrs = (before.attrs ?? {}) as Record<string, unknown>;
  const afterAttrs = (after.attrs ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(beforeAttrs), ...Object.keys(afterAttrs)])) {
    push(`attrs.${key}`, key, beforeAttrs[key], afterAttrs[key]);
  }
  return changes;
}

export const resourceService = {
  async list(query: ResourceQuery) {
    const scope = await resolveScope(query);
    const { items, meta } = await resourceRepository.list(query, scope);
    const maps = await loadProjectLabels();
    const usage = await resourceRepository.capacityUsageByResources(items.map((r) => r.id));
    const hierarchy = await loadHierarchy(items);
    // 台账的容量列与详情同为「按时间段的峰值」口径：错峰占用不累加，避免合计虚高
    const peaks = await peakAmountByResources(items, usage);
    return {
      items: items.map((r) =>
        toResourceDto(r, labelsOf(r, maps), usage.get(r.id), hierarchy.get(r.id), peaks.get(r.id) ?? null),
      ),
      meta,
    };
  },

  /** 资源详情：DTO + 容量明细 + 被哪些项目/环境/槽位引用 + 父子层级 */
  async get(id: number): Promise<ResourceDetail> {
    const row = await resourceRepository.findById(id);
    if (!row) throw notFound(`资源 ${id} 不存在`);
    const maps = await loadProjectLabels();
    const [usage, refs, children, ancestors] = await Promise.all([
      resourceRepository.capacityUsageByResources([id]),
      resourceRefRepository.listByResource(id),
      resourceRepository.listChildren(id),
      resourceRepository.ancestorsOf(id),
    ]);
    const hierarchy = await loadHierarchy([row, ...children]);
    const dto = toResourceDto(row, labelsOf(row, maps), usage.get(id), hierarchy.get(id));
    const references: ResourceReference[] = [];
    for (const r of refs) {
      references.push({
        projectId: r.projectId,
        projectName: r.projectId ? (maps.projects.get(r.projectId) ?? null) : null,
        envId: r.envId,
        envName: r.envName,
        environment: r.environment,
        environmentLabel: await environmentLabelOf(r.environment),
        slotId: r.slotId,
        slotRole: r.slotRole,
        amount: r.amount,
        startAt: r.startAt ? new Date(r.startAt).toISOString() : null,
        endAt: r.endAt ? new Date(r.endAt).toISOString() : null,
        overdueDays: overdueDaysOf(r.endAt),
        occupancyState: occupancyStateOf(r.startAt, r.endAt) ?? 'ACTIVE',
        notStarted: notStartedOf(r.startAt),
      });
    }

    // 按项目聚合占用，便于一眼看清容量去向
    const byProject = new Map<string, { projectId: number | null; projectName: string | null; envIds: Set<number>; slotCount: number; amount: number }>();
    for (const ref of references) {
      const key = String(ref.projectId ?? '—');
      const cur =
        byProject.get(key) ??
        { projectId: ref.projectId, projectName: ref.projectName, envIds: new Set<number>(), slotCount: 0, amount: 0 };
      cur.envIds.add(ref.envId);
      cur.slotCount += 1;
      cur.amount += ref.amount ?? 0;
      byProject.set(key, cur);
    }

    const childDtos: ResourceChild[] = [];
    for (const child of children) {
      const childUsage = await resourceRepository.capacityUsageByResources([child.id]);
      const childDetail = hierarchy.get(child.id);
      childDtos.push({
        id: child.id,
        code: child.code,
        name: child.name,
        type: child.type,
        typeLabel: (await getTypeMeta(child.type)).label,
        environment: child.environment,
        environmentLabel: await environmentLabelOf(child.environment),
        status: child.status,
        demandAmount: child.demandAmount ?? null,
        capacityTotal: child.capacityTotal ?? null,
        capacityAllocated: round2(childUsage.get(child.id)?.allocated ?? 0),
        slotRefCount: childUsage.get(child.id)?.slotCount ?? 0,
        childCount: childDetail?.childCount ?? 0,
        projectId: child.projectId ?? null,
        projectName: child.projectId ? (maps.projects.get(child.projectId) ?? null) : null,
        attrs: (child.attrs ?? {}) as Record<string, unknown>,
      });
    }

    // 按时间段的峰值占用：不重叠的占用不累加，重叠的求和
    const childBaseline = usage.get(id)?.childAllocated ?? 0;
    const { peak } = peakUsageOf(refs, childBaseline);
    const refBySlot = new Map(refs.map((r) => [r.slotId, r]));
    const peakDto: CapacityPeak = {
      amount: peak.amount,
      segmentAmount: peak.segmentAmount,
      constantAmount: round2(childBaseline),
      startAt: peak.startAt ? peak.startAt.toISOString() : null,
      endAt: peak.endAt ? peak.endAt.toISOString() : null,
      slotCount: peak.ids.length,
      items: peak.ids
        .map((slotId) => refBySlot.get(slotId))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({
          slotId: r.slotId,
          projectId: r.projectId,
          projectName: r.projectId ? (maps.projects.get(r.projectId) ?? null) : null,
          envName: r.envName,
          slotRole: r.slotRole,
          amount: r.amount,
          startAt: r.startAt ? new Date(r.startAt).toISOString() : null,
          endAt: r.endAt ? new Date(r.endAt).toISOString() : null,
        })),
      curve: peak.curve.map((c) => ({
        startAt: c.startAt ? c.startAt.toISOString() : null,
        endAt: c.endAt ? c.endAt.toISOString() : null,
        amount: c.amount,
      })),
    };

    return {
      ...dto,
      capacity: capacityDetailOf(row, usage.get(id), peakDto),
      references,
      capacityByProject: [...byProject.values()]
        .map((v) => ({
          projectId: v.projectId,
          projectName: v.projectName,
          envCount: v.envIds.size,
          slotCount: v.slotCount,
          amount: round2(v.amount),
        }))
        .sort((a, b) => b.amount - a.amount),
      children: childDtos,
      ancestors: ancestors.map((a) => ({ id: a.id, code: a.code, name: a.name })).reverse(),
    };
  },

  /** 某资源被占用的时间轴（跨项目 / 跨环境），并标注区间重叠的共用情况 */
  async timeline(id: number): Promise<ResourceTimeline> {
    const row = await resourceRepository.findById(id);
    if (!row) throw notFound(`资源 ${id} 不存在`);
    const [refs, maps] = await Promise.all([
      resourceRefRepository.listByResource(id),
      loadProjectLabels(),
    ]);

    const now = new Date();
    const entries = refs.map((r) => {
      const state = occupancyStateOf(r.startAt, r.endAt, now) ?? 'ACTIVE';
      return {
        slotId: r.slotId,
        envId: r.envId,
        envName: r.envName,
        projectId: r.projectId,
        projectName: r.projectId ? (maps.projects.get(r.projectId) ?? null) : null,
        environment: r.environment,
        environmentLabel: '—',
        slotRole: r.slotRole,
        amount: r.amount,
        startAt: (r.startAt ? new Date(r.startAt) : new Date(row.createdAt)).toISOString(),
        endAt: r.endAt ? new Date(r.endAt).toISOString() : null,
        overdueDays: overdueDaysOf(r.endAt, now),
        occupancyState: state,
        notStarted: notStartedOf(r.startAt, now),
        shared: false,
      };
    });
    for (const e of entries) e.environmentLabel = await environmentLabelOf(e.environment);

    const overlaps: { a: number; b: number; from: string; to: string | null }[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i]!;
        const b = entries[j]!;
        const range = overlapRange(
          new Date(a.startAt),
          a.endAt ? new Date(a.endAt) : null,
          new Date(b.startAt),
          b.endAt ? new Date(b.endAt) : null,
        );
        if (!range) continue;
        a.shared = true;
        b.shared = true;
        overlaps.push({
          a: a.slotId,
          b: b.slotId,
          from: (range.from ?? new Date(a.startAt)).toISOString(),
          to: range.to ? range.to.toISOString() : null,
        });
      }
    }

    // 时间轴范围：覆盖全部占用区间，最少展示前后各 45 天
    const starts = entries.map((e) => new Date(e.startAt).getTime());
    const ends = entries.filter((e) => e.endAt).map((e) => new Date(e.endAt!).getTime());
    const hasLongTerm = entries.some((e) => e.endAt === null);
    const min = starts.length > 0 ? Math.min(...starts, now.getTime() - 45 * 86400000) : now.getTime() - 45 * 86400000;
    const max = Math.max(
      now.getTime() + 45 * 86400000,
      ...ends,
      hasLongTerm ? now.getTime() + 180 * 86400000 : now.getTime(),
    );

    return {
      resource: {
        id: row.id,
        code: row.code,
        name: row.name,
        type: row.type,
        typeLabel: (await getTypeMeta(row.type)).label,
        capacityTotal: row.capacityTotal ?? null,
        capacityUnit: row.capacityUnit ?? null,
      },
      range: {
        from: new Date(min).toISOString(),
        to: new Date(max).toISOString(),
        today: now.toISOString(),
      },
      entries,
      expiredCount: entries.filter((e) => e.occupancyState === 'EXPIRED').length,
      overlaps,
    };
  },

  async create(
    input: {
      type: string;
      name: string;
      environment: string;
      status?: string;
      datacenter?: string;
      owner?: string;
      tags?: string[];
      remark?: string;
      projectId?: number | null;
      projectEnvId?: number | null;
      attrs: Record<string, unknown>;
      capacityTotal?: number | null;
      capacityUnit?: string | null;
      capacityRemark?: string | null;
      parentId?: number | null;
      demandAmount?: number | null;
    },
    actor: Actor,
    requestId?: string,
  ): Promise<ResourceDto> {
    await dictGuard.assertEnvironment(input.environment);

    // —— 父子层级：子资源必须与父资源同类型，并在父资源剩余容量内申请一段容量
    const parent = input.parentId ? await resourceRepository.findById(input.parentId) : null;
    if (input.parentId && !parent) throw notFound(`父资源 ${input.parentId} 不存在`);
    if (parent && parent.type !== input.type) {
      throw validationError('子资源类型必须与父资源一致', {
        field: 'type',
        parentType: parent.type,
        parentTypeLabel: (await getTypeMeta(parent.type)).label,
      });
    }
    if (parent) await assertParentCapacityAvailable(parent, input.demandAmount ?? null);

    /**
     * 子资源属性：
     * - 必填属性一律继承父资源，调用方即使传入不同值也会被父资源覆盖（前端渲染为只读）
     * - 非必填属性允许子资源自行补充，用于描述该子资源特有的信息
     */
    let baseAttrs = input.attrs;
    if (parent) {
      const meta = await getTypeMeta(input.type);
      const requiredKeys = new Set(meta.fields.filter((f) => f.required).map((f) => f.key));
      const extras = Object.fromEntries(
        Object.entries(input.attrs ?? {}).filter(([key]) => !requiredKeys.has(key)),
      );
      baseAttrs = { ...(parent.attrs ?? {}), ...extras };
    }
    const attrs = await validateAttrs(input.type, baseAttrs);
    // 子资源的 IP 等必填属性继承自父资源，不构成独立占用，由父资源代表参与冲突检测
    if (!parent) await assertNoIpConflict(input.type, attrs, input.environment);

    const envInherited = parent ? (input.environment ?? parent.environment) : input.environment;
    const { projectId, projectEnvId } = await resolveProjectRef({
      // 子资源默认继承父资源的项目归属，便于在项目视图里一并管理
      projectId: input.projectId !== undefined ? input.projectId : (parent?.projectId ?? null),
      projectEnvId: input.projectEnvId !== undefined ? input.projectEnvId : (parent?.projectEnvId ?? null),
    });

    const code = await resourceRepository.nextCode(input.type);
    const row = await resourceRepository.create({
      code,
      name: input.name,
      type: input.type,
      environment: envInherited as ResourceRow['environment'],
      status: (input.status ?? 'IN_USE') as ResourceRow['status'],
      datacenter: input.datacenter ?? parent?.datacenter ?? null,
      owner: input.owner ?? parent?.owner ?? null,
      projectId,
      projectEnvId,
      tags: input.tags ?? [],
      remark: input.remark ?? null,
      attrs,
      parentId: parent?.id ?? null,
      demandAmount: parent ? (input.demandAmount ?? null) : null,
      // 子资源自身的容量上限即向父资源申请的额度，避免出现「申请 100 却对外声称 1000」
      capacityTotal: parent
        ? (input.demandAmount ?? null)
        : (input.capacityTotal ?? null),
      capacityUnit: parent ? (parent.capacityUnit ?? null) : (input.capacityTotal != null ? (input.capacityUnit ?? null) : null),
      capacityRemark: parent ? (input.capacityRemark ?? `从父资源 ${parent.code} 申请`) : (input.capacityRemark ?? null),
      createdById: actor.id,
      createdByName: actor.username,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const maps = await loadProjectLabels();
    const hierarchy = await loadHierarchy([row]);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'CREATE',
      targetType: 'RESOURCE',
      targetId: String(row.id),
      targetName: `${row.code} ${row.name}`,
      changes: [
        {
          field: '*',
          label: parent ? `创建子资源（父资源 ${parent.code}，申请容量 ${input.demandAmount ?? '—'}）` : '创建资源',
          from: null,
          to: toResourceDto(row, labelsOf(row, maps), undefined, hierarchy.get(row.id)),
        },
      ],
      requestId,
    });
    return toResourceDto(row, labelsOf(row, maps), undefined, hierarchy.get(row.id));
  },

  async update(
    id: number,
    patch: {
      name?: string;
      environment?: string;
      status?: string;
      datacenter?: string;
      owner?: string;
      tags?: string[];
      remark?: string;
      projectId?: number | null;
      projectEnvId?: number | null;
      attrs?: Record<string, unknown>;
      capacityTotal?: number | null;
      capacityUnit?: string | null;
      capacityRemark?: string | null;
      parentId?: number | null;
      demandAmount?: number | null;
    },
    actor: Actor,
    requestId?: string,
  ): Promise<ResourceDto> {
    const before = await resourceRepository.findById(id);
    if (!before) throw notFound(`资源 ${id} 不存在`);

    if (patch.environment) await dictGuard.assertEnvironment(patch.environment);

    // —— 父子层级变更：改挂父资源 / 调整申请量 / 脱离父资源
    const parentTouched = patch.parentId !== undefined || patch.demandAmount !== undefined;
    const nextParentId = patch.parentId !== undefined ? patch.parentId : before.parentId;
    const nextDemand = patch.demandAmount !== undefined ? patch.demandAmount : before.demandAmount;
    let parent: ResourceRow | null = null;

    if (parentTouched) {
      if (nextParentId === id) {
        throw validationError('资源不能作为自己的父资源', { field: 'parentId' });
      }
      if (nextParentId !== null) {
        parent = await resourceRepository.findById(nextParentId) ?? null;
        if (!parent) throw notFound(`父资源 ${nextParentId} 不存在`);
        if (parent.type !== before.type) {
          throw validationError('子资源类型必须与父资源一致', {
            field: 'parentId',
            parentType: parent.type,
            parentTypeLabel: (await getTypeMeta(parent.type)).label,
          });
        }
        // 防止把父资源挂到自己的后代下形成环
        const descendants = await resourceRepository.descendantIds(id);
        if (descendants.includes(parent.id)) {
          throw validationError('不能把资源挂到它自己的子资源下，会形成循环层级', { field: 'parentId' });
        }
        await assertParentCapacityAvailable(parent, nextDemand ?? null, id);
      } else if (nextDemand) {
        throw validationError('未挂载父资源时不能设置申请容量', { field: 'demandAmount' });
      }
    }

    /**
     * 子资源的父资源：既包括本次改挂，也包括原本就挂着的情况。
     * 提前取出来，后面容量校验与「必填属性锁定」都要用。
     */
    const nextParent = parentTouched
      ? parent
      : before.parentId
        ? (await resourceRepository.findById(before.parentId)) ?? null
        : null;

    // 子资源的总容量由申请额度派生，不接受直接改写（避免出现「申请 100 却对外声称 1000」）
    if (nextParent && patch.capacityTotal !== undefined) {
      throw validationError('子资源的总容量由向父资源申请的额度决定，请调整「申请容量」', {
        field: 'demandAmount',
        parentId: nextParent.id,
      });
    }

    // 调容量前先核算现有占用（槽位 + 子资源），避免下调后装不下已有申请：
    // 顶层资源校验「新总容量 ≥ 已占用」，子资源校验「新申请量 ≥ 其下级已占用」
    if (patch.capacityTotal !== undefined && !nextParent) {
      await assertCapacityAdjustable(before, patch.capacityTotal);
    }
    if (patch.demandAmount !== undefined) {
      await assertCapacityAdjustable(before, before.capacityTotal, patch.demandAmount);
    }

    /**
     * 子资源的必填属性一律继承父资源：创建时如此，编辑时也保持同步，
     * 只允许子资源自行补充「非必填」的额外属性（如用途备注、配额说明）。
     */
    const mergedAttrs = { ...(before.attrs ?? {}), ...(patch.attrs ?? {}) };
    if (nextParent) {
      const meta = await getTypeMeta(before.type);
      const parentAttrs = (nextParent.attrs ?? {}) as Record<string, unknown>;
      for (const field of meta.fields) {
        if (field.required) mergedAttrs[field.key] = parentAttrs[field.key];
      }
    }
    const attrs = await validateAttrs(before.type, mergedAttrs);
    const environment = patch.environment ?? before.environment;
    if (!nextParent) await assertNoIpConflict(before.type, attrs, environment, id);

    const touchedProject = patch.projectId !== undefined || patch.projectEnvId !== undefined;
    const ref = touchedProject
      ? await resolveProjectRef({
          projectId: patch.projectId !== undefined ? patch.projectId : before.projectId,
          projectEnvId: patch.projectEnvId !== undefined ? patch.projectEnvId : before.projectEnvId,
        })
      : null;

    const nextCapacityTotal = nextParent
      ? (nextDemand ?? null)
      : patch.capacityTotal !== undefined
        ? patch.capacityTotal
        : before.capacityTotal;

    const updated = await resourceRepository.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.environment !== undefined ? { environment: patch.environment as ResourceRow['environment'] } : {}),
      ...(patch.status !== undefined ? { status: patch.status as ResourceRow['status'] } : {}),
      ...(patch.datacenter !== undefined ? { datacenter: patch.datacenter ?? null } : {}),
      ...(patch.owner !== undefined ? { owner: patch.owner ?? null } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.remark !== undefined ? { remark: patch.remark ?? null } : {}),
      ...(touchedProject ? { projectId: ref!.projectId, projectEnvId: ref!.projectEnvId } : {}),
      ...(patch.attrs !== undefined ? { attrs } : {}),
      ...(parentTouched
        ? {
            parentId: nextParent?.id ?? null,
            demandAmount: nextParent ? (nextDemand ?? null) : null,
            capacityTotal: nextCapacityTotal,
            capacityUnit: nextParent ? (nextParent.capacityUnit ?? null) : before.capacityUnit,
          }
        : {}),
      ...(patch.capacityTotal !== undefined && !nextParent
        ? {
            capacityTotal: patch.capacityTotal,
            // 取消容量核算时一并清掉单位，避免残留「0 / GB」这类歧义展示
            capacityUnit: patch.capacityTotal === null ? null : (patch.capacityUnit ?? before.capacityUnit),
          }
        : {}),
      ...(patch.capacityUnit !== undefined && patch.capacityTotal === undefined && !nextParent
        ? { capacityUnit: patch.capacityUnit }
        : {}),
      ...(patch.capacityRemark !== undefined ? { capacityRemark: patch.capacityRemark } : {}),
    });

    const maps = await loadProjectLabels();
    const changes = diffChanges(before, updated, maps);
    if (changes.length > 0) {
      await auditRepository.record({
        actorId: actor.id,
        actorName: actor.username,
        action: 'UPDATE',
        targetType: 'RESOURCE',
        targetId: String(id),
        targetName: `${updated.code} ${updated.name}`,
        changes,
        requestId,
      });
    }
    // 回带容量占用，前端调容量后可立即看到新的「已占用 / 剩余」
    const usage = await resourceRepository.capacityUsageByResources([updated.id]);
    const hierarchy = await loadHierarchy([updated]);
    return toResourceDto(updated, labelsOf(updated, maps), usage.get(updated.id), hierarchy.get(updated.id));
  },

  async remove(id: number, actor: Actor, requestId?: string) {
    const before = await resourceRepository.findById(id);
    if (!before) throw notFound(`资源 ${id} 不存在`);
    const children = await resourceRepository.listChildren(id);
    if (children.length > 0) {
      throw conflict(
        `资源 ${before.code} 下仍有 ${children.length} 个子资源（${children.map((c) => c.code).join('、')}），请先调整或删除子资源后再删除父资源`,
        {
          resourceId: id,
          children: children.map((c) => ({ id: c.id, code: c.code, name: c.name, demandAmount: c.demandAmount })),
          reason: 'HAS_CHILDREN',
        },
      );
    }
    await resourceRepository.remove(id);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'DELETE',
      targetType: 'RESOURCE',
      targetId: String(id),
      targetName: `${before.code} ${before.name}`,
      changes: [{ field: '*', label: '删除资源', from: toResourceDto(before), to: null }],
      requestId,
    });
    return { id };
  },

  /** IP 占用查询：新建资源前的前置校验接口 */
  async checkIp(ip: string) {
    if (!ipv4.safeParse(ip).success) throw validationError('IP 地址格式不正确');
    const rows = await resourceRepository.findByIp(ip);
    const conflicts: {
      code: string;
      name: string;
      type: string;
      typeLabel: string;
      field: string;
    }[] = [];
    for (const r of rows) {
      const attrs = (r.attrs ?? {}) as Record<string, unknown>;
      const match = extractIps(attrs, await ipFieldsOf(r.type)).find((x) => x.value === ip);
      if (!match) continue;
      conflicts.push({
        code: r.code,
        name: r.name,
        type: r.type,
        typeLabel: (await getTypeMeta(r.type)).label,
        field: match.field,
      });
    }
    return { ip, available: conflicts.length === 0, conflicts };
  },

  /** CSV 批量导入：逐行校验，单行失败不影响其他行，返回逐行错误 */
  async importCsv(
    input: { type: string; csv: string; onConflict: 'skip' | 'overwrite' },
    actor: Actor,
    requestId?: string,
  ) {
    const { header, rows } = parseCsv(input.csv);
    const typeMeta = await dictGuard.assertType(input.type);
    const defaultEnv = await defaultEnvironmentCode();
    const result = { total: rows.length, created: 0, updated: 0, skipped: 0, errors: [] as { row: number; message: string }[] };
    if (header.length === 0) throw validationError('CSV 缺少表头');

    for (let i = 0; i < rows.length; i += 1) {
      const lineNo = i + 2; // 表头占第 1 行
      try {
        const raw = rows[i]!;
        const record: Record<string, string> = {};
        for (const key of header) record[key] = raw[key] ?? '';

        const attrs: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(record)) {
          if (['name', 'environment', 'status', 'datacenter', 'owner', 'tags', 'remark', 'project', 'projectEnv'].includes(k)) continue;
          attrs[k] = v === '' ? undefined : coerce(typeMeta.fields, k, v);
        }
        for (const k of Object.keys(attrs)) if (attrs[k] === undefined) delete attrs[k];

        const payload = {
          type: input.type,
          name: record['name'] || `${typeMeta.label}-${lineNo}`,
          environment: record['environment'] || defaultEnv,
          status: record['status'] || 'IN_USE',
          datacenter: record['datacenter'] || undefined,
          owner: record['owner'] || undefined,
          tags: record['tags'] ? record['tags'].split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
          remark: record['remark'] || undefined,
          attrs,
        };

        const validated = await validateAttrs(input.type, attrs, lineNo);

        // 每行独立事务：单行数据库失败不会污染整批 PostgreSQL 事务，
        // 同时保证该行业务写入与审计记录原子提交或回滚。
        const outcome = await withTransaction(async () => {
          // 以「名称 + 环境」作为幂等键，重复导入时按策略跳过或覆盖；
          // 覆盖场景需把自身排除在 IP 冲突校验之外，否则自己跟自己冲突。
          const existing = (await resourceRepository.listAll({ type: input.type, q: payload.name })).find(
            (r) => r.name === payload.name && r.environment === payload.environment,
          );
          await assertNoIpConflict(input.type, validated, payload.environment, existing?.id);

          if (existing) {
            if (input.onConflict === 'skip') return 'skipped';
            await this.update(existing.id, { ...payload, attrs }, actor, requestId);
            return 'updated';
          }
          await this.create({ ...payload, attrs: validated }, actor, requestId);
          return 'created';
        });
        if (outcome === 'skipped') result.skipped += 1;
        if (outcome === 'updated') result.updated += 1;
        if (outcome === 'created') result.created += 1;
      } catch (err) {
        result.errors.push({ row: lineNo, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  },

  /** 导出当前筛选结果为 CSV */
  async exportCsv(query: ResourceQuery) {
    const scope = await resolveScope(query);
    const { items } = await resourceRepository.list({ ...query, page: 1, pageSize: 200 }, scope);
    const maps = await loadProjectLabels();
    const typeLabels = new Map<string, string>();
    for (const r of items) {
      if (!typeLabels.has(r.type)) typeLabels.set(r.type, (await getTypeMeta(r.type)).label);
    }
    const rows = items.map((r) => {
      const attrs = (r.attrs ?? {}) as Record<string, unknown>;
      return {
        code: r.code,
        name: r.name,
        type: r.type,
        typeLabel: typeLabels.get(r.type) ?? r.type,
        environment: r.environment,
        status: r.status,
        project: r.projectId ? (maps.projects.get(r.projectId) ?? '') : '',
        projectEnv: r.projectEnvId ? (maps.envs.get(r.projectEnvId) ?? '') : '',
        datacenter: r.datacenter ?? '',
        owner: r.owner ?? '',
        tags: (r.tags ?? []).join(';'),
        ...attrs,
        remark: r.remark ?? '',
      };
    });
    return toCsv(rows);
  },

  /** 存量资源批量标注项目 / 项目环境 */
  async bulkAssign(
    input: { ids: number[]; projectId: number | null; projectEnvId?: number | null },
    actor: Actor,
    requestId?: string,
  ) {
    const { ids } = input;
    const existing = await resourceRepository.findByIds(ids);
    if (existing.length === 0) throw notFound('所选资源均不存在');

    const ref = await resolveProjectRef({
      projectId: input.projectId,
      projectEnvId: input.projectEnvId ?? null,
    });

    const targetIds = existing.map((r) => r.id);
    await resourceProjectRepository.setProject(targetIds, ref.projectId, ref.projectEnvId);

    const maps = await loadProjectLabels();
    const projectName = ref.projectId ? (maps.projects.get(ref.projectId) ?? String(ref.projectId)) : '未标注';
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'PROJECT',
      targetId: ref.projectId ? String(ref.projectId) : null,
      targetName: projectName,
      changes: [
        {
          field: 'resources',
          label: `批量标注 ${targetIds.length} 个资源`,
          from: null,
          to: existing.map((r) => r.code).join('、'),
        },
      ],
      requestId,
    });

    return { updated: targetIds.length, ids: targetIds };
  },
};

/** 依据字段定义把 CSV 里的字符串转成数字 / 布尔 */
function coerce(fields: RuntimeField[], key: string, value: string): unknown {
  const field = fields.find((f) => f.key === key);
  if (!field) return value;
  if (['NUMBER', 'INTEGER', 'PORT'].includes(field.fieldType)) {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (field.fieldType === 'BOOLEAN') return ['1', 'true', 'yes', 'Y'].includes(value);
  return value;
}

/** CSV 未指定环境时的兜底环境：取字典中排序最靠前的启用环境 */
async function defaultEnvironmentCode(): Promise<string> {
  const list = await environmentRepository.listEnabled();
  return list[0]?.code ?? 'DEV';
}
