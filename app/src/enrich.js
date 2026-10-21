var cnData = require('./cn-models');
var shape = require('./model-shape.js');

/* 能力位：第四级联网检索从 models.dev 静态库带回来的那几项。
   命名跟 model-shape.js 的 extractCaps 对齐——reasoning / modalitiesIn 是既有的，
   新增的是 attachment（附件）、toolCall（工具调用）、modalitiesOut（输出模态）。
   每个能力位另记一个来源字段（<字段>Src），跟 ctxSrc/outSrc 同一套标签：
   api=平台自报、web=联网检索、meta=内置表。参考值必须说清是哪一级来的。 */
const CAP_FIELDS = ['reasoning', 'modalitiesIn', 'attachment', 'toolCall', 'modalitiesOut'];
const CAP_SRC = {
  reasoning: 'reasoningSrc',
  modalitiesIn: 'modalitiesInSrc',
  attachment: 'attachmentSrc',
  toolCall: 'toolCallSrc',
  modalitiesOut: 'modalitiesOutSrc'
};
/* models.dev 的模态枚举（实测 api.json：输入 text/image/pdf/video/audio，输出 text/image/video），
   比平台那套多一个 pdf。未登记的值不存，界面也就不会喊。 */
const MODS_KNOWN = ['text', 'image', 'audio', 'video', 'pdf', 'file'];

/* 布尔位：只认 true/false。false 是「不支持」，跟 null（没这个字段）是两回事——
   真值化会把「不支持」变成「不知道」，所以这里不做任何真值判断。 */
function boolOf(v) { return typeof v === 'boolean' ? v : null; }

/* 模态数组：只留已知枚举、去重；text 是默认（纯文本输入/输出不必每行都喊一遍），
   存进库前先剔掉，剔完为空就当没有（null），不存冗余值。 */
function modsOf(arr) {
  if (!Array.isArray(arr)) return null;
  const got = [];
  for (let i = 0; i < arr.length; i++) {
    const x = String(arr[i] || '').toLowerCase().trim();
    if (x === 'text') continue;
    if (MODS_KNOWN.indexOf(x) < 0) continue;
    if (got.indexOf(x) < 0) got.push(x);
  }
  return got.length ? got : null;
}

const PROVIDERS = [
  {
    id: 'openrouter',
    url: 'https://openrouter.ai/api/v1/models',
    parse: function (body) {
      const list = (body && Array.isArray(body.data)) ? body.data : [];
      const entries = [];
      for (let i = 0; i < list.length; i++) {
        const m = list[i] || {};
        const id = String(m.id || '').trim();
        if (!id) continue;
        const out = (m.top_provider && m.top_provider.max_completion_tokens != null)
          ? m.top_provider.max_completion_tokens
          : (m.max_completion_tokens != null ? m.max_completion_tokens : null);
        entries.push({ id: id, ctx: m.context_length == null ? null : m.context_length, out: out });
      }
      return entries;
    }
  },
  {
    id: 'modelsdev',
    url: 'https://models.dev/api.json',
    parse: function (body) {
      const entries = [];
      const providers = body && typeof body === 'object' ? Object.keys(body) : [];
      for (let i = 0; i < providers.length; i++) {
        const models = (body[providers[i]] || {}).models;
        if (!models || typeof models !== 'object') continue;
        const ids = Object.keys(models);
        for (let j = 0; j < ids.length; j++) {
          const m = models[ids[j]] || {};
          const limit = m.limit || {};
          const mods = m.modalities || {};
          entries.push({
            id: providers[i] + '/' + ids[j],
            ctx: limit.context == null ? null : limit.context,
            out: limit.output == null ? null : limit.output,
            /* 能力位：models.dev 是按模型名跨平台查的静态库，属第四级联网检索（参考值）。
               attachment=附件、tool_call=工具调用、modalities 分输入/输出两套。 */
            reasoning: boolOf(m.reasoning),
            attachment: boolOf(m.attachment),
            toolCall: boolOf(m.tool_call),
            modalitiesIn: modsOf(mods.input),
            modalitiesOut: modsOf(mods.output)
          });
        }
      }
      return entries;
    }
  }
];

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = {};

function resetCache() {
  Object.keys(cache).forEach(function (k) { delete cache[k]; });
  _localIndex = null;
}

function norm(s) { return String(s || '').toLowerCase().trim(); }
function stripVendor(s) { const i = s.indexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
function stripSuffix(s) {
  return s.replace(/[-:](free|exp|experimental|preview|beta|alpha|latest|stable|batch)$/g, '');
}

var UUID_PREFIX_RE = /^openai-compatible-(?:chat|completion|embedding)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

function stripUuidPrefix(s) {
  return s.replace(UUID_PREFIX_RE, '');
}

function allSuffixes(s) {
  var parts = s.split('/');
  var result = [];
  for (var i = 0; i < parts.length; i++) {
    var joined = parts.slice(i).join('/');
    if (joined) result.push(joined);
  }
  return result;
}

/* 一条目录记录有没有内容：数值参数或能力位，至少得有一项。
   早先只看 ctx/out，models.dev 里「有能力位但没 limit」的条目会被整条丢掉。 */
function hasAny(e) {
  if (e.ctx != null || e.out != null) return true;
  for (let i = 0; i < CAP_FIELDS.length; i++) if (e[CAP_FIELDS[i]] != null) return true;
  return false;
}

/* 合并两条目录记录：每项各自取先到的那份非空值，不是整条取先到的那条。
   早先整条替换会把老条目里已有的 ctx 冲掉（后来的条目自己没 ctx 时）。 */
function mergeEntry(cur, e) {
  const r = { ctx: null, out: null };
  if (cur) { r.ctx = cur.ctx; r.out = cur.out; }
  if (r.ctx == null) r.ctx = e.ctx;
  if (r.out == null) r.out = e.out;
  for (let i = 0; i < CAP_FIELDS.length; i++) {
    const f = CAP_FIELDS[i];
    const v = (cur && cur[f] != null) ? cur[f] : e[f];
    if (v != null) r[f] = v;
  }
  return r;
}

/* 老条目缺的项被后来的条目补上时才需要重建：已有的非空值优先，不被覆盖 */
function addsSomething(cur, e) {
  if (cur.ctx == null && e.ctx != null) return true;
  if (cur.out == null && e.out != null) return true;
  for (let i = 0; i < CAP_FIELDS.length; i++) {
    const f = CAP_FIELDS[i];
    if (cur[f] == null && e[f] != null) return true;
  }
  return false;
}

function buildIndex(entries) {
  const index = {};
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!hasAny(e)) continue;
    const stripped = norm(stripVendor(e.id));
    const variants = [norm(e.id), stripped, stripSuffix(stripped)];
    for (let j = 0; j < variants.length; j++) {
      const v = variants[j];
      if (!v) continue;
      if (!index[v] || addsSomething(index[v], e)) {
        index[v] = mergeEntry(index[v], e);
      }
    }
  }
  return index;
}

function matchModel(index, query) {
  const q = norm(query);
  if (!q) return null;
  if (index[q]) return index[q];

  const uuidStripped = norm(stripUuidPrefix(query));
  if (uuidStripped !== q && index[uuidStripped]) return index[uuidStripped];

  const variants = allSuffixes(q);
  for (var i = 0; i < variants.length; i++) {
    var v = norm(stripSuffix(variants[i]));
    if (v !== q && index[v]) return index[v];
  }

  let best = null;
  const keys = Object.keys(index);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.length < 6) continue;
    if ((q.includes(k) || k.includes(q)) && (!best || k.length > best.length)) best = k;
  }
  if (best) return index[best];

  for (var j = 0; j < variants.length; j++) {
    var seg = norm(variants[j]);
    if (seg.length < 6) continue;
    for (var m = 0; m < keys.length; m++) {
      var key = keys[m];
      if (key.length < 6) continue;
      if ((seg.includes(key) || key.includes(seg)) && (!best || key.length > best.length)) best = key;
    }
  }
  return best ? index[best] : null;
}

async function fetchProvider(p, opts) {
  const f = (opts && opts.fetchImpl) || fetch;
  const timeoutMs = (opts && opts.timeoutMs) || 8000;
  const cached = cache[p.id];
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.index;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  let index = null;
  let status = 0;
  try {
    const res = await f(p.url, { signal: ctrl.signal });
    status = res.status;
    if (res.ok) {
      const text = await res.text();
      index = buildIndex(p.parse(JSON.parse(text)));
    }
  } finally {
    clearTimeout(timer);
  }
  if (!index) throw new Error('HTTP ' + status);
  cache[p.id] = { at: Date.now(), index: index };
  return index;
}

var _localIndex = null;
function getLocalIndex() {
  if (!_localIndex) _localIndex = buildIndex(cnData.CN_MODELS);
  return _localIndex;
}

/* 四级兜底的第三、四级（内置元数据库 / 联网检索）都是**仅供参考**：
   它们按「模型 id」跨平台查表，而模型限制其实是 (平台端点, 模型) 的二元事实
   （实测：kimi-k2.6 在云知声 out=16000、intern-ai out=262144，差 16.4 倍）。
   所以这两级只能填空、不能覆盖平台自报值，且**必须标清各自是哪一级来的**——
   早先这里把内置表命中也打成 'web'，等于把本地数据谎报成联网检索来的。
   ctxSrc/outSrc 记来源，ctxFrom/outFrom 记具体出处（哪个目录），两者不能混。 */
async function lookupOnline(ids, opts) {
  const results = {};
  const errors = [];
  const catalogs = await Promise.all(PROVIDERS.map(function (p) {
    return fetchProvider(p, opts).catch(function (e) {
      errors.push(p.id + '：' + (e && e.message ? e.message : String(e)));
        return null;
      });
  }));
  /* 每个目录连同它的来源标签一起走：联网源是 'web'，内置表是 'meta' */
  const sources = catalogs.map(function (c, i) {
    return { index: c, src: PROVIDERS[i].id, kind: 'web' };
  });
  sources.push({ index: getLocalIndex(), src: 'builtin-cn', kind: 'meta' });
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i] || '').trim();
    if (!id) continue;
    for (let j = 0; j < sources.length; j++) {
      const s = sources[j];
      const hit = s.index ? matchModel(s.index, id) : null;
      if (!hit) continue;
      const cur = results[id] || { ctx: null, out: null, ctxFrom: null, outFrom: null };
      /* 先到先得：联网源在前（PROVIDERS 顺序），内置表在后；
         但同一级里 ctx 与 out 可以分别来自不同目录（如 ctx 来自 OpenRouter、out 来自 models.dev），
         所以按字段各自记出处，不按整条记。 */
      const next = Object.assign({}, cur);
      next.ctx = cur.ctx != null ? cur.ctx : hit.ctx;
      next.out = cur.out != null ? cur.out : hit.out;
      next.ctxFrom = cur.ctx != null ? cur.ctxFrom : (hit.ctx != null ? s.src : null);
      next.outFrom = cur.out != null ? cur.outFrom : (hit.out != null ? s.src : null);
      next.ctxKind = cur.ctx != null ? cur.ctxKind : (hit.ctx != null ? s.kind : null);
      next.outKind = cur.out != null ? cur.outKind : (hit.out != null ? s.kind : null);
      /* 能力位同「先到先得」：先命中的目录说了算，后面的目录不覆盖。
         布尔位的 false 也是「有值」（不支持），所以判空一律用 == null，不做真值判断。 */
      CAP_FIELDS.forEach(function (f) {
        if (cur[f] != null) return;
        if (hit[f] == null) return;
        next[f] = hit[f];
        next[CAP_SRC[f]] = s.kind;                    /* 联网目录是 web，内置表是 meta */
        if (s.kind === 'web') next.capsFrom = s.src;  /* 具体出处（哪个公开目录给的） */
      });
      results[id] = next;
    }
  }
  var onlineFailed = sources.slice(0, -1).every(function (s) { return !s.index; });
  var hasResults = Object.keys(results).length > 0;
  return {
    found: results,
    error: onlineFailed && !hasResults && sources.length > 1
      ? '联网检索失败（' + errors.join('；') + '）'
      : null
  };
}

function applyToModels(models, found) {
  const changed = [];
  const out = (models || []).map(function (m) {
    const hit = found && found[m.id];
    if (!hit) return m;
    const ctx = m.ctx != null ? m.ctx : hit.ctx;
    const outv = m.out != null ? m.out : hit.out;
    /* 能力位：平台自报优先，联网只填空（跟 ctx/out 同一规矩）。
       平台报过的项以平台为准，没报过的才拿目录的值来填。
       false 是「不支持」不是「没这个字段」，所以判空用 == null，不是真值。 */
    const filled = [];
    for (let i = 0; i < CAP_FIELDS.length; i++) {
      const f = CAP_FIELDS[i];
      if (m[f] != null) continue;
      if (hit[f] == null) continue;
      filled.push(f);
    }
    if (ctx === m.ctx && outv === m.out && !filled.length) return m;
    changed.push(m.id);
    /* 在原件上扩展而非重建：能力位与按字段来源都是挂在原记录上的，
       重建会把它们连同 conflict / outGtCtx 标记一起丢掉 */
    const r = Object.assign({}, m);
    const fs = shape.fieldSrcs(m);
    /* 来源按字段取真实出处：内置表命中是 'meta'，联网目录命中才是 'web'。
       早先一律写 'web'，断网时命中内置表也谎报成联网检索——那是两回事，
       界面上「元数据库」和「联网检索」是不同的可信度提示。 */
    r.ctx = ctx;
    r.out = outv;
    r.ctxSrc = (m.ctx != null) ? fs.ctxSrc : (hit.ctx != null ? (hit.ctxKind || 'web') : fs.ctxSrc);
    r.outSrc = (m.out != null) ? fs.outSrc : (hit.out != null ? (hit.outKind || 'web') : fs.outSrc);
    /* 出处也记下来（哪个目录给的），界面上可以展开说清「这个值来自哪」 */
    if (m.ctx == null && hit.ctx != null) r.ctxFrom = hit.ctxFrom || null;
    if (m.out == null && hit.out != null) r.outFrom = hit.outFrom || null;
    /* 能力位连同各自的来源一起落：联网目录命中的是 'web'（参考值）。
       平台自己报过的那几项不写来源——那是平台自报，不是参考值。 */
    for (let i = 0; i < filled.length; i++) {
      const f = filled[i];
      r[f] = hit[f];
      r[CAP_SRC[f]] = hit[CAP_SRC[f]] || 'web';
    }
    if (filled.length && hit.capsFrom) r.capsFrom = hit.capsFrom;
    r.src = (m.src === 'manual') ? 'manual' : shape.summarizeSrc(r.ctxSrc, r.outSrc);
    if (r.note == null) r.note = null;
    return r;
  });
  return { models: out, changed: changed };
}

module.exports = {
  lookupOnline: lookupOnline,
  applyToModels: applyToModels,
  matchModel: matchModel,
  buildIndex: buildIndex,
  resetCache: resetCache,
  PROVIDERS: PROVIDERS,
  stripUuidPrefix: stripUuidPrefix,
  allSuffixes: allSuffixes,
  /* 能力位字段清单（含各自的来源字段）：api 层落库时要按这张表逐字段带过去，
     两处各写一份清单必然会漂移 —— 这里导出唯一一份。 */
  CAP_FIELDS: CAP_FIELDS,
  CAP_SRC: CAP_SRC
};
