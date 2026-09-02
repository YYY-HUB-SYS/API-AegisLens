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
          const limit = (models[ids[j]] || {}).limit || {};
          entries.push({
            id: providers[i] + '/' + ids[j],
            ctx: limit.context == null ? null : limit.context,
            out: limit.output == null ? null : limit.output
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
}

function norm(s) { return String(s || '').toLowerCase().trim(); }
function stripVendor(s) { const i = s.indexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
function stripSuffix(s) {
  return s.replace(/[-:](free|exp|experimental|preview|beta|alpha|latest|stable|batch)$/g, '');
}

function buildIndex(entries) {
  const index = {};
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.ctx == null && e.out == null) continue;
    const stripped = norm(stripVendor(e.id));
    const variants = [norm(e.id), stripped, stripSuffix(stripped)];
    for (let j = 0; j < variants.length; j++) {
      const v = variants[j];
      if (!v) continue;
      if (!index[v] || (index[v].ctx == null && e.ctx != null) || (index[v].out == null && e.out != null)) {
        index[v] = { ctx: e.ctx, out: e.out };
      }
    }
  }
  return index;
}

function matchModel(index, query) {
  const q = norm(query);
  if (!q) return null;
  if (index[q]) return index[q];
  const stripped = stripSuffix(stripVendor(q));
  if (stripped !== q && index[stripped]) return index[stripped];
  let best = null;
  const keys = Object.keys(index);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.length < 6) continue;
    if ((q.includes(k) || k.includes(q)) && (!best || k.length > best.length)) best = k;
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

async function lookupOnline(ids, opts) {
  const results = {};
  const errors = [];
  const catalogs = await Promise.all(PROVIDERS.map(function (p) {
    return fetchProvider(p, opts).catch(function (e) {
      errors.push(p.id + '：' + (e && e.message ? e.message : String(e)));
      return null;
    });
  }));
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i] || '').trim();
    if (!id) continue;
    for (let j = 0; j < catalogs.length; j++) {
      const hit = catalogs[j] ? matchModel(catalogs[j], id) : null;
      if (!hit) continue;
      const cur = results[id] || { ctx: null, out: null };
      results[id] = {
        ctx: cur.ctx != null ? cur.ctx : hit.ctx,
        out: cur.out != null ? cur.out : hit.out
      };
    }
  }
  return {
    found: results,
    error: catalogs.every(function (c) { return !c; })
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
    if (ctx === m.ctx && outv === m.out) return m;
    changed.push(m.id);
    return { id: m.id, ctx: ctx, out: outv, src: m.src === 'manual' ? 'manual' : 'web', note: m.note == null ? null : m.note };
  });
  return { models: out, changed: changed };
}

module.exports = {
  lookupOnline: lookupOnline,
  applyToModels: applyToModels,
  matchModel: matchModel,
  buildIndex: buildIndex,
  resetCache: resetCache,
  PROVIDERS: PROVIDERS
};
