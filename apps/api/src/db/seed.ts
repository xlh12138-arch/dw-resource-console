/**
 * 演示数据：覆盖五类资源，含生产/准生产/开发三种环境。
 * 执行：npm run db:seed
 */
import { config } from '../config/env.js';
import { runMigrations } from '../db/auto-migrate.js';
import { db, withTransaction } from '../db/index.js';
import { envTemplates, projects, resources } from '../db/schema.js';
import { authService } from '../modules/auth/service.js';
import { ensureBuiltinDict } from '../modules/dict/bootstrap.js';
import { projectEnvService, projectService, templateService } from '../modules/projects/service.js';
import { templateRepository } from '../modules/projects/repository.js';
import { resourceRepository } from '../modules/resources/repository.js';
import { resourceService } from '../modules/resources/service.js';

const actor = { id: null, username: '系统初始化' };

const SEEDS: SeedResource[] = [
  {
    type: 'BATCH_SCHED_SERVER',
    name: '调度主节点-01',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '张伟',
    tags: ['核心', '调度'],
    remark: 'Control-M 主调度节点，7x24 值守',
    attrs: {
      hostname: 'dw-sched-master-01',
      mgmtIp: '10.10.1.11',
      osType: 'Linux',
      cpuCores: 16,
      memGb: 64,
      diskGb: 1024,
      agentPort: 7020,
      nodeRole: 'MASTER',
      schedDomain: 'ETL_CORE',
    },
  },
  {
    type: 'BATCH_SCHED_SERVER',
    name: '调度备节点-02',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳B机房',
    owner: '张伟',
    tags: ['核心', '容灾'],
    attrs: {
      hostname: 'dw-sched-standby-02',
      mgmtIp: '10.10.1.12',
      osType: 'Linux',
      cpuCores: 16,
      memGb: 64,
      diskGb: 1024,
      agentPort: 7020,
      nodeRole: 'STANDBY',
      schedDomain: 'ETL_CORE',
    },
  },
  {
    type: 'BATCH_SCHED_SERVER',
    name: 'ETL执行代理-01',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '李娜',
    tags: ['执行代理'],
    attrs: {
      hostname: 'dw-etl-agent-01',
      mgmtIp: '10.10.1.21',
      osType: 'Linux',
      cpuCores: 32,
      memGb: 128,
      diskGb: 2048,
      agentPort: 7020,
      nodeRole: 'AGENT',
      schedDomain: 'ETL_CORE',
    },
  },
  {
    type: 'BATCH_SCHED_SERVER',
    name: 'ETL执行代理-02（UAT）',
    environment: 'UAT',
    status: 'MAINTAINING',
    datacenter: '深圳A机房',
    owner: '李娜',
    tags: ['执行代理'],
    remark: '操作系统补丁升级中',
    attrs: {
      hostname: 'dw-etl-agent-02',
      mgmtIp: '10.11.1.22',
      osType: 'Linux',
      cpuCores: 16,
      memGb: 64,
      diskGb: 1024,
      agentPort: 7020,
      nodeRole: 'AGENT',
      schedDomain: 'ETL_UAT',
    },
  },
  {
    type: 'BATCH_SCHED_PLATFORM_IP',
    name: '批量调度平台-生产接入',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '王强',
    tags: ['平台入口'],
    attrs: {
      ip: '10.20.1.10',
      port: 8443,
      protocol: 'HTTPS',
      platformName: '批量调度平台-生产',
      accessUrl: 'https://sched.dw.internal:8443/console',
      vip: true,
      gateway: '10.20.1.1',
    },
  },
  {
    type: 'BATCH_SCHED_PLATFORM_IP',
    name: '批量调度平台-UAT接入',
    environment: 'UAT',
    status: 'IN_USE',
    datacenter: '深圳A机房',
    owner: '王强',
    attrs: {
      ip: '10.21.1.10',
      port: 8443,
      protocol: 'HTTPS',
      platformName: '批量调度平台-UAT',
      accessUrl: 'https://sched-uat.dw.internal:8443/console',
      vip: false,
      gateway: '10.21.1.1',
    },
  },
  {
    type: 'COLLECT_EXCHANGE_PLATFORM_IP',
    name: '采集交换平台-生产主入口',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳B机房',
    owner: '赵敏',
    tags: ['采集', '交换'],
    attrs: {
      ip: '10.30.1.20',
      port: 9001,
      protocol: 'TCP',
      platformName: '采集交换平台-生产',
      accessUrl: 'http://exchange.dw.internal:9001',
      vip: true,
      gateway: '10.30.1.1',
    },
  },
  {
    type: 'COLLECT_EXCHANGE_PLATFORM_IP',
    name: '采集交换平台-FTP接入',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳B机房',
    owner: '赵敏',
    tags: ['文件采集'],
    attrs: {
      ip: '10.30.1.21',
      port: 21,
      protocol: 'FTP',
      platformName: '采集交换平台-生产',
      vip: false,
      gateway: '10.30.1.1',
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
    remark: '存放接口文件与临时落地数据， retention 30 天',
    attrs: {
      clusterName: 'NAS-CLUSTER-A',
      exportPath: '/vol/dw_etl',
      mountPoint: '/mnt/dw_etl',
      protocol: 'NFS',
      capacityGb: 20480,
      usedGb: 13720,
      rwMode: 'RW',
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
      uploadBatch: 'RISK_DAILY',
      retentionDays: 30,
    },
    capacityUnit: 'GB',
  },
  {
    type: 'NAS',
    name: '归档存储-生产',
    environment: 'PT',
    status: 'IN_USE',
    datacenter: '深圳B机房',
    owner: '陈涛',
    tags: ['归档'],
    attrs: {
      clusterName: 'NAS-CLUSTER-B',
      exportPath: '/vol/dw_archive',
      mountPoint: '/mnt/dw_archive',
      protocol: 'NFS',
      capacityGb: 102400,
      usedGb: 61440,
      rwMode: 'RO',
    },
    capacityTotal: 102400,
    capacityUnit: 'GB',
  },
  {
    type: 'NAS',
    name: '开发测试共享存储',
    environment: 'DEV',
    status: 'IDLE',
    datacenter: '深圳A机房',
    owner: '陈涛',
    attrs: {
      clusterName: 'NAS-CLUSTER-DEV',
      exportPath: '/vol/dw_dev',
      mountPoint: '/mnt/dw_dev',
      protocol: 'CIFS',
      capacityGb: 5120,
      usedGb: 860,
      rwMode: 'RW',
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
      hostname: 'gds-node-01',
      ip: '10.40.1.10',
      port: 9042,
      serviceType: 'GDS_SERVER',
      version: 'v3.2.1',
      nodeRole: 'PRIMARY',
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
      hostname: 'gds-node-01-collect',
      ip: '10.40.1.31',
      port: 9044,
      serviceType: 'GDS_AGENT',
      version: 'v3.2.1',
      nodeRole: 'SECONDARY',
      upstream: 'gds-node-01',
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
      hostname: 'gds-node-02',
      ip: '10.40.1.11',
      port: 9042,
      serviceType: 'GDS_SERVER',
      version: 'v3.2.1',
      nodeRole: 'SECONDARY',
      upstream: 'gds-node-01',
    },
  },
  {
    type: 'GDS_SERVER',
    name: 'GDS 采集代理-01',
    environment: 'PT',
    status: 'RESERVED',
    datacenter: '深圳A机房',
    owner: '刘洋',
    tags: ['GDS', '采集'],
    remark: '新业务接入预留，暂未投产',
    attrs: {
      hostname: 'gds-agent-01',
      ip: '10.40.1.21',
      port: 9043,
      serviceType: 'GDS_AGENT',
      version: 'v3.2.1',
      nodeRole: 'SECONDARY',
      upstream: 'gds-node-01',
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
    description: '生产标准配置：双调度节点 + 调度/采集平台地址 + 共享存储 + GDS 主备节点',
    items: [
      { resourceType: 'BATCH_SCHED_SERVER', slotRole: '调度节点', quantity: 2, required: true },
      { resourceType: 'BATCH_SCHED_PLATFORM_IP', slotRole: '批量调度平台入口', quantity: 1, required: true },
      { resourceType: 'COLLECT_EXCHANGE_PLATFORM_IP', slotRole: '采集交换平台入口', quantity: 1, required: true },
      { resourceType: 'NAS', slotRole: 'ETL 共享存储', quantity: 1, required: true },
      { resourceType: 'GDS_SERVER', slotRole: 'GDS 节点', quantity: 2, required: true },
    ],
  },
  {
    name: '轻量项目-开发测试',
    description: '开发/测试最小集：单调度节点 + 共享存储 + 单 GDS',
    items: [
      { resourceType: 'BATCH_SCHED_SERVER', slotRole: '调度节点', quantity: 1, required: true },
      { resourceType: 'NAS', slotRole: '开发共享存储', quantity: 1, required: true },
      { resourceType: 'GDS_SERVER', slotRole: 'GDS 节点', quantity: 1, required: false },
    ],
  },
  {
    name: '采集交换专项',
    description: '以采集交换为主的专项：双平台地址 + 双 GDS 代理',
    items: [
      { resourceType: 'COLLECT_EXCHANGE_PLATFORM_IP', slotRole: '采集交换入口', quantity: 2, required: true },
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
    environment: 'DEV' | 'PT' | 'UAT' | 'PROD';
    template?: string;
    status: 'PLANNING' | 'BUILDING' | 'RUNNING' | 'OFFLINE';
  }[];
}[] = [
  {
    name: '信贷风控数据集市',
    owner: '张伟',
    description: '风控指标与特征集市，覆盖贷前审批与贷后预警',
    envs: [
      { name: '生产环境', environment: 'PROD', template: '标准数仓项目-生产', status: 'RUNNING' },
      { name: '产品测试环境', environment: 'PT', template: '标准数仓项目-生产', status: 'RUNNING' },
      { name: '用户测试环境', environment: 'UAT', template: '轻量项目-开发测试', status: 'BUILDING' },
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
    envs: [{ name: '用户测试环境', environment: 'UAT', template: '采集交换专项', status: 'BUILDING' }],
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

async function autoFill(env: { id: number; projectId: number; environment: string; slots: { id: number; resourceType: string; resourceId: number | null }[] }, limit: number) {
  let filled = 0;
  for (const slot of env.slots) {
    if (slot.resourceId !== null || filled >= limit) continue;
    const candidates = await resourceRepository.listAll({
      type: slot.resourceType as never,
      environment: env.environment as never,
    });
    // 子资源更「具体」，优先分配给项目环境，用来演示父子资源与容量申请
    const pickable = (rows: typeof candidates) =>
      rows.filter((c) => !usedResourceIds.has(c.id) && (c.projectId === null || c.projectId === env.projectId));
    let available = pickable(candidates);
    // 生产环境通常复用已有机房资源：同环境无候选时回退到全量同类型资源（形成跨环境引用）
    if (available.length === 0 && env.environment === 'PROD') {
      available = pickable(await resourceRepository.listAll({ type: slot.resourceType as never }));
    }
    const pick = available.find((c) => c.parentId !== null) ?? available[0];
    if (!pick) continue;
    // 父资源按总量的 10% 申请；子资源按其自身容量的一半申请，演示子资源再分配
    const amount = pick.capacityTotal
      ? Math.max(1, Math.round(pick.capacityTotal * (pick.parentId ? 0.5 : 0.1)))
      : null;
    const period = demoPeriod();
    await projectEnvService.assignSlot(env.id, slot.id, {
      resourceId: pick.id,
      amount,
      acknowledge: true,
      startAt: period.startAt,
      endAt: period.endAt,
    }, actor);
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
    // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
      console.log(
        `[seed] 项目 ${project.code} ${project.name} / ${env.name}（模板 ${env.templateName ?? '无'}，已填充 ${filled}/${env.slotTotal}）`,
      );
    }
  }
}

await runMigrations();
await ensureBuiltinDict();
await authService.ensureBootstrapAdmin();

await withTransaction(async () => {
  const existing = await db.select({ id: resources.id }).from(resources).limit(1);
  if (existing.length > 0) {
    // eslint-disable-next-line no-console
    console.log('[seed] 已存在资源数据，跳过资源初始化（如需重置请先执行 npm run db:reset）');
  } else {
    // 先建父资源，再按 parentName 建子资源；用 map 记录名称 → id
    const resourceIdByName = new Map<string, number>();
    for (const seed of SEEDS.filter((s) => !s.parentName)) {
      const { parentName: _parentName, demandAmount: _demand, ...payload } = seed;
      const created = await resourceService.create(payload, actor);
      resourceIdByName.set(created.name, created.id);
      // eslint-disable-next-line no-console
      console.log(`[seed] ${created.code} ${created.name} (${created.type})`);
    }
    for (const seed of SEEDS.filter((s) => s.parentName)) {
      const parentId = resourceIdByName.get(seed.parentName!);
      if (!parentId) {
        // eslint-disable-next-line no-console
        console.warn(`[seed] 跳过子资源 ${seed.name}：父资源 ${seed.parentName} 不存在`);
        continue;
      }
      const { parentName: _parentName, ...payload } = seed;
      const created = await resourceService.create({ ...payload, parentId }, actor);
      resourceIdByName.set(created.name, created.id);
      // eslint-disable-next-line no-console
      console.log(
        `[seed]   └ ${created.code} ${created.name} (子资源，向父资源申请 ${seed.demandAmount ?? 0})`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[seed] 完成，共写入 ${SEEDS.length} 条资源；管理员账号 ${config.auth.bootstrapAdmin.username}`);
  }

  await seedTemplates();
  await seedProjects();
});

process.exit(0);
