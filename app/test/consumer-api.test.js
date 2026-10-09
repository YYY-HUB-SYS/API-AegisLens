/* 消费者令牌 HTTP 层单测：假 storage + 真 vault 会话 + 假限流，绝不打真实数据目录。
   这里盯的是四件容易写错的事：
   1) 锁着的时候报 423 而不是 401——报成 401 会让消费者以为令牌坏了，跑去重新申请；
   2) 门禁排在「资源存不存在」之前——否则作用域不足的令牌能靠 404/403 的差异探测哪些 id 存在；
   3) 令牌串只在 201 那条响应里出现一次，列表里永不复现；
   4) 吊销看的是库里的 tid 清单，不是签名说了算。 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { encryptField } = require('../src/crypto');
const vault = require('../src/vault');
const ct = require('../src/consumer-tokens');
const api = require('../src/consumer-api');

const KEY_PLAIN = 'sk-UPPERCASE-secret-8899';
const BALANCE = { value: 12.5, status: 'ok', updatedAt: '2026-01-01T00:00:00.000Z' };

function fakeThrottle(allow) {
  const st = { checked: [], passed: [], failed: [], allow: allow !== false };
  return {
    state: st,
    check: function (key) {
      st.checked.push(key);
      return st.allow ? { allowed: true } : { allowed: false, retryAfterMs: 1234 };
    },
    passed: function (key) { st.passed.push(key); },
    failed: function (key) { st.failed.push(key); }
  };
}

function fakeStorage(c) {
  const keys = new Map();
  const creds = new Map();
  const tokens = new Map();
  const calls = [];
  const stamp = function () { return new Date(c.now()).toISOString(); };
  let seq = 0;

  keys.set(1, { id: 1, name: '日日新', platform: 'deepseek', key: KEY_PLAIN, balance: BALANCE, endpoints: [{ url: 'https://x/v1' }] });
  keys.set(2, { id: 2, name: '第二把', platform: 'openai', key: 'sk-another-0001', balance: null, endpoints: [] });
  creds.set(7, { id: 7, title: '内网', username: 'admin', url: 'https://intra', passwordEnc: null, secretEnc: null, totpEnc: null, noteEnc: null, lastUsedAt: null });

  return {
    calls: calls,
    keys: keys,
    creds: creds,
    tokens: tokens,
    getKey: function (id) { const r = keys.get(Number(id)); return r ? Object.assign({}, r) : null; },
    getCredential: function (id) {
      const r = creds.get(Number(id));
      return r ? Object.assign({}, r) : null;
    },
    setCredentialLastUsed: function (id) { calls.push(['setCredentialLastUsed', Number(id)]); return null; },
    createToken: function (input) {
      calls.push(['createToken', input]);
      seq += 1;
      const row = {
        id: seq, tid: String(input.tid), fingerprint: input.fingerprint, label: input.label,
        scopes: (input.scopes || []).slice(), keyIds: (input.keyIds || []).slice(), credIds: (input.credIds || []).slice(),
        iat: input.iat, exp: input.exp,
        issuedAt: new Date(input.iat * 1000).toISOString(),
        expiresAt: new Date(input.exp * 1000).toISOString(),
        revokedAt: null, lastUsedAt: null, createdAt: stamp()
      };
      tokens.set(row.tid, row);
      return Object.assign({}, row);
    },
    getToken: function (tid) { const r = tokens.get(String(tid)); return r ? Object.assign({}, r) : null; },
    listTokens: function () {
      return Array.from(tokens.values()).sort(function (a, b) { return b.id - a.id; })
        .map(function (r) { return Object.assign({}, r); });
    },
    revokeToken: function (tid) {
      calls.push(['revokeToken', String(tid)]);
      const r = tokens.get(String(tid));
      if (!r) return null;
      if (r.revokedAt === null) r.revokedAt = stamp();
      return Object.assign({}, r);
    },
    setTokenLastUsed: function (tid) {
      calls.push(['setTokenLastUsed', String(tid)]);
      const r = tokens.get(String(tid));
      if (!r) return null;
      r.lastUsedAt = stamp();
      return Object.assign({}, r);
    }
  };
}

function harness(opts) {
  const o = opts || {};
  const c = { t: 1700000000000 };
  c.now = function () { return c.t; };
  c.advance = function (ms) { c.t += ms; return c.t; };
  const dek = o.dek || crypto.randomBytes(32);
  const session = vault.createVaultSession({ now: c.now });
  const storage = fakeStorage(c);
  const throttle = o.throttle || fakeThrottle();
  const sink = { calls: [] };
  const testsRun = [];

  const ctx = {
    storage: storage,
    vault: session,
    throttle: throttle,
    json: function (res, status, payload) {
      sink.calls.push({ status: status, payload: payload });
      return true;
    },
    readBody: function (req) { return Promise.resolve(req.body === undefined ? {} : req.body); },
    fetchImpl: function () { throw new Error('测试里不该发真实网络请求'); },
    testKeyAt: function (st, key, endpointIndex) {
      testsRun.push({ id: key.id, endpointIndex: endpointIndex });
      return Promise.resolve({ test: { status: 'pass', httpStatus: 200, latencyMs: 7 } });
    },
    bad: function (res, status, message, extra) {
      sink.calls.push({ status: status, payload: Object.assign({ error: message }, extra || {}) });
      return true;
    }
  };

  /* Node 的 http 把请求头键名一律收成小写，假 req 也得照做：
     写成 Authorization 会让被测代码读 headers.authorization 读到 undefined，红得毫无信息量 */
  function lowerHeaders(src) {
    const out = {};
    Object.keys(src || {}).forEach(function (k) { out[k.toLowerCase()] = src[k]; });
    return out;
  }

  function call(method, url, body, headers) {
    const req = {
      method: method,
      url: url,
      headers: lowerHeaders(Object.assign({}, o.headers || {}, headers || {})),
      socket: { remoteAddress: o.ip || '127.0.0.1' },
      body: body
    };
    return Promise.resolve(api.handleConsumerApi(req, { writeHead: function () { return this; }, end: function () { return this; } }, ctx))
      .then(function (handled) {
        const last = sink.calls[sink.calls.length - 1];
        return { handled: handled, status: last && last.status, data: last && last.payload };
      });
  }

  return {
    clock: c, dek: dek, session: session, storage: storage, throttle: throttle, ctx: ctx,
    testsRun: testsRun, sink: sink, call: call,
    unlock: function () { session.attach(dek, 'envelope'); return dek; },
    /* 走真实签发路径拿一把能用的令牌；默认只覆盖 key 1 */
    issue: function (body) {
      const b = Object.assign({ label: 'svc', scopes: ['key:read'], keyIds: [1] }, body || {});
      return call('POST', '/api/consumer/tokens', b);
    },
    bearer: function (token) { return { Authorization: 'Bearer ' + token }; },
    /* 不经接口、直接用同一 DEK 手工签一把：用于造「签名对但库里没有」和「已过期」两种行 */
    handIssue: function (over) {
      const p = Object.assign({ dek: dek, label: 'hand', scopes: ['key:read'], keyIds: [1] }, over || {});
      return ct.issueToken(p);
    },
    auditRows: function () { return session.audit.list(); }
  };
}

/* ── 锁定态 ─────────────────────────────────────────────────────── */

test('锁着的时候管理面与机器面都是 423，不是 401', async () => {
  const h = harness();
  const list = await h.call('GET', '/api/consumer/tokens');
  assert.strictEqual(list.status, 423);
  assert.strictEqual(list.data.tokens, undefined, '锁着时不该带出半套列表');
  const issue = await h.issue();
  assert.strictEqual(issue.status, 423);
  const machine = await h.call('GET', '/api/consumer/keys/1', undefined, { Authorization: 'Bearer whatever' });
  assert.strictEqual(machine.status, 423, '没有 DEK 就无从验签，此时报 401 会骗消费者去重新申请令牌');
  assert.strictEqual(machine.data.reason, 'locked');
});

test('解锁后机器面缺 Authorization 才是 401 missing', async () => {
  const h = harness();
  h.unlock();
  const r = await h.call('GET', '/api/consumer/keys/1');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.reason, 'missing');
});

/* ── 签发与列表 ─────────────────────────────────────────────────── */

test('签发 201 带 token，而列表响应里那把串一个字节都不出现', async () => {
  const h = harness();
  h.unlock();
  const made = await h.issue({ label: 'claude-code', scopes: ['key:read', 'balance:read'], keyIds: [1, 2], ttlSeconds: 3600 });
  assert.strictEqual(made.status, 201);
  assert.ok(made.data.token, '签发响应必须把令牌给出去一次');
  assert.strictEqual(made.data.resourceCount, 2);
  assert.match(made.data.fingerprint, /^[0-9a-f]{8}$/, 'fingerprint 是 8 位 hex');
  assert.ok(made.data.expiresAt > made.data.issuedAt);

  const list = await h.call('GET', '/api/consumer/tokens');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.data.tokens.length, 1);
  assert.strictEqual(list.data.tokens[0].token, undefined);
  assert.ok(JSON.stringify(list.data).indexOf(made.data.token) === -1, '列表绝不能复现令牌串');
  assert.ok(JSON.stringify(h.auditRows()).indexOf(made.data.token) === -1, '审计里也不能有令牌串');
});

test('签发边界：label 超长与空 scopes 都 400，并把可用 scope 带回', async () => {
  const h = harness();
  h.unlock();
  const long = await h.issue({ label: 'x'.repeat(60) });
  assert.strictEqual(long.status, 400);
  assert.strictEqual(long.data.maxLabelLen, ct.MAX_LABEL_LEN);
  assert.deepStrictEqual(long.data.scopes, ct.SCOPES);
  const empty = await h.issue({ scopes: [] });
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(h.storage.tokens.size, 0, '签发失败不该在库里留下行');
  assert.deepStrictEqual(h.throttle.state.failed.length, 2, '两次失败都该记进限流计数');
});

test('签发被限流时 429 带 retryAfterMs，且不碰存储', async () => {
  const h = harness({ throttle: fakeThrottle(false) });
  h.unlock();
  const r = await h.issue();
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.data.retryAfterMs, 1234);
  assert.strictEqual(h.storage.tokens.size, 0);
});

/* ── 机器面：正例与门禁顺序 ─────────────────────────────────────── */

test('作用域命中：给明文、记最近使用、审计里是 fingerprint 不是令牌', async () => {
  const h = harness();
  h.unlock();
  const made = await h.issue();
  const r = await h.call('GET', '/api/consumer/keys/1', undefined, h.bearer(made.data.token));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.key, KEY_PLAIN);
  assert.strictEqual(r.data.name, '日日新');
  assert.ok(h.storage.calls.some(function (c) { return c[0] === 'setTokenLastUsed' && c[1] === made.data.tid; }));
  const rows = h.auditRows();
  const ok = rows.filter(function (x) { return x.kind === 'consumer' && x.status === 'ok'; });
  assert.ok(ok.length >= 1);
  assert.match(ok[ok.length - 1].detail, /fp=[0-9a-f]{8}/);
  assert.ok(JSON.stringify(rows).indexOf(made.data.token) === -1, '审计只记 fp=，不记令牌');
});

test('门禁排在存在性之前：白名单外的 id 是 403，不是 404', async () => {
  const h = harness();
  h.unlock();
  const made = await h.issue({ keyIds: [1] });
  const r = await h.call('GET', '/api/consumer/keys/900', undefined, h.bearer(made.data.token));
  assert.strictEqual(r.status, 403, '让作用域不足的令牌靠 404/403 差异探测 id 是否存在，等于送出库结构');
  assert.strictEqual(r.data.reason, 'scope');
  const miss = await h.call('GET', '/api/consumer/keys/2', undefined, h.bearer(made.data.token));
  assert.strictEqual(miss.status, 403, '库里有的 id 也一样先撞作用域墙');
});

test('scope 与路由要对得上：key:read 不能打 test 与 balance', async () => {
  const h = harness();
  h.unlock();
  const made = await h.issue({ scopes: ['key:read'] });
  const t = await h.call('POST', '/api/consumer/keys/1/test', {}, h.bearer(made.data.token));
  assert.strictEqual(t.status, 403);
  assert.strictEqual(h.testsRun.length, 0, '被拒的请求绝不能已经朝厂商发出去');
  const b = await h.call('GET', '/api/consumer/keys/1/balance', undefined, h.bearer(made.data.token));
  assert.strictEqual(b.status, 403);
});

test('key:test 走的是同一套测试路径，能带 endpointIndex', async () => {
  const h = harness();
  h.unlock();
  const made = await h.issue({ scopes: ['key:test'], keyIds: [1] });
  const r = await h.call('POST', '/api/consumer/keys/1/test', { endpointIndex: 0 }, h.bearer(made.data.token));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.test, { status: 'pass', httpStatus: 200, latencyMs: 7 });
  assert.deepStrictEqual(h.testsRun, [{ id: 1, endpointIndex: 0 }]);
});

test('balance 只给现存快照，不是刷新入口', async () => {
  const h = harness();
  h.unlock();
  const made = await h.issue({ scopes: ['balance:read'], keyIds: [1] });
  const r = await h.call('GET', '/api/consumer/keys/1/balance', undefined, h.bearer(made.data.token));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.balance, BALANCE);
  assert.strictEqual(JSON.stringify(h.storage.calls).indexOf('refresh'), -1);
});

test('cred:read 的明文字段名与 reveal 同源（同一张 ENC_FIELDS）', async () => {
  const h = harness();
  const dek = h.unlock();
  h.storage.creds.set(7, {
    id: 7, title: '内网', username: 'admin', url: 'https://intra',
    passwordEnc: encryptField(dek, 'p@ss'), secretEnc: null,
    totpEnc: encryptField(dek, 'JBSWY3DPEHPK3PXP'), noteEnc: null, lastUsedAt: null
  });
  const made = await h.issue({ scopes: ['cred:read'], credIds: [7] });
  const r = await h.call('GET', '/api/consumer/credentials/7', undefined, h.bearer(made.data.token));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.password, 'p@ss');
  assert.strictEqual(r.data.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.strictEqual(r.data.secret, null, '空列给 null 而不是漏字段——界面按字段名取值，缺键会静默变 undefined');
  const wrong = await h.call('GET', '/api/consumer/credentials/9', undefined, h.bearer(made.data.token));
  assert.strictEqual(wrong.status, 403, '先门禁后存在性');
});

/* ── 失效路径 ───────────────────────────────────────────────────── */

test('篡改签名与乱格式都是 401，reason 各归各', async () => {
  const h = harness();
  h.unlock();
  const made = await h.issue();
  const tampered = made.data.token.slice(0, -3) + 'AAA';
  const r1 = await h.call('GET', '/api/consumer/keys/1', undefined, h.bearer(tampered));
  assert.strictEqual(r1.status, 401);
  assert.strictEqual(r1.data.reason, 'bad-signature');
  const r2 = await h.call('GET', '/api/consumer/keys/1', undefined, h.bearer('nonsense'));
  assert.strictEqual(r2.data.reason, 'malformed');
  assert.strictEqual(r2.status, 401);
});

test('签名对但库里没有（重建过库/换了数据目录）→ 401 unknown', async () => {
  const h = harness();
  h.unlock();
  const hand = h.handIssue();
  const r = await h.call('GET', '/api/consumer/keys/1', undefined, h.bearer(hand.token));
  assert.strictEqual(r.status, 401, '吊销看的是 tid 清单，签名说了算不行');
  assert.strictEqual(r.data.reason, 'unknown');
});

test('过期令牌 401 expired，库里的行也如实标 expired', async () => {
  const h = harness();
  h.unlock();
  const past = Date.now() - 7200 * 1000;
  const hand = h.handIssue({ now: past, ttlSeconds: 60 });
  h.storage.createToken({
    tid: hand.payload.tid, fingerprint: hand.fingerprint, label: 'hand',
    scopes: hand.payload.scopes, keyIds: [1], credIds: [], iat: hand.payload.iat, exp: hand.payload.exp
  });
  const r = await h.call('GET', '/api/consumer/keys/1', undefined, h.bearer(hand.token));
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.reason, 'expired');
  const list = await h.call('GET', '/api/consumer/tokens');
  assert.strictEqual(list.data.tokens[0].expired, true);
  assert.strictEqual(list.data.tokens[0].revoked, false);
});

test('DEK 本体一换（重建库/换数据目录）旧令牌全体验签失败——注意设/改口令不在此列', async () => {
  const h = harness();
  const dek1 = h.unlock();
  const made = await h.issue();
  const before = await h.call('GET', '/api/consumer/keys/1', undefined, h.bearer(made.data.token));
  assert.strictEqual(before.status, 200);
  const session2 = h.session;
  session2.lock();
  session2.attach(Buffer.from(dek1).reverse(), 'envelope');
  const after = await h.call('GET', '/api/consumer/keys/1', undefined, h.bearer(made.data.token));
  assert.strictEqual(after.status, 401);
  assert.strictEqual(after.data.reason, 'bad-signature', 'TEK 由 DEK 派生，换了根就得重新逐把签发');
});

test('吊销之后立刻 401 revoked，且吊销幂等、响应带回新列表', async () => {
  const h = harness();
  h.unlock();
  const made = await h.issue();
  const ok = await h.call('GET', '/api/consumer/keys/1', undefined, h.bearer(made.data.token));
  assert.strictEqual(ok.status, 200);
  const rv = await h.call('POST', '/api/consumer/tokens/' + made.data.tid + '/revoke');
  assert.strictEqual(rv.status, 200);
  assert.strictEqual(rv.data.ok, true);
  assert.ok(rv.data.revokedAt);
  assert.strictEqual(rv.data.tokens.length, 1);
  assert.strictEqual(rv.data.tokens[0].revoked, true);
  const deniedReq = await h.call('GET', '/api/consumer/keys/1', undefined, h.bearer(made.data.token));
  assert.strictEqual(deniedReq.status, 401);
  assert.strictEqual(deniedReq.data.reason, 'revoked');
  const again = await h.call('POST', '/api/consumer/tokens/' + made.data.tid + '/revoke');
  assert.strictEqual(again.data.revokedAt, rv.data.revokedAt, '重复吊销不该改出第二个时间');
  const nope = await h.call('POST', '/api/consumer/tokens/' + 'f'.repeat(24) + '/revoke');
  assert.strictEqual(nope.status, 404);
});

/* ── 分发边界 ───────────────────────────────────────────────────── */

test('未知子路径由本子模块收口成 404，不让 /api/consumer/* 漏回主路由', async () => {
  const h = harness();
  h.unlock();
  const r = await h.call('DELETE', '/api/consumer/tokens');
  assert.strictEqual(r.handled, true, 'handled=false 会被主路由当「不是我的路径」，两条 404 语义就乱了');
  assert.strictEqual(r.status, 404);
  const weird = await h.call('POST', '/api/consumer/tokens/' + 'zz' + '/revoke');
  assert.strictEqual(weird.handled, true);
});

test('非 consumer 路径返回 false，交给主路由', async () => {
  const h = harness();
  h.unlock();
  const r = await h.call('GET', '/api/credentials');
  assert.strictEqual(r.handled, false);
  assert.strictEqual(h.sink.calls.length, 0, '不该抢着应答别人的路径');
});
