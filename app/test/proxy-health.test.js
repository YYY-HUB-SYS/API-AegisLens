/* 代理转发与健康快照的联动。
   早先代理**只读**健康快照、从不写 —— 厂商明明拒了这把 key（401），
   下次代理还是先试它：连续失败要攒到 2 次才跳过，而那两次永远攒不出来。
   代理是唯一会持续、大批量踩到坏 key 的路径，它不记账，别的路径记了也没用。

   这一组盯四件事：
   ① 401 ⇒ 那把 key 的连续失败 +1（下次会被跳过）
   ② 转发成功 ⇒ 连续失败清零（它又活了）
   ③ 429 / 5xx ⇒ **不动**健康快照：那是平台侧的限流与故障，
      记成「这把 key 坏了」会让好 key 被误伤跳过
   ④ markKeyHealth 在 json / sqlite 两个后端上逐字一致 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const vault = require('../src/vault');
const ct = require('../src/consumer-tokens');
const proxy = require('../src/proxy-api');

const GOOD_KEY = 'sk-health-GOODKEY-0001';
const BAD_KEY = 'sk-health-BADKEY-0002';
const BUSY_KEY = 'sk-health-BUSYKEY-0003';
const BOOM_KEY = 'sk-health-BOOMKEY-0004';

/* 假厂商：按 key 决定回什么 */
async function startVendor() {
  const server = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const out = function (status, obj) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (key === BAD_KEY) return out(401, { error: { message: 'invalid api key', code: 'invalid_api_key' } });
      if (key === BUSY_KEY) return out(429, { error: { message: 'rate limited', code: 'rate_limit_exceeded' } });
      if (key === BOOM_KEY) return out(500, { error: { message: 'upstream boom', code: 'server_error' } });
      out(200, {
        id: 'chatcmpl-1', object: 'chat.completion', created: 1700000000, model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
      });
    });
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  return {
    base: base,
    close: function () {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return new Promise(function (r) { server.close(r); });
    }
  };
}

async function startApp(backend) {
  const dir = tmp.mk('akm-health');
  const mk = loadOrCreateMasterKey(dir);
  const store = createStore(dir, mk, { backend: backend || 'json' });
  const session = vault.createVaultSession({ idleLockMs: 10 * 60 * 1000 });
  session.attach(Buffer.from(mk), 'envelope');
  const app = createApp({
    storage: store,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test',
    vault: session
  });
  await new Promise(function (r) { app.listen(0, '127.0.0.1', r); });
  return {
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

function seedKey(h, keyValue, base) {
  return h.store.createKey({
    name: 'K' + keyValue.slice(-4), platform: 'openai', customName: '', key: keyValue,
    endpoints: [{ url: base, style: 'openai' }]
  });
}

function issueToken(h, keyIds) {
  const issued = ct.issueToken({
    dek: h.mk, label: 'health-client', scopes: ['proxy:invoke'],
    keyIds: keyIds || [], credIds: [], ttlSeconds: 3600
  });
  const p = issued.payload;
  h.store.createToken({
    tid: p.tid, fingerprint: issued.fingerprint, label: p.label,
    scopes: p.scopes, keyIds: p.keyIds, credIds: p.credIds, iat: p.iat, exp: p.exp
  });
  return issued.token;
}

function call(base, method, p, body, headers) {
  const init = { method: method, headers: Object.assign({}, headers || {}) };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(base + p, init).then(function (res) {
    return res.text().then(function (text) {
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      return { status: res.status, data: data, text: text };
    });
  });
}

const CHAT = { model: 'gpt-4o', messages: [{ role: 'user', content: 'ping' }] };

function failCountOf(h, keyId) {
  const k = h.store.getKey(keyId);
  return k ? Number(k.failCount) || 0 : -1;
}

test('代理：厂商拒了这把 key（401）⇒ 连续失败 +1', async () => {
  const vendor = await startVendor();
  const h = await startApp('json');
  try {
    const bad = seedKey(h, BAD_KEY, vendor.base);
    const good = seedKey(h, GOOD_KEY, vendor.base);
    const tok = issueToken(h, [bad.id, good.id]);
    const auth = { Authorization: 'Bearer ' + tok };

    const r = await call(h.base, 'POST', proxy.CHAT_PATH, CHAT, auth);
    assert.strictEqual(r.status, 200, '应当换到第二把并成功：' + r.text.slice(0, 200));
    assert.strictEqual(failCountOf(h, bad.id), 1, '被拒的那把连续失败应当 +1');
    assert.strictEqual(failCountOf(h, good.id), 0, '成功的那把不该有失败计数');
  } finally {
    await h.close();
    await vendor.close();
  }
});

test('代理：转发成功 ⇒ 连续失败清零（它又活了）', async () => {
  const vendor = await startVendor();
  const h = await startApp('json');
  try {
    const good = seedKey(h, GOOD_KEY, vendor.base);
    /* 前置是**失败过一次**（failCount=1，仍算健康）——
       连续失败两次的 key 压根不会被代理选中（不健康就跳过），
       也就没机会靠一次成功清零：那要等用户手动重测确认它好了。 */
    h.store.markKeyHealth(good.id, false);
    assert.strictEqual(failCountOf(h, good.id), 1, '前置：先攒一次失败');

    const tok = issueToken(h, [good.id]);
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, CHAT, { Authorization: 'Bearer ' + tok });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.strictEqual(failCountOf(h, good.id), 0, '成功一次就该清零');
  } finally {
    await h.close();
    await vendor.close();
  }
});

test('代理：429 / 5xx ⇒ 不动健康快照（平台侧的问题不该记到 key 头上）', async () => {
  const vendor = await startVendor();
  const h = await startApp('json');
  try {
    const busy = seedKey(h, BUSY_KEY, vendor.base);
    const boom = seedKey(h, BOOM_KEY, vendor.base);
    const good = seedKey(h, GOOD_KEY, vendor.base);
    const tok = issueToken(h, [busy.id, boom.id, good.id]);
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, CHAT, { Authorization: 'Bearer ' + tok });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.strictEqual(failCountOf(h, busy.id), 0, '429 是平台限流，不是这把 key 坏了');
    assert.strictEqual(failCountOf(h, boom.id), 0, '5xx 是厂商出毛病，不是这把 key 坏了');
  } finally {
    await h.close();
    await vendor.close();
  }
});

test('代理：连续失败两次的 key 会被跳过（不健康就不该再用）', async () => {
  const vendor = await startVendor();
  const h = await startApp('json');
  try {
    const bad = seedKey(h, BAD_KEY, vendor.base);
    const good = seedKey(h, GOOD_KEY, vendor.base);
    h.store.markKeyHealth(bad.id, false);
    h.store.markKeyHealth(bad.id, false);
    assert.strictEqual(failCountOf(h, bad.id), 2, '前置：连续失败两次');

    const tok = issueToken(h, [bad.id, good.id]);
    const r = await call(h.base, 'POST', proxy.CHAT_PATH, CHAT, { Authorization: 'Bearer ' + tok });
    assert.strictEqual(r.status, 200, '应当跳过不健康的那把、用健康的这把：' + r.text.slice(0, 200));
    /* 那把被跳过的 key 不该再被试一次 —— 试它就得再攒一次失败 */
    assert.strictEqual(failCountOf(h, bad.id), 2, '被跳过的 key 不该再被试（失败次数不变）');
  } finally {
    await h.close();
    await vendor.close();
  }
});

test('markKeyHealth：两个后端行为逐字一致', async () => {
  const results = {};
  for (const backend of ['json', 'sqlite']) {
    const dir = tmp.mk('akm-health-store-' + backend);
    const mk = loadOrCreateMasterKey(dir);
    const store = createStore(dir, mk, { backend: backend });
    const k = store.createKey({
      name: '甲', platform: 'openai', customName: '', key: 'sk-health-store-abcdef',
      endpoints: [{ url: 'https://api.openai.com/v1', style: 'openai' }]
    });
    const steps = [];
    steps.push(store.markKeyHealth(k.id, false).failCount);
    steps.push(store.markKeyHealth(k.id, false).failCount);
    steps.push(store.markKeyHealth(k.id, true).failCount);
    steps.push(store.markKeyHealth(k.id, false).failCount);
    const rec = store.getKey(k.id);
    results[backend] = {
      steps: steps,
      failCount: rec.failCount,
      有时间: !!rec.lastHealthAt
    };
    store.close();
  }
  assert.deepStrictEqual(results.json, results.sqlite, '两个后端的 markKeyHealth 行为不一致');
  assert.deepStrictEqual(results.json.steps, [1, 2, 0, 1], '失败累加、成功清零的序列不对');
});
