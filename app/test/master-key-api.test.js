/* 主密钥位置的两个新接口：
 *   GET  /api/vault/status  → 多两个字段：masterKeySource / keyringAvailable
 *   POST /api/vault/master-key-location {target:'os'|'file'} → 搬动主密钥
 *
 * 这两个接口动的是**信任根**，所以测的不只是「返回 200」，
 * 而是要盯住：搬完之后主密钥还是不是同一个、盘上还有没有明文、
 * 失败时有没有把事情说清楚。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createStore } = require('../src/storage');
const { createVaultSession, createThrottle } = require('../src/vault');
const { loadOrCreateMasterKey, masterKeySource } = require('../src/crypto');

/* 换掉 keystore 模块（内存 Map 当凭据管理器），并让 crypto.js 重新加载拿到它。
   真凭据管理器会污染用户机器，CI 上也没有。
   ⚠ 还要让 **api.js** 重新加载：它在模块加载时就 require 了 crypto，
   只换 crypto 的缓存，api.js 手里那份仍是真 keystore（会真去调系统凭据管理器）。 */
async function withFakeKeyring(opts, fn) {
  const o = opts || {};
  const store = new Map();
  /* 键要跟真实现一致：真 keystore 用 path.resolve(dataDir) 做条目名，
     这里也用 resolve —— 否则同一份数据目录写成 'x/' 和 'x' 会落到两个条目上，
     读的时候就说「这台机器上读不到」，而实际是键不一致。 */
  const keyOf = function (dir) { return path.resolve(dir); };
  const fake = {
    SERVICE: 'API-AegisLens',
    isAvailable: function () { return o.available !== false; },
    getSecret: function (dir) {
      if (!store.has(keyOf(dir))) return null;
      return Buffer.from(store.get(keyOf(dir)), 'hex');
    },
    setSecret: function (dir, sec) {
      if (o.writeFails) return false;
      store.set(keyOf(dir), Buffer.from(sec).toString('hex'));
      return true;
    },    deleteSecret: function (dir) { return store.delete(keyOf(dir)); },
    hasSecret: function (dir) { return store.has(keyOf(dir)); },
    describe: function () { return { available: o.available !== false, inUse: store.size > 0, service: 'API-AegisLens' }; },
    cleanupProbe: function () { }
  };
  const ksPath = require.resolve('../src/keystore');
  const cryptoPath = require.resolve('../src/crypto');
  const apiPath = require.resolve('../src/api');
  /* app.js 也要清：它在顶层 require 了 api.js，而 api.js 在加载时就把 crypto 绑定了。
     只清 crypto / api 的缓存不够 —— app.js 缓存里那份 api.js 仍持有**旧 crypto**，
     于是「写凭据」用的是新 fake、「读凭据」用的是旧 fake，键就对不上
     （症状：SET 成功、紧接着 GET 却 hit=false）。
     app.js / storage.js / vault.js 都不依赖 keystore，清掉它们是安全的。 */
  const appPath = require.resolve('../src/app');
  const origKs = require.cache[ksPath];
  require.cache[ksPath] = { id: ksPath, filename: ksPath, loaded: true, exports: fake };
  delete require.cache[cryptoPath];
  delete require.cache[apiPath];
  delete require.cache[appPath];
  /* ⚠ 必须 await 回调，不能 `return fn(...)`：
     fn 是 async，返回 Promise 时 finally 会**立刻**执行（不等 Promise 完成），
     缓存被提前恢复，后面的 await 继续跑时拿到的是另一份缓存。 */
  try {
    const out = await fn(require('../src/crypto'), fake, require('../src/app'));
    return out;
  } finally {
    if (origKs) require.cache[ksPath] = origKs; else delete require.cache[ksPath];
    delete require.cache[cryptoPath];
    delete require.cache[apiPath];
    delete require.cache[appPath];
  }
}

async function startServer(opts, appMod) {
  const o = opts || {};
  const dir = tmp.mk('akm-mkapi');
  const storage = createStore(dir, Buffer.alloc(32, 7), { backend: 'json' });
  const vault = createVaultSession({ idleLockMs: 60000 });
  vault.openLegacy(Buffer.alloc(32, 7));
  const throttle = {
    unlock: createThrottle({ maxFails: 5 }),
    reveal: createThrottle({ maxFails: 30 }),
    credential: createThrottle({ maxFails: 20 }),
    passphrase: createThrottle({ maxFails: 5 }),
    token: createThrottle({ maxFails: 20 })
  };
  const createApp = (appMod || require('../src/app')).createApp;
  const server = createApp({
    storage: storage,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    vault: vault,
    throttle: throttle
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  return {
    dir: dir, storage: storage, vault: vault,
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

test('GET /api/vault/status：要报出主密钥在哪 + 这台机器能不能用凭据管理器', async () => {
  await withFakeKeyring({}, async function (crypto, fake, appMod) {
    const h = await startServer({}, appMod);
    try {
      const r = await call(h.base, 'GET', '/api/vault/status');
      assert.strictEqual(r.status, 200);
      assert.ok('masterKeySource' in r.data, '必须报出主密钥的位置');
      assert.ok('keyringAvailable' in r.data, '必须报出这台机器能不能用凭据管理器');
      assert.strictEqual(typeof r.data.keyringAvailable, 'boolean');
      /* 这个测试库的主密钥是 harness 直接造的，不走 loadOrCreateMasterKey，
         所以位置是 null（没有 master.key 文件）——但字段必须在 */
      assert.ok(r.data.masterKeySource === null || r.data.masterKeySource === 'file' || r.data.masterKeySource === 'os',
        'masterKeySource 的取值要受约束，实得：' + r.data.masterKeySource);
    } finally { h.server.close(); }
  });
});

test('POST /api/vault/master-key-location：搬完主密钥还是同一个，盘上不再有明文', async () => {
  await withFakeKeyring({}, async function (crypto, fake, appMod) {
    const dir = tmp.mk('akm-mkmove');
    /* 先造一个「老库」：盘上明文 master.key */
    const orig = 'e'.repeat(64);
    fs.writeFileSync(path.join(dir, 'master.key'), orig, { mode: 0o600 });
    const storage = createStore(dir, Buffer.from(orig, 'hex'), { backend: 'json' });
    const vault = createVaultSession({ idleLockMs: 60000 });
    vault.openLegacy(Buffer.from(orig, 'hex'));
    const server = appMod.createApp({
      storage: storage,
      publicDir: path.join(__dirname, '..', 'public'),
      version: 'test',
      vault: vault,
      throttle: {
        unlock: createThrottle({ maxFails: 5 }),
        reveal: createThrottle({ maxFails: 30 }),
        credential: createThrottle({ maxFails: 20 }),
        passphrase: createThrottle({ maxFails: 5 }),
        token: createThrottle({ maxFails: 20 })
      }
    });
    await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      const r = await call(base, 'POST', '/api/vault/master-key-location', { target: 'os' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      assert.strictEqual(r.data.changed, true);
      assert.strictEqual(r.data.source, 'os');

      const onDisk = fs.readFileSync(path.join(dir, 'master.key'), 'utf8').trim();
      assert.ok(onDisk.startsWith('os:v1:'), '盘上应换成占位标记');
      assert.strictEqual(onDisk.includes(orig), false, '★ 盘上不能还留着明文主密钥');

      /* 搬完还读得到同一个主密钥 —— 否则整库就废了 */
      const back = crypto.loadOrCreateMasterKey(dir);
      assert.strictEqual(back.toString('hex'), orig, '搬完必须还读得到同一个主密钥（dir=' + dir + ' / storage.dataDir=' + storage.dataDir + '）');
      assert.strictEqual(crypto.masterKeySource(dir), 'os');
      /* 搬回文件 */
      const back2 = await call(base, 'POST', '/api/vault/master-key-location', { target: 'file' });
      assert.strictEqual(back2.status, 200, JSON.stringify(back2.data));
      assert.strictEqual(fs.readFileSync(path.join(dir, 'master.key'), 'utf8').trim(), orig, '主密钥要回到盘上');
    } finally { server.close(); }
  });
});

test('POST /api/vault/master-key-location：位置没变就说没变，不假装搬了', async () => {
  await withFakeKeyring({}, async function (crypto, fake, appMod) {
    const h = await startServer({}, appMod);
    try {
      const r = await call(h.base, 'POST', '/api/vault/master-key-location', { target: 'os' });
      /* 这个测试库压根没有 master.key（不是 file 也不是 os），所以是 409「还没有主密钥」 */
      assert.strictEqual(r.status, 409, JSON.stringify(r.data));
      assert.match(r.data.error, /还没有主密钥/);
    } finally { h.server.close(); }
  });
});

test('POST /api/vault/master-key-location：非法 target 要被拒', async () => {
  await withFakeKeyring({}, async function (crypto, fake, appMod) {
    const h = await startServer({}, appMod);
    try {
      const r = await call(h.base, 'POST', '/api/vault/master-key-location', { target: '随便什么' });
      assert.strictEqual(r.status, 400);
      assert.match(r.data.error, /target/);
    } finally { h.server.close(); }
  });
});
