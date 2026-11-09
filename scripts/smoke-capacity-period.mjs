/**
 * 冒烟测试：容量按时间段计算
 *
 * 业务规则：同一资源可被多个项目在不同时间段占用
 *  - 时间段**不重叠** → 各自都能用到资源的最大容量（错峰复用，不累加）
 *  - 时间段**重叠**   → 同一时刻的占用为各方之和，超过总容量即拒绝
 *  - 未给时间段       → 视为长期占用，与所有占用重叠
 *
 * 覆盖：
 *  1. 错峰占用：A 占 1 段、B 占另一段，都能拿到满容量
 *  2. 资源详情给出「合计占用」与「峰值占用」两个口径，峰值 ≤ 总容量
 *  3. 峰值时段与明细（项目 / 环境 / 槽位 / 起止）
 *  4. 重叠占用求和超额 → 409，且错误详情带峰值口径
 *  5. 空档期可继续占用
 *  6. 长期占用（无时间段）与全部占用重叠 → 拒绝
 *  7. 时间轴占用曲线
 */

import { ADMIN_USERNAME, BASE, adminPassword } from './lib/smoke-env.mjs';

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
  username: ADMIN_USERNAME,
  password: adminPassword('smoke-capacity-period'),
};

const login = await req('/auth/login', { method: 'POST', body: ADMIN });
if (!login.json?.accessToken) {
  console.log('登录失败，无法执行冒烟：', login.text);
  process.exit(1);
}
const A = login.json.accessToken;

/** 相对今天偏移若干天的日期（YYYY-MM-DD） */
const day = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
/** 服务端按本地时区存日期，UTC 串可能相差一天，这里容忍 1 天误差 */
const sameDayish = (a, b) => {
  if (!a || !b) return false;
  return Math.abs((new Date(a.slice(0, 10)) - new Date(b)) / 86400000) <= 1;
};

const stamp = Date.now().toString().slice(-6);

/* ------------------------------------------------------------------ *
 * [0] 准备：一个 1000GB 的资源 + 三个项目（各一个环境与存储槽位）
 * ------------------------------------------------------------------ */
console.log('\n[0] 准备测试数据');
const nas = (
  await req('/resources', {
    method: 'POST',
    token: A,
    body: {
      type: 'NAS',
      name: `冒烟时段容量-${stamp}`,
      environment: 'PT',
      capacityTotal: 1000,
      capacityUnit: 'GB',
      attrs: {
        NAS_URL: 'nfs://nas-smoke/vol/smoke',
        USEAGE: 'SOURCE_NAS',
        REMARK_NOTE: '/mnt/smoke',
      },
    },
  })
).json;
ok(Boolean(nas?.id), `容量资源创建成功（${nas.code} / 1000 GB）`);

async function makeProject(name) {
  const project = (
    await req('/projects', { method: 'POST', token: A, body: { name, owner: '冒烟' } })
  ).json;
  const env = (
    await req(`/projects/${project.id}/environments`, {
      method: 'POST',
      token: A,
      body: { name: '开发环境', environment: 'DEV' },
    })
  ).json;
  const withSlot = (
    await req(`/project-environments/${env.id}/slots`, {
      method: 'POST',
      token: A,
      body: { resourceType: 'NAS', slotRole: '存储槽位' },
    })
  ).json;
  return { project, env, slot: withSlot.slots.find((s) => s.slotRole === '存储槽位') };
}

const ctxA = await makeProject(`冒烟时段A-${stamp}`);
const ctxB = await makeProject(`冒烟时段B-${stamp}`);
const ctxC = await makeProject(`冒烟时段C-${stamp}`);
ok(Boolean(ctxA.slot?.id && ctxB.slot?.id && ctxC.slot?.id), '三个项目环境槽位就绪');

/* ------------------------------------------------------------------ *
 * [1] 错峰占用：两个不重叠的时间段都能占满容量
 * ------------------------------------------------------------------ */
console.log('\n[1] 不重叠时间段各自可用最大容量');
const bindA = await req(`/project-environments/${ctxA.env.id}/slots/${ctxA.slot.id}/assign`, {
  method: 'POST',
  token: A,
  body: {
    resourceId: nas.id,
    amount: 1000,
    startAt: day(-300),
    endAt: day(-150),
    acknowledge: true,
  },
});
ok(bindA.status === 200, `A 项目占用 1000GB（${day(-300)} → ${day(-150)}）成功`, bindA.text);
ok(bindA.json?.slot?.demandAmount === 1000, 'A 槽位记录申请容量 1000');

const bindB = await req(`/project-environments/${ctxB.env.id}/slots/${ctxB.slot.id}/assign`, {
  method: 'POST',
  token: A,
  body: {
    resourceId: nas.id,
    amount: 1000,
    startAt: day(-140),
    endAt: day(-10),
    acknowledge: true,
  },
});
ok(bindB.status === 200, `B 项目错峰占用 1000GB（${day(-140)} → ${day(-10)}）成功`, bindB.text);
ok(bindB.json?.slot?.demandAmount === 1000, 'B 项目拿到满容量（错峰不累加，未被 A 的占用挤占）');

/* ------------------------------------------------------------------ *
 * [2] 详情给出「合计」与「峰值」两个口径
 * ------------------------------------------------------------------ */
console.log('\n[2] 资源详情的容量口径');
const detail = (await req(`/resources/${nas.id}`, { token: A })).json;
const cap = detail?.capacity;
ok(cap?.total === 1000, `总容量 1000（实际 ${cap?.total}）`);
ok(cap?.allocated === 2000, `不分时段合计占用 2000（实际 ${cap?.allocated}）`);
ok(cap?.peak?.amount === 1000, `按时间段的峰值占用为 1000（实际 ${cap?.peak?.amount}）`);
ok(cap?.peakAvailable === 0, `峰值口径剩余 0（实际 ${cap?.peakAvailable}）`);
ok(
  sameDayish(cap?.peak?.startAt, day(-300)) && sameDayish(cap?.peak?.endAt, day(-150)),
  `峰值时段落在 A 的占用区间（实际 ${cap?.peak?.startAt?.slice(0, 10)} → ${cap?.peak?.endAt?.slice(0, 10)}）`,
);
ok(
  cap?.peak?.slotCount === 1 && cap?.peak?.items?.length === 1,
  `峰值时刻只有 1 个占用生效（实际 ${cap?.peak?.slotCount}）`,
);
ok(
  cap?.peak?.items?.[0]?.projectName?.includes('冒烟时段A'),
  `峰值明细指向 A 项目（实际 ${cap?.peak?.items?.[0]?.projectName}）`,
);

/* ------------------------------------------------------------------ *
 * [3] 重叠占用求和：超容量被拒绝
 * ------------------------------------------------------------------ */
console.log('\n[3] 时间段重叠时占用求和，超额被拒绝');
const clash = await req(`/project-environments/${ctxC.env.id}/slots/${ctxC.slot.id}/assign`, {
  method: 'POST',
  token: A,
  body: {
    resourceId: nas.id,
    amount: 200,
    startAt: day(-200),
    endAt: day(-180),
    acknowledge: true,
  },
});
ok(clash.status === 409, `与 A 重叠的 200GB 被拒绝（409，实际 ${clash.status}）`);
ok(clash.json?.error?.details?.code === 'CAPACITY_EXCEEDED', '错误类型为 CAPACITY_EXCEEDED');
ok(
  clash.json?.error?.details?.available === 0,
  `提示该时段剩余 0（实际 ${clash.json?.error?.details?.available}）`,
);
ok(
  clash.json?.error?.details?.peak?.amount === 1000,
  `错误详情带峰值口径 ${clash.json?.error?.details?.peak?.amount}`,
);
ok((clash.json?.error?.message ?? '').includes('超出'), '错误信息可读');

/* ------------------------------------------------------------------ *
 * [4] 空档期可继续占用
 * ------------------------------------------------------------------ */
console.log('\n[4] 空档期（A 已结束、B 未开始）可继续占用');
const gap = await req(`/project-environments/${ctxC.env.id}/slots/${ctxC.slot.id}/assign`, {
  method: 'POST',
  token: A,
  body: {
    resourceId: nas.id,
    amount: 300,
    startAt: day(-149),
    endAt: day(-141),
    acknowledge: true,
  },
});
ok(gap.status === 200, `空档期占用 300GB 成功（${day(-149)} → ${day(-141)}）`, gap.text);
const afterGap = (await req(`/resources/${nas.id}`, { token: A })).json;
ok(
  afterGap?.capacity?.peak?.amount === 1000,
  `空档期占用后峰值仍为 1000（实际 ${afterGap?.capacity?.peak?.amount}）`,
);
ok(
  afterGap?.capacity?.allocated === 2300,
  `合计占用升至 2300（实际 ${afterGap?.capacity?.allocated}）`,
);

/* ------------------------------------------------------------------ *
 * [5] 长期占用（无时间段）与全部占用重叠
 * ------------------------------------------------------------------ */
console.log('\n[5] 未填时间段视为长期占用（默认从今天起，与当前生效的占用重叠）');
const ctxD = await makeProject(`冒烟时段D-${stamp}`);
ok(Boolean(ctxD.slot?.id), 'D 项目槽位就绪（此前未绑定资源）');
// 先造一个「当前正在生效」的满容量占用：覆盖今天
// 注意：结束时间按当天 23:59:59 解析，起点需晚于上一段的结束日（B 结束于 day(-10)）
const current = await req(`/project-environments/${ctxD.env.id}/slots/${ctxD.slot.id}/assign`, {
  method: 'POST',
  token: A,
  body: { resourceId: nas.id, amount: 1000, startAt: day(-9), endAt: day(30), acknowledge: true },
});
ok(current.status === 200, `覆盖今天的占用 1000GB 成功（${day(-9)} → ${day(30)}）`, current.text);

// 再以「不填时间段」的方式申请：默认从今天起长期占用，必然与上面的占用重叠
const ctxE = await makeProject(`冒烟时段E-${stamp}`);
const forever = await req(`/project-environments/${ctxE.env.id}/slots/${ctxE.slot.id}/assign`, {
  method: 'POST',
  token: A,
  body: { resourceId: nas.id, amount: 500, acknowledge: true },
});
ok(forever.status === 409, `长期占用 500GB 被拒绝（409，实际 ${forever.status}）`);
ok(
  forever.json?.error?.details?.available === 0,
  `长期占用与当前占用重叠，剩余 0（实际 ${forever.json?.error?.details?.available}）`,
);

/* ------------------------------------------------------------------ *
 * [6] 时间轴占用曲线
 * ------------------------------------------------------------------ */
console.log('\n[6] 时间轴占用曲线');
const curve = afterGap?.capacity?.peak?.curve ?? [];
ok(curve.length >= 3, `曲线包含多个区间（实际 ${curve.length} 段）`);
ok(
  curve.some((c) => c.amount === 1000),
  '曲线中存在占用 1000 的区间（A 与 B 各自占满的时段）',
);
ok(
  curve.some((c) => c.amount === 0),
  '曲线中存在空闲区间（错峰可复用的来源）',
);
ok(
  curve.every((c) => c.amount <= 1000),
  '曲线上任一时刻都不超过总容量',
);

/* ------------------------------------------------------------------ *
 * [7] 台账列表与资源详情口径一致
 * ------------------------------------------------------------------ */
console.log('\n[7] 台账容量列 = 详情峰值口径');
const listed = (await req('/resources?pageSize=100', { token: A })).json;
const row = (listed?.items ?? []).find((r) => r.id === nas.id);
ok(Boolean(row), '台账里能查到该资源');
ok(row?.capacityPeak === 1000, `台账展示峰值 1000（实际 ${row?.capacityPeak}）`);
ok(row?.capacityAllocated === 3300, `台账合计口径仍为 3300（实际 ${row?.capacityAllocated}）`);
const detail2 = (await req(`/resources/${nas.id}`, { token: A })).json;
ok(
  row?.capacityPeak === detail2?.capacity?.peak?.amount,
  `台账峰值与详情 peak 完全一致（${row?.capacityPeak} vs ${detail2?.capacity?.peak?.amount}）`,
);
ok(
  row?.capacityPeakAvailable === detail2?.capacity?.peakAvailable,
  `台账峰值剩余与详情一致（${row?.capacityPeakAvailable} vs ${detail2?.capacity?.peakAvailable}）`,
);

/* ------------------------------------------------------------------ *
 * [8] 字典：环境引用明细带项目名
 * ------------------------------------------------------------------ */
console.log('\n[8] 字典环境引用带项目名');
const envRefs = (await req('/environments/DEV/references', { token: A })).json;
const projEnvGroup = (envRefs?.groups ?? []).find((g) => g.entity === 'PROJECT_ENV');
ok(Boolean(projEnvGroup), `DEV 环境有项目环境引用（${projEnvGroup?.count ?? 0} 处）`);
ok(
  (projEnvGroup?.samples ?? []).length > 0 &&
    (projEnvGroup?.samples ?? []).every((s) => / · /.test(s.name)),
  `引用明细带项目名（样例：${(projEnvGroup?.samples ?? [])[0]?.name ?? '无'}）`,
);
// 样例只取前 8 条，这里校验「每条都能落到具体项目」，而不是依赖排序
const knownProjects = new Set(
  (await req('/projects?pageSize=200', { token: A })).json.items.map((p) => p.name),
);
ok(
  (projEnvGroup?.samples ?? []).every((s) => {
    const head = s.name.split(' · ')[0];
    return head === '未归属项目' || knownProjects.has(head);
  }),
  `每条引用都能定位到具体项目（样例：${(projEnvGroup?.samples ?? [])[0]?.name ?? '无'}）`,
);
const typeRefs = (await req('/resource-types/NAS/references', { token: A })).json;
const slotGroup = (typeRefs?.groups ?? []).find((g) => g.entity === 'ENV_SLOT');
ok(
  (slotGroup?.samples ?? []).every((s) => / · /.test(s.name)),
  `资源类型引用的槽位也带项目名（样例：${(slotGroup?.samples ?? [])[0]?.name ?? '无'}）`,
);

/* ------------------------------------------------------------------ *
 * 清理
 * ------------------------------------------------------------------ */
console.log('\n[9] 清理冒烟数据');
for (const ctx of [ctxA, ctxB, ctxC, ctxD, ctxE]) {
  // 顺序：解绑槽位 → 删除环境 → 删除项目（项目下仍有环境时不允许删除）
  const unbound = await req(`/project-environments/${ctx.env.id}/slots/${ctx.slot.id}/assign`, {
    method: 'DELETE',
    token: A,
  });
  const envRemoved = await req(`/project-environments/${ctx.env.id}`, {
    method: 'DELETE',
    token: A,
  });
  const removed = await req(`/projects/${ctx.project.id}`, { method: 'DELETE', token: A });
  ok(
    removed.status === 200,
    `项目 ${ctx.project.name} 已清理`,
    removed.status === 200
      ? undefined
      : `解绑 ${unbound.status} / 删环境 ${envRemoved.status} / 删项目 ${removed.status} ${removed.text}`,
  );
}
const delRes = await req(`/resources/${nas.id}`, { method: 'DELETE', token: A });
ok(delRes.status === 200, `冒烟资源已清理（${delRes.status}）`);

console.log(`\n—— 容量按时段计算冒烟：${passed} 通过 / ${failed} 失败 ——`);
process.exit(failed > 0 ? 1 : 0);
