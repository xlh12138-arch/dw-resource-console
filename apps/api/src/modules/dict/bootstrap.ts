import {
  ATTR_FIELDS,
  ENVIRONMENTS,
  ENVIRONMENT_COLORS,
  ENVIRONMENT_DESCRIPTIONS,
  ENVIRONMENT_LABELS,
  ENVIRONMENT_TONES,
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
  RESOURCE_TYPE_PREFIX,
  TYPE_COLUMNS,
} from '@dw/shared';
import { environmentRepository, resourceTypeFieldRepository, resourceTypeRepository } from './repository.js';
import { invalidateDictCache } from './validator.js';
import { withTransaction } from '../../db/index.js';

/**
 * 内置字典初始化：把代码里内置的五类资源与三种环境写入字典表。
 * 之后它们就与自定义类型一样可在页面上维护；
 * 已存在的条目与已有字段定义不会被覆盖（避免冲掉用户的改动）。
 */

/** 内置类型中参与 IP 占用检测的字段 */
const IP_KEYS: Record<string, string[]> = {
  BATCH_SCHED_SERVER: ['mgmtIp'],
  BATCH_SCHED_PLATFORM_IP: ['ip'],
  COLLECT_EXCHANGE_PLATFORM_IP: ['ip'],
  NAS: [],
  GDS_SERVER: ['ip'],
};

/** 平台地址类资源按 IP+端口判重 */
const IP_UNIQUE_BY_PORT: Record<string, boolean> = {
  BATCH_SCHED_SERVER: false,
  BATCH_SCHED_PLATFORM_IP: true,
  COLLECT_EXCHANGE_PLATFORM_IP: true,
  NAS: false,
  GDS_SERVER: false,
};

const FIELD_DEFAULTS: Record<string, Record<string, string>> = {
  BATCH_SCHED_SERVER: { agentPort: '7020' },
  BATCH_SCHED_PLATFORM_IP: { vip: 'false' },
  COLLECT_EXCHANGE_PLATFORM_IP: { vip: 'false' },
  NAS: { rwMode: 'RW', usedGb: '0' },
  GDS_SERVER: { port: '9042' },
};

const ENV_TONES: Record<string, string> = { ...ENVIRONMENT_TONES };
const ENV_COLORS: Record<string, string> = { ...ENVIRONMENT_COLORS };
const ENV_DESC: Record<string, string> = { ...ENVIRONMENT_DESCRIPTIONS };

function fieldTypeOf(kind: string, isIp: boolean): string {
  if (isIp) return 'IP';
  if (kind === 'select') return 'SELECT';
  if (kind === 'switch') return 'BOOLEAN';
  if (kind === 'number') return 'NUMBER';
  if (kind === 'textarea') return 'TEXTAREA';
  return 'TEXT';
}

export async function ensureBuiltinDict(): Promise<void> {
  let created = 0;
  await withTransaction(async () => {
  for (const [index, code] of RESOURCE_TYPES.entries()) {
    const exists = await resourceTypeRepository.exists(code);
    if (!exists) {
      await resourceTypeRepository.create({
        code,
        label: RESOURCE_TYPE_LABELS[code],
        prefix: RESOURCE_TYPE_PREFIX[code],
        description: null,
        ipUniqueByPort: IP_UNIQUE_BY_PORT[code] ?? false,
        listColumns: TYPE_COLUMNS[code] ?? [],
        enabled: true,
        builtin: true,
        sortOrder: index,
      });
      created += 1;
    }

    const existingFields = await resourceTypeFieldRepository.listByType(code);
    if (existingFields.length === 0) {
      const ipKeys = IP_KEYS[code] ?? [];
      const defaults = FIELD_DEFAULTS[code] ?? {};
      await resourceTypeFieldRepository.replaceAll(
        code,
        (ATTR_FIELDS[code] ?? []).map((f, i) => ({
          typeCode: code,
          key: f.key,
          label: f.label,
          fieldType: fieldTypeOf(f.kind, ipKeys.includes(f.key)),
          required: f.required ?? false,
          options: f.options ?? [],
          defaultValue: defaults[f.key] ?? null,
          placeholder: f.placeholder ?? null,
          unit: f.unit ?? null,
          isIp: ipKeys.includes(f.key),
          sortOrder: i,
        })),
      );
    }
  }

  for (const [index, code] of ENVIRONMENTS.entries()) {
    if (!(await environmentRepository.exists(code))) {
      await environmentRepository.create({
        code,
        label: ENVIRONMENT_LABELS[code as keyof typeof ENVIRONMENT_LABELS],
        tone: ENV_TONES[code] ?? 'gray',
        color: ENV_COLORS[code] ?? null,
        description: ENV_DESC[code] ?? null,
        enabled: true,
        builtin: true,
        sortOrder: index,
      });
      created += 1;
    } else {
      // 历史库里已存在的内置环境：补齐内置标记与缺失的标识色，不覆盖用户已自定义的颜色
      const row = await environmentRepository.findByCode(code);
      if (!row) continue;
      const patch: { builtin?: boolean; color?: string } = {};
      if (!row.builtin) patch.builtin = true;
      if (!row.color && ENV_COLORS[code]) patch.color = ENV_COLORS[code];
      if (Object.keys(patch).length > 0) await environmentRepository.update(code, patch);
    }
  }

  invalidateDictCache();
  });

  if (created > 0) {
    // eslint-disable-next-line no-console
    console.log(`[dict] 内置字典初始化完成，新增 ${created} 条字典项`);
  }
}
