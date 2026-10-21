/* 本地网关数据面的端到端测试。

   全部跑真协议：真 HTTP 客户端 → 真 app（app.js）→ 真 store + 真保险库会话
   → 真假厂商服务端（另起一个 http.Server）。**不 mock fetch**：
   代理这一路的全部价值就在「转发得像真的」，把 fetch mock 掉就变成在测自己写的
   假厂商，测不出路径拼错、头没带、body 被改这类问题。

   盯的是这八件事（每一条都对应一个真实的事故形态）：
   1) 令牌门禁：无令牌 / 已吊销 / scope 不够 / 过期，四种都要挡住；
   2) 老令牌兼容：改动前的签发逻辑签出来的令牌，改动后照样验得过、照样能用；
   3) 转发：厂商收到的路径 / 头 / 体都对，客户端拿到的是原样内容；
   4) 故障切换：第一把被拒（401）→ 自动换第二把 → 成功，审计里能看出换过；
   5) 全坏：502，且说清「试了几把、都是什么原因」；
   6) 泄漏：响应体 / 错误消息 / 审计里都搜不到池里那把 key 的明文；
   7) 审计不记内容：prompt 一句都不许进审计；
   8) 请求体超限：413，不是 400，更不是「连接被重置」。 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const tmp = require('./tmp.js');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const vault = require('../src/vault');
const ct = require('../src/consumer-tokens');
const proxy = require('../src/proxy-api');

/* 四把钥匙，四种命运：好使 / 被拒 / 被打满 / 厂商炸了。
   值里各带一段可辨认的片段（GOODKEY / BADKEY / BUSYKEY / BOOMKEY），
   泄漏检查要连片段一起搜——只搜整串明文的话，漏出半截反而查不出来。 */
const GOOD_KEY = 'sk-proxy-GOODKEY-0001';
const BAD_KEY = 'sk-proxy-BADKEY-0002';
const BUSY_KEY = 'sk-proxy-BUSYKEY-0003';
const BOOM_KEY = 'sk-proxy-BOOMKEY-0004';
const HANG_KEY = 'sk-proxy-HANGKEY-0005';

/* 审计里绝不该出现的句子 */
const PROMPT = '请用一句话讲个笑话-SECRET-PROMPT-9182';

/* ---------- 假厂商服务端 ---------- */

function vendorJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/* 起一个真的 http.Server 当厂商。它按 Authorization 头里的 key 决定回什么，
   并且**故意把 key 回显在错误体里**——中转站把密钥回显出来这种事真的发生过，
   泄密防线必须扛得住这种输入，而不是只在「厂商规规矩矩」时才安全。 */
async function startVendor() {
  const requests = [];
  const hanging = [];
  const server = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      const auth = String(req.headers.authorization || '');
      const key = auth.replace(/^Bearer\s+/i, '');
      let body = null;
      try { body = JSON.parse(raw); } catch (e) { body = null; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw, key: key });
      if (key === HANG_KEY) { hanging.push(res); return; }  /* 永不回应：验超时 */
      if (key === BAD_KEY) {
        return vendorJson(res, 401, { error: { message: 'invalid api key: ' + key, code: 'invalid_api_key' } });
      }
      if (key === BUSY_KEY) {
        return vendorJson(res, 429, { error: { message: 'rate limited: ' + key, code: 'rate_limit_exceeded' } });
      }
      if (key === BOOM_KEY) {
        return vendorJson(res, 500, { error: { message: 'upstream boom: ' + key, code: 'server_error' } });
      }
      vendorJson(res, 200, {
        id: 'chatcmpl-vendor-1',
        object: 'chat.completion',
        created: 1700000000,
        model: (body && body.model) || 'unknown-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      });
    });
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  return {
    server: server,
    requests: requests,
    base: 'http://127.0.0.1:' + port + '/v1',
    close: function () {
      hanging.forEach(function (res) { try { res.destroy(); } catch (e) { /* 已经断了 */ } });
      /* fetch 的连接池会把 socket 留着，不主动断干净的话 close() 要等到超时才返回 */
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return new Promise(function (r) { server.close(r); });
    }
  };
}

/* ---------- 真 app（真 store + 真保险库会话） ---------- */

async function startApp(opts) {
  const o = opts || {};
  const dir = tmp.mk('akm-proxy');
  const mk = loadOrCreateMasterKey(dir);
  const store = createStore(dir, mk, { backend: 'json' });
  /* 给会话一份**拷贝**：会话在锁上时会把 DEK 填零，而 store 用的是同一把。
     用拷贝分开两边，测试里就算会话被锁也不至于把 store 的密钥毁掉。 */
  const session = vault.createVaultSession({ idleLockMs: 10 * 60 * 1000 });
  session.attach(Buffer.from(mk), 'envelope');
  const app = createApp({
    storage: store,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    vault: session,
    proxyThrottle: o.proxyThrottle || null,
    proxyTimeoutMs: o.proxyTimeoutMs || null
  });
  await new Promise(function (r) { app.listen(0, '127.0.0.1', r); });
  return {
    app: app,
    store: store,
    session: session,
    mk: mk,
    base: 'http://127.0.0.1:' + app.address().port,
    close: function () {
      if (typeof app.closeAllConnections === 'function') app.closeAllConnections();
      return new Promise(function (r) { app.close(r); });
    }
  };
}

/* 造一把指向假厂商的密钥 */
function seedKey(h, keyValue, base, name) {
  return h.store.createKey({
    name: name || ('K' + keyValue.slice(-4)),
    platform: 'openai',
    customName: '',
    key: keyValue,
    endpoints: [{ url: base, style: 'openai' }]
  });
}

/* 签一把真令牌（走 consumer-tokens 的正式签发路径），并在库里落一条签发记录 */
function issueToken(h, opts) {
  const o = opts || {};
  const issued = ct.issueToken({
    dek: h.mk,
    label: o.label || 'dify',
    scopes: o.scopes || ['proxy:invoke'],
    keyIds: o.keyIds || [],
    credIds: o.credIds || [],
    ttlSeconds: o.ttlSeconds === undefined ? 3600 : o.ttlSeconds,
    now: o.now
  });
  const p = issued.payload;
  const row = h.store.createToken({
    tid: p.tid, fingerprint: issued.fingerprint, label: p.label,
    scopes: p.scopes, keyIds: p.keyIds, credIds: p.credIds, iat: p.iat, exp: p.exp
  });
  return { token: issued.token, tid: row.tid, payload: p, fingerprint: issued.fingerprint };
}

/* 改动前的签发逻辑（等价实现）：payload 七个键、scopes 只有老四项、
   TEK 派生与签名算法一字未改。用它签的令牌在改动之后必须照样验得过——
   这是「老令牌照旧能用」的底线，也是 payload 不能加字段的原因。 */
const LEGACY_SCOPES = ['key:read', 'key:test', 'cred:read', 'balance:read'];

function legacyIssueToken(dek, opts) {
  const o = opts || {};
  const iat = Math.floor((o.now || Date.now()) / 1000);
  const want = o.scopes || LEGACY_SCOPES;
  const payload = {
    tid: crypto.randomBytes(12).toString('hex'),
    label: o.label || 'legacy-client',
    /* 老代码的 scopes 顺序就是 SCOPES 的顺序：老四项的相对顺序不能变，
       变了等于改了老令牌的签名内容。 */
    scopes: LEGACY_SCOPES.filter(function (s) { return want.indexOf(s) !== -1; }),
    keyIds: (o.keyIds || []).slice().sort(function (a, b) { return a - b; }),
    credIds: (o.credIds || []).slice().sort(function (a, b) { return a - b; }),
    exp: iat + (o.ttlSeconds || 3600),
    iat: iat
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const tek = Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), Buffer.from('aegis:consumer-token:v1', 'utf8'), 32));
  const sig = crypto.createHmac('sha256', tek).update('v1:' + body, 'utf8').digest('base64url');
  tek.fill(0);
  return { token: 'v1.' + body + '.' + sig, payload: payload };
}

/* 真 HTTP 调用（不走任何 mock） */
function call(base, method, p, body, headers) {
  const init = { method: method, headers: Object.assign({}, headers || {}) };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(base + p, init).then(function (res) {
    return res.text().then(function (text) {
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      return { status: res.status, text: text, data: data, headers: res.headers };
    });
  });
}

function chatBody(model, extra) {
  return Object.assign({
    model: model || 'gpt-4o',
    messages: [{ role: 'user', content: PROMPT }]
  }, extra || {});
}

function proxyAudit(h) {
  return h.session.audit.list().filter(function (e) { return e.kind === 'proxy'; });
}

/* ---------- 1. 令牌鉴权 ---------- */

test('代理：令牌门禁——无令牌/已吊销/scope 不够/过期', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k = seedKey(h, GOOD_KEY, vendor.base);
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k.id] });
    const auth = { Authorization: 'Bearer ' + tok.token };

    let r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody());
    assert.strictEqual(r.status, 401, '没有令牌必须 401');
    assert.strictEqual(r.data.reason, 'missing');

    h.store.revokeToken(tok.tid);
    r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), auth);
    assert.strictEqual(r.status, 401, '已吊销的令牌必须 401');
    assert.strictEqual(r.data.reason, 'revoked');

    const noScope = issueToken(h, { scopes: ['key:read'], keyIds: [k.id] });
    r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + noScope.token });
    assert.strictEqual(r.status, 403, 'scope 不含 proxy:invoke 必须 403');
    assert.strictEqual(r.data.reason, 'scope');

    /* 过期：签发时刻挪到两小时前，ttl 最短 60 秒 ⇒ exp 早已过去 */
    const expired = issueToken(h, {
      scopes: ['proxy:invoke'], keyIds: [k.id], ttlSeconds: 60, now: Date.now() - 2 * 60 * 60 * 1000
    });
    r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + expired.token });
    assert.strictEqual(r.status, 401, '过期的令牌必须 401');
    assert.strictEqual(r.data.reason, 'expired');

    assert.strictEqual(vendor.requests.length, 0, '没过门禁的请求不许打到厂商');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 2. 老令牌兼容 ---------- */

test('代理：改动前签发的老令牌照样验得过、照样能用', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k = seedKey(h, GOOD_KEY, vendor.base);
    const legacy = legacyIssueToken(h.mk, { scopes: ['key:read'], keyIds: [k.id] });
    /* 老令牌当年也是落过签发记录的（库里只有 tid 与元数据） */
    h.store.createToken({
      tid: legacy.payload.tid, fingerprint: ct.tokenFingerprint(legacy.token, h.mk), label: legacy.payload.label,
      scopes: legacy.payload.scopes, keyIds: legacy.payload.keyIds, credIds: legacy.payload.credIds,
      iat: legacy.payload.iat, exp: legacy.payload.exp
    });

    const v = ct.verifyToken(legacy.token, { dek: h.mk });
    assert.strictEqual(v.ok, true, '老令牌必须还能验签（payload 形状/签名算法不能变）');
    assert.deepStrictEqual(v.payload.keyIds, [k.id]);
    assert.deepStrictEqual(v.payload.scopes, ['key:read']);
    assert.deepStrictEqual(Object.keys(v.payload).sort(), ['credIds', 'exp', 'iat', 'keyIds', 'label', 'scopes', 'tid'],
      'payload 的键集合必须还是原来那七个：加一个字段会让所有老令牌验签失败');

    /* 在代理这一路是 403（scope 不含 proxy:invoke），但**不是**验签失败 */
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + legacy.token });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.data.reason, 'scope');

    /* 在它原来的数据面上照常工作——这才是「老令牌照旧能用」 */
    const r2 = await call(h.base, 'GET', '/api/consumer/keys/' + k.id, null, { Authorization: 'Bearer ' + legacy.token });
    assert.strictEqual(r2.status, 200, '老令牌在原来的数据面上必须照常工作');
    assert.strictEqual(r2.data.key, GOOD_KEY);
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 3. 转发 ---------- */

test('代理：转发到厂商——路径/头/体都对，响应原样透传给客户端', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k = seedKey(h, GOOD_KEY, vendor.base);
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k.id] });
    const body = chatBody('gpt-4o', { temperature: 0.2, max_tokens: 128 });

    const r = await call(h.base, 'POST', proxy.CHAT_PATH, body, { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 200, r.text);

    assert.strictEqual(vendor.requests.length, 1, '厂商那边应该正好收到一个请求');
    const up = vendor.requests[0];
    assert.strictEqual(up.method, 'POST');
    assert.strictEqual(up.url, '/v1/chat/completions', '路径拼错是这类网关最常见的毛病');
    assert.strictEqual(up.headers.authorization, 'Bearer ' + GOOD_KEY, '服务端用池里那把 key 的明文去调厂商');
    assert.strictEqual(up.headers['content-type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(up.body), body, '请求体要原样转发');

    /* 客户端拿到的是厂商的原样内容 */
    assert.strictEqual(r.data.object, 'chat.completion');
    assert.strictEqual(r.data.choices[0].message.content, 'pong');
    assert.strictEqual(r.data.model, 'gpt-4o');
    assert.strictEqual(r.data.usage.total_tokens, 18);
    assert.ok(r.text.indexOf(GOOD_KEY) === -1, '客户端不许看到池里那把 key');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 4. 故障切换 ---------- */

test('代理：第一把被拒（401）→ 自动换备用那把 → 成功，审计里能看出换过', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k1 = seedKey(h, BAD_KEY, vendor.base);   /* 当前生效那把 */
    const k2 = seedKey(h, GOOD_KEY, vendor.base);  /* 备用队列里那把 */
    const pool = h.store.createPool({ name: '网关池', keyIds: [k1.id, k2.id] });
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k1.id, k2.id] });

    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.data.choices[0].message.content, 'pong');

    assert.strictEqual(vendor.requests.length, 2, '应当是两把各试一次');
    assert.strictEqual(vendor.requests[0].key, BAD_KEY, '先试当前生效那把');
    assert.strictEqual(vendor.requests[1].key, GOOD_KEY, '再试备用队列里那把');

    const ok = proxyAudit(h).filter(function (e) { return e.status === 'ok'; });
    assert.strictEqual(ok.length, 1, '应当正好有一条 ok 审计');
    const d = ok[0].detail;
    assert.match(d, /fp=/, '审计要带令牌指纹');
    assert.match(d, new RegExp('pool=' + pool.id), '审计要带池 id');
    assert.match(d, /model=gpt-4o/, '审计要带模型名');
    assert.match(d, /tried=2/, '审计要带试了几把');
    assert.match(d, /switched=1/, '审计要带换了几把 key');
    assert.match(d, /http=200/, '审计要带 HTTP 状态');
    assert.match(d, /usage=prompt:11,completion:7,total:18/, '审计要带 token 用量');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 5. 全坏 ---------- */

test('代理：所有 key 都失败 → 502，并说清试了几把、都是什么原因', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k1 = seedKey(h, BAD_KEY, vendor.base);
    const k2 = seedKey(h, BUSY_KEY, vendor.base);
    const k3 = seedKey(h, BOOM_KEY, vendor.base);
    h.store.createPool({ name: '网关池', keyIds: [k1.id, k2.id, k3.id] });
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k1.id, k2.id, k3.id] });

    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 502, '全坏必须 502，不许装成成功');
    assert.strictEqual(r.data.tried, 3, '要说清试了几把');
    assert.strictEqual(r.data.attempts.length, 3);
    assert.match(r.data.error, /试了 3 把/);
    const reasons = r.data.attempts.map(function (a) { return a.status; });
    assert.deepStrictEqual(reasons, [401, 429, 500], '每把失败的原因都要带出来');
    assert.strictEqual(vendor.requests.length, 3, '三把都要真试过');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 6. 泄漏检查 ---------- */

test('代理：响应体 / 错误消息 / 审计里都搜不到池里那把 key 的明文', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k1 = seedKey(h, BAD_KEY, vendor.base);  /* 厂商会把 key 回显在错误体里 */
    const k2 = seedKey(h, BOOM_KEY, vendor.base);
    h.store.createPool({ name: '网关池', keyIds: [k1.id, k2.id] });
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k1.id, k2.id] });

    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 502);

    assert.ok(r.text.indexOf(BAD_KEY) === -1, '响应体里不能出现 key 明文');
    assert.ok(r.text.indexOf(BOOM_KEY) === -1, '响应体里不能出现 key 明文');
    assert.ok(r.text.indexOf('BADKEY') === -1, '连 key 的片段也不能出现');
    assert.ok(r.text.indexOf('BOOMKEY') === -1, '连 key 的片段也不能出现');

    const auditJson = JSON.stringify(h.session.audit.list());
    assert.ok(auditJson.indexOf(BAD_KEY) === -1, '审计里不能出现 key 明文');
    assert.ok(auditJson.indexOf('BADKEY') === -1, '连 key 的片段也不能出现');
    assert.ok(auditJson.indexOf('BOOMKEY') === -1, '连 key 的片段也不能出现');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 7. 审计不记内容 ---------- */

test('代理：审计里不记 prompt / messages / 请求体', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k = seedKey(h, GOOD_KEY, vendor.base);
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k.id] });
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 200);

    const auditJson = JSON.stringify(h.session.audit.list());
    assert.ok(auditJson.indexOf(PROMPT) === -1, '审计里不能出现 prompt 内容');
    assert.ok(auditJson.indexOf('messages') === -1, '审计里不能出现请求体字段');
    assert.ok(auditJson.indexOf('gpt-4o') !== -1, '审计里要出现模型名（那是元数据，不是内容）');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 8. 请求体超限 ---------- */

test('代理：请求体超限 → 413', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k = seedKey(h, GOOD_KEY, vendor.base);
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k.id] });
    const huge = 'x'.repeat(proxy.MAX_BODY_BYTES + 4096);
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, {
      model: 'gpt-4o', messages: [{ role: 'user', content: huge }]
    }, { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 413, '超限要报 413，不是 400');
    assert.strictEqual(r.data.maxBodyBytes, proxy.MAX_BODY_BYTES);
    assert.strictEqual(vendor.requests.length, 0, '超限的请求不该打到厂商');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 选 key：健康快照与回退口径 ---------- */

test('代理：连续失败 ≥2 次的 key 被跳过，没测过的算健康', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k1 = seedKey(h, BAD_KEY, vendor.base);
    const k2 = seedKey(h, GOOD_KEY, vendor.base);
    h.store.createPool({ name: '网关池', keyIds: [k1.id, k2.id] });
    /* k1 连挂两次 ⇒ 健康快照判它不健康（failCount>=2）；k2 没测过（failCount=0）⇒ 算健康 */
    h.store.saveTest(k1.id, { status: 'fail', msg: 'x' });
    h.store.saveTest(k1.id, { status: 'fail', msg: 'x' });
    assert.strictEqual(h.store.getKey(k1.id).failCount, 2);

    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k1.id, k2.id] });
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(vendor.requests.length, 1, '不健康的 key 不该被试');
    assert.strictEqual(vendor.requests[0].key, GOOD_KEY, '没测过的 key 算健康，该被用上');
  } finally {
    await h.close();
    await vendor.close();
  }
});

test('代理：令牌没列 keyId 时回退到池里当前生效的那把', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k1 = seedKey(h, GOOD_KEY, vendor.base);
    const k2 = seedKey(h, BUSY_KEY, vendor.base);
    h.store.createPool({ name: '网关池', keyIds: [k1.id, k2.id] });
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [] });

    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(vendor.requests.length, 1);
    assert.strictEqual(vendor.requests[0].key, GOOD_KEY, '没列 keyId 时用池里当前生效那把');
  } finally {
    await h.close();
    await vendor.close();
  }
});

test('代理：令牌授权范围外的 key 用不上（池里有也不能碰）', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k1 = seedKey(h, BUSY_KEY, vendor.base);   /* 在池里，但令牌没授权 */
    const k2 = seedKey(h, GOOD_KEY, vendor.base);   /* 令牌授权的那把 */
    h.store.createPool({ name: '网关池', keyIds: [k1.id, k2.id] });
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k2.id] });
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(vendor.requests.length, 1);
    assert.strictEqual(vendor.requests[0].key, GOOD_KEY, '没授权的那把一把都不许碰');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 模型列表 ---------- */

test('代理：GET /api/proxy/v1/models 列出授权 key 支持的模型', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k1 = seedKey(h, GOOD_KEY, vendor.base);
    const k2 = seedKey(h, BUSY_KEY, vendor.base);
    h.store.createPool({ name: '网关池', keyIds: [k1.id, k2.id] });
    h.store.replaceModels(k1.id, [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }]);
    h.store.replaceModels(k2.id, [{ id: 'gpt-4o' }, { id: 'other-model' }]);

    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k1.id] });
    const r = await call(h.base, 'GET', proxy.MODELS_PATH, null, { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.data.object, 'list');
    assert.deepStrictEqual(r.data.data.map(function (m) { return m.id; }), ['gpt-4o', 'gpt-4o-mini'],
      '只列令牌授权的那几把 key 支持的模型');

    const r2 = await call(h.base, 'GET', proxy.MODELS_PATH, null);
    assert.strictEqual(r2.status, 401, '模型列表也要令牌');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 限流 / 流式 / 超时 ---------- */

test('代理：超过限流额度 → 429', async () => {
  const vendor = await startVendor();
  const throttle = proxy.createProxyThrottle({ max: 2, windowMs: 60 * 1000 });
  const h = await startApp({ proxyThrottle: throttle });
  try {
    const k = seedKey(h, GOOD_KEY, vendor.base);
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k.id] });
    const auth = { Authorization: 'Bearer ' + tok.token };
    assert.strictEqual((await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), auth)).status, 200);
    assert.strictEqual((await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), auth)).status, 200);
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), auth);
    assert.strictEqual(r.status, 429, '超额度要 429');
    assert.ok(Number(r.data.retryAfterMs) > 0);
    assert.strictEqual(vendor.requests.length, 2, '被限流的请求不该再打厂商');
  } finally {
    await h.close();
    await vendor.close();
  }
});

test('代理：stream=true 明说本版本不支持（而不是静默回非流式）', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k = seedKey(h, GOOD_KEY, vendor.base);
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k.id] });
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody('gpt-4o', { stream: true }),
      { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /流式/, '必须说清本版本暂不支持流式');
    assert.strictEqual(r.data.streamSupported, false);
    assert.strictEqual(vendor.requests.length, 0);
  } finally {
    await h.close();
    await vendor.close();
  }
});

test('代理：厂商不响应时按超时收尾，不挂死', async () => {
  const vendor = await startVendor();
  const h = await startApp({ proxyTimeoutMs: 300 });
  try {
    const k = seedKey(h, HANG_KEY, vendor.base);
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k.id] });
    const t0 = Date.now();
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + tok.token });
    const spent = Date.now() - t0;
    assert.strictEqual(r.status, 502, '上游挂住时要收尾，不能一直等');
    assert.match(r.data.attempts[0].reason, /超时/);
    assert.ok(spent < 10000, '超时档位必须真的生效（本次耗时 ' + spent + ' ms）');
  } finally {
    await h.close();
    await vendor.close();
  }
});

/* ---------- 形状转换（Anthropic 上游 → OpenAI 下游） ---------- */

test('代理：Anthropic 兼容端点能接 OpenAI 格式的请求，回 OpenAI 形状', async () => {
  const anthropic = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw);
      assert.strictEqual(req.url, '/v1/messages');
      assert.strictEqual(req.headers['x-api-key'], GOOD_KEY, 'Anthropic 系用 x-api-key');
      assert.ok(body.max_tokens > 0, 'Anthropic 的 max_tokens 是必填项');
      assert.strictEqual(body.messages[0].content, PROMPT);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', model: body.model, stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'pong' }],
        usage: { input_tokens: 11, output_tokens: 7 }
      }));
    });
  });
  await new Promise(function (r) { anthropic.listen(0, '127.0.0.1', r); });
  /* Anthropic 系的 Base URL **不带**版本前缀（平台目录里就是 https://api.anthropic.com），
     /v1/messages 由代理按同一口径拼上去——与 adapters 的 chatProbePath 一致。 */
  const base = 'http://127.0.0.1:' + anthropic.address().port;
  const h = await startApp();
  try {
    const k = h.store.createKey({
      name: 'Kanth', platform: 'anthropic', customName: '', key: GOOD_KEY,
      endpoints: [{ url: base, style: 'anthropic' }]
    });
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k.id] });
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody('claude-x'), { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.data.object, 'chat.completion');
    assert.strictEqual(r.data.choices[0].message.content, 'pong');
    assert.strictEqual(r.data.usage.prompt_tokens, 11);
    assert.strictEqual(r.data.usage.completion_tokens, 7);
  } finally {
    await h.close();
    if (typeof anthropic.closeAllConnections === 'function') anthropic.closeAllConnections();
    await new Promise(function (r) { anthropic.close(r); });
  }
});

/* ---------- 边角：没有可用密钥 / 跨域写 ---------- */

test('代理：授权范围里一把可用密钥都没有 → 502 并说清原因', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    /* 令牌授权的是一把库里已经不存在的 key（白名单没跟上库里的删除） */
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [9999] });
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), { Authorization: 'Bearer ' + tok.token });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.data.tried, 0, '一把都没试过就不能说试了几把');
    assert.match(r.data.error, /没有可用的密钥/);
    assert.strictEqual(vendor.requests.length, 0);
  } finally {
    await h.close();
    await vendor.close();
  }
});

test('代理：跨域写请求被拒（浏览器里的网页不许朝本机打消耗额度的请求）', async () => {
  const vendor = await startVendor();
  const h = await startApp();
  try {
    const k = seedKey(h, GOOD_KEY, vendor.base);
    const tok = issueToken(h, { scopes: ['proxy:invoke'], keyIds: [k.id] });
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, chatBody(), {
      Authorization: 'Bearer ' + tok.token,
      Origin: 'http://evil.example.com'
    });
    assert.strictEqual(r.status, 403);
    assert.match(r.data.error, /跨域/);
    assert.strictEqual(vendor.requests.length, 0);
  } finally {
    await h.close();
    await vendor.close();
  }
});
