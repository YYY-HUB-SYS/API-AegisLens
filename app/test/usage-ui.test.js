/* 限额快照的界面接线：**必须落在真正被画的那一层**。

   踩过的坑（2026-10-21）：这一段界面加在了 index.html 的 renderCard() 里，
   但界面主视图的详情面板是 app/public/app/layout-shared.js 的 detailOf() 画的
   （layout-main.js 的 detailHtml → S.detail(ctx, k)）——
   index.html 那份 renderCard 只是**单卡重绘**（点「显示明文」之类）才走的路。
   结果：代码在、文档写了、后端接口也通，**界面上就是没有那一格**。

   所以这里守两件事：
   ① layout 层（真正被画的那一层）产出里必须有「限额快照」与「查限额」；
   ② index.html 的 AegisUI 必须暴露这两个原子 —— 不暴露，layout 层那格永远是空的。

   两条路都要有：主视图走 layout 层，单卡重绘走 index.html。
   只加一处 = 用户在一种操作下看得到、另一种操作下消失。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..');
const PUBLIC = path.join(APP, 'public');
const INDEX = path.join(PUBLIC, 'index.html');

const html = fs.readFileSync(INDEX, 'utf8');
const sharedSrc = fs.readFileSync(path.join(PUBLIC, 'app', 'layout-shared.js'), 'utf8');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* layout-shared.js 顶层不碰 document/window，只挂 window.LayoutShared ⇒ 一个空 window 就够 */
function loadShared() {
  const sb = { window: {} };
  vm.createContext(sb);
  vm.runInContext(sharedSrc, sb, { filename: 'layout-shared.js' });
  return sb.window.LayoutShared;
}

const KEY = {
  id: 7, name: '验证用', platform: 'deepseek', customName: '', model: 'deepseek-chat',
  reg: '', exp: '', revoked: false, keyMasked: '****abcd',
  balance: { value: 12.34, status: 'ok', updatedAt: '2026-10-21T13:05:00.000Z' },
  usage: {
    status: 'ok', kind: 'quota', updatedAt: '2026-10-21T13:05:00.000Z',
    windows: [{ name: '5 小时', used: 1200, limit: 1500, resetAt: '2026-10-21T18:00:00.000Z' }]
  },
  endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }],
  models: [], assigned: [], test: null
};

function fakeCtx(usageText, usageTitle) {
  return {
    api: {
      esc: esc,
      usageText: usageText,
      usageTitle: usageTitle,
      balanceTitle: function () { return '上次查询时的余额（2026-10-21 13:05）'; },
      renderCard: null,
      platLabel: function () { return 'DeepSeek'; },
      balanceText: function () { return '¥12.34'; },
      expiryText: function () { return '长期有效'; },
      keyStatus: function () { return 'ok'; },
      shortName: function () { return '验证用'; },
      isAutoName: function () { return false; },
      testChip: function () { return ''; },
      authNoteOf: function () { return ''; },
      keyMaskText: function () { return '****abcd'; },
      styleShort: function () { return 'OpenAI'; },
      styleLabel: function () { return 'OpenAI 风格'; },
      icon: function () { return ''; },
      ic: function () { return ''; },
      modelsBtnOf: function () { return ''; }
    },
    platforms: { deepseek: { name: 'DeepSeek', color: '#22A5F7', currency: 'CNY' } },
    ui: { authOpen: false, assignedOpen: {}, modelsLoading: {}, editingNote: {}, editingSupp: {} },
    state: { layout: 'c', keys: [KEY] }
  };
}

test('layout 层（界面真正在画的那一层）产出里有「限额快照」与「查限额」', () => {
  const L = loadShared();
  assert.ok(L && typeof L.detail === 'function', 'layout-shared.js 没有导出 detail()');
  const ctx = fakeCtx(function () { return '5 小时 1200/1500'; }, function () { return '上次查询时的限额快照'; });
  const out = L.detail(ctx, KEY);

  assert.ok(out.indexOf('限额快照') > -1, '详情面板里没有「限额快照」这一格');
  assert.ok(out.indexOf('data-act="key-usage"') > -1, '详情面板里没有「查限额」按钮');
  assert.ok(out.indexOf('5 小时 1200/1500') > -1, '限额快照的值没渲染出来');
});

test('layout 层在 ctx.api 缺这两个原子时不会炸（退回空串，不显示这格）', () => {
  const L = loadShared();
  const ctx = fakeCtx(undefined, undefined);
  delete ctx.api.usageText;
  delete ctx.api.usageTitle;
  const out = L.detail(ctx, KEY);
  assert.ok(out, 'detail() 应当照常产出');
  assert.ok(out.indexOf('限额快照') > -1, '格位还在，只是值为空（这是刻意的：不猜）');
});

test('余额那一格也标出数据新鲜度（余额同样是快照，不标时间看着像实时的）', () => {
  const L = loadShared();
  const ctx = fakeCtx(function () { return '5 小时 1200/1500'; }, function () { return '快照说明'; });
  const out = L.detail(ctx, KEY);
  assert.ok(out.indexOf('上次查询时的余额') > -1, '余额格没有带快照时间');
});

test('AegisUI 暴露了 usageText / usageTitle —— 不暴露 layout 层那格永远是空的', () => {
  assert.ok(/get usageText\(\)\s*\{\s*return usageText;\s*\}/.test(html),
    'AegisUI 里没有暴露 usageText');
  assert.ok(/get usageTitle\(\)\s*\{\s*return usageTitle;\s*\}/.test(html),
    'AegisUI 里没有暴露 usageTitle');
  assert.ok(/get balanceTitle\(\)\s*\{\s*return balanceTitle;\s*\}/.test(html),
    'AegisUI 里没有暴露 balanceTitle（余额格的新鲜度会一直是空的）');
});

test('单卡重绘那条路（index.html 的 renderCard）也有这两样', () => {
  /* index.html 的 IIFE 太重（依赖整个页面），跑不起来 ⇒ 这一条做源码层断言。
     守的是「两处都要有」：只加一处 = 用户在一种操作下看得到、另一种操作下消失。 */
  assert.ok(html.indexOf('data-act="key-usage"') > -1, 'index.html 的 renderCard 里没有「查限额」按钮');
  assert.ok(html.indexOf('>限额快照 <b>') > -1, 'index.html 的 renderCard 里没有「限额快照」这一格');
});

test('两个渲染层的 data-act 名字一致（事件委托按名字找，分叉了就点了没反应）', () => {
  const sharedActs = new Set();
  const re = /data-act="([a-z-]+)"/g;
  let m;
  while ((m = re.exec(sharedSrc))) sharedActs.add(m[1]);
  const indexActs = new Set();
  while ((m = re.exec(html))) indexActs.add(m[1]);
  assert.ok(sharedActs.has('key-usage'), 'layout 层没有 key-usage 这个动作名');
  assert.ok(indexActs.has('key-usage'), 'index.html 没有 key-usage 这个动作名');
});
