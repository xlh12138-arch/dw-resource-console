/**
 * UI 实测（CDP）：本轮四项改动
 *  1. 项目环境卡片：编辑按钮与运行状态徽标不重叠
 *  2. ESC 只关闭最上层弹窗（槽位弹窗 → 分配资源弹窗）
 *  3. 资源详情容量块展示峰值占用与时间段
 *  4. Cookie 登录：刷新页面保持登录态
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 每次运行换一个调试端口与独立 profile，避免与残留实例互相干扰
const PORT = 9333 + (Date.now() % 60);
const PROFILE = `C:\\Windows\\Temp\\cdp-ui-${Date.now()}`;
const APP = 'http://localhost:5173/';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const password = (env.match(/^BOOTSTRAP_ADMIN_PASSWORD=(.*)$/m) ?? [])[1]?.trim();
const username = (env.match(/^BOOTSTRAP_ADMIN_USERNAME=(.*)$/m) ?? [])[1]?.trim() || 'admin';

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
};

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 15000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep 	(200);
  }
  throw new Error(`等待超时：${label}`);
}

let ws;
async function connect() {
  // 新建标签页并直接打开应用，避免复用残留的空白页
  let page;
  try {
    const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' });
    page = await created.json();
  } catch {
    /* 老版本 Chrome 不支持 PUT，走 /json/list 兜底 */
  }
  if (!page?.webSocketDebuggerUrl) {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await res.json();
    page = list.find((t) => t.type === 'page') ?? list[0];
  }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }
    }, 20000);
  });
}

async function ev(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 异常');
  return r.result.value;
}

async function navigate(url) {
  await send('Page.navigate', { url });
  await sleep(1200);
}

async function clickHref(href) {
  const clicked = await ev(`
    const a = [...document.querySelectorAll('a')].find((x) => x.getAttribute('href') === ${JSON.stringify(href)});
    if (!a) return false;
    a.click();
    return true;
  `);
  await sleep(1200);
  return clicked;
}

/** 点击列表里第一个以 prefix 开头的链接（用于进入详情） */
async function clickHrefPrefix(prefix) {
  const clicked = await ev(`
    const a = [...document.querySelectorAll('a')].find((x) => (x.getAttribute('href') || '').startsWith(${JSON.stringify(prefix)}));
    if (!a) return false;
    a.click();
    return true;
  `);
  await sleep(1500);
  return clicked;
}

async function press(key) {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code: key,
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await sleep(600);
}

try {
  // 等待调试端口
  for (let i = 0; i < 40; i += 1) {
    try {
      await connect();
      break;
    } catch {
      await sleep(300);
    }
  }
  if (!ws) throw new Error('无法连接 Chrome');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  await navigate(APP);
  // 首次打开可能因 vite 预构建较慢，失败就再导航一次
  let booted = await ev(`return !!document.querySelector('input')`).catch(() => false);
  if (!booted) {
    await send('Page.navigate', { url: APP });
    await sleep(3000);
  }
  await waitFor(async () => ev(`return !!document.querySelector('input')`), 30000, '登录页加载');

  /* ---------- 登录 ---------- */
  // 用页面自带的「演示账号」填充（第一个即管理员），再提交
  await ev(`
    const demo = [...document.querySelectorAll('button')].filter((b) => b.className.includes('w-full rounded-lg border'));
    if (demo[0]) demo[0].click();
    return demo.length;
  `);
  await sleep(400);
  const filled = await ev(`
    const inputs = [...document.querySelectorAll('input')];
    return JSON.stringify(inputs.map((i) => i.value));
  `);
  await ev(`
    const form = document.querySelector('form');
    const btn = [...form.querySelectorAll('button')].find((b) => b.type === 'submit');
    btn.click();
    return true;
  `);
  await sleep(1500);
  const loginState = await ev(`
    return JSON.stringify({
      stillLogin: !!document.querySelector('input[type=password]'),
      banner: (document.body.innerText || '').slice(0, 200),
      filled: ${filled},
    });
  `);
  const ls = JSON.parse(loginState);
  ok(!ls.stillLogin, `以演示账号登录成功（${JSON.stringify(ls.filled)}）`, ls.banner);
  if (ls.stillLogin) throw new Error(`登录失败：${ls.banner}`);

  /* ---------- 1. 环境编辑按钮与徽标不重叠 ---------- */
  console.log('\n[1] 项目环境卡片布局');
  ok(await clickHref('/projects'), '进入需求项目页');
  ok(await clickHrefPrefix('/projects/'), '打开一个项目详情');
  const layout = await ev(`
    const cards = [...document.querySelectorAll('div')].filter((d) => d.className && String(d.className).includes('rounded-lg border border-slate-200'));
    const out = [];
    for (const card of cards) {
      const btn = card.querySelector('button[aria-label^="编辑环境"]');
      if (!btn) continue;
      const badge = [...card.querySelectorAll('span')].find((s) => /规划中|搭建中|运行中|已下线/.test(s.textContent || ''));
      if (!badge) continue;
      const b = btn.getBoundingClientRect();
      const g = badge.getBoundingClientRect();
      const overlap = !(b.right <= g.left || b.left >= g.right || b.bottom <= g.top || b.top >= g.bottom);
      out.push({ overlap, gap: Math.round(b.left - g.right), btn: [Math.round(b.left), Math.round(b.top)], badge: [Math.round(g.left), Math.round(g.right)] });
    }
    return JSON.stringify(out);
  `);
  const layoutRows = JSON.parse(layout);
  ok(layoutRows.length > 0, `找到 ${layoutRows.length} 个带编辑按钮的环境卡片`);
  ok(
    layoutRows.every((r) => !r.overlap),
    '编辑按钮与运行状态徽标无重叠',
    layoutRows.filter((r) => r.overlap),
  );
  ok(
    layoutRows.every((r) => r.gap >= 0),
    '编辑按钮位于徽标右侧（同排流式排列）',
    layoutRows.map((r) => r.gap),
  );

  /* ---------- 2. ESC 只关最上层弹窗 ---------- */
  console.log('\n[2] ESC 关闭顺序（模态栈）');
  await ev(`
    const card = [...document.querySelectorAll('button')].find((b) => String(b.className).includes('rounded-b-lg'));
    if (card) card.click();
    return true;
  `);
  await sleep(1200);
  const slotsOpen = await ev(`
    const d = [...document.querySelectorAll('[role=dialog]')].map((x) => x.textContent || '');
    return JSON.stringify(d.filter((t) => t.includes('资源槽位') || t.includes('环境详情')).length);
  `);
  ok(Number(slotsOpen) > 0, '环境槽位弹窗已打开');

  await ev(`
    const btn = [...document.querySelectorAll('button[title]')].find((b) => /分配资源|更换资源/.test(b.title) && b.offsetParent);
    if (btn) btn.click();
    return true;
  `);
  await sleep(1200);
  const bothOpen = await ev(`
    const titles = [...document.querySelectorAll('[role=dialog]')].map((x) => (x.querySelector('h3')?.textContent || '').trim());
    return JSON.stringify(titles);
  `);
  const titles = JSON.parse(bothOpen);
  ok(titles.length >= 2, `两层弹窗同时存在（${titles.join(' / ')}）`);
  ok(
    titles.some((t) => t.includes('分配资源') || t.includes('更换资源')),
    '第二层是「分配/更换资源」弹窗',
  );

  await press('Escape');
  const afterFirstEsc = await ev(`
    const titles = [...document.querySelectorAll('[role=dialog]')].map((x) => (x.querySelector('h3')?.textContent || '').trim());
    return JSON.stringify(titles);
  `);
  const t1 = JSON.parse(afterFirstEsc);
  ok(
    !t1.some((t) => t.includes('分配资源') || t.includes('更换资源')),
    '第一次 ESC 关闭了后弹出的「分配资源」窗口',
    t1,
  );
  ok(
    t1.some((t) => t.includes('资源槽位') || t.includes('环境详情')),
    '第一次 ESC 后「环境槽位」窗口仍在',
    t1,
  );

  await press('Escape');
  const afterSecondEsc = await ev(`
    return JSON.stringify(document.querySelectorAll('[role=dialog]').length);
  `);
  ok(Number(afterSecondEsc) === 0, `第二次 ESC 关闭「环境槽位」窗口（剩余 ${afterSecondEsc} 个弹窗）`);

  /* ---------- 3. 资源详情容量峰值 ---------- */
  console.log('\n[3] 资源详情容量块');
  ok(await clickHref('/resources'), '进入资源台账');
  const opened = await ev(`
    const btn = [...document.querySelectorAll('button[title^="查看资源详情"]')];
    for (const b of btn) {
      const row = b.closest('tr');
      const text = row ? row.textContent || '' : '';
      if (/GB|TB/.test(text)) { b.click(); return true; }
    }
    // 兜底：打开第一个资源的详情
    if (btn[0]) { btn[0].click(); return true; }
    return false;
  `);
  await sleep(2000);
  const capText = await ev(`
    const body = document.body.innerText;
    const idx = body.indexOf('按时间段峰值');
    return JSON.stringify({
      hasPeak: idx >= 0,
      snippet: idx >= 0 ? body.slice(idx - 120, idx + 160) : '',
      opened: ${opened},
    });
  `);
  const cap = JSON.parse(capText);
  ok(cap.opened === true, '已打开资源详情弹窗');
  ok(cap.hasPeak, '容量块展示「按时间段峰值」', cap.snippet);
  console.log(`    片段：${cap.snippet.replace(/\n/g, ' | ')}`);

  /* ---------- 4. Cookie 登录：刷新保持登录 ---------- */
  console.log('\n[4] Cookie 登录（刷新保持登录态）');
  const before = await ev(`return JSON.stringify(document.cookie.includes('dw_refresh'))`);
  await send('Page.reload', { ignoreCache: false });
  await sleep(2500);
  const afterReload = await ev(`
    return JSON.stringify({
      hasPassword: !!document.querySelector('input[type=password]'),
      text: (document.body.innerText || '').slice(0, 120),
    });
  `);
  const state = JSON.parse(afterReload);
  ok(
    !state.hasPassword,
    '刷新后未回到登录页（凭 httpOnly Cookie 静默续期）',
    state.text,
  );
  console.log(`    刷新后页面：${state.text.replace(/\n/g, ' | ')}`);
  const cookieVisible = JSON.parse(before);
  ok(cookieVisible === false, '刷新令牌 Cookie 为 httpOnly（前端 JS 读不到）');

  /* ---------- 5. 分配资源：保存后关闭不再提示未保存 ---------- */
  console.log('\n[5] 分配资源保存后点关闭不再提示未保存');
  ok(await clickHref('/projects'), '进入需求项目页');
  ok(await clickHrefPrefix('/projects/'), '打开项目详情');
  await ev(`
    const card = [...document.querySelectorAll('button')].find((b) => String(b.className).includes('rounded-b-lg'));
    if (card) card.click();
    return true;
  `);
  await sleep(1300);
  const assignBtn = await ev(`
    const btn = [...document.querySelectorAll('button[title]')].find((b) => /分配资源|更换资源/.test(b.title) && b.offsetParent);
    if (!btn) return 'none';
    btn.click();
    return btn.title;
  `);
  ok(assignBtn !== 'none', `打开「${assignBtn}」弹窗`);
  await sleep(1800);
  await ev(`
    const radios = [...document.querySelectorAll('input[type=radio]')];
    if (radios[0]) radios[0].click();
    return radios.length;
  `);
  await sleep(700);
  await ev(`
    const el = document.querySelector('input[type=number]');
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '10');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return Boolean(el);
  `);
  await sleep(500);
  const submitted = await ev(`
    const btns = [...document.querySelectorAll('button')].filter((b) => /确认绑定|确认更换|我已确认/.test(b.textContent || '') && b.offsetParent);
    if (!btns.length || btns[0].disabled) return 'blocked';
    btns[0].click();
    return 'clicked';
  `);
  ok(submitted === 'clicked', '已提交绑定', submitted);
  await sleep(2200);
  // 出现引用提示时需要二次确认
  await ev(`
    const b = [...document.querySelectorAll('button')].find((x) => /我已确认/.test(x.textContent || '') && x.offsetParent);
    if (b) b.click();
    return Boolean(b);
  `);
  await sleep(2500);
  const bound = await ev(`
    return JSON.stringify({ toast: (document.body.innerText || '').match(/槽位已绑定[^\\n]*/)?.[0] ?? '' });
  `);
  ok(Boolean(JSON.parse(bound).toast), `资源已绑定（${JSON.parse(bound).toast}）`);
  await ev(`
    const btns = [...document.querySelectorAll('button[aria-label="关闭"]')].filter((b) => b.offsetParent);
    if (btns.length) btns[btns.length - 1].click();
    return btns.length;
  `);
  await sleep(1200);
  const dirtyAfterSave = await ev(`return JSON.stringify((document.body.innerText || '').includes('有未保存的修改'))`);
  ok(JSON.parse(dirtyAfterSave) === false, '保存完成后关闭不再提示「有未保存的修改」');

  /* ---------- 6. 台账容量列 = 详情峰值 ---------- */
  console.log('\n[6] 台账容量列与详情峰值一致');
  await press('Escape');
  await sleep(600);
  ok(await clickHref('/resources'), '进入资源台账');
  const rowInfo = await ev(`
    const btns = [...document.querySelectorAll('button[title^="查看资源详情"]')];
    for (const b of btns) {
      const row = b.closest('tr');
      const text = row ? row.textContent || '' : '';
      if (!/GB|TB/.test(text)) continue;
      // 只挑「已有占用」的容量资源，才能同时校验时间轴
      const m = text.match(/([\\d.]+)\\s*\\/\\s*([\\d.]+)/);
      if (m && Number(m[1]) > 0) { b.click(); return JSON.stringify({ used: Number(m[1]), total: Number(m[2]) }); }
    }
    return JSON.stringify(null);
  `);
  const ri = JSON.parse(rowInfo);
  ok(Boolean(ri), `台账容量列读到 ${ri ? `${ri.used}/${ri.total}` : '无'}`);
  await sleep(2200);
  const detailPeak = await ev(`
    const m = (document.body.innerText || '').match(/峰值占用\\s*([\\d.]+)/);
    return m ? Number(m[1]) : null;
  `);
  ok(
    ri && detailPeak !== null && Math.abs(ri.used - detailPeak) < 0.01,
    `台账已占用 ${ri?.used} = 详情峰值 ${detailPeak}`,
  );

  /* ---------- 7. 占用时间轴 tooltip 带项目名 ---------- */
  console.log('\n[7] 占用时间轴 tooltip 含项目名');
  const tips = await ev(`
    const all = [...document.querySelectorAll('[title]')]
      .map((e) => e.getAttribute('title'))
      .filter((t) => t && t.includes('槽位「'));
    const text = document.body.innerText || '';
    return JSON.stringify({
      count: all.length,
      sample: all[0] ?? '',
      firstInPage: all.length ? text.includes(all[0].split(' · ')[0]) : false,
    });
  `);
  const tipInfo = JSON.parse(tips);
  ok(tipInfo.count > 0, `时间轴有 ${tipInfo.count} 段占用`);
  ok(/ · /.test(tipInfo.sample) && tipInfo.sample.includes('槽位「'), 'tooltip 含项目名 · 环境 · 槽位 · 时段', tipInfo.sample);
  ok(tipInfo.firstInPage, 'tooltip 首段（项目名）能在详情里找到', tipInfo.sample);
  console.log(`    tooltip：${tipInfo.sample}`);

  /* ---------- 8. 字典环境引用带项目名 ---------- */
  console.log('\n[8] 字典环境引用明细带项目名');
  await press('Escape');
  await sleep(600);
  ok(await clickHref('/dict'), '进入字典配置');
  await ev(`
    const tab = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '环境');
    if (tab) tab.click();
    return Boolean(tab);
  `);
  await sleep(1200);
  await ev(`
    const link = [...document.querySelectorAll('button')].find((b) => /^\\s*[1-9]\\d*\\s*$/.test((b.textContent || '').trim()) && b.offsetParent);
    if (link) link.click();
    return Boolean(link);
  `);
  await sleep(1500);
  const refText = await ev(`
    const dlg = [...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText || '').join('\\n');
    const m = dlg.match(/项目环境[\\s\\S]{0,200}/);
    return JSON.stringify({ snippet: m ? m[0] : '', hasProject: / · /.test(dlg) });
  `);
  const refInfo = JSON.parse(refText);
  ok(refInfo.snippet.length > 0, '打开了引用明细弹窗');
  ok(refInfo.hasProject, '引用明细里带项目名', refInfo.snippet.replace(/\n/g, ' | '));
  console.log(`    引用明细：${refInfo.snippet.replace(/\n/g, ' | ').slice(0, 160)}`);

  /* ---------- 9. 用户管理：三角色 + 重置密码 ---------- */
  console.log('\n[9] 用户管理：三角色与重置密码');
  await press('Escape');
  await sleep(600);
  ok(await clickHref('/users'), '进入用户管理');

  const roleInfo = JSON.parse(
    await ev(`
      const text = document.body.innerText || '';
      const opts = [...document.querySelectorAll('select')].flatMap((s) => [...s.options].map((o) => o.textContent.trim()));
      return JSON.stringify({
        hasUser: text.includes('普通用户'),
        hasReadonly: text.includes('只读用户'),
        hasLegacyOperator: text.includes('运维人员'),
        opts: [...new Set(opts)],
      });
    `),
  );
  ok(roleInfo.hasUser, '页面出现「普通用户」文案');
  ok(roleInfo.hasReadonly, '页面出现「只读用户」文案');
  ok(!roleInfo.hasLegacyOperator, '页面不再出现已废弃的「运维人员」', roleInfo.opts.join(','));
  ok(
    roleInfo.opts.length === 0 ||
      (roleInfo.opts.includes('管理员') && roleInfo.opts.includes('普通用户') && roleInfo.opts.includes('只读用户')),
    `角色下拉为三项（${roleInfo.opts.join(' / ') || '无下拉'}）`,
  );

  // 新建一个临时账号（顺带验证「普通用户」为默认角色）
  const tmpUser = `ui_pwd_${Date.now().toString(36)}`;
  await ev(`
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('新建用户'));
    if (btn) btn.click();
    return Boolean(btn);
  `);
  await sleep(900);
  const setInput = (index, value) =>
    ev(`
      const el = document.querySelectorAll('[role=dialog] input')[${index}];
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    `);
  await setInput(0, tmpUser);
  await setInput(1, 'UI改密验证');
  await setInput(2, 'Tmp#12345678');
  await sleep(300);
  const roleDefault = await ev(`
    const sel = document.querySelector('[role=dialog] select');
    return sel ? sel.options[sel.selectedIndex].textContent.trim() : 'none';
  `);
  ok(roleDefault === '普通用户', `新建用户默认角色为「普通用户」（实际 ${roleDefault}）`);
  await ev(`
    const btn = [...document.querySelectorAll('[role=dialog] button')].find((b) => (b.textContent || '').trim() === '创建');
    if (btn) btn.click();
    return Boolean(btn);
  `);
  await waitFor(
    async () => ev(`return (document.body.innerText || '').includes(${JSON.stringify(tmpUser)})`),
    15000,
    '新账号出现在列表',
  );
  ok(true, `已通过界面创建临时账号 ${tmpUser}`);

  // 点该行的「重置密码」
  const openReset = await ev(`
    const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(tmpUser)}));
    if (!row) return 'no-row';
    const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').includes('重置密码'));
    if (!btn) return 'no-btn';
    btn.click();
    return 'ok';
  `);
  await sleep(900);
  const confirmText = await ev(`
    const dlg = [...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText || '').join('\\n');
    return JSON.stringify({ text: dlg, hasWarn: /强制下线|重新登录/.test(dlg) });
  `);
  const cf = JSON.parse(confirmText);
  ok(openReset === 'ok', '行内「重置密码」按钮可点击');
  ok(cf.hasWarn, '确认弹窗提示会强制下线', cf.text.replace(/\n/g, ' | ').slice(0, 120));

  await ev(`
    const btn = [...document.querySelectorAll('[role=dialog] button')].find((b) => (b.textContent || '').trim() === '确认重置');
    if (btn) btn.click();
    return Boolean(btn);
  `);
  await sleep(2000);
  const resultInfo = JSON.parse(
    await ev(`
      const dlg = [...document.querySelectorAll('[role=dialog]')].find((d) => (d.innerText || '').includes('密码已重置'));
      const inputs = dlg ? [...dlg.querySelectorAll('input')].map((i) => i.value) : [];
      return JSON.stringify({
        open: Boolean(dlg),
        text: dlg ? dlg.innerText || '' : '',
        values: inputs,
        hasCopy: dlg ? [...dlg.querySelectorAll('button')].some((b) => (b.textContent || '').includes('复制密码')) : false,
      });
    `),
  );
  const newPwd = resultInfo.values.find((v) => /^[A-Za-z0-9]{12}$/.test(v));
  ok(resultInfo.open, '弹出「密码已重置」结果窗口');
  ok(Boolean(newPwd), `结果窗口展示新密码（${newPwd ?? resultInfo.values.join(',')}）`);
  ok(resultInfo.hasCopy, '提供「复制密码」按钮');
  ok(resultInfo.text.includes('关闭后无法再次查看'), '提示新密码仅展示一次');

  await ev(`
    const btn = [...document.querySelectorAll('[role=dialog] button')].find((b) => (b.textContent || '').trim() === '我已记录');
    if (btn) btn.click();
    return Boolean(btn);
  `);
  await sleep(700);
  ok(
    await ev(`return ![...document.querySelectorAll('[role=dialog]')].some((d) => (d.innerText || '').includes('密码已重置'))`),
    '关闭后结果窗口消失',
  );

  // 收尾：停用临时账号
  const disabled = await ev(`
    const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(tmpUser)}));
    if (!row) return 'no-row';
    const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '停用');
    if (!btn) return 'no-btn';
    btn.click();
    return 'ok';
  `);
  await sleep(1200);
  ok(disabled === 'ok', '临时账号已停用');

  /* ---------- 10. 只读用户：可见同普通用户，但无写入口 ---------- */
  console.log('\n[10] 只读用户');
  await ev(`
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('退出登录'));
    if (btn) btn.click();
    return Boolean(btn);
  `);
  await sleep(1800);
  await waitFor(async () => ev(`return !!document.querySelector('input[type=password]')`), 15000, '退回登录页');
  const roDemo = JSON.parse(
    await ev(`
      const demo = [...document.querySelectorAll('button')].filter((b) => b.className.includes('w-full rounded-lg border'));
      if (demo.length >= 3) demo[2].click();
      return JSON.stringify({ count: demo.length, label: (demo[2]?.innerText || '').trim() });
    `),
  );
  ok(roDemo.count >= 3, `登录页有 ${roDemo.count} 个演示账号（含只读）`, roDemo.label);
  await sleep(400);
  await ev(`
    const form = document.querySelector('form');
    const btn = [...form.querySelectorAll('button')].find((b) => b.type === 'submit');
    btn.click();
    return true;
  `);
  await sleep(2000);
  const roState = JSON.parse(
    await ev(`
      return JSON.stringify({
        logged: !document.querySelector('input[type=password]'),
        header: (document.querySelector('header')?.innerText || '').replace(/\\n/g, ' '),
        nav: [...document.querySelectorAll('nav a')].map((a) => (a.textContent || '').trim()),
      });
    `),
  );
  ok(roState.logged, '以只读账号登录成功');
  ok(/只读用户/.test(roState.header), '顶栏角色徽标显示「只读用户」');
  ok(!roState.nav.includes('用户管理'), '只读用户看不到「用户管理」菜单');
  ok(!roState.nav.includes('变更审计'), '只读用户看不到「变更审计」菜单');
  ok(roState.nav.includes('资源台账') && roState.nav.includes('需求项目'), '可见菜单与普通用户一致');

  ok(await clickHref('/resources'), '只读用户可进入资源台账');
  await sleep(1400);
  const roRes = JSON.parse(
    await ev(`
      const text = document.body.innerText || '';
      return JSON.stringify({
        rows: document.querySelectorAll('tbody tr').length,
        hasCreate: text.includes('新增资源'),
        hasImport: text.includes('批量导入'),
        hasExport: text.includes('导出 CSV'),
        hasRowActions: Boolean(document.querySelector('tbody svg.lucide-pencil, tbody svg.lucide-trash-2, tbody .text-rose-600')),
      });
    `),
  );
  ok(roRes.rows > 0, `只读用户能看到资源列表（${roRes.rows} 行，可见范围与普通用户一致）`);
  ok(!roRes.hasCreate, '只读用户看不到「新增资源」');
  ok(!roRes.hasImport, '只读用户看不到「批量导入」');
  ok(roRes.hasExport, '只读用户仍可导出（只读操作）');
  ok(!roRes.hasRowActions, '只读用户行内没有编辑/删除入口');

  ok(await clickHref('/projects'), '只读用户可进入需求项目');
  await sleep(1400);
  const roProj = JSON.parse(
    await ev(`
      return JSON.stringify({
        hasCreate: (document.body.innerText || '').includes('新建项目'),
        entries: document.querySelectorAll('a[href^="/projects/"]').length,
      });
    `),
  );
  ok(!roProj.hasCreate, '只读用户看不到「新建项目」');
  ok(roProj.entries > 0, `只读用户能看到项目列表（${roProj.entries} 个入口）`);

  /* ---------- 11. 普通用户：除用户管理与审计外与管理员一致 ---------- */
  console.log('\n[11] 普通用户');
  await ev(`
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('退出登录'));
    if (btn) btn.click();
    return Boolean(btn);
  `);
  await sleep(1800);
  await waitFor(async () => ev(`return !!document.querySelector('input[type=password]')`), 15000, '退回登录页');
  await ev(`
    const demo = [...document.querySelectorAll('button')].filter((b) => b.className.includes('w-full rounded-lg border'));
    if (demo[1]) demo[1].click();
    return Boolean(demo[1]);
  `);
  await sleep(400);
  await ev(`
    const form = document.querySelector('form');
    const btn = [...form.querySelectorAll('button')].find((b) => b.type === 'submit');
    btn.click();
    return true;
  `);
  await sleep(2000);
  const uState = JSON.parse(
    await ev(`
      return JSON.stringify({
        logged: !document.querySelector('input[type=password]'),
        header: (document.querySelector('header')?.innerText || '').replace(/\\n/g, ' '),
        nav: [...document.querySelectorAll('nav a')].map((a) => (a.textContent || '').trim()),
      });
    `),
  );
  ok(uState.logged, '以普通用户登录成功');
  ok(/普通用户/.test(uState.header), '顶栏角色徽标显示「普通用户」');
  ok(!uState.nav.includes('用户管理'), '普通用户看不到「用户管理」菜单');
  ok(!uState.nav.includes('变更审计'), '普通用户看不到「变更审计」菜单');
  ok(
    uState.nav.includes('资源台账') && uState.nav.includes('需求项目') && uState.nav.includes('环境模板'),
    `普通用户可见其余菜单（${uState.nav.join(' / ')}）`,
  );
  ok(await clickHref('/resources'), '进入资源台账');
  await sleep(1400);
  const uRes = JSON.parse(
    await ev(`
      const text = document.body.innerText || '';
      return JSON.stringify({
        hasCreate: text.includes('新增资源'),
        hasImport: text.includes('批量导入'),
        hasDelete: Boolean(document.querySelector('tbody button svg.text-rose-600')),
      });
    `),
  );
  ok(uRes.hasCreate, '普通用户可以看到「新增资源」');
  ok(uRes.hasImport, '普通用户可以看到「批量导入」');
  ok(uRes.hasDelete, '普通用户可以看到删除入口（与管理员一致）');
} catch (err) {
  fail += 1;
  console.log(`  ✗ 执行异常：${err.message}`);
} finally {
  console.log(`\n—— UI 实测：${pass} 通过 / ${fail} 失败 ——`);
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  process.exit(fail > 0 ? 1 : 0);
}
