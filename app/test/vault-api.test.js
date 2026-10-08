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
  /* 免密会话照样持有 DEK，和 server.js 的真实接法一致：
     否则凭证路由的 ctx.vault.key() 会在测试里永远 423，照不出真问题 */
  if (!o.locked) vault.openLegacy(mk);
  const throttle = {
    unlock: createThrottle({ maxFails: o.unlockMaxFails == null ? 3 : o.unlockMaxFails }),
    reveal: createThrottle({ maxFails: o.revealMaxFails == null ? 3 : o.revealMaxFails })
  };
  const server = createApp({
    storage: storage,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    /* 默认给个坏用的 fetch：不传就会走真网络，测试不该碰外网 */
    fetchImpl: o.fetchImpl || function () {
      return Promise.resolve(new Response('{"error":"invalid"}', { status: 401 }));
    },
    vault: vault,
    throttle: throttle,
    idleLockTickMs: o.idleTickMs
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

/* 掩码收口的负例。不写这一组的话，「GET 不再吐明文」这件事只是我说了一句——
   api.test.js 全绿也证明不了：它断言的 data.key 是记录对象，不是 Key 字符串。 */
test('明文出口收口：八处出口一律不回 Key 字符串，reveal 仍能拿到', async () => {
  const h = harness();
  const base = await serve(h);
  const secret = 'sk-mask-check-9182';
  const importedSecret = 'sk-imported-check-77xz';
  try {
    const created = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: secret, name: 'maskme' });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.data.key.key, undefined, '创建响应里不该有 key 字段');
    assert.strictEqual(created.data.key.keyMasked, '9182');
    const id = created.data.key.id;

    const list = await call(base, 'GET', '/api/keys');
    assert.strictEqual(JSON.stringify(list.data).indexOf(secret), -1, '列表泄露明文');

    /* 改端点让余额支持从有变无，专门走 PUT 里那条 saveBalance 早返回分支 */
    const put = await call(base, 'PUT', '/api/keys/' + id, {
      endpoints: [{ url: 'https://api.openai.com/v1', style: 'openai' }]
    });
    assert.strictEqual(JSON.stringify(put.data).indexOf(secret), -1, 'PUT 早返回分支泄露明文');
    assert.strictEqual(put.data.key.keyMasked, '9182');

    const refreshed = await call(base, 'POST', '/api/refresh-balances', {});
    assert.strictEqual(JSON.stringify(refreshed.data).indexOf(secret), -1, '余额刷新返回泄露明文');

    const pool = await call(base, 'POST', '/api/pools', { name: '池一', keyIds: [id] });
    assert.strictEqual(JSON.stringify(pool.data).indexOf(secret), -1, '池子创建返回泄露明文');
    assert.strictEqual(pool.data.pool.keys[0].keyMasked, '9182');
    const pools = await call(base, 'GET', '/api/pools');
    assert.strictEqual(JSON.stringify(pools.data).indexOf(secret), -1, '池子列表泄露明文');

    const tested = await call(base, 'POST', '/api/keys/' + id + '/test', {});
    assert.strictEqual(JSON.stringify(tested.data).indexOf(secret), -1, '测试结果返回泄露明文');

    const imp = await call(base, 'POST', '/api/import', {
      keys: [{ name: 'imp1', platform: 'deepseek', key: importedSecret }]
    });
    assert.strictEqual(imp.status, 200);
    assert.strictEqual(imp.data.imported, 1, '导入计数是数字，明细在 keys 里');
    assert.strictEqual(imp.data.keys[0].key, undefined, '导入明细里不该有 key 字段');
    assert.strictEqual(imp.data.keys[0].keyMasked, '77xz');
    assert.strictEqual(JSON.stringify(imp.data).indexOf(importedSecret), -1, '导入返回泄露明文');

    /* 唯一明文出口仍然给得出明文，否则上面那一堆掩码就是把功能砍了 */
    const revealed = await call(base, 'POST', '/api/keys/' + id + '/reveal', {});
    assert.strictEqual(revealed.status, 200);
    assert.strictEqual(revealed.data.key, secret);
    const revealedImp = await call(base, 'POST', '/api/keys/' + imp.data.keys[0].id + '/reveal', {});
    assert.strictEqual(revealedImp.data.key, importedSecret);
  } finally { await close(h); }
});

/* PUT 不带 key 到底覆不覆盖——前端「没碰过就不提交」全压在这条语义上，
   不能靠读代码说了算，起服务实跑一遍 */
test('PUT 不带 key 时原 Key 保持不变，带 key 才换', async () => {
  const h = harness();
  const base = await serve(h);
  try {
    const created = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-keepme-a1b2', name: 'keep' });
    const id = created.data.key.id;
    const upd = await call(base, 'PUT', '/api/keys/' + id, { name: '改个名' });
    assert.strictEqual(upd.status, 200);
    assert.strictEqual(upd.data.key.name, '改个名');
    const r1 = await call(base, 'POST', '/api/keys/' + id + '/reveal', {});
    assert.strictEqual(r1.data.key, 'sk-keepme-a1b2', '只改名字不该把 Key 抹掉');
    await call(base, 'PUT', '/api/keys/' + id, { key: 'sk-replaced-c3d4' });
    const r2 = await call(base, 'POST', '/api/keys/' + id + '/reveal', {});
    assert.strictEqual(r2.data.key, 'sk-replaced-c3d4');
  } finally { await close(h); }
});

/* 凭证链路的端到端：真 storage + 真会话 + 真派发，假对象测不出接线问题 */
test('凭证端到端：建→列(无密文)→reveal→TOTP→复用检测→删', async () => {
  const h = harness();
  const base = await serve(h);
  try {
    const made = await call(base, 'POST', '/api/credentials', {
      title: '内网门户', username: 'ops', url: 'https://intra.corp',
      password: 'p@ss-12345', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', tags: '公司,内网'
    });
    assert.strictEqual(made.status, 201, JSON.stringify(made.data));
    const cid = made.data.credential.id;
    assert.strictEqual(made.data.credential.passwordEnc, undefined);
    assert.strictEqual(made.data.credential.hasPassword, true);
    assert.strictEqual(made.data.credential.hasTotp, true);

    const list = await call(base, 'GET', '/api/credentials');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.data.count, 1);
    assert.ok(JSON.stringify(list.data).indexOf('enc:v1') === -1, '列表里出现了密文块');
    assert.ok(JSON.stringify(list.data).indexOf('p@ss-12345') === -1, '列表里出现了明文');

    const rev = await call(base, 'POST', '/api/credentials/' + cid + '/reveal', {});
    assert.strictEqual(rev.status, 200);
    assert.strictEqual(rev.data.password, 'p@ss-12345');

    const totp = await call(base, 'GET', '/api/credentials/' + cid + '/totp');
    assert.strictEqual(totp.status, 200);
    assert.match(String(totp.data.code), /^\d{6}$/, 'TOTP 要出 6 位码：' + JSON.stringify(totp.data));
    assert.ok(totp.data.secondsRemaining >= 1 && totp.data.secondsRemaining <= 30);
    assert.strictEqual(JSON.stringify(totp.data).indexOf('GEZDGNBVGY'), -1, 'TOTP 接口回显了 secret');

    await call(base, 'POST', '/api/credentials', { title: '另一个号', username: 'ops', password: 'weak' });
    const health = await call(base, 'GET', '/api/credentials/health');
    assert.strictEqual(health.status, 200);
    assert.ok(JSON.stringify(health.data).indexOf('p@ss-12345') === -1, '健康页回显了口令');
    const dump = JSON.stringify(health.data);
    assert.ok(/ops/.test(dump), '同名复用该被检出：' + dump.slice(0, 200));

    const del = await call(base, 'DELETE', '/api/credentials/' + cid);
    assert.strictEqual(del.status, 200);
    const gone = await call(base, 'GET', '/api/credentials/' + cid);
    assert.strictEqual(gone.status, 404);
  } finally { await close(h); }
});

test('凭证链路在锁定态一律 423，且列表响应里没有半个密文', async () => {
  const h = harness({ locked: true });
  h.vault.openLegacy(h.mk);
  const made = await call(await new Promise(function (r) {
    h.server.listen(0, '127.0.0.1', function () { r('http://127.0.0.1:' + h.server.address().port); });
  }), 'POST', '/api/credentials', { title: 'T', username: 'u', password: 'pw-value-1' });
  const id = made.data.credential.id;
  try {
    h.vault.lock();
    const base = 'http://127.0.0.1:' + h.server.address().port;
    for (const [m, p] of [['GET', '/api/credentials'], ['GET', '/api/credentials/' + id],
      ['POST', '/api/credentials/' + id + '/reveal'], ['GET', '/api/credentials/' + id + '/totp'],
      ['GET', '/api/credentials/health']]) {
      const r = await call(base, m, p, m === 'POST' ? {} : undefined);
      assert.strictEqual(r.status, 423, m + ' ' + p + ' 锁定态要 423，实得 ' + r.status);
      assert.strictEqual(JSON.stringify(r.data).indexOf('enc:v1'), -1);
      assert.strictEqual(JSON.stringify(r.data).indexOf('pw-value-1'), -1);
    }
  } finally { await close(h); }
});

test('设口令同时发恢复码：52 字符分组显示、信封落盘、换口令不再重复发', async () => {
  const h = harness();
  const base = await serve(h);
  try {
    const set = await call(base, 'POST', '/api/vault/passphrase', { next: 'correct-pass-1' });
    assert.strictEqual(set.status, 200);
    assert.strictEqual(typeof set.data.recoveryCode, 'string', '首次设口令必须给出恢复码');
    assert.strictEqual(set.data.recoveryCode.replace(/[\s-]/g, '').length, 52, '256 位 = 52 个 base32 字符');
    assert.strictEqual(set.data.recoveryCode.split(' ')[0].length, 5, '按 5 字符一组分组');
    assert.ok(fs.existsSync(path.join(h.dir, 'recovery.env')), '恢复信封要落盘');
    assert.ok(fs.readFileSync(path.join(h.dir, 'recovery.env'), 'utf8').startsWith('rec:v1:'));
    assert.strictEqual(JSON.stringify(set.data.recoveryCode).indexOf('enc:v1'), -1);

    const chg = await call(base, 'POST', '/api/vault/passphrase', { current: 'correct-pass-1', next: 'brand-new-pass' });
    assert.strictEqual(chg.status, 200);
    assert.strictEqual(chg.data.recoveryCode, null, '换口令不该顺手把恢复码再念一遍');
  } finally { await close(h); }
});

test('忘口令用恢复码重置：旧口令作废、恢复码当场轮换、会话直接接上', async () => {
  const h = harness({ locked: true });
  const base = await serve(h);
  try {
    const set = await call(base, 'POST', '/api/vault/passphrase', { next: 'correct-pass-1' });
    const code = set.data.recoveryCode;
    h.vault.lock();

    const rec = await call(base, 'POST', '/api/vault/recover', { recoveryCode: code, next: 'second-pass-9' });
    assert.strictEqual(rec.status, 200, JSON.stringify(rec.data));
    assert.strictEqual(rec.data.unlocked, true, '恢复成功就该是解锁状态，不能还要求再解一次');
    assert.ok(rec.data.recoveryCode && rec.data.recoveryCode !== code, '恢复码必须轮换，旧码当场失效');

    h.vault.lock();
    const oldPw = await call(base, 'POST', '/api/vault/unlock', { passphrase: 'correct-pass-1' });
    assert.strictEqual(oldPw.status, 400, '旧口令应当已经解不开');
    const newPw = await call(base, 'POST', '/api/vault/unlock', { passphrase: 'second-pass-9' });
    assert.strictEqual(newPw.status, 200);

    h.vault.lock();
    const oldCode = await call(base, 'POST', '/api/vault/recover', { recoveryCode: code, next: 'third-pass-11' });
    assert.strictEqual(oldCode.status, 400);
    assert.match(oldCode.data.error, /恢复码不正确/);
  } finally { await close(h); }
});

test('恢复路径：没有信封给 409，错码打到上限后连正确码也要冷却', async () => {
  const h = harness({ locked: true, unlockMaxFails: 2 });
  const base = await serve(h);
  const wrong = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  try {
    const none = await call(base, 'POST', '/api/vault/recover', { recoveryCode: wrong, next: 'whatever-1' });
    assert.strictEqual(none.status, 409);
    assert.match(none.data.error, /没有恢复信封/);

    const set = await call(base, 'POST', '/api/vault/passphrase', { next: 'correct-pass-1' });
    h.vault.lock();
    assert.strictEqual((await call(base, 'POST', '/api/vault/recover', { recoveryCode: wrong, next: 'whatever-1' })).status, 400);
    assert.strictEqual((await call(base, 'POST', '/api/vault/recover', { recoveryCode: wrong, next: 'whatever-1' })).status, 400);
    const gated = await call(base, 'POST', '/api/vault/recover', { recoveryCode: set.data.recoveryCode, next: 'whatever-1' });
    assert.strictEqual(gated.status, 429, '错码到上限后，正确恢复码也要先冷却');
    assert.ok(gated.data.retryAfterMs > 0);
  } finally { await close(h); }
});

test('闲置自动锁真的会自己锁上（定时器驱动，不靠请求带动）', async () => {
  const h = harness({ locked: true, idleLockMs: 150, idleTickMs: 30 });
  const base = await serve(h);
  try {
    h.vault.attach(require('node:crypto').randomBytes(32), 'envelope');
    assert.strictEqual(h.vault.isUnlocked(), true);
    await new Promise(function (r) { setTimeout(r, 400); });
    assert.strictEqual(h.vault.isUnlocked(), false, '没人操作到点就该锁');
    const denied = await call(base, 'GET', '/api/credentials');
    assert.strictEqual(denied.status, 423);
  } finally { await close(h); }
});
