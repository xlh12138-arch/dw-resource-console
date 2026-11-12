import { and, asc, count, desc, eq, inArray, like, or } from 'drizzle-orm';
import { db, firstRow } from '../../db/index.js';
import {
  envSlots,
  envTemplateItems,
  envTemplates,
  projectEnvironments,
  projectSnapshots,
  projects,
  resources,
  type EnvSlotRow,
  type ProjectEnvRow,
  type ProjectRow,
  type ProjectSnapshotRow,
} from '../../db/schema.js';
import type { envTemplateQuerySchema, projectQuerySchema } from '@dw/shared';
import type { z } from 'zod';

export type ProjectQuery = z.infer<typeof projectQuerySchema>;
export type EnvTemplateQuery = z.infer<typeof envTemplateQuerySchema>;

/* ------------------------------------------------------------------ *
 * 项目
 * ------------------------------------------------------------------ */

export const projectRepository = {
  async listFiltered(q: ProjectQuery): Promise<ProjectRow[]> {
    const where = q.status ? eq(projects.status, q.status) : undefined;
    const all = await db.select().from(projects).where(where).orderBy(desc(projects.updatedAt));
    return q.q
      ? all.filter(
          (p) =>
            p.name.includes(q.q!) ||
            p.code.toLowerCase().includes(q.q!.toLowerCase()) ||
            (p.owner ?? '').includes(q.q!) ||
            (p.description ?? '').includes(q.q!),
        )
      : all;
  },

  listAll(): Promise<ProjectRow[]> {
    return db.select().from(projects).orderBy(asc(projects.id));
  },

  findById(id: number): Promise<ProjectRow | undefined> {
    return firstRow<ProjectRow>(db.select().from(projects).where(eq(projects.id, id)));
  },

  findByCode(code: string): Promise<ProjectRow | undefined> {
    return firstRow<ProjectRow>(db.select().from(projects).where(eq(projects.code, code)));
  },

  async create(values: typeof projects.$inferInsert): Promise<ProjectRow> {
    const rows = await db.insert(projects).values(values).returning();
    return rows[0]!;
  },

  async update(id: number, values: Partial<typeof projects.$inferInsert>): Promise<ProjectRow> {
    const rows = await db
      .update(projects)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    return rows[0]!;
  },

  async remove(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  },

  async nextCode(): Promise<string> {
    const [{ value: total }] = await db.select({ value: count() }).from(projects);
    let seq = total + 1;
    let code = `PRJ-${String(seq).padStart(4, '0')}`;
    while (await this.findByCode(code)) {
      seq += 1;
      code = `PRJ-${String(seq).padStart(4, '0')}`;
    }
    return code;
  },

  async envIdsByProject(projectId: number): Promise<number[]> {
    const rows = await db
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.projectId, projectId));
    return rows.map((r) => r.id);
  },
};

export const projectSnapshotRepository = {
  findByProjectId(projectId: number): Promise<ProjectSnapshotRow | undefined> {
    return firstRow<ProjectSnapshotRow>(
      db.select().from(projectSnapshots).where(eq(projectSnapshots.projectId, projectId)),
    );
  },

  findById(id: number): Promise<ProjectSnapshotRow | undefined> {
    return firstRow<ProjectSnapshotRow>(
      db.select().from(projectSnapshots).where(eq(projectSnapshots.id, id)),
    );
  },

  async create(values: typeof projectSnapshots.$inferInsert): Promise<ProjectSnapshotRow> {
    const rows = await db.insert(projectSnapshots).values(values).returning();
    return rows[0]!;
  },

  async remove(id: number): Promise<void> {
    await db.delete(projectSnapshots).where(eq(projectSnapshots.id, id));
  },
};

/* ------------------------------------------------------------------ *
 * 项目环境
 * ------------------------------------------------------------------ */

export const projectEnvRepository = {
  listByProject(projectId: number): Promise<ProjectEnvRow[]> {
    return db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.projectId, projectId))
      .orderBy(asc(projectEnvironments.id));
  },

  listAll(): Promise<ProjectEnvRow[]> {
    return db.select().from(projectEnvironments).orderBy(asc(projectEnvironments.id));
  },

  findById(id: number): Promise<ProjectEnvRow | undefined> {
    return firstRow<ProjectEnvRow>(
      db.select().from(projectEnvironments).where(eq(projectEnvironments.id, id)),
    );
  },

  findByName(projectId: number, name: string): Promise<ProjectEnvRow | undefined> {
    return firstRow<ProjectEnvRow>(
      db
        .select()
        .from(projectEnvironments)
        .where(
          and(eq(projectEnvironments.projectId, projectId), eq(projectEnvironments.name, name)),
        ),
    );
  },

  async create(values: typeof projectEnvironments.$inferInsert): Promise<ProjectEnvRow> {
    const rows = await db.insert(projectEnvironments).values(values).returning();
    return rows[0]!;
  },

  async update(
    id: number,
    values: Partial<typeof projectEnvironments.$inferInsert>,
  ): Promise<ProjectEnvRow> {
    const rows = await db
      .update(projectEnvironments)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(projectEnvironments.id, id))
      .returning();
    return rows[0]!;
  },

  async remove(id: number): Promise<void> {
    await db.delete(projectEnvironments).where(eq(projectEnvironments.id, id));
  },

  /** 统计某环境下已填充 / 总槽位数 */
  async slotStat(envId: number): Promise<{ total: number; filled: number }> {
    const rows = await db
      .select({ id: envSlots.id, resourceId: envSlots.resourceId })
      .from(envSlots)
      .where(eq(envSlots.environmentId, envId));
    return { total: rows.length, filled: rows.filter((r) => r.resourceId !== null).length };
  },
};

/* ------------------------------------------------------------------ *
 * 环境槽位
 * ------------------------------------------------------------------ */

export const slotRepository = {
  listAll(): Promise<EnvSlotRow[]> {
    return db.select().from(envSlots).orderBy(asc(envSlots.sortOrder), asc(envSlots.id));
  },

  listByEnv(envId: number): Promise<EnvSlotRow[]> {
    return db
      .select()
      .from(envSlots)
      .where(eq(envSlots.environmentId, envId))
      .orderBy(asc(envSlots.sortOrder), asc(envSlots.id));
  },

  findById(id: number): Promise<EnvSlotRow | undefined> {
    return firstRow<EnvSlotRow>(db.select().from(envSlots).where(eq(envSlots.id, id)));
  },

  async create(values: typeof envSlots.$inferInsert): Promise<EnvSlotRow> {
    const rows = await db.insert(envSlots).values(values).returning();
    return rows[0]!;
  },

  async update(id: number, values: Partial<typeof envSlots.$inferInsert>): Promise<EnvSlotRow> {
    const rows = await db.update(envSlots).set(values).where(eq(envSlots.id, id)).returning();
    return rows[0]!;
  },

  async remove(id: number): Promise<void> {
    await db.delete(envSlots).where(eq(envSlots.id, id));
  },

  async removeByEnv(envId: number): Promise<void> {
    await db.delete(envSlots).where(eq(envSlots.environmentId, envId));
  },

  /** 环境已绑定的资源 id 列表（用于「按项目查看」的共享引用并集） */
  async resourceIdsByEnv(envId: number): Promise<number[]> {
    const rows = await db
      .select({ resourceId: envSlots.resourceId })
      .from(envSlots)
      .where(eq(envSlots.environmentId, envId));
    return rows.map((r) => r.resourceId).filter((id): id is number => id !== null);
  },

  async resourceIdsByEnvs(envIds: number[]): Promise<number[]> {
    if (envIds.length === 0) return [];
    const rows = await db
      .select({ resourceId: envSlots.resourceId })
      .from(envSlots)
      .where(inArray(envSlots.environmentId, envIds));
    return rows.map((r) => r.resourceId).filter((id): id is number => id !== null);
  },

  async countByResource(resourceId: number): Promise<number> {
    const rows = await db
      .select({ id: envSlots.id })
      .from(envSlots)
      .where(eq(envSlots.resourceId, resourceId));
    return rows.length;
  },
};

/* ------------------------------------------------------------------ *
 * 环境模板
 * ------------------------------------------------------------------ */

export const templateRepository = {
  async listFiltered(q: EnvTemplateQuery): Promise<(typeof envTemplates.$inferSelect)[]> {
    const all = await db.select().from(envTemplates).orderBy(desc(envTemplates.updatedAt));
    return q.q
      ? all.filter(
          (t) =>
            t.name.includes(q.q!) ||
            t.code.toLowerCase().includes(q.q!.toLowerCase()) ||
            (t.description ?? '').includes(q.q!),
        )
      : all;
  },

  listAll(): Promise<(typeof envTemplates.$inferSelect)[]> {
    return db.select().from(envTemplates).orderBy(asc(envTemplates.id));
  },

  findById(id: number): Promise<typeof envTemplates.$inferSelect | undefined> {
    return firstRow(db.select().from(envTemplates).where(eq(envTemplates.id, id)));
  },

  findByCode(code: string): Promise<typeof envTemplates.$inferSelect | undefined> {
    return firstRow(db.select().from(envTemplates).where(eq(envTemplates.code, code)));
  },

  listItems(templateId: number) {
    return db
      .select()
      .from(envTemplateItems)
      .where(eq(envTemplateItems.templateId, templateId))
      .orderBy(asc(envTemplateItems.sortOrder), asc(envTemplateItems.id));
  },

  async create(values: typeof envTemplates.$inferInsert) {
    const rows = await db.insert(envTemplates).values(values).returning();
    return rows[0]!;
  },

  async update(id: number, values: Partial<typeof envTemplates.$inferInsert>) {
    const rows = await db
      .update(envTemplates)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(envTemplates.id, id))
      .returning();
    return rows[0]!;
  },

  async remove(id: number): Promise<void> {
    await db.delete(envTemplates).where(eq(envTemplates.id, id));
  },

  async replaceItems(
    templateId: number,
    items: (typeof envTemplateItems.$inferInsert)[],
  ): Promise<void> {
    await db.delete(envTemplateItems).where(eq(envTemplateItems.templateId, templateId));
    if (items.length > 0) await db.insert(envTemplateItems).values(items);
  },

  async nextCode(): Promise<string> {
    const [{ value: total }] = await db.select({ value: count() }).from(envTemplates);
    let seq = total + 1;
    let code = `TPL-${String(seq).padStart(4, '0')}`;
    while (await this.findByCode(code)) {
      seq += 1;
      code = `TPL-${String(seq).padStart(4, '0')}`;
    }
    return code;
  },

  /** 模板被多少个项目环境引用（用于展示与删除保护提示） */
  async usageCount(templateId: number): Promise<number> {
    const rows = await db
      .select({ id: projectEnvironments.id })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.templateId, templateId));
    return rows.length;
  },

  /** 模板展开后的总槽位数 */
  async slotCount(templateId: number): Promise<number> {
    const items = await this.listItems(templateId);
    return items.reduce((sum, i) => sum + i.quantity, 0);
  },
};

/** 资源主表辅助：批量更新项目归属 */
export const resourceProjectRepository = {
  findById(id: number): Promise<typeof resources.$inferSelect | undefined> {
    return firstRow(db.select().from(resources).where(eq(resources.id, id)));
  },

  async findByIds(ids: number[]) {
    if (ids.length === 0) return [];
    return db.select().from(resources).where(inArray(resources.id, ids));
  },

  async setProject(ids: number[], projectId: number | null, projectEnvId: number | null) {
    if (ids.length === 0) return [];
    return db
      .update(resources)
      .set({ projectId, projectEnvId, updatedAt: new Date() })
      .where(inArray(resources.id, ids))
      .returning();
  },

  async clearEnvRefs(envId: number) {
    return db
      .update(resources)
      .set({ projectEnvId: null, updatedAt: new Date() })
      .where(eq(resources.projectEnvId, envId))
      .returning();
  },

  /** 删除项目前解除资源的项目归属（SQLite 的 ADD COLUMN 不带 ON DELETE SET NULL，需显式处理） */
  async clearProjectRefs(projectId: number) {
    return db
      .update(resources)
      .set({ projectId: null, projectEnvId: null, updatedAt: new Date() })
      .where(eq(resources.projectId, projectId))
      .returning();
  },
};

export const searchTemplates = async (keyword: string) =>
  db
    .select()
    .from(envTemplates)
    .where(or(like(envTemplates.name, `%${keyword}%`), like(envTemplates.code, `%${keyword}%`)));
