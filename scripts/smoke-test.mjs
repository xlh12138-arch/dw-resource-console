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

function refreshSetCookieFrom(res) {
  const values = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  return values.find((value) => value.startsWith('dw_refresh='));
}

function refreshCookieFrom(res) {
  return refreshSetCookieFrom(res)?.split(';', 1)[0];
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
  return {
    status: res.status,
    json,
    text,
    cookie: refreshCookieFrom(res),
    setCookie: refreshSetCookieFrom(res),
  };
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
check(
  '登录结果下发无操作自动退出时间',
  Number.isInteger(admin.json.idleTimeoutSeconds) && admin.json.idleTimeoutSeconds > 0,
);
check(
  '刷新 Cookie 为浏览器会话 Cookie，不含 Max-Age/Expires',
  !!admin.setCookie && !/max-age=/i.test(admin.setCookie) && !/expires=/i.test(admin.setCookie),
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

// createdNormal 保持启用：后面的个人资料与改密用例要用它的登录态
for (const uid of [createdRo.json?.id]) {
  if (uid) await req(`/users/${uid}`, { method: 'PATCH', token: A, body: { status: 'DISABLED' } });
}

// 删除用户时的刷新令牌清理只靠应用层补偿（DWS 没有外键级联）。
// 这里先给待删除用户签发一枚刷新令牌，删除后必须立即失效，否则会留下孤儿令牌。
const cascadePassword = `Smoke#${Date.now().toString(36)}`;
const cascadeUser = await req('/users', {
  method: 'POST',
  token: A,
  body: {
    username: `smoke_cascade_${Date.now().toString(36)}`,
    password: cascadePassword,
    displayName: '孤儿令牌校验',
    role: 'READONLY',
  },
});
check('创建孤儿令牌校验用户', cascadeUser.status === 201, cascadeUser.text);
const cascadeLogin = await login(cascadeUser.json.username, cascadePassword);
check('孤儿令牌校验：删除前可登录', cascadeLogin.status === 200 && !!cascadeLogin.cookie);
const cascadeToken = await req('/auth/refresh', {
  method: 'POST',
  cookie: cascadeLogin.cookie,
});
check(
  '孤儿令牌校验：删除前刷新令牌有效',
  cascadeToken.status === 200 && cascadeToken.json.user?.role === 'READONLY',
  `status=${cascadeToken.status}`,
);
await req(`/users/${cascadeUser.json.id}`, {
  method: 'PATCH',
  token: A,
  body: { status: 'DISABLED' },
});
const cascadeDelete = await req(`/users/${cascadeUser.json.id}`, { method: 'DELETE', token: A });
check('删除已停用用户', cascadeDelete.status === 200, cascadeDelete.text);
const cascadeAfter = await req('/auth/refresh', { method: 'POST', cookie: cascadeToken.cookie });
check(
  '用户删除后刷新令牌同步清理，不再可续期（DWS 无外键时同样成立）',
  cascadeAfter.status === 401,
  `status=${cascadeAfter.status}`,
);

console.log('\n[8] 用户批量操作与批量导入（整批回滚）');

const unique = () => Date.now().toString(36);
const mkUsers = async (count, prefix) => {
  const users = [];
  for (let i = 0; i < count; i += 1) {
    const password = `Bulk#${unique()}${i}`;
    const created = await req('/users', {
      method: 'POST',
      token: A,
      body: {
        username: `${prefix}_${unique()}${i}`.slice(0, 32),
        password,
        displayName: `批量校验${i}`,
        role: 'READONLY',
      },
    });
    users.push({ id: created.json?.id, username: created.json?.username, password });
  }
  return users;
};

// 1) 批量停用：两个账号都应变为 DISABLED，且各自的刷新令牌立即失效
const stopUsers = await mkUsers(2, 'smoke_bulk_stop');
const stopCookies = [];
for (const user of stopUsers) {
  const res = await login(user.username, user.password);
  stopCookies.push(res.cookie);
}
const stopRes = await req('/users/bulk/status', {
  method: 'POST',
  token: A,
  body: { ids: stopUsers.map((u) => u.id), status: 'DISABLED' },
});
check(
  '批量停用：一次请求更新全部账号',
  stopRes.status === 200 && stopRes.json.updated === 2,
  stopRes.text,
);
const stopAfterRefresh = await Promise.all(
  stopCookies.map((cookie) => req('/auth/refresh', { method: 'POST', cookie })),
);
check(
  '批量停用：被停用账号的会话同步失效',
  stopAfterRefresh.every((res) => res.status === 401),
  stopAfterRefresh.map((res) => res.status).join(','),
);

// 2) 批量启用：已停用的账号恢复 ACTIVE，不应恢复历史会话
const startRes = await req('/users/bulk/status', {
  method: 'POST',
  token: A,
  body: { ids: stopUsers.map((u) => u.id), status: 'ACTIVE' },
});
check(
  '批量启用：更新全部账号',
  startRes.status === 200 && startRes.json.updated === 2,
  startRes.text,
);
const startAgain = await req('/users/bulk/status', {
  method: 'POST',
  token: A,
  body: { ids: stopUsers.map((u) => u.id), status: 'ACTIVE' },
});
check(
  '批量启用：已是目标状态的账号被跳过，不重复写审计',
  startAgain.status === 200 && startAgain.json.updated === 0,
  startAgain.text,
);
const reopened = await req('/auth/refresh', { method: 'POST', cookie: stopCookies[0] });
check('批量启用后旧会话不恢复，需要重新登录', reopened.status === 401, `status=${reopened.status}`);

// 3) 批量重置密码：返回每个账号的新密码，旧密码失效
const resetUsers = await mkUsers(2, 'smoke_bulk_reset');
const resetRes = await req('/users/bulk/reset-password', {
  method: 'POST',
  token: A,
  body: { ids: resetUsers.map((u) => u.id) },
});
check(
  '批量重置密码：按提交顺序返回每个账号的新密码',
  resetRes.status === 200 &&
    resetRes.json.updated === 2 &&
    resetRes.json.users.map((u) => u.id).join(',') === resetUsers.map((u) => u.id).join(','),
  resetRes.text,
);
const oldLogin = await login(resetUsers[0].username, resetUsers[0].password);
check('批量重置密码后原密码失效', oldLogin.status === 401, `status=${oldLogin.status}`);
const newLogin = await login(resetUsers[0].username, resetRes.json.users[0].password);
check('批量重置密码后新密码可登录', newLogin.status === 200, `status=${newLogin.status}`);

// 4) 回滚：混入一个未停用账号，批量删除必须整体失败且不留下任何删除痕迹
const rollbackActive = (await mkUsers(1, 'smoke_bulk_live'))[0];
const rollbackDisabled = (await mkUsers(1, 'smoke_bulk_off'))[0];
await req(`/users/${rollbackDisabled.id}`, {
  method: 'PATCH',
  token: A,
  body: { status: 'DISABLED' },
});
const rollbackRes = await req('/users/bulk/delete', {
  method: 'POST',
  token: A,
  body: { ids: [rollbackDisabled.id, rollbackActive.id] },
});
check(
  '批量删除：混入未停用账号时整批失败',
  rollbackRes.status === 409,
  `status=${rollbackRes.status}`,
);
const stillThere = await req('/users', { token: A });
const stillIds = new Set((stillThere.json.items ?? []).map((u) => u.id));
check(
  '批量删除失败后，同批中满足条件的账号也没有被删（事务整体回滚）',
  stillIds.has(rollbackDisabled.id) && stillIds.has(rollbackActive.id),
  `disabled=${stillIds.has(rollbackDisabled.id)} active=${stillIds.has(rollbackActive.id)}`,
);

// 同样的回滚要求也适用于批量停用：包含自己（当前登录账号）时整批不生效
const holder = (await mkUsers(1, 'smoke_bulk_holder'))[0];
const selfRes = await req('/users/bulk/status', {
  method: 'POST',
  token: A,
  body: { ids: [holder.id, admin.json.user.id], status: 'DISABLED' },
});
const holderAfter = await req('/users', { token: A });
const holderRow = (holderAfter.json.items ?? []).find((u) => u.id === holder.id);
check(
  '批量停用包含当前登录账号时整批失败，其他账号状态未变',
  selfRes.status === 409 && holderRow?.status === 'ACTIVE',
  `status=${selfRes.status} holder=${holderRow?.status}`,
);

// 5) 批量删除：全部满足条件时成功
await req(`/users/${rollbackDisabled.id}`, {
  method: 'PATCH',
  token: A,
  body: { status: 'DISABLED' },
});
const deleteOk = await req('/users/bulk/delete', {
  method: 'POST',
  token: A,
  body: { ids: [rollbackDisabled.id] },
});
check(
  '批量删除：全部满足条件时成功',
  deleteOk.status === 200 && deleteOk.json.deleted === 1,
  deleteOk.text,
);

// 6) 批量导入：重复用户名导致整批不写入
const importPrefix = `smoke_imp_${unique()}`;
const dupImport = await req('/users/import', {
  method: 'POST',
  token: A,
  body: {
    rows: [
      { row: 2, username: `${importPrefix}a`, displayName: '导入A', role: '普通用户' },
      { row: 3, username: `${importPrefix}a`, displayName: '导入B', role: 'USER' },
    ],
  },
});
check('批量导入：表内用户名重复时整批拒绝', dupImport.status === 422, `status=${dupImport.status}`);
const afterDup = await req(`/users?q=${importPrefix}a`, { token: A });
check(
  '批量导入失败后没有写入任何账号',
  !(afterDup.json.items ?? []).some((u) => u.username === `${importPrefix}a`),
  afterDup.text,
);
// 前端要把服务端原因逐行展示，所以 details 必须是 [{row, username, message}]
// 错误响应体统一包在 error 下：{ error: { code, message, details, requestId } }
const dupDetails = dupImport.json?.error?.details;
check(
  '批量导入失败时按行返回原因（row / username / message）',
  dupDetails?.reason === 'IMPORT_INVALID' &&
    Array.isArray(dupDetails.errors) &&
    dupDetails.errors.length === 1 &&
    dupDetails.errors[0].row === 3 &&
    typeof dupDetails.errors[0].username === 'string' &&
    /重复/.test(dupDetails.errors[0].message),
  JSON.stringify(dupDetails),
);

// 7) 批量导入：合法数据全部创建，并返回一次性初始密码
const okImport = await req('/users/import', {
  method: 'POST',
  token: A,
  body: {
    rows: [
      { row: 2, username: `${importPrefix}b`, displayName: '导入B', role: '只读用户' },
      {
        row: 3,
        username: `${importPrefix}c`,
        displayName: '导入C',
        role: 'USER',
        password: `Init#${unique()}`,
      },
    ],
  },
});
check(
  '批量导入：合法数据全部创建并返回初始密码',
  okImport.status === 200 &&
    okImport.json.created === 2 &&
    okImport.json.users.every((u) => typeof u.password === 'string' && u.password.length >= 8),
  okImport.text,
);
// 6.5) 与系统里已有账号同名：必须明确告知「已存在」及所在行，不能只给一句汇总
const existImport = await req('/users/import', {
  method: 'POST',
  token: A,
  body: {
    rows: [
      { row: 2, username: `${importPrefix}d`, displayName: '导入D', role: '普通用户' },
      { row: 3, username: ADMIN_USERNAME, displayName: '重名', role: '普通用户' },
    ],
  },
});
const existErrors = existImport.json?.error?.details?.errors ?? [];
check(
  '批量导入：与已有账号同名时，逐行提示该用户名已存在',
  existImport.status === 422 &&
    existErrors.some((e) => e.row === 3 && e.message.includes('已存在')),
  existImport.text,
);
const afterExist = await req(`/users?q=${importPrefix}d`, { token: A });
check(
  '批量导入因重名失败时整批不写入（同批其他新账号也不落库）',
  !(afterExist.json.items ?? []).some((u) => u.username === `${importPrefix}d`),
  afterExist.text,
);

check(
  '批量导入：留空密码自动生成，角色按中文写法识别',
  okImport.json.users?.[0]?.role === 'READONLY',
  okImport.text,
);

// 清理批量用例创建的账号：先停用再删除（与业务规则一致）
const toCleanup = [
  ...stopUsers,
  ...resetUsers,
  rollbackActive,
  holder,
  ...(okImport.json.users ?? []).map((u) => ({ id: u.id })),
];
for (const user of toCleanup) {
  await req(`/users/${user.id}`, { method: 'PATCH', token: A, body: { status: 'DISABLED' } });
}
const cleanupBulk = await req('/users/bulk/delete', {
  method: 'POST',
  token: A,
  body: { ids: toCleanup.map((u) => u.id) },
});
check('清理批量用例账号', cleanupBulk.status === 200, cleanupBulk.text);

console.log('\n[9] 资源批量导入 / 导出');
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

console.log('\n[10] 审计日志');
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

console.log('\n[11] 刷新令牌与登出');
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
check(
  '登出清除刷新 Cookie（下发同名过期 Cookie）',
  !!logout.setCookie && /^dw_refresh=;/.test(logout.setCookie),
  logout.setCookie ?? 'no set-cookie',
);
const refreshAfterLogout = await req('/auth/refresh', { method: 'POST', cookie: refreshed.cookie });
check('登出后刷新令牌立即失效，/auth/refresh 返回 401', refreshAfterLogout.status === 401);

// 空闲超时或访问令牌过期时前端只剩 Cookie，登出不能要求访问令牌
const cookieOnly = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
check('为「仅凭 Cookie 登出」再次登录', cookieOnly.status === 200 && !!cookieOnly.cookie);
const logoutNoToken = await req('/auth/logout', { method: 'POST', cookie: cookieOnly.cookie });
check(
  '不带访问令牌也能登出，且不落系统错误',
  logoutNoToken.status === 200 && logoutNoToken.json?.success === true,
  `status=${logoutNoToken.status}`,
);
const refreshAfterCookieLogout = await req('/auth/refresh', {
  method: 'POST',
  cookie: cookieOnly.cookie,
});
check(
  '仅凭 Cookie 登出后，该刷新令牌同样失效',
  refreshAfterCookieLogout.status === 401,
  `status=${refreshAfterCookieLogout.status}`,
);

console.log('\n[12] 个人资料与密码策略（改姓名 / 改密码 / 首登强制改密）');
check(
  '管理员新建账号带首登改密标记',
  createdNormal.json?.mustChangePassword === true,
  `mustChangePassword=${createdNormal.json?.mustChangePassword}`,
);
const selfProfile = await req('/auth/profile', {
  method: 'PATCH',
  token: U,
  body: { displayName: '冒烟普通用户-已改名' },
});
check(
  '普通用户可以修改自己的姓名',
  selfProfile.status === 200 && selfProfile.json?.displayName === '冒烟普通用户-已改名',
  selfProfile.text,
);
const selfMe = await req('/auth/me', { token: U });
check('改名后 /auth/me 返回新姓名', selfMe.json?.displayName === '冒烟普通用户-已改名');
const emptyName = await req('/auth/profile', {
  method: 'PATCH',
  token: U,
  body: { displayName: '   ' },
});
check(
  '姓名为空被拒绝 400/422',
  [400, 422].includes(emptyName.status),
  `status=${emptyName.status}`,
);

const wrongOld = await req('/auth/password', {
  method: 'POST',
  token: U,
  body: { currentPassword: 'Wrong#000000', newPassword: 'Str0ng-An0ther-Pass' },
});
check(
  '改密码时当前密码错误被拒绝',
  wrongOld.status === 422 && wrongOld.json?.error?.details?.reason === 'WRONG_CURRENT_PASSWORD',
  wrongOld.text,
);
const weakNew = await req('/auth/password', {
  method: 'POST',
  token: U,
  body: { currentPassword: normalPwd, newPassword: 'admin123456' },
});
check(
  '弱口令被密码策略拒绝并给出原因',
  weakNew.status === 422 &&
    weakNew.json?.error?.details?.reason === 'PASSWORD_POLICY' &&
    (weakNew.json?.error?.details?.issues ?? []).length > 0,
  weakNew.text,
);
const shortNew = await req('/auth/password', {
  method: 'POST',
  token: U,
  body: { currentPassword: normalPwd, newPassword: 'Ab1#xy' },
});
check('不足 10 位的新密码被契约拦截', shortNew.status === 400 || shortNew.status === 422);

const changedPwd = `Moved#${Date.now().toString(36)}`;
const changed = await req('/auth/password', {
  method: 'POST',
  token: U,
  body: { currentPassword: normalPwd, newPassword: changedPwd },
});
check(
  '修改密码成功并返回新的访问令牌',
  changed.status === 200 && !!changed.json?.accessToken && !!changed.cookie,
  changed.text,
);
check(
  '改密后首登改密标记清除',
  changed.json?.user?.mustChangePassword === false,
  `mustChangePassword=${changed.json?.user?.mustChangePassword}`,
);
const oldPwdLogin = await login(normalName, normalPwd);
check('改密后旧密码无法登录', oldPwdLogin.status === 401);
const newPwdLogin = await login(normalName, changedPwd);
check('改密后新密码可以登录', newPwdLogin.status === 200 && !!newPwdLogin.json?.accessToken);
check(
  '改密后旧刷新令牌已失效',
  (await req('/auth/refresh', { method: 'POST', cookie: normal.cookie })).status === 401,
);
check(
  '改密后新令牌可正常访问（会话无缝续接）',
  (await req('/auth/me', { token: newPwdLogin.json.accessToken })).status === 200,
);

// 管理员重置口令后，该账号需要重新走一次首登改密
const adminReset = await req(`/users/${createdNormal.json.id}/reset-password`, {
  method: 'POST',
  token: A,
});
check(
  '管理员重置口令后响应即带首登改密标记',
  adminReset.status === 200 && adminReset.json?.user?.mustChangePassword === true,
  adminReset.text,
);
const afterResetLogin = await login(normalName, adminReset.json?.password ?? '');
check(
  '重置后可登录，且再次要求首登改密',
  afterResetLogin.status === 200 && afterResetLogin.json?.user?.mustChangePassword === true,
  `mustChangePassword=${afterResetLogin.json?.user?.mustChangePassword}`,
);
check(
  '重置后的账号仍可访问 /auth/me，且带着首登改密标记',
  (await req('/auth/me', { token: afterResetLogin.json?.accessToken })).json?.mustChangePassword ===
    true,
);
const auditSelf = await req(
  `/audit-logs?pageSize=50&action=UPDATE&actor=${encodeURIComponent('冒烟普通用户-已改名')}`,
  { token: A },
);
const selfAudit = (auditSelf.json?.items ?? []).filter(
  (item) => item.targetName === normalName || item.targetName === '冒烟普通用户-已改名',
);
check('改姓名与改密码都落审计', selfAudit.length >= 2, `count=${selfAudit.length}`);

const disabledNormal = await req(`/users/${createdNormal.json.id}`, {
  method: 'PATCH',
  token: A,
  body: { status: 'DISABLED' },
});
check(
  '临时普通账号已停用',
  disabledNormal.status === 200 && disabledNormal.json.status === 'DISABLED',
);

console.log('\n[13] 清理');
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
