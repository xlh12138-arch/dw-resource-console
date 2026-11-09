/** 针对本轮 8 个缺陷的浏览器回归测试，仅用于临时数据库。 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ADMIN_USERNAME, BASE, WEB_BASE, adminPassword } from './lib/smoke-env.mjs';

const APP = WEB_BASE;
const API = BASE;
const chromePath =
  process.env.CHROME_PATH ??
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error('未找到 Chrome/Chromium');

const username = ADMIN_USERNAME;
const password = adminPassword('ui-regression-fixes');
let pass = 0;
let fail = 0;
const ok = (condition, label, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
  }
};

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json, text };
}

const login = await api('/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
if (!login.json?.accessToken) throw new Error(`API 登录失败：${login.text}`);
const auth = { authorization: `Bearer ${login.json.accessToken}` };
const code = `UI_REG_${Date.now().toString(36).toUpperCase()}`;
let resourceId;
await api('/resource-types', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({
    code,
    label: '无关键列回归类型',
    prefix: `UR${Date.now().toString().slice(-4)}`,
    ipUniqueByPort: false,
    listColumns: [],
    enabled: true,
    sortOrder: 900,
    fields: [
      {
        key: 'note',
        label: '默认字段',
        fieldType: 'TEXT',
        required: false,
        options: [],
        defaultValue: '默认备注',
        placeholder: '默认字段',
        isIp: false,
        sortOrder: 0,
      },
    ],
  }),
});
const created = await api('/resources', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ type: code, name: '无关键属性资源', environment: 'DEV', attrs: {} }),
});
resourceId = created.json?.id ?? null;

const port = 9400 + (Date.now() % 40);
const profile = join(tmpdir(), `dw-ui-reg-${Date.now()}`);
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
const pending = new Map();
let seq = 0;

async function connect() {
  let page;
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(APP)}`, {
        method: 'PUT',
      });
      page = await response.json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('无法连接 Chrome');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(source) {
  const result = await send('Runtime.evaluate', {
    expression: `(() => { ${source} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(source, label, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(source).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
}

async function navigate(path) {
  await send('Page.navigate', { url: `${APP.replace(/\/$/, '')}${path}` });
  await sleep(1000);
}

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(`return !!document.querySelector('input[type=password]')`, '登录页');
  await evaluate(`
    const demo = [...document.querySelectorAll('button')].filter((b) => b.className.includes('w-full rounded-lg border'));
    demo[0]?.click();
    return true;
  `);
  await sleep(300);
  await evaluate(`
    const input = document.querySelector('input[type="password"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(password)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await sleep(100);
  await evaluate(`
    const form = document.querySelector('form');
    form.querySelector('button[type=submit]')?.click();
    return true;
  `);
  await waitFor(`return !!document.querySelector('nav a[href="/resources"]')`, '登录完成');

  console.log('\n[1] 资源台账');
  await navigate('/resources');
  await waitFor(`return document.body.innerText.includes('资源台账')`, '资源台账');
  await evaluate(`
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新增资源'));
    button?.click();
    return true;
  `);
  await waitFor(
    `return document.querySelectorAll('[role="dialog"] button[data-resource-type]').length > 0;`,
    '新增资源弹窗',
  );
  const defaultType = await evaluate(`
    const dialog = document.querySelector('[role="dialog"]');
    return dialog.querySelector('[data-selected-resource-type]')?.getAttribute('data-selected-resource-type') ?? '';
  `);
  ok(defaultType === '', '新增资源不再默认选中资源类型', defaultType);
  const typeListLayout = await evaluate(`
    const list = document.querySelector('[role="dialog"] [role="listbox"]');
    return {
      clientHeight: list?.clientHeight ?? 0,
      scrollHeight: list?.scrollHeight ?? 0,
      overflowY: list ? getComputedStyle(list).overflowY : '',
    };
  `);
  ok(
    typeListLayout.scrollHeight > typeListLayout.clientHeight &&
      typeListLayout.clientHeight <= 208 &&
      typeListLayout.overflowY === 'auto',
    '资源类型列表限制高度并在内部滚动',
    typeListLayout,
  );
  const typeButton = await evaluate(`
    const dialog = document.querySelector('[role="dialog"]');
    const button = dialog.querySelector('button[data-resource-type]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return {
      type: button.getAttribute('data-resource-type'),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  `);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: typeButton.x, y: typeButton.y });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: typeButton.x,
    y: typeButton.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: typeButton.x,
    y: typeButton.y,
    button: 'left',
    clickCount: 1,
  });
  await sleep(300);
  const typeAfterOneSelection = await evaluate(`
    const dialog = document.querySelector('[role="dialog"]');
    const selected = dialog.querySelector('[data-selected-resource-type]');
    return {
      value: selected?.getAttribute('data-selected-resource-type') ?? '__missing__',
      attrsTitle: [...dialog.querySelectorAll('p')].find((node) => node.innerText.includes('专属属性'))?.innerText ?? '',
    };
  `);
  ok(
    typeButton?.type !== '__missing__' &&
      typeAfterOneSelection.value === typeButton?.type &&
      typeAfterOneSelection.attrsTitle.includes('专属属性'),
    '新增资源时资源类型选择一次即可生效',
    { selectedType: typeButton?.type, actual: typeAfterOneSelection },
  );
  await evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  `);
  await sleep(300);

  await evaluate(`
    const button = [...document.querySelectorAll('thead button')].find((b) => b.textContent.includes('名称'));
    button?.click();
    return true;
  `);
  await sleep(500);
  const sortSearch = await evaluate(`return location.search`);
  ok(sortSearch.includes('sortBy=name'), '点击表头后写入排序参数', sortSearch);

  const nasRows = await api('/resources?type=NAS&pageSize=50', { headers: auth });
  const child = nasRows.json?.items?.find((item) => item.parentId && item.demandAmount > 0);
  const parent = child ? await api(`/resources/${child.parentId}`, { headers: auth }) : null;
  if (child && parent) {
    await navigate(`/resources?id=${child.id}`);
    await waitFor(
      `return document.body.innerText.includes(${JSON.stringify(child.code)})`,
      '子资源',
    );
    await evaluate(`
      const button = [...document.querySelectorAll('tbody button')].find((b) => b.querySelector('.lucide-pencil'));
      button?.click();
      return true;
    `);
    await waitFor(
      `return document.querySelector('[role="dialog"]')?.innerText.includes('申请容量')`,
      '子资源编辑弹窗',
    );
    await sleep(250);
    const text = await evaluate(`return document.querySelector('[role="dialog"]').innerText`);
    const match = text.match(/父资源剩余可用\s*([0-9.]+)/);
    const expected = Number(parent.json.capacityAvailable ?? 0) + Number(child.demandAmount ?? 0);
    ok(Number(match?.[1]) === expected, '父资源剩余容量不重复扣除当前子资源', {
      shown: match?.[1],
      expected,
    });
    await evaluate(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    `);
    await sleep(250);
  }

  await navigate(`/resources?type=${code}`);
  await waitFor(`return document.body.innerText.includes('无关键属性资源')`, '无关键属性资源');
  ok(
    await evaluate(`return document.body.innerText.includes('未设置关键属性')`),
    '未配置关键列时展示明确提示',
  );
  await evaluate(`
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新增资源'));
    button?.click();
    return true;
  `);
  await waitFor(`return !!document.querySelector('[role="dialog"]')`, '资源新增弹窗');
  await sleep(300);
  const defaultValue = await evaluate(`
    const label = [...document.querySelectorAll('[role="dialog"] label')].find((node) => node.innerText.includes('默认字段'));
    return label?.querySelector('input')?.value ?? '__missing__';
  `);
  ok(defaultValue === '默认备注', '新增表单显示字典字段默认值', defaultValue);
  await evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  `);
  await sleep(250);

  console.log('\n[2] 环境模板');
  await navigate('/templates');
  await waitFor(`return document.body.innerText.includes('项目环境模板')`, '模板列表');
  await waitFor(
    `return [...document.querySelectorAll('button')].some((b) => b.querySelector('.lucide-pencil'))`,
    '模板编辑按钮',
  );
  await evaluate(`
    const button = [...document.querySelectorAll('button')].find((b) => b.querySelector('.lucide-pencil'));
    button?.click();
    return true;
  `);
  await waitFor(
    `return document.querySelector('[role="dialog"]')?.innerText.includes('资源组合')`,
    '模板编辑弹窗',
  );
  await waitFor(
    `
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('添加资源类型'));
    return button && !button.disabled;
  `,
    '模板详情加载',
  );
  const before = await evaluate(`
    return document.querySelectorAll('[role="dialog"] .divide-y > div select').length;
  `);
  await evaluate(`
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('添加资源类型'));
    button?.click();
    return true;
  `);
  await sleep(300);
  const after = await evaluate(`
    return document.querySelectorAll('[role="dialog"] .divide-y > div select').length;
  `);
  ok(after === before + 1, '编辑模板时可添加资源类型', { before, after });
  const addedValues = await evaluate(`
    const rows = [...document.querySelectorAll('[role="dialog"] .divide-y > div')];
    const row = rows[rows.length - 1];
    return {
      type: row?.querySelector('select')?.value ?? '__missing__',
      role: row?.querySelector('input')?.value ?? '__missing__',
    };
  `);
  ok(addedValues.type === '' && addedValues.role === '', '新增资源类型不预填默认值', addedValues);

  console.log('\n[3] 项目环境槽位编辑');
  await navigate('/projects');
  await waitFor(`return document.querySelectorAll('a[href^="/projects/"]').length > 0`, '项目列表');
  await evaluate(`
    document.querySelector('a[href^="/projects/"]')?.click();
    return true;
  `);
  await waitFor(`return document.body.innerText.includes('项目环境')`, '项目详情');
  await evaluate(`
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('槽位'));
    button?.click();
    return true;
  `);
  await waitFor(
    `return document.querySelector('[role="dialog"]')?.innerText.includes('槽位列表')`,
    '槽位列表',
  );
  ok(
    await evaluate(`return [...document.querySelectorAll('button[title="编辑槽位"]')].length > 0`),
    '环境槽位提供编辑入口',
  );
  await evaluate(`
    const button = document.querySelector('button[title="编辑槽位"]');
    button?.click();
    return true;
  `);
  await waitFor(
    `return [...document.querySelectorAll('[role="dialog"]')].some((node) => node.querySelector('h3')?.innerText.startsWith('编辑槽位'));`,
    '槽位编辑弹窗',
  );
  const slotRoleBefore = await evaluate(`
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => node.querySelector('h3')?.innerText.startsWith('编辑槽位'));
    const label = [...dialog.querySelectorAll('label')].find((node) => node.innerText.includes('槽位名称'));
    return label?.querySelector('input')?.value ?? '__missing__';
  `);
  const slotRoleAfter = `${slotRoleBefore}-回归`;
  await evaluate(`
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => node.querySelector('h3')?.innerText.startsWith('编辑槽位'));
    const label = [...dialog.querySelectorAll('label')].find((node) => node.innerText.includes('槽位名称'));
    const input = label.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(slotRoleAfter)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await evaluate(`
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => node.querySelector('h3')?.innerText.startsWith('编辑槽位'));
    [...dialog.querySelectorAll('button')].find((button) => button.textContent.includes('保存修改'))?.click();
    return true;
  `);
  await waitFor(
    `return ![...document.querySelectorAll('[role="dialog"] h3')].some((node) => node.innerText.startsWith('编辑槽位'));`,
    '槽位编辑保存完成',
  );
  await waitFor(
    `return document.body.innerText.includes(${JSON.stringify(slotRoleAfter)});`,
    '槽位名称刷新',
  );
  ok(
    await evaluate(`return document.body.innerText.includes(${JSON.stringify(slotRoleAfter)});`),
    '编辑槽位名称后保存并刷新列表',
  );
  await evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  `);
  await sleep(250);

  console.log('\n[4] 字典排序');
  await navigate('/dict');
  await waitFor(`return document.body.innerText.includes('资源类型')`, '字典配置');
  const rowsBefore = await evaluate(`
    return [...document.querySelectorAll('tbody tr')].map((row) => row.querySelector('td')?.innerText.trim());
  `);
  const hasArrows = await evaluate(`
    return [...document.querySelectorAll('button[title="上移"], button[title="下移"]')].length >= 2;
  `);
  ok(hasArrows, '资源类型行提供上移/下移按钮');
  await evaluate(`
    const button = document.querySelector('tbody tr button[title="下移"]');
    button?.click();
    return true;
  `);
  await sleep(900);
  const rowsAfter = await evaluate(`
    return [...document.querySelectorAll('tbody tr')].map((row) => row.querySelector('td')?.innerText.trim());
  `);
  ok(rowsAfter[0] === rowsBefore[1] && rowsAfter[1] === rowsBefore[0], '点击下移后字典顺序生效', {
    before: rowsBefore.slice(0, 2),
    after: rowsAfter.slice(0, 2),
  });
} catch (error) {
  fail += 1;
  console.error(error);
} finally {
  if (resourceId) {
    await api(`/resources/${resourceId}`, { method: 'DELETE', headers: auth }).catch(() => {});
  }
  await api(`/resource-types/${code}`, { method: 'DELETE', headers: auth }).catch(() => {});
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  console.log(`\n—— UI 回归修复测试：${pass} 通过 / ${fail} 失败 ——`);
  process.exit(fail === 0 ? 0 : 1);
}
