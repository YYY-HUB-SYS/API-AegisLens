/* 后端补的两处：①「立即跑一轮」的出口；② /api/meta 的会话校验。
   这两条都不是纯界面活，都会改服务端行为，所以单独钉住。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createApp } = require('../src/app');
const { createStore } = require('../src/storage');
const { createScheduler } = require('../src/scheduler');
const { createVaultSession, createThrottle } = require('../src/vault');
const { createDataThrottle } = require('../src/consumer-api');
const { loadOrCreateMasterKey } = require('../src/crypto');

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
    reset: function () { armed.length = 0; }
  };
}

function mockFetch(url) {
  const u = String(url);
  if (u.indexOf('/models') >= 0) {
    return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'm-1' }] }), { status: 200 }));
  }
  return Promise.resolve(new Response('{"error":"x"}', { status: 401 }));
}

async function startServer(opts) {
  const o = opts || {};
  const dir = tmp.mk('akm-schedapi');
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: o.backend || 'json' });
  const fake = makeFakeTimer();
  const sched = createScheduler({
    storage: storage,
    fetchImpl: o.fetchImpl || mockFetch,
    enabled: false,
    intervalMinutes: 60,
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer
  });
  const vault = createVaultSession({ idleLockMs: 60000 });
  /* 锁态要真的锁住：生产里锁定是 vault.lock() + 关 store，这里两件都做，
     否则测的就是「本来就没锁」的世界 */
  if (!o.locked) {
    vault.openLegacy(mk);
  }
  const throttle = {
    unlock: createThrottle({ maxFails: 5 }),
    reveal: createThrottle({ maxFails: 30 }),
    credential: createThrottle({ maxFails: 20 }),
    passphrase: createThrottle({ maxFails: 5 }),
    token: createThrottle({ maxFails: 20 }),
    schedule: createThrottle({ maxFails: 5 })
  };
  const server = createApp({
    storage: storage,
    fetchImpl: o.fetchImpl || mockFetch,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    scheduler: sched,
    /* 与生产同一套滑窗限流器（调用次数语义） */
    scheduleThrottle: createDataThrottle({ max: 5, windowMs: 60 * 60 * 1000 }),
    vault: vault,
    throttle: throttle
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  return {
    dir: dir, storage: storage, sched: sched, fake: fake, vault: vault,
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

/* ================= ① 立即跑一轮 ================= */

test('POST /api/schedule/run：跑一轮并记账（上次运行 / 上次结果都要有值）', async () => {
  const h = await startServer({});
  try {
    h.storage.createKey({
      name: '带地址', platform: 'deepseek', customName: '', key: 'sk-run-0001',
      endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }]
    });
    const before = h.sched.status();
    assert.strictEqual(before.lastRunAt, null, '一开始不该有上次运行');
    assert.strictEqual(before.lastResult, null);

    const r = await call(h.base, 'POST', '/api/schedule/run', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.result, '响应要带回本轮结果');
    assert.strictEqual(r.data.result.keys, 1, '本轮应该测了这一把');
    assert.strictEqual(r.data.result.passed, 1, 'mockFetch 走 /models 返回 200，算通');

    /* ★ 关键：手动跑完也必须记账。早先 runOnce() 只跑不记，
       界面上「上次运行」永远是空的，看着像没跑过。 */
    assert.ok(r.data.schedule.lastRunAt, '跑完必须写上 lastRunAt');
    assert.ok(r.data.schedule.lastResult, '跑完必须写上 lastResult');
    assert.strictEqual(r.data.schedule.lastError, null, '跑通了不该留错误');
    assert.strictEqual(r.data.schedule.lastResult.keys, 1);
  } finally { h.server.close(); }
});

test('POST /api/schedule/run：锁着的时候不许跑（423）', async () => {
  const h = await startServer({ locked: true });
  try {
    const r = await call(h.base, 'POST', '/api/schedule/run', {});
    assert.strictEqual(r.status, 423, '没 DEK 就没 store，这条路跑不了');
    assert.match(r.data.error, /未解锁/);
    assert.strictEqual(h.sched.status().lastRunAt, null, '没跑成就不该有上次运行');
  } finally { h.server.close(); }
});

test('POST /api/schedule/run：单独限流（5 次/小时），超了报 429', async () => {
  const h = await startServer({});
  try {
    /* 没有 Key 时 runOnce 也会成功返回（0 把），照样消耗额度 —— 限流数的是调用次数，
       不是跑了几把。 */
    for (let i = 0; i < 5; i++) {
      const ok = await call(h.base, 'POST', '/api/schedule/run', {});
      assert.strictEqual(ok.status, 200, '第 ' + (i + 1) + ' 次该放行');
    }
    const sixth = await call(h.base, 'POST', '/api/schedule/run', {});
    assert.strictEqual(sixth.status, 429, '第 6 次该被限流挡下');
    assert.ok(sixth.data.retryAfterMs > 0, '要报出还要等多久');
  } finally { h.server.close(); }
});

/* ================= ② /api/meta 的会话校验 ================= */

test('GET /api/meta：已解锁时给 dataDir；锁着时不给（路径是敏感信息）', async () => {
  const open = await startServer({});
  try {
    const r = await call(open.base, 'GET', '/api/meta');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.dataDir, '已解锁时该给数据目录');
    assert.strictEqual(r.data.unlocked, true, '要告诉界面当前是解锁态');
  } finally { open.server.close(); }

  const locked = await startServer({ locked: true });
  try {
    const r = await call(locked.base, 'GET', '/api/meta');
    assert.strictEqual(r.status, 200, '这条路由是公开只读的（页面轮询用），锁着也该回 200');
    assert.strictEqual(r.data.dataDir, null, '★ 锁着时不该给真实路径');
    assert.strictEqual(r.data.unlocked, false, '要告诉界面「现在没解锁」，而不是让它以为本来就没这一项');
    /* 其余元信息不敏感，照给 —— 版本和存储类型不泄露什么 */
    assert.ok(r.data.version, '版本照给');
    assert.ok(r.data.storage, '存储类型照给');
  } finally { locked.server.close(); }
});

/* ================= ③ 调度器内部：runAndRecord 与 tick 走同一条路 ================= */

test('scheduler.runAndRecord 与 tick 记的是同一份账（不会两套口径）', async () => {
  const dir = tmp.mk('akm-sched-rec');
  const storage = createStore(dir, Buffer.alloc(32, 7), { backend: 'json' });
  const fake = makeFakeTimer();
  const sched = createScheduler({
    storage: storage, fetchImpl: mockFetch, enabled: false, intervalMinutes: 60,
    setTimer: fake.setTimer, clearTimer: fake.clearTimer
  });
  try {
    await sched.runAndRecord();
    const st = sched.status();
    assert.ok(st.lastRunAt, 'runAndRecord 要写 lastRunAt');
    assert.ok(st.lastResult, 'runAndRecord 要写 lastResult');
    assert.strictEqual(st.lastError, null);
    assert.strictEqual(st.running, false, '跑完 running 必须归位，否则下一次会被当成还在跑');
  } finally { storage.close(); }
});

test('scheduler：跑一轮失败时 lastError 要留住，且不把 running 卡在 true', async () => {
  const dir = tmp.mk('akm-sched-err');
  const storage = createStore(dir, Buffer.alloc(32, 7), { backend: 'json' });
  const fake = makeFakeTimer();
  /* 整轮唯一会炸的地方是 storage.listKeys()：
     每把 Key 的测试与余额刷新都各自有 try/catch（单把失败不该中断整轮），
     所以要造「整轮炸掉」，得让取列表这一步就抛。 */
  const boomStorage = {
    listKeys: function () { throw new Error('目录接口炸了'); }
  };
  const sched = createScheduler({
    storage: boomStorage, fetchImpl: mockFetch, enabled: false, intervalMinutes: 60,
    setTimer: fake.setTimer, clearTimer: fake.clearTimer
  });
  try {
    let threw = false;
    try { await sched.runAndRecord(); } catch (e) { threw = true; }
    assert.ok(threw, '失败要往上抛，调用方才好回 500');
    const st = sched.status();
    assert.match(String(st.lastError), /目录接口炸了/, '错误要留在 lastError 里');
    assert.strictEqual(st.running, false, '失败也不能把 running 卡住');
  } finally { storage.close(); }
});
