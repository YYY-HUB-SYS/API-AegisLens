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

const submit = view.__internals.submitPayload;

/* 后端 buildPatch 的语义（credentials-api.js:149/154）：键缺失＝不改，空串＝清空。
   这两条一起决定了前端绝不能把没碰过的字段照直发出去。 */
const DRAFT = { id: 7, title: '内网', username: 'ops', url: 'https://intra', folder: '', tags: '', password: '', note: '', totpSecret: '' };

function keysOf(p) { return Object.keys(p).sort().join(','); }

test('编辑时没碰过口令与备注 → 请求体里根本不出现这两个键', () => {
  const p = submit(Object.assign({}, DRAFT), 'update', { pw: false, note: false });
  assert.ok(!('password' in p), '带上 password:"" 就等于把用户存了的口令删掉');
  assert.ok(!('note' in p), '同理，备注也会被清空');
  assert.strictEqual(keysOf(p), 'folder,tags,title,url,username');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-view-'));
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
      body: JSON.stringify({ title: '仅私钥那条', username: 'svc', secret: 'sk-chain-123456', note: '备注也在' })
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
    const META = ['id', 'title', 'username', 'url', 'lastUsedAt'];
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
