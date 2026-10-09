/* 消费者作用域令牌的 HTTP 层（P4）。
   签名/验签/授权判定全在 consumer-tokens.js，这里只做路由、状态码映射、限流与审计。
   令牌本体只在签发那一条响应里出现一次；之后库里只有 fingerprint，日志与审计里也只有
   fingerprint——把令牌串记进审计等于在日志里再存一份凭据。

   两类路径分开，别混：
   - /api/consumer/tokens*             人（浏览器）管理令牌，受保险库会话与限流约束
   - /api/consumer/keys|credentials/*  机器带 Bearer 令牌取数据，按 scope 与白名单放行 */

const ct = require('./consumer-tokens');
const { decryptField } = require('./crypto');
const { ENC_FIELDS } = require('./credentials-api');

/* 拒绝原因 → HTTP 状态。locked 由服务自己判（手里没有 DEK 就无从验签），
   不是 consumer-tokens 报回来的 */
const STATUS_OF_REASON = {
  missing: 401,
  malformed: 401,
  'bad-signature': 401,
  expired: 401,
  revoked: 401,
  unknown: 401,
  scope: 403,
  locked: 423
};

const REVOKE_RE = /^\/api\/consumer\/tokens\/([0-9a-f]{24})\/revoke$/;
const KEY_ITEM_RE = /^\/api\/consumer\/keys\/(\d+)$/;
const KEY_TEST_RE = /^\/api\/consumer\/keys\/(\d+)\/test$/;
const KEY_BALANCE_RE = /^\/api\/consumer\/keys\/(\d+)\/balance$/;
const CRED_ITEM_RE = /^\/api\/consumer\/credentials\/(\d+)$/;

function pathnameOf(req) {
  return new URL(req.url, 'http://127.0.0.1').pathname;
}

function bearerOf(req) {
  const h = String(req.headers.authorization || '').trim();
  const m = /^Bearer\s+(\S.*)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function audit(ctx, entry) {
  if (!ctx.vault || !ctx.vault.audit) return;
  try { ctx.vault.audit.push(entry); } catch (e) { /* 审计旁路不许把主流程带崩 */ }
}

/* 每一记都带上 fp=：一条「某把 key 被读了」若不记主体，审计就只是流水账 */
function fpOf(fingerprint) {
  return fingerprint ? 'fp=' + fingerprint : 'fp=-';
}

function denyMessage(reason) {
  if (reason === 'missing') return '缺少 Authorization: Bearer <token>';
  if (reason === 'malformed') return '令牌格式不对';
  if (reason === 'bad-signature') return '令牌签名不对（保险库根已更换？令牌要重新签发）';
  if (reason === 'expired') return '令牌已过期';
  if (reason === 'revoked') return '令牌已被吊销';
  if (reason === 'unknown') return '这把令牌不在本机的签发记录里';
  if (reason === 'scope') return '令牌的作用域不覆盖这个资源';
  if (reason === 'locked') return '保险库未解锁，令牌无从验签';
  return '令牌校验未通过';
}

/* 只把 fingerprint 放进 detail：审计环形缓冲会被 /api/vault/status 前 8 条原样吐到界面上 */
function denied(ctx, res, req, reason, fingerprint, detail) {
  audit(ctx, {
    kind: 'consumer',
    target: pathnameOf(req),
    status: 'denied',
    detail: reason + (detail ? ':' + String(detail).slice(0, 40) : '') + ' ' + fpOf(fingerprint)
  });
  return ctx.bad(res, STATUS_OF_REASON[reason] || 401, denyMessage(reason), { reason: reason });
}

function unlockDek(ctx) {
  if (!ctx.vault.isUnlocked()) return null;
  try {
    return ctx.vault.key();
  } catch (e) {
    return null;
  }
}

/* 这把令牌能不能动这个 scope + 这个资源，一次问清四件事。
   顺序是有讲究的：先确认手里有信任根，否则连「这令牌是不是我签的」都答不了——
   那时候报 401 会骗消费者以为令牌坏了去重新申请，实际该报的是 423（服务锁着）。
   然后才是验签、查吊销。放行时把 payload 与库存行一起交出去，调用方不再二次解签。 */
function guard(ctx, req, res, want) {
  const dek = unlockDek(ctx);
  if (!dek) {
    denied(ctx, res, req, 'locked');
    return null;
  }
  const token = bearerOf(req);
  if (!token) {
    denied(ctx, res, req, 'missing');
    return null;
  }
  const v = ct.verifyToken(token, { dek: dek, scopes: want.scope, resource: want.resource });
  if (!v.ok) {
    denied(ctx, res, req, v.reason);
    return null;
  }
  const row = ctx.storage.getToken(v.payload.tid);
  if (!row) {
    denied(ctx, res, req, 'unknown', v.fingerprint);
    return null;
  }
  if (row.revokedAt) {
    denied(ctx, res, req, 'revoked', v.fingerprint);
    return null;
  }
  audit(ctx, {
    kind: 'consumer',
    target: want.target,
    status: 'ok',
    detail: want.scope + ' ' + fpOf(v.fingerprint)
  });
  return { payload: v.payload, row: row, fingerprint: v.fingerprint };
}

function tokenView(t, nowSec) {
  return {
    tid: t.tid,
    fingerprint: t.fingerprint,
    label: t.label,
    scopes: t.scopes.slice(),
    keyIds: t.keyIds.slice(),
    credIds: t.credIds.slice(),
    resourceCount: t.keyIds.length + t.credIds.length,
    iat: t.iat,
    exp: t.exp,
    issuedAt: t.issuedAt,
    expiresAt: t.expiresAt,
    /* exp=0 是没夹住的脏行，按已过期处理：宁可少放行，不能当它永不过期 */
    expired: !t.exp || t.exp <= nowSec,
    revoked: !!t.revokedAt,
    revokedAt: t.revokedAt,
    lastUsedAt: t.lastUsedAt
  };
}

function listView(ctx) {
  const nowSec = Math.floor(Date.now() / 1000);
  return ctx.storage.listTokens().map(function (t) { return tokenView(t, nowSec); });
}

/* ---------- 管理面（人） ---------- */

async function issueToken(ctx, req, res) {
  const dek = unlockDek(ctx);
  if (!dek) return ctx.bad(res, 423, '保险库未解锁：没有 DEK 就签不出令牌');
  const gateKey = 'issue:' + clientIp(req);
  const gate = ctx.throttle.check(gateKey);
  if (!gate.allowed) {
    audit(ctx, { kind: 'token', status: 'denied', detail: 'throttled' });
    return ctx.bad(res, 429, '签发令牌过于频繁，请稍后再试', { retryAfterMs: gate.retryAfterMs });
  }
  const b = await ctx.readBody(req).catch(function () { return {}; });
  let issued;
  try {
    issued = ct.issueToken({
      dek: dek,
      label: b.label,
      scopes: b.scopes,
      keyIds: b.keyIds,
      credIds: b.credIds,
      ttlSeconds: b.ttlSeconds
    });
  } catch (e) {
    ctx.throttle.failed(gateKey);
    audit(ctx, { kind: 'token', status: 'fail', detail: String(e.message).slice(0, 60) });
    /* 把边界一并带回：界面上「还能填几个」不该由前端另抄一份常量 */
    return ctx.bad(res, e.httpStatus || 400, e.message, {
      maxLabelLen: ct.MAX_LABEL_LEN,
      maxResources: ct.MAX_TOTAL_RESOURCE_IDS,
      scopes: ct.SCOPES
    });
  }
  const p = issued.payload;
  const row = ctx.storage.createToken({
    tid: p.tid, fingerprint: issued.fingerprint, label: p.label,
    scopes: p.scopes, keyIds: p.keyIds, credIds: p.credIds, iat: p.iat, exp: p.exp
  });
  ctx.throttle.passed(gateKey);
  audit(ctx, {
    kind: 'token', status: 'ok',
    detail: 'issue ' + fpOf(issued.fingerprint) + ' ' + p.scopes.join('+')
  });
  /* token 字段只在这一条响应里出现；列表接口再也不会带它 */
  return ctx.json(res, 201, Object.assign(
    { token: issued.token, ttlSeconds: issued.ttlSeconds },
    tokenView(row, Math.floor(Date.now() / 1000))
  ));
}

function listTokens(ctx, res) {
  if (!ctx.vault.isUnlocked()) return ctx.bad(res, 423, '保险库未解锁');
  return ctx.json(res, 200, { tokens: listView(ctx) });
}

function revokeToken(ctx, res, tid) {
  if (!ctx.vault.isUnlocked()) return ctx.bad(res, 423, '保险库未解锁');
  const row = ctx.storage.revokeToken(tid);
  if (!row) return ctx.bad(res, 404, '没有这把令牌：' + tid);
  audit(ctx, { kind: 'token', status: 'ok', detail: 'revoke ' + fpOf(row.fingerprint) });
  /* 顺手把新列表带回，界面不必再发一次 GET：少一次往返就少一次状态不一致的机会 */
  return ctx.json(res, 200, { ok: true, tid: row.tid, revokedAt: row.revokedAt, tokens: listView(ctx) });
}

/* ---------- 数据面（机器） ---------- */

/* 过了门禁才去查资源在不在：反过来的话，一把作用域不足的令牌就能拿「404 还是 403」探测哪些 id 存在 */
function authorizedKey(ctx, req, res, rawId, scope) {
  const id = Number(rawId);
  const authed = guard(ctx, req, res, { scope: scope, resource: { keyId: id }, target: 'key:' + id });
  if (!authed) return null;
  const key = ctx.storage.getKey(id);
  if (!key) {
    audit(ctx, { kind: 'consumer', target: 'key:' + id, status: 'fail', detail: 'not-found ' + fpOf(authed.fingerprint) });
    ctx.bad(res, 404, '密钥不存在');
    return null;
  }
  ctx.storage.setTokenLastUsed(authed.row.tid);
  return { key: key, authed: authed };
}

function readKeyPlaintext(ctx, req, res) {
  const id = Number(KEY_ITEM_RE.exec(pathnameOf(req))[1]);
  const got = authorizedKey(ctx, req, res, id, 'key:read');
  if (!got) return;
  return ctx.json(res, 200, { id: got.key.id, name: got.key.name, platform: got.key.platform, key: got.key.key });
}

async function testKeyViaToken(ctx, req, res) {
  const id = Number(KEY_TEST_RE.exec(pathnameOf(req))[1]);
  const got = authorizedKey(ctx, req, res, id, 'key:test');
  if (!got) return;
  const body = await ctx.readBody(req).catch(function () { return {}; });
  const rec = await ctx.testKeyAt(ctx.storage, got.key, body.endpointIndex, { fetchImpl: ctx.fetchImpl });
  return ctx.json(res, 200, { test: rec.test });
}

function readBalanceViaToken(ctx, req, res) {
  const id = Number(KEY_BALANCE_RE.exec(pathnameOf(req))[1]);
  const got = authorizedKey(ctx, req, res, id, 'balance:read');
  if (!got) return;
  /* 只给现存快照，不当刷新入口：刷余额会往历史表写「观测结果」，那不该由一把只读令牌代笔 */
  return ctx.json(res, 200, { id: got.key.id, balance: got.key.balance || null });
}

function readCredentialViaToken(ctx, req, res) {
  const id = Number(CRED_ITEM_RE.exec(pathnameOf(req))[1]);
  const authed = guard(ctx, req, res, { scope: 'cred:read', resource: { credId: id }, target: 'credential:' + id });
  if (!authed) return;
  const rec = ctx.storage.getCredential(id);
  if (!rec) {
    audit(ctx, { kind: 'consumer', target: 'credential:' + id, status: 'fail', detail: 'not-found ' + fpOf(authed.fingerprint) });
    return ctx.bad(res, 404, '凭证不存在');
  }
  const dek = ctx.vault.key();
  const out = { id: rec.id, title: rec.title, username: rec.username, url: rec.url };
  const opened = [];
  /* 字段名与 POST /api/credentials/:id/reveal 同源同一张 ENC_FIELDS 表：
     两处各写一份映射的话，加第五个密文列时必然只改到一边 */
  for (const field of ENC_FIELDS) {
    const stored = rec[field.column];
    let value = null;
    if (stored !== null && stored !== undefined && stored !== '') {
      try {
        value = decryptField(dek, stored) || null;
      } catch (e) {
        audit(ctx, { kind: 'consumer', target: 'credential:' + id, status: 'fail', detail: 'decrypt:' + field.in });
        return ctx.bad(res, 500, '字段无法解密（' + field.in + '）：密文损坏或主密钥已更换');
      }
    }
    out[field.in] = value;
    if (value !== null) opened.push(field.in);
  }
  ctx.storage.setTokenLastUsed(authed.row.tid);
  audit(ctx, {
    kind: 'consumer', target: 'credential:' + id, status: 'ok',
    detail: 'opened:' + (opened.join('+') || 'empty') + ' ' + fpOf(authed.fingerprint)
  });
  return ctx.json(res, 200, out);
}

/* ---------- 分发 ---------- */

function handles(path) {
  return path === '/api/consumer/tokens' || path.indexOf('/api/consumer/tokens/') === 0
    || path.indexOf('/api/consumer/keys/') === 0
    || path.indexOf('/api/consumer/credentials/') === 0;
}

async function handleConsumerApi(req, res, ctx) {
  const path = pathnameOf(req);
  if (!handles(path)) return false;
  const method = req.method;

  if (method === 'GET' && path === '/api/consumer/tokens') {
    listTokens(ctx, res);
    return true;
  }
  if (method === 'POST' && path === '/api/consumer/tokens') {
    await issueToken(ctx, req, res);
    return true;
  }
  const rv = REVOKE_RE.exec(path);
  if (rv && method === 'POST') {
    revokeToken(ctx, res, rv[1]);
    return true;
  }
  if (method === 'GET' && KEY_ITEM_RE.test(path)) {
    readKeyPlaintext(ctx, req, res);
    return true;
  }
  if (method === 'POST' && KEY_TEST_RE.test(path)) {
    await testKeyViaToken(ctx, req, res);
    return true;
  }
  if (method === 'GET' && KEY_BALANCE_RE.test(path)) {
    readBalanceViaToken(ctx, req, res);
    return true;
  }
  if (method === 'GET' && CRED_ITEM_RE.test(path)) {
    readCredentialViaToken(ctx, req, res);
    return true;
  }
  ctx.bad(res, 404, '接口不存在');
  return true;
}

module.exports = {
  handleConsumerApi: handleConsumerApi,
  STATUS_OF_REASON: STATUS_OF_REASON,
  REASONS: ct.REASONS,
  tokenView: tokenView,
  bearerOf: bearerOf,
  pathnameOf: pathnameOf
};
