/* 定时调度接界面的那几条硬边界。
   定时调度那段代码写在 index.html 的内联脚本里（不能新开 public/app/*.js：
   那些文件要在 app/src/app.js 的 APP_ASSETS 里登记才能被服务，
   而 app/src/** 这轮不许动），所以这里把那一段抠出来，
   放进 vm 沙箱里跑：假的 document / api，
   断言的是真行为，不是字符串里有没有某个词。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');

const START = '/* ================= 定时调度（开关 + 间隔 + 运行记录） =================';
const END = '/* ================= 列表自动刷新（轻量轮询） =================';

const UNLOCKED = { unlocked: true, mode: 'envelope', passphraseSet: true };
const OFF = {
  schedule: {
    enabled: false, intervalMinutes: 60, running: false,
    lastRunAt: null, lastResult: null, lastError: null, nextRunAt: null
  }
};

function scheduleSection() {
  const a = html.indexOf(START);
  const b = html.indexOf(END, a);
  assert.ok(a > -1, 'index.html 里找不到定时调度那一段（起始标记被改了？）');
  assert.ok(b > a, 'index.html 里找不到定时调度那一段的结束标记');
  return html.slice(a, b);
}

/* 假元素：只要够那几行代码用（属性、textContent、checked、disabled、hidden） */
function fakeEl() {
  return {
    textContent: '', value: '', checked: false, disabled: false, hidden: false,
    attrs: {}, handlers: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    focus() {}
  };
}

const EL_IDS = [
  'btn-schedule', 'schedule-label', 'f-schedule-enabled', 'f-schedule-interval',
  'btn-schedule-save', 'btn-schedule-run', 'schedule-locked', 'schedule-err',
  'schedule-switch-state', 'schedule-last-run', 'schedule-last-result',
  'schedule-next-run', 'schedule-last-error'
];

/* 起一个沙箱：页面里用到的东西全是假的，只有被测的那几件是真的 */
function sandbox(opts) {
  const o = opts || {};
  const calls = [];
  const els = {};
  EL_IDS.forEach(id => { els[id] = fakeEl(); });
  const responses = o.responses || {};

  const sb = {
    console: console,
    document: {
      activeElement: null,
      getElementById: id => (els[id] || null)
    },
    api: function (method, p, body) {
      calls.push({ method: method, path: p, body: body });
      let r = responses[method + ' ' + p];
      if (typeof r === 'function') r = r(body, calls);
      if (r && r.__reject) return Promise.reject(new Error(r.__reject));
      return Promise.resolve(r || {});
    },
    toast: function (msg, type) { sb.__toasts.push({ msg: msg, type: type }); },
    openOverlay: function (id) { sb.__opened.push(id); },
    __calls: calls,
    __els: els,
    __toasts: [],
    __opened: []
  };
  vm.createContext(sb);
  vm.runInContext(scheduleSection(), sb, { filename: 'index.html#schedule' });
  return sb;
}

function posts(sb) {
  return sb.__calls.filter(c => c.method === 'POST');
}

/* ---------- 静态结构 ---------- */

test('顶栏：定时调度按钮挨着「刷新余额」，用的是 sprite 里那个日历图标', () => {
  assert.ok(html.includes('id="btn-schedule"'), '顶栏没有定时调度按钮');
  assert.ok(/<symbol id="i-calendar-days"/.test(html), 'sprite 里没有 i-calendar-days');
  const btn = html.match(/<button[^>]*id="btn-schedule"[\s\S]*?<\/button>/);
  assert.ok(btn, '按钮没找着');
  assert.ok(btn[0].indexOf('href="#i-calendar-days"') > -1, '按钮没用 sprite 里的日历图标');
  const iRefresh = html.indexOf('id="btn-refresh-all"');
  const iSchedule = html.indexOf('id="btn-schedule"');
  assert.ok(iRefresh > -1 && iSchedule > iRefresh, '按钮没放在刷新余额旁边');
});

test('顶栏按钮：带 aria-pressed 与状态文案，初始是关', () => {
  const btn = html.match(/<button[^>]*id="btn-schedule"[^>]*>/)[0];
  assert.ok(/aria-pressed="false"/.test(btn), '初始状态不是关（默认不许开）');
  assert.ok(html.includes('id="schedule-label"'), '按钮没有状态文案');
  assert.ok(html.includes('定时调度 · 关'), '初始文案没说是关');
});

test('弹层：role/aria-modal/tabindex/aria-labelledby 齐备，且指向真实存在的标题', () => {
  const m = html.match(/id="overlay-schedule">\s*<div class="modal"([^>]*)>/);
  assert.ok(m, '找不到定时调度弹层的 .modal');
  const attrs = m[1];
  assert.ok(/role="dialog"/.test(attrs), '缺 role="dialog"');
  assert.ok(/aria-modal="true"/.test(attrs), '缺 aria-modal="true"');
  assert.ok(/tabindex="-1"/.test(attrs), '缺 tabindex="-1"');
  const labelled = attrs.match(/aria-labelledby="([^"]+)"/);
  assert.ok(labelled, '缺 aria-labelledby');
  assert.ok(html.indexOf('id="' + labelled[1] + '"') > -1,
    'aria-labelledby 指向的 id 不存在：' + labelled[1]);
});

test('弹层：焦点能进能出靠的是既有那套 openOverlay/closeOverlay，本段没有另发明一套', () => {
  const sec = scheduleSection();
  assert.ok(/openOverlay\('overlay-schedule'\)/.test(sec), '没有走既有的 openOverlay');
  assert.ok(/data-close="overlay-schedule"/.test(html), '没有关闭按钮，弹层关不掉');
  /* 既有的遮罩点关闭与 Esc 关闭都按 .overlay.show 走：新弹层得是 .overlay 才行 */
  assert.ok(/<div class="overlay" id="overlay-schedule">/.test(html), '弹层根节点不是 .overlay');
});

test('这一段新增的 id 全局唯一（撞了会把别的控件的点击接走）', () => {
  const ids = EL_IDS.concat([
    'overlay-schedule', 'schedule-title', 'schedule-status', 'schedule-run-note'
  ]);
  ids.forEach(id => {
    const n = (html.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    assert.strictEqual(n, 1, 'id 重复或没落盘：' + id + '（出现 ' + n + ' 次）');
  });
});

test('「立即跑一轮」：后端有出口了，按钮就该能用（不再是装样子）', () => {
  const btn = html.match(/<button[^>]*id="btn-schedule-run"[^>]*>/);
  assert.ok(btn, '弹层里没有「立即跑一轮」按钮');
  /* 后端补了 POST /api/schedule/run（2026-10-21），按钮不该再是禁用的：
     禁着而接口在那儿，就是界面在装样子。 */
  assert.ok(!/\sdisabled(\s|>|=)/.test(btn[0]), '后端已有出口，按钮不该还禁用着');
  /* 但这按钮会**真的朝厂商发请求**，所以要点明后果，不能让人无脑点 */
  assert.ok(/真的朝厂商发请求|会真的朝厂商发请求/.test(html), '要写明这一按会真的朝厂商发请求');
  /* 限流档位也要露出来（后端是 5 次/小时） */
  assert.ok(/5 次\/小时|5次\/小时/.test(html), '要写明限流档位');
});

test('这一段没用 data-act 动作名（docs.test.js 按 data-act 数量对账，用了就得同步改文档）', () => {
  assert.ok(!/data-act\s*=/.test(scheduleSection()), '用了 data-act 就要同步改 docs/API.md 与 docs/API_EN.md 的数量');
});

/* ---------- 行为（沙箱里真跑） ---------- */

test('开关默认是关的：代码初值是关，界面不会自己开', async () => {
  const sec = scheduleSection();
  assert.ok(/var scheduleState = \{[\s\S]*?enabled: false/.test(sec), 'JS 初值不是关');
  assert.ok(!/enabled:\s*true/.test(sec), '代码里冒出了 enabled: true');

  const sb = sandbox({ responses: { 'GET /schedule': OFF, 'GET /vault/status': UNLOCKED } });
  assert.strictEqual(sb.scheduleState.enabled, false, '一上来就是开的');
  await sb.openScheduleModal();
  assert.strictEqual(sb.scheduleState.enabled, false, '打开弹层把开关打开了');
  assert.deepStrictEqual(posts(sb), [], '打开弹层就发了写请求');
});

test('开机只读一次状态，不发任何写请求', () => {
  const sb = sandbox({ responses: { 'GET /schedule': OFF } });
  assert.ok(sb.__calls.some(c => c.method === 'GET' && c.path === '/schedule'), '开机没读调度状态');
  assert.deepStrictEqual(posts(sb), [], '开机发了写请求');
});

test('间隔分钟数非法：前端自己挡住，不发请求，给人话提示', async () => {
  const bad = ['', '0', '-5', '10081', 'abc', '1.5'];
  for (const v of bad) {
    const sb = sandbox({ responses: { 'GET /schedule': OFF, 'GET /vault/status': UNLOCKED } });
    await sb.openScheduleModal();
    sb.__calls.length = 0;
    sb.__els['f-schedule-enabled'].checked = true;
    sb.__els['f-schedule-interval'].value = v;
    const ok = await sb.saveSchedule();
    assert.strictEqual(ok, false, '越界的间隔不该被接受：' + JSON.stringify(v));
    assert.deepStrictEqual(posts(sb), [], '越界间隔不该发请求：' + JSON.stringify(v));
    const msg = sb.__els['schedule-err'].textContent;
    assert.ok(msg && msg.indexOf('间隔分钟数') > -1, '没给人话提示：' + JSON.stringify(v) + ' → ' + msg);
    assert.ok(msg.indexOf('1') > -1 && msg.indexOf('10080') > -1, '提示里没说合法范围：' + msg);
  }
});

test('锁着的时候：弹层说保险库未解锁，开关被摁住，不报错也不发写请求', async () => {
  const sb = sandbox({
    responses: {
      'GET /schedule': OFF,
      'GET /vault/status': { unlocked: false, mode: 'envelope', passphraseSet: true }
    }
  });
  await sb.openScheduleModal();
  const locked = sb.__els['schedule-locked'];
  assert.strictEqual(locked.hidden, false, '锁着却没提示未解锁');
  assert.ok(locked.textContent.indexOf('保险库未解锁') > -1, '提示里没有「保险库未解锁」：' + locked.textContent);
  assert.strictEqual(sb.__els['f-schedule-enabled'].disabled, true, '锁着却还能拨开关');
  assert.strictEqual(sb.__els['f-schedule-interval'].disabled, true, '锁着却还能填间隔');
  assert.strictEqual(sb.__els['btn-schedule-save'].disabled, true, '锁着却还能保存');
  assert.strictEqual(sb.__els['schedule-err'].textContent, '',
    '锁着不该报错：' + sb.__els['schedule-err'].textContent);
  assert.deepStrictEqual(posts(sb), [], '锁着不该发写请求');
});

test('锁着的时候：连保险库状态都问不到，也不能当成已解锁', async () => {
  const sb = sandbox({
    responses: {
      'GET /schedule': OFF,
      'GET /vault/status': { __reject: '服务没回应' }
    }
  });
  await sb.openScheduleModal();
  assert.strictEqual(sb.__els['f-schedule-enabled'].disabled, true, '状态问不到却还能拨开关');
  assert.strictEqual(sb.__els['btn-schedule-save'].disabled, true, '状态问不到却还能保存');
  assert.deepStrictEqual(posts(sb), [], '状态问不到却发了写请求');
});

test('打开弹层：拉一次状态，把上次运行的统计与上次错误显示出来', async () => {
  const sb = sandbox({
    responses: {
      'GET /vault/status': UNLOCKED,
      'GET /schedule': {
        schedule: {
          enabled: true, intervalMinutes: 30, running: false,
          lastRunAt: '2026-10-21T02:00:00.000Z',
          lastResult: {
            at: '2026-10-21T02:00:00.000Z', keys: 5, passed: 3, failed: 1, skipped: 1,
            balanceUpdated: 2, balanceFailed: 0, durationMs: 1234
          },
          lastError: '厂商返回 401',
          nextRunAt: '2026-10-21T03:00:00.000Z'
        }
      }
    }
  });
  await sb.openScheduleModal();
  assert.ok(sb.__calls.some(c => c.method === 'GET' && c.path === '/schedule'), '没读调度状态');
  const res = sb.__els['schedule-last-result'].textContent;
  assert.ok(res.indexOf('5') > -1, '上一轮的密钥数没显示：' + res);
  assert.ok(res.indexOf('1234') > -1, '上一轮的耗时没显示：' + res);
  assert.ok(res.indexOf('3') > -1, '上一轮的通过数没显示：' + res);
  assert.strictEqual(sb.__els['schedule-last-error'].hidden, false, '上次错误没显示');
  assert.ok(sb.__els['schedule-last-error'].textContent.indexOf('厂商返回 401') > -1,
    '上次错误的内容不对：' + sb.__els['schedule-last-error'].textContent);
  assert.ok(sb.__els['schedule-last-run'].textContent.length > 4, '上次运行时间没显示');
  assert.ok(sb.__els['schedule-next-run'].textContent.indexOf('未开启') === -1, '开着却显示未开启');
});

test('按钮的 aria-pressed 与文案跟着服务端状态走', async () => {
  const on = sandbox({
    responses: {
      'GET /vault/status': UNLOCKED,
      'GET /schedule': {
        schedule: {
          enabled: true, intervalMinutes: 30, running: false,
          lastRunAt: null, lastResult: null, lastError: null, nextRunAt: '2026-10-21T03:00:00.000Z'
        }
      }
    }
  });
  await on.openScheduleModal();
  assert.strictEqual(on.__els['btn-schedule'].getAttribute('aria-pressed'), 'true', '按钮没反映开');
  assert.ok(on.__els['schedule-label'].textContent.indexOf('开') > -1, '按钮文案没反映开');

  const off = sandbox({ responses: { 'GET /schedule': OFF, 'GET /vault/status': UNLOCKED } });
  await off.openScheduleModal();
  assert.strictEqual(off.__els['btn-schedule'].getAttribute('aria-pressed'), 'false', '按钮没反映关');
  assert.ok(off.__els['schedule-label'].textContent.indexOf('关') > -1, '按钮文案没反映关');
});

test('保存：把开关与间隔发给后端，并按后端回来的状态刷新界面', async () => {
  const sb = sandbox({
    responses: {
      'GET /vault/status': UNLOCKED,
      'GET /schedule': OFF,
      'POST /schedule': {
        schedule: {
          enabled: true, intervalMinutes: 15, running: false,
          lastRunAt: null, lastResult: null, lastError: null, nextRunAt: '2026-10-21T03:00:00.000Z'
        }
      }
    }
  });
  await sb.openScheduleModal();
  sb.__els['f-schedule-enabled'].checked = true;
  sb.__els['f-schedule-interval'].value = '15';
  const ok = await sb.saveSchedule();
  assert.strictEqual(ok, true, '保存没成');
  const post = posts(sb).filter(c => c.path === '/schedule');
  assert.strictEqual(post.length, 1, '保存请求数不对');
  /* body 是在 vm 沙箱里造出来的，原型不是本 realm 的那个：
     deepStrictEqual 会因为原型不同而误判，所以逐字段比。 */
  assert.deepStrictEqual(Object.keys(post[0].body).sort(), ['enabled', 'intervalMinutes']);
  assert.strictEqual(post[0].body.enabled, true, '开关没送上去');
  assert.strictEqual(post[0].body.intervalMinutes, 15, '间隔没送上去');
  assert.strictEqual(sb.__els['btn-schedule'].getAttribute('aria-pressed'), 'true', '保存后按钮没跟上');
  assert.ok(sb.__toasts.length > 0, '保存完没有回执');
});

test('关掉调度：也是走同一个接口，body 里 enabled 必须是 false', async () => {
  const sb = sandbox({
    responses: {
      'GET /vault/status': UNLOCKED,
      'GET /schedule': OFF,
      'POST /schedule': OFF
    }
  });
  await sb.openScheduleModal();
  sb.__els['f-schedule-enabled'].checked = false;
  sb.__els['f-schedule-interval'].value = '60';
  await sb.saveSchedule();
  const post = posts(sb).filter(c => c.path === '/schedule');
  assert.strictEqual(post.length, 1);
  assert.strictEqual(post[0].body.enabled, false, '关不掉');
});
