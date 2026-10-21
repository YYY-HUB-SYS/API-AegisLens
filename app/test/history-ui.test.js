/* 观测历史（最近观测）界面。
   做法照 autorefresh.test.js：按「===== 段落标记 =====」把那一段从 index.html 里切出来，
   扔进 vm 沙箱跑 —— 断言的是真行为，不是「文件里有没有某个词」。
   后端契约见 app/src/api.js 与 app/src/storage.js：
     GET /api/keys/:id/history?kind=test|balance&limit=N → { history: [...] }
     行字段：{ id, keyId, at, kind, status, latency, value, detail }
   kind=test 的行有 latency 没有 value；kind=balance 的行有 value 没有 latency。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const LAYOUT_MAIN = path.join(__dirname, '..', 'public', 'app', 'layout-main.js');
const html = fs.readFileSync(INDEX, 'utf8');
const layoutMain = fs.readFileSync(LAYOUT_MAIN, 'utf8');

const MARK = '/* ================= 观测历史 =================';

function section(src, marker) {
  const a = src.indexOf(marker);
  assert.ok(a > -1, 'index.html 里找不到段落标记：' + marker);
  const b = src.indexOf('/* ================= ', a + marker.length);
  assert.ok(b > a, '段落后面没有下一个标记，切片会一直吃到文件尾：' + marker);
  return src.slice(a, b);
}

/* 页面里那个 esc：& < > " ' 都要转义，观测记录里的 detail 是厂商返回的原文 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 起一个沙箱：页面里用到的东西全是假的，只有被测的那几件是真的 */
function sandbox(opts) {
  const o = opts || {};
  const calls = { api: [], rerender: [] };
  const sb = {
    console: console,
    ui: {
      historyOpen: {}, historyKind: {}, historyRows: {},
      historyLoading: {}, historyErr: {}, historyShown: {}
    },
    ic: name => '<svg class="ic"><use href="#i-' + name + '"></use></svg>',
    esc: esc,
    P: id => ({ name: id, currency: (o.currency || 'CNY') }),
    api: (method, p) => {
      calls.api.push(method + ' ' + p);
      if (o.failWith) return Promise.reject(o.failWith);
      return Promise.resolve(o.response || { history: [] });
    },
    rerenderCard: id => { calls.rerender.push(id); }
  };
  vm.createContext(sb);
  vm.runInContext(section(html, MARK), sb, { filename: 'index.html#history' });
  sb.__calls = calls;
  return sb;
}

function keyOf(id) { return { id: id, name: 'K' + id, platform: 'deepseek' }; }

function row(over) {
  return Object.assign({
    id: 1, keyId: 7, at: '2026-10-21T08:12:03.000Z',
    kind: 'test', status: 'pass', latency: 123, value: null, detail: null
  }, over || {});
}

test('段落切得出来，且里面没有把 kind 写死成后端不认的值', () => {
  const src = section(html, MARK);
  assert.ok(src.length > 500, '观测历史那一段太短了：' + src.length);
  /* 后端只认 test / balance，kind=all 会被 400 挡掉 —— 「全部」只能不发 kind 参数 */
  assert.ok(src.includes("'test'") && src.includes("'balance'"), 'kind 只该有 test 与 balance 两种取值');
});

test('kind 切换会带上对应的查询参数：「全部」不带 kind，其余各带各的', async () => {
  const sb = sandbox();
  const k = keyOf(7);

  sb.ui.historyKind[7] = 'test';
  await sb.loadHistory(k);
  sb.ui.historyKind[7] = 'balance';
  await sb.loadHistory(k);
  sb.ui.historyKind[7] = 'all';
  await sb.loadHistory(k);

  const calls = sb.__calls.api;
  assert.ok(calls.includes('GET /keys/7/history?kind=test&limit=200'),
    '连通测试要发 kind=test：' + calls.join(' | '));
  assert.ok(calls.includes('GET /keys/7/history?kind=balance&limit=200'),
    '余额要发 kind=balance：' + calls.join(' | '));
  const allCall = calls.filter(c => c.indexOf('kind=') < 0);
  assert.strictEqual(allCall.length, 1, '「全部」那次不该带 kind 参数：' + calls.join(' | '));
  assert.ok(allCall[0].indexOf('/keys/7/history?limit=200') > -1,
    '「全部」仍要限量：' + allCall[0]);
  /* 后端默认就是 200 条，前端不该一次把 1000 条全要过来 */
  assert.ok(calls.every(c => c.indexOf('limit=200') > -1), '每次都只取 200 条：' + calls.join(' | '));
});

test('一次不铺开：200 条只先画 50 行，剩下的点「再看一批」才放出来', () => {
  const sb = sandbox();
  const k = keyOf(7);
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(row({ id: i + 1, latency: i }));
  sb.ui.historyRows[7] = rows;
  sb.ui.historyOpen[7] = true;

  const out = sb.renderHistoryPanel(k);
  const drawn = (out.match(/class="hist-row"/g) || []).length;
  assert.strictEqual(drawn, 50, '一次只该画 50 行，实得 ' + drawn);
  assert.ok(out.includes('data-act="history-more"'), '剩下的要有个出口，不许悄悄丢掉');
  assert.ok(out.includes('还有 150 条没显示'), '要说明还剩多少：' + out.slice(-260));

  /* 再点一次：画到 100 行 */
  sb.ui.historyShown[7] = 100;
  assert.strictEqual((sb.renderHistoryPanel(k).match(/class="hist-row"/g) || []).length, 100);
});

test('空状态友好：这把 Key 没有观测记录时说一句人话，不给空白页', () => {
  const sb = sandbox();
  const k = keyOf(7);
  sb.ui.historyRows[7] = [];
  sb.ui.historyOpen[7] = true;
  const out = sb.renderHistoryPanel(k);
  assert.ok(out.includes('这把 Key 还没有观测记录'), '空状态文案不对：' + out);
  assert.ok(out.includes('测一次连通或查一次余额'), '空状态要告诉人下一步做什么：' + out);
  assert.ok(out.indexOf('hist-row') < 0, '空状态不该画出行');
});

test('每条都按 listHistory 的真实字段显示：时间、结果、延迟或余额', () => {
  const sb = sandbox();
  const k = keyOf(7);
  sb.ui.historyOpen[7] = true;
  sb.ui.historyRows[7] = [
    row({ id: 1, kind: 'test', status: 'pass', latency: 123, value: null, detail: null }),
    row({ id: 2, kind: 'test', status: 'fail', latency: 3000, value: null, detail: '密钥无效或无权限（HTTP 401）' }),
    row({ id: 3, kind: 'balance', status: 'ok', latency: null, value: 12.5, detail: null })
  ];
  const out = sb.renderHistoryPanel(k);
  /* 时间字段叫 at（ISO 串），不是 time/timestamp */
  assert.ok(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(out), '时间没画出来：' + out);
  assert.ok(out.includes('通'), '连通结果没画出来');
  assert.ok(out.includes('不通'), '失败结果没画出来');
  assert.ok(out.includes('123ms'), '连通测试的 latency 没画出来：' + out);
  assert.ok(out.includes('¥12.50'), '余额的 value 没画出来：' + out);
  assert.ok(out.includes('密钥无效或无权限'), '失败原因（detail）没画出来');
  /* test 行没有 value，balance 行没有 latency —— 不许拿不存在的字段凑数 */
  assert.ok(out.indexOf('3000ms') > -1, '失败那次也要报延迟');
});

test('无障碍：开关带 aria-expanded / aria-controls，面板是 region，类型按钮带 aria-pressed', () => {
  const sb = sandbox();
  const k = keyOf(7);

  const closed = sb.renderHistoryBlock(k);
  assert.ok(closed.includes('data-act="toggle-history"'), '缺开关按钮');
  assert.ok(closed.includes('aria-expanded="false"'), '折叠态没标 aria-expanded');
  assert.ok(closed.includes('aria-controls="hist-panel-7"'), '开关没指到面板');
  assert.ok(closed.includes('id="hist-panel-7"'), '面板没有对应的 id');
  assert.ok(closed.includes('role="region"'), '面板要是个 region');
  assert.ok(closed.includes('aria-label="最近观测"'), '面板要有名字');
  assert.ok(closed.includes(' hidden'), '折叠态面板要藏起来');
  assert.ok(closed.includes('aria-pressed="true"'), '当前 kind 要标出来');
  assert.ok(closed.includes('aria-pressed="false"'), '其余 kind 也要标出来');

  sb.ui.historyOpen[7] = true;
  const open = sb.renderHistoryBlock(k);
  assert.ok(open.includes('aria-expanded="true"'), '展开态没标 aria-expanded');
  assert.ok(open.indexOf(' hidden') < 0, '展开态不该还藏着');
});

test('面板与开关用的是 sprite 里那个 #i-activity', () => {
  assert.ok(html.includes('<symbol id="i-activity"'), 'sprite 里应有 i-activity');
  const sb = sandbox();
  const out = sb.renderHistoryBlock(keyOf(7));
  assert.ok(out.includes('#i-activity'), '观测区没用 #i-activity：' + out);
});

test('读失败要说话，不能留一块空白', () => {
  const sb = sandbox();
  const k = keyOf(7);
  sb.ui.historyErr[7] = '服务没有回应';
  sb.ui.historyOpen[7] = true;
  const out = sb.renderHistoryPanel(k);
  assert.ok(out.includes('读不到观测记录'), '出错时要有提示：' + out);
  assert.ok(out.includes('服务没有回应'), '出错时要说清原因');
});

test('423 不再往卡上贴错误（那时整页已经进解锁门了）', async () => {
  const err = new Error('保险库未解锁');
  err.status = 423;
  const sb = sandbox({ failWith: err });
  sb.ui.historyRows[7] = undefined;
  await sb.loadHistory(keyOf(7));
  assert.strictEqual(sb.ui.historyErr[7], null, '423 不该被当成卡片自己的错');
});

test('布局层要把这一块剪进详情面板：否则主视图根本看不见它', () => {
  assert.ok(layoutMain.includes("extractBlock(card, 'hist-block')"),
    'layout-main.js 的 detailHtml 得剪 hist-block，否则主视图的详情面板里没有观测区');
});

/* 剪块那套机制是布局层真在用的代码：按 div 深度配平取出一整块。
   这里拿真函数跑一遍，确认 hist-block 能被完整剪出来（嵌套 div 不多不少）。 */
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at > -1, 'layout-main.js 里找不到函数 ' + name);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('函数 ' + name + ' 的括号没配平');
}

test('剪块机制认得 hist-block（嵌套 div 配平，不多剪也不少剪）', () => {
  const extractBlock = new Function(extractFn(layoutMain, 'extractBlock') + '; return extractBlock;')();
  const card = '<article class="keycard">' +
    '<div class="kc-main"><div class="params">x</div>' +
    '<div class="hist-block"><button class="btn">最近观测</button>' +
    '<div class="hist-panel"><div class="hist-list"><div class="hist-row">1</div></div></div>' +
    '</div></div></article>';
  const cut = extractBlock(card, 'hist-block');
  assert.ok(cut.startsWith('<div class="hist-block">'), '剪出来的是 hist-block：' + cut);
  assert.ok(cut.endsWith('</div>'), '剪出来的是完整一块：' + cut);
  assert.ok(cut.indexOf('hist-row') > -1, '里面那几层也得一起剪走：' + cut);
  assert.strictEqual(extractBlock(card, 'tool-add-bar'), '', '不存在的一块剪出空串');
});
