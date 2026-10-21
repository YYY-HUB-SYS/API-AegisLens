/* /api/local-usage 的测试。
 *
 * ★ 绝不依赖本机真实数据：采集器一律注入到临时目录里的假 sqlite / json，
 *   再用 collectUsage({ root }) 指过去 —— 真机上那份 runtime-state.sqlite 有 1 GB
 *   且正在被写，测试绝不能去碰它（这也是 token-usage.js 支持"根目录可注入"的原因）。
 *
 * 覆盖：假数据下的响应形状（只有数字与模型名、不含会话标题与本机路径）、
 *   保险库锁着 423、数据源缺失/采集抛错时降级成空结果而不是 500、
 *   短缓存命中、限流 429、days 参数校验。 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const tmp = require('./tmp.js');
const usage = require('../src/token-usage.js');
/* 先把 node:sqlite 的实验性警告静音，再 require 它，免得测试输出里全是黄字 */
usage.silenceSqliteWarning();
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/app');
const { createStore } = require('../src/storage');
const { createVaultSession, createThrottle } = require('../src/vault');
const { createDataThrottle } = require('../src/consumer-api');
const { loadOrCreateMasterKey } = require('../src/crypto');

/* 固定"现在"：所有与日期有关的断言都基于它，不受跑测试时的真实时间影响 */
const NOW = new Date(2026, 9, 21, 12, 0, 0, 0).getTime();
/* 故意放进假数据里的敏感串：会话标题。任何输出里都不许出现它 */
const SECRET = '绝密会话标题-DO-NOT-LEAK-77';

function dayMs(y, m, d, h) {
  return new Date(y, m - 1, d, h || 0, 0, 0, 0).getTime();
}

/* 造一份同名的 local_runtime_token_usage 表（列名与真机一致），外加一张带 title 的会话表 */
function writeMinimax(root, rows) {
  const dir = path.join(root, '.minimax', 'v2', 'sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'runtime-state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE local_runtime_token_usage ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent_name TEXT, framework_type TEXT,'
    + ' turn_id TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER,'
    + ' reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,'
    + ' cost_usd REAL, raw TEXT)');
  const ins = db.prepare('INSERT INTO local_runtime_token_usage (session_id, agent_name, framework_type,'
    + ' turn_id, model, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,'
    + ' cache_write_tokens, cost_usd, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) {
    ins.run(
      r.sessionId || 'sess-1',
      r.agent === undefined ? 'worker' : r.agent,
      'pi-agent',
      'turn-1',
      r.model === undefined || r.model === null ? null : String(r.model),
      r.ts,
      r.input || 0,
      r.output || 0,
      r.reasoning || 0,
      r.cacheRead || 0,
      r.cacheWrite || 0,
      r.cost || 0,
      r.raw === undefined ? null : r.raw
    );
  }
  /* 真机上就有这张表；造一份带 title 的，用来看住"绝不读会话标题"这条线 */
  db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT, title TEXT, created_at_ms INTEGER)');
  db.prepare('INSERT INTO local_runtime_sessions (session_id, title, created_at_ms) VALUES (?,?,?)')
    .run('sess-1', SECRET, NOW);
  db.close();
  return dbPath;
}

function writeWorkBuddy(root, conversations) {
  const dir = path.join(root, '.workbuddy-ai', 'storage', 'user-x', 'storage-abc', 'scoped', 'hash1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'conversationContextUsage.json');
  fs.writeFileSync(file, JSON.stringify(conversations), 'utf8');
  return file;
}

function mockFetch() {
  return Promise.resolve(new Response('{}', { status: 200 }));
}

/* 采集器：注入到假数据根目录，并数清楚被调用了几次（缓存那条用例靠它断言） */
function makeCollector(root, counter) {
  return function (params) {
    if (counter) counter.n += 1;
    return usage.collectUsage({ root: root, days: params.days, now: NOW });
  };
}

async function startServer(opts) {
  const o = opts || {};
  /* ★ 采集器必须显式注入：漏了就让它当场炸，而不是悄悄回落到默认采集器去扫
     本机真机上那份 1 GB 的 runtime-state.sqlite（那既慢，又让断言失去意义）。
     写这条护栏是因为踩过一次：选项名写错，测试默默读了真数据。 */
  if (typeof o.collector !== 'function') {
    throw new Error('测试必须注入采集器（startServer({ collector })）');
  }
  const dir = tmp.mk('akm-lusage');
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: 'json' });
  const vault = createVaultSession({ idleLockMs: 60000 });
  /* 锁态要真的锁住：生产里锁定是 vault.lock() + 关 store，这里先只锁会话 */
  if (!o.locked) vault.openLegacy(mk);
  const throttle = {
    unlock: createThrottle({ maxFails: 5 }),
    reveal: createThrottle({ maxFails: 30 }),
    credential: createThrottle({ maxFails: 20 }),
    passphrase: createThrottle({ maxFails: 5 }),
    token: createThrottle({ maxFails: 20 })
  };
  const server = createApp({
    storage: storage,
    fetchImpl: mockFetch,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    vault: vault,
    throttle: throttle,
    localUsageCollector: o.collector || null,
    localUsageRoot: o.root || null,
    localUsageThrottle: o.throttle || null,
    localUsageCacheTtlMs: o.cacheTtlMs
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    server: server,
    storage: storage,
    vault: vault
  };
}

function call(base, p) {
  return fetch(base + p).then(function (res) {
    return res.json().then(function (data) { return { status: res.status, data: data }; });
  });
}

/* 桶里除分组键外必须全是数字：这是"只出聚合数字"这条线的形状断言 */
function assertBucketsAreNumeric(list, keyName, label) {
  assert.ok(Array.isArray(list), label + ' 要是数组');
  for (const row of list) {
    for (const k of Object.keys(row)) {
      if (k === keyName) {
        assert.strictEqual(typeof row[k], 'string', label + ' 的分组键要是字符串');
        continue;
      }
      assert.strictEqual(typeof row[k], 'number', label + ' 里的 ' + k + ' 必须是数字，实际是 ' + typeof row[k]);
    }
  }
}

test('GET /api/local-usage：假数据下返回聚合数字，不带会话标题与本机路径', async () => {
  const root = tmp.mk('aegis-lu-');
  writeMinimax(root, [
    { ts: dayMs(2026, 10, 20) + 3600000, agent: 'worker', model: 'm-1', input: 100, output: 10, reasoning: 1, cacheRead: 5, cacheWrite: 2, cost: 0.001 },
    { ts: dayMs(2026, 10, 21) + 3600000, agent: 'mavis', model: 'm-2', input: 300, output: 30, reasoning: 3, cacheRead: 7, cacheWrite: 0, cost: 0.004 }
  ]);
  writeWorkBuddy(root, {
    'conv-a': { version: 1, used: 1000, size: 2000, modelId: 'hy3', updatedAt: dayMs(2026, 10, 21) }
  });

  const counter = { n: 0 };
  const h = await startServer({ collector: makeCollector(root, counter) });
  try {
    const r = await call(h.base, '/api/local-usage');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.days, 30, '默认 30 天');
    assert.strictEqual(typeof r.data.generatedAt, 'string');
    assert.ok(r.data.range && r.data.range.since && r.data.range.until, '要给统计范围');

    /* 消耗口径：按天 / 按模型 / 按 agent 三份聚合 */
    assert.strictEqual(r.data.byDay.length, 2);
    assert.strictEqual(r.data.byDay[0].date, '2026-10-20');
    assert.strictEqual(r.data.byDay[0].inputTokens, 100);
    assert.strictEqual(r.data.byDay[1].date, '2026-10-21');
    assert.strictEqual(r.data.byDay[1].inputTokens, 300);
    assert.strictEqual(r.data.byModel.length, 2);
    assert.strictEqual(r.data.byAgent.length, 2);
    assert.strictEqual(r.data.totals.requests, 2);
    assert.strictEqual(r.data.totals.inputTokens, 400);
    assert.strictEqual(r.data.totals.outputTokens, 40);
    assert.strictEqual(r.data.totals.totalTokens, 400 + 40 + 4 + 12 + 2);
    assert.strictEqual(r.data.totals.costUsd, 0.005);

    /* 上下文占用是另一套口径，不许混进消耗里 */
    assert.strictEqual(r.data.context.available, true);
    assert.strictEqual(r.data.context.conversations, 1);
    assert.strictEqual(r.data.context.used, 1000);

    /* 数据源列表：可用与不可用都要如实列出 */
    const mm = r.data.sources.find(function (s) { return s.id === 'minimax-code'; });
    assert.ok(mm, '要列出 MiniMax Code 这个数据源');
    assert.strictEqual(mm.available, true);
    assert.strictEqual(mm.rows, 2);
    const cs = r.data.sources.find(function (s) { return s.id === 'cc-switch'; });
    assert.ok(cs, '没数据的源也要列出来');
    assert.strictEqual(cs.available, false);
    assert.ok(cs.reason && cs.reason.length > 0, '不可用时要写清原因');

    /* 形状：桶里除分组键外全是数字 */
    assertBucketsAreNumeric(r.data.byDay, 'date', 'byDay');
    assertBucketsAreNumeric(r.data.byModel, 'model', 'byModel');
    assertBucketsAreNumeric(r.data.byAgent, 'agent', 'byAgent');
    for (const k of Object.keys(r.data.totals)) {
      assert.strictEqual(typeof r.data.totals[k], 'number', 'totals 里的 ' + k + ' 必须是数字');
    }

    /* ★ 敏感面：会话标题、会话 id、本机路径一个都不许出现 */
    const body = JSON.stringify(r.data);
    assert.ok(!body.includes(SECRET), '响应里出现了会话标题');
    assert.ok(!body.includes('sess-1'), '响应里出现了会话 id');
    assert.ok(!body.includes('conv-a'), '响应里出现了会话 id（WorkBuddy）');
    assert.ok(!body.includes(root), '响应里出现了本机数据根目录');
    assert.ok(!/[A-Za-z]:\\\\/.test(body), '响应里出现了绝对路径');
  } finally { h.server.close(); }
});

test('保险库锁着 ⇒ 423，且压根不去采集', async () => {
  const root = tmp.mk('aegis-lu-');
  const counter = { n: 0 };
  const h = await startServer({ locked: true, collector: makeCollector(root, counter) });
  try {
    const r = await call(h.base, '/api/local-usage');
    assert.strictEqual(r.status, 423, JSON.stringify(r.data));
    assert.match(r.data.error, /未解锁/);
    assert.strictEqual(counter.n, 0, '锁着的时候不该去扫库');
  } finally { h.server.close(); }
});

test('数据源不存在 ⇒ 降级成空结果而不是 500', async () => {
  const root = tmp.mk('aegis-lu-');   /* 空目录：三个数据源一个都没有 */
  const h = await startServer({ collector: makeCollector(root, null) });
  try {
    const r = await call(h.base, '/api/local-usage');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.availableSources, 0);
    assert.deepStrictEqual(r.data.byDay, []);
    assert.deepStrictEqual(r.data.byModel, []);
    assert.deepStrictEqual(r.data.byAgent, []);
    assert.strictEqual(r.data.totals.totalTokens, 0);
    assert.strictEqual(r.data.totals.requests, 0);
    /* 不可用的源要如实列出并写明原因 */
    const mm = r.data.sources.find(function (s) { return s.id === 'minimax-code'; });
    assert.strictEqual(mm.available, false);
    assert.ok(mm.reason && mm.reason.length > 0);
    assert.notStrictEqual(r.data.degraded, true, '空结果不是"采集炸了"，是"确实没数据"');
  } finally { h.server.close(); }
});

test('源格式变了（不是库）⇒ 降级成空结果而不是 500', async () => {
  const root = tmp.mk('aegis-lu-');
  const dir = path.join(root, '.minimax', 'v2', 'sqlite');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime-state.sqlite'), 'this is not a sqlite database', 'utf8');

  const h = await startServer({ collector: makeCollector(root, null) });
  try {
    const r = await call(h.base, '/api/local-usage');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const mm = r.data.sources.find(function (s) { return s.id === 'minimax-code'; });
    assert.strictEqual(mm.available, false);
    assert.ok(mm.reason && mm.reason.length > 0, '要写清为什么读不了');
    assert.strictEqual(r.data.totals.totalTokens, 0);
  } finally { h.server.close(); }
});

test('采集整体抛错 ⇒ 200 + 空结果 + 说明字段（优雅地说不出）', async () => {
  const h = await startServer({
    collector: function () { throw new Error('采集炸了'); }
  });
  try {
    const r = await call(h.base, '/api/local-usage');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.degraded, true);
    assert.ok(r.data.error && r.data.error.length > 0, '要说明为什么说不出');
    assert.deepStrictEqual(r.data.byDay, []);
    assert.strictEqual(r.data.totals.totalTokens, 0);
  } finally { h.server.close(); }
});

test('缓存：连打两次只采集一次；换 days 才重新采集', async () => {
  const root = tmp.mk('aegis-lu-');
  writeMinimax(root, [{ ts: dayMs(2026, 10, 21) + 3600000, model: 'm-1', input: 10, output: 5 }]);
  const counter = { n: 0 };
  const h = await startServer({ collector: makeCollector(root, counter) });
  try {
    const first = await call(h.base, '/api/local-usage');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(counter.n, 1, '第一次要真采集');

    const second = await call(h.base, '/api/local-usage');
    assert.strictEqual(second.status, 200);
    assert.strictEqual(counter.n, 1, '★ 第二次应当命中缓存，不该再扫一次库');
    assert.deepStrictEqual(second.data.totals, first.data.totals, '命中缓存时结果要一样');

    /* 窗口不一样就是另一份数据，不能拿旧的糊弄 */
    const third = await call(h.base, '/api/local-usage?days=7');
    assert.strictEqual(third.status, 200);
    assert.strictEqual(third.data.days, 7);
    assert.strictEqual(counter.n, 2, '换了 days 要重新采集');
  } finally { h.server.close(); }
});

test('缓存过期后会重新采集', async () => {
  const root = tmp.mk('aegis-lu-');
  writeMinimax(root, [{ ts: dayMs(2026, 10, 21) + 3600000, model: 'm-1', input: 10, output: 5 }]);
  const counter = { n: 0 };
  const h = await startServer({ collector: makeCollector(root, counter), cacheTtlMs: 30 });
  try {
    await call(h.base, '/api/local-usage');
    assert.strictEqual(counter.n, 1);
    await call(h.base, '/api/local-usage');
    assert.strictEqual(counter.n, 1, 'TTL 内仍然命中缓存');
    await new Promise(function (r) { setTimeout(r, 60); });
    await call(h.base, '/api/local-usage');
    assert.strictEqual(counter.n, 2, 'TTL 过了要重新采集');
  } finally { h.server.close(); }
});

test('限流：超额度 ⇒ 429（带 retryAfterMs）', async () => {
  const root = tmp.mk('aegis-lu-');
  writeMinimax(root, [{ ts: dayMs(2026, 10, 21) + 3600000, model: 'm-1', input: 10, output: 5 }]);
  const h = await startServer({
    collector: makeCollector(root, null),
    throttle: createDataThrottle({ max: 3, windowMs: 60 * 1000 })
  });
  try {
    for (let i = 0; i < 3; i++) {
      const ok = await call(h.base, '/api/local-usage');
      assert.strictEqual(ok.status, 200, '第 ' + (i + 1) + ' 次该放行');
    }
    const over = await call(h.base, '/api/local-usage');
    assert.strictEqual(over.status, 429, '第 4 次该被限流挡下');
    assert.ok(over.data.retryAfterMs > 0, '要报出还要等多久');
  } finally { h.server.close(); }
});

test('days 参数不合法 ⇒ 400；sources=1 额外给出探测结果', async () => {
  const root = tmp.mk('aegis-lu-');
  writeMinimax(root, [{ ts: dayMs(2026, 10, 21) + 3600000, model: 'm-1', input: 10, output: 5 }]);
  const h = await startServer({ collector: makeCollector(root, null) });
  try {
    const bad = await call(h.base, '/api/local-usage?days=0');
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.data));
    const bad2 = await call(h.base, '/api/local-usage?days=abc');
    assert.strictEqual(bad2.status, 400);
    const bad3 = await call(h.base, '/api/local-usage?days=99999');
    assert.strictEqual(bad3.status, 400);

    const plain = await call(h.base, '/api/local-usage');
    assert.strictEqual(plain.status, 200);
    assert.strictEqual(plain.data.detected, undefined, '不给 sources 时不必带探测详情');

    const withSrc = await call(h.base, '/api/local-usage?sources=1');
    assert.strictEqual(withSrc.status, 200);
    assert.ok(withSrc.data.detected, 'sources=1 要多给探测结果');
    assert.ok(Array.isArray(withSrc.data.detected.available));
    assert.ok(Array.isArray(withSrc.data.detected.unavailable));
    assert.ok(withSrc.data.detected.available.some(function (s) { return s.id === 'minimax-code'; }));
    assert.ok(withSrc.data.detected.unavailable.some(function (s) { return s.id === 'cc-switch'; }));
    /* 探查过但没数据的 agent 也要如实列出 */
    assert.ok(withSrc.data.detected.unavailable.some(function (s) { return s.id === 'codebuddy'; }));
  } finally { h.server.close(); }
});

test('只支持 GET：跨域写请求被拒，其它方法 405', async () => {
  const root = tmp.mk('aegis-lu-');
  const h = await startServer({ collector: makeCollector(root, null) });
  try {
    const cross = await fetch(h.base + '/api/local-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: '{}'
    });
    assert.strictEqual(cross.status, 403, '跨域写请求要拒');

    const post = await fetch(h.base + '/api/local-usage', { method: 'POST' });
    assert.strictEqual(post.status, 405);
  } finally { h.server.close(); }
});
