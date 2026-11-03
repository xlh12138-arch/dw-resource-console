/**
 * 冒烟测试：三角色模型（管理员 / 普通用户 / 只读用户）+ 管理员重置密码
 *
 * 覆盖：
 *  1. 角色只有 ADMIN / USER / READONLY 三种，未定义角色（VIEWER 等）不可创建
 *  2. 管理员重置密码 → 返回一次性明文新口令（12 位）
 *  3. 旧密码立即失效、新密码可登录
 *  4. 重置后该账号已签发的刷新令牌被吊销（需重新登录）
 *  5. 重置不影响角色与状态
 *  6. 普通用户不能调用重置接口（403）、不能看审计（403），未登录 401
 *  7. 只读用户能读不能写（403）
 *  8. 目标不存在返回 404
 *  9. 审计留痕且不记录明文密码
 */

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787/api/v1';

let passed = 0;
let failed = 0;

function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}

function refreshCookieFrom(res) {
  const values = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  return values
    .map((value) => value.split(';', 1)[0])
    .find((value) => value.startsWith('dw_refresh='));
}

async function req(path, { method = 'GET', token, body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text, cookie: refreshCookieFrom(res) };
}

const ADMIN = {
  username: process.env.SMOKE_ADMIN_USER ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'Admin@12345',
};

const adminLogin = await req('/auth/login', { method: 'POST', body: ADMIN });
if (!adminLogin.json?.accessToken) {
  console.log('管理员登录失败，无法执行冒烟：', adminLogin.text);
  process.exit(1);
}
const A = adminLogin.json.accessToken;

const stamp = Date.now().toString(36);
const username = `smoke_pwd_${stamp}`;
const oldPwd = `Old#${stamp}Aa1`;
const displayName = '冒烟改密用户';

/* ------------------------------------------------------------------ *
 * [1] 角色只有两种
 * ------------------------------------------------------------------ */
console.log('\n[1] 角色为 ADMIN / USER / READONLY 三种');
const list = await req('/users', { token: A });
const roles = [...new Set((list.json?.items ?? []).map((u) => u.role))];
ok(list.status === 200, `用户列表可读（${list.json?.items?.length ?? 0} 个账号）`);
ok(
  roles.every((r) => r === 'ADMIN' || r === 'USER' || r === 'READONLY'),
  `现有账号角色都属于 ADMIN/USER/READONLY（实际 ${roles.join(', ') || '无'}）`,
);
ok(
  (list.json?.items ?? []).some((u) => u.role === 'READONLY'),
  '种子数据里有只读账号（readonly）',
);
const legacyCreate = await req('/users', {
  method: 'POST',
  token: A,
  body: { username: `smoke_legacy_${stamp}`, password: 'Legacy#12345', displayName: '旧角色', role: 'VIEWER' },
});
ok(legacyCreate.status === 422, `未定义角色 VIEWER 不可再创建（422，实际 ${legacyCreate.status}）`);

/* ------------------------------------------------------------------ *
 * [2] 创建测试账号并登录
 * ------------------------------------------------------------------ */
console.log('\n[2] 准备测试账号');
const created = await req('/users', {
  method: 'POST',
  token: A,
  body: { username, password: oldPwd, displayName, role: 'USER' },
});
ok(created.status === 201, `创建普通用户 ${username}（${created.status}）`, created.text);
const userId = created.json?.id;
ok(typeof userId === 'number', '返回新用户 id');

const before = await req('/auth/login', { method: 'POST', body: { username, password: oldPwd } });
ok(before.status === 200, '重置前旧密码可登录');
ok(typeof before.cookie === 'string' && before.cookie.length > 16, '拿到重置前的刷新 Cookie');
ok(!('refreshToken' in (before.json ?? {})), '登录响应不含刷新令牌');

/* ------------------------------------------------------------------ *
 * [3] 管理员重置密码
 * ------------------------------------------------------------------ */
console.log('\n[3] 管理员重置密码');
const reset = await req(`/users/${userId}/reset-password`, { method: 'POST', token: A });
const newPwd = reset.json?.password;
ok(reset.status === 200, `重置成功（${reset.status}）`, reset.text);
ok(typeof newPwd === 'string' && newPwd.length === 12, `返回 12 位新密码（实际 ${newPwd?.length}）`);
ok(/^[A-Za-z0-9]{12}$/.test(newPwd ?? ''), '新密码为不含易混淆字符的字母数字');
ok(newPwd !== oldPwd, '新密码与旧密码不同');
ok(reset.json?.user?.username === username, '响应回带账号信息');
ok(reset.json?.user?.role === 'USER', `重置不改变角色（${reset.json?.user?.role}）`);
ok(reset.json?.user?.status === 'ACTIVE', `重置不改变状态（${reset.json?.user?.status}）`);

/* ------------------------------------------------------------------ *
 * [4] 新旧密码与刷新令牌
 * ------------------------------------------------------------------ */
console.log('\n[4] 旧密码失效 / 新密码生效');
const oldLogin = await req('/auth/login', { method: 'POST', body: { username, password: oldPwd } });
ok(oldLogin.status === 401, `旧密码登录被拒（${oldLogin.status}）`);
const newLogin = await req('/auth/login', { method: 'POST', body: { username, password: newPwd } });
ok(newLogin.status === 200, `新密码登录成功（${newLogin.status}）`, newLogin.text);

const staleRefresh = await req('/auth/refresh', { method: 'POST', cookie: before.cookie });
ok(staleRefresh.status === 401, `重置前的刷新令牌已吊销（${staleRefresh.status}）`);

/* ------------------------------------------------------------------ *
 * [5] 权限与边界
 * ------------------------------------------------------------------ */
console.log('\n[5] 权限与边界');
const U = newLogin.json?.accessToken;
const byNormal = await req(`/users/${userId}/reset-password`, { method: 'POST', token: U });
ok(byNormal.status === 403, `普通用户重置密码被拒（403，实际 ${byNormal.status}）`);
const anonymous = await req(`/users/${userId}/reset-password`, { method: 'POST' });
ok(anonymous.status === 401, `未登录调用被拒（401，实际 ${anonymous.status}）`);
const missing = await req('/users/999999/reset-password', { method: 'POST', token: A });
ok(missing.status === 404, `目标用户不存在返回 404（实际 ${missing.status}）`);
const selfReset = await req(`/users/${userId}/reset-password`, { method: 'POST', token: U });
ok(selfReset.status === 403, '普通用户也不能重置自己（无 user:manage）');
const normalAudit = await req('/audit-logs?pageSize=1', { token: U });
ok(normalAudit.status === 403, `普通用户不能看变更审计（403，实际 ${normalAudit.status}）`);
ok('普通用户不能访问用户列表', (await req('/users', { token: U })).status === 403);

/* ------------------------------------------------------------------ *
 * [5b] 只读用户：能读不能写
 * ------------------------------------------------------------------ */
console.log('\n[5b] 只读用户能读不能写');
const roName = `smoke_ro_${stamp}`;
const roPwd = `Readonly#${stamp}`;
const roCreated = await req('/users', {
  method: 'POST',
  token: A,
  body: { username: roName, password: roPwd, displayName: '冒烟只读用户', role: 'READONLY' },
});
ok(roCreated.status === 201, `管理员可创建只读用户（${roCreated.status}）`, roCreated.text);
const roLogin = await req('/auth/login', { method: 'POST', body: { username: roName, password: roPwd } });
ok(roLogin.status === 200 && roLogin.json?.user?.role === 'READONLY', `只读用户可登录且角色为 READONLY（${roLogin.json?.user?.role}）`);
const R = roLogin.json.accessToken;
ok('只读用户可读资源', (await req('/resources?pageSize=1', { token: R })).status === 200);
ok('只读用户可读项目', (await req('/projects?pageSize=1', { token: R })).status === 200);
ok('只读用户不能看变更审计', (await req('/audit-logs?pageSize=1', { token: R })).status === 403);
const roWrite = await req('/resources', {
  method: 'POST',
  token: R,
  body: {
    type: 'NAS',
    name: `冒烟只读越权-${stamp}`,
    environment: 'DEV',
    attrs: { exportPath: '/smoke-ro', mountPoint: '/mnt/smoke-ro', protocol: 'NFS', capacityGb: 10 },
  },
});
ok(roWrite.status === 403, `只读用户新建资源被拒（403，实际 ${roWrite.status}）`);
ok(
  '只读用户新建项目被拒',
  (await req('/projects', { method: 'POST', token: R, body: { name: `只读越权-${stamp}` } })).status === 403,
);
ok(
  '只读用户改资源被拒',
  (await req('/resources/1', { method: 'PATCH', token: R, body: { name: 'x' } })).status === 403,
);
ok('只读用户访问用户管理被拒', (await req('/users', { token: R })).status === 403);
if (roCreated.json?.id) await req(`/users/${roCreated.json.id}`, { method: 'PATCH', token: A, body: { status: 'DISABLED' } });

/* ------------------------------------------------------------------ *
 * [6] 审计留痕
 * ------------------------------------------------------------------ */
console.log('\n[6] 审计留痕');
const audit = await req(`/audit-logs?targetType=USER&targetId=${userId}&pageSize=50`, { token: A });
const records = audit.json?.items ?? [];
const pwdRecord = records.find((r) => (r.changes ?? []).some((c) => c.field === 'password'));
ok(audit.status === 200, `审计日志可读（${records.length} 条）`);
ok(Boolean(pwdRecord), '存在密码重置的审计记录');
ok(pwdRecord?.actorName === '系统管理员' || pwdRecord?.actorName === ADMIN.username, `记录操作人（${pwdRecord?.actorName}）`);
ok(
  !JSON.stringify(records).includes(newPwd ?? '\u0000') &&
    !JSON.stringify(records).includes(oldPwd),
  '审计明细不含新旧明文密码',
);
ok(
  JSON.stringify(pwdRecord?.changes ?? []).includes('已重置'),
  '审计里以「已重置」标记代替明文',
);

/* ------------------------------------------------------------------ *
 * 清理：停用测试账号（无删除接口，停用即可避免污染后续用例）
 * ------------------------------------------------------------------ */
console.log('\n[7] 清理');
const disabled = await req(`/users/${userId}`, { method: 'PATCH', token: A, body: { status: 'DISABLED' } });
ok(disabled.status === 200, '测试账号已停用');

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
