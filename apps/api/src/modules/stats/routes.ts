import {
  RESOURCE_STATUSES,
  RESOURCE_STATUS_LABELS,
  statsOverviewSchema,
  type StatsOverview,
} from '@dw/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { overdueDaysOf } from '../../lib/occupancy.js';
import { extractIps, ipFieldsOf } from '../resources/mapper.js';
import { resourceRepository } from '../resources/repository.js';
import { getTypeMeta } from '../dict/validator.js';
import { labelsOf, loadProjectLabels, toResourceDto } from '../resources/mapper.js';
import { environmentService, resourceTypeService } from '../dict/service.js';
import {
  projectEnvRepository,
  projectRepository,
  slotRepository,
  templateRepository,
} from '../projects/repository.js';

/** 项目维度统计：主归属 ∪ 环境槽位引用，另统计未标注项目的资源 */
async function buildProjectStats(all: Awaited<ReturnType<typeof resourceRepository.listAll>>) {
  const [projectList, envList, slotList, templateList] = await Promise.all([
    projectRepository.listAll(),
    projectEnvRepository.listAll(),
    slotRepository.listAll(),
    templateRepository.listAll(),
  ]);

  const slotByEnv = new Map<number, number[]>();
  for (const slot of slotList) {
    if (slot.resourceId === null) continue;
    const list = slotByEnv.get(slot.environmentId) ?? [];
    list.push(slot.resourceId);
    slotByEnv.set(slot.environmentId, list);
  }

  const byProject = projectList
    .map((p) => {
      const envIds = envList.filter((e) => e.projectId === p.id).map((e) => e.id);
      const ids = new Set<number>();
      for (const r of all) if (r.projectId === p.id) ids.add(r.id);
      for (const envId of envIds) for (const rid of slotByEnv.get(envId) ?? []) ids.add(rid);
      return { projectId: p.id as number | null, name: p.name, count: ids.size };
    })
    .sort((a, b) => b.count - a.count);

  const unassigned = all.filter((r) => r.projectId === null).length;
  if (unassigned > 0) byProject.push({ projectId: null, name: '未标注项目', count: unassigned });

  return {
    byProject,
    projectSummary: {
      projectCount: projectList.length,
      envCount: envList.length,
      templateCount: templateList.length,
      unassignedCount: unassigned,
    },
  };
}

/**
 * 超期占用明细：结束时间已过但仍未释放的槽位。
 * 按「项目 → 环境 → 槽位 → 资源」展开，供概览页统一展示「哪些项目的哪些资源超期」。
 */
async function buildOverdue(envLabels: Map<string, string>) {
  const [slots, envs, projects] = await Promise.all([
    slotRepository.listAll(),
    projectEnvRepository.listAll(),
    projectRepository.listAll(),
  ]);

  const envMap = new Map(envs.map((e) => [e.id, e]));
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const resourceIds = [
    ...new Set(slots.map((s) => s.resourceId).filter((id): id is number => id !== null)),
  ];
  const resourceMap = new Map(
    resourceIds.length
      ? (await resourceRepository.findByIds(resourceIds)).map((r) => [r.id, r])
      : [],
  );

  const now = new Date();
  const items = await Promise.all(
    slots
      .filter((s) => s.resourceId !== null && s.endAt !== null && s.endAt.getTime() < now.getTime())
      .map(async (s) => {
        const env = envMap.get(s.environmentId);
        const project = env ? projectMap.get(env.projectId) : undefined;
        const resource = resourceMap.get(s.resourceId!);
        return {
          projectId: project?.id ?? null,
          projectName: project?.name ?? null,
          envId: s.environmentId,
          envName: env?.name ?? `环境 #${s.environmentId}`,
          environment: env?.environment ?? 'DEV',
          environmentLabel: env ? (envLabels.get(env.environment) ?? env.environment) : '—',
          slotId: s.id,
          slotRole: s.slotRole,
          resourceId: s.resourceId!,
          resourceCode: resource?.code ?? `资源 #${s.resourceId}`,
          resourceName: resource?.name ?? '—',
          resourceType: resource?.type ?? s.resourceType,
          resourceTypeLabel: (await getTypeMeta(resource?.type ?? s.resourceType)).label,
          amount: s.demandAmount ?? null,
          startAt: s.startAt ? new Date(s.startAt).toISOString() : null,
          endAt: new Date(s.endAt!).toISOString(),
          overdueDays: overdueDaysOf(s.endAt),
          renewCount: s.renewCount ?? 0,
        };
      }),
  );
  items.sort((a, b) => b.overdueDays - a.overdueDays);

  // 按项目分组：超期最久的排前面，便于概览页直接看出重点
  const groupMap = new Map<string, (typeof items)[number][]>();
  for (const item of items) {
    const key = String(item.projectId ?? 'none');
    const list = groupMap.get(key) ?? [];
    list.push(item);
    groupMap.set(key, list);
  }
  const overdueByProject = [...groupMap.values()]
    .map((list) => ({
      projectId: list[0]!.projectId,
      projectName: list[0]!.projectName,
      count: list.length,
      maxOverdueDays: Math.max(...list.map((i) => i.overdueDays)),
      items: list,
    }))
    .sort((a, b) => b.maxOverdueDays - a.maxOverdueDays || b.count - a.count);

  return { overdueSlots: items, overdueByProject };
}

async function buildOverview(): Promise<StatsOverview> {
  const all = await resourceRepository.listAll();

  // 类型 / 环境分布按字典输出，新增的自定义类型与环境自动进入统计
  const [typeDict, envDict] = await Promise.all([
    resourceTypeService.list(true),
    environmentService.list(true),
  ]);
  const byType = typeDict
    .map((t) => ({
      type: t.code,
      label: t.label,
      count: all.filter((r) => r.type === t.code).length,
    }))
    .filter((t) => t.count > 0 || typeDict.length <= 12);
  const byEnvironment = envDict
    .map((e) => ({
      environment: e.code,
      label: e.label,
      count: all.filter((r) => r.environment === e.code).length,
    }))
    .filter((e) => e.count > 0 || envDict.length <= 12);

  const byStatus = RESOURCE_STATUSES.map((status) => ({
    status,
    label: RESOURCE_STATUS_LABELS[status],
    count: all.filter((r) => r.status === status).length,
  }));

  const dcMap = new Map<string, number>();
  for (const r of all) {
    const key = r.datacenter ?? '未分配';
    dcMap.set(key, (dcMap.get(key) ?? 0) + 1);
  }
  const byDatacenter = [...dcMap.entries()]
    .map(([datacenter, count]) => ({ datacenter, count }))
    .sort((a, b) => b.count - a.count);

  const nas = all.filter((r) => r.type === 'NAS');
  // 子资源只是父资源容量池里划出的一段配额（且会继承父资源的 capacityGb），
  // 统计物理容量池时只按顶层资源汇总，避免父子重复计入导致总量翻倍。
  // 容量以资源自身的容量字段为准（GB）；早期 NAS 把容量放在 attrs.capacityGb/usedGb，
  // 字典类资源类型已无这两个字段，这里仅保留读出兜底。
  const nasRoots = nas.filter((r) => r.parentId === null);
  let capacityGb = 0;
  let usedGb = 0;
  for (const r of nasRoots) {
    const attrs = (r.attrs ?? {}) as Record<string, unknown>;
    const gb = r.capacityUnit === 'GB' || !r.capacityUnit ? (r.capacityTotal ?? 0) : 0;
    capacityGb += gb > 0 ? gb : Number(attrs['capacityGb'] ?? 0);
    usedGb += Number(attrs['usedGb'] ?? 0);
  }

  const ipMap = new Map<string, number>();
  for (const r of all) {
    // 子资源的 IP 等必填属性继承自父资源，不构成独立占用，统计时跳过
    if (r.parentId !== null) continue;
    if (!['IN_USE', 'RESERVED'].includes(r.status)) continue;
    const ips = extractIps((r.attrs ?? {}) as Record<string, unknown>, await ipFieldsOf(r.type));
    for (const { value } of ips) ipMap.set(value, (ipMap.get(value) ?? 0) + 1);
  }
  const duplicates = [...ipMap.entries()].filter(([, n]) => n > 1);

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const createdLast7Days = all.filter((r) => new Date(r.createdAt) >= since).length;

  const recent = await resourceRepository.list({
    page: 1,
    pageSize: 5,
    sortBy: 'updatedAt',
    sortOrder: 'desc',
  });

  const maps = await loadProjectLabels();
  const projectStats = await buildProjectStats(all);

  // 超期明细：结束时间已过但未释放的占用，按项目分组后统一展示
  const overdue = await buildOverdue(new Map(envDict.map((e) => [e.code, e.label])));

  // 标签分布：点击标签可直接跳到台账并按标签筛选
  const byTag = await resourceRepository.tagCounts();

  // 父子层级：子资源单独计数，避免「资源总数」被层级放大后误读
  const childRows = all.filter((r) => r.parentId !== null);
  const parentIds = new Set(all.map((r) => r.parentId).filter((id): id is number => id !== null));

  // 占用期限：按服务端当前时间推导超期与即将到期
  const slots = await slotRepository.listAll();
  const bound = slots.filter((s) => s.resourceId !== null);
  const now = new Date();
  const slotPeriod = {
    occupiedCount: bound.length,
    expiringSoonCount: bound.filter(
      (s) =>
        s.endAt !== null &&
        s.endAt.getTime() >= now.getTime() &&
        s.endAt.getTime() - now.getTime() <= 7 * 86400000,
    ).length,
    expiredCount: bound.filter((s) => s.endAt !== null && s.endAt.getTime() < now.getTime()).length,
    longTermCount: bound.filter((s) => s.endAt === null).length,
  };

  return {
    total: all.length,
    byType,
    byEnvironment,
    byStatus,
    byDatacenter,
    nasCapacity: {
      count: nas.length,
      capacityGb,
      usedGb,
      usageRate: capacityGb > 0 ? Number(((usedGb / capacityGb) * 100).toFixed(2)) : 0,
    },
    ipConflict: { count: duplicates.length, samples: duplicates.slice(0, 8).map(([ip]) => ip) },
    createdLast7Days,
    recentUpdated: recent.items.map((r) => toResourceDto(r, labelsOf(r, maps))),
    byTag: byTag.slice(0, 12),
    hierarchy: {
      rootCount: all.length - childRows.length,
      childCount: childRows.length,
      parentCount: parentIds.size,
    },
    slotPeriod,
    ...overdue,
    ...projectStats,
  };
}

export const statsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/stats/overview',
    {
      preHandler: app.authenticate,
      schema: { response: { 200: statsOverviewSchema } },
    },
    async () => buildOverview(),
  );
};
