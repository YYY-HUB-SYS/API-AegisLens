const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = require('./tmp.js');
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
  const dir = tmp.mk('akm-store-' + backend);
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

  test('存储后端 ' + backend + '：endpoints 数组存储与旧 base 自动迁移', () => {
    const { store } = newStore(backend);

    const rec = store.createKey({
      name: '多端点', platform: 'deepseek', customName: '', key: KEY_VALUE,
      endpoints: [
        { url: 'https://api.deepseek.com', style: 'openai' },
        { url: 'https://api.deepseek.com/anthropic', style: 'anthropic' }
      ],
      model: 'deepseek-chat', reg: '', exp: ''
    });
    let k = store.getKey(rec.id);
    assert.deepStrictEqual(k.endpoints, [
      { url: 'https://api.deepseek.com', style: 'openai' },
      { url: 'https://api.deepseek.com/anthropic', style: 'anthropic' }
    ]);
    assert.strictEqual(k.base, 'https://api.deepseek.com', 'base 保留首地址便于兼容');

    const upd = store.updateKey(rec.id, {
      endpoints: [{ url: 'https://gw.example.com', style: 'my-style' }]
    });
    assert.deepStrictEqual(upd.endpoints, [{ url: 'https://gw.example.com', style: 'my-style' }]);
    assert.strictEqual(upd.base, 'https://gw.example.com');

    const keep = store.updateKey(rec.id, { name: '改名不改端点' });
    assert.strictEqual(keep.endpoints.length, 1, '普通字段更新不应清空端点');
    assert.strictEqual(keep.endpoints[0].style, 'my-style');

    const legacy = store.createKey({
      name: '旧数据', platform: 'anthropic', customName: '', key: KEY_VALUE,
      base: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', reg: '', exp: ''
    });
    k = store.getKey(legacy.id);
    assert.deepStrictEqual(k.endpoints, [{ url: 'https://api.anthropic.com', style: 'anthropic' }], '旧 base 按 anthropic 风格迁移');

    const legacyUpd = store.updateKey(legacy.id, { base: 'https://new.anthropic.com' });
    assert.deepStrictEqual(legacyUpd.endpoints, [{ url: 'https://new.anthropic.com', style: 'anthropic' }], '旧 base 更新仍走单端点路径');

    const empty = store.createKey({
      name: '无地址', platform: 'custom', customName: '某中转', key: KEY_VALUE,
      endpoints: [], model: '', reg: '', exp: ''
    });
    k = store.getKey(empty.id);
    assert.deepStrictEqual(k.endpoints, []);
    assert.strictEqual(k.base, '');
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
  const dir = tmp.mk('akm-store-nosqlite');
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

test('另一份后端留有数据时标记 shadowStore，避免"升级 Node 后密钥全没了"被误判成丢数据', () => {
  const dir = tmp.mk('akm-shadow');
  const mk = loadOrCreateMasterKey(dir);
  const jsonStore = createStore(dir, mk, { backend: 'json' });
  jsonStore.createKey({
    name: 'JSON 时代的 Key', platform: 'deepseek', customName: '', key: KEY_VALUE,
    base: 'https://api.deepseek.com', model: 'deepseek-chat', reg: '', exp: ''
  });
  assert.strictEqual(jsonStore.shadowStore, undefined, '只有 store.json 时不该报影子库');

  fs.writeFileSync(path.join(dir, 'keys.db'), 'placeholder');
  const mixed = createStore(dir, mk, { backend: 'json' });
  assert.strictEqual(mixed.backend, 'json');
  assert.strictEqual(mixed.shadowStore, 'keys.db', '空目录外的另一份库必须被指出');
  assert.strictEqual(mixed.listKeys().length, 1, '影子库不应污染当前读取结果');

  const other = tmp.mk('akm-shadow2');
  createStore(other, mk, { backend: 'json' }).createKey({
    name: '旧数据', platform: 'openai', customName: '', key: KEY_VALUE,
    base: 'https://api.openai.com/v1', model: 'gpt-4o', reg: '', exp: ''
  });
  const zeroLen = path.join(other, 'keys.db');
  fs.writeFileSync(zeroLen, '');
  const noShadow = createStore(other, mk, { backend: 'json' });
  assert.strictEqual(noShadow.shadowStore, undefined, '零字节的残留文件不算另一份库');
});
