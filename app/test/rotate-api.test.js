/* 轮换链路与健康快照：两个后端（json / sqlite）必须一模一样。
   轮换动的是「当前在用的那把密钥」，是安全面，所以这组测试盯四件事：
   ① 挑备用看健康快照：连续失败两次以上才判死，没测过的不判死；
   ② 旧的当前生效那把排到队尾，不是被丢掉；
   ③ 幂等：轮换到已经在用的那把不报错、不改状态；
   ④ 审计留痕，但只记 id，不留密钥明文。 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const tmp = require('./tmp.js');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const { createApp } = require('../src/app');
const { createVaultSession } = require('../src/vault');

const KEY_VALUE = 'sk-rotate-secret-abcdef';

const backends = [];
try {
  require('node:sqlite');
  backends.push('sqlite');
} catch (e) { /* 当前 Node 不支持，跳过 */ }
backends.push('json');

/* 两个后端的结论都攒在这里，最后逐字比对：「两个后端语义一致」不能靠眼看 */
const summary = {};

function newStore(backend) {
  const dir = tmp.mk('akm-rotate-' + backend);
  const mk = loadOrCreateMasterKey(dir);
  return { store: createStore(dir, mk, { backend: backend }), dir: dir };
}

function seedKey(store, name) {
  return store.createKey({
    name: name, platform: 'deepseek', customName: '', key: KEY_VALUE + name,
    base: 'https://api.deepseek.com', model: 'deepseek-chat', reg: '', exp: ''
  });
}

async function startServer(backend) {
  const dir = tmp.mk('akm-rotate-api-' + backend);
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: backend });
  const vault = createVaultSession({ idleLockMs: 60000 });
  vault.openLegacy(mk);
  const server = createApp({
    storage: storage,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    vault: vault,
    idleLockTickMs: 100
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  return {
    server: server,
    storage: storage,
    vault: vault,
    base: 'http://127.0.0.1:' + server.address().port
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

async function addKey(base, name) {
  const r = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: KEY_VALUE + name, name: name });
  assert.strictEqual(r.status, 201, '建密钥应成功');
  return r.data.key;
}

/* 池的语义状态：谁是当前生效、备用队列怎么排（不看 sortIndex 的具体数值，
   两个后端编号基数不同，顺序才是同一件事） */
function poolStateOf(storage, poolId) {
  const p = storage.getPool(poolId);
  const members = p.members || [];
  const active = members.filter(function (m) { return m.role === 'active'; }).map(function (m) { return m.keyId; });
  const backups = members
    .filter(function (m) { return m.role !== 'active'; })
    .sort(function (a, b) { return (a.sortIndex || 0) - (b.sortIndex || 0); })
    .map(function (m) { return m.keyId; });
  return { active: active, backups: backups, raw: p };
}

/* 比对用：把 id 换成密钥名，两个后端的 id 序号不同也能比 */
function namesOf(storage, ids) {
  return (ids || []).map(function (id) {
    const k = storage.getKey(id);
    return k ? k.name : '#' + id;
  });
}

function failTwice(storage, keyId) {
  storage.saveTest(keyId, { status: 'fail', code: '401', msg: '密钥无效或无权限' });
  storage.saveTest(keyId, { status: 'fail', code: '401', msg: '密钥无效或无权限' });
}

function runSuite(backend) {
  test('存储后端 ' + backend + '：健康快照跟着测试结论走（失败累加、通过归零）', () => {
    const { store } = newStore(backend);
    const k = seedKey(store, '甲');
    let rec = store.getKey(k.id);
    assert.strictEqual(rec.failCount, 0, '新密钥没有失败次数');
    assert.strictEqual(rec.lastHealthAt, null, '没测过就没有健康时间');
    assert.strictEqual(rec.test, null, '没测过就没有测试结论');

    store.saveTest(k.id, { status: 'fail', code: '401', msg: '密钥无效或无权限' });
    rec = store.getKey(k.id);
    assert.strictEqual(rec.failCount, 1, '失败一次记一次');
    assert.ok(rec.lastHealthAt, '失败也是有结论的一次探测');

    store.saveTest(k.id, { status: 'fail', code: '401', msg: '密钥无效或无权限' });
    rec = store.getKey(k.id);
    assert.strictEqual(rec.failCount, 2, '连续两次失败');

    store.saveTest(k.id, { status: 'pass', latency: 12, msg: 'ok' });
    rec = store.getKey(k.id);
    assert.strictEqual(rec.failCount, 0, '通过一次就归零');
    assert.ok(rec.lastHealthAt, '通过也刷新健康时间');

    summary[backend] = summary[backend] || {};
    summary[backend].health = {
      fresh: { failCount: 0, lastHealthAt: null },
      afterFail1: { failCount: 1, hasTime: true },
      afterFail2: { failCount: 2, hasTime: true },
      afterPass: { failCount: 0, hasTime: true }
    };
  });

  test('存储后端 ' + backend + '：健康快照重启后仍在', () => {
    const { store, dir } = newStore(backend);
    const k = seedKey(store, '甲');
    failTwice(store, k.id);
    const mk2 = loadOrCreateMasterKey(dir);
    const store2 = createStore(dir, mk2, { backend: backend });
    const rec = store2.getKey(k.id);
    assert.strictEqual(rec.failCount, 2, '重启后连续失败次数还在');
    assert.ok(rec.lastHealthAt, '重启后健康时间还在');
  });

  test('API（' + backend + '）：自动轮换挑健康的备用，旧 active 排到队尾', async () => {
    const h = await startServer(backend);
    try {
      const k1 = await addKey(h.base, '甲');   /* 当前生效那把 */
      const k2 = await addKey(h.base, '乙');   /* 连续失败两次 ⇒ 不健康 */
      const k3 = await addKey(h.base, '丙');   /* 健康 */
      failTwice(h.storage, k2.id);
      h.storage.saveTest(k3.id, { status: 'pass', latency: 12, msg: 'ok' });

      const created = await call(h.base, 'POST', '/api/pools', { name: '主力池', keyIds: [k1.id, k2.id, k3.id] });
      assert.strictEqual(created.status, 201);
      const poolId = created.data.pool.id;
      assert.deepStrictEqual(poolStateOf(h.storage, poolId).active, [k1.id], '建池后队首那把是当前生效');

      const r = await call(h.base, 'POST', '/api/pools/' + poolId + '/rotate', {});
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.ok, true);
      assert.strictEqual(r.data.changed, true);
      assert.strictEqual(r.data.rotatedTo, k3.id, '应该轮到健康那把');
      assert.strictEqual(r.data.rotatedFrom, k1.id, '旧的是当前生效那把');
      assert.deepStrictEqual(r.data.skipped, [k2.id], '不健康那把被跳过');

      const st = poolStateOf(h.storage, poolId);
      assert.deepStrictEqual(st.active, [k3.id], '新的成了当前生效');
      assert.deepStrictEqual(st.backups, [k2.id, k1.id], '旧 active 排到备用队列末尾');
      assert.ok(r.data.pool, '结果里要带池记录');
      assert.strictEqual(r.data.pool.health.length, 3, '池记录带健康快照');

      summary[backend] = summary[backend] || {};
      /* 再轮换一次：这次**不带请求体**（界面上的「轮换到下一把健康的」就是这么发的）。
         队列往前挪一格：乙仍然不健康被跳过，甲没测过（不算坏）⇒ 轮到甲。 */
      const again = await call(h.base, 'POST', '/api/pools/' + poolId + '/rotate', null);
      assert.strictEqual(again.status, 200, "不带请求体也要能轮换");
      assert.strictEqual(again.data.rotatedTo, k1.id, "轮到下一把健康的（甲没测过，不算坏）");
      assert.strictEqual(again.data.rotatedFrom, k3.id);
      assert.deepStrictEqual(again.data.skipped, [k2.id], "不健康那把仍然被跳过");
      const st2 = poolStateOf(h.storage, poolId);
      assert.deepStrictEqual(st2.active, [k1.id]);
      assert.deepStrictEqual(st2.backups, [k2.id, k3.id], "上一把当前生效的排到队尾");

      summary[backend].rotate = {
        rotatedTo: namesOf(h.storage, [r.data.rotatedTo]),
        rotatedFrom: namesOf(h.storage, [r.data.rotatedFrom]),
        skipped: namesOf(h.storage, r.data.skipped),
        active: namesOf(h.storage, st.active),
        backups: namesOf(h.storage, st.backups)
      };
    } finally {
      h.server.close();
    }
  });

  test('API（' + backend + '）：备用队列里没有健康的密钥 ⇒ 400 并说清原因', async () => {
    const h = await startServer(backend);
    try {
      const k1 = await addKey(h.base, '甲');
      const k2 = await addKey(h.base, '乙');
      failTwice(h.storage, k2.id);
      const created = await call(h.base, 'POST', '/api/pools', { name: '全坏池', keyIds: [k1.id, k2.id] });
      const poolId = created.data.pool.id;

      const r = await call(h.base, 'POST', '/api/pools/' + poolId + '/rotate', {});
      assert.strictEqual(r.status, 400);
      assert.ok(/没有健康的密钥/.test(r.data.error), '要说清为什么轮换不了：' + r.data.error);
      assert.deepStrictEqual(poolStateOf(h.storage, poolId).active, [k1.id], '没轮换成就不该动状态');

      const rows = h.vault.audit.list().filter(function (r2) { return r2.kind === 'rotate'; });
      assert.ok(rows.length >= 1, '失败的轮换也要留审计');
      assert.strictEqual(rows[rows.length - 1].status, 'fail');
      assert.ok(rows[rows.length - 1].detail.indexOf(KEY_VALUE) < 0, '审计里不许出现密钥明文');
    } finally {
      h.server.close();
    }
  });

  test('API（' + backend + '）：指定不在池里的密钥 ⇒ 400', async () => {
    const h = await startServer(backend);
    try {
      const k1 = await addKey(h.base, '甲');
      const k2 = await addKey(h.base, '乙');
      const outsider = await addKey(h.base, '丙');
      const created = await call(h.base, 'POST', '/api/pools', { name: '主力池', keyIds: [k1.id, k2.id] });
      const poolId = created.data.pool.id;

      const r = await call(h.base, 'POST', '/api/pools/' + poolId + '/rotate', { toKeyId: outsider.id });
      assert.strictEqual(r.status, 400);
      assert.ok(/不在这个池子里/.test(r.data.error), '要说清这把不在池里：' + r.data.error);
      assert.deepStrictEqual(poolStateOf(h.storage, poolId).active, [k1.id], '没轮换成就不该动状态');

      const bad = await call(h.base, 'POST', '/api/pools/' + poolId + '/rotate', { toKeyId: '不是数字' });
      assert.strictEqual(bad.status, 400);
      const rows = h.vault.audit.list().filter(function (r2) { return r2.kind === 'rotate'; });
      assert.strictEqual(rows[rows.length - 1].status, 'fail', '失败也要留审计');
    } finally {
      h.server.close();
    }
  });

  test('API（' + backend + '）：轮换到已经在用的那把 ⇒ 幂等不报错', async () => {
    const h = await startServer(backend);
    try {
      const k1 = await addKey(h.base, '甲');
      const k2 = await addKey(h.base, '乙');
      const k3 = await addKey(h.base, '丙');
      const created = await call(h.base, 'POST', '/api/pools', { name: '主力池', keyIds: [k1.id, k2.id, k3.id] });
      const poolId = created.data.pool.id;
      const before = poolStateOf(h.storage, poolId);

      const r = await call(h.base, 'POST', '/api/pools/' + poolId + '/rotate', { toKeyId: k1.id });
      assert.strictEqual(r.status, 200, '幂等不是报错');
      assert.strictEqual(r.data.ok, true);
      assert.strictEqual(r.data.changed, false, '没换就不算换');
      assert.strictEqual(r.data.rotatedTo, k1.id);
      assert.strictEqual(r.data.rotatedFrom, null, '没从任何一把轮换过来');

      const after = poolStateOf(h.storage, poolId);
      assert.deepStrictEqual(after.active, before.active, '当前生效那把没变');
      assert.deepStrictEqual(after.backups, before.backups, '备用队列没变');
    } finally {
      h.server.close();
    }
  });

  test('API（' + backend + '）：单池详情带每个成员的健康快照', async () => {
    const h = await startServer(backend);
    try {
      const k1 = await addKey(h.base, '甲');
      const k2 = await addKey(h.base, '乙');
      const k3 = await addKey(h.base, '丙');
      failTwice(h.storage, k2.id);
      h.storage.saveTest(k3.id, { status: 'pass', latency: 12, msg: 'ok' });
      const created = await call(h.base, 'POST', '/api/pools', { name: '主力池', keyIds: [k1.id, k2.id, k3.id] });
      const poolId = created.data.pool.id;

      const r = await call(h.base, 'GET', '/api/pools/' + poolId, null);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.pool.id, poolId);
      const byId = {};
      r.data.pool.health.forEach(function (x) { byId[x.keyId] = x; });
      assert.strictEqual(Object.keys(byId).length, 3, '每个成员一条快照');

      assert.strictEqual(byId[k2.id].failCount, 2);
      assert.strictEqual(byId[k2.id].lastStatus, 'fail');
      assert.strictEqual(byId[k2.id].healthy, false, '连续失败两次算不健康');
      assert.ok(byId[k2.id].lastHealthAt, '不健康的那把也有健康时间');

      assert.strictEqual(byId[k3.id].failCount, 0);
      assert.strictEqual(byId[k3.id].lastStatus, 'pass');
      assert.strictEqual(byId[k3.id].healthy, true);

      assert.strictEqual(byId[k1.id].failCount, 0);
      assert.strictEqual(byId[k1.id].lastStatus, null, '没测过的没有测试状态');
      assert.strictEqual(byId[k1.id].lastHealthAt, null);
      assert.strictEqual(byId[k1.id].healthy, true, '没测过的不该被判死');

      const miss = await call(h.base, 'GET', '/api/pools/9999', null);
      assert.strictEqual(miss.status, 404, '池不存在应 404');
    } finally {
      h.server.close();
    }
  });

  test('API（' + backend + '）：轮换留审计，审计里没有密钥明文', async () => {
    const h = await startServer(backend);
    try {
      const k1 = await addKey(h.base, '甲');
      const k2 = await addKey(h.base, '乙');
      const created = await call(h.base, 'POST', '/api/pools', { name: '主力池', keyIds: [k1.id, k2.id] });
      const poolId = created.data.pool.id;

      const r = await call(h.base, 'POST', '/api/pools/' + poolId + '/rotate', {});
      assert.strictEqual(r.status, 200);
      const rows = h.vault.audit.list().filter(function (x) { return x.kind === 'rotate'; });
      assert.strictEqual(rows.length, 1, '轮换留一条审计');
      assert.strictEqual(rows[0].status, 'ok');
      assert.ok(rows[0].detail.indexOf(KEY_VALUE) < 0, '审计里不许出现密钥明文');
      assert.ok(rows[0].detail.indexOf(String(k2.id)) > -1, '审计记的是密钥 id');
    } finally {
      h.server.close();
    }
  });
}

backends.forEach(runSuite);

test('两个后端的健康快照行为一致', () => {
  if (!summary.json || !summary.sqlite) return;
  assert.deepStrictEqual(summary.json.health, summary.sqlite.health);
});

test('两个后端的轮换结果一致', () => {
  if (!summary.json || !summary.sqlite) return;
  assert.deepStrictEqual(summary.json.rotate, summary.sqlite.rotate);
});
