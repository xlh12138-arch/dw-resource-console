/**
 * 冒烟测试：验证鉴权、CRUD、校验、RBAC、审计、导出。
 * 用法：先启动服务（npm run dev:api），再 node .tmp/smoke.mjs
 */
import { ADMIN_USERNAME, BASE as SMOKE_BASE, adminPassword } from './lib/smoke-env.mjs';

// 管理员口令取自 SMOKE_PASSWORD 或 .env 的 BOOTSTRAP_ADMIN_PASSWORD，缺失即失败
const ADMIN_PASSWORD = adminPassword('smoke-test');

const B = SMOKE_BASE;
const BASE = new URL(B).origin;
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}${extra ? ` :: ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

function refreshCookieFrom(res) {
  const values = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  return values
    .map((value) => value.split(';', 1)[0])
    .find((value) => value.startsWith('dw_refresh='));
}

async function req(path, { method = 'GET', token, body, cookie } = {}) {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text, cookie: refreshCookieFrom(res) };
}

const login = async (username, password) =>
  req('/auth/login', { method: 'POST', body: { username, password } });

console.log('\n[1] 健康检查');
const health = await fetch(`${BASE}/health`).then((r) => r.json());
check('GET /health 返回 ok', health.status === 'ok');
const ready = await fetch(`${BASE}/ready`).then((r) => r.json());
check('GET /ready 返回 ready', ready.status === 'ready');
const docs = await fetch(`${BASE}/docs/`);
check('GET /docs 可访问', docs.status === 200, `status=${docs.status}`);

console.log('\n[2] 认证');
const admin = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
check('管理员登录成功', admin.status === 200 && !!admin.json.accessToken);
check(
  '刷新令牌不出现在响应体，仅通过 HttpOnly Cookie 下发',
  !('refreshToken' in (admin.json ?? {})) && !!admin.cookie,
);
const A = admin.json.accessToken;
const badLogin = await login('admin', 'wrong-password');
check('错误口令返回 401', badLogin.status === 401, JSON.stringify(badLogin.json?.error?.code));
const noToken = await req('/resources');
check('未登录访问受保护接口返回 401', noToken.status === 401);

console.log('\n[3] 资源查询');
const list = await req('/resources?pageSize=3', { token: A });
check('分页列表返回 16 条总数', list.json.meta?.total === 16, `total=${list.json.meta?.total}`);
const nas = await req('/resources?type=NAS', { token: A });
check(
  '按类型筛选 NAS',
  nas.json.items?.every((i) => i.type === 'NAS') && nas.json.meta.total === 3,
);
const search = await req('/resources?q=GDS', { token: A });
check('关键字搜索命中 GDS', search.json.meta?.total >= 3, `total=${search.json.meta?.total}`);
const sorted = await req('/resources?sortBy=name&sortOrder=asc&pageSize=5', { token: A });
check('排序参数可用', Array.isArray(sorted.json.items));

console.log('\n[4] 统计概览');
const stats = await req('/stats/overview', { token: A });
check('统计接口返回总量', stats.json.total === 16, `total=${stats.json.total}`);
check('按类型统计覆盖字典中 11 类资源类型', stats.json.byType?.length === 11);
check(
  'NAS 容量统计正确',
  stats.json.nasCapacity?.capacityGb === 25600,
  `capacity=${stats.json.nasCapacity?.capacityGb}, usage=${stats.json.nasCapacity?.usageRate}%`,
);

console.log('\n[5] IP 占用检测');
const ipUsed = await req('/resources/check-ip?ip=10.10.1.11', { token: A });
check(
  '已占用 IP 返回 available=false',
  ipUsed.json.available === false,
  JSON.stringify(ipUsed.json.conflicts?.[0]),
);
const ipFree = await req('/resources/check-ip?ip=172.16.99.99', { token: A });
check('空闲 IP 返回 available=true', ipFree.json.available === true);
const ipBad = await req('/resources/check-ip?ip=999.1.1.1', { token: A });
check('非法 IP 返回 422', ipBad.status === 422);

console.log('\n[6] 新建 / 更新 / 删除');
const created = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: 'GDS_SERVER',
    name: '冒烟测试GDS',
    environment: 'PT',
    owner: '冒烟',
    tags: ['smoke'],
    attrs: {
      IP: '10.40.9.99',
      PORT: 5000,
      USER_NAME: 'edws',
    },
  },
});
check(
  '新建资源返回 201 + 编码',
  created.status === 201 && created.json.code?.startsWith('GDS-'),
  `${created.json.code}`,
);
const id = created.json.id;

const updated = await req(`/resources/${id}`, {
  method: 'PATCH',
  token: A,
  // 改成「维护中」会使资源不再参与 IP 占用判定，后面还要用它验证重复 IP，所以这里保持 IN_USE
  body: { status: 'IN_USE', attrs: { USER_NAME: 'edws2' } },
});
check(
  '更新状态与属性',
  updated.json.status === 'IN_USE' && updated.json.attrs?.USER_NAME === 'edws2',
);

const invalidIp = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: 'GDS_SERVER',
    name: 'bad',
    environment: 'PT',
    attrs: {
      IP: '999.1.1.1',
      PORT: 5000,
      USER_NAME: 'edws',
    },
  },
});
check(
  '非法 IP 新建返回 422',
  invalidIp.status === 422,
  JSON.stringify(invalidIp.json.error?.details?.[0] ?? ''),
);

const dupIp = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: 'GDS_SERVER',
    name: 'dup-gds',
    environment: 'PT',
    attrs: {
      IP: '10.40.9.99',
      PORT: 5000,
      USER_NAME: 'edws',
    },
  },
});
check('重复 IP 新建返回 409', dupIp.status === 409, dupIp.json.error?.message);

const notFound = await req(`/resources/999999`, { token: A });
check('不存在的资源返回 404', notFound.status === 404);

console.log('\n[7] RBAC（管理员 / 普通用户 / 只读用户）');
// 用管理员临时创建普通账号与只读账号来校验 RBAC，测试结束即停用
const normalName = `smoke_user_${Date.now().toString(36)}`;
const normalPwd = `Smoke#${Date.now().toString(36)}`;
const createdNormal = await req('/users', {
  method: 'POST',
  token: A,
  body: { username: normalName, password: normalPwd, displayName: '冒烟普通用户', role: 'USER' },
});
check('管理员可创建普通用户', createdNormal.status === 201, createdNormal.text);
const normal = await login(normalName, normalPwd);
const U = normal.json.accessToken;
const normalRead = await req('/resources?pageSize=1', { token: U });
check('普通用户可以查询资源', normalRead.status === 200);
const normalWrite = await req('/resources', {
  method: 'POST',
  token: U,
  body: {
    type: 'NAS',
    name: `冒烟普通用户资源-${Date.now().toString(36)}`,
    environment: 'DEV',
    attrs: {
      NAS_URL: 'nfs://nas-smoke/rbac',
      USEAGE: 'SOURCE_NAS',
    },
  },
});
check('普通用户可以新建资源', normalWrite.status === 201, normalWrite.text);
const normalDel = await req(`/resources/${normalWrite.json.id ?? id}`, {
  method: 'DELETE',
  token: U,
});
check('普通用户可以删除资源（与管理员一致）', normalDel.status === 200, normalDel.text);
const normalUsers = await req('/users', { token: U });
check('普通用户访问用户管理被拒绝 403', normalUsers.status === 403);
const normalReset = await req(`/users/${createdNormal.json.id ?? 1}/reset-password`, {
  method: 'POST',
  token: U,
});
check('普通用户重置密码被拒绝 403', normalReset.status === 403);
const normalAudit = await req('/audit-logs?pageSize=1', { token: U });
check('普通用户访问变更审计被拒绝 403', normalAudit.status === 403, `status=${normalAudit.status}`);

// 只读用户：可见范围同普通用户，但只能读
const roName = `smoke_ro_${Date.now().toString(36)}`;
const roPwd = `Smoke#${Date.now().toString(36)}`;
const createdRo = await req('/users', {
  method: 'POST',
  token: A,
  body: { username: roName, password: roPwd, displayName: '冒烟只读用户', role: 'READONLY' },
});
check('管理员可创建只读用户', createdRo.status === 201, createdRo.text);
const RO = (await login(roName, roPwd)).json.accessToken;
check('只读用户可以查询资源', (await req('/resources?pageSize=1', { token: RO })).status === 200);
check('只读用户可以查看资源详情', (await req(`/resources/${id}`, { token: RO })).status === 200);
check('只读用户可以查询项目', (await req('/projects?pageSize=1', { token: RO })).status === 200);
check('只读用户可以查询字典', (await req('/resource-types', { token: RO })).status === 200);
const roWrite = await req('/resources', {
  method: 'POST',
  token: RO,
  body: {
    type: 'NAS',
    name: `冒烟只读越权-${Date.now().toString(36)}`,
    environment: 'DEV',
    attrs: {
      NAS_URL: 'nfs://nas-smoke/ro',
      USEAGE: 'SOURCE_NAS',
    },
  },
});
check('只读用户新建资源被拒绝 403', roWrite.status === 403, `status=${roWrite.status}`);
check(
  '只读用户删除资源被拒绝 403',
  (await req(`/resources/${id}`, { method: 'DELETE', token: RO })).status === 403,
);
check(
  '只读用户改资源被拒绝 403',
  (await req(`/resources/${id}`, { method: 'PATCH', token: RO, body: { name: 'x' } })).status ===
    403,
);
check(
  '只读用户创建项目被拒绝 403',
  (
    await req('/projects', {
      method: 'POST',
      token: RO,
      body: { name: `只读越权-${Date.now().toString(36)}` },
    })
  ).status === 403,
);
check('只读用户访问用户管理被拒绝 403', (await req('/users', { token: RO })).status === 403);
check(
  '只读用户访问变更审计被拒绝 403',
  (await req('/audit-logs?pageSize=1', { token: RO })).status === 403,
);
check('管理员可以访问变更审计', (await req('/audit-logs?pageSize=1', { token: A })).status === 200);

for (const uid of [createdNormal.json?.id, createdRo.json?.id]) {
  if (uid) await req(`/users/${uid}`, { method: 'PATCH', token: A, body: { status: 'DISABLED' } });
}

console.log('\n[8] 批量导入 / 导出');
const csv = [
  'name,environment,status,owner,IP,USER_NAME,OS',
  '导入服务器-A,PT,IN_USE,张三,10.77.1.1,etladmin,Linux',
  '导入服务器-B,PT,IN_USE,张三,10.77.1.2,etladmin,Linux',
  '导入服务器-C,PT,IN_USE,张三,999.1.1.3,etladmin,Linux',
].join('\n');
const imported = await req('/resources/import', {
  method: 'POST',
  token: A,
  body: { type: 'ETL_SERVER', csv, onConflict: 'skip' },
});
check(
  'CSV 导入：2 成功 1 失败',
  imported.json.created === 2 && imported.json.errors?.length === 1,
  JSON.stringify({ created: imported.json.created, errors: imported.json.errors?.length }),
);
const reimport = await req('/resources/import', {
  method: 'POST',
  token: A,
  body: { type: 'ETL_SERVER', csv, onConflict: 'overwrite' },
});
check(
  '重复导入 overwrite 策略生效',
  reimport.json.updated >= 2 && reimport.json.skipped === 0,
  JSON.stringify(reimport.json),
);

const exportCsv = await fetch(`${B}/resources/export?type=NAS`, {
  headers: { authorization: `Bearer ${A}` },
});
const csvText = await exportCsv.text();
check(
  'CSV 导出含表头与数据行',
  csvText.startsWith('code,name,type') && csvText.includes('NAS-') && csvText.includes('NAS_URL'),
);

console.log('\n[9] 审计日志');
const audit = await req('/audit-logs?pageSize=5', { token: A });
check(
  '审计日志有记录',
  audit.json.items?.length > 0,
  `${audit.json.items?.[0]?.action} ${audit.json.items?.[0]?.targetName}`,
);
const resAudit = await req(`/resources/${id}/audit`, { token: A });
check(
  '资源级审计可追溯',
  Array.isArray(resAudit.json) && resAudit.json.length >= 2,
  `count=${resAudit.json?.length}`,
);

console.log('\n[10] 刷新令牌与登出');
const refreshed = await req('/auth/refresh', { method: 'POST', cookie: admin.cookie });
check('刷新令牌换取新访问令牌', refreshed.status === 200 && !!refreshed.json.accessToken);
check(
  '续期响应同样不暴露刷新令牌',
  !('refreshToken' in (refreshed.json ?? {})) && !!refreshed.cookie,
);
const reused = await req('/auth/refresh', { method: 'POST', cookie: admin.cookie });
check('旧刷新令牌已轮换失效', reused.status === 401);
const me = await req('/auth/me', { token: refreshed.json.accessToken });
check('新令牌可获取用户信息', me.json.username === 'admin');
const logout = await req('/auth/logout', {
  method: 'POST',
  token: refreshed.json.accessToken,
  cookie: refreshed.cookie,
});
check('登出成功', logout.status === 200);

const disabledNormal = await req(`/users/${createdNormal.json.id}`, {
  method: 'PATCH',
  token: A,
  body: { status: 'DISABLED' },
});
check(
  '临时普通账号已停用',
  disabledNormal.status === 200 && disabledNormal.json.status === 'DISABLED',
);

console.log('\n[11] 清理');
const del = await req(`/resources/${id}`, { method: 'DELETE', token: A });
check('删除冒烟资源', del.status === 200);
const cleanup = await req('/resources?type=ETL_SERVER&q=导入服务器', { token: A });
for (const item of cleanup.json.items ?? []) {
  await req(`/resources/${item.id}`, { method: 'DELETE', token: A });
}
check(
  '清理导入数据',
  (await req('/resources?type=ETL_SERVER&q=导入服务器', { token: A })).json.meta?.total === 0,
);

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail === 0 ? 0 : 1);
