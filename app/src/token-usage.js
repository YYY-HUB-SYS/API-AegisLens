/* 本机 AI agent 的 token 计量：把各个 agent 自己记的用量汇总成「今天/这周烧了多少、花了多少钱」。
 *
 * 为什么单开一个模块：这是个**只读的旁路统计器**，不参与 API-AegisLens 的任何业务读写。
 * 它读的是别的 agent（MiniMax Code / cc-switch / WorkBuddy AI）落在本机磁盘上的数据文件，
 * 只出聚合数字，不碰任何会话内容。
 *
 * ★ 合规边界（已定，不再逐次询问）：
 *   ① 本机自读 —— 读的是本机磁盘上自己账号产生的文件，不联网、不外传、不上传；
 *   ② 只出数字 —— 输出里只有 token 数、成本、模型名、agent 名；
 *   ③ 不落内容 —— 不把读到的会话标题/消息正文写进文件、日志或返回值；
 *   ④ 只读打开 —— sqlite 一律 readOnly:true，用完 close()，绝不对别人的库执行任何写操作。
 *   在这个边界内，「本机自读 + 只出聚合数字」是可接受的；越过这条线（读正文、外传）才是不允许的。
 *
 * ★ 两种口径必须分开呈现，不能混成一个数：
 *   消耗类（consumption）：调用真的烧掉了多少 token、花了多少钱 —— MiniMax Code 的 token_usage、cc-switch 的代理记账。
 *   上下文占用类（context）：某个会话**此刻**占了多少上下文窗口、还剩多少能放 —— WorkBuddy 的 conversationContextUsage。
 *   把后者当成「花费」是错的：它是一次快照，不是累加量（用户可能一句话都没再发）。
 *
 * ★ 时间戳单位不猜：先取 MAX(ts) 按数量级判定秒/毫秒/微秒/纳秒，再统一换算成毫秒做按天分组。
 *   （2026-10-21 的秒级 ≈ 1.79e9、毫秒 ≈ 1.79e12、微秒 ≈ 1.79e15。）
 *
 * ★ 数据根目录可注入：collectUsage({ root }) —— root 顶替 %USERPROFILE%。
 *   测试靠它指向临时目录里的假数据，不依赖本机真实数据，也不会在别人机器上红。 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;
/* 每批拉多少行：既限内存（万级行 × 十几列会占不少），也避免一次性 SELECT 整张大表 */
const MAX_BATCH = 20000;
/* 找 WorkBuddy 那份 json 的最大目录深度（实测层级不固定） */
const WORKBUDDY_MAX_DEPTH = 8;
/* 未知值统一显示成这个，别让 null 混进表格里 */
const UNKNOWN = '(未记录)';

/* ══════════════════════════════════════════════════════════════════
 * 一、时间戳单位与日期
 * ══════════════════════════════════════════════════════════════════ */

/* 按数量级判单位：秒 ≈ 1.8e9、毫秒 ≈ 1.8e12、微秒 ≈ 1.8e15、纳秒 ≈ 1.8e18 */
function detectTsUnit(maxTs) {
  const v = Number(maxTs);
  if (!Number.isFinite(v) || v <= 0) return 'ms';
  if (v >= 1e17) return 'ns';
  if (v >= 1e14) return 'us';
  if (v >= 1e11) return 'ms';
  return 'sec';
}

/* 换算成毫秒要「乘」，从毫秒换回原单位要「除」—— 两个方向别搞混 */
const TO_MS = { sec: 1000, ms: 1, us: 0.001, ns: 0.000001 };
const PER_MS = { sec: 0.001, ms: 1, us: 1000, ns: 1000000 };

/* 统一换算成毫秒；换不出来（null/NaN）返回 null，调用方按「这条没有时间」处理 */
function tsToMs(ts, unit) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (TO_MS[unit] || 1));
}

/* 本地时区的 YYYY-MM-DD（用本地字段拼，跨夏令时也不会串天） */
function dayKeyFromMs(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/* 最近 N 天（含今天）的起点：今天零点往前推 N-1 天，本地构造避开时区/DST 边界 */
function startOfWindowMs(now, days) {
  const d = new Date(now.getTime());
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1), 0, 0, 0, 0).getTime();
}

/* ══════════════════════════════════════════════════════════════════
 * 二、聚合用的桶
 * ══════════════════════════════════════════════════════════════════ */

function newBucket() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0
  };
}

function addUsage(bucket, row) {
  /* row.requests 存在就用它（cc-switch 的日聚合是「一批请求」而不是一行一请求） */
  bucket.requests += (row.requests === undefined || row.requests === null)
    ? 1
    : (Number(row.requests) || 0);
  bucket.inputTokens += row.inputTokens || 0;
  bucket.outputTokens += row.outputTokens || 0;
  bucket.reasoningTokens += row.reasoningTokens || 0;
  bucket.cacheReadTokens += row.cacheReadTokens || 0;
  bucket.cacheWriteTokens += row.cacheWriteTokens || 0;
  bucket.costUsd += row.costUsd || 0;
  return bucket;
}

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

/* 合计 = 输入 + 输出 + 推理 + 缓存读 + 缓存写
 * （缓存读写是独立的计数器，不并进输入；这个「合计」是计数口径，不是计费口径） */
function finalizeBucket(bucket, keyName, key) {
  const out = {};
  if (keyName) { out[keyName] = key; }
  out.requests = bucket.requests;
  out.inputTokens = bucket.inputTokens;
  out.outputTokens = bucket.outputTokens;
  out.reasoningTokens = bucket.reasoningTokens;
  out.cacheReadTokens = bucket.cacheReadTokens;
  out.cacheWriteTokens = bucket.cacheWriteTokens;
  out.totalTokens = bucket.inputTokens + bucket.outputTokens + bucket.reasoningTokens
    + bucket.cacheReadTokens + bucket.cacheWriteTokens;
  out.costUsd = round6(bucket.costUsd);
  return out;
}

/* 把 {key -> bucket} 变成数组并排序 */
function bucketList(map, keyName, sortBy) {
  const arr = [];
  for (const [key, bucket] of map.entries()) arr.push(finalizeBucket(bucket, keyName, key));
  arr.sort(function (a, b) {
    if (sortBy === 'asc') return String(a[keyName]).localeCompare(String(b[keyName]));
    const d = b.totalTokens - a.totalTokens;
    return d !== 0 ? d : String(a[keyName]).localeCompare(String(b[keyName]));
  });
  return arr;
}

function mergeBuckets(list) {
  const total = newBucket();
  for (const b of list) {
    total.requests += b.requests;
    total.inputTokens += b.inputTokens;
    total.outputTokens += b.outputTokens;
    total.reasoningTokens += b.reasoningTokens;
    total.cacheReadTokens += b.cacheReadTokens;
    total.cacheWriteTokens += b.cacheWriteTokens;
    total.costUsd += b.costUsd;
  }
  return finalizeBucket(total);
}

/* ══════════════════════════════════════════════════════════════════
 * 三、sqlite 只读访问
 * ══════════════════════════════════════════════════════════════════ */

let sqliteWarningSilenced = false;

/* node:sqlite 在 Node 24 上会打一句 ExperimentalWarning。
   只想消掉这一句（别的一概照常冒出来），所以先摘下原有监听器再挂回去。 */
function silenceSqliteWarning() {
  if (sqliteWarningSilenced) return;
  sqliteWarningSilenced = true;
  const original = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', function (w) {
    if (w && /SQLite is an experimental feature/.test(String(w.message))) return;
    for (const fn of original) {
      try { fn(w); } catch (e) { /* 原监听器抛错不影响主流程 */ }
    }
  });
}

/* 只读打开。拿不到 node:sqlite（老 Node）或打不开，一律返回 null，由调用方降级。 */
function openReadOnly(dbPath) {
  try {
    silenceSqliteWarning();
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return null;
  }
}

/* 统一的关闭：Windows 上句柄不释放会把文件锁住，别的程序就写不进去了 */
function closeQuietly(db) {
  if (!db) return;
  try { db.close(); } catch (e) { /* 已经关了就算了 */ }
}

/* ══════════════════════════════════════════════════════════════════
 * 四、数据源一：MiniMax Code（消耗类）
 * ══════════════════════════════════════════════════════════════════ */

const MINIMAX_REL = path.join('.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');

/* 固定路径找不到时，在 .minimax 下有限深度找同名文件（版本目录可能变） */
function findMinimaxDb(root) {
  const direct = path.join(root, MINIMAX_REL);
  if (fs.existsSync(direct)) return direct;
  const base = path.join(root, '.minimax');
  let found = null;
  (function walk(dir, depth) {
    if (found || depth > 5) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      if (found) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.name.toLowerCase() === 'runtime-state.sqlite') { found = full; return; }
    }
  })(base, 0);
  return found;
}

function readMinimaxUsage(root, opts) {
  const src = {
    id: 'minimax-code',
    name: 'MiniMax Code',
    kind: 'consumption',
    available: false,
    reason: '',
    location: '~/' + MINIMAX_REL.split(path.sep).join('/'),
    rows: 0,
    tsUnit: null,
    byDay: [],
    byModel: [],
    byAgent: [],
    total: finalizeBucket(newBucket())
  };

  const dbPath = findMinimaxDb(root);
  if (!dbPath) {
    src.reason = '未找到本地运行时数据库（runtime-state.sqlite）';
    return src;
  }

  let db = null;
  try {
    db = openReadOnly(dbPath);
    if (!db) {
      src.reason = '无法以只读方式打开本地运行时数据库（node:sqlite 不可用或文件被占用）';
      return src;
    }

    /* 第一步：只要一个 MAX(ts)，用来判时间戳单位 —— 不碰任何明细列 */
    let probe;
    try {
      probe = db.prepare('SELECT MAX(ts) AS mx FROM local_runtime_token_usage').get();
    } catch (e) {
      src.reason = '表 local_runtime_token_usage 不存在或结构已变：' + e.message;
      return src;
    }
    const unit = detectTsUnit(probe && probe.mx);
    src.tsUnit = unit;

    /* 第二步：按时间范围 + id 游标分批取数。
       ★ 绝不 SELECT *：raw 列可能很大，这里只点名要用的 10 列。 */
    const sinceSource = Math.floor(opts.sinceMs * (PER_MS[unit] || 1));
    const stmt = db.prepare(
      'SELECT id, ts, model, agent_name, input_tokens, output_tokens, reasoning_tokens,'
      + ' cache_read_tokens, cache_write_tokens, cost_usd'
      + ' FROM local_runtime_token_usage WHERE ts >= ? AND id > ? ORDER BY id LIMIT ?'
    );

    const byDay = new Map();
    const byModel = new Map();
    const byAgent = new Map();
    let lastId = 0;
    let rows = 0;

    for (;;) {
      const batch = stmt.all(sinceSource, lastId, MAX_BATCH);
      if (!batch || batch.length === 0) break;
      for (const r of batch) {
        lastId = r.id;
        const ms = tsToMs(r.ts, unit);
        if (ms === null || ms < opts.sinceMs) continue;
        const row = {
          inputTokens: Number(r.input_tokens) || 0,
          outputTokens: Number(r.output_tokens) || 0,
          reasoningTokens: Number(r.reasoning_tokens) || 0,
          cacheReadTokens: Number(r.cache_read_tokens) || 0,
          cacheWriteTokens: Number(r.cache_write_tokens) || 0,
          costUsd: Number(r.cost_usd) || 0
        };
        const day = dayKeyFromMs(ms);
        const model = r.model ? String(r.model) : UNKNOWN;
        const agent = r.agent_name ? String(r.agent_name) : UNKNOWN;
        if (!byDay.has(day)) byDay.set(day, newBucket());
        if (!byModel.has(model)) byModel.set(model, newBucket());
        if (!byAgent.has(agent)) byAgent.set(agent, newBucket());
        addUsage(byDay.get(day), row);
        addUsage(byModel.get(model), row);
        addUsage(byAgent.get(agent), row);
        rows += 1;
      }
      if (batch.length < MAX_BATCH) break;
    }

    src.available = true;
    src.rows = rows;
    src.byDay = bucketList(byDay, 'date', 'asc');
    src.byModel = bucketList(byModel, 'model', 'desc');
    src.byAgent = bucketList(byAgent, 'agent', 'desc');
    src.total = mergeBuckets(src.byDay);
  } catch (e) {
    src.reason = '读取失败：' + e.message;
  } finally {
    closeQuietly(db);
  }
  return src;
}

/* ══════════════════════════════════════════════════════════════════
 * 五、数据源二：cc-switch（消耗类，走代理记账）
 * ══════════════════════════════════════════════════════════════════ */

const CCSWITCH_REL = path.join('.cc-switch', 'cc-switch.db');

/* cc-switch 的日期列可能是 'YYYY-MM-DD' 文本，也可能是时间戳，统一折成 YYYY-MM-DD */
function normalizeDay(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    if (/^\d{13}$/.test(s)) return dayKeyFromMs(Number(s));
    if (/^\d{10}$/.test(s)) return dayKeyFromMs(Number(s) * 1000);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e11) return dayKeyFromMs(n);
  if (n >= 1e9) return dayKeyFromMs(n * 1000);
  /* 形如 20261021 的数字日期 */
  if (n >= 19000101 && n <= 29991231) {
    const s = String(Math.floor(n));
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }
  return null;
}

function readCcSwitchUsage(root, opts) {
  const src = {
    id: 'cc-switch',
    name: 'cc-switch',
    kind: 'consumption',
    available: false,
    reason: '',
    location: '~/' + CCSWITCH_REL.split(path.sep).join('/'),
    rows: 0,
    byDay: [],
    byModel: [],
    byAgent: [],
    total: finalizeBucket(newBucket()),
    detail: ''
  };

  const dbPath = path.join(root, CCSWITCH_REL);
  if (!fs.existsSync(dbPath)) {
    src.reason = '未找到 cc-switch 的本地数据库';
    return src;
  }

  let db = null;
  try {
    db = openReadOnly(dbPath);
    if (!db) {
      src.reason = '无法以只读方式打开 cc-switch 的本地数据库';
      return src;
    }

    const byDay = new Map();
    const byModel = new Map();
    const byAgent = new Map();
    let rows = 0;

    const put = function (day, model, agent, row, requests) {
      if (!day) return;
      if (!byDay.has(day)) byDay.set(day, newBucket());
      if (!byModel.has(model)) byModel.set(model, newBucket());
      if (!byAgent.has(agent)) byAgent.set(agent, newBucket());
      const b = (requests === undefined || requests === null)
        ? row
        : Object.assign({}, row, { requests: requests });
      addUsage(byDay.get(day), b);
      addUsage(byModel.get(model), b);
      addUsage(byAgent.get(agent), b);
      rows += 1;
    };

    /* ★ 同一批用量在 cc-switch 里存了两份：日聚合表 usage_daily_rollups 与请求明细表
       proxy_request_logs。两张都读会重复计数，所以只用其中一张：
       优先日聚合（已按天算好、量小），它为空时才退到请求明细。 */
    let rollupRows = [];
    try {
      rollupRows = db.prepare(
        'SELECT date, app_type, model, request_count, input_tokens, output_tokens,'
        + ' cache_read_tokens, cache_creation_tokens, total_cost_usd'
        + ' FROM usage_daily_rollups'
      ).all();
    } catch (e) {
      rollupRows = [];
    }

    if (rollupRows.length) {
      src.detail = '日聚合表 usage_daily_rollups';
      for (const r of rollupRows) {
        const day = normalizeDay(r.date);
        if (!day) continue;
        const dayMs = new Date(day + 'T00:00:00').getTime();
        if (!Number.isFinite(dayMs) || dayMs < opts.sinceMs) continue;
        put(day, r.model ? String(r.model) : UNKNOWN, r.app_type ? String(r.app_type) : UNKNOWN, {
          inputTokens: Number(r.input_tokens) || 0,
          outputTokens: Number(r.output_tokens) || 0,
          reasoningTokens: 0,
          cacheReadTokens: Number(r.cache_read_tokens) || 0,
          cacheWriteTokens: Number(r.cache_creation_tokens) || 0,
          costUsd: Number(r.total_cost_usd) || 0
        }, Number(r.request_count) || 0);
      }
    } else {
      let logRows = [];
      try {
        logRows = db.prepare(
          'SELECT created_at, app_type, model, input_tokens, output_tokens,'
          + ' cache_read_tokens, cache_creation_tokens, total_cost_usd'
          + ' FROM proxy_request_logs ORDER BY created_at LIMIT ?'
        ).all(MAX_BATCH * 10);
      } catch (e) {
        logRows = [];
      }
      src.detail = logRows.length ? '请求明细表 proxy_request_logs' : '有表但暂无记录';
      for (const r of logRows) {
        const day = normalizeDay(r.created_at);
        if (!day) continue;
        const dayMs = new Date(day + 'T00:00:00').getTime();
        if (!Number.isFinite(dayMs) || dayMs < opts.sinceMs) continue;
        put(day, r.model ? String(r.model) : UNKNOWN, r.app_type ? String(r.app_type) : UNKNOWN, {
          inputTokens: Number(r.input_tokens) || 0,
          outputTokens: Number(r.output_tokens) || 0,
          reasoningTokens: 0,
          cacheReadTokens: Number(r.cache_read_tokens) || 0,
          cacheWriteTokens: Number(r.cache_creation_tokens) || 0,
          costUsd: Number(r.total_cost_usd) || 0
        }, 1);
      }
    }

    src.available = true;
    src.rows = rows;
    src.byDay = bucketList(byDay, 'date', 'asc');
    src.byModel = bucketList(byModel, 'model', 'desc');
    src.byAgent = bucketList(byAgent, 'agent', 'desc');
    src.total = mergeBuckets(src.byDay);
  } catch (e) {
    src.reason = '读取失败：' + e.message;
  } finally {
    closeQuietly(db);
  }
  return src;
}

/* ══════════════════════════════════════════════════════════════════
 * 六、数据源三：WorkBuddy AI（上下文占用类）
 * ══════════════════════════════════════════════════════════════════ */

const WORKBUDDY_FILE = 'conversationcontextusage.json';

function findWorkBuddyFiles(root) {
  const base = path.join(root, '.workbuddy-ai');
  const out = [];
  (function walk(dir, depth) {
    if (depth > WORKBUDDY_MAX_DEPTH) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.name.toLowerCase() === WORKBUDDY_FILE) out.push(full);
    }
  })(base, 0);
  return out;
}

function readWorkBuddyContext(root, opts) {
  const src = {
    id: 'workbuddy-ai',
    name: 'WorkBuddy AI',
    kind: 'context',
    available: false,
    reason: '',
    location: '~/.workbuddy-ai/**/' + WORKBUDDY_FILE,
    files: 0,
    conversations: 0,
    updatedInWindow: 0,
    total: { conversations: 0, used: 0, size: 0, remaining: 0 },
    byModel: [],
    byDay: [],
    byCategory: []
  };

  const files = findWorkBuddyFiles(root);
  if (!files.length) {
    src.reason = '未找到 conversationContextUsage.json';
    return src;
  }

  const modelMap = new Map();
  const dayMap = new Map();
  const catMap = new Map();
  let conversations = 0;
  let updatedInWindow = 0;
  let used = 0;
  let size = 0;
  let remaining = 0;

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      /* 文件正在被写、格式变了 —— 跳过这一份，别让整个工具挂掉 */
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    src.files += 1;

    /* 顶层 key 是会话 id：只用来计数，绝不进输出（id 属于会话标识，不该外泄） */
    for (const convId of Object.keys(parsed)) {
      const rec = parsed[convId];
      if (!rec || typeof rec !== 'object') continue;
      const model = rec.modelId ? String(rec.modelId) : UNKNOWN;
      const cUsed = Number(rec.used) || 0;
      const cSize = Number(rec.size) || 0;
      const cRemain = Math.max(0, cSize - cUsed);
      conversations += 1;
      used += cUsed;
      size += cSize;
      remaining += cRemain;

      if (!modelMap.has(model)) modelMap.set(model, { conversations: 0, used: 0, size: 0, remaining: 0 });
      const mb = modelMap.get(model);
      mb.conversations += 1;
      mb.used += cUsed;
      mb.size += cSize;
      mb.remaining += cRemain;

      const cats = rec.usageByCategory;
      if (cats && typeof cats === 'object') {
        for (const cat of Object.keys(cats)) {
          const v = Number(cats[cat]);
          if (!Number.isFinite(v)) continue;
          catMap.set(cat, (catMap.get(cat) || 0) + v);
        }
      }

      const updatedAt = tsToMs(rec.updatedAt, detectTsUnit(rec.updatedAt));
      if (updatedAt !== null && updatedAt >= opts.sinceMs) {
        updatedInWindow += 1;
        const day = dayKeyFromMs(updatedAt);
        if (!dayMap.has(day)) dayMap.set(day, { conversations: 0, used: 0, size: 0 });
        const db = dayMap.get(day);
        db.conversations += 1;
        db.used += cUsed;
        db.size += cSize;
      }
    }
  }

  src.available = true;
  src.conversations = conversations;
  src.updatedInWindow = updatedInWindow;
  src.total = { conversations: conversations, used: used, size: size, remaining: remaining };
  src.byModel = Array.from(modelMap.entries()).map(function (e) {
    return { model: e[0], conversations: e[1].conversations, used: e[1].used, size: e[1].size, remaining: e[1].remaining };
  }).sort(function (a, b) { return b.used - a.used || a.model.localeCompare(b.model); });
  src.byDay = Array.from(dayMap.entries()).map(function (e) {
    return { date: e[0], conversations: e[1].conversations, used: e[1].used, size: e[1].size };
  }).sort(function (a, b) { return a.date.localeCompare(b.date); });
  src.byCategory = Array.from(catMap.entries()).map(function (e) {
    return { category: e[0], tokens: e[1] };
  }).sort(function (a, b) { return b.tokens - a.tokens || a.category.localeCompare(b.category); });

  return src;
}

/* ══════════════════════════════════════════════════════════════════
 * 七、采集入口
 * ══════════════════════════════════════════════════════════════════ */

/* 探查过但**没有**可用用量数据源的 agent（如实列出，不硬凑） */
const UNSUPPORTED = [
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    reason: '未找到可用的用量数据源（~/.codebuddy 下只有日志与插件；AppData 的 state.vscdb 里唯一的 LLM 数据缓存是加密字节块，不是明文用量）'
  },
  {
    id: 'qoder',
    name: 'Qoder',
    reason: '未找到可用的用量数据源（~/.qoder 与 AppData 下只有模型目录、文件历史、鉴权文件，没有 token 用量表）'
  },
  {
    id: 'trae-cn',
    name: 'Trae CN',
    reason: '未找到可用的用量数据源（~/.trae-cn 与 AppData 下只有内置资源与扩展清单，没有 token 用量表）'
  }
];

function collectUsage(opts) {
  const o = opts || {};
  const root = o.root || process.env.USERPROFILE || os.homedir();
  const days = Math.max(1, Math.min(MAX_DAYS, Math.floor(Number(o.days) || DEFAULT_DAYS) || DEFAULT_DAYS));
  const now = o.now ? new Date(o.now) : new Date();
  const sinceMs = startOfWindowMs(now, days);

  const minimax = readMinimaxUsage(root, { sinceMs: sinceMs });
  const ccSwitch = readCcSwitchUsage(root, { sinceMs: sinceMs });
  const workbuddy = readWorkBuddyContext(root, { sinceMs: sinceMs });

  const consumptionSources = [minimax, ccSwitch];
  const contextSources = [workbuddy];
  const availableCount = consumptionSources.concat(contextSources).filter(function (s) { return s.available; }).length;

  const unavailable = [];
  for (const s of consumptionSources.concat(contextSources)) {
    if (!s.available) unavailable.push({ id: s.id, name: s.name, reason: s.reason || '不可用' });
  }
  for (const u of UNSUPPORTED) unavailable.push({ id: u.id, name: u.name, reason: u.reason });

  const consumptionTotal = mergeBuckets(
    consumptionSources.filter(function (s) { return s.available; })
      .reduce(function (acc, s) { return acc.concat(s.byDay); }, [])
  );

  return {
    generatedAt: now.toISOString(),
    days: days,
    /* ★ 不回传 root：那是带用户名的绝对路径，输出里不许出现用户标识 */
    range: { since: dayKeyFromMs(sinceMs), until: dayKeyFromMs(now.getTime()) },
    availableSources: availableCount,
    consumption: { sources: consumptionSources, total: consumptionTotal },
    context: { sources: contextSources },
    unavailable: unavailable
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 八、输出（中文 / 千分位 / 成本 4 位小数）
 * ══════════════════════════════════════════════════════════════════ */

function fmtInt(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

function fmtCost(n) {
  return (Number(n) || 0).toFixed(4);
}

/* 中文是全角，按字符数补空格会错位；这里按显示宽度算（CJK 记 2） */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && (
      cp <= 0x115f
      || cp === 0x2329 || cp === 0x232a
      || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x20000 && cp <= 0x3fffd)
    ));
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s, width) {
  const text = String(s === null || s === undefined ? '' : s);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/* 通用表格：列宽按内容自适应 */
function renderTable(headers, rows, indent) {
  const pre = indent || '';
  const widths = headers.map(function (h, i) {
    let w = displayWidth(h);
    for (const r of rows) w = Math.max(w, displayWidth(r[i] === null || r[i] === undefined ? '' : r[i]));
    return w;
  });
  const lines = [];
  lines.push(pre + headers.map(function (h, i) { return pad(h, widths[i]); }).join('  ').replace(/\s+$/, ''));
  for (const r of rows) {
    lines.push(pre + r.map(function (c, i) { return pad(c, widths[i]); }).join('  ').replace(/\s+$/, ''));
  }
  return lines;
}

/* 表格直接 push 进调用方的数组：
   之前写成 `lines = lines.concat(...)` 是在子函数里给形参重新赋值，
   调用方手里的数组其实拿不到表格行 —— 表格会整段消失。 */
function addTable(lines, headers, rows, indent) {
  for (const line of renderTable(headers, rows, indent)) lines.push(line);
}
function usageRows(list, keyLabel) {
  return list.map(function (b) {
    return [
      b[keyLabel],
      fmtInt(b.requests),
      fmtInt(b.inputTokens),
      fmtInt(b.outputTokens),
      fmtInt(b.reasoningTokens),
      fmtInt(b.cacheReadTokens),
      fmtInt(b.cacheWriteTokens),
      fmtInt(b.totalTokens),
      fmtCost(b.costUsd)
    ];
  });
}

const USAGE_HEADERS = ['日期/维度', '调用', '输入', '输出', '推理', '缓存读', '缓存写', '合计', '成本$'];

function renderConsumptionSource(lines, src) {
  lines.push('  来源：' + src.name + '（' + src.location + '）'
    + (src.tsUnit ? ' · 时间戳单位：' + src.tsUnit : '')
    + ' · ' + fmtInt(src.rows) + ' 条记录'
    + (src.detail ? ' · ' + src.detail : ''));
  if (!src.available) {
    lines.push('    不可用：' + src.reason);
    return;
  }
  if (!src.rows) {
    lines.push('    窗口内没有记录。');
    return;
  }
  lines.push('');
  lines.push('    按天');
  addTable(lines,USAGE_HEADERS, usageRows(src.byDay, 'date'), '    ');
  lines.push('');
  lines.push('    按模型');
  addTable(lines,['模型'].concat(USAGE_HEADERS.slice(1)), usageRows(src.byModel, 'model'), '    ');
  lines.push('');
  lines.push('    按 agent');
  addTable(lines,['agent'].concat(USAGE_HEADERS.slice(1)), usageRows(src.byAgent, 'agent'), '    ');
}

function renderText(result) {
  const lines = [];
  const nowText = new Date(result.generatedAt).toLocaleString('zh-CN', { hour12: false });
  lines.push('API-AegisLens · 本机 AI agent token 计量');
  lines.push('生成时间 ' + nowText + '（本地） · 统计范围 最近 ' + result.days + ' 天：'
    + result.range.since + ' ~ ' + result.range.until);
  lines.push('');

  lines.push('■ 消耗类：token 消耗与花费');
  lines.push('  口径：模型调用真烧掉的 token（输入/输出/推理/缓存读/缓存写）与对应美元成本。');
  lines.push('  合计 = 输入 + 输出 + 推理 + 缓存读 + 缓存写（计数口径，不等于账单口径）。');
  for (const src of result.consumption.sources) renderConsumptionSource(lines, src);
  if (result.consumption.total.requests) {
    lines.push('');
    lines.push('  消耗类合计（所有来源相加）');
    addTable(lines,['维度'].concat(USAGE_HEADERS.slice(1)), [
      [
        '合计',
        fmtInt(result.consumption.total.requests),
        fmtInt(result.consumption.total.inputTokens),
        fmtInt(result.consumption.total.outputTokens),
        fmtInt(result.consumption.total.reasoningTokens),
        fmtInt(result.consumption.total.cacheReadTokens),
        fmtInt(result.consumption.total.cacheWriteTokens),
        fmtInt(result.consumption.total.totalTokens),
        fmtCost(result.consumption.total.costUsd)
      ]
    ], '  ');
  }
  lines.push('');

  lines.push('■ 上下文占用类：当前上下文窗口占用（不是花费）');
  lines.push('  口径：每个会话此刻占了多少上下文窗口、还剩多少能放。');
  lines.push('        它是一次快照，不等于历史消耗 —— 用户没再发消息，数字也不会变少。');
  for (const src of result.context.sources) {
    lines.push('  来源：' + src.name + '（' + src.location + '） · ' + fmtInt(src.conversations) + ' 个会话'
      + (src.files ? ' · ' + src.files + ' 份文件' : ''));
    if (!src.available) {
      lines.push('    不可用：' + src.reason);
      continue;
    }
    if (!src.conversations) {
      lines.push('    没有可用记录。');
      continue;
    }
    lines.push('');
    lines.push('    按模型');
    addTable(lines,
      ['模型', '会话数', '当前占用', '窗口上限', '剩余'],
      src.byModel.map(function (m) {
        return [m.model, fmtInt(m.conversations), fmtInt(m.used), fmtInt(m.size), fmtInt(m.remaining)];
      }),
      '    '
    );
    if (src.byCategory.length) {
      lines.push('');
      lines.push('    按上下文类别（所有会话合计）');
      addTable(lines,
        ['类别', '占用'],
        src.byCategory.map(function (c) { return [c.category, fmtInt(c.tokens)]; }),
        '    '
      );
    }
    if (src.byDay.length) {
      lines.push('');
      lines.push('    按最近更新日（这些会话当前的占用，不是当天消耗）');
      addTable(lines,
        ['日期', '会话数', '当前占用', '窗口上限'],
        src.byDay.map(function (d) { return [d.date, fmtInt(d.conversations), fmtInt(d.used), fmtInt(d.size)]; }),
        '    '
      );
    }
  }
  lines.push('');

  if (result.unavailable.length) {
    lines.push('■ 未接入的数据源');
    for (const u of result.unavailable) lines.push('  - ' + u.name + '：' + u.reason);
    lines.push('');
  }

  if (!result.availableSources) {
    lines.push('没有任何可用的数据源 —— 上面逐条写了原因。');
  }
  return lines.join('\n');
}

function renderJson(result) {
  return JSON.stringify(result, null, 2);
}

/* --sources：只列探测结果，不刷表格 */
function renderSources(result) {
  const lines = [];
  lines.push('探测到的数据源');
  const describe = function (src) {
    const state = src.available ? '可用' : '不可用';
    let extra = '';
    if (src.available) {
      if (src.kind === 'consumption') extra = ' · ' + fmtInt(src.rows) + ' 条记录'
        + (src.tsUnit ? ' · 时间戳单位 ' + src.tsUnit : '');
      else extra = ' · ' + fmtInt(src.conversations) + ' 个会话';
    } else {
      extra = ' · ' + src.reason;
    }
    lines.push('  [' + state + '] ' + src.name + '（' + src.kind + '） · ' + src.location + extra);
  };
  for (const src of result.consumption.sources) describe(src);
  for (const src of result.context.sources) describe(src);
  if (result.unavailable.length) {
    lines.push('');
    lines.push('未接入');
    for (const u of result.unavailable) {
      if (result.consumption.sources.concat(result.context.sources).some(function (s) { return s.id === u.id; })) continue;
      lines.push('  [不可用] ' + u.name + ' · ' + u.reason);
    }
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_DAYS: DEFAULT_DAYS,
  collectUsage: collectUsage,
  renderText: renderText,
  renderJson: renderJson,
  renderSources: renderSources,
  silenceSqliteWarning: silenceSqliteWarning,
  detectTsUnit: detectTsUnit,
  tsToMs: tsToMs,
  dayKeyFromMs: dayKeyFromMs,
  startOfWindowMs: startOfWindowMs
};
