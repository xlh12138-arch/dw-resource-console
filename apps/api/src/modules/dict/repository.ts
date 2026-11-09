import { asc, count, eq, inArray } from 'drizzle-orm';
import { db, firstRow } from '../../db/index.js';
import {
  environmentDict,
  envSlots,
  envTemplateItems,
  envTemplates,
  projectEnvironments,
  projects,
  resourceTypeFields,
  resourceTypes,
  resources,
  type EnvironmentRow,
  type ResourceTypeFieldRow,
  type ResourceTypeRow,
} from '../../db/schema.js';

/* ------------------------------------------------------------------ *
 * 资源类型字典
 * ------------------------------------------------------------------ */

export const resourceTypeRepository = {
  listAll(): Promise<ResourceTypeRow[]> {
    return db
      .select()
      .from(resourceTypes)
      .orderBy(asc(resourceTypes.sortOrder), asc(resourceTypes.code));
  },

  listEnabled(): Promise<ResourceTypeRow[]> {
    return db
      .select()
      .from(resourceTypes)
      .where(eq(resourceTypes.enabled, true))
      .orderBy(asc(resourceTypes.sortOrder), asc(resourceTypes.code));
  },

  async findByCode(code: string): Promise<ResourceTypeRow | undefined> {
    return firstRow<ResourceTypeRow>(
      db.select().from(resourceTypes).where(eq(resourceTypes.code, code)),
    );
  },

  async create(values: typeof resourceTypes.$inferInsert): Promise<ResourceTypeRow> {
    const rows = await db.insert(resourceTypes).values(values).returning();
    return rows[0]!;
  },

  async update(
    code: string,
    values: Partial<typeof resourceTypes.$inferInsert>,
  ): Promise<ResourceTypeRow> {
    const rows = await db
      .update(resourceTypes)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(resourceTypes.code, code))
      .returning();
    return rows[0]!;
  },

  async remove(code: string): Promise<void> {
    await db.delete(resourceTypes).where(eq(resourceTypes.code, code));
  },

  /** 编码变更：先建新行 → 迁移子表与引用 → 删旧行（SQLite 外键无 ON UPDATE CASCADE） */
  async renameCode(from: string, to: string): Promise<void> {
    const before = await this.findByCode(from);
    if (!before) return;
    await db.insert(resourceTypes).values({ ...before, code: to, updatedAt: new Date() });
    await db
      .update(resourceTypeFields)
      .set({ typeCode: to })
      .where(eq(resourceTypeFields.typeCode, from));
    await db.delete(resourceTypes).where(eq(resourceTypes.code, from));
  },

  async exists(code: string): Promise<boolean> {
    return (await this.findByCode(code)) !== undefined;
  },
};

/* ------------------------------------------------------------------ *
 * 资源类型的属性字段定义
 * ------------------------------------------------------------------ */

export const resourceTypeFieldRepository = {
  listByType(typeCode: string): Promise<ResourceTypeFieldRow[]> {
    return db
      .select()
      .from(resourceTypeFields)
      .where(eq(resourceTypeFields.typeCode, typeCode))
      .orderBy(asc(resourceTypeFields.sortOrder), asc(resourceTypeFields.id));
  },

  listAllByTypes(typeCodes: string[]): Promise<ResourceTypeFieldRow[]> {
    if (typeCodes.length === 0) return Promise.resolve([]);
    return db
      .select()
      .from(resourceTypeFields)
      .where(inArray(resourceTypeFields.typeCode, typeCodes))
      .orderBy(asc(resourceTypeFields.sortOrder), asc(resourceTypeFields.id));
  },

  listAll(): Promise<ResourceTypeFieldRow[]> {
    return db
      .select()
      .from(resourceTypeFields)
      .orderBy(asc(resourceTypeFields.sortOrder), asc(resourceTypeFields.id));
  },

  /** 全量替换某类型的字段定义 */
  async replaceAll(
    typeCode: string,
    fields: (typeof resourceTypeFields.$inferInsert)[],
  ): Promise<void> {
    await db.delete(resourceTypeFields).where(eq(resourceTypeFields.typeCode, typeCode));
    if (fields.length > 0) await db.insert(resourceTypeFields).values(fields);
  },

  async countByType(typeCode: string): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(resourceTypeFields)
      .where(eq(resourceTypeFields.typeCode, typeCode));
    return row?.value ?? 0;
  },
};

/* ------------------------------------------------------------------ *
 * 环境字典
 * ------------------------------------------------------------------ */

export const environmentRepository = {
  listAll(): Promise<EnvironmentRow[]> {
    return db
      .select()
      .from(environmentDict)
      .orderBy(asc(environmentDict.sortOrder), asc(environmentDict.code));
  },

  listEnabled(): Promise<EnvironmentRow[]> {
    return db
      .select()
      .from(environmentDict)
      .where(eq(environmentDict.enabled, true))
      .orderBy(asc(environmentDict.sortOrder), asc(environmentDict.code));
  },

  async findByCode(code: string): Promise<EnvironmentRow | undefined> {
    return firstRow<EnvironmentRow>(
      db.select().from(environmentDict).where(eq(environmentDict.code, code)),
    );
  },

  async create(values: typeof environmentDict.$inferInsert): Promise<EnvironmentRow> {
    const rows = await db.insert(environmentDict).values(values).returning();
    return rows[0]!;
  },

  async update(
    code: string,
    values: Partial<typeof environmentDict.$inferInsert>,
  ): Promise<EnvironmentRow> {
    const rows = await db
      .update(environmentDict)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(environmentDict.code, code))
      .returning();
    return rows[0]!;
  },

  async remove(code: string): Promise<void> {
    await db.delete(environmentDict).where(eq(environmentDict.code, code));
  },

  async renameCode(from: string, to: string): Promise<void> {
    const before = await this.findByCode(from);
    if (!before) return;
    await db.insert(environmentDict).values({ ...before, code: to, updatedAt: new Date() });
    await db.delete(environmentDict).where(eq(environmentDict.code, from));
  },

  async exists(code: string): Promise<boolean> {
    return (await this.findByCode(code)) !== undefined;
  },
};

/* ------------------------------------------------------------------ *
 * 引用统计：字典项被哪些对象引用、引用了多少
 * ------------------------------------------------------------------ */

const SAMPLE_LIMIT = 8;

/** 按项目 id 取项目名：引用明细里要把「哪个项目的哪套环境」说清楚 */
async function projectNameMap(ids: (number | null)[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const wanted = [...new Set(ids.filter((v): v is number => typeof v === 'number'))];
  if (wanted.length === 0) return map;
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, wanted));
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

export const dictReferenceRepository = {
  async resourceTypeRefs(code: string) {
    const [resRows, itemRows, slotRows] = await Promise.all([
      db
        .select({ id: resources.id, name: resources.name, code: resources.code })
        .from(resources)
        .where(eq(resources.type, code)),
      db
        .select({
          id: envTemplateItems.id,
          templateId: envTemplateItems.templateId,
          slotRole: envTemplateItems.slotRole,
        })
        .from(envTemplateItems)
        .where(eq(envTemplateItems.resourceType, code)),
      db
        .select({
          id: envSlots.id,
          envId: envSlots.environmentId,
          slotRole: envSlots.slotRole,
        })
        .from(envSlots)
        .where(eq(envSlots.resourceType, code)),
    ]);

    const templateNames = new Map<number, string>();
    if (itemRows.length > 0) {
      const tpls = await db
        .select({ id: envTemplates.id, name: envTemplates.name })
        .from(envTemplates);
      for (const t of tpls) templateNames.set(t.id, t.name);
    }
    const envNames = new Map<number, string>();
    const envProject = new Map<number, number | null>();
    if (slotRows.length > 0) {
      const envs = await db
        .select({
          id: projectEnvironments.id,
          name: projectEnvironments.name,
          projectId: projectEnvironments.projectId,
        })
        .from(projectEnvironments);
      for (const e of envs) {
        envNames.set(e.id, e.name);
        envProject.set(e.id, e.projectId ?? null);
      }
    }
    const projectNames = await projectNameMap(slotRows.map((r) => envProject.get(r.envId) ?? null));

    return {
      total: resRows.length + itemRows.length + slotRows.length,
      groups: [
        {
          entity: 'RESOURCE' as const,
          label: '资源',
          count: resRows.length,
          samples: resRows
            .slice(0, SAMPLE_LIMIT)
            .map((r) => ({ id: String(r.id), name: `${r.code} ${r.name}` })),
        },
        {
          entity: 'TEMPLATE_ITEM' as const,
          label: '环境模板条目',
          count: itemRows.length,
          samples: itemRows.slice(0, SAMPLE_LIMIT).map((r) => ({
            id: String(r.id),
            name: `${templateNames.get(r.templateId) ?? '模板'} · ${r.slotRole}`,
          })),
        },
        {
          entity: 'ENV_SLOT' as const,
          label: '项目环境槽位',
          count: slotRows.length,
          samples: slotRows.slice(0, SAMPLE_LIMIT).map((r) => ({
            id: String(r.id),
            name: `${projectNames.get(envProject.get(r.envId) ?? -1) ?? '未归属项目'} · ${
              envNames.get(r.envId) ?? '环境'
            } · ${r.slotRole}`,
          })),
        },
      ].filter((g) => g.count > 0),
    };
  },

  async environmentRefs(code: string) {
    const [resRows, envRows] = await Promise.all([
      db
        .select({ id: resources.id, name: resources.name, code: resources.code })
        .from(resources)
        .where(eq(resources.environment, code)),
      db
        .select({
          id: projectEnvironments.id,
          name: projectEnvironments.name,
          projectId: projectEnvironments.projectId,
        })
        .from(projectEnvironments)
        .where(eq(projectEnvironments.environment, code)),
    ]);

    // 项目环境要带上所属项目名，否则「开发环境」这类重名环境分不清是哪个项目的
    const projectNames = await projectNameMap(envRows.map((r) => r.projectId));

    return {
      total: resRows.length + envRows.length,
      groups: [
        {
          entity: 'RESOURCE' as const,
          label: '资源',
          count: resRows.length,
          samples: resRows
            .slice(0, SAMPLE_LIMIT)
            .map((r) => ({ id: String(r.id), name: `${r.code} ${r.name}` })),
        },
        {
          entity: 'PROJECT_ENV' as const,
          label: '项目环境',
          count: envRows.length,
          samples: envRows.slice(0, SAMPLE_LIMIT).map((r) => ({
            id: String(r.id),
            name: `${projectNames.get(r.projectId ?? -1) ?? '未归属项目'} · ${r.name}`,
          })),
        },
      ].filter((g) => g.count > 0),
    };
  },
};
