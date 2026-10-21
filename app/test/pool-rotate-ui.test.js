/* 账号池面板的三态与轮换按钮。
   池面板的渲染写在 index.html 的内联脚本里（不能新开 public/app/*.js：
   那些文件要在 app/src/app.js 的 APP_ASSETS 里登记才能被服务，
   而 app/src/** 这轮不许动），所以这里把「账号池视图」那一段抠出来，
   放进 vm 沙箱里跑：假的状态、假的 api、假的 toast，断言的是真行为：
   界面上真的分得清「当前生效 / 备用队列 / 不健康 / 未测试」，
   轮换请求的 body 形状跟后端契约一致，没有健康备用时按钮是禁用的。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..');
const INDEX = path.join(APP, 'public', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');

const START = '/* ================= 账号池视图 ================= */';
const END = '/* ================= 观测历史 =================';

function poolSection() {
  const a = html.indexOf(START);
  const b = html.indexOf(END, a);
  assert.ok(a > -1, 'index.html 里找不到账号池视图那一段（起始标记被改了？）');
  assert.ok(b > a, 'index.html 里找不到账号池视图那一段的结束标记');
  return html.slice(a, b);
}

function key(id, over) {
  return Object.assign({
    id: id, name: 'K' + id, platform: 'openai', keyMasked: '****' + id,
    model: 'gpt-4o', reg: '', exp: '', revoked: false, models: [], endpoints: []
  }, over || {});
}

function pool(id, members, keys, over) {
  return Object.assign({
    id: id, name: '池 ' + id,
    keyIds: keys.map(function (k) { return k.id; }),
    members: members,
    keys: keys
  }, over || {});
}

const PASSED_TEST = { status: 'pass', latency: 120, msg: '密钥可用', at: '2026-10-21T10:00:00.000Z' };

/* 起一个沙箱：页面里用到的东西全是假的，只有被测的那几件是真的 */
function sandbox(opts) {
  const o = opts || {};
  const calls = { api: [], toast: [], render: 0 };
  const els = {};
  const sb = {
    console: console,
    state: {
      keys: o.keys || [],
      pools: o.pools || [],
      platforms: { openai: { name: 'OpenAI', color: '#4CC2C4', currency: 'CNY' } },
      view: 'pools'
    },
    ui: { collapsedGroup: {}, assignedOpen: {}, testing: {}, editingNote: {}, editingSupp: {}, manualOpen: {} },
    revealTmp: {},
    SELF_HOST: '',
    window: {},
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    document: {
      getElementById: function (id) {
        if (!els[id]) els[id] = { innerHTML: '', textContent: '', value: '', style: {}, querySelectorAll: function () { return []; } };
        return els[id];
      },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; }
    },
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&#38;', '<': '&#60;', '>': '&#62;', '"': '&#34;', "'": '&#39;' }[c];
      });
    },
    keyStatus: function (k) { return k.revoked ? 'revoked' : (k.exp ? 'warn' : 'ok'); },
    ST_LABEL: { ok: '有效', warn: '临期', exp: '已过期', revoked: '已停用' },
    P: function (id) {
      return sb.state.platforms[id] || { name: id, color: '#8A8FA8', currency: 'CNY', supportsBalance: false };
    },
    platLabel: function (k) { return k.platform === 'custom' ? (k.customName || '自定义平台') : sb.P(k.platform).name; },
    shortName: function (k) { return String(k.name || ''); },
    balanceText: function () { return '0.00'; },
    render: function () { calls.render++; },
    toast: function (msg, type) { calls.toast.push({ msg: msg, type: type }); },
    api: function (method, p, body) {
      calls.api.push({ method: method, path: p, body: body });
      if (o.api) return o.api(method, p, body);
      return Promise.resolve({});
    }
  };
  vm.createContext(sb);
  vm.runInContext(poolSection(), sb, { filename: 'index.html#pool-view' });
  sb.__calls = calls;
  sb.__els = els;
  return sb;
}

function boardOf(sb) {
  sb.renderPoolBoard();
  return sb.__els['pool-board'].innerHTML;
}

function rotateCalls(sb) {
  return sb.__calls.api.filter(function (c) {
    return c.method === 'POST' && /\/pools\/\d+\/rotate$/.test(c.path);
  });
}

/* ---------- 三态：当前生效 / 备用队列 / 健康快照 ---------- */

test('池成员分得清「当前生效」和「备用队列」，当前生效置顶、备用按 sortIndex 排队', () => {
  const k1 = key(1), k2 = key(2), k3 = key(3);
  const p = pool(9, [
    { keyId: 3, role: 'backup', sortIndex: 1 },
    { keyId: 1, role: 'active', sortIndex: 0 },
    { keyId: 2, role: 'backup', sortIndex: 0 }
  ], [k1, k2, k3]);
  const sb = sandbox({ pools: [p], keys: [k1, k2, k3] });
  const out = boardOf(sb);

  assert.ok(out.includes('data-role="active"'), '没有标出谁是当前生效');
  assert.ok(out.includes('data-role="backup"'), '没有标出谁在备用队列');
  assert.ok(out.indexOf('当前生效') < out.indexOf('备用 第 1 位'), '当前生效的那把没排在最前面');

  /* 备用位次按 sortIndex 排：keyId 2 是 sortIndex 0，keyId 3 是 sortIndex 1 */
  assert.ok(out.indexOf('data-key="2"') < out.indexOf('data-key="3"'), '备用队列没按 sortIndex 排队');
  assert.ok(out.includes('备用 第 1 位') && out.includes('备用 第 2 位'), '备用队列的位次没显示出来');
});

test('「设为当前」只出现在备用成员上，当前生效那把不给这个按钮', () => {
  const k1 = key(1), k2 = key(2);
  const p = pool(1, [
    { keyId: 1, role: 'active', sortIndex: 0 },
    { keyId: 2, role: 'backup', sortIndex: 0 }
  ], [k1, k2]);
  const sb = sandbox({ pools: [p], keys: [k1, k2] });
  const out = boardOf(sb);

  const activeRow = out.slice(out.indexOf('data-key="1"'), out.indexOf('data-key="2"'));
  const backupRow = out.slice(out.indexOf('data-key="2"'));
  assert.ok(!activeRow.includes('pool-rotate-set'), '当前生效的那把也给了「设为当前」');
  assert.ok(backupRow.includes('data-act="pool-rotate-set"'), '备用成员旁没有「设为当前」');
});

test('不健康（连续失败 ≥2 次）与「未测试」是两种不同的呈现', () => {
  const bad = key(1, { failCount: 3 });
  const untested = key(2);
  const good = key(3, { failCount: 0, test: PASSED_TEST, lastHealthAt: PASSED_TEST.at });
  const p = pool(1, [
    { keyId: 1, role: 'active', sortIndex: 0 },
    { keyId: 2, role: 'backup', sortIndex: 0 },
    { keyId: 3, role: 'backup', sortIndex: 1 }
  ], [bad, untested, good]);
  const sb = sandbox({ pools: [p], keys: [bad, untested, good] });
  const out = boardOf(sb);

  assert.ok(out.includes('pool-health bad'), '连续失败 ≥2 次的没标成不健康');
  assert.ok(out.includes('>不健康<'), '不健康的文案没显示出来');
  assert.ok(out.includes('pool-health untested'), '没测过的没标成未测试');
  assert.ok(out.includes('>未测试<'), '未测试的文案没显示出来');
  assert.ok(out.includes('pool-health ok'), '测过且没失败的没标成健康');
  assert.ok(out.includes('>健康<'), '健康的文案没显示出来');

  /* 没测过的那一行里不许出现危险色/不健康——没测过不等于坏了 */
  const untestedRow = out.slice(out.indexOf('data-key="2"'), out.indexOf('data-key="3"'));
  assert.ok(!untestedRow.includes('pool-health bad'), '没测过的被画成不健康了');
  assert.ok(!untestedRow.includes('不健康'), '没测过的那行出现了「不健康」');
});

test('「未测试」和「不健康」在样式上是两回事（没测过不能是红底）', () => {
  const untested = html.match(/\.pool-health\.untested\s*\{[^}]*\}/);
  assert.ok(untested, '缺 .pool-health.untested 的样式');
  assert.ok(!/danger/.test(untested[0]), '未测试用了危险色');
  assert.ok(/dashed/.test(untested[0]), '未测试没有虚线边，跟别的状态长得一样');
  const bad = html.match(/\.pool-health\.bad\s*\{[^}]*\}/);
  assert.ok(bad && /danger/.test(bad[0]), '不健康没用危险色');
});

test('健康快照也能从池记录的 pool.health 里取（后端把快照挂在池上，不在密钥视图里）', () => {
  const k1 = key(1);
  const k2 = key(2);
  const p = pool(1, [
    { keyId: 1, role: 'active', sortIndex: 0 },
    { keyId: 2, role: 'backup', sortIndex: 0 }
  ], [k1, k2], {
    health: [
      { keyId: 1, role: 'active', failCount: 0, lastHealthAt: null, lastStatus: null, healthy: true },
      { keyId: 2, role: 'backup', failCount: 3, lastHealthAt: '2026-10-21T09:00:00.000Z', lastStatus: 'fail', healthy: false }
    ]
  });
  const sb = sandbox({ pools: [p] });
  const out = boardOf(sb);
  assert.ok(out.includes('>不健康<'), 'pool.health 里的不健康没显示出来');
  assert.ok(out.includes('>未测试<'), '没测过的那把没显示成未测试');
});

test('健康快照把最近一次探测时间显示出来', () => {
  const k1 = key(1, { test: PASSED_TEST, lastHealthAt: PASSED_TEST.at });
  const p = pool(1, [{ keyId: 1, role: 'active', sortIndex: 0 }], [k1]);
  const sb = sandbox({ pools: [p], keys: [k1] });
  const out = boardOf(sb);
  assert.ok(out.includes('最近探测'), '没显示最近探测时间');
});

/* ---------- 轮换 ---------- */

test('轮换到指定成员：请求体带 toKeyId，路径是 /pools/:id/rotate', async () => {
  const k1 = key(1), k2 = key(2);
  const p = pool(7, [
    { keyId: 1, role: 'active', sortIndex: 0 },
    { keyId: 2, role: 'backup', sortIndex: 0 }
  ], [k1, k2]);
  const sb = sandbox({ pools: [p], keys: [k1, k2] });
  await sb.rotatePool(p, 2, null);

  const calls = rotateCalls(sb);
  assert.strictEqual(calls.length, 1, '轮换请求没发出去');
  assert.strictEqual(calls[0].path, '/pools/7/rotate', '轮换路径不对');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0].body)), { toKeyId: 2 }, '带 toKeyId 的请求体形状不对');
});

test('轮换到下一把健康的：请求体不带 toKeyId', async () => {
  const k1 = key(1), k2 = key(2);
  const p = pool(7, [
    { keyId: 1, role: 'active', sortIndex: 0 },
    { keyId: 2, role: 'backup', sortIndex: 0 }
  ], [k1, k2]);
  const sb = sandbox({ pools: [p], keys: [k1, k2] });
  await sb.rotatePool(p, null, null);

  const calls = rotateCalls(sb);
  assert.strictEqual(calls.length, 1, '轮换请求没发出去');
  assert.strictEqual(calls[0].path, '/pools/7/rotate', '轮换路径不对');
  assert.strictEqual(calls[0].body, undefined, '自动轮换不该带 toKeyId');
});

test('轮换成功后重新拉一遍池数据并重画', async () => {
  const k1 = key(1);
  const p = pool(7, [{ keyId: 1, role: 'active', sortIndex: 0 }], [k1]);
  const sb = sandbox({ pools: [p], keys: [k1] });
  await sb.rotatePool(p, null, null);

  const got = sb.__calls.api.filter(function (c) { return c.method === 'GET' && c.path === '/pools'; });
  assert.strictEqual(got.length, 1, '轮换后没刷新池数据');
  assert.ok(sb.__calls.render > 0, '刷新后没重画');
});

test('轮换中：按钮变「轮换中…」并禁用', async () => {
  let release = null;
  const sb = sandbox({
    /* 只把 POST 挂住：GET /pools 是轮换成功之后的刷新，那一步要放行 */
    api: function (method) {
      if (method === 'POST') return new Promise(function (res) { release = res; });
      return Promise.resolve({});
    }
  });
  const btn = { disabled: false, textContent: '轮换到下一把健康的', isConnected: true };
  const running = sb.rotatePool(pool(1, [], []), null, btn);
  assert.strictEqual(btn.disabled, true, '请求在路上时按钮没禁用');
  assert.ok(btn.textContent.indexOf('轮换中') > -1, '请求在路上时按钮没显示「轮换中…」');
  release({});
  await running;
});

test('轮换失败：弹错误提示，按钮恢复可点', async () => {
  const sb = sandbox({
    api: function (method) {
      if (method === 'POST') return Promise.reject(new Error('备用队列里没有健康的密钥'));
      return Promise.resolve({});
    }
  });
  const btn = { disabled: false, textContent: '轮换到下一把健康的', isConnected: true };
  await sb.rotatePool(pool(1, [], []), null, btn);

  assert.ok(sb.__calls.toast.length === 1, '失败没有弹提示');
  assert.ok(sb.__calls.toast[0].msg.indexOf('备用队列里没有健康的密钥') > -1, '失败提示不是后端给的原话');
  assert.strictEqual(sb.__calls.toast[0].type, 'warn', '失败提示不是告警样式');
  assert.strictEqual(btn.disabled, false, '失败后按钮还禁着');
  assert.strictEqual(btn.textContent, '轮换到下一把健康的', '失败后按钮文案没恢复');
});

/* ---------- 交互要诚实 ---------- */

test('备用队列里没有健康密钥时，「轮换到下一把健康的」是禁用的并说明原因', () => {
  const k1 = key(1);
  const bad = key(2, { failCount: 2 });
  const p = pool(1, [
    { keyId: 1, role: 'active', sortIndex: 0 },
    { keyId: 2, role: 'backup', sortIndex: 0 }
  ], [k1, bad]);
  const sb = sandbox({ pools: [p], keys: [k1, bad] });
  const out = boardOf(sb);

  assert.ok(/data-act="pool-rotate-next"[^>]*disabled/.test(out), '没健康备用时按钮没禁用（按了必失败）');
  assert.ok(out.includes('不健康') || out.includes('没有健康'), '没说明为什么按不了');
});

test('备用队列是空的时候，轮换按钮同样禁用', () => {
  const k1 = key(1);
  const p = pool(1, [{ keyId: 1, role: 'active', sortIndex: 0 }], [k1]);
  const sb = sandbox({ pools: [p], keys: [k1] });
  const out = boardOf(sb);
  assert.ok(/data-act="pool-rotate-next"[^>]*disabled/.test(out), '备用队列空了还能点轮换');
});

test('还有健康备用时，轮换按钮是可点的', () => {
  const k1 = key(1);
  const healthy = key(2, { failCount: 0, test: PASSED_TEST });
  const p = pool(1, [
    { keyId: 1, role: 'active', sortIndex: 0 },
    { keyId: 2, role: 'backup', sortIndex: 0 }
  ], [k1, healthy]);
  const sb = sandbox({ pools: [p], keys: [k1, healthy] });
  const out = boardOf(sb);
  assert.ok(!/data-act="pool-rotate-next"[^>]*disabled/.test(out), '有健康备用却把轮换按钮禁用了');
});

test('没测过的备用也算能接班（没测过不等于坏了）', () => {
  const k1 = key(1);
  const untested = key(2);
  const p = pool(1, [
    { keyId: 1, role: 'active', sortIndex: 0 },
    { keyId: 2, role: 'backup', sortIndex: 0 }
  ], [k1, untested]);
  const sb = sandbox({ pools: [p], keys: [k1, untested] });
  const out = boardOf(sb);
  assert.ok(!/data-act="pool-rotate-next"[^>]*disabled/.test(out), '只因为没测过就把轮换按钮禁用了');
});

/* ---------- 老数据兜底 ---------- */

test('后端还没给 members 时，按 keyIds 兜底：第一把当当前生效，其余排队', () => {
  const k1 = key(1), k2 = key(2);
  const p = { id: 3, name: '老池', keyIds: [1, 2], keys: [k1, k2] };
  const sb = sandbox({ pools: [p], keys: [k1, k2] });
  const out = boardOf(sb);
  assert.ok(out.includes('data-role="active"'), '老数据兜底没标出当前生效');
  assert.ok(out.includes('备用 第 1 位'), '老数据兜底没排出备用位次');
});

/* ---------- data-act 名字 ---------- */

const ACT_FILES = ['public/index.html', 'public/credentials-view.js', 'public/consumer-view.js'];
const NEW_ACTS = ['pool-rotate-next', 'pool-rotate-set'];

test('新加的 data-act 名字全局唯一：各自只出现在一个按钮上，且各有一个事件分支', () => {
  for (const name of NEW_ACTS) {
    let hits = 0;
    for (const f of ACT_FILES) {
      const src = fs.readFileSync(path.join(APP, f), 'utf8');
      hits += (src.match(new RegExp('data-act="' + name + '"', 'g')) || []).length;
    }
    assert.strictEqual(hits, 1, name + ' 在前端里出现了 ' + hits + ' 处（撞名或重复使用）');
    const branches = (html.match(new RegExp("act === '" + name + "'", 'g')) || []).length;
    assert.strictEqual(branches, 1, name + ' 的事件分支不止一个');
  }
});

test('新加的 data-act 名字没和已有动作撞名', () => {
  const all = new Set();
  for (const f of ACT_FILES) {
    const src = fs.readFileSync(path.join(APP, f), 'utf8');
    (src.match(/data-act="[a-z-]+"/g) || []).forEach(function (m) { all.add(m.slice(10, -1)); });
  }
  for (const name of NEW_ACTS) {
    assert.ok(all.has(name), name + ' 根本没进前端');
  }
  /* 池相关的动作名互不重名 */
  const poolActs = Array.from(all).filter(function (n) { return n.indexOf('pool-') === 0; }).sort();
  assert.deepStrictEqual(
    poolActs,
    ['pool-add', 'pool-create', 'pool-del', 'pool-rename', 'pool-rm', 'pool-rotate-next', 'pool-rotate-set'],
    '池相关的 data-act 名字跟预期不一致：' + poolActs.join(',')
  );
});

test('轮换按钮是真 button，不是 div 冒充的', () => {
  assert.ok(/<button[^>]*data-act="pool-rotate-next"/.test(html), '轮换按钮不是 <button>');
  assert.ok(/<button[^>]*data-act="pool-rotate-set"[^>]*data-key=/.test(html), '「设为当前」不是 <button>');
});
