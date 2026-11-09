/**
 * 演示数据：覆盖 ETL / 功能服务器 / 采集交换 / 数据库 / 存储 / GDS 等资源类型，含产品测试、用户测试与开发三种环境。
 * 执行：npm run db:seed
 */
import { config } from '../config/env.js';
import { runMigrations } from '../db/auto-migrate.js';
import { db, withTransaction } from '../db/index.js';
import { envTemplates, projects, resources } from '../db/schema.js';
import { authService } from '../modules/auth/service.js';
import { seedDemoDict } from '../modules/dict/bootstrap.js';
import { projectEnvService, projectService, templateService } from '../modules/projects/service.js';
import { templateRepository } from '../modules/projects/repository.js';
import { resourceRepository } from '../modules/resources/repository.js';
import { resourceService } from '../modules/resources/service.js';

const actor = { id: null, username: '系统初始化' };

const SEEDS: SeedResource[] = [
  {
    type: 'ETL_SERVER',
    name: 'ETL服务器-01',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '张伟',
    tags: ['ETL', '核心'],
    remark: '日批 ETL 主服务器',
    attrs: {
      IP: '10.10.1.11',
      USER_NAME: 'etladmin',
      OS: 'Linux',
    },
  },
  {
    type: 'ETL_SERVER',
    name: 'ETL服务器-02',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳B机房',
    owner: '张伟',
    tags: ['ETL'],
    attrs: {
      IP: '10.10.1.12',
      USER_NAME: 'etladmin',
      OS: 'Linux',
    },
  },
  {
    type: 'ETL_SERVER',
    name: 'ETL服务器-03（UAT）',
    environment: 'UAT',
    status: 'MAINTAINING',
    datacenter: '深圳A机房',
    owner: '李娜',
    tags: ['ETL'],
    remark: '操作系统补丁升级中',
    attrs: {
      IP: '10.11.1.22',
      USER_NAME: 'etladmin',
      OS: 'Linux',
    },
  },
  {
    type: 'FUNCTION_SERVER',
    name: '功能服务器-01',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '王强',
    tags: ['功能'],
    attrs: {
      IP: '10.15.1.31',
      USER_NAME: 'funcadmin',
      OS: 'Linux',
    },
  },
  {
    type: 'DCE',
    name: '采集交换平台-生产',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳B机房',
    owner: '赵敏',
    tags: ['采集', '交换'],
    attrs: {
      WEB_URL: 'http://exchange.dw.internal:9001',
      API_URL: 'http://exchange.dw.internal:9001/api',
      USER_NAME: 'dceadmin',
      TOKEN: 'demo-token',
      API_CHECK_TASKS: 'dce_queryjoblist',
      API_CHECK_TASK: 'dce_runjinfo2',
      API_LOAD_TASK: 'dce_dlsjob',
      API_EXPORT_TASK: 'dce_desjob',
      API_ADD_TOKEN: 'dce_addjob',
    },
  },
  {
    type: 'DCE',
    name: '采集交换平台-UAT',
    environment: 'UAT',
    status: 'IN_USE',
    datacenter: '深圳B机房',
    owner: '赵敏',
    tags: ['采集', '交换'],
    attrs: {
      WEB_URL: 'http://exchange-uat.dw.internal:9001',
      API_URL: 'http://exchange-uat.dw.internal:9001/api',
      USER_NAME: 'dceadmin',
    },
  },
  {
    type: 'DWS_DB',
    name: 'DWS 集群-生产',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '刘洋',
    tags: ['数据库', '核心'],
    attrs: {
      CLUSTER: 'dws-prod',
      IP: '10.50.1.10',
      PORT: '8000',
      DB_NAME: 'dw',
      USER_NAME: 'dwuser',
      WEB_URL: 'https://dws.dw.internal',
    },
    capacityTotal: 1000,
    capacityUnit: '核',
  },
  {
    type: 'DWS_DB',
    name: 'DWS 集群-开发',
    environment: 'DEV',
    status: 'IDLE',
    datacenter: '深圳A机房',
    owner: '刘洋',
    tags: ['数据库'],
    attrs: {
      CLUSTER: 'dws-dev',
      IP: '10.52.1.10',
      PORT: '8000',
      DB_NAME: 'dw_dev',
      USER_NAME: 'dwuser',
    },
    capacityTotal: 200,
    capacityUnit: '核',
  },
  {
    type: 'ORACLE',
    name: 'ORACLE 库-生产',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳B机房',
    owner: '陈涛',
    tags: ['数据库'],
    attrs: {
      IP: '10.60.1.20',
      PORT: '1521',
      DB_NAME: 'ORCL',
      USER_NAME: 'dwuser',
    },
  },
  {
    type: 'NAS',
    name: 'ETL 共享存储-生产',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '陈涛',
    tags: ['存储', '核心'],
    remark: '存放接口文件与临时落地数据',
    attrs: {
      NAS_URL: 'nfs://nas-a.dw.internal/vol/dw_etl',
      USEAGE: 'SOURCE_NAS',
    },
    capacityTotal: 20480,
    capacityUnit: 'GB',
    capacityRemark: '共享存储池，按项目环境分配配额',
  },
  {
    type: 'NAS',
    name: 'ETL 共享存储-风控配额',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '陈涛',
    tags: ['存储', '风控'],
    remark: '从 ETL 共享存储-生产 申请的子资源，供信贷风控数据集市独占使用',
    parentName: 'ETL 共享存储-生产',
    demandAmount: 4096,
    attrs: {
      NAS_URL: 'nfs://nas-a.dw.internal/vol/dw_etl/risk',
      USEAGE: 'SOURCE_NAS',
    },
    capacityUnit: 'GB',
  },
  {
    type: 'NAS',
    name: '归档存储-开发',
    environment: 'DEV',
    status: 'IDLE',
    datacenter: '深圳B机房',
    owner: '陈涛',
    tags: ['归档'],
    attrs: {
      NAS_URL: 'nfs://nas-b.dw.internal/vol/dw_dev',
      USEAGE: 'SOURCE_NAS',
    },
    capacityTotal: 5120,
    capacityUnit: 'GB',
  },
  {
    type: 'GDS_SERVER',
    name: 'GDS 主节点-01',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '刘洋',
    tags: ['GDS', '核心'],
    attrs: {
      IP: '10.40.1.10',
      PORT: '5000',
      USER_NAME: 'edws',
    },
    capacityTotal: 1000,
    capacityUnit: 'GB',
    capacityRemark: 'GDS 主节点可对外分配的连接/配额容量',
  },
  {
    type: 'GDS_SERVER',
    name: 'GDS 采集子节点-01（主节点扩容）',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '刘洋',
    tags: ['GDS', '采集'],
    remark: '作为 GDS 主节点-01 的子资源，共享其服务地址与端口',
    parentName: 'GDS 主节点-01',
    demandAmount: 200,
    attrs: {
      IP: '10.40.1.31',
      PORT: '5000',
      USER_NAME: 'edws',
    },
  },
  {
    type: 'GDS_SERVER',
    name: 'GDS 备节点-02',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳B机房',
    owner: '刘洋',
    tags: ['GDS', '容灾'],
    attrs: {
      IP: '10.40.1.11',
      PORT: '5000',
      USER_NAME: 'edws',
    },
  },
  {
    type: 'IDEAL',
    name: '理想调度平台-生产',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '王强',
    tags: ['调度平台'],
    attrs: {
      WEB_URL: 'https://ideal.dw.internal',
      USER_NAME: 'idealadmin',
    },
  },
];

/* ------------------------------------------------------------------ *
 * 项目环境模板：自由组合各类资源
 * ------------------------------------------------------------------ */

/**
 * 种子资源：先建父资源，再按 parentName 建子资源（子资源继承父资源属性并申请容量）。
 * parentName / demandAmount 仅在本脚本内使用，不进入 create 入参。
 */
type SeedResource = Parameters<typeof resourceService.create>[0] & {
  parentName?: string;
  demandAmount?: number;
};

const TEMPLATES: Parameters<typeof templateService.create>[0][] = [
  {
    name: '标准数仓项目-生产',
    description: '生产标准配置：双 ETL 服务器 + DWS 数据库 + 功能服务器 + 共享存储 + GDS 主备节点',
    items: [
      { resourceType: 'ETL_SERVER', slotRole: 'ETL 服务器', quantity: 2, required: true },
      {
        resourceType: 'DWS_DB',
        slotRole: 'DWS 数据库',
        quantity: 1,
        required: true,
      },
      {
        resourceType: 'FUNCTION_SERVER',
        slotRole: '功能服务器',
        quantity: 1,
        required: true,
      },
      { resourceType: 'NAS', slotRole: 'ETL 共享存储', quantity: 1, required: true },
      { resourceType: 'GDS_SERVER', slotRole: 'GDS 节点', quantity: 2, required: true },
    ],
  },
  {
    name: '轻量项目-开发测试',
    description: '开发/测试最小集：单 ETL 服务器 + 共享存储 + 单 GDS',
    items: [
      { resourceType: 'ETL_SERVER', slotRole: 'ETL 服务器', quantity: 1, required: true },
      { resourceType: 'NAS', slotRole: '开发共享存储', quantity: 1, required: true },
      { resourceType: 'GDS_SERVER', slotRole: 'GDS 节点', quantity: 1, required: false },
    ],
  },
  {
    name: '采集交换专项',
    description: '以采集交换为主的专项：双采集交换平台 + 双 GDS 代理',
    items: [
      {
        resourceType: 'DCE',
        slotRole: '采集交换平台入口',
        quantity: 2,
        required: true,
      },
      { resourceType: 'GDS_SERVER', slotRole: 'GDS 采集代理', quantity: 2, required: true },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 需求项目 + 项目环境
 * ------------------------------------------------------------------ */

const PROJECTS: {
  name: string;
  owner: string;
  description: string;
  envs: {
    name: string;
    // 演示种子只铺非生产环境；生产环境由管理员在字典与项目里按需建立
    environment: 'DEV' | 'PT' | 'UAT';
    template?: string;
    status: 'PLANNING' | 'BUILDING' | 'RUNNING' | 'OFFLINE';
  }[];
}[] = [
  {
    name: '信贷风控数据集市',
    owner: '张伟',
    description: '风控指标与特征集市，覆盖贷前审批与贷后预警',
    envs: [
      { name: '产品测试环境', environment: 'PT', template: '标准数仓项目-生产', status: 'RUNNING' },
      {
        name: '用户测试环境',
        environment: 'UAT',
        template: '轻量项目-开发测试',
        status: 'BUILDING',
      },
      { name: '开发环境', environment: 'DEV', template: '轻量项目-开发测试', status: 'PLANNING' },
    ],
  },
  {
    name: '客户画像平台',
    owner: '李娜',
    description: '客户标签与画像服务，日批处理',
    envs: [
      { name: '产品测试环境', environment: 'PT', template: '标准数仓项目-生产', status: 'RUNNING' },
      { name: '开发环境', environment: 'DEV', template: '轻量项目-开发测试', status: 'BUILDING' },
    ],
  },
  {
    name: '监管报送-1104',
    owner: '赵敏',
    description: '监管报送数据采集与交换',
    envs: [
      { name: '用户测试环境', environment: 'UAT', template: '采集交换专项', status: 'BUILDING' },
    ],
  },
];

/** 演示用：按槽位要求自动挑选同类型、同环境的资源填充（并自动补标项目归属） */
const usedResourceIds = new Set<number>();
let fillSeq = 0;

/** 演示三种占用期限：已超期（需续期/释放）、即将到期、长期不限 */
function demoPeriod(): { startAt: string; endAt: string | null } {
  const now = Date.now();
  const day = 86400000;
  const variant = fillSeq % 3;
  if (variant === 0) {
    return {
      startAt: new Date(now - 120 * day).toISOString(),
      endAt: new Date(now - 18 * day).toISOString(),
    };
  }
  if (variant === 1) {
    return {
      startAt: new Date(now - 60 * day).toISOString(),
      endAt: new Date(now + 5 * day).toISOString(),
    };
  }
  return { startAt: new Date(now - 30 * day).toISOString(), endAt: null };
}

async function autoFill(
  env: {
    id: number;
    projectId: number;
    environment: string;
    slots: { id: number; resourceType: string; resourceId: number | null }[];
  },
  limit: number,
) {
  let filled = 0;
  for (const slot of env.slots) {
    if (slot.resourceId !== null || filled >= limit) continue;
    const candidates = await resourceRepository.listAll({
      type: slot.resourceType as never,
      environment: env.environment as never,
    });
    // 子资源更「具体」，优先分配给项目环境，用来演示父子资源与容量申请
    const pickable = (rows: typeof candidates) =>
      rows.filter(
        (c) =>
          !usedResourceIds.has(c.id) && (c.projectId === null || c.projectId === env.projectId),
      );
    let available = pickable(candidates);
    // 生产环境通常复用已有机房资源：同环境无候选时回退到全量同类型资源（形成跨环境引用）
    if (available.length === 0 && env.environment === 'PRD') {
      available = pickable(await resourceRepository.listAll({ type: slot.resourceType as never }));
    }
    const pick = available.find((c) => c.parentId !== null) ?? available[0];
    if (!pick) continue;
    // 父资源按总量的 10% 申请；子资源按其自身容量的一半申请，演示子资源再分配
    const amount = pick.capacityTotal
      ? Math.max(1, Math.round(pick.capacityTotal * (pick.parentId ? 0.5 : 0.1)))
      : null;
    const period = demoPeriod();
    await projectEnvService.assignSlot(
      env.id,
      slot.id,
      {
        resourceId: pick.id,
        amount,
        acknowledge: true,
        startAt: period.startAt,
        endAt: period.endAt,
      },
      actor,
    );
    usedResourceIds.add(pick.id);
    fillSeq += 1;
    filled += 1;
  }
  return filled;
}

async function seedTemplates(): Promise<void> {
  const existing = await db.select({ id: envTemplates.id }).from(envTemplates).limit(1);
  if (existing.length > 0) return;
  for (const template of TEMPLATES) {
    const created = await templateService.create(template, actor);
    console.log(`[seed] 模板 ${created.code} ${created.name}（${created.slotCount} 个槽位）`);
  }
}

async function seedProjects(): Promise<void> {
  const existing = await db.select({ id: projects.id }).from(projects).limit(1);
  if (existing.length > 0) return;

  const templateRows = await templateRepository.listAll();
  const templateByName = new Map(templateRows.map((t) => [t.name, t.id]));

  for (const spec of PROJECTS) {
    const project = await projectService.create(
      { name: spec.name, owner: spec.owner, description: spec.description },
      actor,
    );
    for (const envSpec of spec.envs) {
      const env = await projectEnvService.create(
        {
          projectId: project.id,
          name: envSpec.name,
          environment: envSpec.environment,
          templateId: envSpec.template ? templateByName.get(envSpec.template) : undefined,
          owner: spec.owner,
          status: envSpec.status,
        },
        actor,
      );
      const filled = await autoFill({ ...env, projectId: project.id }, 6);
      console.log(
        `[seed] 项目 ${project.code} ${project.name} / ${env.name}（模板 ${env.templateName ?? '无'}，已填充 ${filled}/${env.slotTotal}）`,
      );
    }
  }
}

await runMigrations();
await seedDemoDict();
await authService.ensureBootstrapAdmin();

await withTransaction(async () => {
  const existing = await db.select({ id: resources.id }).from(resources).limit(1);
  if (existing.length > 0) {
    console.log('[seed] 已存在资源数据，跳过资源初始化（如需重置请先执行 npm run db:reset）');
  } else {
    // 先建父资源，再按 parentName 建子资源；用 map 记录名称 → id
    const resourceIdByName = new Map<string, number>();
    for (const seed of SEEDS.filter((s) => !s.parentName)) {
      const { parentName: _parentName, demandAmount: _demand, ...payload } = seed;
      const created = await resourceService.create(payload, actor);
      resourceIdByName.set(created.name, created.id);
      console.log(`[seed] ${created.code} ${created.name} (${created.type})`);
    }
    for (const seed of SEEDS.filter((s) => s.parentName)) {
      const parentId = resourceIdByName.get(seed.parentName!);
      if (!parentId) {
        console.warn(`[seed] 跳过子资源 ${seed.name}：父资源 ${seed.parentName} 不存在`);
        continue;
      }
      const { parentName: _parentName, ...payload } = seed;
      const created = await resourceService.create({ ...payload, parentId }, actor);
      resourceIdByName.set(created.name, created.id);
      console.log(
        `[seed]   └ ${created.code} ${created.name} (子资源，向父资源申请 ${seed.demandAmount ?? 0})`,
      );
    }
    console.log(
      `[seed] 完成，共写入 ${SEEDS.length} 条资源；管理员账号 ${config.auth.bootstrapAdmin.username}`,
    );
  }

  await seedTemplates();
  await seedProjects();
});

process.exit(0);
