/* 限额快照的历史行：快照在密钥上只留最新一份，曲线得靠观测历史。
   盯这几件事：
   ① 一个窗口 = 一行（3 个窗口写 3 行），value 是该窗口的 used（画曲线靠它）；
   ② used 为 null 的窗口不写行 —— 平台没报 ≠ 用了 0；
   ③ 失败也写一行，原因留在 detail 里，曲线不能因为一次失败就断掉；
   ④ 真存真读：写进去再读回来，字段逐个对得上（不是只测纯函数）；
   ⑤ 两个后端逐字一致（比业务值，不比行号）；
   ⑥ 老库（没有 usage 列的 SQLite 库、没有 usage 字段的 JSON 库）打开后照样能用。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createStore } = require('../src/storage');
const { usageHistoryEntries } = require('../src/usage-history');

const backends = [];
try {
  require('node:sqlite');
  backends.push('sqlite');
} catch (e) { /* 当前 Node 没有 node:sqlite，只跑 JSON 后端 */ }
backends.push('json');

function newDir(prefix) { return tmp.mk('aegis-' + prefix); }

/* store 的 SQLite 句柄要等进程退出才释放，Windows 上目录因此删不掉；清理尽力而为 */
function sweep(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 句柄未释放，留给 OS */ }
}

function store(dir, backend) { return createStore(dir, Buffer.alloc(32, 7), { backend: backend }); }

function addKey(s) {
  return s.createKey({
    name: '限额', platform: 'deepseek', customName: '', key: 'sk-usage-hist-0001',
    endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }]
  }).id;
}

/* 一次典型的限额快照：三个窗口（5 小时 / 7 天 / 30 天） */
const SNAP = {
  status: 'ok',
  windows: [
    { name: '5 小时', used: 1200, limit: 1500, resetAt: '2026-10-21T18:00:00.000Z' },
    { name: '7 天', used: 8400, limit: 12000, resetAt: '2026-10-24T00:00:00.000Z' },
    { name: '30 天', used: 21000, limit: 30000, resetAt: '2026-10-31T00:00:00.000Z' }
  ],
  kind: 'quota',
  raw: { code: 200, data: { list: [] } }
};

/* ---------- 纯计算 ---------- */

test('纯计算：三个窗口的快照拆成三行，一行一个窗口', () => {
  const rows = usageHistoryEntries(SNAP);
  assert.strictEqual(rows.length, 3, '一个窗口 = 一行');
  assert.deepStrictEqual(rows.map(function (r) { return r.kind; }), ['usage', 'usage', 'usage']);
  assert.deepStrictEqual(rows.map(function (r) { return r.value; }), [1200, 8400, 21000],
    'value 是该窗口的 used，画曲线靠它，必须能排序比较');
  assert.deepStrictEqual(rows.map(function (r) { return r.status; }), ['ok', 'ok', 'ok']);
  const d0 = JSON.parse(rows[0].detail);
  assert.strictEqual(d0.name, '5 小时', '窗口名要带着，不然分不清是哪个窗口');
  assert.strictEqual(d0.limit, 1500, '光有 used 画不出「用了 1200 / 上限 1500」');
  assert.strictEqual(d0.resetAt, '2026-10-21T18:00:00.000Z');
  assert.strictEqual(d0.kind, 'quota');
  assert.strictEqual(rows[0].latency, undefined, '用量没有延迟可言，别编');
});

test('纯计算：used 为 null 的窗口不产行（平台没报 ≠ 用了 0）', () => {
  const rows = usageHistoryEntries({
    status: 'ok', kind: 'quota',
    windows: [
      { name: '5 小时', used: null, limit: 1500, resetAt: null },
      { name: '7 天', used: 8400, limit: 12000, resetAt: null },
      { name: '30 天', used: undefined, limit: 30000, resetAt: null }
    ]
  });
  assert.strictEqual(rows.length, 1, '没数的窗口不写行');
  assert.strictEqual(rows[0].value, 8400);
  assert.strictEqual(JSON.parse(rows[0].detail).name, '7 天');
});

test('纯计算：fail 快照产出一行，value 为 null，原因写在 detail 里', () => {
  const rows = usageHistoryEntries({
    status: 'fail', windows: [], kind: null, raw: null, msg: '密钥无效：401 unauthorized'
  });
  assert.strictEqual(rows.length, 1, '失败也要记，否则曲线在失败那天断掉');
  assert.strictEqual(rows[0].kind, 'usage');
  assert.strictEqual(rows[0].status, 'fail');
  assert.strictEqual(rows[0].value, null);
  assert.strictEqual(JSON.parse(rows[0].detail).msg, '密钥无效：401 unauthorized',
    '认证失败的原因要说清');
});

test('纯计算：窗口名特别长时 detail 仍是合法 JSON（存储层会截断 detail）', () => {
  const rows = usageHistoryEntries({
    status: 'ok', kind: 'quota',
    windows: [{ name: '特别长的窗口名'.repeat(30), used: 1, limit: 2, resetAt: null }]
  });
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].detail.length <= 200, 'detail 超长会被存储层截断，截成半个 JSON 就 parse 不出来了');
  const d = JSON.parse(rows[0].detail);
  assert.ok(d.name.length > 0, '窗口名要还在');
  assert.strictEqual(d.limit, 2, '上限要还在');
});

/* ---------- 存储层：真存真读 ---------- */

backends.forEach(function (backend) {
  test(backend + ' 后端：saveUsage 写的 usage 历史逐字段读得回来', () => {
    const dir = newDir('usage-hist-' + backend);
    try {
      const s = store(dir, backend);
      const id = addKey(s);
      s.saveUsage(id, SNAP);

      const rows = s.listHistory(id, { kind: 'usage' });
      assert.strictEqual(rows.length, 3, '三个窗口写三行');
      assert.deepStrictEqual(rows.map(function (r) { return r.kind; }), ['usage', 'usage', 'usage']);
      assert.deepStrictEqual(rows.map(function (r) { return r.value; }), [1200, 8400, 21000]);
      assert.deepStrictEqual(rows.map(function (r) { return r.status; }), ['ok', 'ok', 'ok']);
      assert.deepStrictEqual(rows.map(function (r) { return r.latency; }), [null, null, null],
        '用量没有延迟，别编一个数填上');
      assert.deepStrictEqual(
        rows.map(function (r) { return JSON.parse(r.detail).name; }),
        ['5 小时', '7 天', '30 天'], '窗口名要能从 detail 里读出来'
      );
      assert.deepStrictEqual(
        rows.map(function (r) { return JSON.parse(r.detail).limit; }),
        [1500, 12000, 30000], '上限要能从 detail 里读出来'
      );
      assert.deepStrictEqual(
        rows.map(function (r) { return JSON.parse(r.detail).resetAt; }),
        ['2026-10-21T18:00:00.000Z', '2026-10-24T00:00:00.000Z', '2026-10-31T00:00:00.000Z']
      );
      const rec = s.getKey(id);
      assert.strictEqual(rows[0].at, rec.usage.updatedAt, '历史那一行与快照同时戳');

      /* 重新打开存储还读得回来 ⇒ 真落盘，不是内存对象 */
      const reopened = store(dir, backend).listHistory(id, { kind: 'usage' });
      assert.strictEqual(reopened.length, 3, '真落盘');
      assert.deepStrictEqual(reopened.map(function (r) { return r.value; }), [1200, 8400, 21000]);
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：只查 kind=usage 时不串进 test/balance 的行', () => {
    const dir = newDir('usage-kind-' + backend);
    try {
      const s = store(dir, backend);
      const id = addKey(s);
      s.saveTest(id, { status: 'pass', latency: 12 });
      s.saveBalance(id, { value: 88.5, status: 'ok' });
      s.saveUsage(id, SNAP);

      const usage = s.listHistory(id, { kind: 'usage' });
      assert.strictEqual(usage.length, 3, 'usage 只有自己的三行');
      assert.ok(usage.every(function (r) { return r.kind === 'usage'; }), '不串进 test/balance 的行');
      assert.strictEqual(s.listHistory(id, { kind: 'test' }).length, 1);
      assert.strictEqual(s.listHistory(id, { kind: 'balance' }).length, 1);
      assert.strictEqual(s.listHistory(id).length, 5, '不筛时三类观测都在');
    } finally { sweep(dir); }
  });
});

/* ---------- 两个后端逐字一致 ---------- */

const summary = {};

backends.forEach(function (backend) {
  test(backend + ' 后端：同一串操作跑下来的 usage 历史', () => {
    const dir = newDir('usage-sum-' + backend);
    try {
      const s = store(dir, backend);
      const id = addKey(s);
      s.saveUsage(id, SNAP);
      /* 窗口值没变也要再写一遍：快照是「上次查询时」的读数，
         每次查询都是一个时间点，历史要看出「什么时候查的、那时候是多少」 */
      s.saveUsage(id, {
        status: 'ok', kind: 'quota',
        windows: [
          { name: '5 小时', used: 1200, limit: 1500, resetAt: '2026-10-21T18:00:00.000Z' },
          { name: '7 天', used: null, limit: 12000, resetAt: null }
        ]
      });
      s.saveUsage(id, { status: 'fail', windows: [], kind: null, raw: null, msg: '密钥无效：401' });

      const rows = s.listHistory(id, { kind: 'usage' });
      assert.strictEqual(rows.length, 5, '3 + 1 + 1 行');
      summary[backend] = rows.map(function (r) {
        /* 行号与时间戳两个后端必然不同，比的是业务值 */
        return { kind: r.kind, status: r.status, value: r.value, latency: r.latency, detail: r.detail };
      });
    } finally { sweep(dir); }
  });
});

test('两个后端的 usage 历史逐字一致', function () {
  if (!summary.json || !summary.sqlite) return;
  assert.deepStrictEqual(summary.json, summary.sqlite,
    '两个后端给出的 usage 历史不一样：\njson: ' + JSON.stringify(summary.json, null, 1)
    + '\nsqlite: ' + JSON.stringify(summary.sqlite, null, 1));
});

/* ---------- 老库兼容 ---------- */

test('老 SQLite 库：keys 表缺 usage 四列，升级后能打开、能存 usage、也能写历史', () => {
  if (backends.indexOf('sqlite') < 0) return;
  const dir = newDir('usage-old-sqlite');
  try {
    const a = store(dir, 'sqlite');
    const id = addKey(a);
    a.close();

    /* 把四列删掉 = 还原成加列之前的表结构。
       只改建表语句（CREATE TABLE IF NOT EXISTS）的话，老库一打开就
       "no such column" —— 服务在老库上根本起不来。 */
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'keys.db'));
    db.exec('ALTER TABLE keys DROP COLUMN usage_json');
    db.exec('ALTER TABLE keys DROP COLUMN usage_status');
    db.exec('ALTER TABLE keys DROP COLUMN usage_msg');
    db.exec('ALTER TABLE keys DROP COLUMN usage_updated_at');
    db.close();

    const b = store(dir, 'sqlite');
    const got = b.getKey(id);
    assert.ok(got, '老库里的密钥要还在');
    assert.strictEqual(got.usage.status, 'pending');
    assert.deepStrictEqual(got.usage.windows, []);

    b.saveUsage(id, SNAP);
    assert.strictEqual(b.getKey(id).usage.status, 'ok');
    const rows = b.listHistory(id, { kind: 'usage' });
    assert.strictEqual(rows.length, 3, '老库上照样能写 usage 历史');
    assert.deepStrictEqual(rows.map(function (r) { return r.value; }), [1200, 8400, 21000]);
    b.close();
  } finally { sweep(dir); }
});

test('老 JSON 库：密钥记录里没有 usage 字段时也能打开、能存 usage、也能写历史', () => {
  const dir = newDir('usage-old-json');
  try {
    const a = store(dir, 'json');
    const id = addKey(a);

    /* 还原成加 usage 之前的形态：密钥记录里没有 usage 字段 */
    const file = path.join(dir, 'store.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const k = doc.keys.filter(function (x) { return x.id === id; })[0];
    delete k.usage;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');

    const b = store(dir, 'json');
    const got = b.getKey(id);
    assert.ok(got, '老库里的密钥要还在');
    assert.strictEqual(got.usage.status, 'pending', '没有 usage 字段的老库读出来是空快照');
    assert.deepStrictEqual(got.usage.windows, []);

    b.saveUsage(id, SNAP);
    assert.strictEqual(b.getKey(id).usage.status, 'ok');
    const rows = b.listHistory(id, { kind: 'usage' });
    assert.strictEqual(rows.length, 3, '老库上照样能写 usage 历史');
    assert.deepStrictEqual(rows.map(function (r) { return r.value; }), [1200, 8400, 21000]);
  } finally { sweep(dir); }
});

/* ---------- 接口层 ---------- */

function call(base, method, p, body) {
  return fetch(base + p, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.json().then(function (data) { return { status: res.status, data: data }; });
  });
}

test('接口：/api/keys/:id/history?kind=usage 读得出限额历史，别的 kind 仍然 400', async () => {
  const { createApp } = require('../src/app');
  const dir = newDir('usage-api');
  let server = null;
  try {
    const storage = store(dir, 'json');
    const app = createApp({
      storage: storage,
      /* 这个测试不发外网请求：限额快照是直接走存储层写进去的 */
      fetchImpl: function () { return Promise.reject(new Error('这个测试不该发外网请求')); },
      publicDir: path.join(__dirname, '..', 'public'),
      version: 'test'
    });
    await new Promise(function (r) { server = app.listen(0, '127.0.0.1', r); });
    const base = 'http://127.0.0.1:' + server.address().port;

    const created = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-usage-api-0001' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.data));
    const id = created.data.key.id;

    /* 走真写入口落一段限额快照 */
    storage.saveUsage(id, SNAP);

    let r = await call(base, 'GET', '/api/keys/' + id + '/history?kind=usage');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.history.length, 3, 'usage 历史读得回来');
    assert.deepStrictEqual(r.data.history.map(function (h) { return h.value; }), [1200, 8400, 21000]);
    assert.strictEqual(JSON.parse(r.data.history[0].detail).name, '5 小时');

    r = await call(base, 'GET', '/api/keys/' + id + '/history');
    assert.strictEqual(r.status, 200, '不筛 kind 也能读');
    assert.strictEqual(r.data.history.length, 3);

    r = await call(base, 'GET', '/api/keys/' + id + '/history?kind=bogus');
    assert.strictEqual(r.status, 400, '别的 kind 仍然挡掉');
  } finally {
    if (server) server.close();
    sweep(dir);
  }
});
