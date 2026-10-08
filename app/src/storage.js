const fs = require('node:fs');
const path = require('node:path');
const { encryptField, decryptField } = require('./crypto');
const { inferStyle } = require('./adapters');

/* 按字段来源与能力位：JSON 后端直接挂在模型对象上，SQLite 后端存进 models.extra 一列。
   两边合并补丁时都按这张表逐字段处理，漏一处就会静默丢字段。 */
const MODEL_EXTRA = ['ctxSrc', 'outSrc', 'conflict', 'outGtCtx', 'reasoning', 'modalitiesIn', 'rpm'];

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
  return store;
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
const CRED_PLAIN = ['title', 'username', 'url', 'folder', 'tags'];
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

/* ================= JSON 文件后端 ================= */

function makeJsonStore(dataDir, masterKey) {
  const file = path.join(dataDir, 'store.json');
  let data;
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    data = { nextId: 1, keys: [] };
  }
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
  function persist() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  function find(id) { return data.keys.find(function (x) { return x.id === id; }) || null; }
  function findCred(id) {
    const n = credId(id);
    return data.credentials.find(function (x) { return x.id === n; }) || null;
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
      test: doc.test || null,
      modelsFetched: !!doc.modelsFetched,
      models: (doc.models || []).map(deriveFlags),
      assigned: doc.assigned || [],
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
      keyIds: Array.isArray(doc.keyIds) ? doc.keyIds.slice() : [],
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt
    };
  }

  return {
    backend: 'json',
    dataDir: dataDir,

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
        test: null,
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

    saveTest(id, test) {
      const d = find(id);
      if (!d) return null;
      const at = nowIso();
      d.test = Object.assign({ at: at }, test);
      pushHistory(id, testHistoryOf(test), at);
      persist();
      return toRec(d);
    },

    appendHistory(id, entry) {
      if (!find(id)) return null;
      const at = nowIso();
      const row = pushHistory(id, entry, at);
      persist();
      return Object.assign({}, row);
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

    addAssigned(id, tool) {
      const d = find(id);
      if (!d) return null;
      d.assigned = d.assigned || [];
      if (d.assigned.indexOf(tool) >= 0) return null;
      d.assigned.push(tool);
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    removeAssigned(id, tool) {
      const d = find(id);
      if (!d) return null;
      d.assigned = d.assigned.filter(function (t) { return t !== tool; });
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
        const idx = p.keyIds.indexOf(id);
        if (idx >= 0) p.keyIds.splice(idx, 1);
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
        keyIds: Array.isArray(input.keyIds) ? input.keyIds.filter(Number.isInteger) : [],
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
        d.keyIds = Array.isArray(patch.keyIds) ? patch.keyIds.filter(Number.isInteger) : [];
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
      if (d.keyIds.indexOf(keyId) >= 0) return null;
      d.keyIds.push(keyId);
      d.updatedAt = nowIso();
      persist();
      return toPool(d);
    },

    removePoolKey(poolId, keyId) {
      const d = data.pools.find(function (p) { return p.id === poolId; });
      if (!d) return null;
      const idx = d.keyIds.indexOf(keyId);
      if (idx < 0) return null;
      d.keyIds.splice(idx, 1);
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

    touchCredential(id) {
      const d = findCred(id);
      if (!d) return null;
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
    '  test_json TEXT,',
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
    '  PRIMARY KEY (key_id, tool)',
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
    '  PRIMARY KEY (pool_id, key_id)',
    ');'
  ].join('\n'));
  try {
    db.exec('ALTER TABLE keys ADD COLUMN endpoints_json TEXT');
  } catch (e) { /* 旧库已有该列或新库已含，忽略 */ }
  try {
    db.exec('ALTER TABLE keys ADD COLUMN auth_note TEXT');
  } catch (e) { /* 旧库已有该列或新库已含，忽略 */ }
  try {
    db.exec('ALTER TABLE models ADD COLUMN extra TEXT');
  } catch (e) { /* 旧库已有该列或新库已含，忽略 */ }

  const stmt = {
    selectAll: db.prepare('SELECT * FROM keys ORDER BY id'),
    selectOne: db.prepare('SELECT * FROM keys WHERE id = ?'),
    insert: db.prepare('INSERT INTO keys (name, platform, custom_name, key_enc, base, endpoints_json, model, reg, exp, auth_note, balance_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE keys SET name = ?, platform = ?, custom_name = ?, key_enc = ?, base = ?, endpoints_json = ?, model = ?, reg = ?, exp = ?, auth_note = ?, updated_at = ? WHERE id = ?'),
    setBalance: db.prepare('UPDATE keys SET balance_value = ?, balance_status = ?, balance_updated_at = ? WHERE id = ?'),
    setTest: db.prepare('UPDATE keys SET test_json = ? WHERE id = ?'),
    setModelsFetched: db.prepare('UPDATE keys SET models_fetched = 1 WHERE id = ?'),
    touch: db.prepare('UPDATE keys SET updated_at = ? WHERE id = ?'),
    delKey: db.prepare('DELETE FROM keys WHERE id = ?'),
    selModels: db.prepare('SELECT id, ctx, out, src, note, extra FROM models WHERE key_id = ? ORDER BY rowid'),
    delModels: db.prepare('DELETE FROM models WHERE key_id = ?'),
    insModel: db.prepare('INSERT INTO models (key_id, id, ctx, out, src, note, extra) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    selModel: db.prepare('SELECT id, ctx, out, src, note, extra FROM models WHERE key_id = ? AND id = ?'),
    updModel: db.prepare('UPDATE models SET ctx = ?, out = ?, src = ?, note = ?, extra = ? WHERE key_id = ? AND id = ?'),
    selAssigned: db.prepare('SELECT tool FROM assigned WHERE key_id = ? ORDER BY rowid'),
    insAssigned: db.prepare('INSERT OR IGNORE INTO assigned (key_id, tool) VALUES (?, ?)'),
    delAssigned: db.prepare('DELETE FROM assigned WHERE key_id = ? AND tool = ?'),
    delAssignedAll: db.prepare('DELETE FROM assigned WHERE key_id = ?'),
    insHistory: db.prepare('INSERT INTO history (key_id, at, kind, status, latency, value, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    selHistory: db.prepare('SELECT * FROM history WHERE key_id = ? ORDER BY id DESC LIMIT ?'),
    selHistoryKind: db.prepare('SELECT * FROM history WHERE key_id = ? AND kind = ? ORDER BY id DESC LIMIT ?'),
    trimHistory: db.prepare('DELETE FROM history WHERE key_id = ? AND id NOT IN (SELECT id FROM history WHERE key_id = ? ORDER BY id DESC LIMIT ?)'),
    delHistory: db.prepare('DELETE FROM history WHERE key_id = ?'),
    insCredential: db.prepare('INSERT INTO credentials (title, username, url, folder, tags, password_enc, secret_enc, totp_enc, note_enc, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    selCredential: db.prepare('SELECT * FROM credentials WHERE id = ?'),
    selAllCredentials: db.prepare('SELECT * FROM credentials ORDER BY id'),
    updCredential: db.prepare('UPDATE credentials SET title = ?, username = ?, url = ?, folder = ?, tags = ?, password_enc = ?, secret_enc = ?, totp_enc = ?, note_enc = ?, updated_at = ? WHERE id = ?'),
    touchCredential: db.prepare('UPDATE credentials SET updated_at = ? WHERE id = ?'),
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
    selPoolKeys: db.prepare('SELECT key_id FROM pool_keys WHERE pool_id = ? ORDER BY rowid'),
    insPoolKey: db.prepare('INSERT OR IGNORE INTO pool_keys (pool_id, key_id) VALUES (?, ?)'),
    delPoolKey: db.prepare('DELETE FROM pool_keys WHERE pool_id = ? AND key_id = ?'),
    touchPool: db.prepare('UPDATE pools SET updated_at = ? WHERE id = ?')
  };

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
    return stmt.selAssigned.all(id).map(function (r) { return r.tool; });
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
      test: test,
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
    CRED_PLAIN.forEach(function (f) { c[f] = row[f]; });
    CRED_ENC.forEach(function (f) { c[f] = row[CRED_ENC_COLUMN[f]]; });
    return c;
  }
  function credentialRecord(row) { return row ? credRecord(credentialFromRow(row)) : null; }
  /* id 先经 credId 收成数字：非数字一律当查不到，免得把 NaN 绑进 SQL */
  function getCredRow(id) {
    const n = credId(id);
    return Number.isFinite(n) ? (stmt.selCredential.get(n) || null) : null;
  }

  return {
    backend: 'sqlite',
    dataDir: dataDir,

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

    saveTest(id, test) {
      const cur = getRow(id);
      if (!cur) return null;
      const at = nowIso();
      stmt.setTest.run(JSON.stringify(Object.assign({ at: at }, test)), id);
      pushHistory(id, testHistoryOf(test), at);
      return toRec(getRow(id));
    },

    appendHistory(id, entry) {
      const cur = getRow(id);
      if (!cur) return null;
      return pushHistory(id, entry, nowIso());
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

    addAssigned(id, tool) {
      const cur = getRow(id);
      if (!cur) return null;
      const r = stmt.insAssigned.run(id, tool);
      if (r.changes === 0) return null;
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    removeAssigned(id, tool) {
      const cur = getRow(id);
      if (!cur) return null;
      stmt.delAssigned.run(id, tool);
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    deleteKey(id) {
      const cur = getRow(id);
      if (!cur) return false;
      stmt.delModels.run(id);
      stmt.delAssignedAll.run(id);
      stmt.delHistory.run(id);
      stmt.delPoolKeyByKey.run(id);
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
      (Array.isArray(input.keyIds) ? input.keyIds : []).forEach(function (kid) {
        stmt.insPoolKey.run(poolId, kid);
      });
      return toPool(stmt.selPool.get(poolId));
    },

    updatePool(id, patch) {
      const cur = stmt.selPool.get(id);
      if (!cur) return null;
      stmt.updPool.run(patch.name !== undefined ? patch.name : cur.name, nowIso(), id);
      if (patch.keyIds !== undefined) {
        stmt.delPoolKeys.run(id);
        (Array.isArray(patch.keyIds) ? patch.keyIds : []).forEach(function (kid) {
          stmt.insPoolKey.run(id, kid);
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
      const r = stmt.insPoolKey.run(poolId, keyId);
      if (r.changes === 0) return null;
      stmt.touchPool.run(nowIso(), poolId);
      return toPool(stmt.selPool.get(poolId));
    },

    removePoolKey(poolId, keyId) {
      const cur = stmt.selPool.get(poolId);
      if (!cur) return null;
      const r = stmt.delPoolKey.run(poolId, keyId);
      if (r.changes === 0) return null;
      stmt.touchPool.run(nowIso(), poolId);
      return toPool(stmt.selPool.get(poolId));
    },

    /* ---------- 凭证保险库（与 JSON 后端同名方法、同结果；密文原样进原样出） ---------- */

    createCredential(input) {
      const now = nowIso();
      const doc = credNew(input);
      const r = stmt.insCredential.run(
        doc.title, doc.username, doc.url, doc.folder, doc.tags,
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
        credText(merged.title), credText(merged.username), credText(merged.url),
        credText(merged.folder), credText(merged.tags),
        credCipher(merged.passwordEnc), credCipher(merged.secretEnc),
        credCipher(merged.totpEnc), credCipher(merged.noteEnc),
        nowIso(), cur.id
      );
      return credentialRecord(getCredRow(cur.id));
    },

    touchCredential(id) {
      const cur = getCredRow(id);
      if (!cur) return null;
      stmt.touchCredential.run(nowIso(), cur.id);
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
    }
  };
}

module.exports = { createStore };
