import { and, asc, count, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { config } from '../../config/env.js';
import { db, firstRow } from '../../db/index.js';
import { getTypeMeta } from '../dict/validator.js';
import { envSlots, projectEnvironments, resources, type ResourceRow } from '../../db/schema.js';
import type { resourceQuerySchema } from '@dw/shared';
import type { z } from 'zod';

export type ResourceQuery = z.infer<typeof resourceQuerySchema>;

const SORT_COLUMNS = {
  updatedAt: resources.updatedAt,
  createdAt: resources.createdAt,
  name: resources.name,
  code: resources.code,
  type: resources.type,
  environment: resources.environment,
  status: resources.status,
  datacenter: resources.datacenter,
  owner: resources.owner,
} as const;

export interface Paged<T> {
  items: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

/**
 * 项目维度的作用域：资源的「主归属项目」与「环境槽位引用」是或关系，
 * 因此按项目检索时要把槽位里绑定的资源 id 一并纳入。
 */
export interface ResourceScope {
  slotResourceIds?: number[];
}

function buildWhere(q: ResourceQuery, scope?: ResourceScope) {
  const clauses = [];
  if (q.q) {
    const term = `%${q.q}%`;
    clauses.push(
      or(
        like(resources.name, term),
        like(resources.code, term),
        like(resources.owner, term),
        like(resources.datacenter, term),
        sql`cast(${resources.attrs} as text) like ${term}`,
        like(resources.remark, term),
      ),
    );
  }
  if (q.type) clauses.push(eq(resources.type, q.type));
  if (q.environment) clauses.push(eq(resources.environment, q.environment));
  if (q.status) clauses.push(eq(resources.status, q.status));
  if (q.datacenter) clauses.push(eq(resources.datacenter, q.datacenter));
  if (q.owner) clauses.push(like(resources.owner, `%${q.owner}%`));
  // 标签支持逗号分隔多值，语义为「同时包含」
  if (q.tag) {
    for (const tag of q.tag.split(',').map((t) => t.trim()).filter(Boolean)) {
      clauses.push(sql`cast(${resources.tags} as text) like ${`%"${tag}"%`}`);
    }
  }
  if (q.unassigned) clauses.push(isNull(resources.projectId));
  // 精确按 id 定位（子资源跳父资源时只看该资源本身）
  if (q.id) clauses.push(eq(resources.id, q.id));
  if (q.parentId) clauses.push(eq(resources.parentId, q.parentId));
  if (q.rootOnly) clauses.push(isNull(resources.parentId));

  // 项目维度：主归属 ∪ 槽位引用
  const scopeClauses = [];
  if (q.projectId) scopeClauses.push(eq(resources.projectId, q.projectId));
  if (q.projectEnvId) scopeClauses.push(eq(resources.projectEnvId, q.projectEnvId));
  if (scope?.slotResourceIds?.length) scopeClauses.push(inArray(resources.id, scope.slotResourceIds));
  if (scopeClauses.length > 0) clauses.push(or(...scopeClauses));

  return clauses.length ? and(...clauses) : undefined;
}

export const resourceRepository = {
  async list(q: ResourceQuery, scope?: ResourceScope): Promise<Paged<ResourceRow>> {
    const where = buildWhere(q, scope);
    const attrKey = q.sortBy.startsWith('attr:') ? q.sortBy.slice(5) : null;
    const sortExpression = attrKey
      ? config.db.driver === 'postgres'
        ? sql`${resources.attrs} ->> ${attrKey}`
        : sql`json_extract(${resources.attrs}, ${`$.${attrKey}`})`
      : SORT_COLUMNS[q.sortBy as keyof typeof SORT_COLUMNS];
    const [{ value: total }] = await db
      .select({ value: count() })
      .from(resources)
      .where(where);
    const rows = await db
      .select()
      .from(resources)
      .where(where)
      .orderBy(q.sortOrder === 'asc' ? asc(sortExpression) : desc(sortExpression))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const totalPages = Math.max(1, Math.ceil(total / q.pageSize));
    return { items: rows, meta: { page: q.page, pageSize: q.pageSize, total, totalPages } };
  },

  listAll(q: Partial<ResourceQuery> = {}, scope?: ResourceScope): Promise<ResourceRow[]> {
    return db.select().from(resources).where(buildWhere(q as ResourceQuery, scope));
  },

  findById(id: number): Promise<ResourceRow | undefined> {
    return firstRow<ResourceRow>(db.select().from(resources).where(eq(resources.id, id)));
  },

  findByCode(code: string): Promise<ResourceRow | undefined> {
    return firstRow<ResourceRow>(db.select().from(resources).where(eq(resources.code, code)));
  },

  async findByIds(ids: number[]): Promise<ResourceRow[]> {
    if (ids.length === 0) return [];
    return db.select().from(resources).where(inArray(resources.id, ids));
  },

  async create(values: typeof resources.$inferInsert): Promise<ResourceRow> {
    const rows = await db.insert(resources).values(values).returning();
    return rows[0]!;
  },

  async update(id: number, values: Partial<typeof resources.$inferInsert>): Promise<ResourceRow> {
    const rows = await db
      .update(resources)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(resources.id, id))
      .returning();
    return rows[0]!;
  },

  async remove(id: number): Promise<void> {
    await db.delete(resources).where(eq(resources.id, id));
  },

  /** 按 IP 精查（attrs JSON 文本匹配），用于 IP 占用检测 */
  async findByIp(ip: string): Promise<ResourceRow[]> {
    return db
      .select()
      .from(resources)
      .where(sql`cast(${resources.attrs} as text) like ${`%"${ip}"%`}`);
  },

  async countBy(field: 'type' | 'environment' | 'status' | 'datacenter') {
    const column = {
      type: resources.type,
      environment: resources.environment,
      status: resources.status,
      datacenter: resources.datacenter,
    }[field];
    return db
      .select({ key: column, value: count() })
      .from(resources)
      .groupBy(column)
      .orderBy(desc(count()));
  },

  async nextCode(type: string): Promise<string> {
    const prefix = (await getTypeMeta(type)).prefix;
    const [{ value: total }] = await db
      .select({ value: count() })
      .from(resources)
      .where(eq(resources.type, type));
    let seq = total + 1;
    let code = `${prefix}-${String(seq).padStart(4, '0')}`;
    // 并发/历史删除场景下保证唯一
    while (await this.findByCode(code)) {
      seq += 1;
      code = `${prefix}-${String(seq).padStart(4, '0')}`;
    }
    return code;
  },

  async statsCreatedSince(since: Date): Promise<number> {
    const [{ value }] = await db
      .select({ value: count() })
      .from(resources)
      .where(
        sql`${resources.createdAt} >= ${
          config.db.driver === 'postgres' ? since : since.getTime()
        }`,
      );
    return value;
  },

  /**
   * 批量统计资源已占用的容量与引用数量：
   * - slotAllocated：被环境槽位申请的容量
   * - childAllocated：被子资源申请的容量
   * 两者之和即「已占用」，一次查询完成，避免列表页逐行统计（N+1）。
   */
  async capacityUsageByResources(ids: number[]): Promise<
    Map<number, { allocated: number; slotCount: number; slotAllocated: number; childAllocated: number }>
  > {
    const map = new Map<
      number,
      { allocated: number; slotCount: number; slotAllocated: number; childAllocated: number }
    >();
    if (ids.length === 0) return map;

    const slotRows = await db
      .select({ resourceId: envSlots.resourceId, amount: envSlots.demandAmount })
      .from(envSlots)
      .where(inArray(envSlots.resourceId, ids));
    for (const r of slotRows) {
      if (r.resourceId === null) continue;
      const cur = map.get(r.resourceId) ?? { allocated: 0, slotCount: 0, slotAllocated: 0, childAllocated: 0 };
      cur.allocated += r.amount ?? 0;
      cur.slotAllocated += r.amount ?? 0;
      cur.slotCount += 1;
      map.set(r.resourceId, cur);
    }

    const childRows = await db
      .select({ parentId: resources.parentId, demand: resources.demandAmount })
      .from(resources)
      .where(inArray(resources.parentId, ids));
    for (const r of childRows) {
      if (r.parentId === null) continue;
      const cur = map.get(r.parentId) ?? { allocated: 0, slotCount: 0, slotAllocated: 0, childAllocated: 0 };
      cur.allocated += r.demand ?? 0;
      cur.childAllocated += r.demand ?? 0;
      map.set(r.parentId, cur);
    }
    return map;
  },

  /** 直接子资源 */
  async listChildren(parentId: number): Promise<ResourceRow[]> {
    return db.select().from(resources).where(eq(resources.parentId, parentId)).orderBy(asc(resources.id));
  },

  /** 批量取多个父资源下的子资源，避免列表页逐行查询 */
  async listChildrenByParents(parentIds: number[]): Promise<ResourceRow[]> {
    if (parentIds.length === 0) return [];
    return db.select().from(resources).where(inArray(resources.parentId, parentIds));
  },

  /** 子资源申请量合计（父资源容量校验用） */
  async sumChildDemand(parentId: number): Promise<number> {
    const rows = await db
      .select({ demand: resources.demandAmount })
      .from(resources)
      .where(eq(resources.parentId, parentId));
    return rows.reduce((sum, r) => sum + (r.demand ?? 0), 0);
  },

  /** 祖先链（由近及远），用于容量同步校验与「从子资源回到父资源」 */
  async ancestorsOf(id: number): Promise<ResourceRow[]> {
    const out: ResourceRow[] = [];
    const seen = new Set<number>([id]);
    let current = await this.findById(id);
    while (current?.parentId) {
      if (seen.has(current.parentId)) break;
      const parent = await this.findById(current.parentId);
      if (!parent) break;
      seen.add(parent.id);
      out.push(parent);
      current = parent;
    }
    return out;
  },

  /** 子资源 id 集合（含多层），用于阻止把父资源挂到自己的后代下形成环 */
  async descendantIds(id: number): Promise<number[]> {
    const out: number[] = [];
    const queue = [id];
    const seen = new Set<number>([id]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await this.listChildren(current);
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child.id);
        queue.push(child.id);
      }
    }
    return out;
  },

  /** 所有标签及出现次数（概览里的标签云、台账筛选下拉） */
  async tagCounts(): Promise<{ tag: string; count: number }[]> {
    const rows = await db.select({ tags: resources.tags }).from(resources);
    const counter = new Map<string, number>();
    for (const r of rows) {
      for (const tag of r.tags ?? []) counter.set(tag, (counter.get(tag) ?? 0) + 1);
    }
    return [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
  },
};

/* ------------------------------------------------------------------ *
 * 资源引用明细：某个资源被哪些项目 / 项目环境 / 槽位引用
 * ------------------------------------------------------------------ */

export interface ResourceSlotRefRow {
  slotId: number;
  slotRole: string;
  amount: number | null;
  envId: number;
  envName: string;
  environment: string;
  projectId: number | null;
  startAt: Date | null;
  endAt: Date | null;
  renewCount: number;
}

export const resourceRefRepository = {
  /** 某资源被哪些环境槽位引用（含项目 / 环境信息、申请量与占用期限） */
  async listByResource(resourceId: number): Promise<ResourceSlotRefRow[]> {
    const rows = await db
      .select({
        slotId: envSlots.id,
        slotRole: envSlots.slotRole,
        amount: envSlots.demandAmount,
        envId: projectEnvironments.id,
        envName: projectEnvironments.name,
        environment: projectEnvironments.environment,
        projectId: projectEnvironments.projectId,
        startAt: envSlots.startAt,
        endAt: envSlots.endAt,
        renewCount: envSlots.renewCount,
      })
      .from(envSlots)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, envSlots.environmentId))
      .where(eq(envSlots.resourceId, resourceId))
      .orderBy(asc(envSlots.startAt), asc(envSlots.id));
    return rows;
  },

  /** 批量：多个资源各自的引用明细 */
  async listByResources(resourceIds: number[]): Promise<Map<number, ResourceSlotRefRow[]>> {
    const map = new Map<number, ResourceSlotRefRow[]>();
    if (resourceIds.length === 0) return map;
    const rows = await db
      .select({
        resourceId: envSlots.resourceId,
        slotId: envSlots.id,
        slotRole: envSlots.slotRole,
        amount: envSlots.demandAmount,
        envId: projectEnvironments.id,
        envName: projectEnvironments.name,
        environment: projectEnvironments.environment,
        projectId: projectEnvironments.projectId,
        startAt: envSlots.startAt,
        endAt: envSlots.endAt,
        renewCount: envSlots.renewCount,
      })
      .from(envSlots)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, envSlots.environmentId))
      .where(inArray(envSlots.resourceId, resourceIds))
      .orderBy(asc(envSlots.startAt), asc(envSlots.id));
    for (const r of rows) {
      if (r.resourceId === null) continue;
      const list = map.get(r.resourceId) ?? [];
      list.push({
        slotId: r.slotId,
        slotRole: r.slotRole,
        amount: r.amount,
        envId: r.envId,
        envName: r.envName,
        environment: r.environment,
        projectId: r.projectId,
        startAt: r.startAt,
        endAt: r.endAt,
        renewCount: r.renewCount,
      });
      map.set(r.resourceId, list);
    }
    return map;
  },
};
