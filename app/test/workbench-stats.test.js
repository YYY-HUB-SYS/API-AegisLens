'use strict';
/* 统计条「未测试」格 与 列表行「未测」标记：两处必须同一口径（回归守卫）。

   翻过的车：统计条一度写成
       if (!k.test || k.test.ok === null || k.test.ok === undefined) untested++;
   而后端 testKey()（app/src/adapters.js）产出的测试记录里根本没有 ok 字段
   （只有 status / latency / msg / code），k.test.ok 恒为 undefined，
   于是每把钥匙都被算成「未测试」——统计条那格永远等于总数，
   行上却只有真没测过的那几把带「未测」标记（12 把里 3 把已测，统计条写的是 12 未测试）。

   正确口径是 !k.test || k.test.ok === null，与列表层 app/public/app/layout-main.js
   的 isUntested(k) 一致（那处是对的，别动它）。

   这里不抄判定条件，而是把两处真代码都跑起来再对数：
   - 统计条：把 app/public/index.html 里的 statCell / renderStats 原样搬进 vm 上下文执行；
   - 列表行：把 app/public/app/layout-shared.js + layout-main.js 原样搬进 vm 上下文执行，
     数行上带 px-untested 标记的条数。
   两边喂同一批钥匙、同一份 test 记录（记录直接取自后端 adapters.testKey() 的真产物），
   然后断言：统计条「未测试」格 == 行上「未测」标记条数 == 从没测过连通的那批把数。
   旧写法下统计条那格会等于总数，与行上的标记条数对不上，这条当场红。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const adapters = require('../src/adapters');

const publicDir = path.join(__dirname, '..', 'public');

/* ---------- 替身：后端 fetch（不发真实厂商请求） ---------- */

function mockFetchOk(url) {
  return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 }));
}

function mockFetch401(url) {
  return Promise.resolve(new Response('{"error":"invalid"}', { status: 401 }));
}

/* ---------- 统计条那一侧：index.html 的 statCell + renderStats 原样跑 ---------- */

function loadStatsRenderer() {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const from = html.indexOf('function statCell(');
  const to = html.indexOf('function renderFilterTabs()');
  assert.ok(from > -1 && to > from, '没截到 index.html 里的 statCell / renderStats');
  const src = html.slice(from, to);

  const nums = [];
  const statsEl = {
    _html: '',
    set innerHTML(v) {
      this._html = String(v);
      nums.length = 0;
      for (const m of this._html.matchAll(/<span class="num"[^>]*>([^<]*)<\/span>/g)) {
        nums.push({
          textContent: m[1],
          parentNode: { classList: { add: function () {}, remove: function () {} } }
        });
      }
    },
    get innerHTML() { return this._html; },
    querySelectorAll: function (sel) { return sel === '.num' ? nums.slice() : []; }
  };

  const state = { keys: [] };
  const sandbox = {
    console: console,
    state: state,
    setTimeout: function () { return 0; },
    document: {
      getElementById: function (id) { return id === 'stats' ? statsEl : null; }
    },
    platLabel: function (k) { return String((k && k.platform) || ''); },
    keyStatus: function () { return 'ok'; }
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html#stats' });

  return function (keys) {
    state.keys = keys;
    sandbox.renderStats();
    return statsEl.innerHTML;
  };
}

/* ---------- 列表行那一侧：layout-shared.js + layout-main.js 原样跑 ---------- */

function loadBoardRenderer() {
  const sandbox = { console: console };
  sandbox.window = sandbox;              /* 浏览器里 window 就是全局对象 */
  vm.createContext(sandbox);
  /* 加载顺序跟 index.html 的 <head> 一致：先共享层，后主视图 */
  for (const f of ['layout-shared.js', 'layout-main.js']) {
    vm.runInContext(fs.readFileSync(path.join(publicDir, 'app', f), 'utf8'), sandbox, { filename: f });
  }
  assert.ok(sandbox.BoardLayouts && typeof sandbox.BoardLayouts.main === 'function',
    'layout-main.js 应注册 window.BoardLayouts.main');
  return function (ctx) { return sandbox.BoardLayouts.main(ctx); };
}

function boardCtx(keys) {
  return {
    keys: keys,
    platforms: {},
    ui: {},
    state: { filter: 'all' },
    api: {
      keyStatus: function () { return 'ok'; },
      platLabel: function (k) { return String((k && k.platform) || ''); },
      esc: function (s) { return String(s == null ? '' : s); }
    }
  };
}

/* 统计条某一格上的数字 */
function statNumber(html, label) {
  const m = html.match(new RegExp('<span class="num"[^>]*>(\\d+)</span><span class="lbl">' + label + '</span>'));
  assert.ok(m, '统计条里没找到「' + label + '」这一格');
  return Number(m[1]);
}

function mkKey(id, name, test) {
  return {
    id: id,
    name: name,
    platform: 'deepseek',
    customName: '',
    key: 'sk-' + id,
    endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }],
    base: 'https://api.deepseek.com',
    model: '',
    exp: '',
    balance: { status: 'unsupported' },
    test: test,
    models: [],
    assigned: []
  };
}

test('统计条「未测试」格 == 行上「未测」标记条数 == 从没测过连通的那批把数', async () => {
  /* 测试记录直接取自后端 adapters.testKey()：前端看到的就是后端产出的那个形状 */
  const ep = { url: 'https://api.deepseek.com', style: 'openai' };
  const passRec = await adapters.testKey('deepseek', ep, 'sk-pass-0001', { fetchImpl: mockFetchOk });
  const failRec = await adapters.testKey('deepseek', ep, 'sk-fail-0002', { fetchImpl: mockFetch401 });

  /* 根因钉死：后端记录里没有 ok 字段（只有 status/latency/msg/code）。
     所以「没测过」只能靠 test 记录为空来判断；把「没有 ok 字段」当成「没测过」，
     每把测过的钥匙都会被算进未测试（这条回归就是这么翻的车）。 */
  assert.strictEqual(passRec.status, 'pass', '连通时应是 pass');
  assert.strictEqual(failRec.status, 'fail', '401 时应是 fail');
  assert.strictEqual(failRec.code, '401', '失败时应带上 401');
  assert.ok(!('ok' in passRec), '连通的记录里不该有 ok 字段');
  assert.ok(!('ok' in failRec), '失败的记录里不该有 ok 字段');

  const keys = [
    mkKey(1, '没测过-A', null),                                  /* 从没测过 */
    mkKey(2, '测过-通', passRec),                                /* 测过且通 */
    mkKey(3, '测过-不通', failRec),                              /* 测过但失败 */
    mkKey(4, '没测过-B', null),                                  /* 从没测过 */
    mkKey(5, '测过-通-2', passRec),                              /* 测过且通 */
    mkKey(6, '老记录-没结论', { at: '2026-09-01T00:00:00.000Z', ok: null })  /* 有记录但没结论 */
  ];
  const shouldBeUntested = 3;      /* 两把没测过 + 一条没结论的老记录 */

  const statsHtml = loadStatsRenderer()(keys);
  const untestedCell = statNumber(statsHtml, '未测试');
  assert.strictEqual(statNumber(statsHtml, '个密钥'), keys.length, '统计条总数格应等于钥匙总数');

  const boardHtml = loadBoardRenderer()(boardCtx(keys));
  const marked = (boardHtml.match(/class="px-untested"/g) || []).length;
  assert.strictEqual(marked, shouldBeUntested,
    '行上带「未测」标记的条数应是 ' + shouldBeUntested + '，实得 ' + marked);

  assert.strictEqual(untestedCell, marked,
    '统计条「未测试」格（' + untestedCell + '）必须与行上「未测」标记条数（' + marked + '）一致');
  assert.strictEqual(untestedCell, shouldBeUntested,
    '统计条「未测试」格必须等于从没测过连通的那批把数（' + shouldBeUntested + '）');
});
