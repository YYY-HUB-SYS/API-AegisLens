const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');

const KEY_VALUE = 'sk-secret-1234567890abcd';

const backends = [];
try {
  require('node:sqlite');
  backends.push('sqlite');
} catch (e) { /* 当前 Node 不支持，跳过 */ }
backends.push('json');

function newStore(backend) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-store-' + backend + '-'));
  const mk = loadOrCreateMasterKey(dir);
  return { store: createStore(dir, mk, { backend: backend }), dir: dir };
}

function runSuite(backend) {
  test('存储后端 ' + backend + '：基础 CRUD', () => {
    const { store } = newStore(backend);
    const rec = store.createKey({
      name: '主力 Key', platform: 'deepseek', customName: '', key: KEY_VALUE,
      base: 'https://api.deepseek.com', model: 'deepseek-chat',
      reg: '2025-06-18', exp: '2027-01-01', balanceStatus: 'pending'
    });
    assert.ok(rec.id >= 1);
    assert.strictEqual(store.listKeys().length, 1);

    const got = store.getKey(rec.id);
    assert.strictEqual(got.key, KEY_VALUE);
    assert.strictEqual(got.name, '主力 Key');
    assert.strictEqual(got.balance.status, 'pending');
    assert.deepStrictEqual(got.models, []);
    assert.deepStrictEqual(got.assigned, []);
    assert.strictEqual(got.modelsFetched, false);
    assert.strictEqual(got.test, null);

    const upd = store.updateKey(rec.id, { name: '改名', model: 'deepseek-reasoner' });
    assert.strictEqual(upd.name, '改名');
    assert.strictEqual(upd.model, 'deepseek-reasoner');
    assert.strictEqual(upd.key, KEY_VALUE);

    assert.strictEqual(store.deleteKey(rec.id), true);
    assert.strictEqual(store.getKey(rec.id), null);
    assert.strictEqual(store.deleteKey(rec.id), false);
  });

  test('存储后端 ' + backend + '：密钥落盘为密文', () => {
    const { store, dir } = newStore(backend);
    store.createKey({
      name: '加密检查', platform: 'openai', customName: '', key: KEY_VALUE,
      base: 'https://api.openai.com/v1', model: 'gpt-4o', reg: '', exp: ''
    });
    const files = fs.readdirSync(dir);
    const dbFile = files.find(f => f === 'store.json' || f === 'keys.db');
    const raw = fs.readFileSync(path.join(dir, dbFile));
    const text = raw.toString('latin1');
    assert.ok(!text.includes(KEY_VALUE), '落盘文件不应包含明文密钥');
    assert.ok(text.includes('enc:v1:'), '落盘文件应包含加密前缀');
  });

  test('存储后端 ' + backend + '：模型 upsert 与替换', () => {
    const { store } = newStore(backend);
    const rec = store.createKey({
      name: '模型测试', platform: 'deepseek', customName: '', key: KEY_VALUE,
      base: 'https://api.deepseek.com', model: 'deepseek-chat', reg: '', exp: ''
    });

    store.upsertModel(rec.id, { id: 'manual-model', ctx: 1000, out: 200, src: 'manual', note: 'Dify' });
    let k = store.getKey(rec.id);
    assert.strictEqual(k.models.length, 1);
    assert.strictEqual(k.models[0].note, 'Dify');

    store.upsertModel(rec.id, { id: 'manual-model', note: 'n8n' });
    k = store.getKey(rec.id);
    assert.strictEqual(k.models[0].note, 'n8n');
    assert.strictEqual(k.models[0].ctx, 1000, '未提供的字段保持不变');

    store.replaceModels(rec.id, [
      { id: 'manual-model', ctx: 1000, out: 200, src: 'manual', note: 'n8n' },
      { id: 'deepseek-chat', ctx: 65536, out: 8192, src: 'meta', note: null }
    ]);
    k = store.getKey(rec.id);
    assert.strictEqual(k.models.length, 2);
    assert.strictEqual(k.modelsFetched, true);
  });

  test('存储后端 ' + backend + '：配置去向增删与去重', () => {
    const { store } = newStore(backend);
    const rec = store.createKey({
      name: '去向测试', platform: 'moonshot', customName: '', key: KEY_VALUE,
      base: 'https://api.moonshot.cn/v1', model: '', reg: '', exp: ''
    });
    const r1 = store.addAssigned(rec.id, 'Dify');
    assert.deepStrictEqual(r1.assigned, ['Dify']);
    assert.strictEqual(store.addAssigned(rec.id, 'Dify'), null, '重复添加返回 null');
    store.addAssigned(rec.id, 'n8n');
    const r2 = store.removeAssigned(rec.id, 'Dify');
    assert.deepStrictEqual(r2.assigned, ['n8n']);
  });

  test('存储后端 ' + backend + '：余额与测试结果持久化', () => {
    const { store } = newStore(backend);
    const rec = store.createKey({
      name: '状态测试', platform: 'deepseek', customName: '', key: KEY_VALUE,
      base: 'https://api.deepseek.com', model: '', reg: '', exp: ''
    });
    store.saveBalance(rec.id, { value: 88.5, status: 'ok' });
    store.saveTest(rec.id, { status: 'pass', latency: 250, msg: 'ok' });
    const k = store.getKey(rec.id);
    assert.strictEqual(k.balance.value, 88.5);
    assert.strictEqual(k.balance.status, 'ok');
    assert.ok(k.balance.updatedAt);
    assert.strictEqual(k.test.status, 'pass');
    assert.strictEqual(k.test.latency, 250);
  });

  test('存储后端 ' + backend + '：删除密钥时清理模型与去向', () => {
    const { store } = newStore(backend);
    const rec = store.createKey({
      name: '级联删除', platform: 'deepseek', customName: '', key: KEY_VALUE,
      base: 'https://api.deepseek.com', model: '', reg: '', exp: ''
    });
    store.upsertModel(rec.id, { id: 'm1', src: 'manual' });
    store.addAssigned(rec.id, 'Dify');
    store.deleteKey(rec.id);
    const again = store.createKey({
      name: '级联删除', platform: 'deepseek', customName: '', key: KEY_VALUE,
      base: 'https://api.deepseek.com', model: '', reg: '', exp: ''
    });
    const k = store.getKey(again.id);
    assert.deepStrictEqual(k.models, [], '新密钥不应看到旧密钥的模型');
    assert.deepStrictEqual(k.assigned, []);
  });

  test('存储后端 ' + backend + '：重启后数据仍在（新建 store 读取同一目录）', () => {
    const { store, dir } = newStore(backend);
    store.createKey({
      name: '持久化', platform: 'openai', customName: '', key: KEY_VALUE,
      base: 'https://api.openai.com/v1', model: 'gpt-4o', reg: '', exp: ''
    });
    const mk2 = loadOrCreateMasterKey(dir);
    const store2 = createStore(dir, mk2, { backend: backend });
    const keys = store2.listKeys();
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].key, KEY_VALUE);
    assert.strictEqual(keys[0].name, '持久化');
  });
}

backends.forEach(runSuite);

test('createStore auto 模式返回可用后端', () => {
  const { store } = newStore('auto');
  assert.ok(store.backend === 'sqlite' || store.backend === 'json');
});

test('createStore 指定 sqlite 但不可用时抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-store-nosqlite-'));
  loadOrCreateMasterKey(dir);
  const Module = require('node:module');
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'node:sqlite') throw new Error('not available');
    return orig.apply(this, arguments);
  };
  try {
    assert.throws(() => createStore(dir, Buffer.alloc(32, 1), { backend: 'sqlite' }));
    const fallback = createStore(dir, Buffer.alloc(32, 1), { backend: 'auto' });
    assert.strictEqual(fallback.backend, 'json');
  } finally {
    Module.prototype.require = orig;
  }
});
