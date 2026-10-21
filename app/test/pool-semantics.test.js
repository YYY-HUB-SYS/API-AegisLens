/* 池语义：两个后端必须给出同一份结果 + 老库升级不许炸。
   盯这几件事：
   ① 建池：队首那把是「当前生效」，其余进备用队列；
   ② 编号口径：active 占 0，backup 从 1 起连续（0 是 active 的位置，备用不占）；
   ③ 改成员名单不换当前生效那把 —— 它还在名单里就还在，不在了才让队首顶上；
   ④ 加成员：有 active 就排队尾，没有就让新来的当 active；
   ⑤ 删成员：删掉的正好是当前生效那把 ⇒ 备用队首提上来；
   ⑥ 老 SQLite 库（pool_keys 缺 role/sort_index 两列）升级后必须能打开 ——
      这是上一版埋过的坑：缺 ALTER TABLE，服务在老库上根本起不来。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const tmp = require('./tmp.js');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');

const KEY_VALUE = 'sk-pool-sem-abcdef';

const backends = [];
try {
  require('node:sqlite');
  backends.push('sqlite');
} catch (e) { /* 当前 Node 不支持，跳过 */ }
backends.push('json');

/* 两个后端的结论都攒在这里，最后逐字比对：「两个后端语义一致」不能靠眼看 */
const summary = {};

function newStore(backend) {
  const dir = tmp.mk('akm-pool-sem-' + backend);
  const mk = loadOrCreateMasterKey(dir);
  return { store: createStore(dir, mk, { backend: backend }), dir: dir };
}

function seedKey(store, name) {
  return store.createKey({
    name: name, platform: 'deepseek', customName: '', key: KEY_VALUE + name,
    base: 'https://api.deepseek.com', model: 'deepseek-chat', reg: '', exp: ''
  });
}

/* 池的成员形态。按密钥名而不是 id：两个后端的 id 序号不一定一样，
   比的是「谁排在哪、什么角色、几号」这三件事。 */
function shapeOf(store, poolId) {
  const p = store.getPool(poolId);
  return (p.members || []).map(function (m) {
    const k = store.getKey(m.keyId);
    return (k ? k.name : '#' + m.keyId) + '/' + m.role + '/' + m.sortIndex;
  });
}

function rolesOf(store, poolId) {
  return (store.getPool(poolId).members || []).map(function (m) { return m.role; });
}

/* 一整套操作跑下来，留下每一步的形态 */
function scenario(store) {
  const k1 = seedKey(store, '甲');
  const k2 = seedKey(store, '乙');
  const k3 = seedKey(store, '丙');
  const out = {};

  /* 建池：队首那把是当前生效 */
  const p1 = store.createPool({ name: '池一', keyIds: [k1.id, k2.id, k3.id] });
  out.create = shapeOf(store, p1.id);

  /* 改名单但当前生效那把还在 ⇒ 不换 */
  store.updatePool(p1.id, { keyIds: [k2.id, k1.id, k3.id] });
  out.updateKeep = shapeOf(store, p1.id);

  /* 改名单且当前生效那把不在了 ⇒ 队首顶上 */
  store.updatePool(p1.id, { keyIds: [k2.id, k3.id] });
  out.updateDrop = shapeOf(store, p1.id);

  /* 加成员：排队尾 */
  store.addPoolKey(p1.id, k1.id);
  out.add = shapeOf(store, p1.id);

  /* 删掉当前生效那把 ⇒ 备用队首提上来 */
  store.removePoolKey(p1.id, k2.id);
  out.remove = shapeOf(store, p1.id);

  /* 轮换：把当前生效换成备用队首 */
  const now = store.getPool(p1.id);
  const first = now.members.filter(function (m) { return m.role !== 'active'; })
    .sort(function (a, b) { return a.sortIndex - b.sortIndex; })[0];
  store.setPoolActive(p1.id, first.keyId);
  out.setActive = shapeOf(store, p1.id);

  /* 备用队列重排（倒着排） */
  const backups = store.getPool(p1.id).members
    .filter(function (m) { return m.role !== 'active'; }).map(function (m) { return m.keyId; });
  store.setPoolBackupOrder(p1.id, backups.slice().reverse());
  out.backupOrder = shapeOf(store, p1.id);

  /* 空池加成员 ⇒ 新来的就是当前生效那把 */
  const p2 = store.createPool({ name: '池二', keyIds: [] });
  store.addPoolKey(p2.id, k2.id);
  out.emptyThenAdd = shapeOf(store, p2.id);

  return out;
}

backends.forEach(function (backend) {
  test('存储后端 ' + backend + '：池成员的语义与编号', () => {
    const { store } = newStore(backend);
    const k1 = seedKey(store, '甲');
    const k2 = seedKey(store, '乙');
    const k3 = seedKey(store, '丙');

    /* 建池：队首那把是当前生效，其余排队 */
    const p = store.createPool({ name: '池', keyIds: [k1.id, k2.id, k3.id] });
    assert.deepStrictEqual(rolesOf(store, p.id), ['active', 'backup', 'backup'],
      '队首那把是当前生效，其余在备用队列');
    assert.deepStrictEqual(store.getPool(p.id).members.map(function (m) { return m.sortIndex; }), [0, 1, 2],
      '编号：active 占 0，backup 从 1 起连续');

    /* 一把池只有一把 active */
    assert.strictEqual(rolesOf(store, p.id).filter(function (r) { return r === 'active'; }).length, 1);

    /* 改名单：当前生效那把还在就不换 */
    store.updatePool(p.id, { keyIds: [k2.id, k1.id, k3.id] });
    assert.strictEqual(store.getPool(p.id).members[0].keyId, k1.id, '当前生效那把不该被换掉');
    assert.deepStrictEqual(rolesOf(store, p.id), ['active', 'backup', 'backup']);

    /* 改名单：当前生效那把不在了 ⇒ 队首顶上 */
    store.updatePool(p.id, { keyIds: [k2.id, k3.id] });
    assert.strictEqual(store.getPool(p.id).members[0].keyId, k2.id, '不在名单里了才换人');
    assert.deepStrictEqual(rolesOf(store, p.id), ['active', 'backup']);

    /* 加成员排队尾 */
    store.addPoolKey(p.id, k1.id);
    assert.deepStrictEqual(rolesOf(store, p.id), ['active', 'backup', 'backup']);
    assert.strictEqual(store.getPool(p.id).members[2].keyId, k1.id, '新来的排队尾');

    /* 删掉当前生效那把 ⇒ 备用队首提上来 */
    store.removePoolKey(p.id, k2.id);
    assert.deepStrictEqual(rolesOf(store, p.id), ['active', 'backup']);
    assert.strictEqual(store.getPool(p.id).members[0].keyId, k3.id, '备用队首提上来当当前生效');
  });

  test('存储后端 ' + backend + '：整套操作跑下来每个成员都有角色与编号', () => {
    const { store } = newStore(backend);
    const out = scenario(store);
    for (const step of Object.keys(out)) {
      for (const row of out[step]) {
        assert.ok(/^(.+)\/(active|backup)\/\d+$/.test(row), step + ' 里有形态不对的成员：' + row);
      }
    }
    summary[backend] = out;
  });
});

test('两个后端的池语义逐字一致', function () {
  if (!summary.json || !summary.sqlite) return;
  assert.deepStrictEqual(summary.json, summary.sqlite,
    '两个后端给出的池成员形态不一样：\njson: ' + JSON.stringify(summary.json, null, 1)
    + '\nsqlite: ' + JSON.stringify(summary.sqlite, null, 1));
});

/* ---------- 老库升级 ---------- */

test('老 SQLite 库：pool_keys 缺 role/sort_index 两列，升级后能打开且池成员按老口径归一', () => {
  const dir = tmp.mk('akm-oldpool-sqlite');
  const mk = loadOrCreateMasterKey(dir);
  const store = createStore(dir, mk, { backend: 'sqlite' });
  const k1 = seedKey(store, '甲');
  const k2 = seedKey(store, '乙');
  const pool = store.createPool({ name: '老池', keyIds: [k1.id, k2.id] });
  store.close();

  /* 把这两列删掉 = 还原成加列之前的表结构；
     顺带还原上一版误插进 models 表的那两列 */
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'keys.db'));
  db.exec('ALTER TABLE pool_keys DROP COLUMN role');
  db.exec('ALTER TABLE pool_keys DROP COLUMN sort_index');
  db.exec("ALTER TABLE models ADD COLUMN role TEXT DEFAULT 'backup'");
  db.exec('ALTER TABLE models ADD COLUMN sort_index INTEGER DEFAULT 0');
  db.close();

  /* 升级：老库必须能打开。缺 ALTER TABLE 的话，服务在老库上直接起不来 */
  const mk2 = loadOrCreateMasterKey(dir);
  const store2 = createStore(dir, mk2, { backend: 'sqlite' });
  const p = store2.getPool(pool.id);
  assert.ok(p, '老库里的池要还在');
  assert.deepStrictEqual(p.members.map(function (m) { return m.role; }), ['active', 'backup'],
    '老池补列之后全是 backup，要按老口径把队首那把提成当前生效');
  assert.strictEqual(p.members[0].keyId, k1.id, '队首（插入顺序）那把是当前生效');
  assert.deepStrictEqual(p.members.map(function (m) { return m.sortIndex; }), [0, 1],
    '编号：active 占 0，backup 从 1 起');

  /* 老库上照样能加成员、轮换 */
  const k3 = seedKey(store2, '丙');
  store2.addPoolKey(p.id, k3.id);
  assert.deepStrictEqual(rolesOf(store2, p.id), ['active', 'backup', 'backup']);
  store2.setPoolActive(p.id, k2.id);
  assert.deepStrictEqual(rolesOf(store2, p.id), ['active', 'backup', 'backup']);
  assert.strictEqual(store2.getPool(p.id).members[0].keyId, k2.id, '轮换后新的成了当前生效');
  store2.close();
});

test('老 SQLite 库：models 表里多插的 role/sort_index 会被清掉', () => {
  const dir = tmp.mk('akm-oldpool-models');
  const mk = loadOrCreateMasterKey(dir);
  const store = createStore(dir, mk, { backend: 'sqlite' });
  seedKey(store, '甲');
  store.close();

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'keys.db'));
  db.exec("ALTER TABLE models ADD COLUMN role TEXT DEFAULT 'backup'");
  db.exec('ALTER TABLE models ADD COLUMN sort_index INTEGER DEFAULT 0');
  db.close();

  const mk2 = loadOrCreateMasterKey(dir);
  const store2 = createStore(dir, mk2, { backend: 'sqlite' });
  /* 句柄不关 ⇒ Windows 上目录删不掉，%TEMP% 里每次跑都攒一批残留 */
  const db2 = new DatabaseSync(path.join(dir, 'keys.db'));
  const cols = db2.prepare('PRAGMA table_info(models)').all().map(function (c) { return c.name; });
  db2.close();
  assert.ok(cols.indexOf('role') < 0, 'models 表里不该有 role 列：' + cols.join(','));
  assert.ok(cols.indexOf('sort_index') < 0, 'models 表里不该有 sort_index 列：' + cols.join(','));
  store2.close();
});

test('老 JSON 库：池成员是裸 keyIds（没有 members）时也能读出角色与编号', () => {
  const dir = tmp.mk('akm-oldpool-json');
  const mk = loadOrCreateMasterKey(dir);
  const store = createStore(dir, mk, { backend: 'json' });
  const k1 = seedKey(store, '甲');
  const k2 = seedKey(store, '乙');
  const pool = store.createPool({ name: '老池', keyIds: [k1.id, k2.id] });
  store.close();

  /* 还原成加 members 之前的形态：池里只有裸 keyIds，没有 members */
  const file = path.join(dir, 'store.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const p = doc.pools.filter(function (x) { return x.id === pool.id; })[0];
  p.keyIds = p.members.map(function (m) { return m.keyId; });
  delete p.members;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');

  const mk2 = loadOrCreateMasterKey(dir);
  const store2 = createStore(dir, mk2, { backend: 'json' });
  const got = store2.getPool(pool.id);
  assert.ok(got, '老库里的池要还在');
  assert.deepStrictEqual(got.members.map(function (m) { return m.role; }), ['active', 'backup'],
    '裸 keyIds 的老池要补出当前生效那把');
  assert.deepStrictEqual(got.members.map(function (m) { return m.sortIndex; }), [0, 1]);

  /* 老池上轮换不能炸（老库里 d.members 是 undefined，这儿最容易崩） */
  store2.setPoolActive(pool.id, k2.id);
  assert.strictEqual(store2.getPool(pool.id).members[0].keyId, k2.id);
});
