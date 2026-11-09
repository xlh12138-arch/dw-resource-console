/**
 * 项目 / 项目环境 / 环境模板 冒烟测试（需先启动 API）
 * 用法：node scripts/smoke-project.mjs
 */
import { ADMIN_USERNAME, BASE, adminPassword } from './lib/smoke-env.mjs';

const ADMIN_PASSWORD = adminPassword('smoke-project');
let passed = 0;
let failed = 0;

function check(name, ok, extra = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

const login = async (username, password) =>
  req('/auth/login', { method: 'POST', body: { username, password } });

console.log('[1] 登录');
const admin = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
check('管理员登录成功', admin.status === 200, JSON.stringify(admin.json));
const A = admin.json.accessToken;

console.log('\n[2] 环境模板');
const templates = await req('/env-templates', { token: A });
check(
  '模板列表返回 3 个',
  templates.status === 200 && templates.json.items.length === 3,
  JSON.stringify(templates.json?.meta),
);
const tpl = templates.json.items.find((t) => t.name === '标准数仓项目-生产');
check('标准模板含 7 个槽位', tpl?.slotCount === 7, `slotCount=${tpl?.slotCount}`);

const newTpl = await req('/env-templates', {
  method: 'POST',
  token: A,
  body: {
    name: `冒烟模板-${Date.now().toString(36)}`,
    description: '冒烟测试用',
    items: [
      { resourceType: 'NAS', slotRole: '归档存储', quantity: 2, required: true },
      { resourceType: 'GDS_SERVER', slotRole: 'GDS 代理', quantity: 1, required: false },
    ],
  },
});
check(
  '创建模板成功且 3 个槽位',
  newTpl.status === 201 && newTpl.json.slotCount === 3,
  JSON.stringify(newTpl.json),
);
const tplId = newTpl.json.id;

const updatedTpl = await req(`/env-templates/${tplId}`, {
  method: 'PATCH',
  token: A,
  body: {
    items: [
      { resourceType: 'BATCH_SCHED_SERVER', slotRole: '调度节点', quantity: 3, required: true },
    ],
  },
});
check(
  '更新模板组合生效',
  updatedTpl.status === 200 &&
    updatedTpl.json.slotCount === 3 &&
    updatedTpl.json.items[0].resourceType === 'BATCH_SCHED_SERVER',
);

const cloned = await req(`/env-templates/${tplId}/clone`, { method: 'POST', token: A });
check('克隆模板成功', cloned.status === 201 && cloned.json.id !== tplId);

console.log('\n[3] 项目与环境');
const projects = await req('/projects', { token: A });
check(
  '项目列表返回 3 个项目',
  projects.status === 200 && projects.json.items.length === 3,
  JSON.stringify(projects.json?.meta),
);
const prj = projects.json.items.find((p) => p.name === '信贷风控数据集市');
check(
  '项目统计含环境数（演示种子 3 套非生产环境）',
  prj?.envCount === 3,
  `envCount=${prj?.envCount}`,
);
check('项目统计含资源数', prj?.resourceCount > 0, `resourceCount=${prj?.resourceCount}`);

const newPrj = await req('/projects', {
  method: 'POST',
  token: A,
  body: { name: `冒烟项目-${Date.now().toString(36)}`, owner: '测试', description: '冒烟' },
});
check(
  '创建项目成功',
  newPrj.status === 201 && /^PRJ-\d{4}$/.test(newPrj.json.code),
  JSON.stringify(newPrj.json),
);
const prjId = newPrj.json.id;

const envCreated = await req(`/projects/${prjId}/environments`, {
  method: 'POST',
  token: A,
  body: {
    name: '产品测试环境',
    environment: 'PT',
    templateId: tplId,
    owner: '测试',
    status: 'BUILDING',
  },
});
check(
  '套用模板创建环境成功',
  envCreated.status === 201 && envCreated.json.slotTotal === 3,
  `slotTotal=${envCreated.json?.slotTotal}`,
);
check(
  '环境记录了模板名称',
  envCreated.json.templateName?.includes('冒烟模板'),
  envCreated.json.templateName,
);
const envId = envCreated.json.id;

const dupEnv = await req(`/projects/${prjId}/environments`, {
  method: 'POST',
  token: A,
  body: { name: '产品测试环境', environment: 'UAT' },
});
check('同名环境冲突返回 409', dupEnv.status === 409, `status=${dupEnv.status}`);

const envDetail = await req(`/project-environments/${envId}`, { token: A });
check('环境详情含 3 个槽位', envDetail.status === 200 && envDetail.json.slots.length === 3);
const slot = envDetail.json.slots[0];

console.log('\n[4] 槽位分配资源');
const resList = await req('/resources?type=BATCH_SCHED_SERVER&environment=PT&pageSize=10', {
  token: A,
});
check(
  '存在可用于绑定的 PT 调度服务器',
  resList.json.items.length > 0,
  `count=${resList.json.items.length}`,
);
const candidate =
  resList.json.items.find((r) => !envDetail.json.slots.some((s) => s.resourceId === r.id)) ??
  resList.json.items[0];
// 资源可能已被其他项目引用 / 属于其他环境，绑定需带上容量申请并确认提示
const assign = await req(`/project-environments/${envId}/slots/${slot.id}/assign`, {
  method: 'POST',
  token: A,
  body: {
    resourceId: candidate.id,
    amount: candidate.capacityTotal ? 10 : null,
    acknowledge: true,
  },
});
check(
  '槽位绑定资源成功',
  assign.status === 200 && assign.json.slot.resourceId === candidate.id,
  JSON.stringify(assign.json),
);
check('绑定后资源自动标注项目', assign.json.env.projectName !== undefined);

const nasList = await req('/resources?type=NAS&environment=PT&pageSize=1', { token: A });
const wrongType = await req(
  `/project-environments/${envId}/slots/${envDetail.json.slots[1].id}/assign`,
  {
    method: 'POST',
    token: A,
    body: { resourceId: nasList.json.items[0].id, acknowledge: true },
  },
);
check('类型不匹配返回 422', wrongType.status === 422, `status=${wrongType.status}`);

const unassign = await req(`/project-environments/${envId}/slots/${slot.id}/assign`, {
  method: 'DELETE',
  token: A,
});
check('槽位解绑成功', unassign.status === 200 && unassign.json.slot.resourceId === null);

const applyTpl = await req(`/project-environments/${envId}/apply-template`, {
  method: 'POST',
  token: A,
  body: { templateId: tpl.id },
});
check(
  '追加套用模板后槽位增加',
  applyTpl.status === 200 && applyTpl.json.slotTotal === 10,
  `slotTotal=${applyTpl.json?.slotTotal}`,
);

console.log('\n[5] 按项目查看资源');
// 重新绑定槽位，验证「槽位绑定即纳入该项目」
const rebind = await req(`/project-environments/${envId}/slots/${slot.id}/assign`, {
  method: 'POST',
  token: A,
  body: {
    resourceId: candidate.id,
    amount: candidate.capacityTotal ? 10 : null,
    acknowledge: true,
  },
});
check('重新绑定槽位成功', rebind.status === 200, `status=${rebind.status}`);
const byProject = await req(`/resources?projectId=${prjId}`, { token: A });
check(
  '按项目筛选资源可用',
  byProject.status === 200 && byProject.json.meta.total >= 1,
  `total=${byProject.json?.meta?.total}`,
);
const byEnv = await req(`/resources?projectEnvId=${envId}`, { token: A });
check('按项目环境筛选可用', byEnv.status === 200, `status=${byEnv.status}`);
const unassigned = await req('/resources?unassigned=true', { token: A });
check(
  '未标注项目筛选可用',
  unassigned.status === 200 && unassigned.json.items.every((r) => r.projectId === null),
);

console.log('\n[6] 资源批量标注');
const ids = unassigned.json.items.slice(0, 3).map((r) => r.id);
if (ids.length > 0) {
  const bulk = await req('/resources/bulk-assign', {
    method: 'POST',
    token: A,
    body: { ids, projectId: prjId },
  });
  check(
    '批量标注成功',
    bulk.status === 200 && bulk.json.updated === ids.length,
    JSON.stringify(bulk.json),
  );
  const after = await req(`/resources?projectId=${prjId}`, { token: A });
  check(
    '标注后项目资源数增加',
    after.json.meta.total >= ids.length,
    `total=${after.json.meta.total}`,
  );
} else {
  check('批量标注（无未标注资源，跳过）', true);
}

console.log('\n[7] 资源表单标注项目');
const created = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: 'GDS_SERVER',
    name: `冒烟-GDS-${Date.now().toString(36)}`,
    environment: 'DEV',
    projectId: prjId,
    attrs: {
      hostname: 'gds-smoke-01',
      ip: '10.77.9.99',
      port: 9042,
      serviceType: 'GDS_AGENT',
      nodeRole: 'SECONDARY',
    },
  },
});
check(
  '创建资源时可直接指定项目',
  created.status === 201 && created.json.projectId === prjId,
  JSON.stringify(created.json),
);
check(
  '资源 DTO 返回项目名称',
  created.json.projectName !== undefined && created.json.projectName !== null,
);

const badProject = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: 'GDS_SERVER',
    name: `冒烟-错误项目-${Date.now().toString(36)}`,
    environment: 'DEV',
    projectId: 999999,
    attrs: {
      hostname: 'gds-smoke-02',
      ip: '10.77.9.98',
      port: 9042,
      serviceType: 'GDS_AGENT',
      nodeRole: 'SECONDARY',
    },
  },
});
check('不存在的项目返回 404', badProject.status === 404, `status=${badProject.status}`);

console.log('\n[8] 统计与审计');
const stats = await req('/stats/overview', { token: A });
check('概览含项目维度统计', Array.isArray(stats.json.byProject) && stats.json.byProject.length > 0);
check(
  '概览含项目汇总',
  stats.json.projectSummary?.projectCount >= 3,
  JSON.stringify(stats.json.projectSummary),
);
const audit = await req('/audit-logs?targetType=ENVIRONMENT&pageSize=5', { token: A });
check(
  '环境变更写入审计',
  audit.status === 200 && audit.json.items.length > 0,
  `count=${audit.json.items.length}`,
);

console.log('\n[9] 删除保护与清理');
const delTplUsed = await req(`/env-templates/${tpl.id}`, { method: 'DELETE', token: A });
check('被引用的模板禁止删除（409）', delTplUsed.status === 409, `status=${delTplUsed.status}`);
const delPrj = await req(`/projects/${prjId}`, { method: 'DELETE', token: A });
check('有环境的项目禁止删除（409）', delPrj.status === 409, `status=${delPrj.status}`);

await req(`/project-environments/${envId}`, { method: 'DELETE', token: A });
check('删除环境成功', (await req(`/project-environments/${envId}`, { token: A })).status === 404);
const delPrj2 = await req(`/projects/${prjId}`, { method: 'DELETE', token: A });
check('环境清空后项目可删除', delPrj2.status === 200, `status=${delPrj2.status}`);
await req(`/env-templates/${cloned.json.id}`, { method: 'DELETE', token: A });
const delTplOk = await req(`/env-templates/${tplId}`, { method: 'DELETE', token: A });
check('未被引用的模板可删除', delTplOk.status === 200, `status=${delTplOk.status}`);
if (created.status === 201)
  await req(`/resources/${created.json.id}`, { method: 'DELETE', token: A });

console.log('\n[10] 权限（管理员 / 普通用户 / 只读用户）');
const normalName = `smoke_user_${Date.now().toString(36)}`;
const normalPwd = `Smoke#${Date.now().toString(36)}`;
const v = await req('/users', {
  method: 'POST',
  token: A,
  body: { username: normalName, password: normalPwd, displayName: '普通用户', role: 'USER' },
});
const V = (await login(normalName, normalPwd)).json.accessToken;
check('普通用户可查看项目', (await req('/projects', { token: V })).status === 200);
const normalCreate = await req('/projects', {
  method: 'POST',
  token: V,
  body: {
    name: `冒烟普通用户项目-${Date.now().toString(36)}`,
    owner: '冒烟',
    description: '权限校验',
  },
});
check('普通用户可创建项目', normalCreate.status === 201, normalCreate.text);
check(
  '普通用户可删除项目（与管理员一致）',
  (await req(`/projects/${normalCreate.json.id ?? 0}`, { method: 'DELETE', token: V })).status ===
    200,
);
check('普通用户访问用户管理被拒（403）', (await req('/users', { token: V })).status === 403);
check(
  '普通用户访问变更审计被拒（403）',
  (await req('/audit-logs?pageSize=1', { token: V })).status === 403,
);

const roName = `smoke_ro_${Date.now().toString(36)}`;
const roPwd = `Smoke#${Date.now().toString(36)}`;
const roCreated = await req('/users', {
  method: 'POST',
  token: A,
  body: { username: roName, password: roPwd, displayName: '只读用户', role: 'READONLY' },
});
const RO = (await login(roName, roPwd)).json.accessToken;
check('只读用户可查看项目', (await req('/projects?pageSize=1', { token: RO })).status === 200);
check(
  '只读用户创建项目被拒（403）',
  (
    await req('/projects', {
      method: 'POST',
      token: RO,
      body: { name: `只读越权-${Date.now().toString(36)}` },
    })
  ).status === 403,
);
check('只读用户访问用户管理被拒（403）', (await req('/users', { token: RO })).status === 403);
await req(`/users/${v.json.id}`, { method: 'PATCH', token: A, body: { status: 'DISABLED' } });
if (roCreated.json?.id)
  await req(`/users/${roCreated.json.id}`, {
    method: 'PATCH',
    token: A,
    body: { status: 'DISABLED' },
  });

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
