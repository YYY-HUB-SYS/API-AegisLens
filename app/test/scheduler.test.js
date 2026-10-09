/* 调度器 + 历史读接口。
   定时器不靠真等：注入假 setTimer/clearTimer，断言排到哪一轮、间隔多少、有没有被清掉。
   跑起来的那一轮走的是手动测试同一条路径（api.testKeyAt / api.refreshBalances），
   所以这里同时验证「密钥测试与批量刷新确实会把观测写进历史表」。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createStore } = require('../src/storage');
const { createScheduler } = require('../src/scheduler');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-' + prefix + '-')); }
function sweep(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* SQLite 句柄未释放，留给 OS */ }
}

function makeStore(backend) {
  const dir = tmp('sched-' + backend);
  return { dir: dir, storage: createStore(dir, Buffer.alloc(32, 7), { backend: backend }) };
}

function addKey(storage, platform, base) {
  return storage.createKey({
    name: platform + '-' + Math.random().toString(36).slice(2, 6),
    platform: platform,
    customName: '',
    key: 'sk-fixture-0000abcd',
    endpoints: base ? [{ url: base, style: platform === 'anthropic' ? 'anthropic' : 'openai' }] : []
  }).id;
}

/* 假定时器：fire() 模拟到点，触发之后就不该再算「排着」——和真 setTimeout 一个语义 */
function makeFakeTimer() {
  const armed = [];
  let seq = 0;
  return {
    armed: armed,
    setTimer: function (fn, ms) {
      const t = { id: ++seq, ms: ms, cleared: false };
      t.fire = function () { t.cleared = true; return fn(); };
      armed.push(t);
      return t;
    },
    clearTimer: function (t) { if (t) t.cleared = true; },
    pending: function () { return armed.filter(function (t) { return !t.cleared; }); },
    latest: function () { const p = this.pending(); return p[p.length - 1]; }
  };
}

function mockFetch(url) {
  const u = String(url);
  if (u.includes('/user/balance')) {
    return Promise.resolve(new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '88.50' }]
    }), { status: 200 }));
  }
  if (u.includes('/models')) {
    return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 }));
  }
  return Promise.resolve(new Response('{}', { status: 404 }));
}

function mockFetch401() {
  return Promise.resolve(new Response('{"error":"invalid"}', { status: 401 }));
}

function scheduler(storage, opts) {
  const fake = (opts && opts.fake) || makeFakeTimer();
  return {
    fake: fake,
    sched: createScheduler(Object.assign({
      storage: storage,
      fetchImpl: mockFetch,
      enabled: true,
      intervalMinutes: 60,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer
    }, opts && opts.over))
  };
}

test('开关与间隔：关掉就不排，打开按间隔排，改间隔重新排，stop 清干净', () => {
  const c = makeStore('json');
  try {
    const off = scheduler(c.storage, { over: { enabled: false } });
    assert.strictEqual(off.sched.start().enabled, false);
    assert.strictEqual(off.fake.armed.length, 0, '关闭状态下不排任何定时器');
    assert.strictEqual(off.sched.status().nextRunAt, null);

    const on = off.sched.configure({ enabled: true });
    assert.strictEqual(on.enabled, true);
    assert.strictEqual(off.fake.armed.length, 1);
    assert.strictEqual(off.fake.armed[0].ms, 60 * 60000, '间隔按分钟换算');
    assert.ok(off.fake.armed[0].fire, '排进去的是一个待执行的轮次');
    assert.ok(Date.parse(on.nextRunAt) > Date.now(), 'nextRunAt 在将来');

    const changed = off.sched.configure({ intervalMinutes: 5 });
    assert.strictEqual(off.fake.pending().length, 1, '旧的那一个要被清掉，不能两个都在排着');
    assert.strictEqual(off.fake.latest().ms, 5 * 60000);
    assert.strictEqual(changed.intervalMinutes, 5);

    off.sched.stop();
    assert.strictEqual(off.fake.pending().length, 0);
    assert.strictEqual(off.sched.status().nextRunAt, null);
  } finally { sweep(c.dir); }
});

test('间隔越界由两端同一对上下限夹住', () => {
  const c = makeStore('json');
  try {
    assert.strictEqual(scheduler(c.storage, { over: { intervalMinutes: 0.2 } }).sched.status().intervalMinutes, 1);
    assert.strictEqual(scheduler(c.storage, { over: { intervalMinutes: 999999 } }).sched.status().intervalMinutes, 7 * 24 * 60);
    assert.strictEqual(scheduler(c.storage, { over: { intervalMinutes: 'abc' } }).sched.status().intervalMinutes, 1);
    assert.strictEqual(scheduler(c.storage).sched.configure({ intervalMinutes: 120 }).intervalMinutes, 120);
  } finally { sweep(c.dir); }
});

test('一轮：每个密钥测一次 + 批量刷余额，观测同时进历史表', async () => {
  const c = makeStore('json');
  try {
    const ds = addKey(c.storage, 'deepseek', 'https://api.deepseek.com');
    const oai = addKey(c.storage, 'openai', 'https://api.openai.com/v1');
    const bare = addKey(c.storage, 'custom', '');
    const s = scheduler(c.storage).sched;

    const r = await s.runOnce();
    assert.deepStrictEqual(
      { keys: r.keys, passed: r.passed, failed: r.failed, skipped: r.skipped, balanceUpdated: r.balanceUpdated, balanceFailed: r.balanceFailed },
      { keys: 3, passed: 2, failed: 0, skipped: 1, balanceUpdated: 1, balanceFailed: 0 },
      JSON.stringify(r)
    );
    assert.ok(Date.parse(r.at), '轮次带时间戳');

    assert.deepStrictEqual(c.storage.listHistory(ds).map(function (h) { return h.kind; }), ['test', 'balance']);
    assert.strictEqual(c.storage.listHistory(ds)[0].status, 'pass');
    assert.strictEqual(c.storage.listHistory(ds)[1].value, 88.5, '余额走势有数了');
    assert.deepStrictEqual(c.storage.listHistory(oai).map(function (h) { return h.kind; }), ['test'], '不支持余额查询的密钥不该留空观测');
    assert.deepStrictEqual(c.storage.listHistory(bare), [], '没填地址的密钥只是被跳过，不写「无法测试」');
    assert.strictEqual(c.storage.getKey(bare).test, null);
    assert.strictEqual(c.storage.getKey(oai).balance.status, 'unsupported');
  } finally { sweep(c.dir); }
});

test('失败的观测同样进表，且带得上失败原因', async () => {
  const c = makeStore('json');
  try {
    const id = addKey(c.storage, 'deepseek', 'https://api.deepseek.com');
    const s = createScheduler({ storage: c.storage, fetchImpl: mockFetch401, enabled: false });
    const r = await s.runOnce();
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.balanceFailed, 1);
    const rows = c.storage.listHistory(id);
    assert.deepStrictEqual(rows.map(function (h) { return h.kind + ':' + h.status; }), ['test:fail', 'balance:fail']);
    assert.ok(rows[0].detail, '测试失败原因要留下：' + JSON.stringify(rows[0]));
    assert.ok(rows[1].detail, '余额失败原因要留下：' + JSON.stringify(rows[1]));
    assert.strictEqual(rows[0].latency, null);
  } finally { sweep(c.dir); }
});

test('定时器到点就跑：跑完重新排下一次，一轮异常不会把定时器带停', async () => {
  const broken = {
    listKeys: function () { throw new Error('库被别的进程占着'); }
  };
  const f = scheduler(broken, { over: { intervalMinutes: 2 } });
  f.sched.start();
  const first = f.fake.latest();
  await first.fire();
  assert.strictEqual(f.sched.status().lastError, '库被别的进程占着', '异常要看得见');
  assert.strictEqual(f.sched.status().lastRunAt, null, '没跑成就不算跑过一轮');
  assert.strictEqual(f.fake.pending().length, 1, '失败后仍排着下一次');
  assert.notStrictEqual(f.fake.latest(), first, '重新排了一个新的，而不是复用已触发的');
  assert.strictEqual(f.fake.armed.length, 2);
});

test('正常轮次跑完后按间隔重新排，并记下结果', async () => {
  const c = makeStore('json');
  try {
    addKey(c.storage, 'deepseek', 'https://api.deepseek.com');
    const f = scheduler(c.storage, { over: { intervalMinutes: 3 } });
    f.sched.start();
    await f.fake.latest().fire();
    const st = f.sched.status();
    assert.strictEqual(st.lastError, null);
    assert.ok(st.lastRunAt, '跑成了就记下时间');
    assert.strictEqual(st.lastResult.passed, 1);
    assert.strictEqual(f.fake.pending().length, 1);
    assert.strictEqual(f.fake.latest().ms, 3 * 60000);
  } finally { sweep(c.dir); }
});

test('一轮还没跑完时到点：不叠第二轮，只顺延', async () => {
  const c = makeStore('json');
  try {
    addKey(c.storage, 'deepseek', 'https://api.deepseek.com');
    let release;
    const gate = new Promise(function (r) { release = r; });
    let calls = 0;
    const gated = async function () {
      calls++;
      await gate;
      return new Response('{"data":[]}', { status: 200 });
    };
    const f = scheduler(c.storage, { over: { fetchImpl: gated, intervalMinutes: 1 } });
    f.sched.start();
    const inflight = f.fake.latest().fire();
    assert.strictEqual(f.sched.status().running, true, '网络没回来时这一轮应仍在跑');
    const callsDuringRound = calls;

    /* 改配置会在轮次进行中重新排定时器 —— 此时到点绝不能开第二轮 */
    f.sched.configure({ intervalMinutes: 1 });
    f.fake.latest().fire();
    assert.strictEqual(f.sched.status().running, true);
    assert.strictEqual(calls, callsDuringRound, '第二轮没开：一个请求都没多发');
    release();
    await inflight;
    assert.strictEqual(f.sched.status().running, false);
    assert.ok(calls > callsDuringRound, '这一轮剩下的请求继续跑完');
  } finally { sweep(c.dir); }
});

/* ================= HTTP 层 ================= */

async function startServer(opts) {
  const c = makeStore('json');
  const fake = makeFakeTimer();
  const sched = opts.noScheduler ? null : createScheduler({
    storage: c.storage,
    fetchImpl: opts.fetchImpl || mockFetch,
    enabled: false,
    intervalMinutes: 60,
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer
  });
  const server = createApp({
    storage: c.storage,
    fetchImpl: opts.fetchImpl || mockFetch,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    scheduler: sched
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  return {
    dir: c.dir, storage: c.storage, sched: sched, fake: fake,
    base: 'http://127.0.0.1:' + server.address().port,
    server: server
  };
}

function call(base, method, p, body) {
  return fetch(base + p, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.json().then(function (data) { return { status: res.status, data: data }; });
  });
}

test('接口：手动测试与批量刷新的观测都能从 /api/keys/:id/history 读回来', async () => {
  const srv = await startServer({});
  try {
    const k = await call(srv.base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-history-0001' });
    assert.strictEqual(k.status, 201, JSON.stringify(k.data));
    const id = k.data.key.id;

    let r = await call(srv.base, 'GET', '/api/keys/' + id + '/history');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.history, [], '新建的密钥还没有观测');

    r = await call(srv.base, 'POST', '/api/keys/' + id + '/test');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.test.status, 'pass');

    r = await call(srv.base, 'POST', '/api/refresh-balances');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.updated, 1);

    r = await call(srv.base, 'GET', '/api/keys/' + id + '/history');
    assert.deepStrictEqual(r.data.history.map(function (h) { return h.kind + ':' + h.status; }), ['test:pass', 'balance:ok']);
    assert.strictEqual(r.data.history[0].keyId, id);
    assert.ok(r.data.history[0].at);

    r = await call(srv.base, 'GET', '/api/keys/' + id + '/history?kind=balance');
    assert.strictEqual(r.data.history.length, 1);
    r = await call(srv.base, 'GET', '/api/keys/' + id + '/history?limit=1');
    assert.strictEqual(r.data.history.length, 1);
    assert.strictEqual(r.data.history[0].kind, 'balance', 'limit 取最近一条');

    r = await call(srv.base, 'GET', '/api/keys/' + id + '/history?kind=bogus');
    assert.strictEqual(r.status, 400, JSON.stringify(r.data));
    r = await call(srv.base, 'GET', '/api/keys/4242/history');
    assert.strictEqual(r.status, 404);
  } finally {
    srv.server.close();
    sweep(srv.dir);
  }
});

test('接口：/api/schedule 能读能改，改完真的重排了定时器', async () => {
  const srv = await startServer({});
  try {
    let r = await call(srv.base, 'GET', '/api/schedule');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.schedule.enabled, false);
    assert.strictEqual(r.data.schedule.intervalMinutes, 60);
    assert.strictEqual(srv.fake.armed.length, 0);

    r = await call(srv.base, 'POST', '/api/schedule', { enabled: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.schedule.enabled, true);
    assert.strictEqual(srv.fake.latest().ms, 60 * 60000, '开关一开就排上');

    r = await call(srv.base, 'POST', '/api/schedule', { enabled: false });
    assert.strictEqual(srv.fake.pending().length, 0, '关掉后待跑的轮次要清掉');

    r = await call(srv.base, 'POST', '/api/schedule', { enabled: true, intervalMinutes: 15 });
    assert.strictEqual(r.data.schedule.intervalMinutes, 15);
    assert.strictEqual(srv.fake.latest().ms, 15 * 60000);

    r = await call(srv.base, 'POST', '/api/schedule', { enabled: 'yes' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.data));
    r = await call(srv.base, 'POST', '/api/schedule', { intervalMinutes: 0 });
    assert.strictEqual(r.status, 400, '低于下限要挡下来');
    r = await call(srv.base, 'POST', '/api/schedule', { intervalMinutes: 10081 });
    assert.strictEqual(r.status, 400, '高于上限要挡下来');
    r = await call(srv.base, 'POST', '/api/schedule', { intervalMinutes: 7.4 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.schedule.intervalMinutes, 7, '分钟数取整');
  } finally {
    srv.server.close();
    sweep(srv.dir);
  }
});

test('接口：没挂调度器的进程对 /api/schedule 明确说没有，而不是当成不存在的路径', async () => {
  const srv = await startServer({ noScheduler: true });
  try {
    const r = await call(srv.base, 'GET', '/api/schedule');
    assert.strictEqual(r.status, 404);
    assert.match(r.data.error, /未挂载调度器/);
  } finally {
    srv.server.close();
    sweep(srv.dir);
  }
});

test('SQLite 后端同样接得住调度器这一轮（两个后端行为一致）', async () => {
  let supports = true;
  try { require('node:sqlite'); } catch (e) { supports = false; }
  if (!supports) return;
  const c = makeStore('sqlite');
  try {
    const id = addKey(c.storage, 'deepseek', 'https://api.deepseek.com');
    const s = createScheduler({ storage: c.storage, fetchImpl: mockFetch, enabled: false });
    const r = await s.runOnce();
    assert.strictEqual(r.passed, 1);
    assert.strictEqual(r.balanceUpdated, 1);
    assert.deepStrictEqual(c.storage.listHistory(id).map(function (h) { return h.kind + ':' + h.status; }), ['test:pass', 'balance:ok']);
  } finally { sweep(c.dir); }
});
