/* 本地网关的数据面（proxy data plane）。

   消费者令牌的第一版只能「把明文取走，自己去打厂商」——拿到 key:read 的脚本手里
   就有一把明文密钥。本模块是它的另一半：别的 OpenAI 兼容客户端（Dify / n8n /
   Claude Code / Cherry Studio）拿一把**消费者令牌**就能调用本机账号池里的厂商密钥，
   由本机转发、记审计、限流，而**永远看不到池里那把 key 的明文**。

   安全边界就是本模块存在的理由，这几条不许松：
   - 池里的 key 只在**服务端**出现：转发时用明文，响应体 / 错误消息 / 审计里都不带；
   - 审计只记元数据：令牌指纹、池 id、模型名、换了几把 key、HTTP 状态、token 用量。
     **不记 prompt、不记 messages、不记请求体**——记了就是把对话内容抄进日志；
   - 令牌列了哪些 keyId，代理就只能用这些 key；令牌没列 keyId 时才回退到
     「池里当前生效的那把」。这条回退口径与 consumer-tokens.authorize 的通例
     （空清单 = 一把都拿不到）**故意相反**，是代理专属的，理由写在这里：
     网关的语义是「按池的顺序取当前生效那把」，而授权语义是「白名单为空 = 不给」。

   ★ 消费者令牌的 payload 键集合是**签名的输入**：给 payload 加一个字段会让
     所有已签发的老令牌全部验签失败，与本项目「老令牌照旧能用」的原则冲突。
     所以新增能力只能挂到既有的 keyIds 资源清单上，不能开新字段——
     SCOPES 与 SCOPE_RESOURCE_FIELD 两张表一起加 'proxy:invoke' → 'keyIds'。
     签发 / 验签 / 授权判定全部走 consumer-tokens.js，本模块不重写任何验签逻辑。 */

const ct = require('./consumer-tokens');
const adapters = require('./adapters');
const { createDataThrottle, bearerOf, pathnameOf, STATUS_OF_REASON } = require('./consumer-api');

/* ---------- 常量 ---------- */

/* 新增能力必须与 consumer-tokens.js 的 SCOPES / SCOPE_RESOURCE_FIELD 对齐。
   两张表与用法各写一份，迟早有一边忘了改，结果是「签得出来但没人校验」的空头作用域。 */
const PROXY_SCOPE = 'proxy:invoke';

const CHAT_PATH = '/api/proxy/v1/chat/completions';
const MODELS_PATH = '/api/proxy/v1/models';
const PATH_PREFIX = '/api/proxy';

/* 请求体上限 1 MiB：与 api.js 的 readBody 同一口径（那边超了报 400，这里超了报 413）。
   1 MiB 足够放下几十万 token 的对话，又不至于让一个请求把内存吃光。 */
const MAX_BODY_BYTES = 1024 * 1024;

/* 上游超时：一次尝试 120 秒。
   理由：厂商推理本身可能跑很久（长输出 + 慢模型），adapters 那套 10 秒的默认档
   会把正常的长回答判成失败；但也不能没有上限——厂商挂住时请求必须自己结束。
   整条请求另有一个总预算 5 分钟：换 key 重试是「乘法」，没有总预算的话，
   池里 5 把 key 全挂住就是一个要等 10 分钟的请求。 */
const UPSTREAM_TIMEOUT_MS = 120 * 1000;
const TOTAL_DEADLINE_MS = 5 * 60 * 1000;

/* 上游响应体上限 8 MiB：厂商回一个超大 body 时别把它整个读进内存。 */
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

/* 限流档位：每把令牌每 60 秒最多 60 次代理请求。
   比消费者数据面（120 次 / 60 秒）更紧一档：数据面取的是本地数据，
   代理这一路**每次都在花厂商的额度**，而一个客户端脚本一分钟打几千次是很现实的。
   分桶键是令牌 tid（不是来源 IP）：脚本可能从多个 IP 来（容器、重试网关、换网），
   按 IP 分桶会误伤；按令牌分桶正好对应「一把令牌」的粒度。 */
const PROXY_MAX_REQUESTS = 60;
const PROXY_WINDOW_MS = 60 * 1000;

/* 厂商返回这些状态时换队列里的下一把重试：
   401 = 这把 key 没了/被拒；429 = 这把 key 被打满；5xx = 厂商自己出毛病。
   4xx 里其余的（400 模型不存在、404 路径错）换 key 也没用——重试只会把同一个
   错误再报一遍还给客户端看，那是在浪费额度。 */
function isRetryableStatus(status) {
  return status === 401 || status === 429 || (status >= 500 && status <= 599);
}

/* ---------- 小工具 ---------- */

function proxyError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

/* ctx.json / ctx.bad 在 api.js 里有、在 app.js 里没有（那边只有 apiRouter）。
   这里自己兜一份：模块挂到哪个入口都能应答，不靠调用方记得塞这两个函数。 */
function jsonOf(ctx) {
  if (ctx && typeof ctx.json === 'function') return ctx.json;
  return function (res, status, obj) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(obj));
  };
}

function badOf(ctx) {
  if (ctx && typeof ctx.bad === 'function') return ctx.bad;
  const json = jsonOf(ctx);
  return function (res, status, message, extra) {
    return json(res, status, Object.assign({ error: message }, extra || {}));
  };
}

/* 跨域写请求的拒绝：与 api.js 的 sameOrigin 同一判据（那边是「有 Origin 且 host 对不上」）。
   代理这一路是 POST，若不拦，任意网页都能朝本机 127.0.0.1 打一发消耗额度的请求
   （浏览器不会带 Bearer 头，但预检/配额烧掉照样是真金白银）。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host || '';
  try {
    return new URL(origin).host === host;
  } catch (e) {
    return false;
  }
}

/* 审计的 detail 是一行文本，会被界面原样显示。模型名之类字段来自**客户端请求体**
   （不可信）：不洗一遍的话，一个模型名里塞个换行就能在审计里伪造出一整行记录。 */
function safeField(v, max) {
  const s = String(v == null ? '' : v);
  return s.replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, max || 40);
}

function fpOf(fingerprint) {
  return fingerprint ? 'fp=' + fingerprint : 'fp=-';
}

function audit(ctx, entry) {
  if (!ctx.vault || !ctx.vault.audit) return;
  try { ctx.vault.audit.push(entry); } catch (e) { /* 审计旁路不许把主流程带崩 */ }
}

/* 审计只记元数据。字段顺序固定，方便事后 grep：
   fp / pool / model / tried / switched / http / usage / attempts */
function auditDetail(o) {
  const parts = [];
  parts.push(fpOf(o.fingerprint));
  if (o.poolId !== undefined && o.poolId !== null) parts.push('pool=' + o.poolId);
  if (o.model) parts.push('model=' + safeField(o.model));
  if (o.tried !== undefined) parts.push('tried=' + o.tried);
  if (o.switched !== undefined) parts.push('switched=' + o.switched);
  if (o.httpStatus !== undefined && o.httpStatus !== null) parts.push('http=' + o.httpStatus);
  if (o.usage) {
    parts.push('usage=prompt:' + o.usage.prompt + ',completion:' + o.usage.completion + ',total:' + o.usage.total);
  }
  if (o.attempts && o.attempts.length) parts.push('attempts=' + o.attempts.join(','));
  if (o.models !== undefined) parts.push('models=' + o.models);
  return parts.join(' ');
}

/* 泄密防线（最后一道）：把池里那把 key 的明文从任何要出去的文本里抹掉。
   正常路径上它根本不该出现（厂商不会回显密钥），但「不该出现」不是「不会出现」——
   万一某个中转站把 Authorization 头回显在错误体里，客户端与审计就都拿到了明文。 */
function scrubSecrets(text, secrets) {
  let out = typeof text === 'string' ? text : String(text == null ? '' : text);
  (secrets || []).forEach(function (s) {
    const v = typeof s === 'string' ? s : '';
    if (v.length < 4) return;
    out = out.split(v).join('[redacted]');
  });
  return out;
}

/* 错误摘要里再抹一层「末 4 位」：末 4 位是本项目的「掩码」，但厂商的错误体里
   没必要带它——尾巴也是密钥的一部分。 */
function scrubTail(text, secret) {
  const v = typeof secret === 'string' ? secret : '';
  if (v.length < 8) return text;
  return text.split(v.slice(-4)).join('[redacted]');
}

function parseJsonSafe(text) {
  if (typeof text !== 'string' || !text.length) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

function excerpt(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 200) : t;
}

function denyMessage(reason) {
  if (reason === 'missing') return '缺少 Authorization: Bearer <token>';
  if (reason === 'malformed') return '令牌格式不对';
  if (reason === 'bad-signature') return '令牌签名不对（不是本机签发的令牌，或密钥库数据已重建）';
  if (reason === 'expired') return '令牌已过期';
  if (reason === 'revoked') return '令牌已被吊销';
  if (reason === 'unknown') return '这把令牌不在本机的签发记录里（保险库重置过？令牌要重新签发）';
  if (reason === 'scope') return '令牌的作用域不覆盖这个能力（需要 ' + PROXY_SCOPE + '）';
  if (reason === 'locked') return '保险库未解锁，令牌无从验签';
  return '令牌校验未通过';
}

/* ---------- 鉴权门 ---------- */

/* 与 consumer-api.js 的 guard 同一套顺序：
   先确认手里有信任根（没有 DEK 就报 423，不是 401——报 401 会让消费者以为令牌坏了，
   跑去重新申请），再验签，再查签发记录（吊销看的是库里的 tid 清单，不是签名说了算）。
   唯一与数据面不同的是 scope：代理这一路固定要 proxy:invoke。 */
function guard(ctx, req, res, target) {
  const deny = function (reason, fingerprint) {
    audit(ctx, {
      kind: 'proxy', target: target, status: 'denied',
      detail: 'reason=' + reason + ' ' + fpOf(fingerprint)
    });
    return badOf(ctx)(res, STATUS_OF_REASON[reason] || 401, denyMessage(reason), { reason: reason });
  };
  if (!ctx.vault || !ctx.vault.isUnlocked()) return deny('locked');
  let dek = null;
  try { dek = ctx.vault.key(); } catch (e) { dek = null; }
  if (!dek) return deny('locked');
  const token = bearerOf(req);
  if (!token) return deny('missing');
  const v = ct.verifyToken(token, { dek: dek, scopes: PROXY_SCOPE });
  if (!v.ok) return deny(v.reason, v.fingerprint);
  const row = ctx.storage.getToken(v.payload.tid);
  if (!row) return deny('unknown', v.fingerprint);
  if (row.revokedAt) return deny('revoked', v.fingerprint);
  return { payload: v.payload, row: row, fingerprint: v.fingerprint };
}

/* ---------- 限流 ---------- */

function createProxyThrottle(opts) {
  const o = opts || {};
  return createDataThrottle({
    max: o.max, windowMs: o.windowMs, now: o.now
  });
}

/* 进程级默认桶表。ctx.proxyThrottle 存在时用它（单测要隔离），生产走这一份。
   与消费者数据面**分开一张表**：代理这一路的额度不能跟取明文的额度互相抵押。 */
const defaultProxyThrottle = createProxyThrottle({});

function proxyThrottleOf(ctx) {
  const t = ctx && ctx.proxyThrottle;
  return (t && typeof t.reserve === 'function') ? t : defaultProxyThrottle;
}

function setRetryAfter(res, retryAfterMs) {
  if (!res || typeof res.setHeader !== 'function') return false;
  const secs = Math.max(1, Math.ceil((Number(retryAfterMs) || 0) / 1000));
  try { res.setHeader('Retry-After', String(secs)); return true; } catch (e) { return false; }
}

/* ---------- 请求体 ---------- */

/* 自己读 body，不走 ctx.readBody：代理这一路要的是 413（请求体过大），
   api.js 的 readBody 超限报的是 400，而且它会把连接 destroy 掉——
   客户端收到的是「连接被重置」而不是一个能读懂的 413。
   做法：超限之后**不再缓冲**（内存安全），把剩下的数据读干净再回 413。 */
function readJsonBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const cap = limit || MAX_BODY_BYTES;
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > cap) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (over) { reject(proxyError(413, '请求体过大：代理最多接受 ' + cap + ' 字节')); return; }
      if (!chunks.length) { resolve({}); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(proxyError(400, '请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ---------- 池与候选链 ---------- */

/* 池成员顺序：当前生效那把排最前，其余按 sortIndex 排队。
   与 api.js 的 poolState 同一语义，但不 require api.js——api.js 会 require
   consumer-api.js，绕回去就成了循环依赖。老库可能一把 active 都没有，
   这时队首那把当当前生效（api.js 也是这么兜的）。 */
function orderedMembers(pool) {
  const members = (pool.members || []).slice().sort(function (a, b) {
    return (a.sortIndex || 0) - (b.sortIndex || 0) || a.keyId - b.keyId;
  });
  const active = members.filter(function (m) { return m.role === 'active'; })[0] || null;
  if (!active) return members;
  return [active].concat(members.filter(function (m) { return m.keyId !== active.keyId; }));
}

/* 健康判定与 api.js 的 keyHealth 同一口径：连续失败 ≥2 次算不健康；
   没测过的（failCount = 0）算健康——「没测过」不等于「坏了」。 */
function healthyOf(key) {
  const failCount = Number(key && key.failCount) || 0;
  return { failCount: failCount, healthy: failCount < 2 };
}

/* 这把 key 支不支持这个模型：拉过模型列表的按列表判；没拉过列表的（models 为空）
   无法排除，保留——把没拉过列表的 key 一刀切掉，等于让「没同步」变成「不可用」。 */
function supportsModel(key, model) {
  if (!model) return true;
  const models = (key && key.models) || [];
  if (!models.length) return true;
  return models.some(function (m) { return m && m.id === model; });
}

/* 令牌没列 keyId 时，按模型挑一个池：谁家的 key 声明支持这个模型就用谁家的池。
   挑不出就用编号最小的池——让厂商自己回「模型不存在」，比代理回「没池子」准。 */
function pickPool(pools, storage, model) {
  const sorted = pools.slice().sort(function (a, b) { return a.id - b.id; });
  for (const p of sorted) {
    const members = orderedMembers(p);
    if (!members.length) continue;
    const hit = members.some(function (m) {
      const k = storage.getKey(m.keyId);
      return k && supportsModel(k, model);
    });
    if (hit) return p;
  }
  return sorted[0] || null;
}

/* 候选链：令牌授权的 key，按池语义排序（当前生效那把排最前，其余按 sortIndex 排队），
   跳过连续失败 ≥2 次的。返回的每一条都带 keyId 与所属池 id——审计要记，错误消息也要说。 */
function buildChain(ctx, payload, model) {
  const storage = ctx.storage;
  const authorized = (payload.keyIds || []).slice();
  const pools = (typeof storage.listPools === 'function' ? storage.listPools() : []) || [];
  const chain = [];
  const seen = {};
  let considered = 0;
  let skippedUnhealthy = 0;

  const push = function (key, poolId, role) {
    if (!key) return;
    if (seen[key.id]) return;
    seen[key.id] = true;
    considered += 1;
    const h = healthyOf(key);
    if (!h.healthy) { skippedUnhealthy += 1; return; }
    chain.push({ key: key, poolId: poolId, role: role, failCount: h.failCount });
  };

  if (authorized.length) {
    /* 令牌列了 keyId：只能用这些 key。授权判定走 consumer-tokens 的 authorize，
       资源字段表（keyIds）由它自己管，本模块不另抄一份白名单逻辑。 */
    const usable = authorized.filter(function (id) {
      return ct.authorize(payload, { scope: PROXY_SCOPE, resourceId: id }).ok;
    });
    pools.forEach(function (pool) {
      orderedMembers(pool).forEach(function (m) {
        if (usable.indexOf(m.keyId) === -1) return;
        push(storage.getKey(m.keyId), pool.id, m.role);
      });
    });
    /* 列了 keyId 但这些 key 一把都不在池子里：它们各自当独立候选
       （没有 active/backup 语义，也就没有「备用队列」可排）。 */
    usable.forEach(function (id) {
      push(storage.getKey(id), null, 'backup');
    });
  } else {
    /* 令牌没列 keyId：回退到「池里当前生效的那把」，链长 ≤ 池内成员数。 */
    const pool = pickPool(pools, storage, model);
    if (!pool) {
      return { chain: [], poolId: null, considered: 0, skippedUnhealthy: 0, reason: 'no-pool' };
    }
    orderedMembers(pool).forEach(function (m) {
      push(storage.getKey(m.keyId), pool.id, m.role);
    });
  }

  /* 模型过滤：优先用「自己声明支持这个模型」的 key。全被排除时退回未过滤的链——
     让厂商自己回「模型不存在」，比代理回「没有可用密钥」准。 */
  const byModel = chain.filter(function (c) { return supportsModel(c.key, model); });
  const finalChain = byModel.length ? byModel : chain;
  return {
    chain: finalChain,
    poolId: finalChain.length ? finalChain[0].poolId : null,
    considered: considered,
    skippedUnhealthy: skippedUnhealthy,
    reason: finalChain.length ? null : (considered ? 'all-unhealthy' : 'no-candidate')
  };
}

/* ---------- 上游转发 ---------- */

function primaryEndpointOf(key) {
  const eps = (key && key.endpoints) || [];
  const ep = eps.length ? eps[0] : { url: (key && key.base) || '', style: adapters.inferStyle(key && key.platform) };
  return {
    url: String(ep.url || ''),
    style: ep.style === 'anthropic' ? 'anthropic' : 'openai'
  };
}

/* 对话补全的路径与 adapters 的 chatProbePath 同一口径：base 里已经带了版本前缀
   （…/v1），所以 openai 系拼 /chat/completions、anthropic 系拼 /v1/messages。 */
function chatUrl(style, base) {
  const b = String(base || '').replace(/\/+$/, '');
  return style === 'anthropic' ? b + '/v1/messages' : b + '/chat/completions';
}

/* 上游响应体也限个大小：厂商回一个超大 body 时别把它整个读进内存。 */
async function readUpstreamText(res) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    return typeof t === 'string' ? t : '';
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      chunks.push(r.value);
      if (size > MAX_UPSTREAM_BYTES) break; /* 截断：够客户端看个大概就行 */
    }
  } finally {
    try { await reader.cancel(); } catch (e) { /* 已经读完了 */ }
  }
  return Buffer.concat(chunks.map(function (c) { return Buffer.from(c); })).toString('utf8');
}

/* 一次厂商调用。返回值里**没有**明文 key：key 只进了 headers，出去的时候不留痕。 */
async function callVendor(ctx, key, body, deadlineAt) {
  const ep = primaryEndpointOf(key);
  if (!ep.url) return { error: 'no-endpoint', reason: '该密钥没有配置 Base URL，无法转发' };
  let payload = body;
  if (ep.style === 'anthropic') {
    try {
      payload = toAnthropicBody(body);
    } catch (e) {
      return { error: 'unsupported', status: e.httpStatus || 400, reason: e.message };
    }
  }
  const url = chatUrl(ep.style, ep.url);
  const headers = Object.assign(
    {},
    adapters.authHeaders(ep.style, key.key, ep.url),
    { 'Content-Type': 'application/json' }
  );
  const fetchImpl = (ctx.fetchImpl && typeof ctx.fetchImpl === 'function') ? ctx.fetchImpl : adapters.effectiveFetch;
  /* 超时档位默认是常量 UPSTREAM_TIMEOUT_MS；ctx.proxyTimeoutMs 只给测试用
     （真等两分钟验一次超时太慢）。生产路径不注入它。 */
  const timeoutMs = (ctx.proxyTimeoutMs && Number(ctx.proxyTimeoutMs) > 0)
    ? Math.floor(ctx.proxyTimeoutMs) : UPSTREAM_TIMEOUT_MS;
  const budget = Math.max(100, Math.min(timeoutMs, deadlineAt - Date.now()));
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, budget);
  let res = null;
  let text = '';
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    text = await readUpstreamText(res);
  } catch (e) {
    if (ctrl.signal.aborted) return { error: 'timeout', reason: '上游超时（' + budget + ' ms 内没有响应）' };
    return { error: 'network', reason: '网络错误：' + excerpt(e && e.message ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
  return { status: res.status, text: text, url: url, style: ep.style, contentType: res.headers && res.headers.get && res.headers.get('content-type') };
}

/* ---------- OpenAI ⇄ Anthropic 的形状转换 ---------- */

/* 内容块只认纯文本：图片/音频块本版本不转——悄悄丢掉字段发出去，
   等于让客户端以为模型「看见了」图片，其实它只收到了一句空话。 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const b of content) {
      if (typeof b === 'string') { out += b; continue; }
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') { out += b.text; continue; }
      throw proxyError(400, '本版本代理只转发纯文本内容块，不支持多模态内容（type=' + safeField(b.type, 20) + '）');
    }
    return out;
  }
  if (content === undefined || content === null) return '';
  return String(content);
}

function pickInt(a, b, fallback) {
  const n = Number(a);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const m = Number(b);
  if (Number.isFinite(m) && m > 0) return Math.floor(m);
  return fallback;
}

/* OpenAI 请求 → Anthropic 请求（/v1/messages）。只覆盖非流式的对话补全：
   工具调用（tools / tool_choice）与 tool/function 角色的消息本版本不转，
   遇到了就明说「不支持」，不能悄悄丢掉字段发出去。 */
function toAnthropicBody(body) {
  const b = body || {};
  if (b.tools || b.tool_choice || b.functions || b.function_call) {
    throw proxyError(400, '本版本代理不支持工具调用（tools / tool_choice），请改用纯对话请求');
  }
  const msgs = [];
  const systemParts = [];
  for (const m of (b.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') { systemParts.push(contentText(m.content)); continue; }
    if (m.role === 'tool' || m.role === 'function') {
      throw proxyError(400, '本版本代理不支持 tool / function 角色的消息');
    }
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: contentText(m.content) });
  }
  if (!msgs.length) throw proxyError(400, 'messages 不能为空');
  const out = {
    model: b.model,
    /* Anthropic 的 max_tokens 是必填项，OpenAI 侧可以不带：给一个保守的默认值。 */
    max_tokens: pickInt(b.max_tokens, b.max_completion_tokens, 4096),
    messages: msgs
  };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.top_p = b.top_p;
  if (typeof b.stop === 'string' && b.stop) out.stop_sequences = [b.stop];
  else if (Array.isArray(b.stop) && b.stop.length) out.stop_sequences = b.stop.slice(0, 4).map(String);
  return out;
}

function mapStopReason(reason) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'stop_sequence') return 'stop';
  return 'stop';
}

/* Anthropic 响应 → OpenAI 形状，客户端不用管上游是哪家协议。 */
function fromAnthropicBody(body, fallbackModel) {
  const b = body || {};
  const blocks = Array.isArray(b.content) ? b.content : [];
  let text = '';
  for (const blk of blocks) {
    if (blk && blk.type === 'text' && typeof blk.text === 'string') text += blk.text;
  }
  const u = b.usage || {};
  const prompt = Number.isFinite(Number(u.input_tokens)) ? Number(u.input_tokens) : 0;
  const completion = Number.isFinite(Number(u.output_tokens)) ? Number(u.output_tokens) : 0;
  return {
    id: b.id || 'chatcmpl-proxy',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: b.model || fallbackModel || '',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: mapStopReason(b.stop_reason)
    }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion
    }
  };
}

/* ---------- 用量 ---------- */

function usageOf(body) {
  if (!body || typeof body !== 'object') return null;
  const u = body.usage;
  if (!u || typeof u !== 'object') return null;
  const p = Number(u.prompt_tokens !== undefined ? u.prompt_tokens : u.input_tokens);
  const c = Number(u.completion_tokens !== undefined ? u.completion_tokens : u.output_tokens);
  if (!Number.isFinite(p) && !Number.isFinite(c)) return null;
  const prompt = Number.isFinite(p) ? p : 0;
  const completion = Number.isFinite(c) ? c : 0;
  const t = Number(u.total_tokens);
  return {
    prompt: prompt,
    completion: completion,
    total: Number.isFinite(t) ? t : prompt + completion
  };
}

/* ---------- 路由 ---------- */

async function handleChat(ctx, req, res) {
  const bad = badOf(ctx);
  const json = jsonOf(ctx);
  const target = CHAT_PATH;
  const authed = guard(ctx, req, res, target);
  if (!authed) return true;

  let body = null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    const status = e.httpStatus || 400;
    audit(ctx, {
      kind: 'proxy', target: target, status: 'denied',
      detail: 'body-' + status + ' ' + fpOf(authed.fingerprint)
    });
    if (status === 413) return bad(res, 413, e.message, { maxBodyBytes: MAX_BODY_BYTES });
    return bad(res, status, e.message);
  }

  /* 流式本版本不做：明说，别让客户端拿着一份非流式结果当流式用
     （Dify 之类的客户端会一直等 SSE，最后自己超时）。 */
  if (body && body.stream === true) {
    audit(ctx, {
      kind: 'proxy', target: target, status: 'denied',
      detail: 'stream-unsupported ' + fpOf(authed.fingerprint)
    });
    return bad(res, 400, '本版本暂不支持流式（stream=true）：请把 stream 关掉后重试', { streamSupported: false });
  }

  const model = body && typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) return bad(res, 400, '缺少 model：OpenAI 兼容的对话补全必须带 model');

  /* 限流门在鉴权之后、碰厂商之前：超了额度就别去发厂商请求（那是要花钱的）。 */
  const gate = proxyThrottleOf(ctx).reserve(authed.row.tid);
  if (!gate.allowed) {
    audit(ctx, {
      kind: 'proxy', target: target, status: 'denied',
      detail: 'throttled ' + fpOf(authed.fingerprint)
    });
    setRetryAfter(res, gate.retryAfterMs);
    return bad(res, 429, '代理请求过于频繁，请稍后再试', { retryAfterMs: gate.retryAfterMs });
  }

  const plan = buildChain(ctx, authed.payload, model);
  if (!plan.chain.length) {
    const why = plan.reason === 'all-unhealthy'
      ? '候选密钥全部健康检查未通过（连续失败 ≥2 次）'
      : (plan.reason === 'no-pool' ? '本机没有可用的账号池' : '令牌授权范围内没有可用密钥');
    audit(ctx, {
      kind: 'proxy', target: target, status: 'fail',
      detail: auditDetail({ fingerprint: authed.fingerprint, model: model, tried: 0, switched: 0, attempts: [] })
    });
    return bad(res, 502, '没有可用的密钥：' + why, { tried: 0, attempts: [], model: model });
  }

  const deadlineAt = Date.now() + TOTAL_DEADLINE_MS;
  const attempts = [];
  let last = null;

  for (let i = 0; i < plan.chain.length; i++) {
    const cand = plan.chain[i];
    const r = await callVendor(ctx, cand.key, body, deadlineAt);
    last = r;
    if (r.error) {
      /* 超时 / 网络错误也换下一把：这把 key 挂住不该拖死整个请求。 */
      attempts.push({ keyId: cand.key.id, status: null, reason: r.reason });
      if (r.error === 'unsupported') {
        audit(ctx, {
          kind: 'proxy', target: target, status: 'fail',
          detail: auditDetail({
            fingerprint: authed.fingerprint, poolId: cand.poolId, model: model,
            tried: attempts.length, switched: attempts.length - 1, httpStatus: r.status || null,
            attempts: attempts.map(statusOfAttempt)
          })
        });
        return bad(res, r.status || 400, r.reason, { tried: attempts.length, model: model });
      }
      continue;
    }
    if (isRetryableStatus(r.status)) {
      attempts.push({
        keyId: cand.key.id,
        status: r.status,
        reason: 'HTTP ' + r.status,
        upstream: scrubTail(scrubSecrets(excerpt(r.text), [cand.key.key]), cand.key.key)
      });
      continue; /* 换队列里的下一把 */
    }

    /* 成功（2xx）或不可重试的 4xx：原样透传给客户端。
       透传前仍要过一遍泄密防线——厂商的回显不该把 key 带给客户端。 */
    const raw = scrubSecrets(r.text, [cand.key.key]);
    const parsed = parseJsonSafe(raw);
    let outBody = raw;
    let outType = r.contentType && /json/i.test(r.contentType)
      ? r.contentType : 'application/json; charset=utf-8';
    if (r.style === 'anthropic' && parsed) {
      outBody = JSON.stringify(fromAnthropicBody(parsed, model));
      outType = 'application/json; charset=utf-8';
    }
    const usage = usageOf(parsed);
    attempts.push({ keyId: cand.key.id, status: r.status, reason: 'HTTP ' + r.status });
    audit(ctx, {
      kind: 'proxy', target: target, status: 'ok',
      detail: auditDetail({
        fingerprint: authed.fingerprint, poolId: cand.poolId, model: model,
        tried: attempts.length, switched: attempts.length - 1, httpStatus: r.status, usage: usage
      })
    });
    if (ctx.storage && typeof ctx.storage.setTokenLastUsed === 'function') {
      try { ctx.storage.setTokenLastUsed(authed.row.tid); } catch (e) { /* 记账失败不许把主流程带崩 */ }
    }
    if (ctx.vault && typeof ctx.vault.touch === 'function') {
      try { ctx.vault.touch(); } catch (e) { /* 续期失败不影响应答 */ }
    }
    res.writeHead(r.status, { 'Content-Type': outType, 'Cache-Control': 'no-store' });
    res.end(outBody);
    return true;
  }

  /* 链走完还是没成：502，并把「试了几把、都是什么原因」说清楚——
     说成「成功」或者糊一句「上游错误」都是在骗调用方。 */
  audit(ctx, {
    kind: 'proxy', target: target, status: 'fail',
    detail: auditDetail({
      fingerprint: authed.fingerprint, poolId: plan.poolId, model: model,
      tried: attempts.length, switched: Math.max(0, attempts.length - 1), httpStatus: null,
      attempts: attempts.map(statusOfAttempt)
    })
  });
  return bad(res, 502, '上游全部失败：试了 ' + attempts.length + ' 把密钥，都没能完成这次请求', {
    tried: attempts.length,
    attempts: attempts,
    model: model
  });
}

function statusOfAttempt(a) {
  return a.status === null || a.status === undefined ? 'err' : String(a.status);
}

/* GET /api/proxy/v1/models：列出「令牌授权的那几把 key 支持的模型」。
   数据源是库里存着的模型列表（不是现拉）：现拉要朝厂商发请求，
   而一个「列模型」的接口被脚本轮询起来，那又是一笔看不见的花销。 */
function handleModels(ctx, req, res) {
  const json = jsonOf(ctx);
  const target = MODELS_PATH;
  const authed = guard(ctx, req, res, target);
  if (!authed) return true;

  const gate = proxyThrottleOf(ctx).reserve(authed.row.tid);
  if (!gate.allowed) {
    audit(ctx, {
      kind: 'proxy', target: target, status: 'denied',
      detail: 'throttled ' + fpOf(authed.fingerprint)
    });
    setRetryAfter(res, gate.retryAfterMs);
    return badOf(ctx)(res, 429, '代理请求过于频繁，请稍后再试', { retryAfterMs: gate.retryAfterMs });
  }

  const keys = modelsSourceKeys(ctx, authed.payload);
  const data = [];
  const seen = {};
  for (const k of keys) {
    const created = Math.floor((Date.parse(k.createdAt) || 0) / 1000);
    for (const m of (k.models || [])) {
      if (!m || !m.id || seen[m.id]) continue;
      seen[m.id] = true;
      data.push({
        id: m.id,
        object: 'model',
        created: created,
        owned_by: k.platform || 'aegislens'
      });
    }
  }
  audit(ctx, {
    kind: 'proxy', target: target, status: 'ok',
    detail: auditDetail({ fingerprint: authed.fingerprint, models: data.length })
  });
  return json(res, 200, { object: 'list', data: data });
}

/* 模型列表的取数范围：令牌列了 keyId 就用这些；没列就用各池「当前生效那把」——
   与对话补全同一套回退口径。 */
function modelsSourceKeys(ctx, payload) {
  const storage = ctx.storage;
  const authorized = (payload.keyIds || []).slice();
  if (authorized.length) {
    const out = [];
    for (const id of authorized) {
      if (!ct.authorize(payload, { scope: PROXY_SCOPE, resourceId: id }).ok) continue;
      const k = storage.getKey(id);
      if (k) out.push(k);
    }
    return out;
  }
  const pools = (typeof storage.listPools === 'function' ? storage.listPools() : []) || [];
  const out = [];
  const seen = {};
  pools.forEach(function (p) {
    const ordered = orderedMembers(p);
    const current = ordered.filter(function (m) { return m.role === 'active'; })[0] || ordered[0];
    if (!current || seen[current.keyId]) return;
    seen[current.keyId] = true;
    const k = storage.getKey(current.keyId);
    if (k) out.push(k);
  });
  return out;
}

/* ---------- 分发 ---------- */

function handles(path) {
  return path.indexOf(PATH_PREFIX) === 0;
}

/* 入口形状与 consumer-api 的 handleConsumerApi 一致：认不出的路径返回 false，
   让调用方继续往下走；认出来了就自己应答并返回 true。 */
async function handleProxyApi(req, res, ctx) {
  const path = pathnameOf(req);
  if (!handles(path)) return false;
  const bad = badOf(ctx);
  const method = req.method;

  if (method !== 'GET' && !sameOrigin(req)) {
    audit(ctx, { kind: 'proxy', target: path, status: 'denied', detail: 'cross-origin' });
    return bad(res, 403, '拒绝跨域写请求');
  }

  if (method === 'POST' && path === CHAT_PATH) {
    await handleChat(ctx, req, res);
    return true;
  }
  if (method === 'GET' && path === MODELS_PATH) {
    handleModels(ctx, req, res);
    return true;
  }
  if (path === CHAT_PATH || path === MODELS_PATH) {
    return bad(res, 405, '这个路径不接受 ' + method + ' 方法', {
      allow: path === CHAT_PATH ? 'POST' : 'GET'
    });
  }
  return bad(res, 404, '接口不存在');
}

module.exports = {
  handleProxyApi: handleProxyApi,
  PROXY_SCOPE: PROXY_SCOPE,
  CHAT_PATH: CHAT_PATH,
  MODELS_PATH: MODELS_PATH,
  MAX_BODY_BYTES: MAX_BODY_BYTES,
  UPSTREAM_TIMEOUT_MS: UPSTREAM_TIMEOUT_MS,
  TOTAL_DEADLINE_MS: TOTAL_DEADLINE_MS,
  MAX_UPSTREAM_BYTES: MAX_UPSTREAM_BYTES,
  PROXY_MAX_REQUESTS: PROXY_MAX_REQUESTS,
  PROXY_WINDOW_MS: PROXY_WINDOW_MS,
  createProxyThrottle: createProxyThrottle,
  toAnthropicBody: toAnthropicBody,
  fromAnthropicBody: fromAnthropicBody,
  scrubSecrets: scrubSecrets,
  buildChain: buildChain,
  orderedMembers: orderedMembers
};
