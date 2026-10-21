/* 本机 AI agent token 计量的 HTTP 层：把 token-usage.js 的采集结果整理成稳定的 JSON。
 *
 * 采集与聚合逻辑全在 token-usage.js 里（只读打开 sqlite、不出任何会话内容），
 * 这一层只做四件事：
 *   ① 路由与状态码：锁着 423、超频 429、参数不合法 400，其余一律 200；
 *   ② 形状：整理成 byDay / byModel / byAgent / totals 这套固定字段，界面不用再猜口径；
 *   ③ 脱敏：任何绝对路径都不许出响应（sqlite 的报错里可能带本机用户名）；
 *   ④ 短缓存：界面轮询时别每次都去扫那 1 GB 的库。
 *
 * ★ 降级是硬要求：本机这些数据源随时会改格式，库也可能正被别的进程占着打不开。
 *   采集失败不许 500 崩掉整个接口 —— 降级成空结果 + 一个说明字段（degraded / error），
 *   让界面能「优雅地说不出」而不是整页报错。
 *
 * ★ 只出聚合数字：响应里只有 token 数、成本、模型名、agent 名。
 *   会话标题、对话正文、会话 id 一概不出。token-usage.js 已经不读它们，这一层也不再引入。
 *
 * ★ 保险库锁着要 423：这条接口答的是「你本机在用什么」，裸奔不合适。
 */

'use strict';

const usage = require('./token-usage');
/* 滑窗限流复用 consumer-api.js 那套（不另造轮子）：按来源分桶，
   任何连续 60 秒内不超过额度的请求数。桶只在内存里，进程重启即清零（与现有限流一致，不落盘）。 */
const { createDataThrottle } = require('./consumer-api');

const PATH = '/api/local-usage';
/* 天数上下限跟 token-usage.js 对齐，免得接口与 CLI 报出来的窗口不一样 */
const DEFAULT_DAYS = usage.DEFAULT_DAYS;
const MAX_DAYS = 3650;
/* 短缓存 5 秒：界面轮询时不用每次都去扫那 1 GB 的库 */
const CACHE_TTL_MS = 5000;
/* 缓存条目上限：days 是调用方给的，能取 1..3650，不封顶的话一轮恶意轮询就能把内存塞满。
   每条都存着一份完整结果，8 条足够覆盖界面常用的几个窗口。 */
const CACHE_MAX_ENTRIES = 8;
/* 限流档位：每来源 60 秒 60 次。界面轮询（5 秒一次 = 12 次/分）远够用，
   本机脚本想拿它去反复扫库就会撞上 429。 */
const THROTTLE_MAX = 60;
const THROTTLE_WINDOW_MS = 60 * 1000;

/* 一个用量桶里有哪些字段（除分组键外全是数字） */
const BUCKET_FIELDS = [
  'requests', 'inputTokens', 'outputTokens', 'reasoningTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd'
];

/* ══════════════════════════════════════════════════════════════════
 * 一、HTTP 小工具
 * ══════════════════════════════════════════════════════════════════ */

function pathnameOf(req) {
  return new URL(req.url, 'http://127.0.0.1').pathname;
}

function queryOf(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').searchParams;
  } catch (e) {
    return new URLSearchParams('');
  }
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* 与 api.js 里 sameOrigin 同一套判据：Origin 头在，且它的 host 与 Host 头不一致 ⇒ 跨域。
   写请求必须同源；读接口没有 CORS 头，浏览器本来也拿不到别人的响应。 */
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

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* Retry-After 头（秒）用标准写法给出；响应体里同时给毫秒级的 retryAfterMs。
   res 不是真正的 ServerResponse 时（单测的假 res 没有 setHeader）就跳过这个头，
   不能因为加个头把整个应答搞崩。 */
function setRetryAfter(res, retryAfterMs) {
  if (!res || typeof res.setHeader !== 'function') return false;
  const secs = Math.max(1, Math.ceil((Number(retryAfterMs) || 0) / 1000));
  try { res.setHeader('Retry-After', String(secs)); return true; } catch (e) { return false; }
}

function isTrue(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/* ══════════════════════════════════════════════════════════════════
 * 二、脱敏：绝对路径一律换成 '~'
 * ══════════════════════════════════════════════════════════════════
 * sqlite 打不开时的报错可能把库文件的绝对路径带出来（那里面就有本机用户名）。
 * 输出里只允许出现 '~' 开头的相对写法。 */

/* 前缀要求一个非单词字符：否则 "https://x" 里的 "s:/" 会被当成盘符吃掉 */
function scrub(text, root) {
  let s = (text === undefined || text === null) ? '' : String(text);
  if (root) s = s.split(root).join('~');
  s = s.replace(/(^|[\s(\[=:'"])([A-Za-z]):[\\/][^\s"'<>|]*/g, '$1~');
  s = s.replace(/(^|[\s(\[=:'"])(\\\\[^\s"'<>|]*)/g, '$1~');
  return s;
}

/* ══════════════════════════════════════════════════════════════════
 * 三、形状：把采集结果整理成稳定字段
 * ══════════════════════════════════════════════════════════════════ */

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

function zeroBucket() {
  return {
    requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0
  };
}

/* 把多个数据源的同名分组并成一份：分组键（日期/模型/agent）相同就加到一起。
   界面要看的是「这天/这个模型一共花了多少」，不是「这个源花了多少」。 */
function mergeByKey(lists, keyName) {
  const map = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || row[keyName] === undefined || row[keyName] === null) continue;
      const key = String(row[keyName]);
      let cur = map.get(key);
      if (!cur) {
        cur = zeroBucket();
        cur.key = key;
        map.set(key, cur);
      }
      for (const f of BUCKET_FIELDS) cur[f] += (Number(row[f]) || 0);
    }
  }
  const out = [];
  map.forEach(function (b) {
    const o = {};
    o[keyName] = b.key;
    for (const f of BUCKET_FIELDS) o[f] = (f === 'costUsd') ? round6(b[f]) : b[f];
    out.push(o);
  });
  return out;
}

function sortBuckets(list, keyName, dir) {
  const arr = list.slice();
  arr.sort(function (a, b) {
    if (dir === 'asc') return String(a[keyName]).localeCompare(String(b[keyName]));
    const d = b.totalTokens - a.totalTokens;
    return d !== 0 ? d : String(a[keyName]).localeCompare(String(b[keyName]));
  });
  return arr;
}

/* 消耗类数据源（MiniMax Code / cc-switch）的对外形状 */
function consumptionView(src, root) {
  const v = {
    id: src.id,
    name: src.name,
    kind: src.kind,
    available: !!src.available,
    location: scrub(src.location, root)
  };
  if (src.available) {
    v.rows = Number(src.rows) || 0;
    if (src.tsUnit) v.tsUnit = src.tsUnit;
    if (src.detail) v.detail = scrub(src.detail, root);
  } else {
    v.reason = scrub(src.reason, root);
  }
  return v;
}

/* 上下文占用类数据源（WorkBuddy）的对外形状 */
function contextView(src, root) {
  const v = {
    id: src.id,
    name: src.name,
    kind: src.kind,
    available: !!src.available,
    location: scrub(src.location, root)
  };
  if (src.available) {
    v.files = Number(src.files) || 0;
    v.conversations = Number(src.conversations) || 0;
    v.updatedInWindow = Number(src.updatedInWindow) || 0;
    v.total = {
      conversations: Number(src.conversations) || 0,
      used: Number(src.total && src.total.used) || 0,
      size: Number(src.total && src.total.size) || 0,
      remaining: Number(src.total && src.total.remaining) || 0
    };
  } else {
    v.reason = scrub(src.reason, root);
  }
  return v;
}

/* 上下文占用：跨来源合并。它是「此刻占了多少窗口」的快照，
   和消耗口径是两个东西，**不许**混进 byDay/byModel/totals。 */
function mergeContext(sources, root) {
  const out = {
    available: false,
    files: 0,
    conversations: 0,
    updatedInWindow: 0,
    used: 0,
    size: 0,
    remaining: 0,
    byModel: [],
    byDay: [],
    byCategory: []
  };
  const avail = sources.filter(function (s) { return s && s.available; });
  if (!avail.length) return out;
  out.available = true;

  const modelMap = new Map();
  const dayMap = new Map();
  const catMap = new Map();

  for (const s of avail) {
    out.files += Number(s.files) || 0;
    out.conversations += Number(s.conversations) || 0;
    out.updatedInWindow += Number(s.updatedInWindow) || 0;
    const t = s.total || {};
    out.used += Number(t.used) || 0;
    out.size += Number(t.size) || 0;
    out.remaining += Number(t.remaining) || 0;

    for (const m of (s.byModel || [])) {
      const k = String(m.model);
      let cur = modelMap.get(k);
      if (!cur) {
        cur = { model: k, conversations: 0, used: 0, size: 0, remaining: 0 };
        modelMap.set(k, cur);
      }
      cur.conversations += Number(m.conversations) || 0;
      cur.used += Number(m.used) || 0;
      cur.size += Number(m.size) || 0;
      cur.remaining += Number(m.remaining) || 0;
    }
    for (const d of (s.byDay || [])) {
      const k = String(d.date);
      let cur = dayMap.get(k);
      if (!cur) { cur = { date: k, conversations: 0, used: 0, size: 0 }; dayMap.set(k, cur); }
      cur.conversations += Number(d.conversations) || 0;
      cur.used += Number(d.used) || 0;
      cur.size += Number(d.size) || 0;
    }
    for (const c of (s.byCategory || [])) {
      const k = String(c.category);
      catMap.set(k, (catMap.get(k) || 0) + (Number(c.tokens) || 0));
    }
  }

  out.byModel = Array.from(modelMap.values()).sort(function (a, b) {
    return b.used - a.used || String(a.model).localeCompare(String(b.model));
  });
  out.byDay = Array.from(dayMap.values()).sort(function (a, b) {
    return String(a.date).localeCompare(String(b.date));
  });
  out.byCategory = Array.from(catMap.entries()).map(function (e) {
    return { category: e[0], tokens: e[1] };
  }).sort(function (a, b) { return b.tokens - a.tokens || String(a.category).localeCompare(String(b.category)); });

  return out;
}

/* 采集结果 → 响应体 */
function shapeResult(raw, opts) {
  const o = opts || {};
  const root = o.root || null;
  const r = raw || {};
  const consumption = r.consumption || { sources: [], total: zeroBucket() };
  const context = r.context || { sources: [] };
  const cSources = Array.isArray(consumption.sources) ? consumption.sources : [];
  const xSources = Array.isArray(context.sources) ? context.sources : [];

  /* 探测到的全部数据源（消耗类 + 上下文占用类） */
  const sources = [];
  for (const s of cSources) sources.push(consumptionView(s, root));
  for (const s of xSources) sources.push(contextView(s, root));

  /* 只把**可用**的消耗类来源加总：不可用的源本来就是空的，
     加进去只是多一遍零。 */
  const availC = cSources.filter(function (s) { return s && s.available; });
  const byDay = sortBuckets(mergeByKey(availC.map(function (s) { return s.byDay; }), 'date'), 'date', 'asc');
  const byModel = sortBuckets(mergeByKey(availC.map(function (s) { return s.byModel; }), 'model'), 'model', 'desc');
  const byAgent = sortBuckets(mergeByKey(availC.map(function (s) { return s.byAgent; }), 'agent'), 'agent', 'desc');

  const t = consumption.total || zeroBucket();
  const totals = {};
  BUCKET_FIELDS.forEach(function (f) {
    totals[f] = (f === 'costUsd') ? round6(t[f]) : (Number(t[f]) || 0);
  });

  const out = {
    days: Number(r.days) || 0,
    generatedAt: r.generatedAt || null,
    range: r.range || null,
    availableSources: Number(r.availableSources) || 0,
    sources: sources,
    byDay: byDay,
    byModel: byModel,
    byAgent: byAgent,
    totals: totals,
    context: mergeContext(xSources, root)
  };

  /* sources=1 时额外给出「探测到哪些、哪些不可用」 */
  if (o.wantSources) {
    out.detected = {
      available: sources.filter(function (s) { return s.available; }),
      unavailable: (Array.isArray(r.unavailable) ? r.unavailable : []).map(function (u) {
        return { id: u.id, name: u.name, reason: scrub(u.reason, root) };
      })
    };
  }
  return out;
}

/* 采集彻底失败时的降级体：空结果 + 说明字段，状态码仍是 200 */
function degradedBody(days, err, root) {
  const nowMs = Date.now();
  const sinceMs = usage.startOfWindowMs(new Date(nowMs), days);
  return {
    days: days,
    generatedAt: new Date(nowMs).toISOString(),
    range: { since: usage.dayKeyFromMs(sinceMs), until: usage.dayKeyFromMs(nowMs) },
    availableSources: 0,
    sources: [],
    byDay: [],
    byModel: [],
    byAgent: [],
    totals: zeroBucket(),
    context: {
      available: false, files: 0, conversations: 0, updatedInWindow: 0,
      used: 0, size: 0, remaining: 0, byModel: [], byDay: [], byCategory: []
    },
    degraded: true,
    error: scrub('采集失败：' + (err && err.message ? err.message : String(err)), root)
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 四、装配
 * ══════════════════════════════════════════════════════════════════ */

function createLocalUsageApi(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const cacheTtlMs = (Number.isFinite(o.cacheTtlMs) && o.cacheTtlMs >= 0) ? o.cacheTtlMs : CACHE_TTL_MS;
  const root = o.root || null;
  /* 采集器：默认走 token-usage.js（它自己只读打开 sqlite、用完 close）。
     测试注入一个指向临时目录假数据的采集器 —— 真机上那份库有 1 GB 且正在被写，
     测试绝不能去碰它。 */
  const collect = (typeof o.collect === 'function') ? o.collect : function (params) {
    return usage.collectUsage({ days: params.days, root: root || undefined });
  };
  const throttle = o.throttle || createDataThrottle({ max: THROTTLE_MAX, windowMs: THROTTLE_WINDOW_MS });
  /* 进程级短缓存：只在内存里，进程重启即清（与本项目现有限流一致，不落盘） */
  const cache = new Map();

  function collectCached(days) {
    const key = String(days);
    const hit = cache.get(key);
    const t = now();
    if (hit && (t - hit.at) < cacheTtlMs) return hit.raw;
    const raw = collect({ days: days, root: root });
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { at: t, raw: raw });
    return raw;
  }

  function handle(req, res) {
    if (pathnameOf(req) !== PATH) return false;

    if (req.method !== 'GET') {
      if (!sameOrigin(req)) {
        json(res, 403, { error: '拒绝跨域写请求' });
        return true;
      }
      json(res, 405, { error: '只支持 GET' });
      return true;
    }

    const q = queryOf(req);
    const rawDays = q.get('days');
    let days = DEFAULT_DAYS;
    if (rawDays !== null && rawDays !== '') {
      const n = Number(rawDays);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
        json(res, 400, { error: 'days 必须是 1 到 ' + MAX_DAYS + ' 之间的整数' });
        return true;
      }
      days = n;
    }
    const wantSources = isTrue(q.get('sources'));

    /* 保险库锁着 ⇒ 423：这条接口答的是「你本机在用什么」，裸奔不合适 */
    if (!o.vault || !o.vault.isUnlocked()) {
      json(res, 423, { error: '保险库未解锁' });
      return true;
    }

    /* 限流门在 423 之后：锁着的时候不必消耗额度（与 consumer-api.js 的次序一致） */
    const gate = throttle.reserve(clientIp(req));
    if (!gate.allowed) {
      setRetryAfter(res, gate.retryAfterMs);
      json(res, 429, { error: '请求过于频繁，请稍后再试', retryAfterMs: gate.retryAfterMs });
      return true;
    }

    let raw = null;
    let failure = null;
    try {
      raw = collectCached(days);
    } catch (e) {
      failure = e;
    }
    if (failure) {
      /* 降级而不是 500：本机数据源随时会变格式，接口要能「优雅地说不出」 */
      json(res, 200, degradedBody(days, failure, root));
      return true;
    }

    json(res, 200, shapeResult(raw, { root: root, wantSources: wantSources }));
    /* 真读到了数据才算「人还在用」（与 api.js 的续期规则一致） */
    if (o.vault && o.vault.touch) o.vault.touch();
    return true;
  }

  return {
    handle: handle,
    /* 只有测试与排障会用：清掉缓存与统计 */
    clearCache: function () { cache.clear(); },
    stats: function () { return { size: cache.size }; }
  };
}

module.exports = {
  PATH: PATH,
  DEFAULT_DAYS: DEFAULT_DAYS,
  MAX_DAYS: MAX_DAYS,
  CACHE_TTL_MS: CACHE_TTL_MS,
  THROTTLE_MAX: THROTTLE_MAX,
  THROTTLE_WINDOW_MS: THROTTLE_WINDOW_MS,
  createLocalUsageApi: createLocalUsageApi,
  shapeResult: shapeResult,
  degradedBody: degradedBody,
  scrub: scrub
};
