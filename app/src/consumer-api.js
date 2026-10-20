/* 消费者作用域令牌的 HTTP 层（P4）。
   签名/验签/授权判定全在 consumer-tokens.js，这里只做路由、状态码映射、限流与审计。
   令牌本体只在签发那一条响应里出现一次；之后库里只有 fingerprint，日志与审计里也只有
   fingerprint——把令牌串记进审计等于在日志里再存一份凭据。

   两类路径分开，别混：
   - /api/consumer/tokens*             人（浏览器）管理令牌，受保险库会话与限流约束
   - /api/consumer/keys|credentials/*  机器带 Bearer 令牌取数据，按 scope 与白名单放行，
                                        并按令牌分桶限流（每令牌 60 秒 120 次，见下方「数据面限流」段） */

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
  /* 审计的 ok 由调用方在过了限流门之后补记：这一条只代表「认证过了」，
     代表不了「真取到数据」——被限流挡下的请求不该留下一条 ok */
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

/* ---------- 数据面限流（按令牌分桶） ---------- */

/* 档位：每把令牌每 60 秒最多 120 次数据面请求。
   分桶键是令牌的 tid（令牌 id），**不是来源 IP**：脚本可能从多个 IP 来（容器、重试网关、
   换网），按 IP 分桶会误伤；按令牌分桶正好对应「一把令牌」的粒度——谁拿到的额度就记在谁头上。 */
const DATA_MAX_REQUESTS = 120;
const DATA_WINDOW_MS = 60 * 1000;

/* 滑窗（存每次请求的时刻）：任何连续 60 秒内不超过 120 次。
   固定窗口在窗口边界能放出 240 次/秒（上一窗口末尾 120 + 下一窗口开头 120），滑窗没这条缝。
   桶里最多留 120 个时间戳，内存可以忽略；桶表只在内存里，进程重启即清零（与现有限流一致，不落盘）。 */
function createDataThrottle(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const max = Number.isFinite(o.max) && o.max > 0 ? Math.floor(o.max) : DATA_MAX_REQUESTS;
  const windowMs = Number.isFinite(o.windowMs) && o.windowMs > 0 ? Math.floor(o.windowMs) : DATA_WINDOW_MS;
  const sweepEvery = Number.isFinite(o.sweepEvery) && o.sweepEvery > 0 ? Math.floor(o.sweepEvery) : 64;
  const buckets = new Map(); /* tid -> {stamps:[毫秒], at:最后一次活动} */
  let written = 0;

  /* 窗口是 [now-windowMs, now]：早于等于左边界的都算过期 */
  function prune(b, nowMs) {
    const cut = nowMs - windowMs;
    let i = 0;
    while (i < b.stamps.length && b.stamps[i] <= cut) i += 1;
    if (i > 0) b.stamps.splice(0, i);
  }

  /* 清扫只在写入时顺带做，不起定时器：这套设计里没有任何东西在后台跑（与 vault.js 的节流同思路） */
  function sweep(nowMs) {
    buckets.forEach(function (b, tid) {
      prune(b, nowMs);
      if (!b.stamps.length) buckets.delete(tid);
    });
  }

  return {
    /* 预占一个名额。判断与占用必须在同一个同步函数里做完：拆成 check/count 两步，
       并发请求会一起从缝里挤进来（Node 单线程，同步段才是原子的）。 */
    reserve: function (tid) {
      const nowMs = now();
      let b = buckets.get(tid);
      if (!b) { b = { stamps: [], at: nowMs }; buckets.set(tid, b); }
      prune(b, nowMs);
      b.at = nowMs;
      if (b.stamps.length >= max) {
        /* 最老的那次滑出窗口时就能再放一个：等这么久还不够就别等了 */
        return { allowed: false, retryAfterMs: Math.max(1, (b.stamps[0] + windowMs) - nowMs) };
      }
      b.stamps.push(nowMs);
      if (++written % sweepEvery === 0) sweep(nowMs);
      return { allowed: true, stamp: nowMs };
    },
    /* 这次请求最后没取到数据（404 这类「脚本写错了」），把预占的名额还回去 */
    refund: function (tid, stamp) {
      const b = buckets.get(tid);
      if (!b) return false;
      const i = b.stamps.indexOf(stamp);
      if (i === -1) return false;
      b.stamps.splice(i, 1);
      return true;
    },
    /* 令牌被吊销：桶随令牌一起走，不留残骸 */
    drop: function (tid) { return buckets.delete(tid); },
    /* 只有测试和排障会用：桶里此刻记着几次 */
    peek: function (tid) {
      const b = buckets.get(tid);
      if (!b) return { count: 0 };
      prune(b, now());
      return { count: b.stamps.length };
    },
    size: function () { return buckets.size; },
    reset: function () { buckets.clear(); }
  };
}

/* 进程级默认桶表。ctx.dataThrottle 存在时用它（单测要隔离），生产走这一份 */
const defaultDataThrottle = createDataThrottle();

function dataThrottleOf(ctx) {
  const t = ctx && ctx.dataThrottle;
  return (t && typeof t.reserve === 'function') ? t : defaultDataThrottle;
}

/* 限流门：认证过了、准备取数据之前过这一关。
   超了额度就别去碰存储，更别去发厂商请求（key:test 会真花钱）。 */
function reserveData(ctx, authed) {
  return dataThrottleOf(ctx).reserve(authed.row.tid);
}

/* 没取到数据就把名额还回去——额度只该被「真拿到了东西」的请求消耗 */
function refundData(ctx, authed, gate) {
  if (!gate || gate.allowed !== true) return false;
  return dataThrottleOf(ctx).refund(authed.row.tid, gate.stamp);
}

/* Retry-After 头（秒）用标准写法给出；响应体里同时给毫秒级的 retryAfterMs。
   res 不是真正的 ServerResponse 时（单测的假 res 没有 setHeader）就跳过这个头，
   不能因为加个头把整个应答搞崩。 */
function setRetryAfter(res, retryAfterMs) {
  if (!res || typeof res.setHeader !== 'function') return false;
  const secs = Math.max(1, Math.ceil((Number(retryAfterMs) || 0) / 1000));
  try { res.setHeader('Retry-After', String(secs)); return true; } catch (e) { return false; }
}

function throttled(ctx, res, authed, gate, target) {
  audit(ctx, {
    kind: 'consumer', target: target, status: 'denied',
    detail: 'throttled ' + fpOf(authed.fingerprint)
  });
  setRetryAfter(res, gate.retryAfterMs);
  return ctx.bad(res, 429, '令牌请求过于频繁，请稍后再试', { retryAfterMs: gate.retryAfterMs });
}

/* 门禁过了才记 ok：被限流挡下的请求只该留一条 denied */
function auditOk(ctx, target, authed, scope) {
  audit(ctx, {
    kind: 'consumer',
    target: target,
    status: 'ok',
    detail: scope + ' ' + fpOf(authed.fingerprint)
  });
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
  let issued;
  try {
    /* body 坏掉要报「body 坏了」，不能吞成空对象再报「label 必须是字符串」——
       排查方向不能被带偏（调用方会以为该改 label，其实该改 body）。 */
    const b = await ctx.readBody(req);
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
  /* 桶随令牌一起走：吊销后这把令牌不该再占着额度表的一行 */
  dataThrottleOf(ctx).drop(tid);
  audit(ctx, { kind: 'token', status: 'ok', detail: 'revoke ' + fpOf(row.fingerprint) });
  /* 顺手把新列表带回，界面不必再发一次 GET：少一次往返就少一次状态不一致的机会 */
  return ctx.json(res, 200, { ok: true, tid: row.tid, revokedAt: row.revokedAt, tokens: listView(ctx) });
}

/* ---------- 数据面（机器） ---------- */

/* 过了门禁才去查资源在不在：反过来的话，一把作用域不足的令牌就能拿「404 还是 403」探测哪些 id 存在 */
function authorizedKey(ctx, req, res, rawId, scope) {
  const id = Number(rawId);
  const target = 'key:' + id;
  const authed = guard(ctx, req, res, { scope: scope, resource: { keyId: id }, target: target });
  if (!authed) return null;
  /* 限流门在门禁之后、资源查询之前：超了额度就别去碰存储，更别去发厂商请求 */
  const gate = reserveData(ctx, authed);
  if (!gate.allowed) {
    throttled(ctx, res, authed, gate, target);
    return null;
  }
  auditOk(ctx, target, authed, scope);
  const key = ctx.storage.getKey(id);
  if (!key) {
    /* 404 是脚本写错了（白名单里有、库里没有），不该吃它的额度：名额还回去 */
    refundData(ctx, authed, gate);
    audit(ctx, { kind: 'consumer', target: target, status: 'fail', detail: 'not-found ' + fpOf(authed.fingerprint) });
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
  const target = 'credential:' + id;
  const authed = guard(ctx, req, res, { scope: 'cred:read', resource: { credId: id }, target: target });
  if (!authed) return;
  /* 限流门与 key 那条同一套：认证过了、准备取凭证之前 */
  const gate = reserveData(ctx, authed);
  if (!gate.allowed) {
    throttled(ctx, res, authed, gate, target);
    return;
  }
  auditOk(ctx, target, authed, 'cred:read');
  const rec = ctx.storage.getCredential(id);
  if (!rec) {
    /* 同样是「脚本写错了」，名额还回去 */
    refundData(ctx, authed, gate);
    audit(ctx, { kind: 'consumer', target: target, status: 'fail', detail: 'not-found ' + fpOf(authed.fingerprint) });
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
        audit(ctx, { kind: 'consumer', target: target, status: 'fail', detail: 'decrypt:' + field.in });
        return ctx.bad(res, 500, '字段无法解密（' + field.in + '）：密文损坏或主密钥已更换');
      }
    }
    out[field.in] = value;
    if (value !== null) opened.push(field.in);
  }
  ctx.storage.setTokenLastUsed(authed.row.tid);
  audit(ctx, {
    kind: 'consumer', target: target, status: 'ok',
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
  pathnameOf: pathnameOf,
  createDataThrottle: createDataThrottle,
  DATA_MAX_REQUESTS: DATA_MAX_REQUESTS,
  DATA_WINDOW_MS: DATA_WINDOW_MS
};
