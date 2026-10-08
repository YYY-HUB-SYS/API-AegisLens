const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const { createApp } = require('../src/app');

const KEY_VALUE = 'sk-secret-1234567890abcd';

const backends = [];
try {
  require('node:sqlite');
  backends.push('sqlite');
} catch (e) { /* 当前 Node 不支持，跳过 */ }
backends.push('json');

function newStore(backend) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-pools-' + backend + '-'));
  const mk = loadOrCreateMasterKey(dir);
  return { store: createStore(dir, mk, { backend: backend }), dir: dir };
}

function seedKey(store, name) {
  return store.createKey({
    name: name, platform: 'deepseek', customName: '', key: KEY_VALUE + name,
    base: 'https://api.deepseek.com', model: 'deepseek-chat', reg: '', exp: ''
  });
}

function runSuite(backend) {
  test('存储后端 ' + backend + '：账号池 CRUD 与成员管理', () => {
    const { store } = newStore(backend);
    const k1 = seedKey(store, '甲');
    const k2 = seedKey(store, '乙');

    const pool = store.createPool({ name: '主力池', keyIds: [k1.id] });
    assert.ok(pool.id >= 1);
    assert.strictEqual(pool.name, '主力池');
    assert.deepStrictEqual(pool.keyIds, [k1.id]);

    const got = store.getPool(pool.id);
    assert.deepStrictEqual(got.keyIds, [k1.id]);
    assert.strictEqual(store.getPool(9999), null, '池不存在返回 null');

    assert.deepStrictEqual(store.addPoolKey(pool.id, k2.id).keyIds, [k1.id, k2.id]);
    assert.strictEqual(store.addPoolKey(pool.id, k2.id), null, '重复添加返回 null');
    assert.strictEqual(store.addPoolKey(9999, k1.id), null, '池不存在返回 null');

    const afterRm = store.removePoolKey(pool.id, k1.id);
    assert.deepStrictEqual(afterRm.keyIds, [k2.id]);
    assert.strictEqual(store.removePoolKey(pool.id, 9999), null, '成员不存在返回 null');

    const replaced = store.updatePool(pool.id, { name: '备份池', keyIds: [k1.id] });
    assert.strictEqual(replaced.name, '备份池');
    assert.deepStrictEqual(replaced.keyIds, [k1.id]);
    assert.strictEqual(store.updatePool(9999, { name: 'x' }), null, '池不存在返回 null');

    store.deleteKey(k1.id);
    assert.deepStrictEqual(store.getPool(pool.id).keyIds, [], '删除密钥后应从所有池移除');

    assert.strictEqual(store.deletePool(pool.id), true);
    assert.strictEqual(store.getPool(pool.id), null);
    assert.strictEqual(store.deletePool(pool.id), false);
  });

  test('存储后端 ' + backend + '：账号池重启后仍在', () => {
    const { store, dir } = newStore(backend);
    const k = seedKey(store, '甲');
    store.createPool({ name: '持久池', keyIds: [k.id] });
    const mk2 = loadOrCreateMasterKey(dir);
    const store2 = createStore(dir, mk2, { backend: backend });
    const pools = store2.listPools();
    assert.strictEqual(pools.length, 1);
    assert.strictEqual(pools[0].name, '持久池');
    assert.deepStrictEqual(pools[0].keyIds, [k.id]);
  });
}

backends.forEach(runSuite);

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-pools-api-'));
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: 'json' });
  const server = createApp({
    storage: storage,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test'
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { server: server, base: base };
}

function call(base, method, p, body) {
  return fetch(base + p, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(res => res.json().then(data => ({ status: res.status, data: data })));
}

test('API 集成：账号池完整流程', async () => {
  const { server, base } = await startServer();
  try {
    let r = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-aaa-bbbb-cccc', name: '甲' });
    const k1 = r.data.key.id;
    r = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-ddd-eeee-ffff', name: '乙' });
    const k2 = r.data.key.id;

    r = await call(base, 'POST', '/api/pools', { name: '' });
    assert.strictEqual(r.status, 400, '空名称应被拒绝');
    r = await call(base, 'POST', '/api/pools', { name: '主力池' });
    assert.strictEqual(r.status, 201, '创建成功');
    assert.deepStrictEqual(r.data.pool.keyIds, []);
    assert.deepStrictEqual(r.data.pool.keys, []);
    const poolId = r.data.pool.id;

    r = await call(base, 'POST', '/api/pools', { name: '主力池' });
    assert.strictEqual(r.status, 409, '重名应被拒绝');

    r = await call(base, 'POST', '/api/pools', { name: '带成员池', keyIds: [k1, 9999] });
    assert.strictEqual(r.status, 400, '含不存在密钥应被拒绝');

    r = await call(base, 'POST', '/api/pools', { name: '带成员池', keyIds: [k1] });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.data.pool.keyIds, [k1]);
    assert.strictEqual(r.data.pool.keys.length, 1, '返回的池应带成员完整记录');

    r = await call(base, 'POST', '/api/pools/' + poolId + '/keys', { keyId: k2 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.pool.keyIds, [k2]);
    r = await call(base, 'POST', '/api/pools/' + poolId + '/keys', { keyId: k2 });
    assert.strictEqual(r.status, 409, '重复成员应被拒绝');
    r = await call(base, 'POST', '/api/pools/' + poolId + '/keys', { keyId: 9999 });
    assert.strictEqual(r.status, 400, '不存在密钥应被拒绝');
    r = await call(base, 'POST', '/api/pools/9999/keys', { keyId: k1 });
    assert.strictEqual(r.status, 404, '池不存在应 404');

    r = await call(base, 'PUT', '/api/pools/' + poolId, { name: '改名池', keyIds: [k1] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.pool.name, '改名池');
    assert.deepStrictEqual(r.data.pool.keyIds, [k1]);
    assert.strictEqual(r.data.pool.keys[0].name, '甲');
    r = await call(base, 'POST', '/api/pools', { name: '备用' });
    assert.strictEqual(r.status, 201);
    r = await call(base, 'PUT', '/api/pools/' + poolId, { name: '备用' });
    assert.strictEqual(r.status, 409, '改重名应被拒绝');

    r = await call(base, 'GET', '/api/pools');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.pools.length, 3, '应有三个池');

    r = await call(base, 'DELETE', '/api/pools/' + poolId + '/keys/' + k1);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.pool.keyIds, []);
    r = await call(base, 'DELETE', '/api/pools/' + poolId + '/keys/' + k1);
    assert.strictEqual(r.status, 200, '移除不存在成员应幂等');

    r = await call(base, 'DELETE', '/api/pools/' + poolId);
    assert.strictEqual(r.status, 200);
    r = await call(base, 'GET', '/api/pools');
    assert.strictEqual(r.data.pools.length, 2);
    r = await call(base, 'DELETE', '/api/pools/9999');
    assert.strictEqual(r.status, 404, '删除不存在池应 404');
  } finally {
    server.close();
  }
});

const HOMEPAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('工作台页面：账号池入口与视图容器', () => {
  assert.ok(HOMEPAGE.includes('id="btn-pools"'), '应有账号池切换按钮');
  assert.ok(HOMEPAGE.includes('id="pool-board"'), '应有账号池视图容器');
  assert.ok(HOMEPAGE.includes('id="overlay-pool"'), '应有账号池弹窗');
  assert.ok(HOMEPAGE.includes('id="f-pool-name"'), '应有账号池名称输入');
  assert.ok(HOMEPAGE.includes('id="pool-member-list"'), '应有成员选择列表');
  assert.ok(HOMEPAGE.includes('id="btn-pool-save"'), '应有保存按钮');
});

test('工作台页面：账号池渲染与事件逻辑', () => {
  assert.ok(HOMEPAGE.includes('function renderPoolBoard()'), '应有 renderPoolBoard');
  assert.ok(HOMEPAGE.includes('function renderPoolCard('), '应有 renderPoolCard');
  assert.ok(HOMEPAGE.includes('function renderPoolKeyRow('), '应有 renderPoolKeyRow');
  assert.ok(HOMEPAGE.includes('function openPoolForm('), '应有 openPoolForm');
  assert.ok(HOMEPAGE.includes('function replacePool('), '应有 replacePool');
  assert.ok(HOMEPAGE.includes("state.pools = (results[3] && results[3].pools) || []"), '启动时应加载账号池');
  assert.ok(HOMEPAGE.includes("state.view === 'pools'"), '应有视图状态判断');
  assert.ok(HOMEPAGE.includes("api('POST', '/pools', { name: name, keyIds: keyIds })"), '创建账号池应提交 keyIds');
});