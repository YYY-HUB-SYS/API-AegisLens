/* 凭证路由子模块单测：假 storage + 真 vault（假时钟）+ 假 throttle。
   绝不 require ../src/storage.js，也不碰真实数据目录——密钥库在用户机器上，测试没有资格读写它。 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { encryptField } = require('../src/crypto');
const vault = require('../src/vault');
const totp = require('../src/totp');
const api = require('../src/credentials-api');

const CLOCK_START = 1700000000000;

function clock(start) {
  const c = { t: start === undefined ? CLOCK_START : start, now: function () { return c.t; } };
  c.advance = function (ms) { c.t += ms; return c.t; };
  return c;
}

/* ── 假存储：严格照 createCredential/getCredential/… 的出参形状（camelCase、密文列缺省 null） */
function fakeStorage(c) {
  const rows = new Map();
  let seq = 0;
  const calls = [];
  const stamp = function () { return new Date(c.now()).toISOString(); };

  function shape(input) {
    const b = input || {};
    return {
      id: b.id,
      title: b.title === undefined ? '' : b.title,
      username: b.username === undefined ? '' : b.username,
      url: b.url === undefined ? '' : b.url,
      folder: b.folder === undefined ? '' : b.folder,
      tags: b.tags === undefined ? '' : b.tags,
      passwordEnc: b.passwordEnc === undefined ? null : b.passwordEnc,
      secretEnc: b.secretEnc === undefined ? null : b.secretEnc,
      totpEnc: b.totpEnc === undefined ? null : b.totpEnc,
      noteEnc: b.noteEnc === undefined ? null : b.noteEnc,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      lastUsedAt: b.lastUsedAt === undefined ? null : b.lastUsedAt
    };
  }
  function put(r) { rows.set(r.id, r); return Object.assign({}, r); }

  return {
    rows: rows,
    calls: calls,
    createCredential: function (input) {
      calls.push(['createCredential', input]);
      seq += 1;
      const at = stamp();
      return put(shape(Object.assign({}, input, { id: seq, createdAt: at, updatedAt: at })));
    },
    getCredential: function (id) {
      const r = rows.get(Number(id));
      return r ? Object.assign({}, r) : null;
    },
    listCredentials: function () {
      return Array.from(rows.values()).sort(function (a, b) { return a.id - b.id; })
        .map(function (r) { return Object.assign({}, r); });
    },
    updateCredential: function (id, patch) {
      calls.push(['updateCredential', Number(id), patch]);
      const r = rows.get(Number(id));
      if (!r) return null;
      c.advance(1);
      /* 换新对象而不是原地改：测试里会先抓一份快照再比对 updated_at，原地改会把快照一起改掉 */
      return put(Object.assign({}, r, patch, { updatedAt: stamp() }));
    },
    deleteCredential: function (id) {
      calls.push(['deleteCredential', Number(id)]);
      return rows.delete(Number(id));
    },
    setCredentialLastUsed: function (id) {
      calls.push(['setCredentialLastUsed', Number(id)]);
      const r = rows.get(Number(id));
      if (!r) return null;
      c.advance(1);
      r.lastUsedAt = stamp();
      return put(r);
    },
    credentialUsernameCounts: function () {
      const map = new Map();
      Array.from(rows.values()).forEach(function (r) {
        const u = String(r.username || '');
        if (u === '') return;
        map.set(u, (map.get(u) || 0) + 1);
      });
      return Array.from(map.entries())
        .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; })
        .map(function (e) { return { username: e[0], count: e[1] }; });
    }
  };
}

/* ── 假限流：键与调用序列都要能被断言，超限行为由测试直接摆出来。
   记录用的数组名必须和被记录的函数名错开，否则 push 到的是函数本身。 */
function fakeThrottle() {
  const t = { checked: [], failedKeys: [], passedKeys: [], blockedMs: 0 };
  t.check = function (key) {
    t.checked.push(key);
    if (t.blockedMs > 0) return { allowed: false, retryAfterMs: t.blockedMs };
    return { allowed: true, retryAfterMs: 0 };
  };
  t.failed = function (key) { t.failedKeys.push(key); return { locked: false, failsRemaining: 4 }; };
  t.passed = function (key) { t.passedKeys.push(key); };
  t.blockFor = function (ms) { t.blockedMs = ms; };
  return t;
}

function harness(opts) {
  const o = opts || {};
  const c = clock(o.start);
  const dek = o.dek || crypto.randomBytes(32);
  const session = vault.createVaultSession({ now: c.now, idleLockMs: o.idleLockMs });
  const storage = fakeStorage(c);
  const throttle = o.throttle || fakeThrottle();
  const sink = { calls: [] };

  const ctx = {
    storage: storage,
    vault: session,
    throttle: throttle,
    now: c.now,
    json: function (res, status, payload, headers) {
      sink.calls.push({ status: status, payload: payload, headers: headers || null });
      return true;
    },
    readBody: function (req) { return Promise.resolve(req.body === undefined ? null : req.body); },
    bad: function (res, status, message, extra) {
      sink.calls.push({ status: status, payload: Object.assign({ error: message }, extra || {}), headers: null });
      return true;
    }
  };

  function req(method, url, body) {
    return {
      method: method,
      url: url,
      headers: o.headers || {},
      socket: { remoteAddress: o.ip || '127.0.0.1' },
      body: body
    };
  }

  return {
    clock: c, dek: dek, session: session, storage: storage, throttle: throttle, ctx: ctx, sink: sink,
    unlock: function () { session.attach(dek, 'envelope'); return dek; },
    seed: function (fields) { return storage.createCredential(fields); },
    /* 直接灌密文进假存储，模拟「库里已经有货」而不走 POST，免得测试依赖创建路径 */
    seedEncrypted: function (plain, extra) {
      const enc = {};
      Object.keys(plain).forEach(function (k) {
        const column = { password: 'passwordEnc', secret: 'secretEnc', totpSecret: 'totpEnc', note: 'noteEnc' }[k];
        enc[column] = plain[k] === null ? null : encryptField(dek, plain[k]);
      });
      return storage.createCredential(Object.assign({ title: 'T', username: 'u' }, extra || {}, enc));
    },
    call: function (method, url, body) {
      const r = req(method, url, body);
      return Promise.resolve(api.handleCredentialsApi(r, { writeHead: function () { return this; }, end: function () { return this; } }, ctx))
        .then(function (handled) {
          const last = sink.calls[sink.calls.length - 1];
          return { handled: handled, status: last && last.status, data: last && last.payload, headers: last && last.headers };
        });
    },
    dump: function () { return JSON.stringify(sink.calls.map(function (k) { return k.payload; })); },
    auditRows: function () { return session.audit.list(); }
  };
}

const RAW_TOTP = 'JBSWY3DPEHPK3PXP';
const OTP_URI = 'otpauth://totp/GitHub:alice@example.com?secret=' + RAW_TOTP + '&issuer=GitHub&period=60&digits=8&algorithm=SHA256';

/* ── 未解锁 ───────────────────────────────────────────────────────── */

test('未解锁：所有凭证路由 423，且响应里一个 enc:v1 字节都不出现', async () => {
  const h = harness();
  const rec = h.seedEncrypted({ password: 'hunter2', note: '内网备注', totpSecret: RAW_TOTP }, { title: '锁着的库' });
  const dumpOfStored = JSON.stringify(Array.from(h.storage.rows.values()));
  assert.ok(dumpOfStored.indexOf('enc:v1') === 0 || dumpOfStored.indexOf('enc:v1') > -1, '假存储里确实有密文');

  const routes = [
    ['GET', '/api/credentials'],
    ['GET', '/api/credentials/' + rec.id],
    ['GET', '/api/credentials/health'],
    ['GET', '/api/credentials/' + rec.id + '/totp'],
    ['DELETE', '/api/credentials/' + rec.id]
  ];
  for (const [method, url] of routes) {
    const r = await h.call(method, url);
    assert.strictEqual(r.status, 423, method + ' ' + url);
    assert.match(r.data.error, /未解锁/);
    assert.strictEqual(JSON.stringify(r.data).indexOf('enc:v1'), -1, method + ' ' + url + ' 漏了密文');
    assert.strictEqual(JSON.stringify(r.data).indexOf('hunter2'), -1);
  }

  const post = await h.call('POST', '/api/credentials', { title: '新条目', password: 'hunter2' });
  assert.strictEqual(post.status, 423);
  assert.strictEqual(JSON.stringify(post.data).indexOf('enc:v1'), -1);

  const put = await h.call('PUT', '/api/credentials/' + rec.id, { password: 'hunter2' });
  assert.strictEqual(put.status, 423);

  const reveal = await h.call('POST', '/api/credentials/' + rec.id + '/reveal', {});
  assert.strictEqual(reveal.status, 423);
  assert.strictEqual(JSON.stringify(reveal.data).indexOf('enc:v1'), -1);
  assert.strictEqual(JSON.stringify(reveal.data).indexOf('hunter2'), -1);
  assert.strictEqual(h.storage.rows.get(rec.id).lastUsedAt, null, '423 不该顺手记一次「用过」');

  const rows = h.auditRows().filter(function (r) { return r.kind === 'reveal'; });
  assert.deepStrictEqual(rows.map(function (r) { return [r.target, r.status, r.detail]; }),
    [[String(rec.id), 'denied', 'locked']], '未解锁的 reveal 必须留一条 denied 审计');
});

/* ── 列表 / 单条：掩码视图 ─────────────────────────────────────────── */

test('GET 列表：解锁后只给掩码视图，密文列换成 has* 布尔', async () => {
  const h = harness();
  h.unlock();
  const rec = h.seedEncrypted({ password: 'hunter2', totpSecret: RAW_TOTP }, { title: '内网门户', tags: 'a,b' });
  h.seed({ title: '空条目' });

  const r = await h.call('GET', '/api/credentials');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.count, 2);
  assert.strictEqual(r.data.credentials.length, 2);
  const first = r.data.credentials[0];
  vault.CREDENTIAL_SECRET_FIELDS.forEach(function (f) {
    assert.strictEqual(first[f], undefined, f + ' 不该出现在响应里');
  });
  assert.deepStrictEqual([first.hasPassword, first.hasSecret, first.hasTotp, first.hasNote], [true, false, true, false]);
  assert.strictEqual(first.title, '内网门户');
  assert.strictEqual(first.tags, 'a,b');
  assert.strictEqual(JSON.stringify(r.data).indexOf('enc:v1'), -1);
  assert.strictEqual(JSON.stringify(r.data).indexOf('hunter2'), -1);
  assert.strictEqual(h.storage.rows.get(rec.id).passwordEnc.slice(0, 7), 'enc:v1:', '库里仍是密文');

  const one = await h.call('GET', '/api/credentials/' + rec.id);
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.data.credential.hasPassword, true);
  assert.strictEqual(one.data.credential.passwordEnc, undefined);

  const missing = await h.call('GET', '/api/credentials/9999');
  assert.strictEqual(missing.status, 404);
  assert.match(missing.data.error, /不存在/);
});

/* ── 创建：字段校验与上限 ─────────────────────────────────────────── */

test('POST：必填 title、可选字段加密入库、长度与数量上限', async () => {
  const h = harness();
  h.unlock();

  const noTitle = await h.call('POST', '/api/credentials', { username: 'u' });
  assert.strictEqual(noTitle.status, 400);
  assert.match(noTitle.data.error, /title/);

  const blank = await h.call('POST', '/api/credentials', { title: '   ' });
  assert.strictEqual(blank.status, 400);

  const tooLongPw = await h.call('POST', '/api/credentials', { title: 'x', password: 'a'.repeat(api.MAX_PASSWORD_LEN + 1) });
  assert.strictEqual(tooLongPw.status, 400);
  assert.match(tooLongPw.data.error, new RegExp(String(api.MAX_PASSWORD_LEN)));

  const tooLongNote = await h.call('POST', '/api/credentials', { title: 'x', note: 'n'.repeat(api.MAX_NOTE_LEN + 1) });
  assert.strictEqual(tooLongNote.status, 400);

  const tooManyTags = await h.call('POST', '/api/credentials', {
    title: 'x', tags: Array.from({ length: api.MAX_TAGS + 1 }, function (_, i) { return 't' + i; })
  });
  assert.strictEqual(tooManyTags.status, 400);
  assert.match(tooManyTags.data.error, new RegExp('最多 ' + api.MAX_TAGS));

  const longTag = await h.call('POST', '/api/credentials', { title: 'x', tags: ['标签'.repeat(api.MAX_TAG_LEN + 1)] });
  assert.strictEqual(longTag.status, 400);

  const badTotp = await h.call('POST', '/api/credentials', { title: 'x', totpSecret: 'JBSW0189' });
  assert.strictEqual(badTotp.status, 400, 'base32 字符表没有 0/1/8/9，必须在写入库之前就拒掉');
  assert.strictEqual(h.storage.rows.size, 0, '校验失败的 POST 不该留下任何行');

  const ok = await h.call('POST', '/api/credentials', {
    title: 'GitHub', username: 'moe@example.com', url: 'https://github.com',
    folder: '公司', tags: ['朋友', '家人', '朋友'], password: 'hunter2',
    note: '备用邮箱', totpSecret: RAW_TOTP, secret: 'whsec_1'
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.data));
  assert.strictEqual(ok.data.credential.passwordEnc, undefined);
  assert.strictEqual(ok.data.credential.hasPassword, true);
  assert.strictEqual(ok.data.credential.hasTotp, true);
  assert.strictEqual(ok.data.credential.hasNote, true);
  assert.strictEqual(ok.data.credential.hasSecret, true);
  assert.strictEqual(JSON.stringify(ok.data).indexOf('hunter2'), -1);

  const row = h.storage.rows.get(ok.data.credential.id);
  assert.strictEqual(row.passwordEnc.slice(0, 7), 'enc:v1:');
  assert.strictEqual(row.noteEnc.slice(0, 7), 'enc:v1:');
  assert.strictEqual(row.totpEnc.slice(0, 7), 'enc:v1:');
  assert.strictEqual(row.secretEnc.slice(0, 7), 'enc:v1:');
  assert.strictEqual(row.username, 'moe@example.com', '用户名是明文列，原样存');
  assert.strictEqual(row.tags, '朋友,家人', '数组标签去重后按逗号拼回一列文本');
  assert.strictEqual(row.createdAt, row.updatedAt);

  const createAudit = h.auditRows().filter(function (r) { return r.kind === 'create'; });
  assert.strictEqual(createAudit.length, 1);
  assert.strictEqual(createAudit[0].status, 'ok');
  assert.strictEqual(createAudit[0].detail, '口令+私钥+TOTP+备注');
  assert.strictEqual(JSON.stringify(h.auditRows()).indexOf('hunter2'), -1, '审计里不许有明文');

  const bare = await h.call('POST', '/api/credentials', { title: '只有标题' });
  assert.strictEqual(bare.status, 201);
  const bareRow = h.storage.rows.get(bare.data.credential.id);
  assert.deepStrictEqual([bareRow.passwordEnc, bareRow.noteEnc, bareRow.totpEnc, bareRow.secretEnc],
    [null, null, null, null], '没录的密文列存 null，不是空串');
});

test('POST：不认识的字段与非法 JSON 一律 400，不透传进存储', async () => {
  const h = harness();
  h.unlock();
  const r = await h.call('POST', '/api/credentials', { title: 'x', admin: true });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /不认识的字段/);
  assert.strictEqual(h.storage.rows.size, 0);
  const before = h.sink.calls.length;
  await h.call('POST', '/api/credentials', 'not-an-object');
  assert.strictEqual(h.sink.calls.length, before + 1);
  assert.strictEqual(h.sink.calls[before].status, 400, '请求体不是 JSON 对象也要 400');
});

/* ── 更新 ─────────────────────────────────────────────────────────── */

test('PUT：只改传入字段，空串清除，改口令必须 bump updated_at', async () => {
  const h = harness();
  h.unlock();
  const rec = h.seedEncrypted({ password: 'hunter2', note: '备注', totpSecret: RAW_TOTP, secret: 'whsec_keep' },
    { title: '原名', username: 'u1', url: 'https://a', folder: 'F', tags: 'x' });
  const before = h.storage.rows.get(rec.id);
  const beforeUpdatedAt = before.updatedAt;
  const beforeEnc = before.passwordEnc;

  const rename = await h.call('PUT', '/api/credentials/' + rec.id, { title: '改名了' });
  assert.strictEqual(rename.status, 200);
  const patch1 = h.storage.calls.filter(function (c) { return c[0] === 'updateCredential'; }).pop()[2];
  assert.deepStrictEqual(Object.keys(patch1), ['title'], '补丁里只该有传进来的字段');
  assert.strictEqual(rename.data.credential.title, '改名了');
  assert.strictEqual(h.storage.rows.get(rec.id).username, 'u1');
  assert.strictEqual(h.storage.rows.get(rec.id).passwordEnc, beforeEnc, '没传 password 就不该重新加密');
  assert.notStrictEqual(h.storage.rows.get(rec.id).updatedAt, before.updatedAt, '存储层随任何补丁 bump updated_at');

  h.clock.advance(1000);
  const changePw = await h.call('PUT', '/api/credentials/' + rec.id, { password: 'correct horse battery' });
  assert.strictEqual(changePw.status, 200);
  const patch2 = h.storage.calls.filter(function (c) { return c[0] === 'updateCredential'; }).pop()[2];
  assert.deepStrictEqual(Object.keys(patch2), ['passwordEnc']);
  assert.match(patch2.passwordEnc, /^enc:v1:/);
  assert.notStrictEqual(patch2.passwordEnc, beforeEnc, '同一条口令重新加密也必须得到不同密文（IV 随机）');
  const after = h.storage.rows.get(rec.id);
  assert.notStrictEqual(after.updatedAt, before.updatedAt, '改口令必然带 updated_at');
  assert.strictEqual(changePw.data.credential.passwordEnc, undefined);

  const clear = await h.call('PUT', '/api/credentials/' + rec.id, { password: '', note: '', totpSecret: '' });
  assert.strictEqual(clear.status, 200);
  const cleared = h.storage.rows.get(rec.id);
  assert.deepStrictEqual([cleared.passwordEnc, cleared.noteEnc, cleared.totpEnc], [null, null, null], '空串＝清除');
  assert.deepStrictEqual([clear.data.credential.hasPassword, clear.data.credential.hasNote, clear.data.credential.hasTotp],
    [false, false, false]);
  assert.strictEqual(clear.data.credential.hasSecret, true, '没传的密文列不该被顺手抹掉');

  const emptyPatch = await h.call('PUT', '/api/credentials/' + rec.id, {});
  assert.strictEqual(emptyPatch.status, 400);
  const blankTitle = await h.call('PUT', '/api/credentials/' + rec.id, { title: '' });
  assert.strictEqual(blankTitle.status, 400);
  const missing = await h.call('PUT', '/api/credentials/9999', { title: 'x' });
  assert.strictEqual(missing.status, 404);
  const failAudit = h.auditRows().filter(function (r) { return r.kind === 'update' && r.status === 'fail'; });
  assert.strictEqual(failAudit.length, 1, '更新失败也要记审计');
});

/* ── 删除 ─────────────────────────────────────────────────────────── */

test('DELETE：删得掉，删不存在的给 404 并记 fail 审计', async () => {
  const h = harness();
  h.unlock();
  const rec = h.seed({ title: '待删' });
  const r = await h.call('DELETE', '/api/credentials/' + rec.id);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.deleted, rec.id);
  assert.strictEqual(h.storage.rows.has(rec.id), false);

  const again = await h.call('DELETE', '/api/credentials/' + rec.id);
  assert.strictEqual(again.status, 404);
  const rows = h.auditRows().filter(function (r) { return r.kind === 'delete'; });
  assert.deepStrictEqual(rows.map(function (r) { return r.status; }), ['ok', 'fail']);
});

/* ── reveal：唯一明文出口 ─────────────────────────────────────────── */

test('reveal 成功：返回明文、走 lastUsed、记一条 ok 审计、限流键含 id 与来源', async () => {
  const h = harness();
  const dek = h.unlock();
  const rec = h.seedEncrypted({ password: 'hunter2', note: '备用邮箱', totpSecret: RAW_TOTP },
    { title: '内网门户', username: 'ops', url: 'https://intra' });

  const r = await h.call('POST', '/api/credentials/' + rec.id + '/reveal', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.password, 'hunter2');
  assert.strictEqual(r.data.note, '备用邮箱');
  assert.strictEqual(r.data.totpSecret, RAW_TOTP);
  assert.strictEqual(r.data.secret, null, '没录的字段给 null，不是空串');
  assert.strictEqual(r.data.id, rec.id);
  assert.strictEqual(r.data.title, '内网门户');
  assert.ok(r.data.lastUsedAt, 'lastUsedAt 由 setCredentialLastUsed 带回');
  assert.deepStrictEqual(r.headers, { 'Cache-Control': 'no-store' });
  assert.strictEqual(JSON.stringify(r.data).indexOf('enc:v1'), -1, '明文出口不该顺带把密文也吐出来');

  assert.deepStrictEqual(h.throttle.checked, [api.throttleKey({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, rec.id, 'reveal')]);
  assert.match(h.throttle.checked[0], /reveal:/);
  assert.ok(h.throttle.checked[0].indexOf(String(rec.id)) > -1 && h.throttle.checked[0].indexOf('127.0.0.1') > -1);
  assert.deepStrictEqual(h.throttle.passedKeys, h.throttle.checked, '成功后清零');
  assert.deepStrictEqual(h.throttle.failedKeys, []);
  assert.ok(h.storage.calls.some(function (c) { return c[0] === 'setCredentialLastUsed' && c[1] === rec.id; }));

  const audit = h.auditRows().filter(function (r) { return r.kind === 'reveal'; });
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].status, 'ok');
  assert.strictEqual(audit[0].target, String(rec.id));
  assert.strictEqual(JSON.stringify(h.auditRows()).indexOf('hunter2'), -1, '审计 detail 不许含明文');
  assert.strictEqual(decryptOf(dek, h.storage.rows.get(rec.id).passwordEnc), 'hunter2', 'reveal 不许把库改坏');
});

function decryptOf(key, stored) {
  return require('../src/crypto').decryptField(key, stored);
}

test('reveal 限流命中：429 + retryAfterMs，不给明文，记 denied', async () => {
  const h = harness();
  h.unlock();
  const rec = h.seedEncrypted({ password: 'hunter2' }, { title: '被限流' });
  h.throttle.blockFor(45000);
  const r = await h.call('POST', '/api/credentials/' + rec.id + '/reveal', {});
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.data.retryAfterMs, 45000);
  assert.strictEqual(r.data.password, undefined);
  assert.strictEqual(JSON.stringify(r.data).indexOf('hunter2'), -1);
  assert.strictEqual(JSON.stringify(r.data).indexOf('enc:v1'), -1);
  const audit = h.auditRows().filter(function (r) { return r.kind === 'reveal'; });
  assert.deepStrictEqual(audit.map(function (r) { return [r.status, r.detail]; }), [['denied', 'throttled']]);
  assert.strictEqual(h.storage.calls.some(function (c) { return c[0] === 'setCredentialLastUsed'; }), false, '被限流不算「用过一次」');
});

test('reveal：id 不存在 404 + 消耗一次限流失败额度', async () => {
  const h = harness();
  h.unlock();
  const r = await h.call('POST', '/api/credentials/404/reveal', {});
  assert.strictEqual(r.status, 404);
  assert.deepStrictEqual(h.throttle.failedKeys.length, 1);
  assert.strictEqual(h.throttle.passedKeys.length, 0);
  const audit = h.auditRows().filter(function (r) { return r.kind === 'reveal'; });
  assert.deepStrictEqual(audit.map(function (r) { return [r.target, r.status, r.detail]; }), [['404', 'fail', 'not-found']]);
});

test('reveal：密文损坏走真限流，连续失败后被锁（真实 createThrottle 联动）', async () => {
  const c = clock(0);
  const throttle = vault.createThrottle({ now: c.now, maxFails: 2, lockMs: 60000 });
  const h = harness({ throttle: throttle, start: 0 });
  h.unlock();
  const rec = h.seed({ title: '坏了', passwordEnc: 'enc:v1:AAAA' });

  for (let i = 0; i < 2; i++) {
    const r = await h.call('POST', '/api/credentials/' + rec.id + '/reveal', {});
    assert.strictEqual(r.status, 500, '第 ' + (i + 1) + ' 次');
    assert.strictEqual(r.data.password, undefined);
    assert.strictEqual(r.data.cause, 'internal', '500 不外泄原始错误');
    assert.ok(!/密文字段损坏/.test(JSON.stringify(r.data)));
  }
  const third = await h.call('POST', '/api/credentials/' + rec.id + '/reveal', {});
  assert.strictEqual(third.status, 429);
  assert.strictEqual(third.data.retryAfterMs, 60000);
  const audit = h.auditRows().filter(function (r) { return r.kind === 'reveal'; });
  assert.deepStrictEqual(audit.map(function (r) { return r.status; }), ['fail', 'fail', 'denied']);
});

test('reveal：老库遗留的无前缀明文列照样能读出来，不谎报成损坏', async () => {
  const h = harness();
  h.unlock();
  const rec = h.seed({ title: '老数据', passwordEnc: 'legacy-plain', noteEnc: null });
  const r = await h.call('POST', '/api/credentials/' + rec.id + '/reveal', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.password, 'legacy-plain');
});

/* ── TOTP ─────────────────────────────────────────────────────────── */

test('TOTP：裸 base32 出 6 位码 + secondsRemaining，绝不回显 secret', async () => {
  const h = harness();
  h.unlock();
  const rec = h.seedEncrypted({ totpSecret: RAW_TOTP }, { title: '两 factor' });
  const r = await h.call('GET', '/api/credentials/' + rec.id + '/totp');
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.code, /^\d{6}$/, '默认 6 位');
  assert.strictEqual(r.data.digits, 6);
  assert.strictEqual(r.data.step, 30);
  assert.strictEqual(r.data.algorithm, 'sha1');
  assert.strictEqual(r.data.secondsRemaining, 10, '冻结在 ' + CLOCK_START + 'ms：30 秒窗口已过 20 秒');
  assert.deepStrictEqual(r.headers, { 'Cache-Control': 'no-store' });
  const dump = JSON.stringify(r.data);
  assert.strictEqual(dump.indexOf(RAW_TOTP), -1, '动态码出口不许带 secret');
  assert.strictEqual(dump.indexOf('enc:v1'), -1);
  const expected = totp.generate({ secret: RAW_TOTP, at: CLOCK_START / 1000 });
  assert.strictEqual(r.data.code, expected, '与 totp.generate 同输入同码');

  assert.strictEqual(h.storage.rows.get(rec.id).lastUsedAt, null, '出动态码不该顺手记 lastUsed（只有 reveal 才算取用）');
  assert.strictEqual(h.storage.rows.get(rec.id).updatedAt, rec.updatedAt, 'TOTP 是只读的');
});

test('TOTP：缺 totpEnc 给 409，otpauth URI 里的 period/digits/algorithm 生效', async () => {
  const h = harness();
  h.unlock();
  const plain = h.seed({ title: '没配 TOTP' });
  const missing = await h.call('GET', '/api/credentials/' + plain.id + '/totp');
  assert.strictEqual(missing.status, 409);
  assert.strictEqual(JSON.stringify(missing.data).indexOf(RAW_TOTP), -1);

  const uri = h.seedEncrypted({ totpSecret: OTP_URI }, { title: '带 URI' });
  const r = await h.call('GET', '/api/credentials/' + uri.id + '/totp');
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.code, /^\d{8}$/, 'URI 写了 digits=8 就该出 8 位');
  assert.strictEqual(r.data.step, 60);
  assert.strictEqual(r.data.algorithm, 'sha256');
  assert.ok(r.data.secondsRemaining >= 1 && r.data.secondsRemaining <= 60);
  assert.strictEqual(JSON.stringify(r.data).indexOf(RAW_TOTP), -1);
  assert.strictEqual(JSON.stringify(h.auditRows()).indexOf(RAW_TOTP), -1, '审计里也不许有 secret');

  const gone = await h.call('GET', '/api/credentials/777/totp');
  assert.strictEqual(gone.status, 404);
  assert.deepStrictEqual(h.throttle.failedKeys.length, 1, '不存在的 id 消耗限流额度');
});

test('TOTP：库里存了非法 base32 时出 422 而不是 500 裸奔', async () => {
  const h = harness();
  h.unlock();
  const rec = h.seedEncrypted({ totpSecret: '000000' }, { title: '脏 secret' });
  const r = await h.call('GET', '/api/credentials/' + rec.id + '/totp');
  assert.strictEqual(r.status, 422);
  assert.strictEqual(JSON.stringify(r.data).indexOf('000000'), -1);
  const audit = h.auditRows().filter(function (a) { return a.kind === 'totp'; });
  assert.strictEqual(audit[audit.length - 1].status, 'fail');
});

/* ── health ───────────────────────────────────────────────────────── */

test('health：账号复用清单 + 弱口令计数，输出里没有半个口令', async () => {
  const h = harness();
  const dek = h.unlock();
  const weakPw = 'hunter2';
  const strongPw = 'Xk9#mQ2$vL7!pR4zT8@bN5cWq';
  const a = h.seedEncrypted({ password: weakPw }, { title: '复用A', username: 'shared' });
  const b = h.seedEncrypted({ password: strongPw }, { title: '复用B', username: 'shared' });
  const d = h.seedEncrypted({ password: 'abc12345' }, { title: '复用C', username: 'shared' });
  h.seedEncrypted({ password: strongPw }, { title: '独占', username: 'solo' });
  h.seed({ title: '没有口令', username: 'nopw' });
  const broken = h.seed({ title: '坏密文', username: 'broken', passwordEnc: 'enc:v1:AAAA' });

  const r = await h.call('GET', '/api/credentials/health');
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.total, 6);
  assert.strictEqual(r.data.passwordChecked, 4, '解不开的那条不算「已评估」');
  assert.deepStrictEqual(r.data.usernameReuse, [
    {
      username: 'shared', count: 3,
      items: [{ id: a.id, title: '复用A' }, { id: b.id, title: '复用B' }, { id: d.id, title: '复用C' }]
    }
  ]);
  assert.strictEqual(r.data.reusedUsernameCount, 1, 'count=1 的不算复用');
  assert.strictEqual(r.data.weakCount, 2);
  assert.deepStrictEqual(r.data.weakPasswords.map(function (w) { return w.id; }), [a.id, d.id], '按分数再按 id 排');
  assert.strictEqual(r.data.weakPasswords[0].label, 'very-weak');
  assert.ok(Array.isArray(r.data.weakPasswords[0].reasons));
  assert.deepStrictEqual(r.data.unreadable, [{ id: broken.id, title: '坏密文', reason: '密文无法解开' }]);

  const dump = JSON.stringify(r.data);
  [weakPw, strongPw, 'abc12345'].forEach(function (pw) {
    assert.strictEqual(dump.indexOf(pw), -1, 'health 回显了口令：' + pw);
  });
  assert.strictEqual(dump.indexOf('enc:v1'), -1);
  assert.strictEqual(dump.indexOf(dek.toString('hex')), -1);
  assert.ok(h.storage.calls.every(function (c) { return c[0] !== 'updateCredential'; }), 'health 只读，不写库');
});

test('health：空库给全零，不炸', async () => {
  const h = harness();
  h.unlock();
  const r = await h.call('GET', '/api/credentials/health');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, {
    total: 0, passwordChecked: 0, weakCount: 0, reusedUsernameCount: 0,
    usernameReuse: [], weakPasswords: [], unreadable: [], weakScoreCeiling: api.WEAK_SCORE_MAX
  });
});

test('health：非 GET 方法与未解锁都要被拒', async () => {
  const h = harness();
  const post = await h.call('POST', '/api/credentials/health', {});
  assert.strictEqual(post.status, 405);
  h.unlock();
  const afterUnlock = await h.call('GET', '/api/credentials/health');
  assert.strictEqual(afterUnlock.status, 200);
});

/* ── 路由归属与形状 ───────────────────────────────────────────────── */

test('非 /api/credentials 前缀交回上层，且不写任何响应', async () => {
  const h = harness();
  const r = await h.call('GET', '/api/keys');
  assert.strictEqual(r.handled, false);
  assert.strictEqual(h.sink.calls.length, 0);
});

test('路径与方法形状：未知子路径 404、非数字 id 400、尾斜杠仍是列表', async () => {
  const h = harness();
  h.unlock();
  const unknown = await h.call('GET', '/api/credentials/1/unknown');
  assert.strictEqual(unknown.status, 404);
  const badId = await h.call('GET', '/api/credentials/abc');
  assert.strictEqual(badId.status, 400);
  const sci = await h.call('GET', '/api/credentials/1e3');
  assert.strictEqual(sci.status, 400, 'Number("1e3") 也是数，但人不会这么写 id');
  const wrongMethod = await h.call('DELETE', '/api/credentials/1/reveal');
  assert.strictEqual(wrongMethod.status, 405);
  const totpPost = await h.call('POST', '/api/credentials/1/totp', {});
  assert.strictEqual(totpPost.status, 405);
  const trailing = await h.call('GET', '/api/credentials/');
  assert.strictEqual(trailing.status, 200);
  assert.deepStrictEqual(trailing.data.credentials, []);
  const listQuery = await h.call('GET', '/api/credentials?folder=%E5%85%AC%E5%8F%B8');
  assert.strictEqual(listQuery.status, 200, '查询串不该影响路由');
});

test('闲置自动锁把会话踢回 423：路由层不自己记住任何解锁状态', async () => {
  const h = harness({ idleLockMs: 1000 });
  h.unlock();
  const rec = h.seedEncrypted({ password: 'hunter2' }, { title: '会锁' });
  h.clock.advance(999);
  assert.strictEqual(h.session.lockIfIdle(), false);
  h.clock.advance(1);
  assert.strictEqual(h.session.lockIfIdle(), true);
  const r = await h.call('GET', '/api/credentials');
  assert.strictEqual(r.status, 423);
  const rv = await h.call('POST', '/api/credentials/' + rec.id + '/reveal', {});
  assert.strictEqual(rv.status, 423);
  assert.strictEqual(JSON.stringify(rv.data).indexOf('hunter2'), -1);
});
