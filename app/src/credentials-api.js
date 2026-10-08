/* 凭证路由子模块：只做「HTTP ↔ 已加密的存储契约」这一层翻译。
   加解密用 ./crypto、会话与脱敏视图用 ./vault；限流与审计一律从 ctx 拿——
   这里刻意不自建 throttle / audit，否则会和 api.js 注入的那套分叉成两套规则。
   明文只从 reveal 一个出口出去，TOTP 出口只给实时码不给 secret。 */

const { encryptField, decryptField } = require('./crypto');
const vault = require('./vault');
const totp = require('./totp');
const passgen = require('./passgen');

const CREDENTIAL_PREFIX = '/api/credentials';

/* 长度上限是这一层定的（存储层原样存，不替上层判断），改这里就等于改协议，
   所以每个数都必须在测试里有对应断言。 */
const MAX_TITLE_LEN = 200;
const MAX_PLAIN_LEN = 500;
const MAX_PASSWORD_LEN = 512;
const MAX_SECRET_LEN = 512;
const MAX_TOTP_SECRET_LEN = 1024;
const MAX_NOTE_LEN = 4000;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 40;
const WEAK_SCORE_MAX = 1;

/* 请求体字段 → 存储密文列。totpSecret 存进 totpEnc 而不叫 secretEnc：
   secretEnc 这一列是留给 API 私钥类机密的，两者混用会让「有没有配 TOTP」这个徽标失真。 */
const ENC_FIELDS = [
  { in: 'password', column: 'passwordEnc', max: MAX_PASSWORD_LEN },
  { in: 'secret', column: 'secretEnc', max: MAX_SECRET_LEN },
  { in: 'totpSecret', column: 'totpEnc', max: MAX_TOTP_SECRET_LEN, checkTotp: true },
  { in: 'note', column: 'noteEnc', max: MAX_NOTE_LEN }
];
const PLAIN_FIELDS = [
  { in: 'title', column: 'title', max: MAX_TITLE_LEN, required: true },
  { in: 'username', column: 'username', max: MAX_PLAIN_LEN },
  { in: 'url', column: 'url', max: MAX_PLAIN_LEN },
  { in: 'folder', column: 'folder', max: MAX_PLAIN_LEN }
];
const KNOWN_BODY_KEYS = PLAIN_FIELDS.concat(ENC_FIELDS).map(function (f) { return f.in; })
  .concat(['tags']);

function httpError(message, status, extra) {
  const e = new Error(message);
  e.httpStatus = status;
  if (extra) {
    Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
  }
  return e;
}

function badRequest(message) {
  throw httpError(message, 400);
}

function pathnameOf(url) {
  let p = String(url || '');
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h !== -1) p = p.slice(0, h);
  return p;
}

function queryOf(url) {
  const q = String(url || '');
  const i = q.indexOf('?');
  return i === -1 ? '' : q.slice(i + 1);
}

/* id 只认纯数字：Number('1e3') 也能过，但那会把「拼错的 id」变成另一次合法查询 */
function parseId(seg) {
  const s = String(seg);
  if (!/^\d+$/.test(s)) badRequest('记录 id 必须是数字，收到：' + JSON.stringify(seg));
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) badRequest('记录 id 超出可表示范围：' + s);
  return n;
}

function textOf(body, field, max, required) {
  const raw = body[field.in];
  if (raw === undefined || raw === null) {
    if (required) badRequest('缺少必填字段 ' + field.in);
    return undefined;
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') badRequest(field.in + ' 必须是字符串');
  const v = String(raw).trim();
  if (required && v === '') badRequest(field.in + ' 不能为空');
  if (v.length > max) badRequest(field.in + ' 最长 ' + max + ' 字，收到 ' + v.length);
  return v;
}

/* tags 在存储层是一列自由文本（逗号分隔），这里收数组也收字符串，
   但一律拆开后校验数量与单项长度，再去重、按逗号拼回——不然「12 个上限」形同虚设。 */
function normalizeTags(raw) {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,，]/);
  const tags = [];
  for (const item of list) {
    const t = String(item).trim();
    if (t === '') continue;
    if (t.length > MAX_TAG_LEN) badRequest('单个标签最长 ' + MAX_TAG_LEN + ' 字，收到 ' + JSON.stringify(t.slice(0, 12) + '…'));
    if (tags.indexOf(t) === -1) tags.push(t);
  }
  if (tags.length > MAX_TAGS) badRequest('标签最多 ' + MAX_TAGS + ' 个，收到 ' + tags.length);
  return tags.join(',');
}

/* 存的时候就验，而不是取的时候才发现解不出码：
   base32 字符表没有 0/1/8/9，手抄错的 secret 存进去会永远得到一个「看起来正常却全错」的验证码。 */
function assertTotpShape(value) {
  const s = String(value).trim();
  if (/^otpauth:\/\//i.test(s)) {
    try {
      totp.parseOtpauthUri(s);
    } catch (e) {
      // 不回显 e.message：otpauth 的报错里带着整条 URI，那等于把 secret 抄回响应体和访问日志
      badRequest('otpauth 链接无法解析，请检查 secret 与 period/digits/algorithm 参数');
    }
    return;
  }
  let bytes;
  try {
    bytes = totp.decodeBase32(s);
  } catch (e) {
    badRequest('TOTP 密钥不是合法 base32（字符表 A–Z 与 2–7，注意不含 0/1/8/9）');
  }
  if (bytes.length < 8) badRequest('TOTP 密钥太短（解码后 ' + bytes.length + ' 字节，至少 8）');
}

/* 空串＝清除该字段（存储层缺省是 null，统一成 null 免得 '' 和 null 两种「没有」并存） */
function encryptForStorage(key, field, value) {
  if (value === null) return null;
  const text = field.checkTotp ? String(value).trim() : String(value);
  if (text === '') return null;
  if (field.checkTotp) assertTotpShape(text);
  return encryptField(key, text);
}

function buildPatch(key, body, opts) {
  const o = opts || {};
  const patch = {};
  for (const field of PLAIN_FIELDS) {
    if (body[field.in] === undefined) continue;
    const v = textOf(body, field, field.max, !!field.required && !o.partial);
    if (v !== undefined) patch[field.column] = v;
  }
  if (body.tags !== undefined) {
    const t = normalizeTags(body.tags);
    patch.tags = t === undefined ? '' : t;
  }
  for (const field of ENC_FIELDS) {
    if (body[field.in] === undefined) continue;
    const raw = body[field.in];
    if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
      badRequest(field.in + ' 必须是字符串');
    }
    if (typeof raw === 'string' && raw.length > field.max) {
      badRequest(field.in + ' 最长 ' + field.max + ' 字，收到 ' + raw.length);
    }
    patch[field.column] = encryptForStorage(key, field, raw);
  }
  return patch;
}

/* 来源标识：XFF 只取第一段（链条里最左是客户端），拿不到就退回 socket。
   这是「谁在爆破哪条记录」的键，不是身份认证，别把它当可信输入。 */
function sourceOf(req) {
  const headers = (req && req.headers) || {};
  const fwd = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  if (typeof fwd === 'string' && fwd.trim() !== '') return fwd.split(',')[0].trim();
  const real = headers['x-real-ip'] || headers['X-Real-IP'];
  if (typeof real === 'string' && real.trim() !== '') return real.trim();
  const ip = (req && req.ip) || (req && req.socket && req.socket.remoteAddress);
  return ip ? String(ip) : 'local';
}

function throttleKey(req, id, scope) {
  return 'cred:' + scope + ':' + id + '@' + sourceOf(req);
}

function audit(ctx, evt) {
  const a = ctx.vault && ctx.vault.audit;
  if (!a || typeof a.push !== 'function') return null;
  return a.push(evt);
}

/* 审计与错误详情只允许出现字段名和状态，绝不拼入口令、secret、明文片段 */
function fieldSummary(columns) {
  const names = { passwordEnc: '口令', secretEnc: '私钥', totpEnc: 'TOTP', noteEnc: '备注' };
  return columns.map(function (c) { return names[c] || c; }).join('+');
}

function readJsonBody(ctx, req) {
  return Promise.resolve(ctx.readBody(req)).then(function (body) {
    if (body === undefined || body === null || body === '') return {};
    if (typeof body !== 'object' || Array.isArray(body)) badRequest('请求体必须是 JSON 对象');
    const unknown = Object.keys(body).filter(function (k) { return KNOWN_BODY_KEYS.indexOf(k) === -1; });
    if (unknown.length) badRequest('不认识的字段：' + unknown.join('、'));
    return body;
  });
}

function notFound(ctx, res, id) {
  return ctx.bad(res, 404, '记录不存在（id ' + id + '）');
}

/* ── 路由 ─────────────────────────────────────────────────────────── */

function listAll(req, res, ctx) {
  ctx.vault.key();
  const rows = ctx.storage.listCredentials().map(function (r) { return vault.maskedCredentialView(r); });
  return ctx.json(res, 200, { credentials: rows, count: rows.length });
}

function createOne(req, res, ctx) {
  return readJsonBody(ctx, req).then(function (body) {
    const key = ctx.vault.key();
    const patch = buildPatch(key, body, {});
    if (patch.title === undefined || patch.title === '') badRequest('title 不能为空');
    const created = ctx.storage.createCredential(patch);
    if (!created) throw httpError('写入失败', 500);
    audit(ctx, {
      kind: 'create',
      target: created.id,
      status: 'ok',
      detail: fieldSummary(Object.keys(patch).filter(function (k) { return ENC_FIELDS.some(function (f) { return f.column === k; }); }))
    });
    return ctx.json(res, 201, { credential: vault.maskedCredentialView(created) });
  });
}

function readOne(req, res, ctx, id) {
  ctx.vault.key();
  const rec = ctx.storage.getCredential(id);
  if (!rec) return notFound(ctx, res, id);
  return ctx.json(res, 200, { credential: vault.maskedCredentialView(rec) });
}

function updateOne(req, res, ctx, id) {
  return readJsonBody(ctx, req).then(function (body) {
    const key = ctx.vault.key();
    const patch = buildPatch(key, body, { partial: true });
    if (Object.keys(patch).length === 0) badRequest('没有任何可更新的字段');
    if (patch.title !== undefined && patch.title === '') badRequest('title 不能为空');
    const updated = ctx.storage.updateCredential(id, patch);
    if (!updated) {
      audit(ctx, { kind: 'update', target: id, status: 'fail', detail: 'not-found' });
      return notFound(ctx, res, id);
    }
    audit(ctx, { kind: 'update', target: updated.id, status: 'ok', detail: Object.keys(patch).join('+') });
    return ctx.json(res, 200, { credential: vault.maskedCredentialView(updated) });
  });
}

function deleteOne(req, res, ctx, id) {
  ctx.vault.key();
  const removed = ctx.storage.deleteCredential(id);
  audit(ctx, { kind: 'delete', target: id, status: removed ? 'ok' : 'fail', detail: removed ? null : 'not-found' });
  if (!removed) return notFound(ctx, res, id);
  return ctx.json(res, 200, { deleted: id });
}

/* 唯一的明文出口。顺序固定：解锁 → 限流 → 取记录 → 解密。
   先 key() 再 check() 是需求写死的；副作用是「锁着的库」不会消耗限流额度，
   而爆破 id 的行为会，因为那条路径走得进 check()。 */
function revealOne(req, res, ctx, id) {
  let key;
  try {
    key = ctx.vault.key();
  } catch (e) {
    audit(ctx, { kind: 'reveal', target: id, status: 'denied', detail: 'locked' });
    throw e;
  }
  const tkey = throttleKey(req, id, 'reveal');
  const gate = ctx.throttle.check(tkey);
  if (!gate.allowed) {
    audit(ctx, { kind: 'reveal', target: id, status: 'denied', detail: 'throttled' });
    throw httpError('口令查看过于频繁，请稍后再试', 429, { retryAfterMs: gate.retryAfterMs });
  }
  const rec = ctx.storage.getCredential(id);
  if (!rec) {
    ctx.throttle.failed(tkey);
    audit(ctx, { kind: 'reveal', target: id, status: 'fail', detail: 'not-found' });
    return notFound(ctx, res, id);
  }

  const plain = {};
  const opened = [];
  for (const field of ENC_FIELDS) {
    const stored = rec[field.column];
    if (stored === null || stored === undefined || stored === '') {
      plain[field.in] = null;
      continue;
    }
    let value;
    try {
      value = decryptField(key, stored);
    } catch (e) {
      ctx.throttle.failed(tkey);
      audit(ctx, { kind: 'reveal', target: id, status: 'fail', detail: 'decrypt:' + field.in });
      throw httpError('字段无法解密（' + field.in + '）：密文损坏或主密钥已更换', 500);
    }
    plain[field.in] = value === '' ? null : value;
    if (plain[field.in] !== null) opened.push(field.in);
  }

  const touched = ctx.storage.setCredentialLastUsed(id);
  ctx.throttle.passed(tkey);
  audit(ctx, { kind: 'reveal', target: id, status: 'ok', detail: opened.join('+') || 'empty' });

  const out = {
    id: rec.id,
    title: rec.title,
    username: rec.username,
    url: rec.url,
    password: plain.password,
    secret: plain.secret,
    note: plain.note,
    totpSecret: plain.totpSecret,
    lastUsedAt: touched && touched.lastUsedAt !== undefined ? touched.lastUsedAt : (rec.lastUsedAt || null)
  };
  return ctx.json(res, 200, out, { 'Cache-Control': 'no-store' });
}

/* 密文里既可能是裸 base32，也可能整条 otpauth URI 被粘进来。
   两种都要能出码，参数以 URI 里的 period/digits/algorithm 为准。 */
function totpSpec(secretPlaintext) {
  const text = String(secretPlaintext).trim();
  if (/^otpauth:\/\//i.test(text)) {
    const p = totp.parseOtpauthUri(text);
    return { secret: p.secret, step: p.step, digits: p.digits, algorithm: p.algorithm };
  }
  return { secret: text, step: totp.DEFAULT_STEP_SECONDS, digits: totp.DEFAULT_DIGITS, algorithm: totp.DEFAULT_ALGORITHM };
}

function totpOne(req, res, ctx, id) {
  const key = ctx.vault.key();
  const tkey = throttleKey(req, id, 'totp');
  const gate = ctx.throttle.check(tkey);
  if (!gate.allowed) {
    audit(ctx, { kind: 'totp', target: id, status: 'denied', detail: 'throttled' });
    throw httpError('动态码请求过于频繁，请稍后再试', 429, { retryAfterMs: gate.retryAfterMs });
  }
  const rec = ctx.storage.getCredential(id);
  if (!rec) {
    ctx.throttle.failed(tkey);
    audit(ctx, { kind: 'totp', target: id, status: 'fail', detail: 'not-found' });
    return notFound(ctx, res, id);
  }
  if (!rec.totpEnc) {
    audit(ctx, { kind: 'totp', target: id, status: 'denied', detail: 'no-totp' });
    throw httpError('该记录没有配置 TOTP 密钥', 409);
  }
  let spec;
  let code;
  /* 解密、解析、出码三段合并在一个 try 里：任何一段的原始报错都可能带上 secret 片段，
     一律换成不含输入内容的固定文案，状态码用 422（库没坏，是这条记录存的东西不对）。 */
  try {
    spec = totpSpec(decryptField(key, rec.totpEnc));
    code = totp.generate({
      secret: spec.secret, step: spec.step, digits: spec.digits, algorithm: spec.algorithm,
      at: nowOf(ctx) / 1000
    });
  } catch (e) {
    if (e && e.httpStatus === 423) {
      audit(ctx, { kind: 'totp', target: id, status: 'denied', detail: 'locked' });
      throw e;
    }
    ctx.throttle.failed(tkey);
    audit(ctx, { kind: 'totp', target: id, status: 'fail', detail: 'decode-or-generate-error' });
    if (e && e.httpStatus && e.httpStatus < 500) throw e;
    throw httpError('TOTP 密钥无法解密或格式非法，出不了码', 422);
  }
  ctx.throttle.passed(tkey);
  audit(ctx, { kind: 'totp', target: id, status: 'ok', detail: spec.digits + '位' + spec.step + '秒' });
  return ctx.json(res, 200, {
    id: rec.id,
    title: rec.title,
    code: code,
    digits: spec.digits,
    step: spec.step,
    algorithm: spec.algorithm,
    secondsRemaining: totp.secondsRemaining(nowOf(ctx) / 1000, spec.step)
  }, { 'Cache-Control': 'no-store' });
}

function nowOf(ctx) {
  return (ctx.now ? ctx.now() : Date.now());
}

/* 健康度：账号复用清单 + 弱口令计数。输出里只有 id/title/计数/强度标签，
   口令本身一个字符都不出这道门——否则这个接口就成了把整库口令捞走的钩子。 */
function healthReport(req, res, ctx) {
  const key = ctx.vault.key();
  const records = ctx.storage.listCredentials();
  const counts = ctx.storage.credentialUsernameCounts();

  const reused = (counts || []).filter(function (c) { return c && Number(c.count) > 1; });
  const usernameReuse = reused.map(function (c) {
    const items = records.filter(function (r) { return String(r.username || '') === String(c.username); })
      .map(function (r) { return { id: r.id, title: r.title }; });
    return { username: c.username, count: Number(c.count), items: items };
  });

  const weakPasswords = [];
  const unreadable = [];
  let checked = 0;
  for (const r of records) {
    if (!r.passwordEnc) continue;
    let pw;
    try {
      pw = decryptField(key, r.passwordEnc);
    } catch (e) {
      unreadable.push({ id: r.id, title: r.title, reason: '密文无法解开' });
      continue;
    }
    const text = pw === null || pw === undefined ? '' : String(pw);
    if (text === '') continue;
    checked++;
    const ev = passgen.evaluate(text);
    if (ev.score <= WEAK_SCORE_MAX) {
      weakPasswords.push({
        id: r.id, title: r.title, score: ev.score, label: ev.label,
        bits: ev.bits, length: ev.length, reasons: ev.reasons
      });
    }
  }
  weakPasswords.sort(function (a, b) { return a.score - b.score || a.id - b.id; });

  return ctx.json(res, 200, {
    total: records.length,
    passwordChecked: checked,
    weakCount: weakPasswords.length,
    reusedUsernameCount: usernameReuse.length,
    usernameReuse: usernameReuse,
    weakPasswords: weakPasswords,
    unreadable: unreadable,
    weakScoreCeiling: WEAK_SCORE_MAX
  });
}

function route(req, res, ctx, pathname) {
  const method = String(req.method || 'GET').toUpperCase();
  const rest = pathname.slice(CREDENTIAL_PREFIX.length).replace(/^\/+/, '');
  const parts = rest === '' ? [] : rest.split('/').filter(function (s) { return s !== ''; });

  if (parts.length === 0) {
    if (method === 'GET') return listAll(req, res, ctx);
    if (method === 'POST') return createOne(req, res, ctx);
    throw httpError('方法不支持：' + method + '（/api/credentials 只接受 GET/POST）', 405);
  }
  if (parts.length === 1 && parts[0] === 'health') {
    if (method !== 'GET') throw httpError('方法不支持：' + method + '（health 只接受 GET）', 405);
    return healthReport(req, res, ctx);
  }

  const id = parseId(parts[0]);

  if (parts.length === 1) {
    if (method === 'GET') return readOne(req, res, ctx, id);
    if (method === 'PUT') return updateOne(req, res, ctx, id);
    if (method === 'DELETE') return deleteOne(req, res, ctx, id);
    throw httpError('方法不支持：' + method, 405);
  }
  if (parts.length === 2 && parts[1] === 'reveal') {
    if (method !== 'POST') throw httpError('方法不支持：' + method + '（reveal 只接受 POST）', 405);
    return revealOne(req, res, ctx, id);
  }
  if (parts.length === 2 && parts[1] === 'totp') {
    if (method !== 'GET') throw httpError('方法不支持：' + method + '（totp 只接受 GET）', 405);
    return totpOne(req, res, ctx, id);
  }
  throw httpError('没有这个凭证路由：' + pathname, 404);
}

function sendError(ctx, res, err) {
  const status = Number(err && err.httpStatus) || 500;
  const message = status >= 500 ? '服务端处理凭证请求失败' : String((err && err.message) || '请求失败');
  const extra = {};
  if (status === 429 && Number.isFinite(err.retryAfterMs)) extra.retryAfterMs = err.retryAfterMs;
  if (status >= 500 && err.retryAfterMs === undefined) extra.cause = 'internal';
  return ctx.bad(res, status, message, Object.keys(extra).length ? extra : undefined);
}

/* 命中 /api/credentials 返回 Promise（已自行应答），不命中返回 false 交给上层继续路由。 */
function handleCredentialsApi(req, res, ctx) {
  const pathname = pathnameOf(req.url);
  if (pathname !== CREDENTIAL_PREFIX && !pathname.startsWith(CREDENTIAL_PREFIX + '/')) {
    return Promise.resolve(false);
  }
  if (!ctx || !ctx.storage || !ctx.vault || !ctx.throttle || typeof ctx.json !== 'function' || typeof ctx.bad !== 'function') {
    return Promise.reject(httpError('凭证路由缺少 ctx 依赖（storage/vault/throttle/json/bad）', 500));
  }
  try {
    return Promise.resolve(route(req, res, ctx, pathname));
  } catch (err) {
    return Promise.reject(err);
  }
}

/* 上层（api.js）统一在这里收错误：423/400/404/405/409/429 都按 httpStatus 回，
   其余一律降级成 500 且不把原始 message 漏给前端。 */
function handleCredentialsApiSafe(req, res, ctx) {
  return handleCredentialsApi(req, res, ctx).then(function (handled) {
    return handled;
  }).catch(function (err) {
    if (err === false) return false;
    try {
      sendError(ctx, res, err || new Error('未知错误'));
    } catch (e) { /* ctx 已经坏了，只能吞掉 */ }
    return true;
  });
}

module.exports = {
  handleCredentialsApi: handleCredentialsApiSafe,
  sendError: sendError,
  pathnameOf: pathnameOf,
  throttleKey: throttleKey,
  sourceOf: sourceOf,
  normalizeTags: normalizeTags,
  buildPatch: buildPatch,
  totpSpec: totpSpec,
  CREDENTIAL_PREFIX: CREDENTIAL_PREFIX,
  MAX_TITLE_LEN: MAX_TITLE_LEN,
  MAX_PLAIN_LEN: MAX_PLAIN_LEN,
  MAX_PASSWORD_LEN: MAX_PASSWORD_LEN,
  MAX_SECRET_LEN: MAX_SECRET_LEN,
  MAX_TOTP_SECRET_LEN: MAX_TOTP_SECRET_LEN,
  MAX_NOTE_LEN: MAX_NOTE_LEN,
  MAX_TAGS: MAX_TAGS,
  MAX_TAG_LEN: MAX_TAG_LEN,
  WEAK_SCORE_MAX: WEAK_SCORE_MAX,
  ENC_FIELDS: ENC_FIELDS,
  PLAIN_FIELDS: PLAIN_FIELDS,
  KNOWN_BODY_KEYS: KNOWN_BODY_KEYS
};
