import {
  RESOURCE_STATUS_LABELS,
  type EnvSlotDto,
  type EnvTemplateDetail,
  type EnvTemplateDto,
  type EnvTimeline,
  type ProjectDetail,
  type ProjectDto,
  type ProjectEnvDetail,
  type ProjectEnvDto,
  type SlotAssignWarning,
  type SlotCandidate,
  type SlotCandidates,
} from '@dw/shared';
import { badRequest, conflict, notFound, validationError } from '../../lib/errors.js';
import { peakWithin } from '../../lib/capacity.js';
import {
  DAY_MS,
  notStartedOf,
  overdueDaysOf,
  occupancyStateOf,
  parseTime,
  periodsOverlap,
} from '../../lib/occupancy.js';
import { auditRepository } from '../audit/repository.js';
import { environmentLabelOf, environmentService } from '../dict/service.js';
import { getTypeMeta } from '../dict/validator.js';
import { resourceRepository, resourceRefRepository } from '../resources/repository.js';
import { loadProjectLabels } from '../resources/mapper.js';
import { assertCapacityAvailable, capacityUsageOf, otherProjectUsageOf } from '../resources/service.js';
import {
  projectEnvRepository,
  projectRepository,
  resourceProjectRepository,
  slotRepository,
  templateRepository,
  type EnvTemplateQuery,
  type ProjectQuery,
} from './repository.js';
import type { ProjectEnvRow, ProjectRow } from '../../db/schema.js';
import type { ResourceRow } from '../../db/schema.js';

export interface Actor {
  id: number | null;
  username: string;
}

/* ------------------------------------------------------------------ *
 * DTO 映射
 * ------------------------------------------------------------------ */

function toProjectDto(row: ProjectRow, envCount: number, resourceCount: number): ProjectDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    owner: row.owner ?? null,
    status: row.status,
    envCount,
    resourceCount,
    createdBy: row.createdByName ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** 环境显示名：复用字典模块的实时解析，改字典后项目里的标签立即同步 */
function envLabelOf(code: string): Promise<string> {
  return environmentLabelOf(code);
}

async function toEnvDto(
  row: ProjectEnvRow,
  projectName: string,
  templateName: string | null,
  slotTotal: number,
  slotFilled: number,
): Promise<ProjectEnvDto> {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName,
    name: row.name,
    environment: row.environment,
    environmentLabel: await envLabelOf(row.environment),
    templateId: row.templateId ?? null,
    templateName,
    status: row.status,
    description: row.description ?? null,
    owner: row.owner ?? null,
    slotTotal,
    slotFilled,
    createdBy: row.createdByName ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function toSlotDto(
  row: {
    id: number;
    environmentId: number;
    resourceType: string;
    slotRole: string;
    resourceId: number | null;
    demandAmount: number | null;
    sortOrder: number;
    remark: string | null;
    startAt?: Date | null;
    endAt?: Date | null;
    renewCount?: number;
  },
  resource?: ResourceRow | null,
): EnvSlotDto {
  const bound = row.resourceId !== null;
  const startAt = row.startAt ?? null;
  const endAt = row.endAt ?? null;
  return {
    id: row.id,
    environmentId: row.environmentId,
    resourceType: row.resourceType,
    slotRole: row.slotRole,
    resourceId: row.resourceId ?? null,
    resourceCode: resource?.code ?? null,
    resourceName: resource?.name ?? null,
    resourceStatus: resource?.status ?? null,
    demandAmount: row.resourceId === null ? null : (row.demandAmount ?? null),
    startAt: bound && startAt ? new Date(startAt).toISOString() : null,
    endAt: bound && endAt ? new Date(endAt).toISOString() : null,
    overdueDays: bound ? overdueDaysOf(endAt) : 0,
    occupancyState: bound ? occupancyStateOf(startAt, endAt) : null,
    notStarted: bound ? notStartedOf(startAt) : false,
    renewCount: row.renewCount ?? 0,
    sortOrder: row.sortOrder,
    remark: row.remark ?? null,
  };
}

function toTemplateDto(
  row: { id: number; code: string; name: string; description: string | null; builtin: boolean; createdByName: string | null; createdAt: Date; updatedAt: Date },
  items: { quantity: number }[],
  usageCount: number,
): EnvTemplateDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    itemCount: items.length,
    slotCount: items.reduce((s, i) => s + i.quantity, 0),
    usageCount,
    builtin: row.builtin,
    createdBy: row.createdByName ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 查询辅助
 * ------------------------------------------------------------------ */

/**
 * 容量的「软校验」：与 assertCapacityAvailable 同源，但只产出提示不抛错，
 * 供候选列表与绑定前置提示使用。
 */
async function capacityCheckFor(
  resource: ResourceRow,
  slotId: number,
  amount: number | null,
  period?: { startAt: Date | null; endAt: Date | null },
): Promise<SlotAssignWarning | null> {
  if (resource.capacityTotal === null) return null;
  const unitSuffix = resource.capacityUnit ? ` ${resource.capacityUnit}` : '';
  const { refs } = await capacityUsageOf(resource.id);
  // 只统计与本槽位占用区间重叠的部分：错峰占用可以复用同一份容量
  const others = refs
    .filter((r) => r.slotId !== slotId)
    .map((r) => ({
      id: r.slotId,
      amount: r.amount ?? 0,
      startAt: r.startAt ?? null,
      endAt: r.endAt ?? null,
    }));
  const peak = peakWithin(others, period?.startAt ?? null, period?.endAt ?? null);
  const allocatedExcludingSelf = refs
    .filter((r) => r.slotId !== slotId)
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const available = Math.round((resource.capacityTotal - peak.amount) * 100) / 100;
  const capacity = {
    total: resource.capacityTotal,
    unit: resource.capacityUnit ?? null,
    allocated: Math.round(allocatedExcludingSelf * 100) / 100,
    available,
    requested: amount,
  };

  /**
   * 错峰提示：合计占用超过总容量、但按时间段核算仍放得下时，
   * 说明容量是被不同时间段的占用复用的，提示里说清楚避免误判为超容量。
   */
  const offPeak = capacity.allocated > capacity.total && peak.amount <= capacity.total + 1e-9;
  const periodNote =
    peak.startAt || peak.endAt
      ? `（按占用区间 ${peak.startAt ? peak.startAt.toISOString().slice(0, 10) : '长期'} → ${
          peak.endAt ? peak.endAt.toISOString().slice(0, 10) : '长期'
        } 的峰值 ${peak.amount}${unitSuffix} 核算）`
      : '';

  if (amount === null || amount <= 0) {
    return {
      code: 'CAPACITY_REQUIRED',
      message: `资源 ${resource.code} 已设置容量 ${resource.capacityTotal}${unitSuffix}，已占用 ${capacity.allocated}${unitSuffix}，剩余 ${available}${unitSuffix}${periodNote}，请填写本槽位申请的容量`,
      references: [],
      capacity,
    };
  }
  if (amount > available + 1e-9) {
    return {
      code: 'CAPACITY_EXCEEDED',
      message: `申请容量 ${amount}${unitSuffix} 超出资源 ${resource.code} 的剩余可用容量 ${available}${unitSuffix}（总容量 ${resource.capacityTotal}${unitSuffix}，已占用 ${capacity.allocated}${unitSuffix}${
        offPeak ? `，其中错峰复用部分按时间段核算为峰值 ${peak.amount}${unitSuffix}` : ''
      }${periodNote}）`,
      references: [],
      capacity,
    };
  }
  return null;
}

/** 项目关联的资源 = 主归属该项目的资源 ∪ 该项目各环境槽位绑定的资源 */
export async function projectResourceIds(projectId: number): Promise<number[]> {
  const owned = await resourceRepository.listAll({ projectId });
  const envIds = await projectEnvRepository.listByProject(projectId).then((rows) => rows.map((r) => r.id));
  const referenced = await slotRepository.resourceIdsByEnvs(envIds);
  return [...new Set([...owned.map((r) => r.id), ...referenced])];
}

/* ------------------------------------------------------------------ *
 * 项目
 * ------------------------------------------------------------------ */

/** 模板条目摘要：类型名称取字典，支持自定义类型 */
async function templateItemsSummary(
  items: { resourceType: string; quantity?: number }[],
): Promise<string> {
  const parts: string[] = [];
  for (const i of items) {
    parts.push(`${(await getTypeMeta(i.resourceType)).label}×${i.quantity ?? 1}`);
  }
  return parts.join('、');
}

export const projectService = {
  async list(query: ProjectQuery) {
    const { items, meta } = await projectRepository.list(query);
    const out: ProjectDto[] = [];
    for (const row of items) {
      const envs = await projectEnvRepository.listByProject(row.id);
      const resourceIds = await projectResourceIds(row.id);
      out.push(toProjectDto(row, envs.length, resourceIds.length));
    }
    return { items: out, meta };
  },

  async listOptions() {
    const rows = await projectRepository.listAll();
    const out: ProjectDto[] = [];
    for (const row of rows) {
      out.push(toProjectDto(row, (await projectEnvRepository.listByProject(row.id)).length, 0));
    }
    return out;
  },

  async get(id: number): Promise<ProjectDetail> {
    const row = await projectRepository.findById(id);
    if (!row) throw notFound(`项目 ${id} 不存在`);

    const envRows = await projectEnvRepository.listByProject(id);
    const envs: ProjectEnvDto[] = [];
    for (const env of envRows) {
      const { total, filled } = await projectEnvRepository.slotStat(env.id);
      const template = env.templateId ? await templateRepository.findById(env.templateId) : undefined;
      envs.push(await toEnvDto(env, row.name, template?.name ?? null, total, filled));
    }

    const resourceIds = await projectResourceIds(id);
    const rows = await resourceProjectRepository.findByIds(resourceIds);
    const typeMap = new Map<string, number>();
    for (const r of rows) typeMap.set(r.type, (typeMap.get(r.type) ?? 0) + 1);
    const slotRefs = await slotRefsOfProject(id);

    return {
      ...toProjectDto(row, envs.length, resourceIds.length),
      environments: envs,
      slotRefs,
      overdueCount: slotRefs.filter((r) => r.overdueDays > 0).length,
      byType: await Promise.all(
        [...typeMap.entries()].map(async ([type, count]) => ({
          type,
          label: (await getTypeMeta(type)).label,
          count,
        })),
      ),
    };
  },

  async create(
    input: { code?: string; name: string; description?: string; owner?: string; status?: 'ACTIVE' | 'ARCHIVED' },
    actor: Actor,
    requestId?: string,
  ): Promise<ProjectDto> {
    const code = input.code?.trim() || (await projectRepository.nextCode());
    if (await projectRepository.findByCode(code)) throw conflict(`项目编码 ${code} 已存在`);

    const row = await projectRepository.create({
      code,
      name: input.name,
      description: input.description ?? null,
      owner: input.owner ?? null,
      status: input.status ?? 'ACTIVE',
      createdById: actor.id,
      createdByName: actor.username,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'CREATE',
      targetType: 'PROJECT',
      targetId: String(row.id),
      targetName: `${row.code} ${row.name}`,
      changes: [{ field: '*', label: '创建项目', from: null, to: { code: row.code, name: row.name } }],
      requestId,
    });
    return toProjectDto(row, 0, 0);
  },

  async update(
    id: number,
    patch: { name?: string; description?: string; owner?: string; status?: 'ACTIVE' | 'ARCHIVED' },
    actor: Actor,
    requestId?: string,
  ): Promise<ProjectDto> {
    const before = await projectRepository.findById(id);
    if (!before) throw notFound(`项目 ${id} 不存在`);

    const row = await projectRepository.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
      ...(patch.owner !== undefined ? { owner: patch.owner ?? null } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });

    const changes = (['name', 'description', 'owner', 'status'] as const)
      .filter((k) => patch[k] !== undefined && before[k] !== row[k])
      .map((k) => ({ field: k, label: k, from: before[k] ?? null, to: row[k] ?? null }));
    if (changes.length > 0) {
      await auditRepository.record({
        actorId: actor.id,
        actorName: actor.username,
        action: 'UPDATE',
        targetType: 'PROJECT',
        targetId: String(id),
        targetName: `${row.code} ${row.name}`,
        changes,
        requestId,
      });
    }
    const envs = await projectEnvRepository.listByProject(id);
    return toProjectDto(row, envs.length, (await projectResourceIds(id)).length);
  },

  async remove(id: number, actor: Actor, requestId?: string) {
    const before = await projectRepository.findById(id);
    if (!before) throw notFound(`项目 ${id} 不存在`);
    const envs = await projectEnvRepository.listByProject(id);
    if (envs.length > 0) {
      throw conflict(`项目「${before.name}」下仍有 ${envs.length} 套环境，请先删除环境后再归档或删除项目`);
    }
    // 先解除资源的项目归属，避免遗留外键指向已删除的项目
    await resourceProjectRepository.clearProjectRefs(id);
    await projectRepository.remove(id);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'DELETE',
      targetType: 'PROJECT',
      targetId: String(id),
      targetName: `${before.code} ${before.name}`,
      changes: [{ field: '*', label: '删除项目', from: { code: before.code, name: before.name }, to: null }],
      requestId,
    });
    return { id };
  },

  /**
   * 把资源从项目中移出：
   * - 总会解除主归属（project_id / project_env_id）
   * - includeSlots=true 时一并解除该项目所有环境槽位对该资源的引用
   * 返回剩余槽位引用数，便于前端判断资源是否还会出现在项目资源列表中。
   */
  async detach(
    projectId: number,
    resourceId: number,
    includeSlots: boolean,
    actor: Actor,
    requestId?: string,
  ) {
    const project = await projectRepository.findById(projectId);
    if (!project) throw notFound(`项目 ${projectId} 不存在`);
    const resource = await resourceRepository.findById(resourceId);
    if (!resource) throw notFound(`资源 ${resourceId} 不存在`);

    const refs = await slotRefsOfProject(projectId);
    const own = refs.filter((r) => r.resourceId === resourceId);
    let unboundSlots = 0;

    if (includeSlots) {
      for (const ref of own) {
        await slotRepository.update(ref.slotId, {
          resourceId: null,
          demandAmount: null,
          startAt: null,
          endAt: null,
          updatedAt: new Date(),
        });
        unboundSlots += 1;
      }
    }

    const unlabeled = resource.projectId === projectId || resource.projectEnvId !== null;
    if (unlabeled) await resourceProjectRepository.setProject([resourceId], null, null);

    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'RESOURCE',
      targetId: String(resourceId),
      targetName: `${resource.code} ${resource.name}`,
      changes: [
        {
          field: 'projectId',
          label: '移出项目',
          from: resource.projectId === projectId ? project.name : null,
          to: null,
          ...(unboundSlots > 0 ? { extra: `同时解除 ${unboundSlots} 个环境槽位引用` } : {}),
        },
      ],
      requestId,
    });

    return {
      resourceId,
      unlabeled,
      unboundSlots,
      remainingSlotRefs: own.length - unboundSlots,
    };
  },
};

/* ------------------------------------------------------------------ *
 * 项目环境
 * ------------------------------------------------------------------ */

export const projectEnvService = {
  async listByProject(projectId: number): Promise<ProjectEnvDto[]> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw notFound(`项目 ${projectId} 不存在`);
    const rows = await projectEnvRepository.listByProject(projectId);
    const out: ProjectEnvDto[] = [];
    for (const env of rows) {
      const { total, filled } = await projectEnvRepository.slotStat(env.id);
      const template = env.templateId ? await templateRepository.findById(env.templateId) : undefined;
      out.push(await toEnvDto(env, project.name, template?.name ?? null, total, filled));
    }
    return out;
  },

  async get(envId: number) {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    return buildEnvDetail(env);
  },

  async create(
    input: {
      projectId: number;
      name: string;
      environment: string;
      templateId?: number;
      description?: string;
      owner?: string;
      status?: 'PLANNING' | 'BUILDING' | 'RUNNING' | 'OFFLINE';
    },
    actor: Actor,
    requestId?: string,
  ) {
    const project = await projectRepository.findById(input.projectId);
    if (!project) throw notFound(`项目 ${input.projectId} 不存在`);
    if (project.status === 'ARCHIVED') throw badRequest(`项目「${project.name}」已归档，无法新建环境`);
    if (await projectEnvRepository.findByName(input.projectId, input.name)) {
      throw conflict(`项目「${project.name}」下已存在同名环境「${input.name}」`);
    }

    let template: Awaited<ReturnType<typeof templateRepository.findById>> | undefined;
    if (input.templateId) {
      template = await templateRepository.findById(input.templateId);
      if (!template) throw notFound(`环境模板 ${input.templateId} 不存在`);
    }

    const row = await projectEnvRepository.create({
      projectId: input.projectId,
      name: input.name,
      environment: input.environment,
      status: input.status ?? 'PLANNING',
      templateId: input.templateId ?? null,
      owner: input.owner ?? null,
      description: input.description ?? null,
      createdById: actor.id,
      createdByName: actor.username,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let created = 0;
    if (template) created = (await expandTemplate(row.id, template.id)).length;

    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'CREATE',
      targetType: 'ENVIRONMENT',
      targetId: String(row.id),
      targetName: `${project.name} / ${row.name}`,
      changes: [
        {
          field: '*',
          label: template ? `套用模板 ${template.name} 创建环境（生成 ${created} 个槽位）` : '创建空白环境',
          from: null,
          to: { name: row.name, environment: row.environment, templateId: row.templateId },
        },
      ],
      requestId,
    });
    return buildEnvDetail(row);
  },

  async update(
    envId: number,
    patch: {
      name?: string;
      environment?: string;
      description?: string;
      owner?: string;
      status?: 'PLANNING' | 'BUILDING' | 'RUNNING' | 'OFFLINE';
    },
    actor: Actor,
    requestId?: string,
  ) {
    const before = await projectEnvRepository.findById(envId);
    if (!before) throw notFound(`项目环境 ${envId} 不存在`);
    if (patch.name && patch.name !== before.name) {
      const dup = await projectEnvRepository.findByName(before.projectId, patch.name);
      if (dup && dup.id !== envId) throw conflict(`已存在同名环境「${patch.name}」`);
    }
    const row = await projectEnvRepository.update(envId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.environment !== undefined ? { environment: patch.environment } : {}),
      ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
      ...(patch.owner !== undefined ? { owner: patch.owner ?? null } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    const changes = (['name', 'environment', 'description', 'owner', 'status'] as const)
      .filter((k) => patch[k] !== undefined && before[k] !== row[k])
      .map((k) => ({ field: k, label: k, from: before[k] ?? null, to: row[k] ?? null }));
    if (changes.length > 0) {
      await auditRepository.record({
        actorId: actor.id,
        actorName: actor.username,
        action: 'UPDATE',
        targetType: 'ENVIRONMENT',
        targetId: String(envId),
        targetName: row.name,
        changes,
        requestId,
      });
    }
    return buildEnvDetail(row);
  },

  async remove(envId: number, actor: Actor, requestId?: string) {
    const before = await projectEnvRepository.findById(envId);
    if (!before) throw notFound(`项目环境 ${envId} 不存在`);
    await resourceProjectRepository.clearEnvRefs(envId);
    await projectEnvRepository.remove(envId);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'DELETE',
      targetType: 'ENVIRONMENT',
      targetId: String(envId),
      targetName: before.name,
      changes: [{ field: '*', label: '删除项目环境', from: { name: before.name }, to: null }],
      requestId,
    });
    return { id: envId };
  },

  /**
   * 槽位可分配资源候选：
   * 放开环境限制（支持跨环境引用），但为每个候选标注
   * 跨环境 / 已被其他项目占用 / 容量余量 / 时间区间重叠，供前端在绑定前提示。
   * 传入 startAt / endAt 时按目标占用区间判断重叠。
   */
  async slotCandidates(
    envId: number,
    slotId: number,
    period?: { startAt?: string | null; endAt?: string | null },
  ): Promise<SlotCandidates> {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const slot = await slotRepository.findById(slotId);
    if (!slot || slot.environmentId !== envId) throw notFound(`槽位 ${slotId} 不存在`);

    const project = await projectRepository.findById(env.projectId);
    const rows = await resourceRepository.listAll({ type: slot.resourceType as never });
    // 已停用的资源不作为候选，避免把下线资源分配给新环境
    const candidates = rows.filter((r) => r.status !== 'RETIRED');

    const usageMap = await resourceRepository.capacityUsageByResources(candidates.map((r) => r.id));
    const refsMap = await resourceRefRepository.listByResources(candidates.map((r) => r.id));
    const maps = await loadProjectLabels();

    const envLabel = await environmentLabelOf(env.environment);
    const typeLabel = (await getTypeMeta(slot.resourceType)).label;
    const wantStart = parseTime(period?.startAt ?? null, false) ?? new Date();
    const wantEnd = parseTime(period?.endAt ?? null);

    const items: SlotCandidate[] = [];
    for (const r of candidates) {
      const usage = usageMap.get(r.id);
      const allocated = usage?.allocated ?? 0;
      const total = r.capacityTotal ?? null;
      const refs = (refsMap.get(r.id) ?? []).filter((x) => x.slotId !== slotId);
      const parent = r.parentId ? await resourceRepository.findById(r.parentId) : null;
      const usedBy: SlotAssignWarning['references'] = [];
      for (const ref of refs) {
        usedBy.push({
          projectId: ref.projectId,
          projectName: ref.projectId ? (maps.projects.get(ref.projectId) ?? null) : null,
          envId: ref.envId,
          envName: ref.envName,
          environment: ref.environment,
          environmentLabel: await environmentLabelOf(ref.environment),
          slotId: ref.slotId,
          slotRole: ref.slotRole,
          amount: ref.amount,
          startAt: ref.startAt ? new Date(ref.startAt).toISOString() : null,
          endAt: ref.endAt ? new Date(ref.endAt).toISOString() : null,
          overdueDays: overdueDaysOf(ref.endAt),
          occupancyState: occupancyStateOf(ref.startAt, ref.endAt) ?? 'ACTIVE',
        notStarted: notStartedOf(ref.startAt),
        });
      }
      const crossEnvironment = r.environment !== env.environment;
      const usedByOtherProject = usedBy.some((u) => u.projectId !== env.projectId);
      const overlapping = usedBy.filter((u) =>
        periodsOverlap(wantStart, wantEnd, parseTime(u.startAt), parseTime(u.endAt)),
      );

      const warnings: SlotAssignWarning[] = [];
      if (crossEnvironment) {
        warnings.push({
          code: 'CROSS_ENVIRONMENT',
          message: `该资源属于「${await environmentLabelOf(r.environment)}」环境，与当前项目环境「${envLabel}」不同，跨环境引用需确认`,
          references: [],
          capacity: null,
        });
      }
      if (usedByOtherProject) {
        warnings.push({
          code: 'USED_BY_OTHER_PROJECT',
          message: `该资源已被 ${usedBy.length} 个槽位引用（${[...new Set(usedBy.map((u) => u.projectName ?? '未归属项目'))].join('、')}），继续引用将形成跨项目共享`,
          references: usedBy,
          capacity: null,
        });
      }
      if (overlapping.length > 0) {
        warnings.push({
          code: 'PERIOD_OVERLAP',
          message: `在该占用区间内，资源已被 ${overlapping.length} 个槽位占用，属于时间上的并发共用，请确认业务允许`,
          references: overlapping,
          capacity: null,
        });
      }

      items.push({
        resource: {
          id: r.id,
          code: r.code,
          name: r.name,
          type: r.type,
          typeLabel,
          environment: r.environment,
          environmentLabel: await environmentLabelOf(r.environment),
          status: r.status,
          statusLabel: RESOURCE_STATUS_LABELS[r.status],
          projectId: r.projectId ?? null,
          projectName: r.projectId ? (maps.projects.get(r.projectId) ?? null) : null,
          datacenter: r.datacenter ?? null,
          owner: r.owner ?? null,
          parentId: r.parentId ?? null,
          parentName: parent?.name ?? null,
        },
        crossEnvironment,
        usedByOtherProject,
        demandRequired: total !== null,
        capacity:
          total === null
            ? null
            : {
                total,
                unit: r.capacityUnit ?? null,
                allocated: Math.round(allocated * 100) / 100,
                available: Math.round((total - allocated) * 100) / 100,
              },
        usedBy,
        warnings,
      });
    }

    // 同环境且未被占用的排前面，跨环境/已被占用的靠后但仍可选
    items.sort((a, b) => {
      const score = (x: SlotCandidate) => (x.crossEnvironment ? 2 : 0) + (x.usedByOtherProject ? 1 : 0);
      return score(a) - score(b);
    });

    return {
      slot: {
        id: slot.id,
        slotRole: slot.slotRole,
        resourceType: slot.resourceType,
        resourceTypeLabel: typeLabel,
        currentResourceId: slot.resourceId ?? null,
        startAt: slot.startAt ? new Date(slot.startAt).toISOString() : null,
        endAt: slot.endAt ? new Date(slot.endAt).toISOString() : null,
      },
      env: {
        id: env.id,
        name: env.name,
        projectId: env.projectId,
        projectName: project?.name ?? '—',
        environment: env.environment,
        environmentLabel: envLabel,
      },
      items,
    };
  },

  /** 手动追加槽位（不套模板时使用） */
  async addSlots(
    envId: number,
    input: { resourceType: string; slotRole: string; quantity?: number; remark?: string },
    actor: Actor,
    requestId?: string,
  ) {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const created = await createSlots(envId, [
      { resourceType: input.resourceType, slotRole: input.slotRole, quantity: input.quantity ?? 1, remark: input.remark },
    ]);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'ENVIRONMENT',
      targetId: String(envId),
      targetName: env.name,
      changes: [{ field: 'slots', label: `新增 ${created.length} 个槽位`, from: null, to: input.slotRole }],
      requestId,
    });
    return buildEnvDetail(env);
  },

  /**
   * 槽位绑定资源：
   * - 类型必须一致（硬校验）
   * - 环境不一致时允许绑定，但返回跨环境引用提示，需前端确认后再提交
   * - 已被其他项目引用时返回占用明细提示，同样需确认
   * - 资源设了容量时必须填写申请量，且不能超过剩余可用（硬校验）
   * - 占用区间与其他槽位重叠时提示并发共用，需确认（endAt 为空表示长期占用）
   */
  async assignSlot(
    envId: number,
    slotId: number,
    input: {
      resourceId: number;
      amount?: number | null;
      acknowledge?: boolean;
      startAt?: string | null;
      endAt?: string | null;
    },
    actor: Actor,
    requestId?: string,
  ): Promise<{ slot: EnvSlotDto; env: ProjectEnvDetail; warnings: SlotAssignWarning[] }> {
    const amount = input.amount ?? null;
    const acknowledge = input.acknowledge ?? false;
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const slot = await slotRepository.findById(slotId);
    if (!slot || slot.environmentId !== envId) throw notFound(`槽位 ${slotId} 不存在`);
    const resource = await resourceRepository.findById(input.resourceId);
    if (!resource) throw notFound(`资源 ${input.resourceId} 不存在`);

    if (resource.type !== slot.resourceType) {
      throw validationError('资源类型与槽位要求不一致', {
        slot: {
          id: slot.id,
          expect: slot.resourceType,
          expectLabel: (await getTypeMeta(slot.resourceType)).label,
        },
        resource: {
          id: resource.id,
          code: resource.code,
          actual: resource.type,
          actualLabel: (await getTypeMeta(resource.type)).label,
        },
      });
    }

    /**
     * 占用期限：
     * - 开始时间缺省时沿用槽位原值（首次绑定则取当前时刻），支持"换资源但保留原占用区间"
     * - 结束时间显式传 null 表示长期；未传则同样沿用原值
     * - 未来开始时间同样算占用，容量立即扣除，只在前端标注「未开始」
     */
    const startAt = parseTime(input.startAt ?? null, false) ?? slot.startAt ?? new Date();
    const endAt =
      input.endAt !== undefined ? parseTime(input.endAt) : (slot.endAt ?? null);
    if (endAt && endAt.getTime() <= startAt.getTime()) {
      throw validationError('占用结束时间必须晚于开始时间', { field: 'endAt' });
    }
    /** 槽位此前已绑定其它资源：本次为「更换资源」 */
    const previousResourceId = slot.resourceId;
    const previousResource =
      previousResourceId !== null && previousResourceId !== resource.id
        ? await resourceRepository.findById(previousResourceId)
        : null;

    // —— 跨环境引用：允许，但必须明确提示（不同环境的资源混用是变更风险点）
    const crossEnvironment = resource.environment !== env.environment;
    const resourceEnvLabel = await environmentLabelOf(resource.environment);
    const envLabel = await environmentLabelOf(env.environment);

    // —— 已被其他项目的环境槽位引用：允许共享，但要展示占用明细
    const usedBy = await otherProjectUsageOf(resource.id, env.projectId);
    const usedByOtherProject = usedBy.length > 0;

    // —— 时间区间重叠：同一资源在同一时段被多个槽位占用属于并发共用
    const allRefs = (await resourceRefRepository.listByResource(resource.id)).filter((r) => r.slotId !== slotId);
    const overlapping = allRefs.filter((r) =>
      periodsOverlap(startAt, endAt, r.startAt, r.endAt),
    );
    const overlapRefs: SlotAssignWarning['references'] = [];
    const refLabels = await loadProjectLabels();
    for (const r of overlapping) {
      overlapRefs.push({
        projectId: r.projectId,
        projectName: r.projectId ? (refLabels.projects.get(r.projectId) ?? null) : null,
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

    // —— 容量：资源设了容量就必须填申请量，且不能超过「本次占用期间」的剩余可用
    // 占用按时间段核算：与本槽位区间不重叠的历史占用可以复用同一份容量
    const capacityCheck = await capacityCheckFor(resource, slotId, amount, { startAt, endAt });

    const warnings: SlotAssignWarning[] = [];
    if (crossEnvironment) {
      warnings.push({
        code: 'CROSS_ENVIRONMENT',
        message: `资源 ${resource.code} 属于「${resourceEnvLabel}」环境，与当前项目环境「${envLabel}」不同，属于跨环境引用，请确认业务上允许共用`,
        references: [],
        capacity: null,
      });
    }
    if (usedByOtherProject) {
      warnings.push({
        code: 'USED_BY_OTHER_PROJECT',
        message: `资源 ${resource.code} 已被 ${usedBy.length} 个槽位引用（${[...new Set(usedBy.map((u) => u.projectName ?? '未归属项目'))].join('、')}），继续引用将形成跨项目共享`,
        references: usedBy,
        capacity: null,
      });
    }
    if (overlapRefs.length > 0) {
      warnings.push({
        code: 'PERIOD_OVERLAP',
        message: `在 ${startAt.toLocaleDateString('zh-CN')} ~ ${endAt ? endAt.toLocaleDateString('zh-CN') : '长期'} 区间内，资源 ${resource.code} 已被 ${overlapRefs.length} 个槽位占用，属于时间上的并发共用，请确认业务允许`,
        references: overlapRefs,
        capacity: null,
      });
    }
    if (capacityCheck) warnings.push(capacityCheck);

    // 存在提示且调用方未确认 → 409 带明细，由前端弹「已被引用」清单后一键确认
    if (warnings.length > 0 && !acknowledge) {
      throw conflict(warnings.map((w) => w.message).join('；'), {
        warnings,
        resource: { id: resource.id, code: resource.code, name: resource.name },
        slot: { id: slot.id, slotRole: slot.slotRole },
      });
    }

    // 容量硬校验：即使已确认提示，超容量也不允许写入（按占用区间取峰值核算）
    await assertCapacityAvailable(resource, slotId, amount, { startAt, endAt });

    const updated = await slotRepository.update(slotId, {
      resourceId: resource.id,
      demandAmount: resource.capacityTotal === null ? null : (amount ?? null),
      startAt,
      endAt,
      updatedAt: new Date(),
    });
    // 资源尚未标注主归属项目时，随槽位绑定自动补标（已有归属则保持，视为共享引用）
    if (resource.projectId === null) {
      await resourceProjectRepository.setProject([resource.id], env.projectId, resource.projectEnvId);
    }
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'ENVIRONMENT',
      targetId: String(envId),
      targetName: `${env.name} · ${slot.slotRole}`,
      changes: [
        {
          field: `slot.${slotId}`,
          label: `槽位「${slot.slotRole}」${previousResource ? `资源由 ${previousResource.code} ${previousResource.name} 更换为 ` : '绑定资源'}${amount ? `（申请 ${amount}${resource.capacityUnit ? ` ${resource.capacityUnit}` : ''}）` : ''}${crossEnvironment ? '（跨环境引用）' : ''}，占用 ${startAt.toLocaleDateString('zh-CN')} 起${endAt ? `至 ${endAt.toLocaleDateString('zh-CN')}` : '（长期）'}`,
          from: previousResource ? `${previousResource.code} ${previousResource.name}` : null,
          to: `${resource.code} ${resource.name}`,
        },
      ],
      requestId,
    });
    return { slot: toSlotDto(updated, resource), env: await buildEnvDetail(env), warnings };
  },

  /** 续期：延长结束时间（已超期的从当前时间起算），或转为长期占用 */
  async renewSlot(
    envId: number,
    slotId: number,
    input: { endAt?: string | null; days?: number; remark?: string },
    actor: Actor,
    requestId?: string,
  ) {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const slot = await slotRepository.findById(slotId);
    if (!slot || slot.environmentId !== envId) throw notFound(`槽位 ${slotId} 不存在`);
    if (slot.resourceId === null) throw badRequest('该槽位尚未绑定资源，无需续期');

    const now = new Date();
    let nextEnd: Date | null;
    if (input.endAt === null) {
      nextEnd = null; // 转为长期占用
    } else if (input.endAt !== undefined) {
      nextEnd = parseTime(input.endAt);
      if (!nextEnd) throw validationError('结束时间格式不正确', { field: 'endAt' });
    } else {
      // 顺延：已超期或未设期限时从当前时间起算
      const base =
        slot.endAt && slot.endAt.getTime() > now.getTime() ? slot.endAt.getTime() : now.getTime();
      nextEnd = new Date(base + (input.days ?? 30) * DAY_MS);
    }

    if (nextEnd && slot.startAt && nextEnd.getTime() <= slot.startAt.getTime()) {
      throw validationError('新的结束时间必须晚于占用开始时间', { field: 'endAt' });
    }

    // 续期后若仍在同一时间区间内与他人重叠，提示但不阻断（续期是既有占用的延续）
    const updated = await slotRepository.update(slotId, {
      endAt: nextEnd,
      // 已超期续期时把开始时间保持在原值，保证时间轴连续
      renewCount: (slot.renewCount ?? 0) + 1,
      updatedAt: now,
    });

    const resource = slot.resourceId ? await resourceRepository.findById(slot.resourceId) : null;
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'SLOT_PERIOD',
      targetId: String(slotId),
      targetName: `${env.name} · ${slot.slotRole}`,
      changes: [
        {
          field: 'endAt',
          label: `槽位「${slot.slotRole}」续期${input.remark ? `（${input.remark}）` : ''}`,
          from: slot.endAt ? new Date(slot.endAt).toLocaleDateString('zh-CN') : '长期',
          to: nextEnd ? nextEnd.toLocaleDateString('zh-CN') : '长期',
        },
      ],
      requestId,
    });
    return {
      slot: toSlotDto(updated, resource),
      env: await buildEnvDetail(env),
      message: `已续期至 ${nextEnd ? nextEnd.toLocaleDateString('zh-CN') : '长期'}`,
    };
  },

  /** 释放：立即释放该槽位对资源的占用（含容量），槽位本身保留可再次分配 */
  async releaseSlot(envId: number, slotId: number, actor: Actor, requestId?: string) {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const slot = await slotRepository.findById(slotId);
    if (!slot || slot.environmentId !== envId) throw notFound(`槽位 ${slotId} 不存在`);
    const resource = slot.resourceId ? await resourceRepository.findById(slot.resourceId) : null;
    const overdue = overdueDaysOf(slot.endAt);

    const updated = await slotRepository.update(slotId, {
      resourceId: null,
      demandAmount: null,
      startAt: null,
      endAt: null,
      updatedAt: new Date(),
    });

    if (resource && resource.projectId === env.projectId) {
      const envIds = (await projectEnvRepository.listByProject(env.projectId)).map((e) => e.id);
      const refs = await slotRepository.resourceIdsByEnvs(envIds);
      if (!refs.includes(resource.id)) {
        await resourceProjectRepository.setProject([resource.id], null, null);
      }
    }

    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'SLOT_PERIOD',
      targetId: String(slotId),
      targetName: `${env.name} · ${slot.slotRole}`,
      changes: [
        {
          field: 'endAt',
          label: `槽位「${slot.slotRole}」释放资源${overdue > 0 ? `（超期 ${overdue} 天）` : ''}`,
          from: resource ? `${resource.code} ${resource.name}` : null,
          to: null,
        },
      ],
      requestId,
    });
    return { slot: toSlotDto(updated), env: await buildEnvDetail(env) };
  },

  /** 调整占用期限（不改变绑定关系） */
  async updateSlotPeriod(
    envId: number,
    slotId: number,
    input: { startAt?: string | null; endAt?: string | null },
    actor: Actor,
    requestId?: string,
  ) {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const slot = await slotRepository.findById(slotId);
    if (!slot || slot.environmentId !== envId) throw notFound(`槽位 ${slotId} 不存在`);
    if (slot.resourceId === null) throw badRequest('该槽位尚未绑定资源，请先分配资源再设置占用期限');

    const nextStart = input.startAt !== undefined ? parseTime(input.startAt, false) : slot.startAt;
    const nextEnd = input.endAt !== undefined ? parseTime(input.endAt) : slot.endAt;
    if (nextStart && nextEnd && nextEnd.getTime() <= nextStart.getTime()) {
      throw validationError('结束时间必须晚于开始时间', { field: 'endAt' });
    }

    const updated = await slotRepository.update(slotId, {
      startAt: nextStart,
      endAt: nextEnd,
      updatedAt: new Date(),
    });
    const resource = await resourceRepository.findById(slot.resourceId);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'SLOT_PERIOD',
      targetId: String(slotId),
      targetName: `${env.name} · ${slot.slotRole}`,
      changes: [
        {
          field: 'period',
          label: `槽位「${slot.slotRole}」调整占用期限`,
          from: `${slot.startAt ? new Date(slot.startAt).toLocaleDateString('zh-CN') : '—'} ~ ${slot.endAt ? new Date(slot.endAt).toLocaleDateString('zh-CN') : '长期'}`,
          to: `${nextStart ? nextStart.toLocaleDateString('zh-CN') : '—'} ~ ${nextEnd ? nextEnd.toLocaleDateString('zh-CN') : '长期'}`,
        },
      ],
      requestId,
    });
    return { slot: toSlotDto(updated, resource), env: await buildEnvDetail(env) };
  },

  /**
   * 环境占用时间轴：按槽位展示占用区间，并标注同一资源的并发共用。
   * 超期未释放的槽位仍然保留在时间轴上（页面据此提示并可一键续期/释放）。
   */
  async timeline(envId: number): Promise<EnvTimeline> {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const [slots, project] = await Promise.all([
      slotRepository.listByEnv(envId),
      projectRepository.findById(env.projectId),
    ]);
    const now = new Date();
    const bound = slots.filter((s) => s.resourceId !== null);

    const resourceIds = [...new Set(bound.map((s) => s.resourceId!))];
    const refsMap = await resourceRefRepository.listByResources(resourceIds);

    const entries: EnvTimeline['entries'] = [];
    for (const slot of bound) {
      const resource = await resourceRepository.findById(slot.resourceId!);
      const startAt = slot.startAt ?? slot.createdAt ?? now;
      const others = (refsMap.get(slot.resourceId!) ?? []).filter((r) => r.slotId !== slot.id);
      const shared = others.some((r) =>
        periodsOverlap(startAt, slot.endAt, r.startAt, r.endAt),
      );
      entries.push({
        slotId: slot.id,
        slotRole: slot.slotRole,
        resourceId: slot.resourceId,
        resourceCode: resource?.code ?? null,
        resourceName: resource?.name ?? null,
        amount: slot.demandAmount ?? null,
        startAt: new Date(startAt).toISOString(),
        endAt: slot.endAt ? new Date(slot.endAt).toISOString() : null,
        overdueDays: overdueDaysOf(slot.endAt, now),
        occupancyState: occupancyStateOf(startAt, slot.endAt, now) ?? 'ACTIVE',
        notStarted: notStartedOf(startAt, now),
        shared,
      });
    }
    entries.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

    const starts = entries.map((e) => new Date(e.startAt).getTime());
    const ends = entries.filter((e) => e.endAt).map((e) => new Date(e.endAt!).getTime());
    const hasLongTerm = entries.some((e) => e.endAt === null);
    const min = Math.min(now.getTime() - 45 * DAY_MS, ...starts);
    const max = Math.max(now.getTime() + 45 * DAY_MS, ...ends, hasLongTerm ? now.getTime() + 180 * DAY_MS : now.getTime());

    return {
      env: {
        id: env.id,
        name: env.name,
        projectId: env.projectId,
        projectName: project?.name ?? '—',
        environment: env.environment,
        environmentLabel: await envLabelOf(env.environment),
      },
      range: { from: new Date(min).toISOString(), to: new Date(max).toISOString(), today: now.toISOString() },
      entries,
      expiredCount: entries.filter((e) => e.occupancyState === 'EXPIRED').length,
    };
  },

  async unassignSlot(envId: number, slotId: number, actor: Actor, requestId?: string) {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const slot = await slotRepository.findById(slotId);
    if (!slot || slot.environmentId !== envId) throw notFound(`槽位 ${slotId} 不存在`);
    const resource = slot.resourceId ? await resourceRepository.findById(slot.resourceId) : null;
    // 解绑即释放该槽位占用的容量与占用期限
    const updated = await slotRepository.update(slotId, {
      resourceId: null,
      demandAmount: null,
      startAt: null,
      endAt: null,
      updatedAt: new Date(),
    });

    // 解绑后若该项目下再无其他槽位引用该资源，撤销自动补标的项目归属
    if (resource && resource.projectId === env.projectId) {
      const envIds = (await projectEnvRepository.listByProject(env.projectId)).map((e) => e.id);
      const refs = await slotRepository.resourceIdsByEnvs(envIds);
      if (!refs.includes(resource.id)) {
        await resourceProjectRepository.setProject([resource.id], null, null);
      }
    }
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'ENVIRONMENT',
      targetId: String(envId),
      targetName: `${env.name} · ${slot.slotRole}`,
      changes: [
        { field: `slot.${slotId}`, label: `槽位「${slot.slotRole}」解绑资源`, from: resource ? `${resource.code} ${resource.name}` : null, to: null },
      ],
      requestId,
    });
    return { slot: toSlotDto(updated), env: await buildEnvDetail(env) };
  },

  async removeSlot(envId: number, slotId: number, actor: Actor, requestId?: string) {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const slot = await slotRepository.findById(slotId);
    if (!slot || slot.environmentId !== envId) throw notFound(`槽位 ${slotId} 不存在`);
    await slotRepository.remove(slotId);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'ENVIRONMENT',
      targetId: String(envId),
      targetName: env.name,
      changes: [{ field: `slot.${slotId}`, label: `删除槽位「${slot.slotRole}」`, from: slot.slotRole, to: null }],
      requestId,
    });
    return buildEnvDetail(env);
  },

  /** 对已有环境追加套用模板（保留现有槽位） */
  async applyTemplate(envId: number, templateId: number, actor: Actor, requestId?: string) {
    const env = await projectEnvRepository.findById(envId);
    if (!env) throw notFound(`项目环境 ${envId} 不存在`);
    const template = await templateRepository.findById(templateId);
    if (!template) throw notFound(`环境模板 ${templateId} 不存在`);
    const created = await expandTemplate(envId, templateId);
    await projectEnvRepository.update(envId, { templateId });
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'ENVIRONMENT',
      targetId: String(envId),
      targetName: env.name,
      changes: [{ field: 'templateId', label: `追加套用模板 ${template.name}`, from: null, to: `${created.length} 个槽位` }],
      requestId,
    });
    return buildEnvDetail((await projectEnvRepository.findById(envId))!);
  },
};

/* ------------------------------------------------------------------ *
 * 环境模板
 * ------------------------------------------------------------------ */

export const templateService = {
  async list(query: EnvTemplateQuery) {
    const { items, meta } = await templateRepository.list(query);
    const out: EnvTemplateDto[] = [];
    for (const row of items) {
      const items_ = await templateRepository.listItems(row.id);
      out.push(toTemplateDto(row, items_, await templateRepository.usageCount(row.id)));
    }
    return { items: out, meta };
  },

  async listOptions() {
    const rows = await templateRepository.listAll();
    const out: EnvTemplateDto[] = [];
    for (const row of rows) {
      const items_ = await templateRepository.listItems(row.id);
      out.push(toTemplateDto(row, items_, await templateRepository.usageCount(row.id)));
    }
    return out;
  },

  async get(id: number): Promise<EnvTemplateDetail> {
    const row = await templateRepository.findById(id);
    if (!row) throw notFound(`环境模板 ${id} 不存在`);
    const items = await templateRepository.listItems(id);
    return {
      ...toTemplateDto(row, items, await templateRepository.usageCount(id)),
      items: items.map((i) => ({
        id: i.id,
        templateId: i.templateId,
        resourceType: i.resourceType,
        slotRole: i.slotRole,
        quantity: i.quantity,
        required: i.required,
        remark: i.remark ?? undefined,
        sortOrder: i.sortOrder,
      })),
    };
  },

  async create(
    input: {
      code?: string;
      name: string;
      description?: string;
      items: { resourceType: string; slotRole: string; quantity?: number; required?: boolean; remark?: string }[];
    },
    actor: Actor,
    requestId?: string,
  ): Promise<EnvTemplateDetail> {
    const code = input.code?.trim() || (await templateRepository.nextCode());
    if (await templateRepository.findByCode(code)) throw conflict(`模板编码 ${code} 已存在`);

    const row = await templateRepository.create({
      code,
      name: input.name,
      description: input.description ?? null,
      builtin: false,
      createdById: actor.id,
      createdByName: actor.username,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await templateRepository.replaceItems(
      row.id,
      input.items.map((item, idx) => ({
        templateId: row.id,
        resourceType: item.resourceType,
        slotRole: item.slotRole,
        quantity: item.quantity ?? 1,
        required: item.required ?? true,
        remark: item.remark ?? null,
        sortOrder: idx,
      })),
    );
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'CREATE',
      targetType: 'TEMPLATE',
      targetId: String(row.id),
      targetName: `${row.code} ${row.name}`,
      changes: [
        {
          field: '*',
          label: '创建环境模板',
          from: null,
          to: await templateItemsSummary(input.items),
        },
      ],
      requestId,
    });
    return this.get(row.id);
  },

  async update(
    id: number,
    patch: {
      name?: string;
      description?: string;
      items?: { resourceType: string; slotRole: string; quantity?: number; required?: boolean; remark?: string }[];
    },
    actor: Actor,
    requestId?: string,
  ): Promise<EnvTemplateDetail> {
    const before = await templateRepository.findById(id);
    if (!before) throw notFound(`环境模板 ${id} 不存在`);
    if (before.builtin && patch.items) {
      throw badRequest('内置模板不支持修改资源组合，请先「另存为」新模板');
    }

    await templateRepository.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
    });
    if (patch.items) {
      await templateRepository.replaceItems(
        id,
        patch.items.map((item, idx) => ({
          templateId: id,
          resourceType: item.resourceType,
          slotRole: item.slotRole,
          quantity: item.quantity ?? 1,
          required: item.required ?? true,
          remark: item.remark ?? null,
          sortOrder: idx,
        })),
      );
    }
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'TEMPLATE',
      targetId: String(id),
      targetName: `${before.code} ${before.name}`,
      changes: [
        {
          field: 'items',
          label: patch.items ? '更新模板资源组合' : '更新模板信息',
          from: null,
          to: patch.items ? await templateItemsSummary(patch.items) : patch.name,
        },
      ],
      requestId,
    });
    return this.get(id);
  },

  async clone(id: number, actor: Actor, requestId?: string): Promise<EnvTemplateDetail> {
    const source = await templateRepository.findById(id);
    if (!source) throw notFound(`环境模板 ${id} 不存在`);
    const items = await templateRepository.listItems(id);
    return this.create(
      {
        name: `${source.name} 副本`,
        description: source.description ?? undefined,
        items: items.map((i) => ({
          resourceType: i.resourceType,
          slotRole: i.slotRole,
          quantity: i.quantity,
          required: i.required,
          remark: i.remark ?? undefined,
        })),
      },
      actor,
      requestId,
    );
  },

  async remove(id: number, actor: Actor, requestId?: string) {
    const before = await templateRepository.findById(id);
    if (!before) throw notFound(`环境模板 ${id} 不存在`);
    const usage = await templateRepository.usageCount(id);
    if (usage > 0) {
      throw conflict(`模板「${before.name}」已被 ${usage} 个项目环境引用，请先解除引用再删除`);
    }
    await templateRepository.remove(id);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'DELETE',
      targetType: 'TEMPLATE',
      targetId: String(id),
      targetName: `${before.code} ${before.name}`,
      changes: [{ field: '*', label: '删除环境模板', from: before.name, to: null }],
      requestId,
    });
    return { id };
  },

  /** 一步到位：基于模板在项目下创建环境 */
  async instantiate(
    templateId: number,
    input: { projectId: number; name: string; environment: string; owner?: string; description?: string },
    actor: Actor,
    requestId?: string,
  ) {
    return projectEnvService.create({ ...input, templateId }, actor, requestId);
  },
};

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

/** 按模板条目展开槽位；quantity > 1 时槽位名追加序号 */
async function createSlots(
  envId: number,
  specs: { resourceType: string; slotRole: string; quantity?: number; remark?: string }[],
) {
  const created = [];
  let sort = (await slotRepository.listByEnv(envId)).length;
  for (const spec of specs) {
    const quantity = spec.quantity ?? 1;
    for (let i = 1; i <= quantity; i += 1) {
      created.push(
        await slotRepository.create({
          environmentId: envId,
          resourceType: spec.resourceType,
          slotRole: quantity > 1 ? `${spec.slotRole}-${i}` : spec.slotRole,
          resourceId: null,
          sortOrder: sort,
          remark: spec.remark ?? null,
          createdAt: new Date(),
        }),
      );
      sort += 1;
    }
  }
  return created;
}

async function expandTemplate(envId: number, templateId: number) {
  const items = await templateRepository.listItems(templateId);
  return createSlots(
    envId,
    items.map((i) => ({
      resourceType: i.resourceType,
      slotRole: i.slotRole,
      quantity: i.quantity,
      remark: i.remark ?? undefined,
    })),
  );
}

async function buildEnvDetail(env: ProjectEnvRow) {
  const project = await projectRepository.findById(env.projectId);
  const template = env.templateId ? await templateRepository.findById(env.templateId) : undefined;
  const { total, filled } = await projectEnvRepository.slotStat(env.id);
  const slots = await slotRepository.listByEnv(env.id);
  const resourceIds = [...new Set(slots.map((s) => s.resourceId).filter((id): id is number => id !== null))];
  const resourceMap = new Map<number, ResourceRow>();
  for (const id of resourceIds) {
    const r = await resourceRepository.findById(id);
    if (r) resourceMap.set(id, r);
  }
  const slotDtos = slots.map((s) => toSlotDto(s, s.resourceId ? resourceMap.get(s.resourceId) ?? null : null));
  return {
    ...(await toEnvDto(env, project?.name ?? '—', template?.name ?? null, total, filled)),
    slots: slotDtos,
    overdueCount: slotDtos.filter((s) => s.overdueDays > 0).length,
  };
}

/** 项目下所有环境槽位绑定的资源，前端据此区分「主归属」与「槽位引用」 */
async function slotRefsOfProject(projectId: number) {
  const envs = await projectEnvRepository.listByProject(projectId);
  const flat: {
    envId: number;
    envName: string;
    environment: string;
    slotId: number;
    slotRole: string;
    resourceId: number;
    amount: number | null;
    startAt: Date | null;
    endAt: Date | null;
    renewCount: number;
  }[] = [];
  for (const env of envs) {
    const slots = await slotRepository.listByEnv(env.id);
    for (const s of slots) {
      if (s.resourceId === null) continue;
      flat.push({
        envId: env.id,
        envName: env.name,
        environment: env.environment,
        slotId: s.id,
        slotRole: s.slotRole,
        resourceId: s.resourceId,
        amount: s.demandAmount ?? null,
        startAt: s.startAt ?? null,
        endAt: s.endAt ?? null,
        renewCount: s.renewCount ?? 0,
      });
    }
  }

  // 冗余资源展示信息，前端可直接列出「本项目的超期资源」而无需二次请求
  const resourceIds = [...new Set(flat.map((f) => f.resourceId))];
  const resourceRows = resourceIds.length ? await resourceRepository.findByIds(resourceIds) : [];
  const resourceMap = new Map(resourceRows.map((r) => [r.id, r]));
  const [envDict, typeLabels] = await Promise.all([
    environmentService.list(true),
    Promise.all(
      [...new Set(resourceRows.map((r) => r.type))].map(async (type) => [type, (await getTypeMeta(type)).label] as const),
    ),
  ]);
  const envLabelMap = new Map(envDict.map((e) => [e.code, e.label]));
  const typeLabelMap = new Map<string, string>(typeLabels);

  return flat.map((f) => {
    const resource = resourceMap.get(f.resourceId);
    return {
      resourceId: f.resourceId,
      resourceCode: resource?.code ?? null,
      resourceName: resource?.name ?? null,
      resourceType: resource?.type ?? null,
      resourceTypeLabel: resource ? (typeLabelMap.get(resource.type) ?? resource.type) : null,
      envId: f.envId,
      envName: f.envName,
      environment: f.environment,
      environmentLabel: envLabelMap.get(f.environment) ?? f.environment,
      slotId: f.slotId,
      slotRole: f.slotRole,
      amount: f.amount,
      startAt: f.startAt ? new Date(f.startAt).toISOString() : null,
      endAt: f.endAt ? new Date(f.endAt).toISOString() : null,
      overdueDays: overdueDaysOf(f.endAt),
      occupancyState: occupancyStateOf(f.startAt, f.endAt) ?? 'ACTIVE',
      notStarted: notStartedOf(f.startAt),
      renewCount: f.renewCount,
    };
  });
}
