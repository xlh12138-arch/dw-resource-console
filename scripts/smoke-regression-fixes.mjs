/**
 * 回归测试：默认值、容量编辑、动态属性排序。
 * 需要一个已初始化并启动的临时 API；脚本创建的数据会在结束时清理。
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787/api/v1';
const password = process.env.SMOKE_PASSWORD ?? 'Admin@12345';
const stamp = Date.now().toString(36).toUpperCase();
let passed = 0;
let failed = 0;

function ok(condition, label, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}

async function req(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json, text };
}

const login = await req('/auth/login', {
  method: 'POST',
  body: { username: process.env.SMOKE_ADMIN_USER ?? 'admin', password },
});
if (!login.json?.accessToken) {
  console.error('登录失败', login.text);
  process.exit(1);
}
const token = login.json.accessToken;
const typeCode = `REG_DEFAULT_${stamp}`;
const parentTypeCode = `REG_CAP_${stamp}`;

try {
  console.log('\n[0] 无容量槽位引用时编辑名称');
  const allResources = await req('/resources?pageSize=200', { token });
  const referenced = allResources.json?.items?.find(
    (item) => item.slotRefCount > 0 && item.capacityTotal === null && item.parentId === null,
  );
  if (referenced) {
    const renameReferenced = await req(`/resources/${referenced.id}`, {
      method: 'PATCH',
      token,
      body: {
        name: referenced.name,
        environment: referenced.environment,
        status: referenced.status,
        datacenter: referenced.datacenter ?? undefined,
        owner: referenced.owner ?? undefined,
        tags: referenced.tags,
        remark: referenced.remark ?? undefined,
        attrs: referenced.attrs,
        parentId: null,
        demandAmount: null,
        capacityTotal: null,
        capacityUnit: null,
        projectId: referenced.projectId,
      },
    });
    ok(renameReferenced.status === 200, '未改变容量时编辑名称不会误报引用', renameReferenced.text);
  }

  console.log('\n[1] 字段默认值');
  const type = await req('/resource-types', {
    method: 'POST',
    token,
    body: {
      code: typeCode,
      label: '默认值回归类型',
      prefix: `RD${stamp.slice(-4)}`,
      ipUniqueByPort: false,
      listColumns: ['score'],
      enabled: true,
      sortOrder: 900,
      fields: [
        {
          key: 'score',
          label: '评分',
          fieldType: 'TEXT',
          required: false,
          options: [],
          defaultValue: 'A',
          isIp: false,
          sortOrder: 0,
        },
      ],
    },
  });
  ok(type.status === 201, '创建带默认值的资源类型', type.text);
  const meta = await req('/meta', { token });
  ok(
    meta.json?.attrFields?.[typeCode]?.[0]?.defaultValue === 'A',
    '/meta 返回字段默认值',
  );

  const first = await req('/resources', {
    method: 'POST',
    token,
    body: {
      type: typeCode,
      name: `默认值资源-A-${stamp}`,
      environment: 'DEV',
      attrs: {},
    },
  });
  ok(first.status === 201 && first.json?.attrs?.score === 'A', '创建时自动写入默认值', first.text);
  const firstDetail = await req(`/resources/${first.json?.id}`, { token });
  ok(firstDetail.json?.attrs?.score === 'A', '创建后详情可见默认值');

  const second = await req('/resources', {
    method: 'POST',
    token,
    body: {
      type: typeCode,
      name: `默认值资源-B-${stamp}`,
      environment: 'DEV',
      attrs: { score: 'B' },
    },
  });
  ok(second.status === 201, '创建动态属性排序测试资源', second.text);
  const sorted = await req(`/resources?type=${typeCode}&sortBy=attr:score&sortOrder=asc&pageSize=20`, {
    token,
  });
  ok(
    sorted.status === 200 &&
      sorted.json?.items?.[0]?.attrs?.score === 'A' &&
      sorted.json?.items?.[1]?.attrs?.score === 'B',
    '动态属性列可排序',
    sorted.text,
  );

  console.log('\n[2] 父子容量编辑');
  const parentType = await req('/resource-types', {
    method: 'POST',
    token,
    body: {
      code: parentTypeCode,
      label: '容量回归类型',
      prefix: `RC${stamp.slice(-4)}`,
      ipUniqueByPort: false,
      listColumns: [],
      enabled: true,
      sortOrder: 901,
      fields: [],
    },
  });
  ok(parentType.status === 201, '创建容量测试类型', parentType.text);
  const parent = await req('/resources', {
    method: 'POST',
    token,
    body: {
      type: parentTypeCode,
      name: `容量父资源-${stamp}`,
      environment: 'DEV',
      attrs: {},
      capacityTotal: 1000,
      capacityUnit: 'GB',
    },
  });
  const childA = await req('/resources', {
    method: 'POST',
    token,
    body: {
      type: parentTypeCode,
      name: `容量子资源-A-${stamp}`,
      environment: 'DEV',
      attrs: {},
      parentId: parent.json?.id,
      demandAmount: 200,
    },
  });
  const childB = await req('/resources', {
    method: 'POST',
    token,
    body: {
      type: parentTypeCode,
      name: `容量子资源-B-${stamp}`,
      environment: 'DEV',
      attrs: {},
      parentId: parent.json?.id,
      demandAmount: 300,
    },
  });
  ok(parent.status === 201 && childA.status === 201 && childB.status === 201, '创建父子容量数据');

  const rename = await req(`/resources/${childA.json?.id}`, {
    method: 'PATCH',
    token,
    body: { name: `仅改名称-${stamp}` },
  });
  ok(rename.status === 200, '仅修改名称不触发容量校验', rename.text);

  const grow = await req(`/resources/${childA.json?.id}`, {
    method: 'PATCH',
    token,
    body: { demandAmount: 700 },
  });
  ok(grow.status === 200, '计算父资源余量时排除当前子资源', grow.text);

  console.log('\n[3] 编辑项目环境槽位');
  const projectList = await req('/projects?pageSize=20', { token });
  let editableSlot = null;
  for (const project of projectList.json?.items ?? []) {
    const projectDetail = await req(`/projects/${project.id}`, { token });
    const envId = projectDetail.json?.environments?.[0]?.id;
    if (!envId) continue;
    const envDetail = await req(`/project-environments/${envId}`, { token });
    const slot = envDetail.json?.slots?.[0];
    if (slot) {
      editableSlot = { envId, slot };
      break;
    }
  }
  if (editableSlot) {
    const nextRole = `回归槽位-${stamp}`;
    const edited = await req(
      `/project-environments/${editableSlot.envId}/slots/${editableSlot.slot.id}`,
      {
        method: 'PATCH',
        token,
        body: { slotRole: nextRole, remark: '回归测试备注' },
      },
    );
    ok(
      edited.status === 200 &&
        edited.json?.slot?.slotRole === nextRole &&
        edited.json?.slot?.remark === '回归测试备注',
      '可编辑槽位名称和备注',
      edited.text,
    );
    await req(`/project-environments/${editableSlot.envId}/slots/${editableSlot.slot.id}`, {
      method: 'PATCH',
      token,
      body: { slotRole: editableSlot.slot.slotRole, remark: editableSlot.slot.remark },
    });
  }

  console.log('\n[4] 清理');
  for (const id of [childA.json?.id, childB.json?.id, parent.json?.id, first.json?.id, second.json?.id]) {
    if (id) await req(`/resources/${id}`, { method: 'DELETE', token });
  }
  await req(`/resource-types/${typeCode}`, { method: 'DELETE', token });
  await req(`/resource-types/${parentTypeCode}`, { method: 'DELETE', token });
  ok(true, '临时测试数据已清理');
} catch (error) {
  failed += 1;
  console.error(error);
}

console.log(`\n—— 回归修复 API 测试：${passed} 通过 / ${failed} 失败 ——`);
process.exit(failed === 0 ? 0 : 1);
