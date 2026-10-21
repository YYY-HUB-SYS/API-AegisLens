/* 凭证视图的两件事：
   1) 提交体的规则（纯函数 submitPayload）——写错就是静默删数据，必须能在 node 里直接断言；
   2) 四个视图文件真的被服务出去——挂载代码是 `if (!window.CredentialsView || !root) return;`，
      APP_ASSETS 少一条或文件名打错，整块面板就静默消失，任何接口测试都看不见。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const view = require('../public/credentials-view.js');
const tmp = require('./tmp.js');

const submit = view.__internals.submitPayload;

/* 后端 buildPatch 的语义（credentials-api.js:149/154）：键缺失＝不改，空串＝清空。
   这两条一起决定了前端绝不能把没碰过的字段照直发出去。 */
const DRAFT = { id: 7, site: 'intra.example', loginMethod: 'oauth', title: '内网', username: 'ops', url: 'https://intra', folder: '', tags: '', password: '', note: '', totpSecret: '' };

function keysOf(p) { return Object.keys(p).sort().join(','); }

test('编辑时没碰过口令与备注 → 请求体里根本不出现这两个键', () => {
  const p = submit(Object.assign({}, DRAFT), 'update', { pw: false, note: false });
  assert.ok(!('password' in p), '带上 password:"" 就等于把用户存了的口令删掉');
  assert.ok(!('note' in p), '同理，备注也会被清空');
  assert.strictEqual(keysOf(p), 'folder,loginMethod,site,tags,title,url,username');
});

test('用户主动清空（碰过且留空）→ 必须把空串发出去，让后端清空', () => {
  const p = submit(Object.assign({}, DRAFT), 'update', { pw: true, note: true });
  assert.strictEqual(p.password, '', '碰过又留空就是「我要删掉它」，不能当没改');
  assert.strictEqual(p.note, '');
});

test('填了新口令 → 照发；只改口令时备注仍然不动', () => {
  const p = submit(Object.assign({}, DRAFT, { password: 'brand-new-pw' }), 'update', { pw: true, note: false });
  assert.strictEqual(p.password, 'brand-new-pw');
  assert.ok(!('note' in p));
});

test('新建态两个字段照直发（此时空串是「就是没有」，不是「删掉」）', () => {
  const p = submit(Object.assign({}, DRAFT), 'create', { pw: false, note: false });
  assert.strictEqual(p.password, '');
  assert.strictEqual(p.note, '');
});

test('提交体带着网站与登录方式：site 是一等公民，不靠标题认人', () => {
  const p = submit(Object.assign({}, DRAFT), 'update', { pw: false, note: false });
  assert.strictEqual(p.site, 'intra.example');
  assert.strictEqual(p.loginMethod, 'oauth');
});

test('TOTP 种子仍按老规矩：非空才发', () => {
  assert.ok(!('totpSecret' in submit(Object.assign({}, DRAFT), 'update', { pw: false, note: false })));
  const p = submit(Object.assign({}, DRAFT, { totpSecret: 'JBSWY3DPEHPK3PXP' }), 'update', {});
  assert.strictEqual(p.totpSecret, 'JBSWY3DPEHPK3PXP');
});

test('touched 整个不传也不能炸（默认按没碰过处理）', () => {
  const p = submit(Object.assign({}, DRAFT), 'update');
  assert.ok(!('password' in p) && !('note' in p));
});

/* ── 视图资产的可达性 ─────────────────────────────────────────── */

async function start() {
  const dir = tmp.mk('akm-view');
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: 'json' });
  const server = createApp({
    storage: storage, fetchImpl: async () => new Response('{}'),
    /* dek 必须交给会话：不传的话免密会话根本不持有 DEK，凭证那条路一律 423，
       「reveal → 存态 → 渲染」这条链在测试里就接不起来了 */
    dek: mk,
    publicDir: path.join(__dirname, '..', 'public'), version: 'test'
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server: server, base: 'http://127.0.0.1:' + server.address().port, dir: dir };
}

test('两个视图的 js/css 都被服务且 MIME 正确（少一条就整块面板静默消失）', async () => {
  const h = await start();
  try {
    const want = {
      '/credentials-view.js': 'text/javascript',
      '/credentials-view.css': 'text/css',
      '/consumer-view.js': 'text/javascript',
      '/consumer-view.css': 'text/css'
    };
    for (const [p, mime] of Object.entries(want)) {
      const res = await fetch(h.base + p);
      assert.strictEqual(res.status, 200, p + ' 取不到：' + res.status);
      assert.ok(String(res.headers.get('content-type')).indexOf(mime) === 0,
        p + ' 的 MIME 是 ' + res.headers.get('content-type') + '，浏览器会拒绝执行/应用');
      assert.ok((await res.text()).length > 500, p + ' 内容为空');
    }
  } finally {
    await new Promise(r => h.server.close(r));
    try { fs.rmSync(h.dir, { recursive: true, force: true }); } catch (e) { /* Windows 句柄 */ }
  }
});

test('index.html 真的挂载了这两个视图（引了脚本又没挂载点同样是白屏）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const needle of ['/credentials-view.js', '/credentials-view.css', '/consumer-view.js', '/consumer-view.css',
    'mountCredentialsView', 'mountConsumerView', 'id="vault"', 'id="consumer-tokens"']) {
    assert.ok(html.includes(needle), 'index.html 缺少挂载要素：' + needle);
  }
});

/* ---------- 挂载/卸载的生命周期 ---------- */
/* 文档承诺 mountCredentialsView() 返回 { destroy() }。destroy 以前只摘 visibilitychange，
   rootEl 上 6 条委托监听一条都没摘——拆完再挂同一个容器，一次点击触发两份 handler：
   reveal 会连发两次明文请求（吃两次 reveal 限流），保存会 POST 两遍。
   用最小 DOM 桩在 node 里真跑挂载/卸载，而不是对着源码数正则。 */
function fakeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', innerHTML: '', children: [], listeners: [],
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, select() {}, closest() { return null; },
    addEventListener(t, fn) { el.listeners.push(t + ':' + (fn && fn.name ? fn.name : 'anon')); },
    removeEventListener(t, fn) {
      const k = t + ':' + (fn && fn.name ? fn.name : 'anon');
      const i = el.listeners.indexOf(k);
      if (i >= 0) el.listeners.splice(i, 1);
    },
    classList: { add() {}, remove() {}, contains() { return false; } }
  };
  return el;
}
function withFakeDocument(fn) {
  const real = globalThis.document;
  const doc = fakeEl('#document');
  doc.hidden = false; doc.activeElement = null;
  doc.body = fakeEl('body');
  doc.createElement = fakeEl;
  globalThis.document = doc;
  try { return fn(doc); } finally { globalThis.document = real; }
}

test('429 要带得等多久：只有「稍后再试」逼人反复点，每点一次窗口又往后推', () => {
  const cls = view.__internals.classifyStatus;
  const rate = cls(429, { error: '口令查看过于频繁，请稍后再试', retryAfterMs: 42000 });
  assert.strictEqual(rate.retryAfterMs, 42000, '时长在响应体里，不在状态码里');
  assert.strictEqual(view.__internals.rateMessage(rate), '口令查看过于频繁，请稍后再试 请 42 秒后再试。');
  /* 后端没给时长时不能凭空造一个「请 0 秒后再试」 */
  const bare = cls(429, { error: '取用过于频繁' });
  assert.strictEqual(bare.retryAfterMs, 0);
  assert.strictEqual(view.__internals.rateMessage(bare, '揭示过于频繁，请稍候'), '取用过于频繁');
  /* 非限流的文案一个字节都不许被改写 */
  assert.strictEqual(view.__internals.rateMessage(cls(401, { error: '口令不正确或会话失效' }), '解锁失败'), '口令不正确或会话失效');
  assert.strictEqual(view.__internals.rateMessage(cls(0, {}), '解锁失败'), '无法连接本地保险库服务');
  assert.strictEqual(view.__internals.rateMessage({ kind: 'client', message: '' }, '解锁失败'), '解锁失败',
    '后端没给话时才用兜底文案');
  assert.strictEqual(view.__internals.retryText(1), '请 1 秒后再试。', '不到 1 秒也说 1 秒，不许出现 0 秒');
});

test('reveal 出来的密钥（API 私钥）必须渲染：那一行标着「密钥」，只读 password 会点了没反应', () => {
  const c = { id: 3, hasPassword: false, hasSecret: true };
  const masked = view.__internals.secretRowInner(c, null);
  assert.match(masked, /显示密钥/, '掩码态的按钮要说清显示的是密钥：' + masked);
  const shown = view.__internals.secretRowInner(c, { password: null, secret: 'sk-fixture-abc' });
  assert.ok(shown.includes('sk-fixture-abc'), '私钥类凭证的明文要出现在行里：' + shown);
  assert.match(shown, /aria-label="复制密钥"/);
  /* 口令类照旧优先 password，别把两类搞混 */
  const both = view.__internals.secretRowInner({ id: 3, hasPassword: true, hasSecret: true }, { password: 'pw1', secret: 'sk-fixture-abc' });
  assert.ok(both.includes('pw1') && !both.includes('sk-fixture-abc'), both);
});

/* ── 揭示那条链：后端 → 存态 → 渲染，少一环就是「点了没反应」 ──────── */
/* 上一轮的真实事故：渲染层修好认 secret 了，但 reveal 响应写进内存态那一行没抄 secret。
   接口 200、备注照样显示、「密钥」那一行还是点点 —— 纯函数单测和接口测试都照不出这一格，
   是真浏览器点出来的。所以这里把整条链在 node 里接起来跑，并且加一道契约闸：
   后端 reveal 再多给一个明文字段而视图没接，当场红。 */
test('私钥类凭证走完 reveal → revealState → secretRowInner，明文必须出现在那一行', async () => {
  const h = await start();
  try {
    const made = await fetch(h.base + '/api/credentials', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: 'keys.example', title: '仅私钥那条', username: 'svc', secret: 'sk-chain-123456', note: '备注也在' })
    }).then(r => r.json());
    const id = made.credential.id;
    assert.strictEqual(made.credential.hasPassword, false, '前提：这条只有 secret');

    const res = await fetch(h.base + '/api/credentials/' + id + '/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.password, null);
    assert.strictEqual(body.secret, 'sk-chain-123456');

    const internals = view.__internals;
    const row = internals.secretRowInner({ id: id, hasPassword: false, hasSecret: true }, internals.revealState(body));
    assert.ok(row.indexOf('sk-chain-123456') > -1, '整条链走完必须把私钥显示出来，实得：' + row);
    assert.match(row, /aria-label="复制密钥"/);

    /* 契约闸：后端 reveal 出去的键，除了纯元信息，视图一个都不许漏接 */
    const META = ['id', 'site', 'loginMethod', 'title', 'username', 'url', 'lastUsedAt'];
    const keys = Object.keys(body);
    const notCarried = keys.filter(k => META.indexOf(k) === -1 && internals.REVEAL_FIELDS.indexOf(k) === -1);
    assert.deepStrictEqual(notCarried, [], '后端 reveal 里有字段是视图没接的：' + notCarried.join(', '));
    const stale = internals.REVEAL_FIELDS.filter(k => keys.indexOf(k) === -1);
    assert.deepStrictEqual(stale, [], '视图在等一个后端已经不发的字段：' + stale.join(', '));
  } finally {
    await new Promise(r => h.server.close(r));
    try { fs.rmSync(h.dir, { recursive: true, force: true }); } catch (e) { /* Windows 句柄 */ }
  }
});

/* ── 网站中心化：列表映射 / 分组 / 登录方式枚举 ── */
test('parseList：site 与 loginMethod 会进视图项', () => {
  const items = view.__internals.parseList({ credentials: [
    { id: 1, site: 'a.com', loginMethod: 'oauth', title: 'T', username: 'u' },
    { id: 2, title: '没填网站' }
  ] });
  assert.strictEqual(items[0].site, 'a.com');
  assert.strictEqual(items[0].loginMethod, 'oauth');
  assert.strictEqual(items[1].site, '');
  assert.strictEqual(items[1].loginMethod, '');
});

/* 后端把多个标签落成逗号串（存储层就是文本列），视图不按逗号切的话，
   「生产,数据库」会变成一个标签：按「生产」筛不中、也选不了。
   （2026-10-21 夜测：多标签渲染成一个、筛标签筛不中。） */
test('parseList：后端逗号串的标签要按逗号切开', () => {
  const items = view.__internals.parseList({ credentials: [
    { id: 1, title: '多标签', tags: '生产,数据库' },
    { id: 2, title: '单标签', tags: '财务' },
    { id: 3, title: '数组标签', tags: ['甲', '乙'] },
    { id: 4, title: '没标签' }
  ] });
  assert.deepStrictEqual(items[0].tags, ['生产', '数据库'], '逗号串必须切开成两个标签');
  assert.deepStrictEqual(items[1].tags, ['财务'], '单个标签切完还是它自己');
  assert.deepStrictEqual(items[2].tags, ['甲', '乙'], '已经是数组的原样');
  assert.deepStrictEqual(items[3].tags, [], '没标签就是空数组');
});

test('groupBySite：同站多账号归一组，空网站单独成组不丢', () => {
  const groups = view.__internals.groupBySite([
    { id: '1', site: 'github.com', username: 'a' },
    { id: '2', site: 'github.com', username: 'b' },
    { id: '3', site: '', username: 'c' },
    { id: '4', site: 'a.com', username: 'd' }
  ]);
  assert.strictEqual(groups.length, 3, 'github 一组 + 空网站一组 + a.com 一组');
  assert.strictEqual(groups[0].site, 'github.com');
  assert.strictEqual(groups[0].items.length, 2);
  assert.strictEqual(groups[1].site, '（未填写网站）');
  assert.strictEqual(groups[1].items.length, 1);
  assert.strictEqual(groups[2].site, 'a.com');
});

test('loginMethod：五值枚举，认不出的一律按口令登录', () => {
  const I = view.__internals;
  assert.strictEqual(I.loginMethodValue('OAuth'), 'oauth');
  assert.strictEqual(I.loginMethodValue(''), 'password');
  assert.strictEqual(I.loginMethodValue('face'), 'password');
  assert.strictEqual(I.loginMethodLabel('scan'), '扫码登录');
  assert.strictEqual(I.loginMethodLabel('nope'), '口令登录');
});

test('destroy() 把 rootEl 的委托监听全部摘掉：重挂载不会双份触发', () => {
  withFakeDocument(() => {
    const root = fakeEl('section');
    const m = view.mountCredentialsView(root, {});
    const installed = root.listeners.slice();
    for (const t of ['click', 'input', 'change', 'submit', 'keydown']) {
      assert.ok(installed.some(s => s.indexOf(t + ':') === 0), '委托监听缺 ' + t + ' 那条：' + installed.join(', '));
    }
    m.destroy();
    assert.deepStrictEqual(root.listeners, [],
      'destroy() 之后 rootEl 上一条监听都不该留，实际还剩：' + root.listeners.join(', '));
    /* 拆完再挂同一个容器才是用户真能踩到的形态：双份 handler = 一次点击发两次 reveal 请求、
       保存按两遍 POST。第二次挂载的监听集合必须和第一次一模一样。 */
    view.mountCredentialsView(root, {});
    assert.deepStrictEqual(root.listeners.slice().sort(), installed.slice().sort(),
      '重挂载后监听集合变了：' + root.listeners.join(', '));
  });
});

/* 样式表里的每个类名都要真被视图代码用到：类名在 JS 里以字符串出现
   （模板里的 class=、querySelector、classList 增删），修饰类（.w40）
   同样以字符串拼出来。只在样式表内部自引用的类就是死规则——
   今天删掉的 .cv-banner-act / .w70 / .cv-span2 / .cv-pw-hold 就是这么长出来的。 */
test('凭证样式表不许长死规则：每个类名都要被视图代码用到', () => {
  /* 注释里也会提到 .keycard 这类别名，不是真选择器，先剥掉再数 */
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'credentials-view.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'credentials-view.js'), 'utf8');
  const classes = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) classes.add(m[1]);
  const dead = [...classes].filter(c => !new RegExp('\\b' + c + '\\b').test(js));
  assert.deepStrictEqual(dead, [],
    '这些类只在样式表里定义、视图代码一次都没用：' + dead.join(', '));
});

/* 金库端点要对准后端真实路径：后端只有 POST /api/vault/passphrase，
   **没有** /api/vault/init（复核报告第 3 条）。
   端点表 EP 不对外暴露（只能经 opts.endpoints 覆盖），所以在源码层断言——
   谁把默认值写回 /api/vault/init，单独用这个视图文件的人按它去调必然 404。 */
test('金库端点表要对准后端真实路径：没有 /api/vault/init', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'credentials-view.js'), 'utf8');
  /* 注释里要写清"后端没有 /api/vault/init"，源码级断言不能把注释也算进去：
     剥掉块注释与行注释，只看真代码。 */
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!code.includes('/api/vault/init'),
    'credentials-view.js 的代码里还在引用后端不存在的 /api/vault/init');
  assert.ok(code.includes("vaultInit: '/api/vault/passphrase'"),
    'vaultInit 默认值应对准后端真实路径 /api/vault/passphrase');
  /* 内部 mock 也要跟真实后端一致：设口令收的是 next，不收 password。
     mock 原先按 password 取，等于把字段名写错这件事藏在自测里。 */
  assert.ok(/vault\/passphrase'\)[\s\S]{0,240}?\.next/.test(js),
    'CV_MOCK 的设口令分支应当走 /api/vault/passphrase 并读 next 字段');
});

/* ── 易混字符：界面承诺 / 字符池 / 后端必须是同一套 ──────────────────── */
/* 迷你 DOM：只支持这个用例要用的几件事——
   1) 记住渲染出来的标记（innerHTML）；
   2) querySelector 按标记里的类名/id 找元素：标记里根本没有就返回 null
      （免得"往一个根本不存在的元素里写值"也被判成通过）；
   3) 找到的元素是可写的桩：style / textContent / value 都能记下来。 */
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
  if (!m) return true; // 认不出来的选择器不制造假阴性
  return html.indexOf(m[1]) >= 0;
}
function miniDocument(mount) {
  let created = 0;
  return {
    activeElement: null, hidden: false, body: null,
    createElement() { created++; return created === 1 ? mount : miniEl(); },
    addEventListener() {}, removeEventListener() {}
  };
}
/* 把前端的随机源钉成确定序列并记录调用次数：
   用来断言"打开弹层只生成了一次口令"（补强度提示不该顺带再生成一次），
   以及"关掉开关后这六个字符立刻可选"（确定判断，不靠概率）。 */
function seedCrypto() {
  const real = globalThis.crypto.getRandomValues;
  let n = 0;
  globalThis.crypto.getRandomValues = function (buf) {
    for (let i = 0; i < buf.length; i++) { buf[i] = n & 0x7fffffff; n++; }
    return buf;
  };
  return {
    reset() { n = 0; },
    used() { return n; },
    restore() { globalThis.crypto.getRandomValues = real; }
  };
}

test('排除易混字符：界面承诺的 Il1O0o 六个，字符池里一个都不许有', () => {
  const I = view.__internals;
  assert.strictEqual(I.AMBIGUOUS_CHARS, 'Il1O0o');
  assert.strictEqual(I.CHARSETS.upper.length, 24, '大写池：26 减 I、O');
  assert.strictEqual(I.CHARSETS.lower.length, 24, '小写池：26 减 l、o');
  assert.strictEqual(I.CHARSETS.digit.length, 8, '数字池：10 减 0、1');
  assert.strictEqual(I.CHARSETS.symbol.length, 18, '符号池：这六个字符本来就不在里面');
  for (const k of ['upper', 'lower', 'digit', 'symbol']) {
    for (const ch of I.AMBIGUOUS_CHARS) {
      assert.ok(I.CHARSETS[k].indexOf(ch) < 0, k + ' 池里还留着易混字符 ' + ch);
    }
  }
  assert.ok(I.CHARSETS.lower.indexOf('i') >= 0, '小写 i 不在排除集里，不该被牵连');
});

test('前端开关关掉后 Il1O0o 立刻可选（确定随机源，不靠概率）', () => {
  const I = view.__internals;
  const seed = seedCrypto();
  try {
    seed.reset();
    const seen = new Set();
    for (const ch of I.generatePassword({ length: 200, upper: true, lower: true, digit: true, symbol: true, noConfusable: false })) seen.add(ch);
    for (const ch of I.AMBIGUOUS_CHARS) {
      assert.ok(seen.has(ch), '关掉排除后 ' + ch + ' 仍取不到，说明开关没接上');
    }
    // 开关开着：这六个一个都不许出现
    for (let i = 0; i < 200; i++) {
      const pw = I.generatePassword({ length: 32 });
      for (const ch of I.AMBIGUOUS_CHARS) assert.ok(pw.indexOf(ch) < 0, '默认应当排除 ' + ch + '，实得：' + pw);
    }
  } finally { seed.restore(); }
});

test('打开「新增凭证」弹层时强度提示就有值（不是等点「重新生成」才出现）', () => {
  const I = view.__internals;
  const mount = miniEl();
  const realDoc = globalThis.document;
  const seed = seedCrypto();
  try {
    globalThis.document = miniDocument(mount);
    const root = miniEl();
    const mounted = view.mountCredentialsView(root, { needsSetup: false, fetchImpl: async () => new Response('{}') });
    const click = root.listeners.find(l => l[0] === 'click');
    assert.ok(click, 'click 委托监听没装上');
    const actEl = { getAttribute: (k) => (k === 'data-act' ? 'add' : null), classList: { contains: () => false } };
    const target = { closest: (sel) => (sel === '[data-act]' ? actEl : null), classList: { contains: () => false } };
    seed.reset();
    click[1]({ target: target, preventDefault() {} });
    const usedOpen = seed.used();

    const st = mounted.getState();
    assert.ok(st.modal, '弹层没打开');
    const out = st.modal.gen.output;
    assert.strictEqual(out.length, 20, '弹层里应当已经有一条口令');

    // 强度提示：标签与色条都不能是空的
    const label = mount.querySelector('.cv-gen-meter-label');
    assert.ok(label, '标记里没有 .cv-gen-meter-label');
    assert.ok(label.textContent && label.textContent.length > 0, '打开弹层时强度提示是空的');
    assert.strictEqual(label.textContent, I.strengthBits(out).label);
    const bar = mount.querySelector('.cv-gen-meter > i');
    assert.ok(bar, '标记里没有 .cv-gen-meter > i');
    assert.strictEqual(bar.style.width, I.clamp(I.strengthBits(out).bits / 100 * 100, 6, 100) + '%',
      '色条宽度没设，或与强度算出来的对不上');

    // 整块重绘（列表自动刷新）之后强度条也不能又变空：宽度与文案写死在标记里
    const html = mount.innerHTML;
    assert.ok(html.indexOf('<i style="width:') >= 0, '强度条宽度没写进标记，重绘后会变空');
    assert.ok(html.indexOf('cv-gen-meter-label">' + I.strengthBits(out).label) >= 0, '强度文案没写进标记，重绘后会变空');
    // 界面文案与排除集合必须是同一个常量
    assert.ok(html.indexOf('排除易混字符 <code>' + I.AMBIGUOUS_CHARS + '</code>') >= 0, '界面文案与排除集合对不上');

    // 补强度提示不该顺带再生成一次口令
    seed.reset();
    I.generatePassword({ length: 20, upper: true, lower: true, digit: true, symbol: true, noConfusable: true });
    assert.strictEqual(usedOpen, seed.used(), '打开弹层不该多生成一次口令');
  } finally {
    seed.restore();
    if (realDoc === undefined) delete globalThis.document; else globalThis.document = realDoc;
  }
});
