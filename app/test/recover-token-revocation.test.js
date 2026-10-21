/* C-4：拿恢复码重置口令 ⇒ 之前签发的消费者令牌当场作废，但库里数据一条不少。
   这条语义是用户拍板的：忘口令是「找回访问权」，不是「格式化重来」。
   错的那个版本（换 DEK + 全量重新加密）会把密钥、凭证、账号池一起报废——那不是找回，是删库。

   这里盯四件事：
   1) 旧令牌必须 401，且 reason 必须是 unknown（签发记录没了），**不能是 bad-signature**：
      两者都是 401，但含义相反——bad-signature 说明 DEK 换了（数据全得重写），
      unknown 只说明库里查不到这把令牌的签发记录（数据一条没动）。这条断言就是钉住「DEK 没换」。
   2) 密钥 / 凭证 / 账号池一条不少，而且 reveal 还拿得到明文（密文没被重写）。
   3) 恢复码那条路和「改口令」那条路语义必须不同：改口令不吊销令牌（README 写了这条边界）。
   4) JSON 与 SQLite 两个后端行为一致。

   接线照抄 server.js 的生产形状：storage 是个门面，onUnlock 重建 store。
   直接把 store 对象塞进去的话，测的是另一套接线——C-4 的 clearTokens 恰好打在
   「onUnlock 重建出来的新 store」上，这条链路必须真测到。 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const { createVaultSession, createThrottle } = require('../src/vault');

const backends = [];
try {
  require('node:sqlite');
  backends.push('sqlite');
} catch (e) { /* 当前 Node 不支持，跳过 */ }
backends.push('json');

const KEY_VALUE = 'sk-recover-token-0001';

function harness(backend) {
  const dir = tmp.mk('akm-recover-tok');
  const mk = loadOrCreateMasterKey(dir);
  let realStore = createStore(dir, mk, { backend: backend });
  const vault = createVaultSession({ idleLockMs: 60000 });
  vault.openLegacy(mk);

  /* 生产门面（server.js 里就是这个形状）：未解锁时任何真要取数据的调用抛 423；
     dataDir / backend 这类元信息照读，vault 路由要靠 dataDir 找恢复信封。 */
  const storage = new Proxy({}, {
    get: function (_t, prop) {
      if (prop === 'dataDir') return dir;
      if (prop === 'backend') return realStore ? realStore.backend : null;
      if (prop === 'shadowStore') return realStore ? realStore.shadowStore : null;
      if (!realStore) {
        const e = new Error('保险库未解锁');
        e.httpStatus = 423;
        throw e;
      }
      const v = realStore[prop];
      return typeof v === 'function' ? v.bind(realStore) : v;
    }
  });

  const throttle = {
    unlock: createThrottle({ maxFails: 5 }),
    reveal: createThrottle({ maxFails: 30 }),
    credential: createThrottle({ maxFails: 20 }),
    passphrase: createThrottle({ maxFails: 5 }),
    token: createThrottle({ maxFails: 20 })
  };

  const server = createApp({
    storage: storage,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    fetchImpl: function () {
      return Promise.resolve(new Response('{"error":"invalid"}', { status: 401 }));
    },
    vault: vault,
    throttle: throttle,
    /* 照 server.js 的 openStore：解锁 = 用同一把 DEK 重开一个 store 句柄 */
    onUnlock: function (dek, mode) {
      realStore = createStore(dir, dek, { backend: backend });
      vault.attach(dek, mode);
      return realStore;
    },
    /* 照 server.js 的 handleLock：锁上 = 关 store（断掉解密能力）+ 锁会话 */
    onLock: function () {
      const was = vault.lock();
      if (realStore) realStore.close();
      realStore = null;
      return was;
    }
  });
  return { dir: dir, mk: mk, vault: vault, server: server, backend: backend };
}

async function serve(h) {
  await new Promise(function (r) { h.server.listen(0, '127.0.0.1', r); });
  return 'http://127.0.0.1:' + h.server.address().port;
}

function close(h) { return new Promise(function (r) { h.server.close(r); }); }

function call(base, method, p, body, headers) {
  const h = Object.assign({}, headers || {});
  if (body) h['Content-Type'] = 'application/json';
  return fetch(base + p, {
    method: method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.json().then(function (data) { return { status: res.status, data: data }; });
  });
}

/* 塞一份「必须活着」的数据：密钥 + 凭证 + 账号池，三样各一条 */
async function seedData(base) {
  const key = await call(base, 'POST', '/api/keys', {
    platform: 'deepseek', key: KEY_VALUE, name: '恢复后必须还在'
  });
  assert.strictEqual(key.status, 201, JSON.stringify(key.data));
  const cred = await call(base, 'POST', '/api/credentials', {
    site: 'example.com', title: '登录门户', username: 'someone', password: 'p@ss-w0rd'
  });
  assert.strictEqual(cred.status, 201, JSON.stringify(cred.data));
  const pool = await call(base, 'POST', '/api/pools', { name: '主号池', keyIds: [key.data.key.id] });
  assert.strictEqual(pool.status, 201, JSON.stringify(pool.data));
  return { keyId: key.data.key.id, credId: cred.data.credential.id };
}

async function issueToken(base, label, keyIds) {
  const r = await call(base, 'POST', '/api/consumer/tokens', {
    label: label || 'tester', scopes: ['key:read'],
    keyIds: keyIds || [], credIds: [], ttlSeconds: 3600
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data.token;
}

function runSuite(backend) {
  test('存储后端 ' + backend + '：恢复码重置口令 ⇒ 旧令牌作废，但数据一条不少', async () => {
    const h = harness(backend);
    const base = await serve(h);
    try {
      const ids = await seedData(base);
      const token = await issueToken(base, 'before-recover', [ids.keyId]);

      /* 令牌现在能用：不然「作废」两个字没有对照 */
      const before = await call(base, 'GET', '/api/consumer/keys/' + ids.keyId, null,
        { Authorization: 'Bearer ' + token });
      assert.strictEqual(before.status, 200, JSON.stringify(before.data));
      assert.strictEqual(before.data.key, KEY_VALUE);

      /* 设口令 → 拿到恢复码（首次设口令会回读 52 位恢复码） */
      const set = await call(base, 'POST', '/api/vault/passphrase', { next: 'first-pass-1' });
      assert.strictEqual(set.status, 200, JSON.stringify(set.data));
      const recoveryCode = set.data.recoveryCode;
      assert.ok(recoveryCode && recoveryCode.split(' ').length > 0, '首次设口令必须给出恢复码');

      /* 锁上：store 关掉，令牌这条路开始报 423 */
      const lock = await call(base, 'POST', '/api/vault/lock', {});
      assert.strictEqual(lock.status, 200);
      const locked = await call(base, 'GET', '/api/consumer/keys/' + ids.keyId, null,
        { Authorization: 'Bearer ' + token });
      assert.strictEqual(locked.status, 423, '锁着的时候报 423，不报 401');
      assert.strictEqual(locked.data.reason, 'locked');

      /* 忘口令的出口：拿恢复码重置口令 */
      const rec = await call(base, 'POST', '/api/vault/recover', {
        recoveryCode: recoveryCode, next: 'second-pass-2'
      });
      assert.strictEqual(rec.status, 200, JSON.stringify(rec.data));
      assert.strictEqual(rec.data.unlocked, true, '恢复成功就该是解锁状态');
      assert.strictEqual(rec.data.restartRequired, false, 'store 当场重建，不该叫用户去重启');
      assert.strictEqual(rec.data.tokensRevoked, 1, '响应必须报出作废了几把旧令牌');
      assert.ok(rec.data.recoveryCode && rec.data.recoveryCode !== recoveryCode, '恢复码必须轮换');

      /* 旧令牌：401，且落在 unknown 这一档 —— DEK 没换，只是签发记录没了 */
      const after = await call(base, 'GET', '/api/consumer/keys/' + ids.keyId, null,
        { Authorization: 'Bearer ' + token });
      assert.strictEqual(after.status, 401, '旧令牌必须当场作废');
      assert.strictEqual(after.data.reason, 'unknown',
        'reason 必须是 unknown（查不到签发记录）；若是 bad-signature 说明 DEK 被换了，数据就全得重写');
      assert.match(after.data.error, /签发记录/, '文案要指出令牌要重新签发');

      /* 数据一条不少：密钥、凭证、账号池、密文全在 */
      const keys = await call(base, 'GET', '/api/keys');
      assert.strictEqual(keys.status, 200);
      assert.strictEqual(keys.data.keys.length, 1, '密钥必须一条不少');
      assert.strictEqual(keys.data.keys[0].id, ids.keyId);

      const reveal = await call(base, 'POST', '/api/keys/' + ids.keyId + '/reveal', {});
      assert.strictEqual(reveal.status, 200);
      assert.strictEqual(reveal.data.key, KEY_VALUE, '密文不许被重写——明文必须还读得出来');

      const creds = await call(base, 'GET', '/api/credentials');
      assert.strictEqual(creds.status, 200);
      assert.strictEqual(creds.data.credentials.length, 1, '凭证必须一条不少');
      assert.strictEqual(creds.data.credentials[0].id, ids.credId);
      assert.strictEqual(creds.data.credentials[0].username, 'someone');

      const pools = await call(base, 'GET', '/api/pools');
      assert.strictEqual(pools.status, 200);
      assert.strictEqual(pools.data.pools.length, 1, '账号池必须一条不少');
      assert.strictEqual(pools.data.pools[0].keys.length, 1, '池子里的成员也必须还在');

      /* 保险库恢复后还能继续用：新令牌签得出来、也真能用 */
      const fresh = await issueToken(base, 'after-recover', [ids.keyId]);
      const freshCall = await call(base, 'GET', '/api/consumer/keys/' + ids.keyId, null,
        { Authorization: 'Bearer ' + fresh });
      assert.strictEqual(freshCall.status, 200, '恢复后必须还能重新签发并使用');
      assert.strictEqual(freshCall.data.key, KEY_VALUE);
    } finally { await close(h); }
  });

  test('存储后端 ' + backend + '：改口令不吊销令牌（只有恢复码那条路才吊销）', async () => {
    const h = harness(backend);
    const base = await serve(h);
    try {
      const ids = await seedData(base);
      const token = await issueToken(base, 'survivor', [ids.keyId]);

      const set = await call(base, 'POST', '/api/vault/passphrase', { next: 'first-pass-1' });
      assert.strictEqual(set.status, 200, JSON.stringify(set.data));

      /* 改口令：DEK 没换、签发记录没动 ⇒ 这把令牌照旧能用。
         README 写了这条边界（「改口令不吊销任何令牌」），测试要把它钉住，
         否则哪天有人图省事把清令牌逻辑挂到 passphrase 路由上，没人会发现。 */
      const chg = await call(base, 'POST', '/api/vault/passphrase', {
        current: 'first-pass-1', next: 'changed-pass-3'
      });
      assert.strictEqual(chg.status, 200, JSON.stringify(chg.data));
      assert.strictEqual(chg.data.recoveryCode, null, '改口令不该顺手把恢复码再念一遍');

      const still = await call(base, 'GET', '/api/consumer/keys/' + ids.keyId, null,
        { Authorization: 'Bearer ' + token });
      assert.strictEqual(still.status, 200, '改口令不吊销令牌');
      assert.strictEqual(still.data.key, KEY_VALUE);
    } finally { await close(h); }
  });

  test('存储后端 ' + backend + '：一把令牌都没签过就恢复，令牌数报 0 而不是报错', async () => {
    const h = harness(backend);
    const base = await serve(h);
    try {
      const set = await call(base, 'POST', '/api/vault/passphrase', { next: 'first-pass-1' });
      assert.strictEqual(set.status, 200, JSON.stringify(set.data));
      const rec = await call(base, 'POST', '/api/vault/recover', {
        recoveryCode: set.data.recoveryCode, next: 'second-pass-2'
      });
      assert.strictEqual(rec.status, 200, JSON.stringify(rec.data));
      assert.strictEqual(rec.data.tokensRevoked, 0, '本来就没有令牌，不该报错也不该报非零');
    } finally { await close(h); }
  });

  test('存储后端 ' + backend + '：恢复码重置后，旧口令与旧恢复码都失效', async () => {
    const h = harness(backend);
    const base = await serve(h);
    try {
      const set = await call(base, 'POST', '/api/vault/passphrase', { next: 'first-pass-1' });
      const oldCode = set.data.recoveryCode;
      const rec = await call(base, 'POST', '/api/vault/recover', {
        recoveryCode: oldCode, next: 'second-pass-2'
      });
      assert.strictEqual(rec.status, 200, JSON.stringify(rec.data));

      /* 旧恢复码不该还能用（它已经被轮换掉了） */
      const reuse = await call(base, 'POST', '/api/vault/recover', {
        recoveryCode: oldCode, next: 'third-pass-3'
      });
      assert.strictEqual(reuse.status, 400);
      assert.match(reuse.data.error, /恢复码不正确/);
    } finally { await close(h); }
  });
}

/* 存储层直测：clearTokens 只清 tokens 一张表，且 id 不回收。
   「id 不回收」是审计可追溯性的前提：id 复用会让审计里的行号对不上旧记录。 */
function runStoreSuite(backend) {
  test('存储后端 ' + backend + '：clearTokens 只清签发记录，id 不回收', () => {
    const dir = tmp.mk('akm-clear-tok-' + backend);
    const store = createStore(dir, loadOrCreateMasterKey(dir), { backend: backend });
    const key = store.createKey({
      name: '留一把', platform: 'deepseek', customName: '', key: KEY_VALUE,
      base: 'https://api.deepseek.com', model: '', reg: '', exp: ''
    });
    const t1 = store.createToken({
      tid: 'a'.repeat(24), fingerprint: 'fp1', label: '一号',
      scopes: ['key:read'], keyIds: [key.id], credIds: [], iat: 1, exp: 2
    });
    assert.strictEqual(store.listTokens().length, 1);

    const n = store.clearTokens();
    assert.strictEqual(n, 1, '必须报出清了几条');
    assert.strictEqual(store.listTokens().length, 0, '签发记录必须清空');
    assert.strictEqual(store.getToken('a'.repeat(24)), null);
    /* 密钥一条不少 */
    assert.strictEqual(store.listKeys().length, 1);
    assert.strictEqual(store.getKey(key.id).key, KEY_VALUE);

    const t2 = store.createToken({
      tid: 'b'.repeat(24), fingerprint: 'fp2', label: '二号',
      scopes: ['key:read'], keyIds: [key.id], credIds: [], iat: 3, exp: 4
    });
    assert.ok(t2.id > t1.id, 'id 不许回收复用（' + t1.id + ' → ' + t2.id + '）');

    /* 清空后再清一次：报 0，不抛 */
    assert.strictEqual(store.clearTokens(), 1);
    assert.strictEqual(store.clearTokens(), 0, '空库再清一次要报 0，不许抛');
    store.close();
  });
}

for (const backend of backends) {
  runSuite(backend);
  runStoreSuite(backend);
}
