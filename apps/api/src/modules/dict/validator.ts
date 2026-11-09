import { RESOURCE_ATTRS_SCHEMAS, ipv4, port, type AttrFieldDef } from '@dw/shared';
import { z } from 'zod';
import type { ResourceTypeFieldRow } from '../../db/schema.js';
import { resourceTypeFieldRepository, resourceTypeRepository } from './repository.js';

/**
 * 动态属性校验：
 * 资源类型与它的字段定义都可以在页面上维护，因此 attrs 的 Zod schema
 * 必须由字段定义实时编译，而不是写死在代码里。编译结果按类型缓存，
 * 字典发生任何变更时调用 invalidateDictCache() 失效。
 */

export interface RuntimeField {
  key: string;
  label: string;
  fieldType: string;
  required: boolean;
  options: { value: string; label: string }[];
  defaultValue: string | null;
  placeholder: string | null;
  unit: string | null;
  isIp: boolean;
  sortOrder: number;
}

export interface TypeMeta {
  code: string;
  label: string;
  prefix: string;
  exists: boolean;
  enabled: boolean;
  ipUniqueByPort: boolean;
  listColumns: string[];
  fields: RuntimeField[];
  /** 参与 IP 占用检测的字段 key */
  ipFields: string[];
  schema: z.ZodType<Record<string, unknown>>;
}

const cache = new Map<string, TypeMeta>();

export function invalidateDictCache(code?: string): void {
  if (code) cache.delete(code);
  else cache.clear();
}

export function toRuntimeField(row: ResourceTypeFieldRow): RuntimeField {
  return {
    key: row.key,
    label: row.label,
    fieldType: row.fieldType,
    required: row.required,
    options: row.options ?? [],
    defaultValue: row.defaultValue ?? null,
    placeholder: row.placeholder ?? null,
    unit: row.unit ?? null,
    isIp: row.isIp,
    sortOrder: row.sortOrder,
  };
}

/** 单个字段 → Zod 校验器 */
function fieldSchema(field: RuntimeField): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (field.fieldType) {
    case 'NUMBER':
      base = z.coerce.number({ message: `${field.label} 必须是数字` });
      break;
    case 'INTEGER':
      base = z.coerce
        .number({ message: `${field.label} 必须是整数` })
        .int(`${field.label} 必须是整数`);
      break;
    case 'PORT':
      base = port;
      break;
    case 'IP':
      base = ipv4;
      break;
    case 'BOOLEAN':
      base = z
        .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
        .transform((v) => (typeof v === 'boolean' ? v : ['true', '1', 'yes'].includes(v)));
      break;
    case 'SELECT': {
      const values = field.options.map((o) => o.value);
      base = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string().trim().min(1);
      break;
    }
    case 'TEXTAREA':
      base = z.string().trim().max(500);
      break;
    default:
      base = z.string().trim().max(64);
  }

  if (field.required) {
    // 必填：key 缺失时 object 会直接报 required；文本类另加非空校验
    if (field.fieldType === 'TEXT') return z.string().trim().min(1).max(64);
    if (field.fieldType === 'TEXTAREA') return z.string().trim().min(1).max(500);
    return base;
  }
  // 选填：允许空串 / null / 缺省
  return z.union([base, z.literal(''), z.null(), z.undefined()]).optional();
}

export function buildAttrsSchema(fields: RuntimeField[]): z.ZodType<Record<string, unknown>> {
  if (fields.length === 0)
    return z.record(z.string(), z.unknown()) as z.ZodType<Record<string, unknown>>;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) shape[f.key] = fieldSchema(f);
  // 允许携带未知字段（历史数据 / 导入冗余列），已知字段仍强校验
  return z.object(shape).catchall(z.unknown()) as unknown as z.ZodType<Record<string, unknown>>;
}

/** 取得类型的运行时元信息（字段定义 + 编译后的校验器） */
export async function getTypeMeta(code: string): Promise<TypeMeta> {
  const cached = cache.get(code);
  if (cached) return cached;

  const row = await resourceTypeRepository.findByCode(code);
  const fieldRows = row ? await resourceTypeFieldRepository.listByType(code) : [];
  const fields = fieldRows.map(toRuntimeField);

  let schema: z.ZodType<Record<string, unknown>>;
  if (fields.length > 0) {
    schema = buildAttrsSchema(fields);
  } else if (code in RESOURCE_ATTRS_SCHEMAS) {
    // 兜底：字典尚未初始化时使用内置静态 schema
    schema = RESOURCE_ATTRS_SCHEMAS[
      code as keyof typeof RESOURCE_ATTRS_SCHEMAS
    ] as unknown as z.ZodType<Record<string, unknown>>;
  } else {
    schema = z.record(z.string(), z.unknown()) as z.ZodType<Record<string, unknown>>;
  }

  const meta: TypeMeta = {
    code,
    label: row?.label ?? code,
    prefix: row?.prefix ?? code.slice(0, 4).toUpperCase(),
    exists: row !== undefined,
    enabled: row?.enabled ?? true,
    ipUniqueByPort: row?.ipUniqueByPort ?? false,
    listColumns: row?.listColumns ?? [],
    fields,
    ipFields: fields.filter((f) => f.isIp).map((f) => f.key),
    schema,
  };
  cache.set(code, meta);
  return meta;
}

/** 动态字段 → 前端动态表单定义 */
export function toAttrFieldDefs(fields: RuntimeField[]): AttrFieldDef[] {
  const kindOf = (t: string): AttrFieldDef['kind'] => {
    if (t === 'SELECT') return 'select';
    if (t === 'BOOLEAN') return 'switch';
    if (t === 'NUMBER' || t === 'INTEGER' || t === 'PORT') return 'number';
    if (t === 'TEXTAREA') return 'textarea';
    return 'text';
  };
  return fields.map((f) => ({
    key: f.key,
    label: f.label,
    kind: kindOf(f.fieldType),
    required: f.required,
    defaultValue: f.defaultValue ?? undefined,
    placeholder: f.placeholder ?? undefined,
    unit: f.unit ?? undefined,
    options: f.options.length > 0 ? f.options : undefined,
  }));
}

/** 按字段定义把 attrs 规范化（缺失补默认值、已删字段可清理、key 可重命名） */
export function normalizeAttrs(
  attrs: Record<string, unknown>,
  fields: RuntimeField[],
  opts: { keyRenames?: { from: string; to: string }[]; dropUnknown?: boolean } = {},
): { value: Record<string, unknown>; changed: boolean } {
  const value: Record<string, unknown> = {};
  const renames = new Map((opts.keyRenames ?? []).map((r) => [r.from, r.to]));
  const source: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const key = renames.get(k) ?? k;
    source[key] = v;
  }

  const known = new Set(fields.map((f) => f.key));
  for (const [k, v] of Object.entries(source)) {
    if (opts.dropUnknown && !known.has(k)) continue;
    value[k] = v;
  }
  for (const f of fields) {
    if (value[f.key] === undefined && f.defaultValue !== null && f.defaultValue !== '') {
      value[f.key] =
        f.fieldType === 'NUMBER' || f.fieldType === 'INTEGER' || f.fieldType === 'PORT'
          ? Number(f.defaultValue)
          : f.fieldType === 'BOOLEAN'
            ? ['true', '1', 'yes'].includes(f.defaultValue)
            : f.defaultValue;
    }
  }

  const changed = JSON.stringify(value) !== JSON.stringify(attrs);
  return { value, changed };
}
