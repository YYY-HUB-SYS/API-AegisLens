/* 「主密钥放在哪」接进凭证保险库视图的「明文密钥」卡片。
 *
 * 这一层的安全语义比功能更要紧，四条线必须钉住：
 *   ① 三态各说各的话：主密钥在系统凭据管理器里、在盘上明文文件里、凭据管理器压根用不了——
 *      每一种的代价和能走的路都不一样，文案不能串。
 *   ② 凭据管理器用不了时**不给**可点的入口：给一个按不动的按钮是骗人。
 *   ③ 「搬」是**可逆**的，只改主密钥放在哪：不要口令、不要勾选。
 *      那套校验属于「拆除明文密钥」（不可逆），搬过来就变成给可逆操作加不可逆的门槛。
 *   ④ 搬动失败要把后端给的话原样显示出来，不能只说「失败」。
 *
 * 测法：用假 fetch 驱动真挂载（跟 credentials-view.test.js 一个路子），
 * 验的是渲染出来的标记与真正发出去的请求体，不对着源码数正则。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const view = require('../public/credentials-view.js');

/* ---------- 最小 DOM 桩：够挂载 + 渲染 + 派发点击即可 ---------- */
function miniEl() {
  const stubs = new Map();
  let html = '';
  const el = {
    className: '', children: [], listeners: [], attrs: {},
    get innerHTML() { return html; },
    set innerHTML(v) { html = String(v); stubs.clear(); },
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {},
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    addEventListener(t, fn) { el.listeners.push([t, fn]); },
    removeEventListener(t, fn) {
      const i = el.listeners.findIndex(x => x[0] === t && x[1] === fn);
      if (i >= 0) el.listeners.splice(i, 1);
    },
    focus() {}, select() {}, closest() { return null; },
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelectorAll() { return []; },
    querySelector(sel) {
      if (!htmlHas(html, sel)) return null;
      let s = stubs.get(sel);
      if (!s) {
        s = {
          style: {}, textContent: '', value: '', innerHTML: '', disabled: false, attrs: {},
          setAttribute(k, v) { s.attrs[k] = v; },
          getAttribute(k) { return k in s.attrs ? s.attrs[k] : null; },
          removeAttribute(k) { delete s.attrs[k]; },
          focus() {}, select() {}, closest() { return null; },
          classList: { contains() { return false; } },
          querySelector() { return null; }, querySelectorAll() { return []; }
        };
        stubs.set(sel, s);
      }
      return s;
    }
  };
  return el;
}
/* 选择器 → 标记里该出现的那个类名/id（它在不在，决定这个元素存不存在） */
function htmlHas(html, sel) {
  const m = /^[.#]([A-Za-z0-9_-]+)/.exec(sel);
  if (!m) return true;
  return html.indexOf(m[1]) >= 0;
}
function miniDocument(mount) {
  const created = [];
  let n = 0;
  return {
    activeElement: null, hidden: false, body: null,
    createElement() { n++; const el = n === 1 ? mount : miniEl(); created.push(el); return el; },
    addEventListener() {}, removeEventListener() {},
    created: created
  };
}
const tick = () => new Promise(r => setImmediate(r));

/* ---------- 假 fetch：只关心金库那几个端点，其余一律空壳；调用记录留着验请求体 ---------- */
function makeFetch(statusBody, moveResp) {
  const calls = [];
  function res(status, body) {
    return Promise.resolve({
      ok: status >= 200 && status < 300, status: status,
      json: function () { return Promise.resolve(body); }
    });
  }
  function fetchImpl(url, init) {
    init = init || {};
    const u = String(url);
    calls.push({
      url: u, method: (init.method || 'GET').toUpperCase(),
      body: init.body ? JSON.parse(init.body) : null
    });
    if (u.indexOf('/api/vault/status') !== -1) return res(200, statusBody);
    if (u.indexOf('/api/vault/master-key-location') !== -1) {
      if (moveResp) return res(moveResp.status, moveResp.body);
      const tgt = init.body ? JSON.parse(init.body).target : null;
      return res(200, { ok: true, changed: true, source: tgt, note: 'ok' });
    }
    if (u.indexOf('/api/vault/discard-master-key') !== -1) {
      return res(200, { ok: true, discarded: true, credentialRemoved: true });
    }
    if (u.indexOf('/api/credentials') !== -1) return res(200, { credentials: [] });
    if (u.indexOf('/api/platforms') !== -1) return res(200, { platforms: [] });
    if (u.indexOf('/api/keys') !== -1) return res(200, { keys: [] });
    return res(200, {});
  }
  return { fetchImpl: fetchImpl, calls: calls };
}

/* 挂载 → 等状态端点回来 → 点开「明文密钥」卡片 */
async function openCard(opts) {
  const o = opts || {};
  const f = makeFetch(o.status, o.moveResp);
  const mount = miniEl();
  const root = miniEl();
  const realDoc = globalThis.document;
  const doc = miniDocument(mount);
  globalThis.document = doc;
  let mounted = null;
  const restore = function () {
    if (mounted) { mounted.destroy(); mounted = null; }
    if (realDoc === undefined) delete globalThis.document; else globalThis.document = realDoc;
  };
  try {
    mounted = view.mountCredentialsView(root, { fetchImpl: f.fetchImpl });
    await tick();
    click(root, 'security');
    await tick();
  } catch (e) {
    restore();
    throw e;
  }
  return {
    mount: mount, root: root, doc: doc, calls: f.calls,
    state: mounted.getState(),
    html: function () { return mount.innerHTML; },
    cleanup: restore
  };
}

/* 派发一次 data-act 点击 */
function click(root, act, attrs) {
  const l = root.listeners.find(x => x[0] === 'click');
  assert.ok(l, 'click 委托监听没装上');
  const a = Object.assign({ 'data-act': act }, attrs || {});
  const actEl = { getAttribute: (k) => (k in a ? a[k] : null), classList: { contains: () => false } };
  const target = { closest: (sel) => (sel === '[data-act]' ? actEl : null), classList: { contains: () => false } };
  l[1]({ target: target, preventDefault() {} });
}

/* ---------- 三种状态端点返回 ---------- */
const STATUS_OS = {
  unlocked: true, passphraseSet: true, mode: 'envelope',
  rawKeyPresent: true, masterKeySource: 'os', keyringAvailable: true
};
const STATUS_FILE = {
  unlocked: true, passphraseSet: true, mode: 'envelope',
  rawKeyPresent: true, masterKeySource: 'file', keyringAvailable: true
};
const STATUS_NO_KEYRING = {
  unlocked: true, passphraseSet: true, mode: 'envelope',
  rawKeyPresent: true, masterKeySource: 'file', keyringAvailable: false
};

test('态一：主密钥在系统凭据管理器里 —— 好处和代价都要说清，并给一条可逆的退路', async () => {
  const c = await openCard({ status: STATUS_OS });
  try {
    const html = c.html();
    assert.match(html, /主密钥：在系统凭据管理器里/, '标题要说清主密钥在哪');
    assert.match(html, /拷走整个数据目录拿不到钥匙/, '好处要说清：拷走目录拿不到钥匙');
    assert.match(html, /换一台电脑/, '代价要说清：换机器就读不到');
    assert.match(html, /整库就解不开/, '代价要说清：读不到就解不开');
    assert.match(html, /data-act="move-master-key" data-target="file"/,
      '要有一条「移回数据目录文件」的入口（可逆）');
    assert.ok(html.indexOf('data-act="discard-key"') === -1,
      '这一态盘上没有明文副本，「拆除明文密钥」入口不该出现（点了等于把凭据里那条也删掉）');
  } finally { c.cleanup(); }
});

test('态二：主密钥还在盘上明文文件里 —— 保留「拆除」，另给一条可逆的「搬到凭据管理器」', async () => {
  const c = await openCard({ status: STATUS_FILE });
  try {
    const html = c.html();
    assert.match(html, /主密钥：还在数据目录的明文文件里/, '标题要说清主密钥在哪');
    assert.match(html, /拷走整个数据目录就等于拷走了解开一切的钥匙/, '风险要说满');
    assert.match(html, /data-act="move-master-key" data-target="os"/,
      '要有「移到系统凭据管理器」的入口');
    assert.match(html, /这一步可逆/, '「可逆」必须写出来，别和「拆除」混成一类');
    assert.match(html, /不需要口令/, '搬动不要口令，文案里要说');
    assert.match(html, /data-act="discard-key"/, '原有的「拆除明文密钥」流程要留着');
    assert.match(html, /id="cv-discard-pw"/, '拆除仍然要口令');
    assert.match(html, /id="cv-discard-ack"/, '拆除仍然要勾选');
  } finally { c.cleanup(); }
});

test('态三：这台机器用不了系统凭据管理器 —— 不给按不动的按钮，只说清怎么才能用上', async () => {
  const c = await openCard({ status: STATUS_NO_KEYRING });
  try {
    const html = c.html();
    assert.ok(html.indexOf('data-target="os"') === -1,
      '凭据管理器用不了时，不该出现「移到系统凭据管理器」的可点入口');
    assert.ok(html.indexOf('move-master-key') === -1, '整个搬动入口都不该渲染');
    assert.match(html, /@napi-rs\/keyring/, '要说清缺的是哪个可选依赖');
    assert.match(html, /npm install/, '要说清怎么装');
    assert.match(html, /data-act="discard-key"/, '「拆除」那一路不受凭据管理器影响');
  } finally { c.cleanup(); }
});

test('态四：拆完之后（盘上连文件都没有）还是原来那一屏', async () => {
  const c = await openCard({
    status: {
      unlocked: true, passphraseSet: true, mode: 'envelope',
      rawKeyPresent: false, masterKeySource: null, keyringAvailable: true
    }
  });
  try {
    const html = c.html();
    assert.match(html, /明文密钥：已拆除/);
    assert.ok(html.indexOf('move-master-key') === -1, '已拆除就没什么可搬的了');
  } finally { c.cleanup(); }
});

test('搬到系统凭据管理器：请求体就是 {target:"os"}，不发口令也不发 confirm', async () => {
  const c = await openCard({ status: STATUS_FILE });
  try {
    click(c.root, 'move-master-key', { 'data-target': 'os' });
    await tick();
    const call = c.calls.find(x => x.url.indexOf('/api/vault/master-key-location') !== -1);
    assert.ok(call, '搬动请求没发出去');
    assert.strictEqual(call.method, 'POST');
    assert.deepStrictEqual(call.body, { target: 'os' });
    assert.strictEqual('passphrase' in call.body, false, '搬动不要口令：那是「拆除」的门槛');
    assert.strictEqual('confirm' in call.body, false, '搬动不是不可逆操作，不该要 confirm');
    /* 搬完状态必须跟着走，否则界面还停在旧位置（说「还在盘上」而其实已经搬走了） */
    assert.strictEqual(c.state.masterKeySource, 'os');
    assert.match(c.html(), /data-state="os"/);
    /* 搬动不触发拆除那套校验 */
    assert.strictEqual(c.state.discardErr, '');
  } finally { c.cleanup(); }
});

test('移回数据目录文件：请求体是 {target:"file"}', async () => {
  const c = await openCard({ status: STATUS_OS });
  try {
    click(c.root, 'move-master-key', { 'data-target': 'file' });
    await tick();
    const call = c.calls.find(x => x.url.indexOf('/api/vault/master-key-location') !== -1);
    assert.ok(call, '搬动请求没发出去');
    assert.strictEqual(call.method, 'POST');
    assert.deepStrictEqual(call.body, { target: 'file' });
    assert.strictEqual(c.state.masterKeySource, 'file');
    assert.match(c.html(), /data-state="present"/);
  } finally { c.cleanup(); }
});

test('搬动失败：把后端给的话原样显示出来（不能只说「失败」）', async () => {
  const c = await openCard({
    status: STATUS_FILE,
    moveResp: { status: 400, body: { error: '这台机器上用不了系统凭据管理器' } }
  });
  try {
    click(c.root, 'move-master-key', { 'data-target': 'os' });
    await tick();
    assert.strictEqual(c.state.moveErr, '这台机器上用不了系统凭据管理器');
    assert.match(c.html(), /这台机器上用不了系统凭据管理器/, '错误文案要出现在卡上');
    assert.match(c.html(), /role="alert"/, '错误要能被读屏软件念出来');
    assert.strictEqual(c.state.masterKeySource, 'file', '失败了就该留在原地');
    assert.match(c.html(), /data-state="present"/);
  } finally { c.cleanup(); }
});

test('没有主密钥（409）也要有话说', async () => {
  const c = await openCard({
    status: STATUS_FILE,
    moveResp: { status: 409, body: { error: '这个数据目录还没有主密钥' } }
  });
  try {
    click(c.root, 'move-master-key', { 'data-target': 'os' });
    await tick();
    assert.strictEqual(c.state.moveErr, '这个数据目录还没有主密钥');
    assert.match(c.html(), /这个数据目录还没有主密钥/);
  } finally { c.cleanup(); }
});

test('搬完的提示要说清发生了什么', async () => {
  const c = await openCard({ status: STATUS_FILE });
  try {
    click(c.root, 'move-master-key', { 'data-target': 'os' });
    await tick();
    const toasts = c.doc.created.filter(e => e.className === 'cv-toast');
    assert.ok(toasts.length >= 1, '搬完没有提示');
    const txt = toasts.map(t => t.innerHTML).join(' ');
    assert.match(txt, /主密钥已移到系统凭据管理器/);
  } finally { c.cleanup(); }
});

test('位置没变时不要谎报搬走了', async () => {
  const c = await openCard({
    status: STATUS_FILE,
    moveResp: { status: 200, body: { ok: true, changed: false, source: 'file', note: '主密钥已经在那个位置了' } }
  });
  try {
    click(c.root, 'move-master-key', { 'data-target': 'os' });
    await tick();
    const toasts = c.doc.created.filter(e => e.className === 'cv-toast');
    const txt = toasts.map(t => t.innerHTML).join(' ');
    assert.match(txt, /主密钥已经在那个位置了/);
    assert.ok(txt.indexOf('已移到系统凭据管理器') === -1, '没搬成就不许说搬成了');
    assert.strictEqual(c.state.masterKeySource, 'file', '位置没变，状态也不该变');
  } finally { c.cleanup(); }
});

test('搬动没有放宽拆除的校验：没口令照样不删', async () => {
  const c = await openCard({ status: STATUS_FILE });
  try {
    click(c.root, 'discard-key');
    await tick();
    /* 拆除那套「口令 + 勾选」一个都不能少（勾选在前，所以先撞上勾选那条） */
    assert.match(c.state.discardErr, /先勾那一项|请输入解锁口令/);
    assert.ok(!c.calls.some(x => x.url.indexOf('/api/vault/discard-master-key') !== -1),
      '没口令没勾选就不许发拆除请求');
  } finally { c.cleanup(); }
});

test('端点表要对准后端真实路径', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'credentials-view.js'), 'utf8');
  assert.ok(js.includes("vaultMasterKeyLocation: '/api/vault/master-key-location'"),
    '端点表里的主密钥搬家路径要与后端一致（app/src/api.js）');
});

test('内置 CV_MOCK 也要认这个新端点（否则手工验收点一下就是 404）', async () => {
  const mock = view.CV_MOCK;
  mock.setMasterKey('file', true);
  try {
    const r = await mock('/api/vault/master-key-location', {
      method: 'POST', body: JSON.stringify({ target: 'os' })
    });
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.changed, true);
    assert.strictEqual(body.source, 'os');
    /* 状态端点也得报出主密钥在哪，否则卡片永远只认「还在盘上」 */
    const st = await (await mock('/api/vault/status')).json();
    assert.strictEqual(st.masterKeySource, 'os');
    assert.strictEqual(st.keyringAvailable, true);
    /* 搬不动时要报错，不能假装成功 */
    mock.setMasterKey('file', false);
    const bad = await mock('/api/vault/master-key-location', {
      method: 'POST', body: JSON.stringify({ target: 'os' })
    });
    assert.strictEqual(bad.status, 400);
  } finally {
    mock.setMasterKey('file', true);
  }
});
