/* 消费者作用域令牌（consumer-scoped tokens）。
   现状：任何本机进程不带 Origin 一条 curl 就能从 GET /api/keys 拿走全部明文——因为拿的是
   共享的保险库口令。本模块把「一把万能钥匙」换成「每服务一把窄权限、短时效、可单独吊销的令牌」。
   这里只有令牌本体（签发/验签/授权判定/审计指纹），路由、落库、吊销列表都由 api 层负责。

   刻意不 require crypto.js / vault.js / storage.js：纯函数、零副作用、任何一侧都能单独单测。

   ★ TEK（令牌签名密钥）由 DEK 经 HKDF 派生，只活在单次调用的内存里，用完立刻填零：
     绝不明文落盘、绝不进任何返回值/错误信息/日志。
     令牌的失效边界因此**只跟 DEK 本体绑定**，而本应用里三件看起来像「换钥匙」的事都不换 DEK：
     设解锁口令（enablePassphrase 只是把原来那把 DEK 包一层）、改口令（重包一次）、
     丢弃 master.key（删掉明文副本，DEK 仍在 vault.key 里）——2026-10-09 端到端实测，
     设口令并重启后旧令牌照样 200。真正会让全部令牌立刻验签失败的只有一种：DEK 本身换了，
     也就是数据目录被重建、或从恢复码走了一次全新库。别在文档里把它许诺成「改口令即可吊销」。
   ★ 另一条边界同样容易误解：DEK 不在内存（未解锁）时连验签的根都没有，此时该报 423 而不是 401。
     含义是设了口令的安装重启后，机器消费者必须等人先解锁才能取到密钥——这是设计后果，不是缺陷。 */

const crypto = require('node:crypto');

const TOKEN_VERSION = 'v1';
const TEK_INFO = 'aegis:consumer-token:v1';
const SIGN_PREFIX = TOKEN_VERSION + ':';

/* 白名单：能出现在令牌里的能力就这四项，多一个字符都算 malformed。
   新增能力必须同时改这张表和 api 层的映射，避免「签了但没人校验」的空头作用域。 */
const SCOPES = Object.freeze(['key:read', 'key:test', 'cred:read', 'balance:read']);

/* 每个 scope 绑到哪份资源清单：balance 是按 key 计的，所以也落 keyIds。 */
const SCOPE_RESOURCE_FIELD = Object.freeze({
  'key:read': 'keyIds',
  'key:test': 'keyIds',
  'balance:read': 'keyIds',
  'cred:read': 'credIds'
});

/* 调用方据此映射 HTTP 状态：malformed/bad-signature → 401，scope → 403，expired → 401（可带重试提示）。
   notYetValid 是预留位：本版本**永不返回**（见下方 verifyToken 里关于 iat 的说明）。 */
const REASONS = Object.freeze(['malformed', 'bad-signature', 'expired', 'scope', 'notYetValid']);

const MAX_LABEL_LEN = 40;
/* 令牌是 URL 头里带的东西，资源清单必须有上限：20 个消费者、每个几十把 key 已经够用，
   不设上限就等于允许把整个库的 id 塞进一个令牌，既撑爆 Header 又让吊销无从下手。 */
const MAX_TOTAL_RESOURCE_IDS = 64;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 90 * 24 * 60 * 60;      // 7776000
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;  // 2592000
const TID_BYTES = 12;                            // → 24 位 hex
const FINGERPRINT_HEX_LEN = 8;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const TID_RE = /^[0-9a-f]{24}$/;
const PAYLOAD_KEYS = 7; // tid,label,scopes,keyIds,credIds,exp,iat —— 多一个键都拒

function tokenError(message, status) {
  const e = new Error(message);
  e.httpStatus = status || 400;
  return e;
}

function isPositiveInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

/* now 一律按**毫秒**理解（与 Date.now / vault.js 同单位），写进 payload 才换算成 Unix 秒。
   传错单位不会静默变宽松：按秒传会算出 1970 年的 exp，令牌立刻 expired，响在验证侧而不是悄悄放行。 */
function nowMsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return Date.now();
}

/* HKDF-Extract/Expand：salt 用空串（DEK 本身已是 256 位均匀随机），info 固定做域分离。
   注意 hkdfSync 返回 ArrayBuffer，必须再 Buffer.from 包一层。 */
function withTek(dek, fn) {
  if (!Buffer.isBuffer(dek) || dek.length !== 32) {
    throw tokenError('DEK 形状不对：令牌签名需要 32 字节 Buffer（保险库未解锁？应先过 vault.key()）', 500);
  }
  const tek = Buffer.from(
    crypto.hkdfSync('sha256', dek, Buffer.alloc(0), Buffer.from(TEK_INFO, 'utf8'), 32)
  );
  try {
    return fn(tek);
  } finally {
    tek.fill(0); // 派生密钥用完即毁，别让它躺在堆上等 GC
  }
}

function signPayload(payloadB64, tek) {
  return crypto.createHmac('sha256', tek)
    .update(SIGN_PREFIX + payloadB64, 'utf8')
    .digest();
}

/* 键序写死在这里：同一份 payload 每次编码出同一串字节，签名与指纹才谈得上「稳定」。 */
function canonicalPayload(p) {
  return {
    tid: p.tid,
    label: p.label,
    scopes: p.scopes,
    keyIds: p.keyIds,
    credIds: p.credIds,
    exp: p.exp,
    iat: p.iat
  };
}

function encodePayload(p) {
  return Buffer.from(JSON.stringify(canonicalPayload(p)), 'utf8').toString('base64url');
}

/* 结构 + 语义双重校验：验签之前先确定 payload 是可解释的形状，
   否则攻击者能塞进 scopes:"key:read"（字符串而非数组）这类怪值，把下游 authorize 绕过去。 */
function parsePayloadObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (Object.keys(obj).length !== PAYLOAD_KEYS) return null;
  if (typeof obj.tid !== 'string' || !TID_RE.test(obj.tid)) return null;
  if (typeof obj.label !== 'string' || obj.label.length === 0 || obj.label.length > MAX_LABEL_LEN) return null;
  if (!Array.isArray(obj.scopes) || obj.scopes.length === 0 || obj.scopes.length > SCOPES.length) return null;
  for (const s of obj.scopes) {
    if (typeof s !== 'string' || SCOPES.indexOf(s) === -1) return null;
  }
  const keyIds = parseIdList(obj.keyIds);
  const credIds = parseIdList(obj.credIds);
  if (!keyIds || !credIds) return null;
  if (keyIds.length + credIds.length > MAX_TOTAL_RESOURCE_IDS) return null;
  if (!Number.isSafeInteger(obj.exp) || obj.exp <= 0) return null;
  if (!Number.isSafeInteger(obj.iat) || obj.iat <= 0) return null;
  return canonicalPayload({ tid: obj.tid, label: obj.label, scopes: obj.scopes, keyIds, credIds, exp: obj.exp, iat: obj.iat });
}

function parseIdList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const n of v) {
    if (!isPositiveInt(n)) return null;
    if (out.indexOf(n) === -1) out.push(n);
  }
  return out.sort(function (a, b) { return a - b; });
}

function decodePayloadB64(b64) {
  if (typeof b64 !== 'string' || !BASE64URL_RE.test(b64)) return null;
  let obj;
  try {
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    if (json.indexOf('\uFFFD') !== -1) return null; // 非 UTF-8 字节：不是我们签过的东西
    obj = JSON.parse(json);
  } catch (err) {
    return null;
  }
  return parsePayloadObject(obj);
}

/* 只做信封拆解，不碰 payload 内容：验签之前不解析 JSON（见 verifyToken 的顺序说明）。 */
function splitRaw(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  if (!parts[1].length || !parts[2].length) return null;
  if (!BASE64URL_RE.test(parts[1]) || !BASE64URL_RE.test(parts[2])) return null;
  return { version: TOKEN_VERSION, payloadB64: parts[1], sigB64: parts[2] };
}

/* ---------- 签发 ---------- */

function normalizeLabel(label) {
  if (typeof label !== 'string') throw tokenError('label 必须是字符串（消费者名字，如 "claude-code"）');
  const trimmed = label.trim();
  if (!trimmed.length) throw tokenError('label 不能为空');
  if (trimmed.length > MAX_LABEL_LEN) throw tokenError('label 最长 ' + MAX_LABEL_LEN + ' 字符，当前 ' + trimmed.length);
  return trimmed;
}

function normalizeScopes(scopes) {
  const list = toArray(scopes);
  if (!list.length) throw tokenError('scopes 不能为空：没有作用域的令牌等于废令牌');
  const out = [];
  for (const s of list) {
    if (typeof s !== 'string' || SCOPES.indexOf(s) === -1) {
      throw tokenError('不认识的 scope：' + String(s).slice(0, 32) + '；可用值 ' + SCOPES.join('、'));
    }
    if (out.indexOf(s) === -1) out.push(s);
  }
  return SCOPES.filter(function (s) { return out.indexOf(s) !== -1; }); // 固定顺序，同集合同字节
}

function normalizeIds(keyIds, credIds) {
  const parse = function (v, name) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw tokenError(name + ' 必须是正整数数组');
    const out = [];
    for (const n of v) {
      if (!isPositiveInt(n)) throw tokenError(name + ' 只能是正整数（数据库自增 id），收到 ' + JSON.stringify(n));
      if (out.indexOf(n) === -1) out.push(n);
    }
    return out.sort(function (a, b) { return a - b; });
  };
  const keys = parse(keyIds, 'keyIds');
  const creds = parse(credIds, 'credIds');
  if (keys.length + creds.length > MAX_TOTAL_RESOURCE_IDS) {
    throw tokenError('资源条目合计最多 ' + MAX_TOTAL_RESOURCE_IDS + ' 个（当前 ' + (keys.length + creds.length)
      + '）：一个令牌盖住整库就说明作用域设计错了');
  }
  return { keyIds: keys, credIds: creds };
}

function normalizeTtl(ttlSeconds) {
  if (ttlSeconds === undefined || ttlSeconds === null) return DEFAULT_TTL_SECONDS;
  const n = Number(ttlSeconds);
  if (!Number.isFinite(n)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(n)));
}

/* issueToken({dek, label, scopes, keyIds, credIds, ttlSeconds, now}) → { token, payload, fingerprint, ... }
   返回的 token 只在此刻出现一次：库里存的是 fingerprint + 元数据，不落明文令牌。 */
function issueToken(opts) {
  const o = opts || {};
  const label = normalizeLabel(o.label);
  const scopes = normalizeScopes(o.scopes);
  const ids = normalizeIds(o.keyIds, o.credIds);
  const ttl = normalizeTtl(o.ttlSeconds);
  const iat = Math.floor(nowMsOf(o.now) / 1000);
  const payload = canonicalPayload({
    tid: crypto.randomBytes(TID_BYTES).toString('hex'),
    label: label,
    scopes: scopes,
    keyIds: ids.keyIds,
    credIds: ids.credIds,
    exp: iat + ttl,
    iat: iat
  });
  const body = encodePayload(payload);
  const token = withTek(o.dek, function (tek) {
    return TOKEN_VERSION + '.' + body + '.' + signPayload(body, tek).toString('base64url');
  });
  return {
    token: token,
    version: TOKEN_VERSION,
    payload: payload,
    ttlSeconds: ttl,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    issuedAt: new Date(payload.iat * 1000).toISOString(),
    fingerprint: tokenFingerprint(token, o.dek)
  };
}

/* ---------- 验签 ---------- */

function fail(reason) {
  return { ok: false, reason: reason };
}

function hasAllScopes(payload, required) {
  const list = toArray(required);
  if (!list.length) return true;
  for (const s of list) {
    if (typeof s !== 'string' || payload.scopes.indexOf(s) === -1) return false;
  }
  return true;
}

/* resource 允许两种写法：{keyId: 3} / {credId: 7}，或 authorize 那种 scope + id 的组合。
   形状不对一律按不满足处理（reason: 'scope'），verifyToken 的契约是「绝不抛」。 */
function resourceAllowed(payload, resource) {
  if (resource === undefined || resource === null) return true;
  if (typeof resource === 'object' && !Array.isArray(resource)) {
    const hasKey = resource.keyId !== undefined && resource.keyId !== null;
    const hasCred = resource.credId !== undefined && resource.credId !== null;
    if (hasKey === hasCred) return false; // 要么只有一个，要么都没有（都没有 = 不校验）
    return hasKey ? payload.keyIds.indexOf(resource.keyId) !== -1
      : payload.credIds.indexOf(resource.credId) !== -1;
  }
  return false;
}

/* verifyToken(token, {dek, now, scopes, resource}) → {ok:true, payload, fingerprint} | {ok:false, reason}
   任何异常路径都收敛成 reason，调用方靠它决定 401/403/423，不需要 try/catch。
   顺序：拆信封 → 验签 → 才解析 payload。**先验签后解析**是刻意的：
   没验过的字节就喂进 JSON.parse / 形状校验，等于把解析器的任何毛病暴露给任意输入。 */
function verifyToken(token, opts) {
  const o = opts || {};
  let raw;
  try {
    raw = splitRaw(token);
  } catch (err) {
    return fail('malformed');
  }
  if (!raw) return fail('malformed');

  let tek;
  let expected;
  try {
    if (!Buffer.isBuffer(o.dek) || o.dek.length !== 32) return fail('bad-signature');
    tek = Buffer.from(crypto.hkdfSync('sha256', o.dek, Buffer.alloc(0), Buffer.from(TEK_INFO, 'utf8'), 32));
    expected = signPayload(raw.payloadB64, tek);
  } catch (err) {
    return fail('bad-signature'); // DEK 形状不对 = 无信任根，按外来令牌处理，不给探针
  } finally {
    if (tek) tek.fill(0);
  }

  const got = Buffer.from(raw.sigB64, 'base64url');
  // 必须先比长度：crypto.timingSafeEqual 长度不等会直接抛 ERR_CRYPTO_BUFFER，而不是返回 false
  if (got.length !== expected.length) return fail('bad-signature');
  if (!crypto.timingSafeEqual(got, expected)) return fail('bad-signature');

  const payload = decodePayloadB64(raw.payloadB64);
  if (!payload) return fail('malformed'); // 签名对了却解不出形状：不是本模块签发的东西

  const nowSec = Math.floor(nowMsOf(o.now) / 1000);
  if (nowSec >= payload.exp) return fail('expired');
  // iat 只是签发时间戳，不做 notBefore：本机时钟比令牌签发早几十秒是常态，
  // 拒了就是自伤（消费者全下线），也没有多守住任何东西。所以 notYetValid 永不返回。

  if (!hasAllScopes(payload, o.scopes)) return fail('scope');
  if (!resourceAllowed(payload, o.resource)) return fail('scope');

  return {
    ok: true,
    payload: canonicalPayload(payload),
    fingerprint: tokenFingerprint(token, o.dek),
    remainingSeconds: payload.exp - nowSec
  };
}

/* authorize(payload, {scope, resourceId}) → {ok, reason?, scope, resourceField}
   语义最容易踩的坑：keyIds/credIds 是**白名单**，空数组表示「一把都读不到」，不是「不限」。
   签发方想给全部就显式列全；这样吊销一条 key 后，忘记重签的令牌不会自动继续覆盖它。 */
function authorize(payload, opts) {
  const o = opts || {};
  const p = parsePayloadObject(payload);
  if (!p) return fail('malformed');
  const scope = o.scope;
  if (typeof scope !== 'string' || SCOPES.indexOf(scope) === -1) return fail('scope');
  if (p.scopes.indexOf(scope) === -1) return fail('scope');

  const field = SCOPE_RESOURCE_FIELD[scope];
  const list = p[field];
  const id = o.resourceId;
  if (id === undefined || id === null) {
    // 不带具体资源时问的是「这令牌在这条 scope 上有没有任何东西可读」，空清单答案是否
    return list.length ? { ok: true, scope: scope, resourceField: field } : fail('scope');
  }
  if (!isPositiveInt(id) || list.indexOf(id) === -1) return fail('scope');
  return { ok: true, scope: scope, resourceField: field, resourceId: id };
}

/* ---------- 展示与审计 ---------- */

/* tokenFingerprint(token, dek) → 8 位 hex。审计和落库拿它当标识：
   单向（HMAC 不可反推令牌）且带 DEK 因子——拿到 keys.db 备份也凑不出某把令牌。
   8 位只有 32 bit，够用但别当唯一约束：唯一性靠 payload.tid（12 字节随机），落库两列都存。 */
function tokenFingerprint(token, dek) {
  const s = typeof token === 'string' ? token : '';
  if (!s.length) return null;
  try {
    return withTek(dek, function (tek) {
      return crypto.createHmac('sha256', tek)
        .update('aegis:consumer-token-fp:v1:' + s, 'utf8')
        .digest('hex')
        .slice(0, FINGERPRINT_HEX_LEN);
    });
  } catch (err) {
    return null; // 审计旁路不许把主流程带崩
  }
}

/* describeToken(token, dek) → 不含签名的明文摘要，给界面显示 label/scopes/exp。
   ⚠ 它不验签：展示不可信输入之前必须先 verifyToken，否则 label 是攻击者写的。
   只解码 payload，永不返回 sig，也永不返回整串 token。 */
function describeToken(token, dek, opts) {
  const o = opts || {};
  const raw = splitRaw(token);
  const p = raw ? decodePayloadB64(raw.payloadB64) : null;
  if (!p) return null;
  const nowSec = Math.floor(nowMsOf(o.now) / 1000);
  return {
    version: TOKEN_VERSION,
    tid: p.tid,
    label: p.label,
    scopes: p.scopes,
    keyIds: p.keyIds.slice(),
    credIds: p.credIds.slice(),
    iat: p.iat,
    exp: p.exp,
    issuedAt: new Date(p.iat * 1000).toISOString(),
    expiresAt: new Date(p.exp * 1000).toISOString(),
    expired: nowSec >= p.exp,
    remainingSeconds: p.exp - nowSec,
    resourceCount: p.keyIds.length + p.credIds.length,
    fingerprint: tokenFingerprint(token, dek)
  };
}

module.exports = {
  issueToken,
  verifyToken,
  authorize,
  tokenFingerprint,
  describeToken,
  SCOPES,
  SCOPE_RESOURCE_FIELD,
  REASONS,
  TOKEN_VERSION,
  MAX_LABEL_LEN,
  MAX_TOTAL_RESOURCE_IDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  FINGERPRINT_HEX_LEN
};
