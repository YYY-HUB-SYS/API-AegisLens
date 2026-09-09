const adapters = require('./adapters');
const enrich = require('./enrich');

function bad(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(bad(400, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(bad(400, '请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

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

function platOf(id) { return adapters.PLATFORMS[id] || null; }

function autoName(platform, customName, keyValue) {
  const p = platOf(platform);
  const label = platform === 'custom' ? (customName || '自定义平台') : (p ? p.name : platform);
  const tail = keyValue.length >= 4 ? keyValue.slice(-4) : keyValue;
  return label + '-' + tail;
}

function str(v) { return String(v == null ? '' : v).trim(); }

function authNoteOf(v) {
  const s = str(v);
  if (s.length > 500) throw bad(400, '特殊认证说明最长 500 字符');
  return s;
}

function parseTokens(v, field) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 100000000) {
    throw bad(400, field + '必须是正整数（tokens 数量）');
  }
  return n;
}

async function enrichUnknowns(models, fetchImpl) {
  const unknowns = (models || []).filter(function (m) { return m.ctx == null; });
  if (!unknowns.length) return { enriched: 0, notFound: [], error: null };
  let found = {};
  let error = null;
  try {
    const r = await enrich.lookupOnline(unknowns.map(function (m) { return m.id; }), { fetchImpl: fetchImpl || adapters.effectiveFetch });
    found = r.found;
    error = r.error;
  } catch (e) {
    error = e.message;
  }
  const applied = enrich.applyToModels(models, found);
  const stillUnknown = applied.models.filter(function (m) {
    return m.ctx == null;
  }).map(function (m) { return m.id; });
  return { enriched: applied.changed.length, notFound: stillUnknown, error: error, models: applied.models };
}

async function routeApi(req, res, ctx) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  const storage = ctx.storage;
  const fetchImpl = ctx.fetchImpl;
  let m = null;

  const requireKey = function (id) {
    const k = storage.getKey(Number(id));
    if (!k) throw bad(404, '密钥不存在');
    return k;
  };

  if (req.method === 'GET' && path === '/api/platforms') {
    return json(res, 200, { platforms: Object.values(adapters.PLATFORMS) });
  }

  if (req.method === 'GET' && path === '/api/meta') {
    return json(res, 200, {
      version: ctx.version,
      storage: storage.backend,
      dataDir: storage.dataDir
    });
  }

  if (req.method === 'GET' && path === '/api/keys') {
    return json(res, 200, { keys: storage.listKeys() });
  }

  if (req.method === 'POST' && path === '/api/keys') {
    const b = await readBody(req);
    const platform = str(b.platform);
    const plat = platOf(platform);
    if (!plat) throw bad(400, '未知平台：' + platform);
    const keyValue = str(b.key);
    if (!keyValue) throw bad(400, 'API Key 为必填项');
    const customName = platform === 'custom' ? (str(b.customName) || '自定义平台') : '';
    const name = str(b.name) || autoName(platform, customName, keyValue);
    const dup = storage.listKeys().some(function (x) {
      return x.platform === platform
        && (platform === 'custom' ? x.customName === customName : true)
        && x.name === name;
    });
    if (dup) throw bad(409, '该平台下已存在同名密钥');
    let endpoints;
    try {
      const raw = b.endpoints !== undefined
        ? b.endpoints
        : (b.base !== undefined ? [{ url: b.base, style: adapters.inferStyle(platform) }] : undefined);
      endpoints = adapters.normalizeEndpoints(platform, raw);
    } catch (e) {
      throw bad(400, e.message);
    }
    const rec = storage.createKey({
      name: name,
      platform: platform,
      customName: customName,
      key: keyValue,
      endpoints: endpoints,
      model: str(b.model) || plat.defaultModel,
      reg: str(b.reg),
      exp: str(b.exp),
      authNote: authNoteOf(b.authNote),
      balanceStatus: endpoints.some(function (e) { return adapters.supportsBalanceUrl(e.url); })
        ? 'pending'
        : 'unsupported'
    });
    return json(res, 201, { key: rec });
  }

  if (req.method === 'PUT' && (m = /^\/api\/keys\/(\d+)$/.exec(path))) {
    const id = Number(m[1]);
    const cur = requireKey(id);
    const b = await readBody(req);
    const patch = {};
    ['name', 'customName', 'model', 'reg', 'exp'].forEach(function (f) {
      if (b[f] !== undefined) patch[f] = str(b[f]);
    });
    if (b.authNote !== undefined) patch.authNote = authNoteOf(b.authNote);
    if (b.platform !== undefined) {
      if (!platOf(str(b.platform))) throw bad(400, '未知平台：' + b.platform);
      patch.platform = str(b.platform);
    }
    if (b.key !== undefined) {
      const kv = str(b.key);
      if (!kv) throw bad(400, 'API Key 为必填项');
      patch.key = kv;
    }
    const platform = patch.platform || cur.platform;
    const customName = platform === 'custom'
      ? (patch.customName !== undefined && patch.customName !== '' ? patch.customName : (cur.customName || '自定义平台'))
      : '';
    if (platform === 'custom') patch.customName = customName;
    if (patch.name === '') {
      patch.name = autoName(platform, customName, patch.key || cur.key);
    }
    if (b.endpoints !== undefined || b.base !== undefined) {
      try {
        const raw = b.endpoints !== undefined
          ? b.endpoints
          : [{ url: b.base, style: adapters.inferStyle(platform) }];
        patch.endpoints = adapters.normalizeEndpoints(platform, raw);
      } catch (e) {
        throw bad(400, e.message);
      }
    }
    const name = patch.name || cur.name;
    const dup = storage.listKeys().some(function (x) {
      return x.id !== id
        && x.platform === platform
        && (platform === 'custom' ? x.customName === customName : true)
        && x.name === name;
    });
    if (dup) throw bad(409, '该平台下已存在同名密钥');
    const rec = storage.updateKey(id, patch);
    /* 端点变更可能改变余额可查性：支持↔不支持切换时重置余额，避免旧值误导 */
    if (patch.endpoints !== undefined) {
      const supported = (rec.endpoints || []).some(function (e) { return adapters.supportsBalanceUrl(e.url); });
      const wasSupported = rec.balance.status !== 'unsupported';
      if (supported !== wasSupported) {
        return json(res, 200, {
          key: storage.saveBalance(id, { value: null, status: supported ? 'pending' : 'unsupported' })
        });
      }
    }
    return json(res, 200, { key: rec });
  }

  if (req.method === 'DELETE' && (m = /^\/api\/keys\/(\d+)$/.exec(path))) {
    requireKey(m[1]);
    storage.deleteKey(Number(m[1]));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/test$/.exec(path))) {
    const k = requireKey(m[1]);
    const test = await adapters.testKey(k.platform, adapters.primaryEndpoint(k), k.key, { fetchImpl: fetchImpl });
    const rec = storage.saveTest(k.id, test);
    return json(res, 200, { test: rec.test });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/models\/fetch$/.exec(path))) {
    const k = requireKey(m[1]);
    const fetched = await adapters.fetchModels(k.platform, adapters.primaryEndpoint(k), k.key, { fetchImpl: fetchImpl });
    let merged = adapters.mergeModels(k.models, fetched);
    let enrichInfo = null;
    if (merged.some(function (mm) { return mm.ctx == null; })) {
      enrichInfo = await enrichUnknowns(merged, fetchImpl);
      if (enrichInfo.models) merged = enrichInfo.models;
    }
    const rec = storage.replaceModels(k.id, merged);
    return json(res, 200, {
      models: rec.models,
      enrich: enrichInfo
        ? { enriched: enrichInfo.enriched, notFound: enrichInfo.notFound, error: enrichInfo.error }
        : { enriched: 0, notFound: [], error: null }
    });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/models\/enrich$/.exec(path))) {
    const k = requireKey(m[1]);
    const b = await readBody(req).catch(function () { return {}; });
    const onlyId = str(b.modelId);
    let targets = (k.models || []).filter(function (mm) { return mm.ctx == null; });
    if (onlyId) targets = targets.filter(function (mm) { return mm.id === onlyId; });
    if (!targets.length) {
      return json(res, 200, {
        models: k.models,
        summary: { checked: 0, enriched: 0, notFound: [], error: null }
      });
    }
    let found = {};
    let error = null;
    try {
      const r = await enrich.lookupOnline(targets.map(function (mm) { return mm.id; }), { fetchImpl: fetchImpl || adapters.effectiveFetch });
      found = r.found;
      error = r.error;
    } catch (e) {
      error = e.message;
    }
    const applied = enrich.applyToModels(k.models, found);
    const changedModels = [];
    applied.models.forEach(function (mm, idx) {
      if (applied.changed.indexOf(mm.id) >= 0) {
        var prev = k.models[idx];
        changedModels.push({
          id: mm.id,
          ctx: mm.ctx != null ? mm.ctx : prev.ctx,
          out: mm.out != null ? mm.out : prev.out,
          src: mm.src
        });
      }
    });
    if (changedModels.length > 0) {
      storage.upsertModels(k.id, changedModels);
    }
    const rec = storage.getKey(k.id);
    const stillUnknown = (rec.models || []).filter(function (mm) {
      return mm.ctx == null;
    }).map(function (mm) { return mm.id; });
    return json(res, 200, {
      models: rec.models,
      summary: {
        checked: targets.length,
        enriched: applied.changed.length,
        notFound: stillUnknown,
        error: error
      }
    });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/models$/.exec(path))) {
    const k = requireKey(m[1]);
    const b = await readBody(req);
    const mid = str(b.id);
    if (!mid) throw bad(400, '请填写模型 ID');
    const ctx = parseTokens(b.ctx, '上下文');
    const out = parseTokens(b.out, '最大输出');
    const mo = { id: mid, src: 'manual' };
    if (ctx !== undefined) mo.ctx = ctx;
    if (out !== undefined) mo.out = out;
    if (b.note !== undefined) mo.note = str(b.note) || null;
    const rec = storage.upsertModel(k.id, mo);
    return json(res, 200, { models: rec.models });
  }

  if (req.method === 'PATCH' && (m = /^\/api\/keys\/(\d+)\/models\/([^/]+)$/.exec(path))) {
    const k = requireKey(m[1]);
    const b = await readBody(req);
    const mid = decodeURIComponent(m[2]);
    const ctx = parseTokens(b.ctx, '上下文');
    const out = parseTokens(b.out, '最大输出');
    const upd = { id: mid };
    if (ctx !== undefined) upd.ctx = ctx;
    if (out !== undefined) upd.out = out;
    if (ctx !== undefined || out !== undefined) upd.src = 'manual';
    if (b.note !== undefined) upd.note = str(b.note) || null;
    const rec = storage.upsertModel(k.id, upd);
    if (!rec) throw bad(404, '模型不存在');
    return json(res, 200, { models: rec.models });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/assigned$/.exec(path))) {
    const k = requireKey(m[1]);
    const b = await readBody(req);
    const tool = str(b.tool);
    if (!tool) throw bad(400, '请填写工具名');
    const rec = storage.addAssigned(k.id, tool);
    if (!rec) throw bad(409, '该工具已在配置清单中');
    return json(res, 201, { assigned: rec.assigned });
  }

  if (req.method === 'DELETE' && (m = /^\/api\/keys\/(\d+)\/assigned\/([^/]+)$/.exec(path))) {
    const k = requireKey(m[1]);
    const tool = decodeURIComponent(m[2]);
    const rec = storage.removeAssigned(k.id, tool);
    return json(res, 200, { assigned: rec.assigned });
  }

  if (req.method === 'POST' && path === '/api/refresh-balances') {
    const keys = storage.listKeys();
    let updated = 0;
    let failed = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const eps = (k.endpoints && k.endpoints.length) ? k.endpoints : [adapters.primaryEndpoint(k)];
      if (!eps.some(function (e) { return adapters.supportsBalanceUrl(e.url); })) {
        /* 自愈：无匹配端点但状态遗留为 fail/ok/pending（如平台余额接口下线）时归位 */
        if (k.balance.status !== 'unsupported') {
          storage.saveBalance(k.id, { value: null, status: 'unsupported' });
        }
        continue;
      }
      try {
        const bal = await adapters.fetchBalanceForKey(k.platform, eps, k.key, { fetchImpl: fetchImpl });
        if (bal) {
          storage.saveBalance(k.id, bal);
          updated++;
        }
      } catch (e) {
        storage.saveBalance(k.id, { value: null, status: 'fail' });
        failed++;
      }
    }
    return json(res, 200, { keys: storage.listKeys(), updated: updated, failed: failed });
  }

  if (req.method === 'POST' && path === '/api/import') {
    const b = await readBody(req);
    const keys = Array.isArray(b.keys) ? b.keys : [];
    if (!keys.length) throw bad(400, '请提供要导入的密钥列表');
    const imported = [];
    const skipped = [];
    for (const item of keys) {
      try {
        const platform = str(item.platform);
        const plat = platOf(platform);
        if (!plat) { skipped.push({ name: item.name || '', reason: '未知平台：' + platform }); continue; }
        const keyValue = str(item.key);
        if (!keyValue) { skipped.push({ name: item.name || '', reason: '缺少 API Key' }); continue; }
        const customName = platform === 'custom' ? (str(item.customName) || '自定义平台') : '';
        const name = str(item.name) || autoName(platform, customName, keyValue);
        const dup = storage.listKeys().some(function (x) {
          return x.platform === platform
            && (platform === 'custom' ? x.customName === customName : true)
            && x.name === name;
        });
        if (dup) { skipped.push({ name: name, reason: '该平台下已存在同名密钥' }); continue; }
        let endpoints;
        try {
          const raw = item.endpoints !== undefined
            ? item.endpoints
            : (item.base !== undefined ? [{ url: item.base, style: adapters.inferStyle(platform) }] : undefined);
          endpoints = adapters.normalizeEndpoints(platform, raw);
        } catch (e) {
          skipped.push({ name: name, reason: '端点格式错误：' + e.message });
          continue;
        }
        const rec = storage.createKey({
          name: name,
          platform: platform,
          customName: customName,
          key: keyValue,
          endpoints: endpoints,
          model: str(item.model) || plat.defaultModel,
          reg: str(item.reg),
          exp: str(item.exp),
          authNote: authNoteOf(item.authNote),
          balanceStatus: endpoints.some(function (e) { return adapters.supportsBalanceUrl(e.url); })
            ? 'pending'
            : 'unsupported'
        });
        if (Array.isArray(item.models) && item.models.length) {
          storage.replaceModels(rec.id, item.models);
        }
        if (Array.isArray(item.assigned) && item.assigned.length) {
          item.assigned.forEach(function (t) {
            try { storage.addAssigned(rec.id, String(t).trim()); } catch (e) { /* 跳过重复 */ }
          });
        }
        imported.push(storage.getKey(rec.id));
      } catch (e) {
        skipped.push({ name: item.name || '', reason: e.message });
      }
    }
    return json(res, 200, {
      imported: imported.length,
      skipped: skipped.length,
      skippedDetails: skipped,
      total: keys.length,
      keys: imported
    });
  }

  return json(res, 404, { error: '接口不存在' });
}

async function apiRouter(req, res, ctx) {
  try {
    if (req.method !== 'GET' && !sameOrigin(req)) {
      return json(res, 403, { error: '拒绝跨域写请求' });
    }
    await routeApi(req, res, ctx);
  } catch (e) {
    try {
      json(res, e.httpStatus || 500, { error: e.message || '服务器内部错误' });
    } catch (e2) { /* 响应已发出 */ }
  }
}

module.exports = { apiRouter: apiRouter };
