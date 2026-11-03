import { ENVIRONMENT_COLORS, ENVIRONMENT_LABELS } from '@dw/shared';
import type {
  DictReferences,
  ResourceTypeFieldDto,
  DictSyncResult,
  EnvironmentDictCreateInput,
  ResourceTypeCreateInput,
  ResourceTypeDetail,
  ResourceTypeDto,
  ResourceTypeUpdateInput,
  EnvironmentDto,
} from '@dw/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { envSlots, envTemplateItems, projectEnvironments, resources } from '../../db/schema.js';
import { conflict, notFound, validationError } from '../../lib/errors.js';
import { auditRepository } from '../audit/repository.js';
import {
  dictReferenceRepository,
  environmentRepository,
  resourceTypeFieldRepository,
  resourceTypeRepository,
} from './repository.js';
import { getTypeMeta, invalidateDictCache, normalizeAttrs, toRuntimeField } from './validator.js';

export interface Actor {
  id: number | null;
  username: string;
}

function toTypeDto(
  row: Awaited<ReturnType<typeof resourceTypeRepository.findByCode>>,
  fieldCount: number,
  referenceCount: number,
): ResourceTypeDto {
  const r = row!;
  return {
    code: r.code,
    label: r.label,
    prefix: r.prefix,
    description: r.description ?? null,
    ipUniqueByPort: r.ipUniqueByPort,
    listColumns: r.listColumns ?? [],
    enabled: r.enabled,
    builtin: r.builtin,
    sortOrder: r.sortOrder,
    fieldCount,
    referenceCount,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toEnvDto(
  row: NonNullable<Awaited<ReturnType<typeof environmentRepository.findByCode>>>,
  referenceCount: number,
): EnvironmentDto {
  return {
    code: row.code,
    label: row.label,
    tone: row.tone,
    color: row.color ?? null,
    description: row.description ?? null,
    enabled: row.enabled,
    builtin: row.builtin,
    sortOrder: row.sortOrder,
    referenceCount,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 资源类型
 * ------------------------------------------------------------------ */

export const resourceTypeService = {
  async list(includeDisabled = true): Promise<ResourceTypeDto[]> {
    const rows = includeDisabled
      ? await resourceTypeRepository.listAll()
      : await resourceTypeRepository.listEnabled();
    const [fields, ...refs] = await Promise.all([
      resourceTypeFieldRepository.listAll(),
      ...rows.map((r) => dictReferenceRepository.resourceTypeRefs(r.code)),
    ]);
    const fieldCount = new Map<string, number>();
    for (const f of fields) fieldCount.set(f.typeCode, (fieldCount.get(f.typeCode) ?? 0) + 1);
    return rows.map((r, i) => toTypeDto(r, fieldCount.get(r.code) ?? 0, refs[i].total));
  },

  async get(code: string): Promise<ResourceTypeDetail> {
    const row = await resourceTypeRepository.findByCode(code);
    if (!row) throw notFound(`资源类型 ${code} 不存在`);
    const [fieldRows, refs] = await Promise.all([
      resourceTypeFieldRepository.listByType(code),
      dictReferenceRepository.resourceTypeRefs(code),
    ]);
    return {
      ...toTypeDto(row, fieldRows.length, refs.total),
      fields: fieldRows.map(
        (f) => ({ ...toRuntimeField(f), id: f.id, typeCode: f.typeCode }) as ResourceTypeFieldDto,
      ),
    };
  },

  async references(code: string): Promise<DictReferences> {
    const row = await resourceTypeRepository.findByCode(code);
    if (!row) throw notFound(`资源类型 ${code} 不存在`);
    const refs = await dictReferenceRepository.resourceTypeRefs(code);
    return { code, label: row.label, kind: 'RESOURCE_TYPE', total: refs.total, groups: refs.groups };
  },

  async create(input: ResourceTypeCreateInput, actor: Actor, requestId?: string): Promise<ResourceTypeDetail> {
    if (await resourceTypeRepository.exists(input.code)) {
      throw conflict(`资源类型编码 ${input.code} 已存在`);
    }
    await this.assertFields(input.fields);
      await resourceTypeRepository.create({
      code: input.code,
      label: input.label,
      prefix: input.prefix,
      description: input.description ?? null,
      ipUniqueByPort: input.ipUniqueByPort,
      listColumns: input.listColumns,
      enabled: input.enabled,
      builtin: false,
      sortOrder: input.sortOrder,
    });
    await resourceTypeFieldRepository.replaceAll(
      input.code,
      input.fields.map((f, i) => ({
        typeCode: input.code,
        key: f.key,
        label: f.label,
        fieldType: f.fieldType,
        required: f.required,
        options: f.options,
        defaultValue: f.defaultValue ?? null,
        placeholder: f.placeholder ?? null,
        unit: f.unit ?? null,
        isIp: f.isIp,
        sortOrder: f.sortOrder || i,
      })),
    );
    invalidateDictCache(input.code);
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'CREATE',
      targetType: 'DICT',
      targetId: input.code,
      targetName: `资源类型 ${input.label}`,
      changes: [{ field: '*', label: '新增资源类型', from: null, to: input.code }],
      requestId,
    });
    return this.get(input.code);
  },

  /** 字段定义自检：key 唯一、下拉必须有选项 */
  async assertFields(fields: { key: string; label: string; fieldType: string; options?: unknown }[]) {
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.key)) throw validationError(`字段标识 ${f.key} 重复`, { field: 'fields' });
      seen.add(f.key);
      if (f.fieldType === 'SELECT' && (!f.options || (f.options as unknown[]).length === 0)) {
        throw validationError(`字段 ${f.label || f.key} 为下拉选择，至少需要一个选项`, { field: 'fields' });
      }
    }
  },

  /**
   * 修改资源类型。
   * - 仅改名称 / 描述 / 排序等展示信息：直接生效，不打扰用户
   * - 改编码：会影响已引用的资源 / 模板条目 / 环境槽位，未带 sync 且存在引用时返回 409 + 引用明细
   * - 改字段定义：可通过 keyRenames / dropUnknownFields 一键同步存量资源的 attrs
   */
  async update(
    code: string,
    input: ResourceTypeUpdateInput,
    actor: Actor,
    requestId?: string,
  ): Promise<{ detail: ResourceTypeDetail; sync: DictSyncResult | null; pendingAttrSync: number }> {
    const before = await resourceTypeRepository.findByCode(code);
    if (!before) throw notFound(`资源类型 ${code} 不存在`);

    const newCode = input.code?.trim() || code;
    const codeChanged = newCode !== code;
    if (codeChanged && (await resourceTypeRepository.exists(newCode))) {
      throw conflict(`资源类型编码 ${newCode} 已存在`);
    }

    const refs = await dictReferenceRepository.resourceTypeRefs(code);
    if (codeChanged && refs.total > 0 && !input.sync) {
      throw conflict(`资源类型「${before.label}」已被 ${refs.total} 个对象引用，修改类型编码需要同步更新这些引用`, {
        needSync: true,
        references: { code, label: before.label, kind: 'RESOURCE_TYPE', total: refs.total, groups: refs.groups },
      });
    }

    if (input.fields) await this.assertFields(input.fields);

    // 1) 编码变更：先迁移引用，再改字典主键（SQLite 无 ON UPDATE CASCADE，内部按新建→迁移→删除处理）
    let sync: DictSyncResult | null = null;
    if (codeChanged) {
      sync = await this.syncCode(code, newCode);
    }

    // 2) 更新字典行（若编码变化，先建新行再删旧行）
    if (codeChanged) {
      await resourceTypeRepository.renameCode(code, newCode);
    }
    await resourceTypeRepository.update(newCode, {
      label: input.label,
      prefix: input.prefix,
      description: input.description,
      ipUniqueByPort: input.ipUniqueByPort,
      listColumns: input.listColumns,
      enabled: input.enabled,
      sortOrder: input.sortOrder,
    });

    // 3) 字段定义全量替换
    if (input.fields) {
      await resourceTypeFieldRepository.replaceAll(
        newCode,
        input.fields.map((f, i) => ({
          typeCode: newCode,
          key: f.key,
          label: f.label,
          fieldType: f.fieldType,
          required: f.required,
          options: f.options,
          defaultValue: f.defaultValue ?? null,
          placeholder: f.placeholder ?? null,
          unit: f.unit ?? null,
          isIp: f.isIp,
          sortOrder: f.sortOrder || i,
        })),
      );
    }

    invalidateDictCache();

    // 4) 属性字段同步到存量资源
    let attrSynced = 0;
    if (input.keyRenames.length > 0 || input.dropUnknownFields) {
      attrSynced = await this.syncAttrs(newCode, {
        keyRenames: input.keyRenames,
        dropUnknown: input.dropUnknownFields,
      });
      if (sync) sync.attrSynced = attrSynced;
    }

    const detail = await this.get(newCode);
    const pendingAttrSync =
      input.keyRenames.length > 0 || input.dropUnknownFields
        ? 0
        : await this.pendingAttrSyncCount(newCode);

    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'DICT',
      targetId: newCode,
      targetName: `资源类型 ${detail.label}`,
      changes: [
        ...(codeChanged ? [{ field: 'code', label: '类型编码', from: code, to: newCode }] : []),
        ...(input.label && input.label !== before.label
          ? [{ field: 'label', label: '类型名称', from: before.label, to: input.label }]
          : []),
        ...(input.fields ? [{ field: 'fields', label: '属性字段', from: null, to: `${input.fields.length} 个字段` }] : []),
        ...(attrSynced > 0 ? [{ field: 'attrs', label: '同步资源属性', from: null, to: `${attrSynced} 条资源` }] : []),
      ],
      requestId,
    });

    return { detail, sync, pendingAttrSync };
  },

  /** 编码变更：把资源 / 模板条目 / 环境槽位上的旧编码批量改为新编码 */
  async syncCode(from: string, to: string): Promise<DictSyncResult> {
    const [resRows] = await Promise.all([
      db.update(resources).set({ type: to, updatedAt: new Date() }).where(eq(resources.type, from)).returning(),
    ]);
    const itemRows = await db
      .update(envTemplateItems)
      .set({ resourceType: to })
      .where(eq(envTemplateItems.resourceType, from))
      .returning();
    const slotRows = await db
      .update(envSlots)
      .set({ resourceType: to })
      .where(eq(envSlots.resourceType, from))
      .returning();
    invalidateDictCache();
    return {
      code: to,
      previousCode: from,
      updated: {
        resource: resRows.length,
        templateItem: itemRows.length,
        envSlot: slotRows.length,
        projectEnv: 0,
      },
      attrSynced: 0,
      total: resRows.length + itemRows.length + slotRows.length,
    };
  },

  /** 把字段定义的变化（重命名 / 删除）应用到存量资源的 attrs */
  async syncAttrs(
    code: string,
    opts: { keyRenames?: { from: string; to: string }[]; dropUnknown?: boolean } = {},
  ): Promise<number> {
    const meta = await getTypeMeta(code);
    const rows = await db.select().from(resources).where(eq(resources.type, code));
    let changed = 0;
    for (const row of rows) {
      const attrs = (row.attrs ?? {}) as Record<string, unknown>;
      const { value, changed: isChanged } = normalizeAttrs(attrs, meta.fields, {
        keyRenames: opts.keyRenames,
        dropUnknown: opts.dropUnknown,
      });
      if (!isChanged) continue;
      await db.update(resources).set({ attrs: value, updatedAt: new Date() }).where(eq(resources.id, row.id));
      changed += 1;
    }
    return changed;
  },

  /** 存量资源中还残留已删除字段 / 未重命名字段的资源数 */
  async pendingAttrSyncCount(code: string): Promise<number> {
    const meta = await getTypeMeta(code);
    if (meta.fields.length === 0) return 0;
    const known = new Set(meta.fields.map((f) => f.key));
    const rows = await db.select({ attrs: resources.attrs }).from(resources).where(eq(resources.type, code));
    return rows.filter((r) => {
      const keys = Object.keys((r.attrs ?? {}) as Record<string, unknown>);
      return keys.some((k) => !known.has(k));
    }).length;
  },

  /** 删除：存在引用时必须先迁移到另一个类型（或由调用方确认后强制迁移） */
  async remove(
    code: string,
    migrateTo: string | undefined,
    actor: Actor,
    requestId?: string,
  ): Promise<DictSyncResult> {
    const before = await resourceTypeRepository.findByCode(code);
    if (!before) throw notFound(`资源类型 ${code} 不存在`);
    const refs = await dictReferenceRepository.resourceTypeRefs(code);
    if (refs.total > 0 && !migrateTo) {
      throw conflict(`资源类型「${before.label}」已被 ${refs.total} 个对象引用，请先选择要迁移到的类型`, {
        needSync: true,
        references: { code, label: before.label, kind: 'RESOURCE_TYPE', total: refs.total, groups: refs.groups },
      });
    }
    let result: DictSyncResult = {
      code,
      previousCode: null,
      updated: { resource: 0, templateItem: 0, envSlot: 0, projectEnv: 0 },
      attrSynced: 0,
      total: 0,
    };
    if (refs.total > 0 && migrateTo) {
      const target = await resourceTypeRepository.findByCode(migrateTo);
      if (!target) throw notFound(`待迁移的资源类型 ${migrateTo} 不存在`);
      result = await this.syncCode(code, migrateTo);
    }
    await resourceTypeRepository.remove(code);
    invalidateDictCache();
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'DELETE',
      targetType: 'DICT',
      targetId: code,
      targetName: `资源类型 ${before.label}`,
      changes: [
        { field: '*', label: '删除资源类型', from: code, to: migrateTo ?? null },
        ...(result.total > 0 ? [{ field: 'migrate', label: '引用迁移至', from: code, to: migrateTo! }] : []),
      ],
      requestId,
    });
    return result;
  },
};

/* ------------------------------------------------------------------ *
 * 环境
 * ------------------------------------------------------------------ */

export const environmentService = {
  async list(includeDisabled = true): Promise<EnvironmentDto[]> {
    const rows = includeDisabled
      ? await environmentRepository.listAll()
      : await environmentRepository.listEnabled();
    const refs = await Promise.all(rows.map((r) => dictReferenceRepository.environmentRefs(r.code)));
    return rows.map((r, i) => toEnvDto(r, refs[i].total));
  },

  async references(code: string): Promise<DictReferences> {
    const row = await environmentRepository.findByCode(code);
    if (!row) throw notFound(`环境 ${code} 不存在`);
    const refs = await dictReferenceRepository.environmentRefs(code);
    return { code, label: row.label, kind: 'ENVIRONMENT', total: refs.total, groups: refs.groups };
  },

  async create(input: EnvironmentDictCreateInput, actor: Actor, requestId?: string): Promise<EnvironmentDto> {
    if (await environmentRepository.exists(input.code)) throw conflict(`环境编码 ${input.code} 已存在`);
      const row = await environmentRepository.create({
      code: input.code,
      label: input.label,
      tone: input.tone,
      // 未显式指定时，内置环境用默认色，自定义环境留空（前端按 tone 兜底）
      color: input.color ?? ENVIRONMENT_COLORS[input.code as keyof typeof ENVIRONMENT_COLORS] ?? null,
      description: input.description ?? null,
      enabled: input.enabled,
      builtin: false,
      sortOrder: input.sortOrder,
    });
    invalidateDictCache();
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'CREATE',
      targetType: 'DICT',
      targetId: input.code,
      targetName: `环境 ${input.label}`,
      changes: [{ field: '*', label: '新增环境', from: null, to: input.code }],
      requestId,
    });
    const refs = await dictReferenceRepository.environmentRefs(input.code);
    return toEnvDto(row, refs.total);
  },

  async update(
    code: string,
    input: {
      code?: string;
      label?: string;
      tone?: string;
      color?: string | null;
      description?: string;
      enabled?: boolean;
      sortOrder?: number;
      sync?: boolean;
      syncNames?: boolean;
    },
    actor: Actor,
    requestId?: string,
  ): Promise<{ detail: EnvironmentDto; sync: DictSyncResult | null; pendingNameSync: number; nameSynced: number }> {
    const before = await environmentRepository.findByCode(code);
    if (!before) throw notFound(`环境 ${code} 不存在`);
    const newCode = input.code?.trim() || code;
    const codeChanged = newCode !== code;
    if (codeChanged && (await environmentRepository.exists(newCode))) {
      throw conflict(`环境编码 ${newCode} 已存在`);
    }

    const refs = await dictReferenceRepository.environmentRefs(code);
    if (codeChanged && refs.total > 0 && !input.sync) {
      throw conflict(`环境「${before.label}」已被 ${refs.total} 个对象引用，修改环境编码需要同步更新这些引用`, {
        needSync: true,
        references: { code, label: before.label, kind: 'ENVIRONMENT', total: refs.total, groups: refs.groups },
      });
    }

    let sync: DictSyncResult | null = null;
    if (codeChanged) {
      const resRows = await db
        .update(resources)
        .set({ environment: newCode, updatedAt: new Date() })
        .where(eq(resources.environment, code))
        .returning();
      const envRows = await db
        .update(projectEnvironments)
        .set({ environment: newCode, updatedAt: new Date() })
        .where(eq(projectEnvironments.environment, code))
        .returning();
      sync = {
        code: newCode,
        previousCode: code,
        updated: { resource: resRows.length, templateItem: 0, envSlot: 0, projectEnv: envRows.length },
        attrSynced: 0,
        total: resRows.length + envRows.length,
      };
      await environmentRepository.renameCode(code, newCode);
    }

    await environmentRepository.update(newCode, {
      label: input.label,
      tone: input.tone,
      color: input.color,
      description: input.description,
      enabled: input.enabled,
      sortOrder: input.sortOrder,
    });
    invalidateDictCache();

    const after = await environmentRepository.findByCode(newCode);
    const afterRefs = await dictReferenceRepository.environmentRefs(newCode);

    /**
     * 环境改名后，项目里已有的环境名称可能与字典不一致（字典叫 A、项目里仍显示 B）。
     * 这里统计不一致的项目环境数量，并在 syncNames=true 时一键统一为字典名称
     * （保留原有的「环境」后缀习惯，避免把「生产环境」改成「生产」）。
     */
    const newLabel = after?.label ?? before.label;
    const targetNameFor = (name: string) =>
      name.endsWith('环境') && !newLabel.endsWith('环境') ? `${newLabel}环境` : newLabel;
    const rows = await db.select().from(projectEnvironments).where(eq(projectEnvironments.environment, newCode));
    const mismatched = rows.filter((r) => r.name !== targetNameFor(r.name));
    let pendingNameSync = 0;
    let nameSynced = 0;
    if (input.syncNames) {
      for (const r of mismatched) {
        await db
          .update(projectEnvironments)
          .set({ name: targetNameFor(r.name), updatedAt: new Date() })
          .where(eq(projectEnvironments.id, r.id));
        nameSynced += 1;
      }
    } else {
      pendingNameSync = mismatched.length;
    }
    if (nameSynced > 0) {
      await auditRepository.record({
        actorId: actor.id,
        actorName: actor.username,
        action: 'UPDATE',
        targetType: 'ENVIRONMENT',
        targetId: newCode,
        targetName: `环境「${newLabel}」`,
        changes: [
          {
            field: 'name',
            label: `同步 ${nameSynced} 个项目环境的名称与字典一致`,
            from: mismatched.map((r) => r.name).join('、'),
            to: newLabel,
          },
        ],
        requestId,
      });
    }

    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'UPDATE',
      targetType: 'DICT',
      targetId: newCode,
      targetName: `环境 ${after?.label ?? newCode}`,
      changes: [
        ...(codeChanged ? [{ field: 'code', label: '环境编码', from: code, to: newCode }] : []),
        ...(input.label && input.label !== before.label
          ? [{ field: 'label', label: '环境名称', from: before.label, to: input.label }]
          : []),
      ],
      requestId,
    });
    return { detail: toEnvDto(after!, afterRefs.total), sync, pendingNameSync, nameSynced };
  },

  async remove(code: string, migrateTo: string | undefined, actor: Actor, requestId?: string): Promise<DictSyncResult> {
    const before = await environmentRepository.findByCode(code);
    if (!before) throw notFound(`环境 ${code} 不存在`);
    const refs = await dictReferenceRepository.environmentRefs(code);
    if (refs.total > 0 && !migrateTo) {
      throw conflict(`环境「${before.label}」已被 ${refs.total} 个对象引用，请先选择要迁移到的环境`, {
        needSync: true,
        references: { code, label: before.label, kind: 'ENVIRONMENT', total: refs.total, groups: refs.groups },
      });
    }
    let result: DictSyncResult = {
      code,
      previousCode: null,
      updated: { resource: 0, templateItem: 0, envSlot: 0, projectEnv: 0 },
      attrSynced: 0,
      total: 0,
    };
    if (refs.total > 0 && migrateTo) {
      const target = await environmentRepository.findByCode(migrateTo);
      if (!target) throw notFound(`待迁移的环境 ${migrateTo} 不存在`);
      const resRows = await db
        .update(resources)
        .set({ environment: migrateTo, updatedAt: new Date() })
        .where(eq(resources.environment, code))
        .returning();
      const envRows = await db
        .update(projectEnvironments)
        .set({ environment: migrateTo, updatedAt: new Date() })
        .where(eq(projectEnvironments.environment, code))
        .returning();
      result = {
        code: migrateTo,
        previousCode: code,
        updated: { resource: resRows.length, templateItem: 0, envSlot: 0, projectEnv: envRows.length },
        attrSynced: 0,
        total: resRows.length + envRows.length,
      };
    }
    await environmentRepository.remove(code);
    invalidateDictCache();
    await auditRepository.record({
      actorId: actor.id,
      actorName: actor.username,
      action: 'DELETE',
      targetType: 'DICT',
      targetId: code,
      targetName: `环境 ${before.label}`,
      changes: [{ field: '*', label: '删除环境', from: code, to: migrateTo ?? null }],
      requestId,
    });
    return result;
  },
};

/**
 * 环境显示名：始终按最新环境字典实时解析，改字典后各处标签立即同步。
 * 字典缺失时回退到内置常量，保证历史数据仍可读。
 */
export async function environmentLabelOf(code: string): Promise<string> {
  const row = await environmentRepository.findByCode(code);
  if (row) return row.label;
  return (ENVIRONMENT_LABELS as Record<string, string>)[code] ?? code;
}

/** 供资源模块使用：校验类型 / 环境是否存在且启用 */
export const dictGuard = {
  async assertType(code: string) {
    const meta = await getTypeMeta(code);
    if (!meta.exists) {
      throw validationError(`资源类型 ${code} 不存在，请先到「字典配置」中维护`, { field: 'type', code });
    }
    if (!meta.enabled) {
      throw validationError(`资源类型 ${meta.label} 已停用，请先启用后再使用`, { field: 'type', code });
    }
    return meta;
  },

  async assertEnvironment(code: string) {
    const row = await environmentRepository.findByCode(code);
    if (!row) throw validationError(`环境 ${code} 不存在，请先到「字典配置」中维护`, { field: 'environment', code });
    if (!row.enabled) throw validationError(`环境 ${row.label} 已停用，请先启用后再使用`, { field: 'environment', code });
    return row;
  },
};
