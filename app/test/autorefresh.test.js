/* 列表自动刷新（轻量轮询）的行为边界。
   轮询写在 index.html 的内联脚本里（不能新开 public/app/*.js：
   那些文件要在 app/src/app.js 的 APP_ASSETS 里登记才能被服务，
   而 app/src/** 这轮不许动），所以这里把那一段抠出来，
   放进 vm 沙箱里跑：假的 document / localStorage / api，
   断言的是真行为，不是字符串里有没有某个词。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');

const START = '/* ================= 列表自动刷新（轻量轮询） =================';
const END = '/* ================= 启动 ================= */';

function pollSection() {
  const a = html.indexOf(START);
  const b = html.indexOf(END, a);
  assert.ok(a > -1, 'index.html 里找不到自动刷新那一段（起始标记被改了？）');
  assert.ok(b > a, 'index.html 里找不到自动刷新那一段的结束标记');
  return html.slice(a, b);
}

function key(id, over) {
  return Object.assign({
    id: id, name: 'K' + id, platform: 'openai', keyMasked: '****' + id,
    model: 'gpt-4o', reg: '', exp: '', revoked: false, models: [], endpoints: []
  }, over || {});
}

/* 起一个沙箱：页面里用到的东西全是假的，只有被测的那几件是真的 */
function sandbox(opts) {
  const o = opts || {};
  const calls = { api: [], stats: 0, tabs: 0, board: 0 };
  const store = Object.assign({}, o.storage || {});
  const timers = [];
  const btn = {
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    handlers: [],
    addEventListener(t, fn) { this.handlers.push(fn); }
  };
  const sb = {
    console: console,
    setInterval: (fn, ms) => { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearInterval: (id) => { timers[id - 1] = null; },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    document: {
      hidden: !!o.hidden,
      activeElement: o.activeElement || null,
      body: { children: [] },
      querySelector: sel => (sel === '.overlay.show' && o.overlay ? {} : null),
      querySelectorAll: () => [],
      getElementById: id => (id === 'btn-autorefresh' ? btn : null)
    },
    state: { keys: o.keys || [], view: o.view || 'keys' },
    ui: o.ui || { testing: {}, modelsLoading: {}, enriching: {}, editingNote: {}, editingSupp: {} },
    revealTmp: o.revealTmp || {},
    findKey: id => sb.state.keys.filter(k => k.id === id)[0] || null,
    gateState: { open: !!o.gateOpen },
    api: (method, p) => {
      calls.api.push(method + ' ' + p);
      return Promise.resolve({ keys: o.nextKeys || [] });
    },
    renderStats: () => { calls.stats++; },
    renderFilterTabs: () => { calls.tabs++; },
    applyBoardLayout: () => { calls.board++; }
  };
  vm.createContext(sb);
  vm.runInContext(pollSection(), sb, { filename: 'index.html#autorefresh' });
  sb.__calls = calls;
  sb.__timers = timers;
  sb.__store = store;
  sb.__btn = btn;
  return sb;
}

test('轮询周期是 10 秒', () => {
  const sb = sandbox();
  sb.startAutoRefresh();
  assert.strictEqual(sb.__timers.length, 1, '定时器没起来');
  assert.strictEqual(sb.__timers[0].ms, 10000, '轮询周期不是 10 秒');
  sb.startAutoRefresh();
  assert.strictEqual(sb.__timers.length, 1, '重复启动不该再挂一个定时器');
});

test('标签页不可见时不轮询', async () => {
  const sb = sandbox({ hidden: true, keys: [key(1)], nextKeys: [key(1), key(2)] });
  await sb.pollOnce();
  assert.deepStrictEqual(sb.__calls.api, [], '页面看不见的时候还在拉数据');
  assert.strictEqual(sb.__calls.board, 0, '看不见的时候不该重画');
});

test('保险库锁着时不轮询', async () => {
  const sb = sandbox({ gateOpen: true, keys: [key(1)], nextKeys: [key(1), key(2)] });
  await sb.pollOnce();
  assert.deepStrictEqual(sb.__calls.api, [], '锁着的时候还在拉数据');
});

test('用户正在输入时不轮询（表单、搜索框都不许被冲掉）', async () => {
  const sb = sandbox({ activeElement: { tagName: 'INPUT' }, keys: [key(1)], nextKeys: [key(1), key(2)] });
  await sb.pollOnce();
  assert.deepStrictEqual(sb.__calls.api, [], '用户正在打字的时候还在拉数据');
  assert.strictEqual(sb.__calls.board, 0, '用户正在打字的时候不该重画');
});

test('弹层开着时不轮询（抽屉里的东西会被重画冲掉）', async () => {
  const sb = sandbox({ overlay: true, keys: [key(1)], nextKeys: [key(1), key(2)] });
  await sb.pollOnce();
  assert.deepStrictEqual(sb.__calls.api, [], '弹层开着的时候还在拉数据');
});

test('有明文正显示着时不轮询', async () => {
  const sb = sandbox({ keys: [key(1)], nextKeys: [key(1), key(2)], revealTmp: { 1: 'sk-plain' } });
  await sb.pollOnce();
  assert.deepStrictEqual(sb.__calls.api, [], '明文显示着的时候还在拉数据');
});

test('列表没变就不重画（每轮都白刷一次 DOM 是白费力气）', async () => {
  const sb = sandbox({ keys: [key(1)], nextKeys: [key(1)] });
  await sb.pollOnce();
  assert.deepStrictEqual(sb.__calls.api, ['GET /keys'], '该拉还是要拉的');
  assert.strictEqual(sb.__calls.stats, 0, '没变化却重画了统计条');
  assert.strictEqual(sb.__calls.board, 0, '没变化却重画了看板');
});

test('列表变了才重画，且重画的是统计条 + 筛选条 + 看板', async () => {
  const sb = sandbox({ keys: [key(1)], nextKeys: [key(1), key(2)] });
  await sb.pollOnce();
  assert.strictEqual(sb.__calls.stats, 1, '统计条没跟着更新');
  assert.strictEqual(sb.__calls.tabs, 1, '筛选条没跟着更新');
  assert.strictEqual(sb.__calls.board, 1, '看板没跟着更新');
  assert.strictEqual(sb.state.keys.length, 2, '新密钥没进列表');
});

test('顺序不同不算变化（本地追加 vs 服务端按 id 排）', async () => {
  const sb = sandbox({ keys: [key(2), key(1)], nextKeys: [key(1), key(2)] });
  await sb.pollOnce();
  assert.strictEqual(sb.__calls.board, 0, '只是顺序不一样就重画了');
});

test('本地自己加的密钥不会被当成外部变化再刷一次', async () => {
  /* 本地新增后 state.keys 已经含这把，服务端列表也有 —— 指纹相同，不该再重画 */
  const sb = sandbox({ keys: [key(1), key(2)], nextKeys: [key(1), key(2)] });
  await sb.pollOnce();
  assert.strictEqual(sb.__calls.board, 0, '本地刚加的密钥害得界面又重画了一遍');
});

test('外部改了名字要跟上（比的是内容，不是只比条数）', async () => {
  const sb = sandbox({ keys: [key(1)], nextKeys: [key(1, { name: 'DeepSeek 主' })] });
  await sb.pollOnce();
  assert.strictEqual(sb.__calls.board, 1, '别人改的名字没跟上');
  assert.strictEqual(sb.state.keys[0].name, 'DeepSeek 主', '新名字没进列表');
});

test('轮询只拉列表接口，不去碰单条详情', async () => {
  const sb = sandbox({ keys: [key(1)], nextKeys: [key(1)] });
  await sb.pollOnce();
  assert.ok(sb.__calls.api.every(c => c === 'GET /keys'), '轮询发了列表以外的请求：' + sb.__calls.api.join(' | '));
});

test('开关：关掉后不轮询，选择记在 localStorage 里', async () => {
  const sb = sandbox({ keys: [key(1)], nextKeys: [key(1), key(2)] });
  assert.strictEqual(sb.autoRefresh.on, true, '默认应当是开的');

  sb.__btn.handlers[0]();   /* 点一下＝关 */
  assert.strictEqual(sb.autoRefresh.on, false, '点完还是开着');
  assert.strictEqual(sb.__store['aegis-autorefresh'], 'off', '没记进 localStorage');
  assert.strictEqual(sb.__btn.getAttribute('aria-pressed'), 'false', '按钮状态没跟上');

  await sb.pollOnce();
  assert.deepStrictEqual(sb.__calls.api, [], '关掉之后还在轮询');

  sb.__btn.handlers[0]();   /* 再点＝开 */
  assert.strictEqual(sb.autoRefresh.on, true, '再点没打开');
  assert.strictEqual(sb.__store['aegis-autorefresh'], 'on', '没记进 localStorage');
});

test('localStorage 里记着 off 时，启动就是关的', () => {
  const sb = sandbox({ storage: { 'aegis-autorefresh': 'off' } });
  assert.strictEqual(sb.autoRefresh.on, false, '记住的偏好没生效');
  const sb2 = sandbox({ storage: { 'aegis-autorefresh': 'on' } });
  assert.strictEqual(sb2.autoRefresh.on, true, '记住的偏好没生效');
});

test('顶栏有那个开关按钮，标着当前状态', () => {
  assert.ok(/id="btn-autorefresh"/.test(html), '顶栏没有自动刷新开关');
  assert.ok(/id="autorefresh-label"/.test(html), '开关没有状态文案');
  const btn = html.match(/<button[^>]*id="btn-autorefresh"[^>]*>/);
  assert.ok(btn && /aria-pressed="true"/.test(btn[0]), '开关初始状态没标成开');
});
