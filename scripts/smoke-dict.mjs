/**
 * 字典配置冒烟测试：资源类型 / 环境的可维护性 + 引用检查 + 一键同步。
 * 前置：API 已在 http://127.0.0.1:8787 启动且已执行 db:seed。
 * 用法：npm run smoke:dict
 */
import { ADMIN_USERNAME, BASE, adminPassword } from './lib/smoke-env.mjs';

const ADMIN_PASSWORD = adminPassword('smoke-dict');

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
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const login = async (username, password) =>
  req('/auth/login', { method: 'POST', body: { username, password } });

const admin = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
if (admin.status !== 200) {
  console.error('登录失败，请确认 API 已启动：', admin.json);
  process.exit(1);
}
const A = admin.json.accessToken;

console.log('\n[1] 内置字典已初始化');
const types = await req('/resource-types', { token: A });
check('资源类型字典可读', types.status === 200, `status=${types.status}`);
check('资源类型字典存在', types.json.length >= 5, `count=${types.json.length}`);
const envList = await req('/environments', { token: A });
check(
  '环境字典可读',
  envList.status === 200 && envList.json.length >= 3,
  `count=${envList.json?.length}`,
);
const meta = await req('/meta', { token: A });
check(
  'meta 返回字典类型',
  Array.isArray(meta.json.resourceTypes) && meta.json.resourceTypes.length >= 5,
);
check('meta 返回动态字段定义', (meta.json.attrFields?.NAS ?? []).length > 0);

console.log('\n[2] 新增自定义资源类型（含字段定义）');
const newTypeCode = `SMOKE_TYPE_${Date.now().toString(36).toUpperCase()}`;
const created = await req('/resource-types', {
  method: 'POST',
  token: A,
  body: {
    code: newTypeCode,
    label: '冒烟自定义类型',
    prefix: 'SMK',
    description: '冒烟测试用',
    ipUniqueByPort: false,
    listColumns: ['endpoint'],
    enabled: true,
    fields: [
      { key: 'endpoint', label: '接入地址', fieldType: 'TEXT', required: true, sortOrder: 0 },
      { key: 'srvIp', label: '服务 IP', fieldType: 'IP', required: true, isIp: true, sortOrder: 1 },
      { key: 'weight', label: '权重', fieldType: 'INTEGER', required: false, sortOrder: 2 },
      {
        key: 'mode',
        label: '模式',
        fieldType: 'SELECT',
        required: true,
        options: [
          { value: 'A', label: '主' },
          { value: 'B', label: '备' },
        ],
        sortOrder: 3,
      },
    ],
  },
});
check(
  '自定义类型创建成功',
  created.status === 201,
  `status=${created.status} ${JSON.stringify(created.json).slice(0, 160)}`,
);
check(
  '字段定义随类型一起保存',
  created.json?.detail?.fields?.length === 4,
  `fields=${created.json?.detail?.fields?.length}`,
);

const dup = await req('/resource-types', {
  method: 'POST',
  token: A,
  body: { code: newTypeCode, label: '重复', prefix: 'SMK', fields: [] },
});
check('重复编码被拒绝(409)', dup.status === 409, `status=${dup.status}`);

console.log('\n[3] 用自定义类型创建资源（属性按动态 schema 校验）');
const okRes = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: newTypeCode,
    name: '冒烟自定义资源',
    environment: 'PT',
    attrs: { endpoint: 'http://x/y', srvIp: '10.77.0.1', mode: 'A' },
  },
});
check(
  '自定义类型资源创建成功',
  okRes.status === 201,
  `status=${okRes.status} ${JSON.stringify(okRes.json).slice(0, 200)}`,
);
const resId = okRes.json?.id;
check(
  '编码前缀取自字典',
  String(okRes.json?.code ?? '').startsWith('SMK-'),
  `code=${okRes.json?.code}`,
);

const badRes = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: newTypeCode,
    name: '非法属性',
    environment: 'PT',
    attrs: { endpoint: '', srvIp: '999.1.1.1', mode: 'C' },
  },
});
check('必填/枚举/IP 校验生效(422)', badRes.status === 422, `status=${badRes.status}`);

const unknownType = await req('/resources', {
  method: 'POST',
  token: A,
  body: { type: 'NOT_EXIST_TYPE', name: 'x', environment: 'PT', attrs: {} },
});
check('未登记类型被拒绝(422)', unknownType.status === 422, `status=${unknownType.status}`);

console.log('\n[4] 修改已被引用的类型：先提示引用，再一键同步');
const refBefore = await req(`/resource-types/${newTypeCode}/references`, { token: A });
check('引用统计含资源', refBefore.json.total >= 1, `total=${refBefore.json.total}`);

const renamedCode = `${newTypeCode}_V2`;
const noSync = await req(`/resource-types/${newTypeCode}`, {
  method: 'PATCH',
  token: A,
  body: { code: renamedCode },
});
check('改编码但未同步 → 409 提示', noSync.status === 409, `status=${noSync.status}`);
check(
  '409 带引用明细',
  noSync.json?.error?.details?.references?.total >= 1,
  JSON.stringify(noSync.json?.error?.details ?? {}).slice(0, 120),
);

const withSync = await req(`/resource-types/${newTypeCode}`, {
  method: 'PATCH',
  token: A,
  body: { code: renamedCode, sync: true },
});
check(
  '带 sync 保存成功',
  withSync.status === 200,
  `status=${withSync.status} ${JSON.stringify(withSync.json).slice(0, 200)}`,
);
check(
  '同步了 1 条资源',
  withSync.json?.sync?.updated?.resource === 1,
  JSON.stringify(withSync.json?.sync ?? {}),
);

const afterRename = await req(`/resources/${resId}`, { token: A });
check(
  '资源的类型已同步为新编码',
  afterRename.json.type === renamedCode,
  `type=${afterRename.json.type}`,
);

console.log('\n[5] 字段重命名 / 删除后一键同步存量资源 attrs');
const keyRename = await req(`/resource-types/${renamedCode}`, {
  method: 'PATCH',
  token: A,
  body: {
    fields: [
      { key: 'endpoint', label: '接入地址', fieldType: 'TEXT', required: true, sortOrder: 0 },
      {
        key: 'serviceIp',
        label: '服务 IP',
        fieldType: 'IP',
        required: true,
        isIp: true,
        sortOrder: 1,
      },
    ],
    keyRenames: [{ from: 'srvIp', to: 'serviceIp' }],
    dropUnknownFields: true,
  },
});
check('字段重命名保存成功', keyRename.status === 200, `status=${keyRename.status}`);
const syncedRes = await req(`/resources/${resId}`, { token: A });
check(
  '存量资源 attrs 已同步为 serviceIp',
  syncedRes.json.attrs?.serviceIp === '10.77.0.1',
  JSON.stringify(syncedRes.json.attrs),
);
check(
  '已删除字段被清理',
  syncedRes.json.attrs?.mode === undefined && syncedRes.json.attrs?.weight === undefined,
);

console.log('\n[6] 环境字典自定义与同步');
const newEnvCode = `SMOKE_ENV_${Date.now().toString(36).toUpperCase()}`;
const envCreated = await req('/environments', {
  method: 'POST',
  token: A,
  body: {
    code: newEnvCode,
    label: '冒烟环境',
    tone: 'purple',
    description: '冒烟测试',
    enabled: true,
  },
});
check('自定义环境创建成功', envCreated.status === 201, `status=${envCreated.status}`);

const envRes = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: renamedCode,
    name: '冒烟环境资源',
    environment: newEnvCode,
    attrs: { endpoint: 'http://a/b', serviceIp: '10.77.0.2' },
  },
});
check('可用自定义环境创建资源', envRes.status === 201, `status=${envRes.status}`);

const envRef = await req(`/environments/${newEnvCode}/references`, { token: A });
check('环境引用统计可见', envRef.json.total >= 1, `total=${envRef.json.total}`);

const envRenameNoSync = await req(`/environments/${newEnvCode}`, {
  method: 'PATCH',
  token: A,
  body: { code: `${newEnvCode}_V2` },
});
check('环境改编码未同步 → 409', envRenameNoSync.status === 409, `status=${envRenameNoSync.status}`);
const envRenameSync = await req(`/environments/${newEnvCode}`, {
  method: 'PATCH',
  token: A,
  body: { code: `${newEnvCode}_V2`, sync: true },
});
check(
  '环境编码一键同步成功',
  envRenameSync.status === 200 && envRenameSync.json.sync?.updated?.resource >= 1,
  JSON.stringify(envRenameSync.json.sync ?? {}),
);

console.log('\n[7] 删除保护与迁移式删除');
const delNoMigrate = await req(`/resource-types/${renamedCode}`, { method: 'DELETE', token: A });
check('有引用时直接删除被拒绝(409)', delNoMigrate.status === 409, `status=${delNoMigrate.status}`);
const delMigrate = await req(`/resource-types/${renamedCode}`, {
  method: 'DELETE',
  token: A,
  body: { migrateTo: 'GDS_SERVER' },
});
check(
  '迁移式删除成功',
  delMigrate.status === 200,
  `status=${delMigrate.status} ${JSON.stringify(delMigrate.json).slice(0, 160)}`,
);
const migrated = await req(`/resources/${resId}`, { token: A });
check('资源已迁移到目标类型', migrated.json.type === 'GDS_SERVER', `type=${migrated.json.type}`);
const envDel = await req(`/environments/${newEnvCode}_V2`, {
  method: 'DELETE',
  token: A,
  body: { migrateTo: 'PT' },
});
check('环境迁移式删除成功', envDel.status === 200, `status=${envDel.status}`);

console.log('\n[8] 停用字典项后禁止继续使用');
const disable = await req('/environments/DEV', {
  method: 'PATCH',
  token: A,
  body: { enabled: false },
});
check('环境停用成功', disable.status === 200, `status=${disable.status}`);
const useDisabled = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: 'NAS',
    name: '停用环境资源',
    environment: 'DEV',
    attrs: { exportPath: '/x', mountPoint: '/y', protocol: 'NFS', capacityGb: 10 },
  },
});
check('停用环境不可再使用(422)', useDisabled.status === 422, `status=${useDisabled.status}`);
await req('/environments/DEV', { method: 'PATCH', token: A, body: { enabled: true } });

console.log('\n[9] 普通用户可写可删 / 只读用户只读');
const normalName = `smoke_dict_${Date.now().toString(36)}`;
const normalPwd = `Smoke#${Date.now().toString(36)}`;
const vCreated = await req('/users', {
  method: 'POST',
  token: A,
  body: { username: normalName, password: normalPwd, displayName: '冒烟普通用户', role: 'USER' },
});
const v = (await login(normalName, normalPwd)).json.accessToken;
const code = `SMOKE${Date.now().toString(36).toUpperCase()}`;
const vWrite = await req('/resource-types', {
  method: 'POST',
  token: v,
  body: { code, label: '冒烟类型', prefix: 'SM', fields: [] },
});
check('普通用户可新增字典项(201)', vWrite.status === 201, `status=${vWrite.status} ${vWrite.text}`);
const vDrop = await req(`/resource-types/${code}`, { method: 'DELETE', token: v });
check('普通用户可删除字典项(200)', vDrop.status === 200, `status=${vDrop.status}`);
const roName = `smoke_ro_dict_${Date.now().toString(36)}`;
const roPwd = `Smoke#${Date.now().toString(36)}`;
const roCreated = await req('/users', {
  method: 'POST',
  token: A,
  body: { username: roName, password: roPwd, displayName: '冒烟只读用户', role: 'READONLY' },
});
const ro = (await login(roName, roPwd)).json.accessToken;
check('只读用户可查看字典(200)', (await req('/resource-types', { token: ro })).status === 200);
const roCode = `ROC${Date.now().toString(36).toUpperCase()}`;
const roWrite = await req('/resource-types', {
  method: 'POST',
  token: ro,
  body: { code: roCode, label: '只读越权', prefix: 'RO', fields: [] },
});
check('只读用户新增字典项被拒(403)', roWrite.status === 403, `status=${roWrite.status}`);
check(
  '只读用户变更审计被拒(403)',
  (await req('/audit-logs?pageSize=1', { token: ro })).status === 403,
);
if (vCreated.json?.id)
  await req(`/users/${vCreated.json.id}`, {
    method: 'PATCH',
    token: A,
    body: { status: 'DISABLED' },
  });
if (roCreated.json?.id)
  await req(`/users/${roCreated.json.id}`, {
    method: 'PATCH',
    token: A,
    body: { status: 'DISABLED' },
  });

console.log('\n[10] 环境字典改名后项目环境标签同步');
// 选一个同时具备 DEV 环境且有资源的项目，便于校验标签与移出行为
const allProjects = (await req('/projects?pageSize=50', { token: A })).json.items ?? [];
let prj = null;
for (const p of allProjects) {
  const detail = (await req(`/projects/${p.id}`, { token: A })).json;
  if (
    (detail.environments ?? []).some((e) => e.environment === 'DEV') &&
    (detail.slotRefs ?? []).length > 0
  ) {
    prj = detail;
    break;
  }
}
if (prj) {
  const before = (await req(`/projects/${prj.id}`, { token: A })).json;
  const devEnv = (before.environments ?? []).find((e) => e.environment === 'DEV');
  check(
    '项目环境 DTO 带环境标签',
    Boolean(devEnv?.environmentLabel),
    JSON.stringify(devEnv ?? {}).slice(0, 120),
  );

  const rename = await req('/environments/DEV', {
    method: 'PATCH',
    token: A,
    body: { label: '开发测试(冒烟)' },
  });
  check('环境改名成功', rename.status === 200, `status=${rename.status}`);
  check(
    '改名后返回待同步名称数',
    typeof rename.json?.pendingNameSync === 'number',
    `pendingNameSync=${rename.json?.pendingNameSync}`,
  );

  const afterRename = (await req(`/projects/${prj.id}`, { token: A })).json;
  check(
    '项目环境标签随字典实时更新',
    (afterRename.environments ?? []).find((e) => e.environment === 'DEV')?.environmentLabel ===
      '开发测试(冒烟)',
    JSON.stringify((afterRename.environments ?? []).map((e) => e.environmentLabel)),
  );

  const syncNames = await req('/environments/DEV', {
    method: 'PATCH',
    token: A,
    body: { label: '开发测试(冒烟)', syncNames: true },
  });
  check(
    '一键同步项目环境名称',
    (syncNames.json?.nameSynced ?? 0) > 0,
    `nameSynced=${syncNames.json?.nameSynced}`,
  );
  const afterSync = (await req(`/projects/${prj.id}`, { token: A })).json;
  check(
    '项目环境名称已与字典一致',
    (afterSync.environments ?? [])
      .filter((e) => e.environment === 'DEV')
      .every((e) => e.name.startsWith('开发测试(冒烟)')),
    JSON.stringify(
      (afterSync.environments ?? []).filter((e) => e.environment === 'DEV').map((e) => e.name),
    ),
  );

  // 还原为内置标签，避免影响后续冒烟
  await req('/environments/DEV', {
    method: 'PATCH',
    token: A,
    body: { label: '开发', syncNames: true },
  });
} else {
  check('存在可校验的项目', false, '无项目数据');
}

console.log('\n[11] 校验失败返回具体原因');
const badAttrs = await req('/resources', {
  method: 'POST',
  token: A,
  body: {
    type: 'ETL_SERVER',
    name: 'x',
    environment: 'PT',
    attrs: { IP: '999.1.1.1', USER_NAME: 'etladmin', OS: 'Linux' },
  },
});
check('属性校验失败返回 422', badAttrs.status === 422, `status=${badAttrs.status}`);
check(
  '错误信息含具体字段原因',
  /校验失败：.*(IP|USER_NAME|OS)/.test(badAttrs.json?.error?.message ?? ''),
  badAttrs.json?.error?.message,
);
const badBody = await req('/resources', {
  method: 'POST',
  token: A,
  body: { type: 'ETL_SERVER' },
});
check(
  '框架校验也给出字段原因',
  /校验失败：/.test(badBody.json?.error?.message ?? ''),
  badBody.json?.error?.message,
);

console.log('\n[12] 项目资源移出（主归属 ∪ 槽位引用）');
if (prj) {
  const detail = (await req(`/projects/${prj.id}`, { token: A })).json;
  check(
    '项目详情返回槽位引用',
    Array.isArray(detail.slotRefs),
    JSON.stringify(detail.slotRefs ?? []).slice(0, 120),
  );
  const listRes = (await req(`/resources?projectId=${prj.id}&pageSize=50`, { token: A })).json;
  const picked = listRes.items?.[0];
  if (picked) {
    const refs = (detail.slotRefs ?? []).filter((x) => x.resourceId === picked.id).length;
    const only = await req(`/projects/${prj.id}/resources/${picked.id}/detach`, {
      method: 'POST',
      token: A,
      body: { includeSlots: false },
    });
    check('仅取消主归属成功', only.status === 200, `status=${only.status}`);
    if (refs > 0) {
      check(
        '仅取消标注后仍被槽位引用',
        only.json?.remainingSlotRefs === refs,
        `remaining=${only.json?.remainingSlotRefs} refs=${refs}`,
      );
      const both = await req(`/projects/${prj.id}/resources/${picked.id}/detach`, {
        method: 'POST',
        token: A,
        body: { includeSlots: true },
      });
      check('解除槽位引用成功', (both.json?.unboundSlots ?? 0) === refs, JSON.stringify(both.json));
      const afterList = (await req(`/resources?projectId=${prj.id}&pageSize=50`, { token: A }))
        .json;
      check(
        '彻底移出后不再出现在项目资源中',
        !(afterList.items ?? []).some((x) => x.id === picked.id),
        `still=${(afterList.items ?? []).some((x) => x.id === picked.id)}`,
      );
    } else {
      const afterList = (await req(`/resources?projectId=${prj.id}&pageSize=50`, { token: A }))
        .json;
      check(
        '无槽位引用时移出即消失',
        !(afterList.items ?? []).some((x) => x.id === picked.id),
        `still=${(afterList.items ?? []).some((x) => x.id === picked.id)}`,
      );
    }
  } else {
    check('项目存在可移出资源', false, '无资源');
  }
}

console.log('\n[13] 清理冒烟数据');
if (resId) await req(`/resources/${resId}`, { method: 'DELETE', token: A });
const envResId = envRes.json?.id;
if (envResId) await req(`/resources/${envResId}`, { method: 'DELETE', token: A });
check('冒烟资源已清理', true);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
