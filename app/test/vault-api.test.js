const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey, enablePassphrase, vaultMode } = require('../src/crypto');
const { createStore } = require('../src/storage');
const { createVaultSession, createThrottle } = require('../src/vault');

/* 会话与限流都从这里注入，而不是改 createApp 的默认行为：
   现有安装必须继续「双击即用」，免密语义由 app.js 的 openLegacy 负责 */
function harness(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-vapi-'));
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: 'json' });
  const vault = createVaultSession({ idleLockMs: o.idleLockMs === undefined ? 60000 : o.idleLockMs });
  if (!o.locked) vault.openLegacy();
  const throttle = {
    unlock: createThrottle({ maxFails: o.unlockMaxFails == null ? 3 : o.unlockMaxFails }),
    reveal: createThrottle({ maxFails: o.revealMaxFails == null ? 3 : o.revealMaxFails })
  };
  const server = createApp({
    storage: storage,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    vault: vault,
    throttle: throttle
  });
  return { dir: dir, mk: mk, storage: storage, vault: vault, throttle: throttle, server: server };
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
  }).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); });
}

function addKey(base, value, name) {
  return call(base, 'POST', '/api/keys', { platform: 'deepseek', key: value, name: name || 'reveal-target' })
    .then(function (r) { return r.data.key; });
}

test('免密老安装：会话默认开着，passphraseSet=false，不做闲置锁', async () => {
  const h = harness();
  const base = await serve(h);
  try {
    const st = await call(base, 'GET', '/api/vault/status');
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.data.unlocked, true);
    assert.strictEqual(st.data.mode, 'legacy');
    assert.strictEqual(st.data.passphraseSet, false);
    assert.strictEqual(st.data.idleRemainingMs, 0, '免密模式压根没有闲置窗口');
    assert.deepStrictEqual(st.data.recent.map(function (r) { return r.kind; }), ['unlock']);
    assert.strictEqual(st.data.recent[0].detail, 'legacy');
    assert.strictEqual(vaultMode(h.dir), 'legacy');
  } finally { await close(h); }
});

test('reveal 是明文唯一出口：拿到原文、不存在 404、审计里绝不留口令本身', async () => {
  const h = harness();
  const base = await serve(h);
  try {
    const secret = 'sk-reveal-abcdef123456';
    const rec = await addKey(base, secret);
    const ok = await call(base, 'POST', '/api/keys/' + rec.id + '/reveal', {});
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.key, secret);
    assert.strictEqual(ok.data.platform, 'deepseek');

    const miss = await call(base, 'POST', '/api/keys/99999/reveal', {});
    assert.strictEqual(miss.status, 404);

    const st = await call(base, 'GET', '/api/vault/status');
    const kinds = st.data.recent.map(function (r) { return r.kind + ':' + r.status; });
    assert.ok(kinds.indexOf('reveal:ok') >= 0, '成功取用要留痕：' + kinds.join(','));
    assert.ok(kinds.indexOf('reveal:fail') >= 0, '查不到也要留痕：' + kinds.join(','));
    assert.ok(JSON.stringify(st.data.recent).indexOf(secret) === -1, '审计里出现了明文');
    assert.ok(JSON.stringify(st.data).indexOf('sk-reveal') === -1);
  } finally { await close(h); }
});

test('手动锁定后 reveal 得 423；免密下再 unlock 不需要口令即恢复', async () => {
  const h = harness();
  const base = await serve(h);
  try {
    const rec = await addKey(base, 'sk-lockme-7788');
    const lock = await call(base, 'POST', '/api/vault/lock', {});
    assert.strictEqual(lock.status, 200);
    assert.strictEqual(lock.data.wasUnlocked, true);

    const denied = await call(base, 'POST', '/api/keys/' + rec.id + '/reveal', {});
    assert.strictEqual(denied.status, 423);
    assert.match(denied.data.error, /未解锁/);

    const again = await call(base, 'POST', '/api/vault/unlock', {});
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.data.unlocked, true);
    const back = await call(base, 'POST', '/api/keys/' + rec.id + '/reveal', {});
    assert.strictEqual(back.status, 200);
    assert.strictEqual(back.data.key, 'sk-lockme-7788');
  } finally { await close(h); }
});

test('设口令：太短拒 400，成功后 passphraseSet=true 并如实报 restartRequired', async () => {
  const h = harness();
  const base = await serve(h);
  try {
    const short = await call(base, 'POST', '/api/vault/passphrase', { next: 'abc' });
    assert.strictEqual(short.status, 400);
    assert.match(short.data.error, /至少 8 位/);

    const ok = await call(base, 'POST', '/api/vault/passphrase', { next: 'correct-pass-1' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.result, 'set');
    assert.strictEqual(ok.data.restartRequired, true, '开机即锁要重启才生效，不能假装已经安全了');
    assert.strictEqual(vaultMode(h.dir), 'envelope');

    const st = await call(base, 'GET', '/api/vault/status');
    assert.strictEqual(st.data.passphraseSet, true);
    assert.strictEqual(st.data.unlocked, true, '当前会话仍可用，不该把人当场踢出');

    const change = await call(base, 'POST', '/api/vault/passphrase', { current: 'wrong-pass-9', next: 'brand-new-pass' });
    assert.strictEqual(change.status, 403, '旧口令不对要区别于参数错误：' + JSON.stringify(change.data));
    const changed = await call(base, 'POST', '/api/vault/passphrase', { current: 'correct-pass-1', next: 'brand-new-pass' });
    assert.strictEqual(changed.status, 200);
    assert.strictEqual(changed.data.result, 'changed');
  } finally { await close(h); }
});

test('口令模式：未解锁一律 423，错口令连打到上限转 429，正确口令放行后再试不消耗额度', async () => {
  const h = harness({ locked: true });
  enablePassphrase(h.dir, 'correct-pass-1');
  const base = await serve(h);
  try {
    const rec = await addKey(base, 'sk-envelope-0011');
    /* 免密默认没锁，这个测试要的是「锁着」的会话 */
    h.vault.lock();
    h.vault.audit.clear();

    const locked = await call(base, 'POST', '/api/keys/' + rec.id + '/reveal', {});
    assert.strictEqual(locked.status, 423);

    for (let i = 0; i < 3; i++) {
      const bad = await call(base, 'POST', '/api/vault/unlock', { passphrase: 'wrong-pass-' + i });
      assert.strictEqual(bad.status, 400, '第 ' + i + ' 次错口令应报口令不正确：' + JSON.stringify(bad.data));
      assert.match(bad.data.error, /解锁口令不正确/);
    }
    const gated = await call(base, 'POST', '/api/vault/unlock', { passphrase: 'correct-pass-1' });
    assert.strictEqual(gated.status, 429, '超过上限后连正确口令也要先冷却');
    assert.ok(gated.data.retryAfterMs > 0);

    h.throttle.unlock.reset();
    const good = await call(base, 'POST', '/api/vault/unlock', { passphrase: 'correct-pass-1' });
    assert.strictEqual(good.status, 200);
    assert.strictEqual(good.data.mode, 'envelope');

    const ok = await call(base, 'POST', '/api/keys/' + rec.id + '/reveal', {});
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.key, 'sk-envelope-0011');

    const idem = await call(base, 'POST', '/api/vault/unlock', { passphrase: 'totally-wrong' });
    assert.strictEqual(idem.status, 200, '已解锁时的重复 unlock 不该消耗失败额度');
  } finally { await close(h); }
});

test('已解锁会话里 envelope 的闲置窗口有读数，legacy 恒为 0', async () => {
  const h = harness({ locked: true, idleLockMs: 30000 });
  try {
    const base0 = await serve(h);
    const legacySt = await call(base0, 'GET', '/api/vault/status');
    assert.strictEqual(legacySt.data.unlocked, false);
    h.vault.attach(Buffer.alloc(32, 5), 'envelope');
    const st = await call(base0, 'GET', '/api/vault/status');
    assert.strictEqual(st.data.mode, 'envelope');
    assert.ok(st.data.idleRemainingMs > 0 && st.data.idleRemainingMs <= 30000);
    await close(h);
  } catch (e) { await close(h); throw e; }
});
