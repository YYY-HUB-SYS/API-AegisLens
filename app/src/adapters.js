const META_MODELS = require('./meta-models.json');

const PLATFORMS = {
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', color: '#22A5F7',
    defaultBase: 'https://api.deepseek.com', defaultModel: 'deepseek-chat',
    currency: 'CNY', supportsBalance: true, auth: 'bearer'
  },
  openai: {
    id: 'openai', name: 'OpenAI', color: '#4B3FE3',
    defaultBase: 'https://api.openai.com/v1', defaultModel: 'gpt-4o',
    currency: 'USD', supportsBalance: false, auth: 'bearer'
  },
  anthropic: {
    id: 'anthropic', name: 'Anthropic', color: '#D97757',
    defaultBase: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5',
    currency: 'USD', supportsBalance: false, auth: 'anthropic'
  },
  moonshot: {
    id: 'moonshot', name: 'Moonshot (Kimi)', color: '#F87454',
    defaultBase: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k',
    currency: 'CNY', supportsBalance: false, auth: 'bearer'
  },
  custom: {
    id: 'custom', name: '自定义平台', color: '#8A8FA8',
    defaultBase: '', defaultModel: '',
    currency: 'CNY', supportsBalance: false, auth: 'bearer'
  }
};

function fail(httpStatus, message, code) {
  const e = new Error(message);
  e.httpStatus = httpStatus;
  e.code = code;
  return e;
}

function platformError(status) {
  if (status === 401 || status === 403) return '密钥无效或无权限（HTTP ' + status + '）';
  if (status === 404) return '接口不存在（HTTP 404），请检查 Base URL 是否正确';
  if (status === 429) return '请求过于频繁（HTTP 429），请稍后再试';
  return '平台返回 HTTP ' + status;
}

async function requestJson(url, headers, opts) {
  const f = (opts && opts.fetchImpl) || fetch;
  const timeoutMs = (opts && opts.timeoutMs) || 10000;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    const res = await f(url, { headers: headers, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    return { status: res.status, ok: res.ok, body: body };
  } catch (e) {
    if (ctrl.signal.aborted) throw fail(504, '请求超时（' + timeoutMs + 'ms），请检查网络或 Base URL', 'TIMEOUT');
    throw fail(502, '网络请求失败：' + (e && e.message ? e.message : String(e)), 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

function trimBase(b) { return String(b || '').replace(/\/+$/, ''); }

function modelsUrl(platform, base) {
  const b = trimBase(base);
  return platform === 'anthropic' ? b + '/v1/models' : b + '/models';
}

function authHeaders(platform, key) {
  return platform === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'Authorization': 'Bearer ' + key };
}

function lookupMeta(platform, modelId) {
  const table = META_MODELS[platform];
  if (!table) return null;
  if (table[modelId]) return table[modelId];
  const keys = Object.keys(table);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.endsWith('*') && modelId.startsWith(k.slice(0, -1))) return table[k];
  }
  return null;
}

async function fetchModels(platform, key, base, opts) {
  if (!trimBase(base)) {
    throw fail(400, '该平台无法自动拉取：请先填写 Base URL，或手动添加模型', 'NO_BASE');
  }
  const res = await requestJson(modelsUrl(platform, base), authHeaders(platform, key), opts);
  if (!res.ok) throw fail(502, platformError(res.status), String(res.status));
  const list = (res.body && Array.isArray(res.body.data)) ? res.body.data : [];
  const models = [];
  for (let i = 0; i < list.length; i++) {
    const id = String((list[i] && list[i].id) || '').trim();
    if (!id) continue;
    const meta = lookupMeta(platform, id);
    models.push({
      id: id,
      ctx: meta ? meta.ctx : null,
      out: meta ? meta.out : null,
      src: meta ? 'meta' : 'api',
      note: null
    });
  }
  return models;
}

async function testKey(platform, key, base, opts) {
  if (!trimBase(base)) {
    return { status: 'fail', code: 'NO_BASE', msg: '无法测试：请先填写 Base URL' };
  }
  const t0 = Date.now();
  try {
    await fetchModels(platform, key, base, opts);
    return { status: 'pass', latency: Date.now() - t0, msg: 'GET /models 返回正常，密钥可用' };
  } catch (e) {
    return { status: 'fail', code: e.code || 'ERROR', msg: e.message };
  }
}

async function fetchBalance(platform, key, base, opts) {
  if (platform !== 'deepseek') return null;
  const res = await requestJson(trimBase(base) + '/user/balance', authHeaders(platform, key), opts);
  if (!res.ok) throw fail(502, platformError(res.status), String(res.status));
  const infos = (res.body && Array.isArray(res.body.balance_infos)) ? res.body.balance_infos : [];
  const cny = infos.find(function (x) { return x.currency === 'CNY'; }) || infos[0];
  if (!cny || cny.total_balance == null) {
    throw fail(502, '平台返回了余额数据，但未能解析出金额', 'PARSE');
  }
  return { value: parseFloat(cny.total_balance), status: 'ok' };
}

function mergeModels(prev, fetched) {
  const prevById = {};
  (prev || []).forEach(function (m) { prevById[m.id] = m; });
  const out = fetched.map(function (f) {
    const old = prevById[f.id];
    if (old && old.src === 'manual') {
      return {
        id: f.id,
        ctx: old.ctx != null ? old.ctx : f.ctx,
        out: old.out != null ? old.out : f.out,
        src: 'manual',
        note: old.note || null
      };
    }
    if (old) {
      const ctx = f.ctx != null ? f.ctx : old.ctx;
      const out = f.out != null ? f.out : old.out;
      const fromOld = (f.ctx == null || f.out == null) && (old.ctx != null || old.out != null);
      return { id: f.id, ctx: ctx, out: out, src: fromOld ? old.src : f.src, note: old.note || null };
    }
    return { id: f.id, ctx: f.ctx, out: f.out, src: f.src, note: null };
  });
  (prev || []).forEach(function (m) {
    if (m.src === 'manual' && !fetched.some(function (f) { return f.id === m.id; })) {
      out.push({ id: m.id, ctx: m.ctx, out: m.out, src: 'manual', note: m.note });
    }
  });
  return out;
}

module.exports = {
  PLATFORMS: PLATFORMS,
  fetchModels: fetchModels,
  testKey: testKey,
  fetchBalance: fetchBalance,
  mergeModels: mergeModels,
  lookupMeta: lookupMeta,
  modelsUrl: modelsUrl,
  authHeaders: authHeaders
};
