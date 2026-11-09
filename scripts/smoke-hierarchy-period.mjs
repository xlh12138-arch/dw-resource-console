/**
 * 冒烟：资源父子层级（容量同步）+ 占用期限（超期 / 续期 / 释放 / 时间轴）+ 标签与层级筛选
 *
 * 前置：API 已在 8787 运行，且执行过 npm run db:reset && npm run db:seed
 * 运行：node scripts/smoke-hierarchy-period.mjs（口令取自 .env 或 SMOKE_PASSWORD）
 */
import { ADMIN_USERNAME, BASE, adminPassword } from './lib/smoke-env.mjs';

const USER = ADMIN_USERNAME;
const PASSWORD = adminPassword('smoke-hierarchy-period');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      // 有 body 时才声明 content-type，否则 Fastify 会因「空 JSON body」返回 400
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 非 JSON 响应
  }
  return { status: res.status, json };
}

/** 相对今天偏移若干天的 ISO 时间 */
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString();
const day = (days) => iso(days).slice(0, 10);

const suffix = Date.now().toString().slice(-6);

async function main() {
  /* ---------------------------------------------------------------- *
   * [1] 准备：登录 + 项目 + 环境
   * ---------------------------------------------------------------- */
  console.log('\n[1] 准备');
  const login = await req('/auth/login', {
    method: 'POST',
    body: { username: USER, password: PASSWORD },
  });
  if (login.status !== 200) {
    console.error(`  登录失败（${login.status}）：${login.json?.error?.message ?? ''}`);
    process.exit(1);
  }
  const token = login.json.accessToken;
  ok(Boolean(token), '管理员登录成功');

  const project = (
    await req('/projects', {
      method: 'POST',
      token,
      body: {
        name: `层级期限冒烟-${suffix}`,
        owner: '冒烟',
        description: 'smoke: hierarchy & period',
      },
    })
  ).json;
  ok(Boolean(project?.id), `创建项目（${project?.code}）`);

  const env = (
    await req(`/projects/${project.id}/environments`, {
      method: 'POST',
      token,
      body: { name: '层级期限冒烟环境', environment: 'DEV' },
    })
  ).json;
  ok(Boolean(env?.id), `创建项目环境（${env?.name}）`);

  /* ---------------------------------------------------------------- *
   * [2] 父子资源与容量同步
   * ---------------------------------------------------------------- */
  console.log('\n[2] 父子资源：创建 / 继承 / 容量同步');
  const nasAttrs = {
    clusterName: 'SMOKE-CLUSTER',
    exportPath: `/vol/smoke_${suffix}`,
    mountPoint: `/mnt/smoke_${suffix}`,
    protocol: 'NFS',
    capacityGb: 1000,
    usedGb: 0,
    rwMode: 'RW',
  };

  const parent = (
    await req('/resources', {
      method: 'POST',
      token,
      body: {
        type: 'NAS',
        name: `冒烟父存储-${suffix}`,
        environment: 'DEV',
        projectId: project.id,
        tags: ['smoke-hp', 'storage'],
        capacityTotal: 1000,
        capacityUnit: 'GB',
        attrs: nasAttrs,
      },
    })
  ).json;
  ok(
    parent?.capacityTotal === 1000 && parent?.capacityAvailable === 1000,
    '父资源容量 1000 / 剩余 1000',
  );
  ok(
    parent?.childCount === 0 && parent?.childAllocated === 0,
    '父资源初始无子资源、子资源占用为 0',
  );

  // 子资源：只补充少数字段，其余属性应与父资源一致
  const child = (
    await req('/resources', {
      method: 'POST',
      token,
      body: {
        type: 'NAS',
        name: `冒烟子存储-${suffix}`,
        environment: 'DEV',
        parentId: parent.id,
        demandAmount: 200,
        attrs: { mountPoint: `/mnt/smoke_child_${suffix}`, clusterName: 'SMOKE-CHILD' },
      },
    })
  ).json;
  ok(child?.parentId === parent.id, '子资源记录了父资源');
  ok(child?.demandAmount === 200, '子资源申请容量 200');
  ok(child?.capacityTotal === 200, `子资源总容量等于申请额度（${child?.capacityTotal}）`);
  ok(child?.projectId === project.id, '子资源继承父资源的项目归属');
  ok(child?.attrs?.exportPath === nasAttrs.exportPath, '子资源继承父资源的专属属性');
  ok(
    child?.attrs?.mountPoint === nasAttrs.mountPoint,
    '子资源无法覆盖必填属性（挂载点继承父资源）',
  );
  ok(child?.attrs?.clusterName === 'SMOKE-CHILD', '子资源可以补充非必填属性');

  const parentAfterChild = (await req(`/resources/${parent.id}`, { token })).json;
  ok(parentAfterChild?.capacity?.childAllocated === 200, '父资源「其中子资源」为 200');
  ok(
    parentAfterChild?.capacity?.available === 800,
    `父资源剩余 800（实际 ${parentAfterChild?.capacity?.available}）`,
  );
  ok(parentAfterChild?.children?.length === 1, '父资源详情返回 1 个子资源');

  const childDetail = (await req(`/resources/${child.id}`, { token })).json;
  ok(
    childDetail?.ancestors?.length === 1 && childDetail.ancestors[0].id === parent.id,
    '子资源详情返回祖先链',
  );
  ok(
    (await req(`/resources/${parent.id}/children`, { token })).json?.length === 1,
    '子资源列表接口返回 1 条',
  );

  // 超申请：父剩余 800，申请 900 应被拒
  const overChild = await req('/resources', {
    method: 'POST',
    token,
    body: {
      type: 'NAS',
      name: `冒烟超额子-${suffix}`,
      environment: 'DEV',
      parentId: parent.id,
      demandAmount: 900,
    },
  });
  ok(overChild.status === 409, `子资源超额申请被拒绝（409，实际 ${overChild.status}）`);
  ok(overChild.json?.error?.details?.siblingDemand === 200, '超额提示带出了已有子资源申请量');

  // 类型不一致：GDS 资源不能挂在 NAS 父资源下
  const wrongType = await req('/resources', {
    method: 'POST',
    token,
    body: {
      type: 'GDS_SERVER',
      name: `冒烟类型不符-${suffix}`,
      environment: 'DEV',
      parentId: parent.id,
      demandAmount: 10,
    },
  });
  ok(
    wrongType.status === 400 || wrongType.status === 422,
    `子资源类型必须与父一致（实际 ${wrongType.status}）`,
  );

  // 父资源调小到低于子资源申请量
  const shrink = await req(`/resources/${parent.id}`, {
    method: 'PATCH',
    token,
    body: { capacityTotal: 150 },
  });
  ok(shrink.status === 409, `父资源调小到 150 被拒绝（409，实际 ${shrink.status}）`);
  ok(
    Array.isArray(shrink.json?.error?.details?.children) &&
      shrink.json.error.details.children.length === 1,
    '拒绝时返回了子资源明细',
  );

  // 有子资源时不能删除
  const delParent = await req(`/resources/${parent.id}`, { method: 'DELETE', token });
  ok(delParent.status === 409, `有子资源时删除父资源被拒绝（409，实际 ${delParent.status}）`);

  /* ---------------------------------------------------------------- *
   * [3] 槽位占用 + 父容量双向校验
   * ---------------------------------------------------------------- */
  console.log('\n[3] 槽位占用与父子容量联动');
  let envDetail = (
    await req(`/project-environments/${env.id}/slots`, {
      method: 'POST',
      token,
      body: { resourceType: 'NAS', slotRole: '冒烟存储槽位' },
    })
  ).json;
  const slot = envDetail.slots.find((s) => s.slotRole === '冒烟存储槽位');
  ok(Boolean(slot?.id), '新增槽位成功');

  const assign = await req(`/project-environments/${env.id}/slots/${slot.id}/assign`, {
    method: 'POST',
    token,
    body: {
      resourceId: parent.id,
      amount: 300,
      startAt: iso(-60),
      endAt: iso(-10),
      acknowledge: true,
    },
  });
  ok(assign.status === 200, `父资源被槽位申请 300（${assign.status}）`);
  const p2 = (await req(`/resources/${parent.id}`, { token })).json;
  ok(p2?.capacity?.slotAllocated === 300, '父资源「槽位占用」为 300');
  ok(p2?.capacity?.childAllocated === 200, '父资源「子资源占用」仍为 200');
  ok(
    p2?.capacity?.allocated === 500 && p2?.capacity?.available === 500,
    '父资源合计占用 500、剩余 500',
  );

  // 此时子资源申请 600（500 + 600 > 1000）应被拒；申请 400 成功
  const childOver = await req(`/resources/${child.id}`, {
    method: 'PATCH',
    token,
    body: { demandAmount: 800 },
  });
  ok(childOver.status === 409, `子资源调大到 800 被拒绝（409，实际 ${childOver.status}）`);
  ok(childOver.json?.error?.details?.slotAllocated === 300, '拒绝时带出父资源的槽位占用量');

  const childGrow = await req(`/resources/${child.id}`, {
    method: 'PATCH',
    token,
    body: { demandAmount: 400 },
  });
  ok(childGrow.status === 200, `子资源调大到 400 成功（${childGrow.status}）`);
  ok(childGrow.json?.capacityTotal === 400, '子资源总容量随申请额度同步更新');

  const p3 = (await req(`/resources/${parent.id}`, { token })).json;
  ok(p3?.capacity?.allocated === 700, `父资源合计占用 700（实际 ${p3?.capacity?.allocated}）`);

  /* ---------------------------------------------------------------- *
   * [4] 占用期限：超期提示 / 续期 / 转长期 / 测试时间重叠
   * ---------------------------------------------------------------- */
  console.log('\n[4] 占用期限与超期处理');
  const slotAfterAssign = (await req(`/project-environments/${env.id}`, { token })).json.slots.find(
    (s) => s.id === slot.id,
  );
  ok(
    slotAfterAssign?.occupancyState === 'EXPIRED',
    `结束时间已过 → 状态为已超期（${slotAfterAssign?.occupancyState}）`,
  );
  ok(slotAfterAssign?.overdueDays >= 10, `返回超期天数（${slotAfterAssign?.overdueDays} 天）`);
  ok(slotAfterAssign?.resourceId === parent.id, '超期后资源仍未被自动释放');

  const envAfter = (await req(`/project-environments/${env.id}`, { token })).json;
  ok(envAfter?.overdueCount >= 1, `环境详情返回超期数量（${envAfter?.overdueCount}）`);

  const resDetail = (await req(`/resources/${parent.id}`, { token })).json;
  const ref = (resDetail.references ?? []).find((r) => r.slotId === slot.id);
  ok(ref?.occupancyState === 'EXPIRED' && ref?.overdueDays >= 10, '资源详情的引用明细同步超期信息');

  // 时间重叠：新槽位用与已占用区间重叠的时间查候选，应给出 PERIOD_OVERLAP
  const envWithSlot2 = (
    await req(`/project-environments/${env.id}/slots`, {
      method: 'POST',
      token,
      body: { resourceType: 'NAS', slotRole: '冒烟重叠槽位' },
    })
  ).json;
  const slot2 = envWithSlot2.slots.find((s) => s.slotRole === '冒烟重叠槽位');
  const candOverlap = (
    await req(
      `/project-environments/${env.id}/slots/${slot2.id}/candidates?startAt=${day(-30)}&endAt=${day(30)}`,
      { token },
    )
  ).json;
  const candItem = candOverlap.items.find((c) => c.resource.id === parent.id);
  ok(
    (candItem?.warnings ?? []).some((w) => w.code === 'PERIOD_OVERLAP'),
    '候选资源标注了时间重叠（PERIOD_OVERLAP）',
  );

  // 续期：顺延 30 天 → 恢复正常
  const renew = await req(`/project-environments/${env.id}/slots/${slot.id}/renew`, {
    method: 'POST',
    token,
    body: { days: 30 },
  });
  ok(renew.status === 200, `续期成功（${renew.status}）`);
  ok(
    renew.json?.slot?.occupancyState === 'ACTIVE',
    `续期后状态恢复为占用中（${renew.json?.slot?.occupancyState}）`,
  );
  ok(renew.json?.slot?.overdueDays === 0, '续期后超期天数为 0');
  ok(renew.json?.slot?.renewCount === 1, `续期次数累计为 1（${renew.json?.slot?.renewCount}）`);

  // 调整期限：改为长期
  const toForever = await req(`/project-environments/${env.id}/slots/${slot.id}/period`, {
    method: 'PATCH',
    token,
    body: { endAt: null },
  });
  ok(
    toForever.status === 200 && toForever.json?.slot?.endAt === null,
    '可将占用期限调整为长期（endAt 为空）',
  );

  const envTimeline = (await req(`/project-environments/${env.id}/timeline`, { token })).json;
  ok(
    envTimeline?.entries?.length >= 1,
    `环境时间轴返回占用区间（${envTimeline?.entries?.length}）`,
  );
  ok(Boolean(envTimeline?.range?.today), '环境时间轴返回「今天」参考时间');

  const resTimeline = (await req(`/resources/${parent.id}/timeline`, { token })).json;
  ok(
    resTimeline?.entries?.length >= 1,
    `资源时间轴返回占用区间（${resTimeline?.entries?.length}）`,
  );
  ok(resTimeline?.resource?.id === parent.id, '资源时间轴标注了资源本身');
  ok(typeof resTimeline?.expiredCount === 'number', '资源时间轴返回超期数量');

  /* ---------------------------------------------------------------- *
   * [5] 一键释放
   * ---------------------------------------------------------------- */
  console.log('\n[5] 一键释放');
  const release = await req(`/project-environments/${env.id}/slots/${slot.id}/release`, {
    method: 'POST',
    token,
  });
  ok(release.status === 200, `释放成功（${release.status}）`);
  ok(release.json?.slot?.resourceId === null, '释放后槽位不再绑定资源');
  ok(
    release.json?.slot?.endAt === null && release.json?.slot?.occupancyState === null,
    '释放后占用期限被清空',
  );

  const p4 = (await req(`/resources/${parent.id}`, { token })).json;
  ok(p4?.capacity?.slotAllocated === 0, '释放后父资源的槽位占用归零');
  ok(
    p4?.capacity?.allocated === 400,
    `父资源仅剩子资源占用的 400（实际 ${p4?.capacity?.allocated}）`,
  );

  /* ---------------------------------------------------------------- *
   * [6] 标签与层级筛选
   * ---------------------------------------------------------------- */
  console.log('\n[6] 标签与层级筛选');
  const tagList = (await req('/resources/tags', { token })).json;
  ok(Array.isArray(tagList), '标签统计接口可用');

  const byTag = (await req('/resources?tag=smoke-hp', { token })).json;
  ok(
    (byTag.items ?? []).some((r) => r.id === parent.id),
    `按标签筛选命中父资源（${byTag.items?.length} 条）`,
  );
  const byTwoTags = (await req('/resources?tag=smoke-hp,storage', { token })).json;
  ok(
    (byTwoTags.items ?? []).some((r) => r.id === parent.id),
    '多标签按「同时包含」匹配',
  );
  const byMissingTag = (await req('/resources?tag=smoke-hp,not-exist-tag', { token })).json;
  ok((byMissingTag.items ?? []).length === 0, '缺少任一标签则不命中');

  const rootOnly = (await req('/resources?rootOnly=true&pageSize=200', { token })).json;
  ok(!(rootOnly.items ?? []).some((r) => r.id === child.id), 'rootOnly=true 不包含子资源');
  ok(
    (rootOnly.items ?? []).some((r) => r.id === parent.id),
    'rootOnly=true 包含父资源',
  );

  const byParent = (await req(`/resources?parentId=${parent.id}`, { token })).json;
  ok(
    (byParent.items ?? []).length === 1 && byParent.items[0].id === child.id,
    `按 parentId 只返回其子资源（${byParent.items?.length} 条）`,
  );

  // 从子资源跳父资源：按 id 精确定位，必须只返回父资源本身
  const byId = (await req(`/resources?id=${parent.id}`, { token })).json;
  ok(
    (byId.items ?? []).length === 1 && byId.items[0].id === parent.id,
    `按 id 精确定位到父资源本身（${byId.items?.length} 条）`,
  );
  ok(!(byId.items ?? []).some((r) => r.id === child.id), '按 id 定位时不会带出子资源');

  const overview = (await req('/stats/overview', { token })).json;
  ok(
    (overview?.hierarchy?.rootCount ?? 0) >= 1,
    `概览返回顶层/子资源统计（顶层 ${overview?.hierarchy?.rootCount}）`,
  );
  ok(Array.isArray(overview?.byTag), '概览返回标签分布');
  ok(typeof overview?.slotPeriod?.expiredCount === 'number', '概览返回占用期限统计（含超期数）');

  /* ---------------------------------------------------------------- *
   * [7] 未来开始也算占用 / 更换资源 / 容量不能为负 / 环境标识色
   * ---------------------------------------------------------------- */
  console.log('\n[7] 未来占用、更换资源与容量下限');

  const childCapacityPatch = await req(`/resources/${child.id}`, {
    method: 'PATCH',
    token,
    body: { capacityTotal: 999 },
  });
  ok(
    childCapacityPatch.status === 400 || childCapacityPatch.status === 422,
    `子资源不能直接改总容量（实际 ${childCapacityPatch.status}）`,
  );

  // 申请时间在未来：容量立即扣除，状态仍为占用中，只标注 notStarted
  const futureAssign = await req(`/project-environments/${env.id}/slots/${slot.id}/assign`, {
    method: 'POST',
    token,
    body: {
      resourceId: parent.id,
      amount: 300,
      startAt: day(10),
      endAt: day(40),
      acknowledge: true,
    },
  });
  ok(futureAssign.status === 200, `未来开始时间可以申请资源（${futureAssign.status}）`);
  ok(futureAssign.json?.slot?.occupancyState === 'ACTIVE', '未来开始时间仍为「占用中」');
  ok(futureAssign.json?.slot?.notStarted === true, '未来开始时间带 notStarted 标记');
  ok(futureAssign.json?.slot?.overdueDays === 0, '未来开始不产生超期天数');
  const pFuture = (await req(`/resources/${parent.id}`, { token })).json;
  ok(
    pFuture?.capacity?.slotAllocated === 300,
    `未来占用的容量已立即扣除（${pFuture?.capacity?.slotAllocated}）`,
  );
  const overviewFuture = (await req('/stats/overview', { token })).json;
  ok(overviewFuture?.slotPeriod?.occupiedCount >= 1, '概览占用数包含未来开始的占用');

  // 更换资源：同一槽位换绑到子资源，旧资源占用自动释放
  const swap = await req(`/project-environments/${env.id}/slots/${slot.id}/assign`, {
    method: 'POST',
    token,
    body: { resourceId: child.id, amount: 100, acknowledge: true },
  });
  ok(swap.status === 200, `已绑定槽位可直接更换资源（${swap.status}）`);
  ok(swap.json?.slot?.resourceId === child.id, '槽位已切换到新资源');
  ok(swap.json?.slot?.startAt !== null, '未传时间时沿用原占用区间');
  const afterSwap = (await req(`/resources/${parent.id}`, { token })).json;
  ok(
    afterSwap?.capacity?.slotAllocated === 0,
    `旧资源的槽位占用已释放（${afterSwap?.capacity?.slotAllocated}）`,
  );
  ok(
    afterSwap?.capacity?.allocated === 400,
    `旧资源仅剩子资源申请 400（${afterSwap?.capacity?.allocated}）`,
  );

  // 容量下限：已占用 400，调到 399 必须拒绝，调到 400 允许（剩余 0）
  const overshrink = await req(`/resources/${parent.id}`, {
    method: 'PATCH',
    token,
    body: { capacityTotal: 399 },
  });
  ok(overshrink.status === 409, `父容量调到低于已占用被拒绝（${overshrink.status}）`);
  ok(overshrink.json?.error?.details?.field === 'capacityTotal', '拒绝时定位到 capacityTotal 字段');
  ok(overshrink.json?.error?.details?.shortage === 1, '拒绝时给出缺口数量');
  const exact = await req(`/resources/${parent.id}`, {
    method: 'PATCH',
    token,
    body: { capacityTotal: 400 },
  });
  ok(
    exact.status === 200 && exact.json?.capacityAvailable === 0,
    '调到刚好等于已占用允许（剩余 0）',
  );
  await req(`/resources/${parent.id}`, { method: 'PATCH', token, body: { capacityTotal: 1000 } });

  // 环境标识色：可写任意 HEX，非 #rrggbb 被拒绝
  const envDicts = (await req('/environments?includeDisabled=true', { token })).json;
  const prodDict = envDicts.find((e) => e.code === 'PROD');
  ok(prodDict?.builtin === false && prodDict?.label === '生产', 'PROD 为非内置生产环境');
  ok(/^#[0-9a-f]{6}$/.test(prodDict?.color ?? ''), `生产环境带默认标识色（${prodDict?.color}）`);
  const recolor = await req('/environments/PROD', {
    method: 'PATCH',
    token,
    body: { color: '#0ea5e9' },
  });
  ok(
    recolor.status === 200 && recolor.json?.detail?.color === '#0ea5e9',
    '标识色可改为任意 HEX（对应 RGB 输入）',
  );
  const badRecolor = await req('/environments/PROD', {
    method: 'PATCH',
    token,
    body: { color: 'rgb(1,2,3)' },
  });
  ok([400, 422].includes(badRecolor.status), '非 #rrggbb 标识色被拒绝');
  await req('/environments/PROD', { method: 'PATCH', token, body: { color: '#dc2626' } });

  // 释放槽位，便于后续删除资源
  await req(`/project-environments/${env.id}/slots/${slot.id}/release`, { method: 'POST', token });

  /* ---------------------------------------------------------------- *
   * [8] 超期汇总（概览 / 项目详情）与项目环境编辑
   * ---------------------------------------------------------------- */
  console.log('\n[8] 超期汇总与项目环境编辑');

  const overdueAssign = await req(`/project-environments/${env.id}/slots/${slot.id}/assign`, {
    method: 'POST',
    token,
    body: {
      resourceId: parent.id,
      amount: 100,
      startAt: day(-30),
      endAt: day(-5),
      acknowledge: true,
    },
  });
  ok(overdueAssign.status === 200, `可构造一个已超期的占用（${overdueAssign.status}）`);
  ok(
    (overdueAssign.json?.slot?.overdueDays ?? 0) >= 5,
    `占用已超期多天（${overdueAssign.json?.slot?.overdueDays}）`,
  );

  const overviewOverdue = (await req('/stats/overview', { token })).json;
  const overdueItem = (overviewOverdue?.overdueSlots ?? []).find((s) => s.slotId === slot.id);
  ok(Boolean(overdueItem), '概览「超期占用资源」包含该槽位');
  ok(overdueItem?.projectId === project.id, '超期明细标注了所属项目');
  ok(
    overdueItem?.resourceId === parent.id && overdueItem?.resourceCode === parent.code,
    '超期明细标注了具体资源',
  );
  ok(
    (overviewOverdue?.overdueByProject ?? []).some(
      (g) => g.projectId === project.id && g.items.some((i) => i.slotId === slot.id),
    ),
    '概览按项目归集超期资源',
  );

  const projOverdue = (await req(`/projects/${project.id}`, { token })).json;
  const overdueRef = (projOverdue?.slotRefs ?? []).find((r) => r.slotId === slot.id);
  ok(
    overdueRef?.resourceCode === parent.code,
    '项目详情的槽位引用带资源编码（可直接列出超期资源）',
  );
  ok((overdueRef?.overdueDays ?? 0) >= 5, '项目详情给出该资源的超期天数');
  ok((projOverdue?.overdueCount ?? 0) >= 1, `项目详情给出超期数量（${projOverdue?.overdueCount}）`);

  const envEdit = await req(`/project-environments/${env.id}`, {
    method: 'PATCH',
    token,
    body: { name: `${env.name}-改`, owner: '冒烟负责人' },
  });
  ok(envEdit.status === 200, `项目环境创建后可修改属性（${envEdit.status}）`);
  ok(envEdit.json?.owner === '冒烟负责人', '环境负责人已更新');
  ok(envEdit.json?.name === `${env.name}-改`, '环境名称已更新');
  ok((envEdit.json?.slots ?? []).length >= 1, '修改属性不会影响已有槽位');

  await req(`/project-environments/${env.id}/slots/${slot.id}/release`, { method: 'POST', token });

  /* ---------------------------------------------------------------- *
   * [9] 清理
   * ---------------------------------------------------------------- */
  console.log('\n[9] 清理冒烟数据');
  await req(`/resources/${child.id}`, { method: 'DELETE', token });
  const delParent2 = await req(`/resources/${parent.id}`, { method: 'DELETE', token });
  ok(delParent2.status === 200, '子资源删除后可删除父资源');
  await req(`/project-environments/${env.id}`, { method: 'DELETE', token });
  await req(`/projects/${project.id}`, { method: 'DELETE', token });
  ok((await req(`/resources/${parent.id}`, { token })).status === 404, '冒烟资源已清理');

  console.log(`\n—— 层级与占用期限冒烟：${passed} 通过 / ${failed} 失败 ——`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
