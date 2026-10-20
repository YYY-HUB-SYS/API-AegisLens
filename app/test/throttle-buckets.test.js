/* 限流分桶的两处改动：reveal 按密钥 id 分桶、recover 与 unlock 各开各的桶。
   这里只盯「桶与桶之间互不牵连」这一件事——桶本身的机制在 vault.test.js 里另有单测。

   前四条**故意不注入 throttle**：用 app.js 的真实档（reveal 30 次、unlock/recover 5 次、
   锁 5 分钟），这样测到的就是线上那套阈值，而不是测试自己写死的数字。
   最后一条才注入 throttle，因为它要看桶键的字面形状（peek 才能看见键）。

   不碰真实数据目录：密钥库在用户机器上，测试没有资格读写它。 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const { createVaultSession, createThrottle } = require('../src/vault');

const PASS = 'correct-pass-1';
/* 52 个 base32 字符（'A' 是合法字符）：格式对、密钥错 → 解封时 GCM 校验失败 */
const WRONG_CODE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
/* 一个库里不存在的 id：reveal 它必定失败，是「连错」那一侧的好靶子 */
const MISSING_ID = '999999';

function harness(opts) {
  const o = opts || {};
  const dir = tmp.mk('akm-bucket');
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: 'json' });
  const vault = createVaultSession({ idleLockMs: 60000 });
  /* 免密会话照样持有 DEK，和 server.js 的真实接法一致 */
  if (!o.locked) vault.openLegacy(mk);
  const server = createApp({
    storage: storage,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    /* 测试不该碰外网 */
    fetchImpl: function () {
      return Promise.resolve(new Response('{"error":"invalid"}', { status: 401 }));
    },
    vault: vault,
    throttle: o.throttle
  });
  return { dir: dir, mk: mk, storage: storage, vault: vault, server: server };
}

async function serve(h) {
  await new Promise(function (r) { h.server.listen(0, '127.0.0.1', r); });
  return 'http://127.0.0.1:' + h.server.address().port;
}

function close(h) { return new Promise(function (r) { h.server.close(r); }); }

function call(base, method, p, body) {
  return fetch(base + p, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.json().then(function (data) { return { status: res.status, data: data }; });
  });
}

function addKey(base, value, name) {
  return call(base, 'POST', '/api/keys', { platform: 'deepseek', key: value, name: name })
    .then(function (r) {
      assert.strictEqual(r.status, 201, '建密钥应当 201：' + JSON.stringify(r.data));
      return r.data.key;
    });
}

/* 锁 5 分钟：留一点余量，只断言「还在冷却窗口里」，不去卡毫秒 */
function assertLocked5min(r) {
  assert.strictEqual(r.status, 429, '应当被限流：' + JSON.stringify(r.data));
  assert.ok(r.data.retryAfterMs > 290000 && r.data.retryAfterMs <= 300000,
    '冷却窗口应当是 5 分钟，实得 ' + r.data.retryAfterMs + 'ms');
}

test('reveal 按密钥 id 分桶：对不存在的 id 连错 30 次只锁那一个 id，别的密钥照常取用', async () => {
  const h = harness();
  const base = await serve(h);
  try {
    const b = await addKey(base, 'sk-bucket-b-2222', '桶B');

    /* 同一个不存在的 id 连打 30 次 */
    for (let i = 0; i < 30; i++) {
      const r = await call(base, 'POST', '/api/keys/' + MISSING_ID + '/reveal', {});
      assert.strictEqual(r.status, 404, '第 ' + (i + 1) + ' 次错 id 应当 404');
    }
    const locked = await call(base, 'POST', '/api/keys/' + MISSING_ID + '/reveal', {});
    assertLocked5min(locked);

    /* 核心断言：同一个 IP 上别的密钥没有被连累 */
    const ok = await call(base, 'POST', '/api/keys/' + b.id + '/reveal', {});
    assert.strictEqual(ok.status, 200, '别的 id 不该被锁：' + JSON.stringify(ok.data));
    assert.strictEqual(ok.data.key, 'sk-bucket-b-2222');
  } finally { await close(h); }
});

test('reveal 成功只清自己那个 id 的桶：别的 id 的失败计数原样留着', async () => {
  const h = harness();
  const base = await serve(h);
  try {
    const a = await addKey(base, 'sk-bucket-a-1111', '桶A');

    /* 锁库：reveal 在「未解锁」这一档上就消耗失败额度，两个 id 各自起一份计数 */
    h.vault.lock();
    for (let i = 0; i < 5; i++) {
      const ra = await call(base, 'POST', '/api/keys/' + a.id + '/reveal', {});
      assert.strictEqual(ra.status, 423, 'A 第 ' + (i + 1) + ' 次应当 423');
      const rb = await call(base, 'POST', '/api/keys/' + MISSING_ID + '/reveal', {});
      assert.strictEqual(rb.status, 423, '缺失 id 第 ' + (i + 1) + ' 次应当 423');
    }
    /* 解锁：复制一份 DEK 交给会话，免得会话清零时把存储层那把也毁掉 */
    h.vault.attach(Buffer.from(h.mk), 'legacy');

    /* A 取用成功 → 只清 A 那个桶 */
    const ok = await call(base, 'POST', '/api/keys/' + a.id + '/reveal', {});
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
    assert.strictEqual(ok.data.key, 'sk-bucket-a-1111');

    /* 缺失 id 的 5 次失败还在：再错 25 次就满 30 → 锁。
       如果 A 那次成功把别的桶也清了，这里就只会剩 25 次，锁不上 */
    for (let i = 0; i < 25; i++) {
      const rb = await call(base, 'POST', '/api/keys/' + MISSING_ID + '/reveal', {});
      assert.strictEqual(rb.status, 404, '缺失 id 第 ' + (i + 6) + ' 次应当 404');
    }
    const locked = await call(base, 'POST', '/api/keys/' + MISSING_ID + '/reveal', {});
    assertLocked5min(locked);

    /* A 自己的桶被清零了，不该跟着缺失 id 一起锁 */
    const still = await call(base, 'POST', '/api/keys/' + a.id + '/reveal', {});
    assert.strictEqual(still.status, 200, 'A 不该被别的 id 连累：' + JSON.stringify(still.data));
  } finally { await close(h); }
});

test('recover 自己一个桶：连错 5 次只锁 recover，unlock 用对口令照样进得来', async () => {
  const h = harness({ locked: true });
  const base = await serve(h);
  try {
    const set = await call(base, 'POST', '/api/vault/passphrase', { next: PASS });
    assert.strictEqual(set.status, 200, JSON.stringify(set.data));
    const code = set.data.recoveryCode;
    assert.ok(code, '设口令应当发恢复码');

    for (let i = 0; i < 5; i++) {
      const r = await call(base, 'POST', '/api/vault/recover', { recoveryCode: WRONG_CODE, next: 'whatever-1' });
      assert.strictEqual(r.status, 400, '第 ' + (i + 1) + ' 次错恢复码应当 400：' + JSON.stringify(r.data));
      assert.match(r.data.error, /恢复码不正确/);
    }
    const locked = await call(base, 'POST', '/api/vault/recover', { recoveryCode: code, next: 'whatever-1' });
    assertLocked5min(locked);

    /* 核心断言：解锁门没被连带堵上，人还能从正门进去 */
    const un = await call(base, 'POST', '/api/vault/unlock', { passphrase: PASS });
    assert.strictEqual(un.status, 200, 'recover 被锁不该连带锁掉 unlock：' + JSON.stringify(un.data));
    assert.strictEqual(un.data.unlocked, true);
  } finally { await close(h); }
});

test('unlock 自己一个桶：连错 5 次只锁 unlock，recover 不跟着被锁', async () => {
  const h = harness({ locked: true });
  const base = await serve(h);
  try {
    const set = await call(base, 'POST', '/api/vault/passphrase', { next: PASS });
    assert.strictEqual(set.status, 200, JSON.stringify(set.data));
    const code = set.data.recoveryCode;
    assert.ok(code, '设口令应当发恢复码');

    for (let i = 0; i < 5; i++) {
      const r = await call(base, 'POST', '/api/vault/unlock', { passphrase: 'wrong-pass-' + i });
      assert.strictEqual(r.status, 400, '第 ' + (i + 1) + ' 次错口令应当 400：' + JSON.stringify(r.data));
      assert.match(r.data.error, /解锁口令不正确/);
    }
    const locked = await call(base, 'POST', '/api/vault/unlock', { passphrase: PASS });
    assertLocked5min(locked);

    /* 核心断言：恢复这条路还通着 */
    const rec = await call(base, 'POST', '/api/vault/recover', { recoveryCode: code, next: 'second-pass-9' });
    assert.strictEqual(rec.status, 200, 'unlock 被锁不该连带锁掉 recover：' + JSON.stringify(rec.data));
    assert.strictEqual(rec.data.unlocked, true);
    assert.ok(rec.data.recoveryCode && rec.data.recoveryCode !== code, '恢复码应当当场轮换');
  } finally { await close(h); }
});

test('分桶键的形状：reveal:<id>、unlock:<ip>、recover:<ip>，旧的那把 IP 锁不再存在', async () => {
  /* 这一条要 peek 桶内容，所以自己注入一把真 createThrottle（阈值不在这条里较真） */
  const throttle = {
    unlock: createThrottle({ maxFails: 5 }),
    reveal: createThrottle({ maxFails: 30 }),
    passphrase: createThrottle({ maxFails: 5 })
  };
  const h = harness({ locked: true, throttle: throttle });
  const base = await serve(h);
  const ip = '127.0.0.1';
  try {
    const set = await call(base, 'POST', '/api/vault/passphrase', { next: PASS });
    assert.strictEqual(set.status, 200, JSON.stringify(set.data));

    const badRec = await call(base, 'POST', '/api/vault/recover', { recoveryCode: WRONG_CODE, next: 'whatever-1' });
    assert.strictEqual(badRec.status, 400, JSON.stringify(badRec.data));
    const badUn = await call(base, 'POST', '/api/vault/unlock', { passphrase: 'nope' });
    assert.strictEqual(badUn.status, 400, JSON.stringify(badUn.data));

    assert.strictEqual(throttle.unlock.peek('recover:' + ip).fails, 1, 'recover 记在自己的桶里');
    assert.strictEqual(throttle.unlock.peek('unlock:' + ip).fails, 1, 'unlock 记在自己的桶里');

    /* reveal 按 id 分桶 */
    h.vault.attach(Buffer.from(h.mk), 'legacy');
    const a = await addKey(base, 'sk-shape-a-3333', '形状A');
    const nf = await call(base, 'POST', '/api/keys/' + MISSING_ID + '/reveal', {});
    assert.strictEqual(nf.status, 404, JSON.stringify(nf.data));
    assert.strictEqual(throttle.reveal.peek('reveal:' + MISSING_ID).fails, 1, 'reveal 按 id 分桶');
    assert.strictEqual(throttle.reveal.peek('reveal:' + a.id).fails, 0, '别的 id 不该被记上');
    assert.strictEqual(throttle.reveal.peek('reveal:' + ip).fails, 0, '不该再有按 IP 的 reveal 桶');
  } finally { await close(h); }
});
