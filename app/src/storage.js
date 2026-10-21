const fs = require('node:fs');
const path = require('node:path');
const { encryptField, decryptField } = require('./crypto');
const { inferStyle } = require('./adapters');
const { usageHistoryEntries } = require('./usage-history');

/* 按字段来源与能力位：JSON 后端直接挂在模型对象上，SQLite 后端存进 models.extra 一列。
   两边合并补丁时都按这张表逐字段处理，漏一处就会静默丢字段。 */
const MODEL_EXTRA = ['ctxSrc', 'outSrc', 'conflict', 'outGtCtx', 'reasoning', 'modalitiesIn', 'rpm',
  /* 第四级联网检索（models.dev）带回来的能力位：附件、工具调用、输出模态。
     值与来源分开记——attachment/toolCall/modalitiesOut 是值，
     <字段>Src 是这一项的来源标签（api 平台自报 / web 联网检索 / meta 内置表），
     capsFrom 是这些参考值来自哪个公开目录。 */
  'attachment', 'toolCall', 'modalitiesOut',
  'reasoningSrc', 'modalitiesInSrc', 'attachmentSrc', 'toolCallSrc', 'modalitiesOutSrc', 'capsFrom',
  /* ctxFrom/outFrom：参考值的具体出处（哪个公开目录给的）。
     第四级联网检索会查两个源（OpenRouter / models.dev），第三级是内置国内模型表，
     同一把 Key 的 ctx 与 out 可能来自不同目录——分字段记，用户才知道这个参考值该信几分。 */
  'ctxFrom', 'outFrom'];

function nowIso() { return new Date().toISOString(); }

/* ctx/out 进库只认三种形态：正整数、null（已确认为空）、undefined（本次不动）。
   /api/import 会把用户 JSON 里的字段原样递进来，SQLite 顺手把 '1e5' 变成 100000
   却把 'abc' 留在 INTEGER 列里，JSON 后端则两个都不动 —— 同一条数据在两个后端连类型
   都不一样，消费方没法假设。归一放在这一层，两个后端才谈得上一致。 */
function normTokens(v) {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normModel(m) {
  if (!m || typeof m !== 'object') return m;
  const r = Object.assign({}, m);
  if (m.ctx !== undefined) r.ctx = normTokens(m.ctx);
  if (m.out !== undefined) r.out = normTokens(m.out);
  return r;
}

/* 告警位是数值的函数，不能各存各的：手改过 ctx 之后，上次拉取留下的「最大输出超过上下文」
   会跟屏幕上正在显示的数字互相打脸。读取时按当前 ctx/out 重算，写入侧不必再管它新不新鲜。 */
function deriveFlags(m) {
  if (!m || typeof m !== 'object') return m;
  m.outGtCtx = (m.ctx != null && m.out != null && m.out > m.ctx) || null;
  return m;
}

/* 同一份 /models 响应里出现两次相同 id：SQLite 的 UNIQUE(key_id, id) 会把整次拉取顶成 500，
   JSON 后端却两条都留下。一个平台的重复条目不该让用户一个模型都看不见 ——
   留第一条，后面的只用来补第一条缺的字段。 */
function dedupeById(models) {
  const kept = [];
  const byId = {};
  (models || []).forEach(function (m) {
    if (!m || typeof m !== 'object' || m.id == null) { kept.push(m); return; }
    const k = String(m.id);
    if (!byId[k]) { byId[k] = m; kept.push(m); return; }
    const first = byId[k];
    Object.keys(m).forEach(function (f) {
      if (f === 'id') return;
      if (first[f] == null && m[f] != null) first[f] = m[f];
    });
  });
  return kept;
}

function normEps(platform, eps) {
  return (eps || []).map(function (e) {
    e = e || {};
    return {
      url: String(e.url == null ? '' : e.url),
      style: String(e.style == null ? '' : e.style) || inferStyle(platform)
    };
  });
}

function legacyEps(platform, base) {
  return base ? [{ url: base, style: inferStyle(platform) }] : [];
}

/* 工厂记一份活实例：--daemon 关停和测试收尾都需要「把还开着的库统一关掉」。
   Windows 上没关的 sqlite 句柄会压着数据目录，删都删不掉。 */
const LIVE_STORES = new Set();

function createStore(dataDir, masterKey, opts) {
  fs.mkdirSync(dataDir, { recursive: true });
  const prefer = (opts && opts.backend) || 'auto';
  let store = null;
  if (prefer !== 'json') {
    try {
      const { DatabaseSync } = require('node:sqlite');
      store = makeSqliteStore(dataDir, masterKey, DatabaseSync);
    } catch (e) {
      if (prefer === 'sqlite') throw e;
    }
  }
  if (!store) store = makeJsonStore(dataDir, masterKey);
  markShadowStore(dataDir, store);
  LIVE_STORES.add(store);
  const rawClose = store.close;
  store.close = function () {
    LIVE_STORES.delete(store);
    return rawClose.call(store);
  };
  return store;
}

function closeAllStores() {
  for (const store of Array.from(LIVE_STORES)) {
    try { store.close(); } catch (e) { /* 已经关掉的，不在这儿报错 */ }
  }
}

/* 首选后端由 Node 版本决定（node:sqlite 自 22 起才有），而两份库互不迁移：
   用 18–21 录的数据升到 22 后看不见，会被当成"密钥全丢了"，其实还在另一个文件里 */
function markShadowStore(dataDir, store) {
  const other = store.backend === 'sqlite' ? 'store.json' : 'keys.db';
  let size = 0;
  try {
    size = fs.statSync(path.join(dataDir, other)).size;
  } catch (e) {
    return;
  }
  if (size > 0) {
    store.shadowStore = other;
    console.warn('  ⚠ 数据目录里还有另一份密钥库 ' + other + '（当前用的是 ' + store.backend + '）。'
      + '两份互不迁移；若列表里少了你录过的密钥，先切到能读它的 Node 版本（SQLite 需 >= 22，'
      + 'JSON 全版本可读）确认，再决定是否合并，别删文件。');
  }
}

function emptyBalance(status) {
  return { value: null, status: status || 'pending', updatedAt: null };
}

/* ================= 用量/限流快照 =================
   余额是 **Key 级** 的（同一把 key 查到的钱属于这把 key），
   用量/限流窗口是 **账户级** 的（同一平台的多个 key 查出来是同一份数据）。
   两套口径混在一列里，以后就再也分不清「上次调用时的限额快照」和「余额」，
   所以这里另立一套字段（usage_json / usage_status / usage_updated_at）。
   两个后端共用下面这段归一，读回来的形状因此不可能分叉。 */
function emptyUsage(status) {
  return { status: status || 'pending', windows: [], kind: null, raw: null, msg: null, updatedAt: null };
}

function usageNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normWindow(w) {
  const x = w || {};
  return {
    name: String(x.name == null ? '' : x.name),
    used: usageNum(x.used),
    limit: usageNum(x.limit),
    resetAt: x.resetAt == null ? null : String(x.resetAt)
  };
}

function normUsage(u) {
  if (!u || typeof u !== 'object') return emptyUsage();
  return {
    status: u.status ? String(u.status) : 'pending',
    windows: (Array.isArray(u.windows) ? u.windows : []).map(normWindow),
    kind: u.kind == null ? null : String(u.kind),
    raw: u.raw == null ? null : u.raw,
    /* 失败原因要留得住：「密钥无效」和「没解析出窗口」是两回事，
       界面上混成一句「失败」等于把这一轮修好的分文案又抹掉了 */
    msg: u.msg == null ? null : String(u.msg),
    updatedAt: u.updatedAt == null ? null : String(u.updatedAt)
  };
}

/* ================= 观测历史 =================
   密钥记录上只留最近一次（d.test 被整条覆盖），延迟趋势、余额走势因此无数据可画。
   每次真实观测另存一行；pending / unsupported 是能力位与重置标记而不是观测结果，
   进表只会把曲线钉在零点上。两个后端共用这套行结构，字段名一律 camelCase。 */
const HISTORY_MAX_PER_KEY = 1000;
const HISTORY_DEFAULT_LIMIT = 200;
const HISTORY_DETAIL_MAX = 200;

function historyLimit(v) {
  if (v === undefined || v === null || v === '') return HISTORY_DEFAULT_LIMIT;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), HISTORY_MAX_PER_KEY);
}

function detailOf(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, HISTORY_DETAIL_MAX) : null;
}

/* 通过的测试每次都是同一句「密钥可用」，只有失败原因值得留下 */
function testHistoryOf(test) {
  const t = test || {};
  return {
    kind: 'test',
    status: t.status,
    latency: t.latency,
    detail: t.status === 'pass' ? null : (t.msg || t.code)
  };
}

/* 健康快照：连续失败次数 + 最近一次「有结论」的探测时间。
   两个后端共用这一段实现——一边改了另一边没改，轮换在两个库上会挑出不同的密钥。
   通过一次 ⇒ 连续失败清零；失败一次 ⇒ 加一；不是结论（既非 pass 也非 fail）⇒ 不动。 */
function healthNext(prevFailCount, prevLastHealthAt, test, at) {
  const failCount = Number(prevFailCount) || 0;
  const t = test || {};
  if (t.status === 'pass') return { failCount: 0, lastHealthAt: at };
  if (t.status === 'fail') return { failCount: failCount + 1, lastHealthAt: at };
  return { failCount: failCount, lastHealthAt: prevLastHealthAt || null };
}
function balanceHistoryOf(balance) {
  const b = balance || {};
  if (b.status === 'pending' || b.status === 'unsupported') return null;
  return {
    kind: 'balance',
    status: b.status,
    value: b.value,
    detail: b.status === 'ok' ? null : (b.msg || b.code)
  };
}

function historyRow(seq, keyId, at, entry) {
  const e = entry || {};
  return {
    id: seq,
    keyId: keyId,
    at: at,
    kind: e.kind == null ? null : String(e.kind),
    status: e.status == null ? null : String(e.status),
    latency: Number.isFinite(e.latency) ? Math.round(e.latency) : null,
    value: e.value == null ? null : Number(e.value),
    detail: detailOf(e.detail)
  };
}

/* ================= 凭证保险库 =================
   四个 *_enc 列存的是 crypto.js 给出的密文：这一层不加解密、不校验 enc:v1: 前缀、
   不改写内容，密文进密文出，解不解是 api 层的事。title/username/url/folder/tags 保持明文，
   跟 keys 表「除 key_enc 外全明文」的做法一致。
   两个后端共用下面这套归一/成行函数，SQLite 侧只多一层 snake_case 列名映射 ——
   models.extra 那次只改一边导致两条后端行为不一致，这里从结构上堵掉。 */
const CRED_PLAIN = ['title', 'username', 'url', 'site', 'loginMethod', 'folder', 'tags'];
/* sqlite 行的属性名是列名（snake_case）。单词字段两种写法相同，
   骆驼式字段必须显式映射，否则 row.loginMethod 读到 undefined
   —— 存得进去、取回来变空串。 */
const CRED_PLAIN_COLUMN = { loginMethod: 'login_method' };
const CRED_ENC = ['passwordEnc', 'secretEnc', 'totpEnc', 'noteEnc'];
/* 入参两种拼法都认（表列名是 snake_case，记录形状跟 keys 一样是 camelCase），出参一律 camelCase */
const CRED_ENC_COLUMN = { passwordEnc: 'password_enc', secretEnc: 'secret_enc', totpEnc: 'totp_enc', noteEnc: 'note_enc' };

function credText(v) { return v == null ? '' : String(v); }

/* 密文原样存：null 还是 null（这一项没录），'' 还是 ''（encryptField 对空串就返回 ''），
   其余走 String()——对字符串本身是恒等，所以 enc:v1: 前缀和正文一个字节都不会被动到 */
function credCipher(v) { return v == null ? null : (v === '' ? '' : String(v)); }

/* id 在两个后端走的比较路径不同：SQLite 的 INTEGER 亲和会把 '2' 自己变成 2，
   JSON 侧是 === 严格比，传字符串就查不到。统一收成数字，api 层传哪种都不会一条后端命中一条不命中。 */
function credId(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/* 新建用的全量字段：明文缺省空串，密文缺省 null，时间戳由后端补 */
function credNew(input) {
  const i = input || {};
  const doc = { createdAt: null, updatedAt: null, lastUsedAt: null };
  CRED_PLAIN.forEach(function (f) { doc[f] = credText(i[f]); });
  CRED_ENC.forEach(function (f) { doc[f] = credCipher(i[f] === undefined ? i[CRED_ENC_COLUMN[f]] : i[f]); });
  return doc;
}

/* 补丁只带出现的字段（undefined=这次不动），id/createdAt/updatedAt/lastUsedAt 由存储层自己管，
   从白名单这里就挡掉了 */
function credPatch(patch) {
  const p = patch || {};
  const out = {};
  CRED_PLAIN.forEach(function (f) {
    if (p[f] !== undefined) out[f] = credText(p[f]);
  });
  CRED_ENC.forEach(function (f) {
    const v = p[f] === undefined ? p[CRED_ENC_COLUMN[f]] : p[f];
    if (v !== undefined) out[f] = credCipher(v);
  });
  return out;
}

/* 两个后端唯一的出口：字段顺序、缺省值都在这一处定死，读回来的行形状因此不可能分叉 */
function credRecord(c) {
  return {
    id: c.id == null ? null : Number(c.id),
    title: credText(c.title),
    username: credText(c.username),
    url: credText(c.url),
    site: credText(c.site),
    loginMethod: credText(c.loginMethod),
    folder: credText(c.folder),
    tags: credText(c.tags),
    passwordEnc: credCipher(c.passwordEnc),
    secretEnc: credCipher(c.secretEnc),
    totpEnc: credCipher(c.totpEnc),
    noteEnc: credCipher(c.noteEnc),
    createdAt: c.createdAt == null ? null : String(c.createdAt),
    updatedAt: c.updatedAt == null ? null : String(c.updatedAt),
    lastUsedAt: c.lastUsedAt == null ? null : String(c.lastUsedAt)
  };
}

/* 口令复用检测要的「同一 username 出现在几条记录里」。
   空白 username 不计：否则每条没填账号的记录都算「复用」，那是噪声不是信号。
   大小写和前后空格一律不归一——归一方式稍有差别，两个后端就会各自判出不同的组。
   排序放在 JS 侧做（SQLite 的 BINARY collation 按 UTF-8 字节序，和字符串比较在个别字符上不同），
   两侧才拿得到同一份顺序。 */
function credUsernameCounts(pairs) {
  const out = [];
  (pairs || []).forEach(function (p) {
    const u = p.username == null ? '' : String(p.username);
    const n = Number(p.count);
    if (!u || !Number.isFinite(n) || n < 1) return;
    out.push({ username: u, count: n });
  });
  out.sort(function (a, b) { return a.username < b.username ? -1 : (a.username > b.username ? 1 : 0); });
  return out;
}

function countUsernamesByUsername(list) {
  const counted = new Map();
  list.forEach(function (raw) {
    const u = credText(raw);
    if (!u) return;
    counted.set(u, (counted.get(u) || 0) + 1);
  });
  const pairs = [];
  counted.forEach(function (count, username) { pairs.push({ username: username, count: count }); });
  return credUsernameCounts(pairs);
}

/* ================= 消费者作用域令牌 =================
   库里只存令牌的**元数据**：签好名的令牌本体永不落盘，只有 fingerprint（HMAC 单向、带 DEK 因子）。
   存令牌本身等于在加密库旁边再放一份可重放的凭据，而吊销要看的是 tid 清单，不是令牌串。 */

function tokStr(v) { return v == null ? '' : String(v); }

/* 正整数数组：去重、升序。签发侧 consumer-tokens.js 已经校验过一轮，这里再夹一次是因为
   JSON 后端会被手改过的 store.json 喂到，不能假定进来的东西是干净的。 */
function tokIds(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const n of v) {
    const x = Number(n);
    if (Number.isSafeInteger(x) && x > 0 && out.indexOf(x) === -1) out.push(x);
  }
  return out.sort(function (a, b) { return a - b; });
}

function tokScopes(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const s of v) {
    const x = String(s);
    if (x && out.indexOf(x) === -1) out.push(x);
  }
  return out;
}

function tokUnix(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function tokNew(input) {
  const i = input || {};
  return {
    tid: tokStr(i.tid),
    fingerprint: tokStr(i.fingerprint),
    label: tokStr(i.label),
    scopes: tokScopes(i.scopes),
    keyIds: tokIds(i.keyIds),
    credIds: tokIds(i.credIds),
    iat: tokUnix(i.iat),
    exp: tokUnix(i.exp)
  };
}

/* 「现在过期了没」是读出来的判断，不是写进去的状态：存成字段就会随时间失真 */
function tokRecord(t) {
  return {
    id: t.id,
    tid: t.tid,
    fingerprint: t.fingerprint,
    label: t.label,
    scopes: t.scopes.slice(),
    keyIds: t.keyIds.slice(),
    credIds: t.credIds.slice(),
    iat: t.iat,
    exp: t.exp,
    issuedAt: t.iat ? new Date(t.iat * 1000).toISOString() : null,
    expiresAt: t.exp ? new Date(t.exp * 1000).toISOString() : null,
    revokedAt: t.revokedAt == null ? null : String(t.revokedAt),
    lastUsedAt: t.lastUsedAt == null ? null : String(t.lastUsedAt),
    createdAt: t.createdAt
  };
}

function tokJsonArray(v) { return JSON.stringify(Array.isArray(v) ? v : []); }

function parseTokJson(v) {
  if (v == null || v === '') return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/* 配置去向：一条 = {tool, host}。host 是「哪台电脑」这一维（用户 10-10 第 5 条）；
   旧库存的是纯字符串数组，读进来归一成对象，写出去一律对象；
   host 为空串 = 不知道哪台电脑（老数据与旧格式导入）。 */
function assignedEntry(tool, host) {
  return { tool: String(tool == null ? '' : tool).trim(), host: String(host == null ? '' : host).trim() };
}
function normAssigned(v) {
  if (!Array.isArray(v)) return [];
  return v.map(function (e) {
    if (typeof e === 'string') return assignedEntry(e, '');
    if (e && typeof e === 'object') return assignedEntry(e.tool, e.host);
    return null;
  }).filter(function (e) { return e && e.tool; });
}

/* ================= JSON 文件后端 ================= */

/* 池成员：{keyId, role, sortIndex}。role='active' 是当前生效那把，
   role='backup' 在备用队列里，sortIndex 决定排队顺序。

   ★ 编号口径（两个后端必须一致）：active 固定占 0，backup 从 1 起连续编号。
     0 是 active 的位置，备用不占 —— 看一个 sortIndex 就知道这把是不是当前生效的。

   ★ 一把池最多一把 active：靠代码守，不靠 SQL（单表约束要多一张表，不值）。

   ★ 两个后端（json / sqlite）必须给出同一份结果：同一个池建在哪个后端上，
     成员角色与排队顺序都得一模一样 —— 不一致的话轮换挑出来的密钥会不同，
     同一个池在两台机器上的界面长得也不一样。 */

/* 池成员 id 名单：去重、只留整数。池成员是密钥 id，不是随便什么数。 */
function poolIds(keyIds) {
  const ids = Array.isArray(keyIds) ? keyIds.filter(Number.isInteger) : [];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/* 排一份成员表：active 一把（占 0），其余 backup 从 1 起编号。
   keepActiveId 是「沿用原来的当前生效那把」；它不在名单里就由名单第一把顶上。 */
function memberTable(ids, keepActiveId) {
  const list = poolIds(ids);
  if (!list.length) return [];
  const keep = list.indexOf(keepActiveId) >= 0 ? keepActiveId : list[0];
  const out = [{ keyId: keep, role: 'active', sortIndex: 0 }];
  list.forEach(function (id) {
    if (id === keep) return;
    out.push({ keyId: id, role: 'backup', sortIndex: out.length });
  });
  return out;
}

/* 成员归一：给一份成员表，算出规范形态 ——
   active 有且只有一把（占 0），其余 backup 从 1 起按原 sortIndex 排队。
   一把 active 都没有时队首那把顶上：老安装一直是「队首就是当前在用的」这个口径，
   不这么归一，老池轮换时会被当成「一把都没有」。 */
function normalizeMembers(members) {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return [];
  const act = list.filter(function (m) { return m.role === 'active'; })[0] || null;
  const bak = list
    .filter(function (m) { return !act || m.keyId !== act.keyId; })
    .sort(function (a, b) { return (a.sortIndex || 0) - (b.sortIndex || 0) || a.keyId - b.keyId; });
  const head = act ? [act] : bak.splice(0, 1);
  const out = head.map(function (m) { return { keyId: m.keyId, role: 'active', sortIndex: 0 }; });
  bak.forEach(function (m) { out.push({ keyId: m.keyId, role: 'backup', sortIndex: out.length }); });
  return out;
}

function makeJsonStore(dataDir, masterKey) {
  const file = path.join(dataDir, 'store.json');
  let data;
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    data = { nextId: 1, keys: [] };
  }
  /* 旧库「配置去向」是纯字符串数组：读进来就归一，下次 persist() 文件自然升级成对象 */
  (Array.isArray(data.keys) ? data.keys : []).forEach(function (d) {
    if (d) d.assigned = normAssigned(d.assigned);
  });
  /* 老库没有 history 字段：按现有文件里已用过的最大 id 续上，避免重启后新行撞号 */
  if (!Array.isArray(data.history)) data.history = [];
  if (typeof data.nextHistoryId !== 'number') {
    data.nextHistoryId = data.history.reduce(function (max, r) {
      return Math.max(max, Number(r && r.id) || 0);
    }, 0) + 1;
  }
  /* credentials 同理：老库没这张表时补上，id 序列从已用过的最大值续 */
  if (!Array.isArray(data.credentials)) data.credentials = [];
  if (typeof data.nextCredentialId !== 'number') {
    data.nextCredentialId = data.credentials.reduce(function (max, r) {
      return Math.max(max, Number(r && r.id) || 0);
    }, 0) + 1;
  }
  /* pools 同理：账号池是后加的能力，旧文件直接初始化为空 */
  if (!Array.isArray(data.pools)) data.pools = [];
  if (typeof data.nextPoolId !== 'number') {
    data.nextPoolId = data.pools.reduce(function (max, p) {
      return Math.max(max, Number(p && p.id) || 0);
    }, 0) + 1;
  }
  /* tokens 同理：消费者令牌是后加的能力 */
  if (!Array.isArray(data.tokens)) data.tokens = [];
  if (typeof data.nextTokenId !== 'number') {
    data.nextTokenId = data.tokens.reduce(function (max, t) {
      return Math.max(max, Number(t && t.id) || 0);
    }, 0) + 1;
  }
  const sleepTick = new Int32Array(new SharedArrayBuffer(4));
  function persist() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    /* Windows 上 rename 覆盖现存文件会偶发 EPERM（Defender / 搜索索引
       瞬态锁住目标），这是环境瞬态不是逻辑错误：短退避重试几次。
       重试耗尽才抛——否则一次杀毒扫描就能让密钥保存整路径挂掉。 */
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); return; }
      catch (e) {
        if (i >= 4 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) throw e;
        Atomics.wait(sleepTick, 0, 0, 25);
      }
    }
  }
  function find(id) { return data.keys.find(function (x) { return x.id === id; }) || null; }
  function findCred(id) {
    const n = credId(id);
    return data.credentials.find(function (x) { return x.id === n; }) || null;
  }
  function findToken(tid) {
    const t = tokStr(tid);
    if (!t) return null;
    return data.tokens.find(function (x) { return x.tid === t; }) || null;
  }
  function trimHistory(keyId) {
    let seen = 0;
    for (let i = data.history.length - 1; i >= 0; i--) {
      if (data.history[i].keyId !== keyId) continue;
      if (++seen > HISTORY_MAX_PER_KEY) data.history.splice(i, 1);
    }
  }
  function pushHistory(keyId, entry, at) {
    const row = historyRow(data.nextHistoryId++, keyId, at, entry);
    data.history.push(row);
    trimHistory(keyId);
    return row;
  }
  function epsOf(doc) {
    if (Array.isArray(doc.endpoints)) return normEps(doc.platform, doc.endpoints);
    return legacyEps(doc.platform, doc.base || '');
  }
  function toRec(doc) {
    const eps = epsOf(doc);
    return {
      id: doc.id,
      name: doc.name,
      platform: doc.platform,
      customName: doc.customName || '',
      key: decryptField(masterKey, doc.keyEnc),
      endpoints: eps,
      base: eps.length ? eps[0].url : '',
      model: doc.model || '',
      reg: doc.reg || '',
      exp: doc.exp || '',
      authNote: doc.authNote || '',
      balance: doc.balance || emptyBalance(),
      usage: normUsage(doc.usage),
      test: doc.test || null,
      failCount: Number(doc.failCount) || 0,
      lastHealthAt: doc.lastHealthAt || null,
      modelsFetched: !!doc.modelsFetched,
      models: (doc.models || []).map(deriveFlags),
      assigned: normAssigned(doc.assigned),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt
    };
  }

  /* 账号池只存成员 id 列表；成员密钥的完整记录由 API 层用 storage.getKey 现取，
     避免这里为了展示把解密后的 key 也带出来 */
  function toPool(doc) {
    return {
      id: doc.id,
      name: doc.name,
    /* 成员以 members 为准；老库只有裸 keyIds，normMembers 会补成 members 结构。
       keyIds 是派生字段（老调用方 api.js 的 poolWithKeys 还在用）。 */
    members: (Array.isArray(doc.members) ? doc.members : memberTable(doc.keyIds, null)).map(function (m) {
      return { keyId: m.keyId, role: m.role || 'backup', sortIndex: m.sortIndex || 0 };
    }),
      keyIds: (Array.isArray(doc.members) ? doc.members : memberTable(doc.keyIds, null)).map(function (m) { return m.keyId; }),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt
    };
  }

  return {
    backend: 'json',
    dataDir: dataDir,

    /* 和 SQLite 后端同一门面：这边本来就没有常驻句柄（persist() 每次写完就关），
       空实现是为了调用方不必问「你这边要不要关」 */
    close() {},

    listKeys() { return data.keys.map(toRec); },
    getKey(id) { const d = find(id); return d ? toRec(d) : null; },

    createKey(input) {
      const eps = Array.isArray(input.endpoints)
        ? normEps(input.platform, input.endpoints)
        : legacyEps(input.platform, input.base || '');
      const doc = {
        id: data.nextId++,
        name: input.name,
        platform: input.platform,
        customName: input.customName || '',
        keyEnc: encryptField(masterKey, input.key),
        endpoints: eps,
        base: eps.length ? eps[0].url : '',
        model: input.model || '',
        reg: input.reg || '',
        exp: input.exp || '',
        authNote: input.authNote || '',
        balance: emptyBalance(input.balanceStatus),
        usage: emptyUsage('pending'),
        test: null,
        failCount: 0,
        lastHealthAt: null,
        modelsFetched: false,
        models: [],
        assigned: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      data.keys.push(doc);
      persist();
      return toRec(doc);
    },

    updateKey(id, patch) {
      const d = find(id);
      if (!d) return null;
      ['name', 'platform', 'customName', 'model', 'reg', 'exp', 'authNote'].forEach(function (f) {
        if (patch[f] !== undefined) d[f] = patch[f];
      });
      if (patch.key !== undefined) d.keyEnc = encryptField(masterKey, patch.key);
      if (patch.endpoints !== undefined) {
        d.endpoints = normEps(d.platform, patch.endpoints);
        d.base = d.endpoints.length ? d.endpoints[0].url : '';
      } else if (patch.base !== undefined) {
        d.base = patch.base;
        d.endpoints = legacyEps(d.platform, patch.base);
      }
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    saveBalance(id, balance) {
      const d = find(id);
      if (!d) return null;
      const at = nowIso();
      d.balance = {
        value: balance.value == null ? null : Number(balance.value),
        status: balance.status || 'ok',
        updatedAt: at
      };
      const entry = balanceHistoryOf(balance);
      if (entry) pushHistory(id, entry, at);
      persist();
      return toRec(d);
    },

    /* 用量/限流快照：账户级数据，但快照挂在这把 key 上（谁查的记谁）。
       与 balance 分开存：两者的口径与刷新时机都不一样。 */
    saveUsage(id, usage) {
      const d = find(id);
      if (!d) return null;
      const at = nowIso();
      d.usage = normUsage(Object.assign({}, usage, { updatedAt: at }));
      /* 快照只留最新一份，曲线要靠历史：每次查询都是一个时间点，
         一个窗口写一行（拆分的口径见 usage-history.js） */
      usageHistoryEntries(d.usage).forEach(function (e) { pushHistory(id, e, at); });
      persist();
      return toRec(d);
    },

    saveTest(id, test) {
      const d = find(id);
      if (!d) return null;
      const at = nowIso();
      d.test = Object.assign({ at: at }, test);
      /* 健康快照跟着测试结论走：通过 ⇒ 连续失败清零，失败 ⇒ 加一 */
      const h = healthNext(d.failCount, d.lastHealthAt, test, at);
      d.failCount = h.failCount;
      d.lastHealthAt = h.lastHealthAt;
      pushHistory(id, testHistoryOf(test), at);
      persist();
      return toRec(d);
    },

    /* 只更新健康快照，不写 test、不写观测历史。
       给「代理转发」用：厂商拒了这把 key 就是一次失败，它该被记下来
       （不然下次代理还是先试它），但它不是用户发起的连通测试，
       不该混进「最近观测」里 —— 那个面板是给人看自己的操作记录的。 */
    markKeyHealth(id, ok) {
      const d = find(id);
      if (!d) return null;
      const at = nowIso();
      d.failCount = ok ? 0 : (Number(d.failCount) || 0) + 1;
      d.lastHealthAt = at;
      persist();
      return toRec(d);
    },

    listHistory(id, opts) {
      const o = opts || {};
      let rows = data.history.filter(function (r) { return r.keyId === id; });
      if (o.kind) rows = rows.filter(function (r) { return r.kind === o.kind; });
      const lim = historyLimit(o.limit);
      return rows.slice(Math.max(0, rows.length - lim)).map(function (r) { return Object.assign({}, r); });
    },

    replaceModels(id, rawModels) {
      const models = dedupeById((rawModels || []).map(normModel));
      const d = find(id);
      if (!d) return null;
      d.models = models;
      d.modelsFetched = true;
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    upsertModel(id, raw) {
      const m = normModel(raw);
      const d = find(id);
      if (!d) return null;
      d.models = d.models || [];
      let hit = null;
      for (let i = 0; i < d.models.length; i++) {
        if (d.models[i].id === m.id) { hit = d.models[i]; break; }
      }
      if (!hit) {
        hit = { id: m.id, ctx: null, out: null, src: m.src || 'manual', note: null };
        d.models.push(hit);
      }
      ['ctx', 'out', 'src', 'note'].concat(MODEL_EXTRA).forEach(function (f) {
        if (m[f] !== undefined) hit[f] = m[f];
      });
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    upsertModels(id, rawModels) {
      const models = dedupeById((rawModels || []).map(normModel));
      const d = find(id);
      if (!d) return null;
      d.models = d.models || [];
      models.forEach(function (m) {
        let hit = null;
        for (let i = 0; i < d.models.length; i++) {
          if (d.models[i].id === m.id) { hit = d.models[i]; break; }
        }
        if (!hit) {
          hit = { id: m.id, ctx: null, out: null, src: m.src || 'manual', note: null };
          d.models.push(hit);
        }
        ['ctx', 'out', 'src', 'note'].concat(MODEL_EXTRA).forEach(function (f) {
          if (m[f] !== undefined) hit[f] = m[f];
        });
      });
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    addAssigned(id, tool, host) {
      const d = find(id);
      if (!d) return null;
      const entry = assignedEntry(tool, host);
      if (!entry.tool) return null;
      d.assigned = normAssigned(d.assigned);
      if (d.assigned.some(function (e) { return e.tool === entry.tool && e.host === entry.host; })) return null;
      d.assigned.push(entry);
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    /* host 传 undefined = 这个工具在所有电脑上的登记一起取消；传字符串（含空串）只取消那一台。
       tool/host 与 add 一样先 trim：DELETE 带空格的工具名要能删掉（审查 A-2） */
    removeAssigned(id, tool, host) {
      const d = find(id);
      if (!d) return null;
      const wantTool = String(tool == null ? '' : tool).trim();
      const wantHost = host === undefined ? undefined : String(host == null ? '' : host).trim();
      d.assigned = normAssigned(d.assigned).filter(function (e) {
        if (e.tool !== wantTool) return true;
        if (wantHost === undefined) return false;
        return e.host !== wantHost;
      });
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    deleteKey(id) {
      const before = data.keys.length;
      data.keys = data.keys.filter(function (x) { return x.id !== id; });
      if (data.keys.length === before) return false;
      data.history = data.history.filter(function (r) { return r.keyId !== id; });
      /* 密钥删除后从所有账号池里摘除，避免池里残留指向已删密钥的 id */
      data.pools.forEach(function (p) {
        if (!Array.isArray(p.members)) p.members = memberTable(p.keyIds, null);
        const idx = p.members.findIndex(function (m) { return m.keyId === id; });
        if (idx >= 0) { p.members.splice(idx, 1); p.members = normalizeMembers(p.members); }
      });
      persist();
      return true;
    },

    /* ---------- 账号池（与 SQLite 后端同名方法、同结果） ---------- */

    listPools() { return data.pools.map(toPool); },

    getPool(id) {
      const d = data.pools.find(function (p) { return p.id === id; });
      return d ? toPool(d) : null;
    },

    createPool(input) {
      const doc = {
        id: data.nextPoolId++,
        name: input.name,
        members: memberTable(input.keyIds, null),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      data.pools.push(doc);
      persist();
      return toPool(doc);
    },

    updatePool(id, patch) {
      const d = data.pools.find(function (p) { return p.id === id; });
      if (!d) return null;
      if (patch.name !== undefined) d.name = patch.name;
      if (patch.keyIds !== undefined) {
        /* 改成员名单不换当前生效那把：原来那把还在名单里就还在，
           不在了才让名单第一把顶上 */
        if (!Array.isArray(d.members)) d.members = memberTable(d.keyIds, null);
        const ids = poolIds(patch.keyIds);
        const keep = d.members.filter(function (m) {
          return m.role === 'active' && ids.indexOf(m.keyId) >= 0;
        })[0];
        d.members = memberTable(ids, keep ? keep.keyId : null);
      }
      d.updatedAt = nowIso();
      persist();
      return toPool(d);
    },

    deletePool(id) {
      const before = data.pools.length;
      data.pools = data.pools.filter(function (p) { return p.id !== id; });
      if (data.pools.length === before) return false;
      persist();
      return true;
    },

    addPoolKey(poolId, keyId) {
      const d = data.pools.find(function (p) { return p.id === poolId; });
      if (!d) return null;
      if (!Array.isArray(d.members)) d.members = memberTable(d.keyIds, null);
      if (d.members.some(function (m) { return m.keyId === keyId; })) return null;
      /* 池里已经有当前生效的那把 ⇒ 新来的排进备用队列队尾；
         还没有（空池或老库池）⇒ 新来的就是当前生效那把 */
      const hasActive = d.members.some(function (m) { return m.role === 'active'; });
      d.members.push({ keyId: keyId, role: hasActive ? 'backup' : 'active', sortIndex: d.members.length });
      d.members = normalizeMembers(d.members);
      d.updatedAt = nowIso();
      persist();
      return toPool(d);
    },

    removePoolKey(poolId, keyId) {
      const d = data.pools.find(function (p) { return p.id === poolId; });
      if (!d) return null;
      if (!Array.isArray(d.members)) d.members = memberTable(d.keyIds, null);
      const idx = d.members.findIndex(function (m) { return m.keyId === keyId; });
      if (idx < 0) return null;
      d.members.splice(idx, 1);
      /* 删掉的正好是当前生效那把 ⇒ 归一时把备用队首提上来，
         否则池子会变成「一把都不能用」的状态 */
      d.members = normalizeMembers(d.members);
      d.updatedAt = nowIso();
      persist();
      return toPool(d);
    },

    /* ---------- 轮换语义（与 SQLite 后端同名方法、同结果） ---------- */

    setPoolActive(poolId, keyId) {
      const d = data.pools.find(function (p) { return p.id === poolId; });
      if (!d) return null;
      if (!Array.isArray(d.members)) d.members = memberTable(d.keyIds, null);
      const m = d.members.find(function (x) { return x.keyId === keyId; });
      if (!m) return null;
      /* 新的当当前生效；旧的降级后排到备用队列末尾（它没坏，只是排到了后面） */
      const oldActive = d.members.filter(function (x) { return x.role === 'active' && x.keyId !== keyId; });
      const backups = d.members.filter(function (x) { return x.role !== 'active' && x.keyId !== keyId; })
        .sort(function (a, b) { return (a.sortIndex || 0) - (b.sortIndex || 0); });
      const out = [{ keyId: keyId, role: 'active', sortIndex: 0 }];
      backups.concat(oldActive).forEach(function (x) {
        out.push({ keyId: x.keyId, role: 'backup', sortIndex: out.length });
      });
      d.members = out;
      d.updatedAt = nowIso();
      persist();
      return toPool(d);
    },

    setPoolBackupOrder(poolId, keyIds) {
      const d = data.pools.find(function (p) { return p.id === poolId; });
      if (!d) return null;
      if (!Array.isArray(d.members)) d.members = memberTable(d.keyIds, null);
      const want = poolIds(keyIds);
      const act = d.members.filter(function (x) { return x.role === 'active'; });
      const backups = d.members.filter(function (x) { return x.role !== 'active'; })
        .sort(function (a, b) { return (a.sortIndex || 0) - (b.sortIndex || 0); });
      /* 按给定顺序排队；名单外的排最后 */
      const ordered = want.map(function (id) {
        return backups.filter(function (x) { return x.keyId === id; })[0];
      }).filter(Boolean);
      backups.forEach(function (x) { if (ordered.indexOf(x) < 0) ordered.push(x); });
      const out = act.map(function (x) { return { keyId: x.keyId, role: 'active', sortIndex: 0 }; });
      ordered.forEach(function (x) { out.push({ keyId: x.keyId, role: 'backup', sortIndex: out.length }); });
      d.members = out;
      d.updatedAt = nowIso();
      persist();
      return toPool(d);
    },

    /* ---------- 凭证保险库（与 SQLite 后端同名方法、同结果；密文原样进原样出） ---------- */

    createCredential(input) {
      const doc = credNew(input);
      doc.id = data.nextCredentialId++;
      doc.createdAt = nowIso();
      doc.updatedAt = doc.createdAt;
      data.credentials.push(doc);
      persist();
      return credRecord(doc);
    },

    getCredential(id) {
      const d = findCred(id);
      return d ? credRecord(d) : null;
    },

    listCredentials() {
      return data.credentials.slice()
        .sort(function (a, b) { return Number(a.id) - Number(b.id); })
        .map(credRecord);
    },

    updateCredential(id, patch) {
      const d = findCred(id);
      if (!d) return null;
      const p = credPatch(patch);
      Object.keys(p).forEach(function (f) { d[f] = p[f]; });
      d.updatedAt = nowIso();
      persist();
      return credRecord(d);
    },

    /* 只是「用了一次」，不算改动记录：只动 last_used_at，updated_at 保持原值 */
    setCredentialLastUsed(id) {
      const d = findCred(id);
      if (!d) return null;
      d.lastUsedAt = nowIso();
      persist();
      return credRecord(d);
    },

    deleteCredential(id) {
      const n = credId(id);
      const before = data.credentials.length;
      data.credentials = data.credentials.filter(function (x) { return x.id !== n; });
      if (data.credentials.length === before) return false;
      persist();
      return true;
    },

    credentialUsernameCounts() {
      return countUsernamesByUsername(data.credentials.map(function (d) { return d.username; }));
    },

    /* ---------- 消费者令牌（与 SQLite 后端同名方法、同结果；存元数据不存令牌本体） ---------- */

    createToken(input) {
      const doc = tokNew(input);
      doc.id = data.nextTokenId++;
      doc.createdAt = nowIso();
      doc.revokedAt = null;
      doc.lastUsedAt = null;
      data.tokens.push(doc);
      persist();
      return tokRecord(doc);
    },

    getToken(tid) {
      const d = findToken(tid);
      return d ? tokRecord(d) : null;
    },

    /* 新的在前：界面上刚签的那一把必须一眼看到，不必数到列表末尾 */
    listTokens() {
      return data.tokens.slice()
        .sort(function (a, b) { return Number(b.id) - Number(a.id); })
        .map(function (d) { return tokRecord(d); });
    },

    /* 幂等：已吊销的再吊销不改时间，也不重复落盘 */
    revokeToken(tid) {
      const d = findToken(tid);
      if (!d) return null;
      if (d.revokedAt == null) {
        d.revokedAt = nowIso();
        persist();
      }
      return tokRecord(d);
    },

    setTokenLastUsed(tid) {
      const d = findToken(tid);
      if (!d) return null;
      d.lastUsedAt = nowIso();
      persist();
      return tokRecord(d);
    },

    /* 清空**签发记录**（不是吊销）：恢复码重置口令成功后用它把之前签出去的令牌一次性作废。
       ⚠ 只动 tokens 这一张表——keys / credentials / pools / 密文一律不碰：
       忘口令是来找回访问权的，不是来删库的；换 DEK + 全量重加密那是格式化重来，用户明确否掉了。
       nextTokenId 不回收：id 复用会让审计里的行号对不上旧记录。
       返回清掉的条数（0 = 本来就一把都没有），api 层拿它记审计。 */
    clearTokens() {
      const n = data.tokens.length;
      if (!n) return 0;
      data.tokens = [];
      persist();
      return n;
    }
  };
}

/* ================= SQLite 后端（node:sqlite） ================= */

function makeSqliteStore(dataDir, masterKey, DatabaseSync) {
  const dbPath = path.join(dataDir, 'keys.db');
  console.log('  SQLite database path:', dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec([
    'CREATE TABLE IF NOT EXISTS keys (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  name TEXT NOT NULL,',
    '  platform TEXT NOT NULL,',
    '  custom_name TEXT DEFAULT \'\',',
    '  key_enc TEXT NOT NULL,',
    '  base TEXT DEFAULT \'\',',
    '  endpoints_json TEXT,',
    '  model TEXT DEFAULT \'\',',
    '  reg TEXT DEFAULT \'\',',
    '  exp TEXT DEFAULT \'\',',
    '  auth_note TEXT DEFAULT \'\',',
    '  balance_value REAL,',
    '  balance_status TEXT DEFAULT \'pending\',',
    '  balance_updated_at TEXT,',
    /* 用量/限流快照（账户级口径，与 balance 分开存） */
    '  usage_json TEXT,',
    '  usage_status TEXT DEFAULT \'pending\',',
    '  usage_msg TEXT,',
    '  usage_updated_at TEXT,',
    '  test_json TEXT,',
    '  fail_count INTEGER DEFAULT 0,',
    '  last_health_at TEXT,',
    '  models_fetched INTEGER DEFAULT 0,',
    '  created_at TEXT,',
    '  updated_at TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS models (',
    '  key_id INTEGER NOT NULL,',
    '  id TEXT NOT NULL,',
    '  ctx INTEGER,',
    '  out INTEGER,',
    '  src TEXT DEFAULT \'meta\',',
    '  note TEXT,',
    '  extra TEXT,',
    '  PRIMARY KEY (key_id, id)',
    ');',
    'CREATE TABLE IF NOT EXISTS assigned (',
    '  key_id INTEGER NOT NULL,',
    '  tool TEXT NOT NULL,',
    "  host TEXT NOT NULL DEFAULT '',",
    '  PRIMARY KEY (key_id, tool, host)',
    ');',
    'CREATE TABLE IF NOT EXISTS history (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  key_id INTEGER NOT NULL,',
    '  at TEXT NOT NULL,',
    '  kind TEXT NOT NULL,',
    '  status TEXT,',
    '  latency INTEGER,',
    '  value REAL,',
    '  detail TEXT',
    ');',
    'CREATE INDEX IF NOT EXISTS history_key_kind ON history (key_id, kind, id);',
    /* 凭证保险库：四个 *_enc 列存 crypto.js 的密文，这一层不碰加解密；
       其余列明文，跟 keys 表的做法一致。老库没这张表时 IF NOT EXISTS 直接补建 */
    'CREATE TABLE IF NOT EXISTS credentials (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  title TEXT DEFAULT \'\',',
    '  username TEXT DEFAULT \'\',',
    '  url TEXT DEFAULT \'\',',
    '  site TEXT DEFAULT \'\',',
    '  login_method TEXT DEFAULT \'\',',
    '  folder TEXT DEFAULT \'\',',
    '  tags TEXT DEFAULT \'\',',
    '  password_enc TEXT,',
    '  secret_enc TEXT,',
    '  totp_enc TEXT,',
    '  note_enc TEXT,',
    '  created_at TEXT,',
    '  updated_at TEXT,',
    '  last_used_at TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS pools (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  name TEXT NOT NULL,',
    '  created_at TEXT,',
    '  updated_at TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS pool_keys (',
    '  pool_id INTEGER NOT NULL,',
    '  key_id INTEGER NOT NULL,',
      /* 下面两列是「轮换」的地基：没有它们就分不清谁是当前生效、谁在备用队列里排队。
         role: active=当前生效那把，backup=备用队列里的；一把池最多一把 active（靠代码守）。
         sort_index: 备用队列的顺序（0 起），active 那把不参与排序。 */
      '  role TEXT DEFAULT \'backup\',',
      '  sort_index INTEGER DEFAULT 0,',
    '  PRIMARY KEY (pool_id, key_id)',
    ');',
    /* 消费者令牌：tid 是令牌中 12 字节随机数的十六进制， UNIQUE 靠它兜住重复签发；
       三个 *_json 列存的是明文清单（这些 id 在掩码列表里本来就看得见），签名令牌永不入库 */
    'CREATE TABLE IF NOT EXISTS tokens (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  tid TEXT NOT NULL UNIQUE,',
    '  fingerprint TEXT DEFAULT \'\',',
    '  label TEXT DEFAULT \'\',',
    '  scopes_json TEXT DEFAULT \'[]\',',
    '  key_ids_json TEXT DEFAULT \'[]\',',
    '  cred_ids_json TEXT DEFAULT \'[]\',',
    '  iat INTEGER DEFAULT 0,',
    '  exp INTEGER DEFAULT 0,',
    '  revoked_at TEXT,',
    '  last_used_at TEXT,',
    '  created_at TEXT',
    ');'
  ].join('\n'));
  try {
    db.exec('ALTER TABLE keys ADD COLUMN endpoints_json TEXT');
  } catch (e) { /* 旧库已有该列或新库已含，忽略 */ }
  try {
    db.exec('ALTER TABLE keys ADD COLUMN auth_note TEXT');
  } catch (e) { /* 旧库已有该列或新库已含，忽略 */ }

  /* 健康快照两列：老库逐列补，抛错即列已存在 */
  try { db.exec('ALTER TABLE keys ADD COLUMN fail_count INTEGER DEFAULT 0'); } catch (e) { /* 已有 */ }
  try { db.exec('ALTER TABLE keys ADD COLUMN last_health_at TEXT'); } catch (e) { /* 已有 */ }
  /* 用量/限流快照三列：老库逐列补，抛错即列已存在。
     ★ 这里必须写 ALTER TABLE：上面那句 CREATE TABLE IF NOT EXISTS 对老库是空操作，
       光改建表语句的话，老库一打开就在 prepare 那几步抛 "no such column" ——
       服务在老库上根本起不来（本项目上周刚踩过这个坑，是 P0）。 */
  try { db.exec('ALTER TABLE keys ADD COLUMN usage_json TEXT'); } catch (e) { /* 已有 */ }
  try { db.exec('ALTER TABLE keys ADD COLUMN usage_status TEXT DEFAULT \'pending\''); } catch (e) { /* 已有 */ }
  try { db.exec('ALTER TABLE keys ADD COLUMN usage_msg TEXT'); } catch (e) { /* 已有 */ }
  try { db.exec('ALTER TABLE keys ADD COLUMN usage_updated_at TEXT'); } catch (e) { /* 已有 */ }
  /* pool_keys 的 role/sort_index 是「轮换」的地基。老库（加这两列之前建的）没有它们：
     不补的话，下面 prepare 这几条语句时就会 "no such column: role" 直接崩 ——
     服务在老库上根本起不来，不是用到池子才出问题。 */
  try { db.exec('ALTER TABLE pool_keys ADD COLUMN role TEXT DEFAULT \'backup\''); } catch (e) { /* 已有 */ }
  try { db.exec('ALTER TABLE pool_keys ADD COLUMN sort_index INTEGER DEFAULT 0'); } catch (e) { /* 已有 */ }
  /* models 表里不该有 role/sort_index —— 那是 pool_keys 的列，上一版插错了表。
     新库已经不建这两列；老库上把多余的删掉（SQLite 3.35+ 才支持 DROP COLUMN，
     版本不够就留着：没人写它们，留着也无害）。 */
  ['role', 'sort_index'].forEach(function (col) {
    try { db.exec('ALTER TABLE models DROP COLUMN ' + col); } catch (e) { /* 老版本 SQLite 不支持，留着无害 */ }
  });
  try {
    db.exec('ALTER TABLE models ADD COLUMN extra TEXT');
  } catch (e) { /* 旧库已有该列或新库已含，忽略 */ }
  /* 凭证表后加的网站/登录方式列：老库逐列补，抛错即列已存在 */
  ['site TEXT DEFAULT \'\'', 'login_method TEXT DEFAULT \'\''].forEach(function (col) {
    try { db.exec('ALTER TABLE credentials ADD COLUMN ' + col); } catch (e) { /* 已有 */ }
  });
  /* assigned 的主键从 (key_id, tool) 扩成 (key_id, tool, host)：同一工具可以登记在
     多台电脑上。SQLite 改不了主键，旧库整表重建一次；host 列已在新库上，幂等 */
  if (!db.prepare('PRAGMA table_info(assigned)').all().some(function (c) { return c.name === 'host'; })) {
    db.exec([
      'BEGIN IMMEDIATE;',
      "CREATE TABLE assigned_v2 (key_id INTEGER NOT NULL, tool TEXT NOT NULL, host TEXT NOT NULL DEFAULT '', PRIMARY KEY (key_id, tool, host));",
      "INSERT OR IGNORE INTO assigned_v2 (key_id, tool, host) SELECT key_id, tool, '' FROM assigned;",
      'DROP TABLE assigned;',
      'ALTER TABLE assigned_v2 RENAME TO assigned;',
      'COMMIT;'
    ].join('\n'));
  }

  const stmt = {
    selectAll: db.prepare('SELECT * FROM keys ORDER BY id'),
    selectOne: db.prepare('SELECT * FROM keys WHERE id = ?'),
    insert: db.prepare('INSERT INTO keys (name, platform, custom_name, key_enc, base, endpoints_json, model, reg, exp, auth_note, balance_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE keys SET name = ?, platform = ?, custom_name = ?, key_enc = ?, base = ?, endpoints_json = ?, model = ?, reg = ?, exp = ?, auth_note = ?, updated_at = ? WHERE id = ?'),
    setBalance: db.prepare('UPDATE keys SET balance_value = ?, balance_status = ?, balance_updated_at = ? WHERE id = ?'),
    /* 用量/限流快照：快照本体一列，状态与时间各一列（与 balance 同款拆法） */
    setUsage: db.prepare('UPDATE keys SET usage_json = ?, usage_status = ?, usage_msg = ?, usage_updated_at = ? WHERE id = ?'),
    setTest: db.prepare('UPDATE keys SET test_json = ? WHERE id = ?'),
    /* 健康快照：连续失败次数与最近一次有结论的探测时间 */
    setKeyHealth: db.prepare('UPDATE keys SET fail_count = ?, last_health_at = ? WHERE id = ?'),
    setModelsFetched: db.prepare('UPDATE keys SET models_fetched = 1 WHERE id = ?'),
    touch: db.prepare('UPDATE keys SET updated_at = ? WHERE id = ?'),
    delKey: db.prepare('DELETE FROM keys WHERE id = ?'),
    selModels: db.prepare('SELECT id, ctx, out, src, note, extra FROM models WHERE key_id = ? ORDER BY rowid'),
    delModels: db.prepare('DELETE FROM models WHERE key_id = ?'),
    insModel: db.prepare('INSERT INTO models (key_id, id, ctx, out, src, note, extra) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    selModel: db.prepare('SELECT id, ctx, out, src, note, extra FROM models WHERE key_id = ? AND id = ?'),
    updModel: db.prepare('UPDATE models SET ctx = ?, out = ?, src = ?, note = ?, extra = ? WHERE key_id = ? AND id = ?'),
    selAssigned: db.prepare('SELECT tool, host FROM assigned WHERE key_id = ? ORDER BY rowid'),
    insAssigned: db.prepare('INSERT OR IGNORE INTO assigned (key_id, tool, host) VALUES (?, ?, ?)'),
    delAssigned: db.prepare('DELETE FROM assigned WHERE key_id = ? AND tool = ? AND host = ?'),
    delAssignedAllTool: db.prepare('DELETE FROM assigned WHERE key_id = ? AND tool = ?'),
    delAssignedAll: db.prepare('DELETE FROM assigned WHERE key_id = ?'),
    insHistory: db.prepare('INSERT INTO history (key_id, at, kind, status, latency, value, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    selHistory: db.prepare('SELECT * FROM history WHERE key_id = ? ORDER BY id DESC LIMIT ?'),
    selHistoryKind: db.prepare('SELECT * FROM history WHERE key_id = ? AND kind = ? ORDER BY id DESC LIMIT ?'),
    trimHistory: db.prepare('DELETE FROM history WHERE key_id = ? AND id NOT IN (SELECT id FROM history WHERE key_id = ? ORDER BY id DESC LIMIT ?)'),
    delHistory: db.prepare('DELETE FROM history WHERE key_id = ?'),
    insCredential: db.prepare('INSERT INTO credentials (title, username, url, site, login_method, folder, tags, password_enc, secret_enc, totp_enc, note_enc, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    selCredential: db.prepare('SELECT * FROM credentials WHERE id = ?'),
    selAllCredentials: db.prepare('SELECT * FROM credentials ORDER BY id'),
    updCredential: db.prepare('UPDATE credentials SET title = ?, username = ?, url = ?, site = ?, login_method = ?, folder = ?, tags = ?, password_enc = ?, secret_enc = ?, totp_enc = ?, note_enc = ?, updated_at = ? WHERE id = ?'),
    setCredentialLastUsed: db.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?'),
    delCredential: db.prepare('DELETE FROM credentials WHERE id = ?'),
    selCredentialUsernames: db.prepare('SELECT username, COUNT(*) AS count FROM credentials GROUP BY username'),
    selAllPools: db.prepare('SELECT * FROM pools ORDER BY id'),
    selPool: db.prepare('SELECT * FROM pools WHERE id = ?'),
    insPool: db.prepare('INSERT INTO pools (name, created_at, updated_at) VALUES (?, ?, ?)'),
    updPool: db.prepare('UPDATE pools SET name = ?, updated_at = ? WHERE id = ?'),
    delPool: db.prepare('DELETE FROM pools WHERE id = ?'),
    delPoolKeys: db.prepare('DELETE FROM pool_keys WHERE pool_id = ?'),
    delPoolKeyByKey: db.prepare('DELETE FROM pool_keys WHERE key_id = ?'),
    /* rowid 也要带出来：并列时按插入顺序断（老库补列后所有成员 sort_index 都是 0） */
    selPoolKeys: db.prepare('SELECT key_id, role, sort_index, rowid AS rid FROM pool_keys WHERE pool_id = ? ORDER BY CASE role WHEN \'active\' THEN 0 ELSE 1 END, sort_index, rowid'),
    insPoolKey: db.prepare('INSERT OR IGNORE INTO pool_keys (pool_id, key_id, role, sort_index) VALUES (?, ?, ?, ?)'),
    delPoolKey: db.prepare('DELETE FROM pool_keys WHERE pool_id = ? AND key_id = ?'),
    /* 池成员角色与排队顺序的统一写入口（归一与轮换都走它） */
    setPoolKeyRole: db.prepare('UPDATE pool_keys SET role = ?, sort_index = ? WHERE pool_id = ? AND key_id = ?'),
    touchPool: db.prepare('UPDATE pools SET updated_at = ? WHERE id = ?'),
    insToken: db.prepare('INSERT INTO tokens (tid, fingerprint, label, scopes_json, key_ids_json, cred_ids_json, iat, exp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    selToken: db.prepare('SELECT * FROM tokens WHERE tid = ?'),
    selAllTokens: db.prepare('SELECT * FROM tokens ORDER BY id DESC'),
    revokeToken: db.prepare('UPDATE tokens SET revoked_at = ? WHERE tid = ? AND revoked_at IS NULL'),
    setTokenLastUsed: db.prepare('UPDATE tokens SET last_used_at = ? WHERE tid = ?'),
    countTokens: db.prepare('SELECT COUNT(*) AS n FROM tokens'),
    clearTokens: db.prepare('DELETE FROM tokens')
  };

  /* 池成员归一：active 有且只有一把（占 0），其余 backup 从 1 起按原 sort_index 排队。
     与 JSON 后端的 normalizeMembers 同一套口径 —— 两个后端必须给出同一份结果。
     一把 active 都没有时队首那把顶上（老安装一直是「队首就是当前在用的」）。 */
  function renumberPoolKeys(poolId) {
    const rows = stmt.selPoolKeys.all(poolId);
    if (!rows.length) return;
    let act = rows.filter(function (r) { return r.role === 'active'; })[0] || null;
    const bak = rows
      .filter(function (r) { return !act || Number(r.key_id) !== Number(act.key_id); })
      .sort(function (a, b) { return (a.sort_index || 0) - (b.sort_index || 0) || Number(a.rid) - Number(b.rid); });
    if (!act && bak.length) act = bak.splice(0, 1)[0];
    if (act) stmt.setPoolKeyRole.run('active', 0, poolId, Number(act.key_id));
    bak.forEach(function (r, i) { stmt.setPoolKeyRole.run('backup', i + 1, poolId, Number(r.key_id)); });
  }

  /* 老库的 pool_keys 补上 role/sort_index 之后，每一行都是 backup、sort_index 都是 0
     —— 一个池里一把 active 都没有。按老安装的口径（队首就是当前在用的）归一一次。 */
  db.prepare('SELECT DISTINCT pool_id FROM pool_keys').all().forEach(function (p) {
    renumberPoolKeys(Number(p.pool_id));
  });

  /* 按字段来源与能力位不各占一列，统一存进 extra 一列 JSON：逐字段加列要为每个字段迁移一次，而 modalitiesIn 本身是数组终究要存 JSON。新增字段进这张表就不会再被持久层静默丢掉。 */
  function extraOf(m) {
    const o = {};
    MODEL_EXTRA.forEach(function (k) { if (m[k] !== undefined && m[k] !== null) o[k] = m[k]; });
    return Object.keys(o).length ? JSON.stringify(o) : null;
  }
  /* 局部更新时不能整列覆盖：补丁只带 reasoning 也要保住已有的 ctxSrc，所以先解旧值再按 undefined=不动 / null=删除 合并。 */
  function extraFor(m, prevJson) {
    const o = {};
    try {
      const prev = prevJson ? JSON.parse(prevJson) : null;
      if (prev && typeof prev === 'object') Object.keys(prev).forEach(function (k) { o[k] = prev[k]; });
    } catch (e) { /* 旧值损坏则从头写 */ }
    MODEL_EXTRA.forEach(function (k) {
      if (m[k] === undefined) return;
      if (m[k] === null) delete o[k]; else o[k] = m[k];
    });
    return Object.keys(o).length ? JSON.stringify(o) : null;
  }
  function modelFromRow(r) {
    const base = { id: r.id, ctx: r.ctx == null ? null : r.ctx, out: r.out == null ? null : r.out, src: r.src || 'api', note: r.note == null ? null : r.note };
    if (!r.extra) return base;
    try {
      const o = JSON.parse(r.extra);
      if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { base[k] = o[k]; });
    } catch (e) { /* 该列损坏时退回五个基础字段，不整条读不出 */ }
    return base;
  }
  function loadModels(id) {
    return stmt.selModels.all(id).map(modelFromRow).map(deriveFlags);
  }
  function loadAssigned(id) {
    return stmt.selAssigned.all(id).map(function (r) { return { tool: r.tool, host: r.host || '' }; });
  }
  function historyFromRow(r) {
    return {
      id: Number(r.id),
      keyId: Number(r.key_id),
      at: r.at,
      kind: r.kind == null ? null : r.kind,
      status: r.status == null ? null : r.status,
      latency: r.latency == null ? null : r.latency,
      value: r.value == null ? null : r.value,
      detail: r.detail == null ? null : r.detail
    };
  }
  /* 行 id 由 SQLite 的 AUTOINCREMENT 分配，historyRow 里的 seq 只是占位 */
  function pushHistory(keyId, entry, at) {
    const shaped = historyRow(0, keyId, at, entry);
    const r = stmt.insHistory.run(
      keyId, shaped.at, shaped.kind, shaped.status, shaped.latency, shaped.value, shaped.detail
    );
    stmt.trimHistory.run(keyId, keyId, HISTORY_MAX_PER_KEY);
    return Object.assign(shaped, { id: Number(r.lastInsertRowid) });
  }
  function epsOfRow(row) {
    if (row.endpoints_json) {
      try {
        const parsed = JSON.parse(row.endpoints_json);
        if (Array.isArray(parsed)) return normEps(row.platform, parsed);
      } catch (e) { /* JSON 损坏时回退 legacy */ }
    }
    return legacyEps(row.platform, row.base || '');
  }
  /* 快照本体在 usage_json 一列，状态与时间各一列；
     读出来与 JSON 后端走同一个 normUsage，两个后端的形状因此一致。 */
  function usageFromRow(row) {
    let snap = null;
    if (row.usage_json) {
      try { snap = JSON.parse(row.usage_json); } catch (e) { snap = null; }
    }
    const u = normUsage(snap);
    u.status = row.usage_status || u.status || 'pending';
    u.msg = row.usage_msg || u.msg || null;
    u.updatedAt = row.usage_updated_at || null;
    return u;
  }
  function toRec(row) {
    let test = null;
    if (row.test_json) {
      try { test = JSON.parse(row.test_json); } catch (e) { test = null; }
    }
    const eps = epsOfRow(row);
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      customName: row.custom_name || '',
      key: decryptField(masterKey, row.key_enc),
      endpoints: eps,
      base: eps.length ? eps[0].url : '',
      model: row.model || '',
      reg: row.reg || '',
      exp: row.exp || '',
      authNote: row.auth_note || '',
      balance: {
        value: row.balance_value == null ? null : row.balance_value,
        status: row.balance_status || 'pending',
        updatedAt: row.balance_updated_at || null
      },
      usage: usageFromRow(row),
      test: test,
      failCount: Number(row.fail_count) || 0,
      lastHealthAt: row.last_health_at || null,
      modelsFetched: !!row.models_fetched,
      models: loadModels(row.id),
      assigned: loadAssigned(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
  function getRow(id) { return stmt.selectOne.get(id) || null; }

  /* 账号池只存成员 id 列表；成员密钥的完整记录由 API 层用 getKey 现取 */
  function toPool(row) {
    return {
      id: Number(row.id),
      name: row.name,
    members: stmt.selPoolKeys.all(row.id).map(function (r) {
      return {
        keyId: Number(r.key_id),
        role: r.role || 'backup',
        sortIndex: Number(r.sort_index) || 0
      };
    }),
    keyIds: stmt.selPoolKeys.all(row.id).map(function (r) { return Number(r.key_id); }),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /* snake_case 列 → camelCase 内部 doc，再走和 JSON 后端同一个 credRecord() 出口 */
  function credentialFromRow(row) {
    const c = {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at
    };
    CRED_PLAIN.forEach(function (f) { c[f] = row[CRED_PLAIN_COLUMN[f] || f]; });
    CRED_ENC.forEach(function (f) { c[f] = row[CRED_ENC_COLUMN[f]]; });
    return c;
  }
  function credentialRecord(row) { return row ? credRecord(credentialFromRow(row)) : null; }
  /* id 先经 credId 收成数字：非数字一律当查不到，免得把 NaN 绑进 SQL */
  function getCredRow(id) {
    const n = credId(id);
    return Number.isFinite(n) ? (stmt.selCredential.get(n) || null) : null;
  }

  function tokenFromRow(row) {
    return {
      id: row.id,
      tid: tokStr(row.tid),
      fingerprint: tokStr(row.fingerprint),
      label: tokStr(row.label),
      scopes: tokScopes(parseTokJson(row.scopes_json)),
      keyIds: tokIds(parseTokJson(row.key_ids_json)),
      credIds: tokIds(parseTokJson(row.cred_ids_json)),
      iat: tokUnix(row.iat),
      exp: tokUnix(row.exp),
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at
    };
  }
  function tokenRecord(row) { return row ? tokRecord(tokenFromRow(row)) : null; }

  return {
    backend: 'sqlite',
    dataDir: dataDir,

    /* 每次解锁都会 createStore 一次，句柄原本要等进程退出才放。
       闲置自动锁 + 每天几十次锁解，攒的是文件描述符（上限就是 EMFILE 那条线）。 */
    close() { db.close(); },

    listKeys() { return stmt.selectAll.all().map(toRec); },
    getKey(id) { const r = getRow(id); return r ? toRec(r) : null; },

    createKey(input) {
      const now = nowIso();
      const eps = Array.isArray(input.endpoints)
        ? normEps(input.platform, input.endpoints)
        : legacyEps(input.platform, input.base || '');
      const r = stmt.insert.run(
        input.name, input.platform, input.customName || '',
        encryptField(masterKey, input.key),
        eps.length ? eps[0].url : '', JSON.stringify(eps),
        input.model || '', input.reg || '', input.exp || '',
        input.authNote || '', input.balanceStatus || 'pending', now, now
      );
      return toRec(getRow(Number(r.lastInsertRowid)));
    },

    updateKey(id, patch) {
      const cur = getRow(id);
      if (!cur) return null;
      const platform = patch.platform !== undefined ? patch.platform : cur.platform;
      let eps;
      if (patch.endpoints !== undefined) {
        eps = normEps(platform, patch.endpoints);
      } else if (patch.base !== undefined) {
        eps = legacyEps(platform, patch.base);
      } else {
        eps = epsOfRow(cur);
      }
      const merged = {
        name: patch.name !== undefined ? patch.name : cur.name,
        platform: platform,
        customName: patch.customName !== undefined ? patch.customName : (cur.custom_name || ''),
        keyEnc: patch.key !== undefined ? encryptField(masterKey, patch.key) : cur.key_enc,
        base: eps.length ? eps[0].url : '',
        endpointsJson: JSON.stringify(eps),
        model: patch.model !== undefined ? patch.model : cur.model,
        reg: patch.reg !== undefined ? patch.reg : cur.reg,
        exp: patch.exp !== undefined ? patch.exp : cur.exp,
        authNote: patch.authNote !== undefined ? patch.authNote : (cur.auth_note || '')
      };
      stmt.update.run(
        merged.name, merged.platform, merged.customName, merged.keyEnc,
        merged.base, merged.endpointsJson,
        merged.model, merged.reg, merged.exp, merged.authNote, nowIso(), id
      );
      return toRec(getRow(id));
    },

    saveBalance(id, balance) {
      const cur = getRow(id);
      if (!cur) return null;
      const at = nowIso();
      stmt.setBalance.run(
        balance.value == null ? null : Number(balance.value),
        balance.status || 'ok',
        at, id
      );
      const entry = balanceHistoryOf(balance);
      if (entry) pushHistory(id, entry, at);
      return toRec(getRow(id));
    },

    /* 用量/限流快照：与 balance 分开存（账户级口径 vs Key 级口径） */
    saveUsage(id, usage) {
      const cur = getRow(id);
      if (!cur) return null;
      const at = nowIso();
      const u = normUsage(Object.assign({}, usage, { updatedAt: at }));
      stmt.setUsage.run(
        JSON.stringify({ windows: u.windows, kind: u.kind, raw: u.raw }),
        u.status, u.msg, at, id
      );
      /* 与 JSON 后端同一段拆法：快照之外，每个窗口另存一行历史 */
      usageHistoryEntries(u).forEach(function (e) { pushHistory(id, e, at); });
      return toRec(getRow(id));
    },

    saveTest(id, test) {
      const cur = getRow(id);
      if (!cur) return null;
      const at = nowIso();
      stmt.setTest.run(JSON.stringify(Object.assign({ at: at }, test)), id);
      /* 健康快照跟着测试结论走：通过 ⇒ 连续失败清零，失败 ⇒ 加一 */
      const h = healthNext(cur.fail_count, cur.last_health_at, test, at);
      stmt.setKeyHealth.run(h.failCount, h.lastHealthAt, id);
      pushHistory(id, testHistoryOf(test), at);
      return toRec(getRow(id));
    },

    /* 与 JSON 后端同名同语义：只动健康快照，不写 test、不写观测历史 */
    markKeyHealth(id, ok) {
      const cur = getRow(id);
      if (!cur) return null;
      const at = nowIso();
      const failCount = ok ? 0 : (Number(cur.fail_count) || 0) + 1;
      stmt.setKeyHealth.run(failCount, at, id);
      return toRec(getRow(id));
    },

    listHistory(id, opts) {
      const o = opts || {};
      const lim = historyLimit(o.limit);
      const rows = o.kind
        ? stmt.selHistoryKind.all(id, String(o.kind), lim)
        : stmt.selHistory.all(id, lim);
      return rows.map(historyFromRow).reverse();
    },

    replaceModels(id, rawModels) {
      const models = dedupeById((rawModels || []).map(normModel));
      const cur = getRow(id);
      if (!cur) return null;
      stmt.delModels.run(id);
      models.forEach(function (m) {
        stmt.insModel.run(id, m.id, m.ctx == null ? null : m.ctx, m.out == null ? null : m.out, m.src || 'api', m.note == null ? null : m.note, extraOf(m));
      });
      stmt.setModelsFetched.run(id);
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    upsertModel(id, raw) {
      const m = normModel(raw);
      const cur = getRow(id);
      if (!cur) return null;
      const hit = stmt.selModel.get(id, m.id);
      if (hit) {
        stmt.updModel.run(
          m.ctx !== undefined ? (m.ctx == null ? null : m.ctx) : hit.ctx,
          m.out !== undefined ? (m.out == null ? null : m.out) : hit.out,
          m.src !== undefined ? m.src : hit.src,
          m.note !== undefined ? m.note : hit.note,
          extraFor(m, hit.extra),
          id, m.id
        );
      } else {
        stmt.insModel.run(id, m.id, m.ctx == null ? null : m.ctx, m.out == null ? null : m.out, m.src || 'manual', m.note == null ? null : m.note, extraOf(m));
      }
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    upsertModels(id, rawModels) {
      const models = dedupeById((rawModels || []).map(normModel));
      const cur = getRow(id);
      if (!cur) return null;
      try {
        models.forEach(function (m) {
          const hit = stmt.selModel.get(id, m.id);
          if (hit) {
            stmt.updModel.run(
              m.ctx !== undefined ? (m.ctx == null ? null : m.ctx) : hit.ctx,
              m.out !== undefined ? (m.out == null ? null : m.out) : hit.out,
              m.src !== undefined ? m.src : hit.src,
              m.note !== undefined ? m.note : hit.note,
              extraFor(m, hit.extra),
              id, m.id
            );
          } else {
            stmt.insModel.run(id, m.id, m.ctx == null ? null : m.ctx, m.out == null ? null : m.out, m.src || 'manual', m.note == null ? null : m.note, extraOf(m));
          }
        });
        stmt.touch.run(nowIso(), id);
      } catch (e) {
        console.error('upsertModels error:', e.message, 'for key', id, 'with', models.length, 'models');
        console.error('Database path:', dbPath);
        console.error('Database exists:', require('fs').existsSync(dbPath));
        throw e;
      }
      return toRec(getRow(id));
    },

    addAssigned(id, tool, host) {
      const cur = getRow(id);
      if (!cur) return null;
      const entry = assignedEntry(tool, host);
      if (!entry.tool) return null;
      const r = stmt.insAssigned.run(id, entry.tool, entry.host);
      if (r.changes === 0) return null;
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    removeAssigned(id, tool, host) {
      const cur = getRow(id);
      if (!cur) return null;
      /* 与 add 一样先 trim，DELETE 带空格的工具名要能删掉（审查 A-2） */
      const wantTool = String(tool == null ? '' : tool).trim();
      if (host === undefined) stmt.delAssignedAllTool.run(id, wantTool);
      else stmt.delAssigned.run(id, wantTool, String(host == null ? '' : host).trim());
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    deleteKey(id) {
      const cur = getRow(id);
      if (!cur) return false;
      stmt.delModels.run(id);
      stmt.delAssignedAll.run(id);
      stmt.delHistory.run(id);
      /* 密钥被删 ⇒ 从所有池里摘掉，摘完把池成员重新归一
         （删掉的正好是当前生效那把 ⇒ 备用队首提上来） */
      const affected = db.prepare('SELECT DISTINCT pool_id FROM pool_keys WHERE key_id = ?').all(id);
      stmt.delPoolKeyByKey.run(id);
      affected.forEach(function (p) { renumberPoolKeys(Number(p.pool_id)); });
      stmt.delKey.run(id);
      return true;
    },

    /* ---------- 账号池（与 JSON 后端同名方法、同结果） ---------- */

    listPools() { return stmt.selAllPools.all().map(toPool); },

    getPool(id) {
      const r = stmt.selPool.get(id);
      return r ? toPool(r) : null;
    },

    createPool(input) {
      const now = nowIso();
      const r = stmt.insPool.run(input.name, now, now);
      const poolId = Number(r.lastInsertRowid);
      memberTable(input.keyIds, null).forEach(function (m) {
        stmt.insPoolKey.run(poolId, m.keyId, m.role, m.sortIndex);
      });
      return toPool(stmt.selPool.get(poolId));
    },

    updatePool(id, patch) {
      const cur = stmt.selPool.get(id);
      if (!cur) return null;
      stmt.updPool.run(patch.name !== undefined ? patch.name : cur.name, nowIso(), id);
      if (patch.keyIds !== undefined) {
        /* 改成员名单不换当前生效那把：原来那把还在名单里就还在，
           不在了才让名单第一把顶上 */
        const ids = poolIds(patch.keyIds);
        const keep = stmt.selPoolKeys.all(id).filter(function (r) {
          return r.role === 'active' && ids.indexOf(Number(r.key_id)) >= 0;
        })[0];
        stmt.delPoolKeys.run(id);
        memberTable(ids, keep ? Number(keep.key_id) : null).forEach(function (m) {
          stmt.insPoolKey.run(id, m.keyId, m.role, m.sortIndex);
        });
      }
      return toPool(stmt.selPool.get(id));
    },

    deletePool(id) {
      const cur = stmt.selPool.get(id);
      if (!cur) return false;
      stmt.delPoolKeys.run(id);
      stmt.delPool.run(id);
      return true;
    },

    addPoolKey(poolId, keyId) {
      const cur = stmt.selPool.get(poolId);
      if (!cur) return null;
      const existing = stmt.selPoolKeys.all(poolId);
      if (existing.some(function (r) { return Number(r.key_id) === Number(keyId); })) return null;
      /* 池里已经有当前生效的那把 ⇒ 新来的排进备用队列队尾；
         还没有（空池或老库池）⇒ 新来的就是当前生效那把 */
      const hasActive = existing.some(function (r) { return r.role === 'active'; });
      const backups = existing.filter(function (r) { return r.role !== 'active'; });
      const r = stmt.insPoolKey.run(poolId, keyId, hasActive ? 'backup' : 'active', hasActive ? backups.length + 1 : 0);
      if (r.changes === 0) return null;
      renumberPoolKeys(poolId);
      stmt.touchPool.run(nowIso(), poolId);
      return toPool(stmt.selPool.get(poolId));
    },

    removePoolKey(poolId, keyId) {
      const cur = stmt.selPool.get(poolId);
      if (!cur) return null;
      const r = stmt.delPoolKey.run(poolId, keyId);
      if (r.changes === 0) return null;
      /* 删掉的正好是当前生效那把 ⇒ 归一时把备用队首提上来，
         否则池子会变成「一把都不能用」的状态 */
      renumberPoolKeys(poolId);
      stmt.touchPool.run(nowIso(), poolId);
      return toPool(stmt.selPool.get(poolId));
    },

    /* ---------- 轮换语义（与 JSON 后端同名方法、同结果） ---------- */

    setPoolActive(poolId, keyId) {
      const cur = stmt.selPool.get(poolId);
      if (!cur) return null;
      const members = stmt.selPoolKeys.all(poolId);
      if (!members.some(function (r) { return Number(r.key_id) === Number(keyId); })) return null;
      /* 新的当当前生效；旧的降级后排到备用队列末尾（它没坏，只是排到了后面） */
      const target = Number(keyId);
      const oldActive = members.filter(function (r) { return r.role === 'active' && Number(r.key_id) !== target; });
      const backups = members.filter(function (r) { return r.role !== 'active' && Number(r.key_id) !== target; })
        .sort(function (a, b) { return (a.sort_index || 0) - (b.sort_index || 0); });
      stmt.setPoolKeyRole.run('active', 0, poolId, target);
      backups.concat(oldActive).forEach(function (r, i) {
        stmt.setPoolKeyRole.run('backup', i + 1, poolId, Number(r.key_id));
      });
      stmt.touchPool.run(nowIso(), poolId);
      return toPool(stmt.selPool.get(poolId));
    },

    setPoolBackupOrder(poolId, keyIds) {
      const cur = stmt.selPool.get(poolId);
      if (!cur) return null;
      const want = poolIds(keyIds);
      const rows = stmt.selPoolKeys.all(poolId);
      const act = rows.filter(function (r) { return r.role === 'active'; })[0] || null;
      const backups = rows.filter(function (r) { return r.role !== 'active'; })
        .sort(function (a, b) { return (a.sort_index || 0) - (b.sort_index || 0); });
      /* 按给定顺序排队；名单外的排最后 */
      const ordered = want.map(function (id) {
        return backups.filter(function (r) { return Number(r.key_id) === id; })[0];
      }).filter(Boolean);
      backups.forEach(function (r) { if (ordered.indexOf(r) < 0) ordered.push(r); });
      if (act) stmt.setPoolKeyRole.run('active', 0, poolId, Number(act.key_id));
      ordered.forEach(function (r, i) { stmt.setPoolKeyRole.run('backup', i + 1, poolId, Number(r.key_id)); });
      stmt.touchPool.run(nowIso(), poolId);
      return toPool(stmt.selPool.get(poolId));
    },

    /* ---------- 凭证保险库（与 JSON 后端同名方法、同结果；密文原样进原样出） ---------- */

    createCredential(input) {
      const now = nowIso();
      const doc = credNew(input);
      const r = stmt.insCredential.run(
        doc.title, doc.username, doc.url, doc.site, doc.loginMethod, doc.folder, doc.tags,
        doc.passwordEnc, doc.secretEnc, doc.totpEnc, doc.noteEnc,
        now, now, null
      );
      return credentialRecord(getCredRow(Number(r.lastInsertRowid)));
    },

    getCredential(id) { return credentialRecord(getCredRow(id)); },

    listCredentials() { return stmt.selAllCredentials.all().map(credentialRecord); },

    updateCredential(id, patch) {
      const cur = getCredRow(id);
      if (!cur) return null;
      const merged = Object.assign(credentialFromRow(cur), credPatch(patch));
      /* 四个密文列再走一次 credCipher：对字符串是恒等，只是挡住 undefined 绑进 SQL（node:sqlite 会抛） */
      stmt.updCredential.run(
        credText(merged.title), credText(merged.username), credText(merged.url), credText(merged.site), credText(merged.loginMethod),
        credText(merged.folder), credText(merged.tags),
        credCipher(merged.passwordEnc), credCipher(merged.secretEnc),
        credCipher(merged.totpEnc), credCipher(merged.noteEnc),
        nowIso(), cur.id
      );
      return credentialRecord(getCredRow(cur.id));
    },

    /* 只是「用了一次」，不算改动记录：只动 last_used_at，updated_at 保持原值 */
    setCredentialLastUsed(id) {
      const cur = getCredRow(id);
      if (!cur) return null;
      stmt.setCredentialLastUsed.run(nowIso(), cur.id);
      return credentialRecord(getCredRow(cur.id));
    },

    deleteCredential(id) {
      const cur = getCredRow(id);
      if (!cur) return false;
      stmt.delCredential.run(cur.id);
      return true;
    },

    credentialUsernameCounts() {
      return credUsernameCounts(stmt.selCredentialUsernames.all().map(function (r) {
        return { username: r.username, count: r.count };
      }));
    },

    /* ---------- 消费者令牌（与 JSON 后端同名方法、同结果；存元数据不存令牌本体） ---------- */

    createToken(input) {
      const doc = tokNew(input);
      stmt.insToken.run(
        doc.tid, doc.fingerprint, doc.label,
        tokJsonArray(doc.scopes), tokJsonArray(doc.keyIds), tokJsonArray(doc.credIds),
        doc.iat, doc.exp, nowIso()
      );
      return tokenRecord(stmt.selToken.get(doc.tid) || null);
    },

    getToken(tid) {
      const t = tokStr(tid);
      return tokenRecord(t ? (stmt.selToken.get(t) || null) : null);
    },

    /* 新的在前：与 JSON 后端同序 */
    listTokens() { return stmt.selAllTokens.all().map(tokenRecord); },

    /* 幂等：已吊销的再吊销不改时间，也不重复写 */
    revokeToken(tid) {
      const t = tokStr(tid);
      const cur = t ? (stmt.selToken.get(t) || null) : null;
      if (!cur) return null;
      if (cur.revoked_at == null) stmt.revokeToken.run(nowIso(), cur.tid);
      return tokenRecord(stmt.selToken.get(cur.tid) || null);
    },

    setTokenLastUsed(tid) {
      const t = tokStr(tid);
      const cur = t ? (stmt.selToken.get(t) || null) : null;
      if (!cur) return null;
      stmt.setTokenLastUsed.run(nowIso(), cur.tid);
      return tokenRecord(stmt.selToken.get(cur.tid) || null);
    },

    /* 同 JSON 后端：只删 tokens 表的行，keys / credentials / pools 一行不碰。
       id 不回收（AUTOINCREMENT 继续往上走），审计里的行号不会撞回旧记录。 */
    clearTokens() {
      const row = stmt.countTokens.get();
      const n = row ? Number(row.n) || 0 : 0;
      if (n) stmt.clearTokens.run();
      return n;
    }
  };
}

module.exports = { createStore: createStore, closeAllStores: closeAllStores };
