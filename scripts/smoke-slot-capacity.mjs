/**
 * 冒烟测试：槽位维护 + 引用提示 + 跨环境引用 + 容量管理
 *
 * 覆盖：
 *  1. 项目环境槽位的删除
 *  2. 引用资源时「已被其他项目占用」的提示与明细
 *  3. 跨环境引用（准生产引用开发资源）需确认后放行
 *  4. 资源台账可查看被哪些项目 / 环境引用
 *  5. 容量：槽位申请必填且不可超额、调小容量时校验现有占用、台账显示容量明细
 *  6. 环境字典为 DEV / PT / UAT，且不再标记内置
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

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  return { status: res.status, json, text };
}

const ADMIN = {
  username: process.env.SMOKE_ADMIN_USER ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'Admin@12345',
};

const A = (await req('/auth/login', { method: 'POST', body: ADMIN })).json.accessToken;

/* ------------------------------------------------------------------ *
 * [1] 环境字典（不再内置）
 * ------------------------------------------------------------------ */
console.log('\n[1] 环境字典为 DEV / PT / UAT');
const envs = (await req('/environments?includeDisabled=true', { token: A })).json;
const codes = envs.map((e) => e.code);
ok(['DEV', 'PT', 'UAT'].every((c) => codes.includes(c)), `环境字典齐全（${codes.join('/')}）`);
const dev = envs.find((e) => e.code === 'DEV');
const pt = envs.find((e) => e.code === 'PT');
const uat = envs.find((e) => e.code === 'UAT');
ok(dev?.builtin === false && Boolean(dev?.label), `DEV 为非内置且有显示名（${dev?.label}）`);
ok(pt?.builtin === false && Boolean(pt?.label), `PT 为非内置且有显示名（${pt?.label}）`);
ok(uat?.builtin === false && Boolean(uat?.label), `UAT 为非内置且有显示名（${uat?.label}）`);
const prod = envs.find((e) => e.code === 'PROD');
ok(prod?.builtin === false && prod?.label === '生产', `PROD 为非内置生产环境（${prod?.label}）`);
ok(envs.every((e) => /^#[0-9a-f]{6}$/.test(e.color ?? '')), '环境字典均带 #rrggbb 标识色');

/* ------------------------------------------------------------------ *
 * [2] 准备：两个项目、各自环境
 * ------------------------------------------------------------------ */
console.log('\n[2] 准备测试项目与环境');
const stamp = Date.now().toString().slice(-6);
const pA = (
  await req('/projects', {
    method: 'POST',
    token: A,
    body: { name: `冒烟项目A-${stamp}`, owner: '冒烟', description: '槽位与容量冒烟' },
  })
).json;
const pB = (
  await req('/projects', {
    method: 'POST',
    token: A,
    body: { name: `冒烟项目B-${stamp}`, owner: '冒烟', description: '跨项目占用冒烟' },
  })
).json;
ok(Boolean(pA?.id && pB?.id), '两个测试项目创建成功');

const envA = (
  await req(`/projects/${pA.id}/environments`, {
    method: 'POST',
    token: A,
    body: { name: '产品测试环境', environment: 'PT' },
  })
).json;
const envB = (
  await req(`/projects/${pB.id}/environments`, {
    method: 'POST',
    token: A,
    body: { name: '开发环境', environment: 'DEV' },
  })
).json;
ok(Boolean(envA?.id && envB?.id), '项目环境创建成功（PT / DEV）');

/* ------------------------------------------------------------------ *
 * [3] 带容量的资源
 * ------------------------------------------------------------------ */
console.log('\n[3] 创建带容量的资源');
const nas = (
  await req('/resources', {
    method: 'POST',
    token: A,
    body: {
      type: 'NAS',
      name: `冒烟共享存储-${stamp}`,
      environment: 'PT',
      capacityTotal: 1000,
      capacityUnit: 'GB',
      attrs: {
        clusterName: 'SMOKE-NAS',
        exportPath: '/vol/smoke',
        mountPoint: '/mnt/smoke',
        protocol: 'NFS',
        capacityGb: 1000,
        usedGb: 0,
        rwMode: 'RW',
      },
    },
  })
).json;
ok(Boolean(nas?.id), `容量资源创建成功（${nas.code}）`);
ok(nas.capacityTotal === 1000 && nas.capacityUnit === 'GB', '容量字段正确落库');
ok(nas.capacityAllocated === 0 && nas.capacityAvailable === 1000, '初始占用为 0、可用为 1000');

/* ------------------------------------------------------------------ *
 * [4] 槽位：新增 → 分配 → 删除
 * ------------------------------------------------------------------ */
console.log('\n[4] 槽位新增 / 分配 / 删除');
let envADetail = (
  await req(`/project-environments/${envA.id}/slots`, {
    method: 'POST',
    token: A,
    body: { resourceType: 'NAS', slotRole: '冒烟存储槽位' },
  })
).json;
const slot = envADetail.slots.find((s) => s.slotRole === '冒烟存储槽位');
ok(Boolean(slot?.id), '手动新增槽位成功');

const slotCountBefore = envADetail.slots.length;
const delSlot = await req(`/project-environments/${envA.id}/slots/${slot.id}`, {
  method: 'DELETE',
  token: A,
});
ok(delSlot.status === 200, '删除槽位返回 200');
const afterDel = (await req(`/project-environments/${envA.id}`, { token: A })).json;
ok(afterDel.slots.length === slotCountBefore - 1, `槽位数量从 ${slotCountBefore} 减到 ${afterDel.slots.length}`);
ok(
  !afterDel.slots.some((s) => s.id === slot.id),
  '被删除的槽位不再出现在环境详情中',
);

/* ------------------------------------------------------------------ *
 * [5] 容量：必填 / 不可超额 / 占用后可调
 * ------------------------------------------------------------------ */
console.log('\n[5] 容量申请与超额校验');
envADetail = (
  await req(`/project-environments/${envA.id}/slots`, {
    method: 'POST',
    token: A,
    body: { resourceType: 'NAS', slotRole: '冒烟存储槽位' },
  })
).json;
const capSlot = envADetail.slots.find((s) => s.slotRole === '冒烟存储槽位');

const noAmount = await req(`/project-environments/${envA.id}/slots/${capSlot.id}/assign`, {
  method: 'POST',
  token: A,
  body: { resourceId: nas.id },
});
ok(noAmount.status === 409, `不填申请容量被拒绝（409，实际 ${noAmount.status}）`);
ok(
  (noAmount.json?.error?.details?.warnings ?? []).some((w) => w.code === 'CAPACITY_REQUIRED'),
  '提示类型为 CAPACITY_REQUIRED',
);

const over = await req(`/project-environments/${envA.id}/slots/${capSlot.id}/assign`, {
  method: 'POST',
  token: A,
  body: { resourceId: nas.id, amount: 1001 },
});
ok(over.status === 409, `超额申请被拒绝（409，实际 ${over.status}）`);
ok(
  (over.json?.error?.details?.warnings ?? []).some((w) => w.code === 'CAPACITY_EXCEEDED'),
  '提示类型为 CAPACITY_EXCEEDED',
);

const good = await req(`/project-environments/${envA.id}/slots/${capSlot.id}/assign`, {
  method: 'POST',
  token: A,
  body: { resourceId: nas.id, amount: 300, acknowledge: true },
});
ok(good.status === 200, `正常申请 300 成功（${good.status}）`);
ok(good.json?.slot?.demandAmount === 300, '槽位记录了申请容量 300');

const nasAfter = (await req(`/resources/${nas.id}`, { token: A })).json;
ok(nasAfter.capacity?.allocated === 300, `资源已占用 300（实际 ${nasAfter.capacity?.allocated}）`);
ok(nasAfter.capacity?.available === 700, `资源剩余 700（实际 ${nasAfter.capacity?.available}）`);

/* ------------------------------------------------------------------ *
 * [6] 调整容量需满足现有占用
 * ------------------------------------------------------------------ */
console.log('\n[6] 调整容量的校验');
const tooLow = await req(`/resources/${nas.id}`, {
  method: 'PATCH',
  token: A,
  body: { capacityTotal: 100 },
});
ok(tooLow.status === 409, `调小到 100 被拒绝（409，实际 ${tooLow.status}）`);
ok(
  Array.isArray(tooLow.json?.error?.details?.references) &&
    tooLow.json.error.details.references.length > 0,
  '返回了占用明细（谁占用了多少）',
);
ok(tooLow.json?.error?.details?.shortage === 200, `缺口计算正确（${tooLow.json?.error?.details?.shortage}）`);

const bigger = await req(`/resources/${nas.id}`, {
  method: 'PATCH',
  token: A,
  body: { capacityTotal: 2000 },
});
ok(bigger.status === 200, `调大到 2000 成功（${bigger.status}）`);
ok(bigger.json.capacityAvailable === 1700, `调大后剩余 1700（实际 ${bigger.json.capacityAvailable}）`);

const clearWhileUsed = await req(`/resources/${nas.id}`, {
  method: 'PATCH',
  token: A,
  body: { capacityTotal: null },
});
ok(clearWhileUsed.status === 409, `仍有占用时取消容量被拒绝（409，实际 ${clearWhileUsed.status}）`);

/* ------------------------------------------------------------------ *
 * [7] 跨项目占用提示
 * ------------------------------------------------------------------ */
console.log('\n[7] 已被其他项目占用时的提示');
const envBDetail = (
  await req(`/project-environments/${envB.id}/slots`, {
    method: 'POST',
    token: A,
    body: { resourceType: 'NAS', slotRole: '跨项目槽位' },
  })
).json;
const slotB = envBDetail.slots.find((s) => s.slotRole === '跨项目槽位');

const candB = (await req(`/project-environments/${envB.id}/slots/${slotB.id}/candidates`, { token: A })).json;
const usedItem = candB.items.find((c) => c.resource.id === nas.id);
ok(Boolean(usedItem), '候选列表中包含该资源');
ok(usedItem?.usedByOtherProject === true, '标记为「已被其他项目引用」');
ok(
  (usedItem?.usedBy ?? []).some((u) => u.projectName === pA.name),
  `占用明细包含项目 A（${usedItem?.usedBy?.[0]?.projectName}）`,
);

const bindUsed = await req(`/project-environments/${envB.id}/slots/${slotB.id}/assign`, {
  method: 'POST',
  token: A,
  body: { resourceId: nas.id, amount: 200 },
});
ok(bindUsed.status === 409, `跨项目占用时直接绑定被拒绝（409，实际 ${bindUsed.status}）`);
ok(
  (bindUsed.json?.error?.details?.warnings ?? []).some((w) => w.code === 'USED_BY_OTHER_PROJECT'),
  '提示类型为 USED_BY_OTHER_PROJECT',
);

const bindAck = await req(`/project-environments/${envB.id}/slots/${slotB.id}/assign`, {
  method: 'POST',
  token: A,
  body: { resourceId: nas.id, amount: 200, acknowledge: true },
});
ok(bindAck.status === 200, `确认后可跨项目共享引用（${bindAck.status}）`);

/* ------------------------------------------------------------------ *
 * [8] 跨环境引用提示
 * ------------------------------------------------------------------ */
console.log('\n[8] 跨环境引用（DEV 环境引用 PT 资源）');
// 单独开一个槽位，避免覆盖上一节已建立的跨项目引用
const envBWithCross = (
  await req(`/project-environments/${envB.id}/slots`, {
    method: 'POST',
    token: A,
    body: { resourceType: 'NAS', slotRole: '跨环境槽位' },
  })
).json;
const crossSlot = envBWithCross.slots.find((s) => s.slotRole === '跨环境槽位');
const candCross = (await req(`/project-environments/${envB.id}/slots/${crossSlot.id}/candidates`, { token: A })).json;
const crossItem = candCross.items.find((c) => c.crossEnvironment);
ok(Boolean(crossItem), '候选列表中存在跨环境资源');
ok(
  (crossItem?.warnings ?? []).some((w) => w.code === 'CROSS_ENVIRONMENT'),
  '候选已标注 CROSS_ENVIRONMENT',
);
const crossId = crossItem?.resource?.id;
if (crossId) {
  const cross = await req(`/project-environments/${envB.id}/slots/${crossSlot.id}/assign`, {
    method: 'POST',
    token: A,
    body: { resourceId: crossId, amount: null },
  });
  ok(cross.status === 409, `跨环境直接绑定被拒绝（409，实际 ${cross.status}）`);
  const crossAck = await req(`/project-environments/${envB.id}/slots/${crossSlot.id}/assign`, {
    method: 'POST',
    token: A,
    body: {
      resourceId: crossId,
      // 资源设了容量时必须给出申请量，否则会因容量必填被拒
      amount: crossItem?.demandRequired ? 10 : null,
      acknowledge: true,
    },
  });
  ok(crossAck.status === 200, `确认后跨环境引用成功（${crossAck.status}）`);
}

/* ------------------------------------------------------------------ *
 * [9] 台账查看引用明细
 * ------------------------------------------------------------------ */
console.log('\n[9] 资源台账的引用明细');
const detail = (await req(`/resources/${nas.id}`, { token: A })).json;
ok(Array.isArray(detail.references) && detail.references.length >= 2, `引用明细 ≥2 条（${detail.references.length}）`);
ok(
  detail.references.some((r) => r.projectName === pA.name && r.envName === '产品测试环境'),
  '明细含项目 A 的产品测试环境',
);
ok(
  detail.references.some((r) => r.projectName === pB.name && r.environment === 'DEV'),
  '明细含项目 B 的开发环境（跨项目 + 跨环境）',
);
ok(
  detail.capacityByProject?.length >= 2,
  `按项目聚合占用 ≥2 组（${detail.capacityByProject?.length}）`,
);
ok(detail.capacity?.allocated === 500, `合计占用 500（实际 ${detail.capacity?.allocated}）`);

const listRow = (await req(`/resources?q=${nas.code}`, { token: A })).json.items?.[0];
ok(listRow?.slotRefCount >= 2, `列表行返回引用槽位数（${listRow?.slotRefCount}）`);
ok(listRow?.capacityTotal === 2000, '列表行返回总容量');

/* ------------------------------------------------------------------ *
 * [10] 解绑释放容量
 * ------------------------------------------------------------------ */
console.log('\n[10] 解绑释放容量');
const un = await req(`/project-environments/${envB.id}/slots/${slotB.id}/assign`, {
  method: 'DELETE',
  token: A,
});
ok(un.status === 200, '解绑成功');
const afterUn = (await req(`/resources/${nas.id}`, { token: A })).json;
ok(afterUn.capacity?.allocated === 300, `解绑后占用回落至 300（实际 ${afterUn.capacity?.allocated}）`);
const clearedSlot = (await req(`/project-environments/${envB.id}`, { token: A })).json.slots.find(
  (s) => s.id === slotB.id,
);
ok(clearedSlot?.demandAmount === null, '解绑后槽位申请量被清空');

/* ------------------------------------------------------------------ *
 * [11] 清理
 * ------------------------------------------------------------------ */
console.log('\n[11] 清理冒烟数据');
await req(`/project-environments/${envA.id}/slots/${capSlot.id}/assign`, { method: 'DELETE', token: A });
await req(`/resources/${nas.id}`, { method: 'DELETE', token: A });
// 项目下有环境时禁止删除，须先删环境，保证脚本可重复执行不残留数据
await req(`/project-environments/${envA.id}`, { method: 'DELETE', token: A });
await req(`/project-environments/${envB.id}`, { method: 'DELETE', token: A });
const delA = await req(`/projects/${pA.id}`, { method: 'DELETE', token: A });
const delB = await req(`/projects/${pB.id}`, { method: 'DELETE', token: A });
ok(delA.status === 200 && delB.status === 200, `冒烟项目已清理（${delA.status}/${delB.status}）`);
const gone = await req(`/resources/${nas.id}`, { token: A });
ok(gone.status === 404, '冒烟资源已清理');

console.log(`\n—— 槽位与容量冒烟：${passed} 通过 / ${failed} 失败 ——`);
process.exit(failed > 0 ? 1 : 0);
