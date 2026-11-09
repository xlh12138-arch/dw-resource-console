import {
  ENVIRONMENTS,
  ENVIRONMENT_COLORS,
  ENVIRONMENT_DESCRIPTIONS,
  ENVIRONMENT_LABELS,
  ENVIRONMENT_TONES,
  PRODUCTION_ENVIRONMENTS,
} from '@dw/shared';
import {
  environmentRepository,
  resourceTypeFieldRepository,
  resourceTypeRepository,
} from './repository.js';
import { invalidateDictCache } from './validator.js';
import { withTransaction } from '../../db/index.js';

/**
 * 演示数据字典初始化：仅供 `db:seed` 创建本地演示数据时使用。
 * 正常启动不会调用，也不会再把任何字典标记为内置。
 *
 * 内容与生产库（PG public schema）资源类型字典保持一致，差异时以生产库为准。
 */

/** 资源类型：编码、名称、编码前缀、是否按 IP+端口判重、列表展示列 */
export const DEMO_TYPES: {
  code: string;
  label: string;
  prefix: string;
  ipUniqueByPort: boolean;
  listColumns: string[];
}[] = [
  {
    code: 'ETL_SERVER',
    label: 'ETL服务器',
    prefix: 'ETL',
    ipUniqueByPort: true,
    listColumns: ['IP'],
  },
  {
    code: 'ORACLE',
    label: 'ORACLE数据库',
    prefix: 'ORACLE',
    ipUniqueByPort: false,
    listColumns: [],
  },
  { code: 'DWS_DB', label: 'DWS数据库', prefix: 'DWS', ipUniqueByPort: false, listColumns: [] },
  { code: 'ARGODB', label: 'ARGO数据库', prefix: 'ARGODB', ipUniqueByPort: false, listColumns: [] },
  { code: 'MRS', label: 'MRS', prefix: 'MRS', ipUniqueByPort: false, listColumns: [] },
  {
    code: 'DCE',
    label: '采集交换平台',
    prefix: 'DCE',
    ipUniqueByPort: false,
    listColumns: ['WEB_URL'],
  },
  { code: 'IDEAL', label: '理想调度平台', prefix: 'IDEAL', ipUniqueByPort: false, listColumns: [] },
  { code: 'DSSP', label: '源启调度平台', prefix: 'DSSP', ipUniqueByPort: false, listColumns: [] },
  { code: 'NAS', label: 'NAS', prefix: 'NAS', ipUniqueByPort: false, listColumns: ['USEAGE'] },
  {
    code: 'GDS_SERVER',
    label: 'GDS服务器',
    prefix: 'GDS',
    ipUniqueByPort: false,
    listColumns: ['IP'],
  },
  {
    code: 'FUNCTION_SERVER',
    label: '功能服务器',
    prefix: 'FUNCTION',
    ipUniqueByPort: false,
    listColumns: ['IP'],
  },
];

/** 资源类型字段：key、名称、字段类型、是否必填、选项、默认值 */
export const DEMO_FIELDS: Record<
  string,
  {
    key: string;
    label: string;
    fieldType: string;
    required: boolean;
    options?: { value: string; label: string }[];
    defaultValue?: string;
  }[]
> = {
  ETL_SERVER: [
    { key: 'IP', label: 'IP地址', fieldType: 'IP', required: true },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: true },
    { key: 'OS', label: '操作系统', fieldType: 'TEXT', required: true },
  ],
  ORACLE: [
    { key: 'IP', label: 'IP地址', fieldType: 'IP', required: true },
    { key: 'PORT', label: '端口', fieldType: 'PORT', required: true },
    { key: 'DB_NAME', label: '数据库名', fieldType: 'TEXT', required: true },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: true },
  ],
  DWS_DB: [
    { key: 'CLUSTER', label: '集群', fieldType: 'TEXT', required: true },
    { key: 'IP', label: 'IP地址', fieldType: 'IP', required: true },
    { key: 'PORT', label: '端口', fieldType: 'PORT', required: true },
    { key: 'DB_NAME', label: '数据库名', fieldType: 'TEXT', required: false },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: false },
    { key: 'WEB_URL', label: '前端地址', fieldType: 'TEXT', required: false },
  ],
  ARGODB: [
    { key: 'IP', label: 'IP地址', fieldType: 'IP', required: true },
    { key: 'PORT', label: '端口', fieldType: 'PORT', required: true },
    { key: 'DB_NAME', label: '数据库名', fieldType: 'TEXT', required: false },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: false },
    { key: 'WEB_URL', label: '前端地址', fieldType: 'TEXT', required: false },
  ],
  MRS: [
    { key: 'CLUSTER', label: '集群', fieldType: 'TEXT', required: true },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: true },
    { key: 'WEB_URL', label: '前端地址', fieldType: 'TEXT', required: false },
  ],
  DCE: [
    { key: 'WEB_URL', label: '前端地址', fieldType: 'TEXT', required: true },
    { key: 'API_URL', label: 'API链接', fieldType: 'TEXT', required: true },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: false },
    { key: 'TOKEN', label: 'TOKEN', fieldType: 'TEXT', required: false },
    {
      key: 'API_CHECK_TASKS',
      label: 'API_检查多任务',
      fieldType: 'TEXT',
      required: false,
      defaultValue: 'dce_queryjoblist',
    },
    {
      key: 'API_CHECK_TASK',
      label: 'API_检查单任务',
      fieldType: 'TEXT',
      required: false,
      defaultValue: 'dce_runjinfo2',
    },
    {
      key: 'API_LOAD_TASK',
      label: 'API_启动装数任务',
      fieldType: 'TEXT',
      required: false,
      defaultValue: 'dce_dlsjob',
    },
    {
      key: 'API_EXPORT_TASK',
      label: 'API_启动卸数任务',
      fieldType: 'TEXT',
      required: false,
      defaultValue: 'dce_desjob',
    },
    {
      key: 'API_ADD_TOKEN',
      label: 'API_增加令牌',
      fieldType: 'TEXT',
      required: false,
      defaultValue: 'dce_addjob',
    },
  ],
  IDEAL: [
    { key: 'WEB_URL', label: '前端地址', fieldType: 'TEXT', required: true },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: false },
  ],
  DSSP: [
    { key: 'WEB_URL', label: '前端地址', fieldType: 'TEXT', required: true },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: false },
  ],
  NAS: [
    { key: 'NAS_URL', label: 'NAS地址', fieldType: 'TEXT', required: true },
    {
      key: 'USEAGE',
      label: '用途',
      fieldType: 'TEXT',
      required: true,
      options: [{ value: 'SOURCE_NAS', label: '上游NAS' }],
    },
  ],
  GDS_SERVER: [
    { key: 'IP', label: 'IP地址', fieldType: 'IP', required: true },
    { key: 'PORT', label: '端口', fieldType: 'PORT', required: true, defaultValue: '5000' },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: true, defaultValue: 'edws' },
  ],
  FUNCTION_SERVER: [
    { key: 'IP', label: 'IP地址', fieldType: 'IP', required: true },
    { key: 'USER_NAME', label: '用户名', fieldType: 'TEXT', required: true },
    { key: 'OS', label: '操作系统', fieldType: 'TEXT', required: true },
  ],
};

const ENV_TONES: Record<string, string> = { ...ENVIRONMENT_TONES };
const ENV_COLORS: Record<string, string> = { ...ENVIRONMENT_COLORS };
const ENV_DESC: Record<string, string> = { ...ENVIRONMENT_DESCRIPTIONS };

export async function seedDemoDict(): Promise<void> {
  let created = 0;
  await withTransaction(async () => {
    for (const [index, type] of DEMO_TYPES.entries()) {
      const exists = await resourceTypeRepository.exists(type.code);
      if (!exists) {
        await resourceTypeRepository.create({
          code: type.code,
          label: type.label,
          prefix: type.prefix,
          description: null,
          ipUniqueByPort: type.ipUniqueByPort,
          listColumns: type.listColumns,
          enabled: true,
          builtin: false,
          sortOrder: index + 1,
        });
        created += 1;
      }

      const existingFields = await resourceTypeFieldRepository.listByType(type.code);
      if (existingFields.length === 0) {
        await resourceTypeFieldRepository.replaceAll(
          type.code,
          (DEMO_FIELDS[type.code] ?? []).map((f, i) => ({
            typeCode: type.code,
            key: f.key,
            label: f.label,
            fieldType: f.fieldType,
            required: f.required,
            options: f.options ?? [],
            defaultValue: f.defaultValue ?? null,
            placeholder: null,
            unit: null,
            isIp: false,
            sortOrder: i + 1,
          })),
        );
      }
    }

    // 只初始化演示用的非生产环境：生产环境（PRD）由管理员在字典里自行维护，
    // 种子数据不再自动创建，避免演示库凭空出现生产环境。
    for (const code of ENVIRONMENTS.filter((c) => !PRODUCTION_ENVIRONMENTS.includes(c))) {
      if (!(await environmentRepository.exists(code))) {
        await environmentRepository.create({
          code,
          label: ENVIRONMENT_LABELS[code as keyof typeof ENVIRONMENT_LABELS],
          tone: ENV_TONES[code] ?? 'gray',
          color: ENV_COLORS[code] ?? null,
          description: ENV_DESC[code] ?? null,
          enabled: true,
          builtin: false,
          // 用全量枚举的下标，跳过生产环境也不会打乱其余环境的排序
          sortOrder: ENVIRONMENTS.indexOf(code) + 1,
        });
        created += 1;
      } else {
        // 历史环境只补齐缺失的标识色，不覆盖用户已自定义的值。
        const row = await environmentRepository.findByCode(code);
        if (!row) continue;
        const patch: { color?: string } = {};
        if (!row.color && ENV_COLORS[code]) patch.color = ENV_COLORS[code];
        if (Object.keys(patch).length > 0) await environmentRepository.update(code, patch);
      }
    }

    invalidateDictCache();
  });

  if (created > 0) {
    console.log(`[dict] 演示字典初始化完成，新增 ${created} 条字典项`);
  }
}
