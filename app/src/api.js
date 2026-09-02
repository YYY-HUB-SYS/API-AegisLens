const adapters = require('./adapters');

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
    const rec = storage.createKey({
      name: name,
      platform: platform,
      customName: customName,
      key: keyValue,
      base: str(b.base) || plat.defaultBase,
      model: str(b.model) || plat.defaultModel,
      reg: str(b.reg),
      exp: str(b.exp),
      balanceStatus: plat.supportsBalance ? 'pending' : 'unsupported'
    });
    return json(res, 201, { key: rec });
  }

  if (req.method === 'PUT' && (m = /^\/api\/keys\/(\d+)$/.exec(path))) {
    const id = Number(m[1]);
    const cur = requireKey(id);
    const b = await readBody(req);
    const patch = {};
    ['name', 'customName', 'base', 'model', 'reg', 'exp'].forEach(function (f) {
      if (b[f] !== undefined) patch[f] = str(b[f]);
    });
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
    const name = patch.name || cur.name;
    const dup = storage.listKeys().some(function (x) {
      return x.id !== id
        && x.platform === platform
        && (platform === 'custom' ? x.customName === customName : true)
        && x.name === name;
    });
    if (dup) throw bad(409, '该平台下已存在同名密钥');
    const rec = storage.updateKey(id, patch);
    return json(res, 200, { key: rec });
  }

  if (req.method === 'DELETE' && (m = /^\/api\/keys\/(\d+)$/.exec(path))) {
    requireKey(m[1]);
    storage.deleteKey(Number(m[1]));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/test$/.exec(path))) {
    const k = requireKey(m[1]);
    const test = await adapters.testKey(k.platform, k.key, k.base, { fetchImpl: fetchImpl });
    const rec = storage.saveTest(k.id, test);
    return json(res, 200, { test: rec.test });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/models\/fetch$/.exec(path))) {
    const k = requireKey(m[1]);
    const fetched = await adapters.fetchModels(k.platform, k.key, k.base, { fetchImpl: fetchImpl });
    const merged = adapters.mergeModels(k.models, fetched);
    const rec = storage.replaceModels(k.id, merged);
    return json(res, 200, { models: rec.models });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/models$/.exec(path))) {
    const k = requireKey(m[1]);
    const b = await readBody(req);
    const mid = str(b.id);
    if (!mid) throw bad(400, '请填写模型 ID');
    const mo = { id: mid, src: 'manual' };
    if (b.ctx !== undefined && b.ctx !== null && b.ctx !== '') mo.ctx = parseInt(b.ctx, 10) || null;
    if (b.out !== undefined && b.out !== null && b.out !== '') mo.out = parseInt(b.out, 10) || null;
    if (b.note !== undefined) mo.note = str(b.note) || null;
    const rec = storage.upsertModel(k.id, mo);
    return json(res, 200, { models: rec.models });
  }

  if (req.method === 'PATCH' && (m = /^\/api\/keys\/(\d+)\/models\/([^/]+)$/.exec(path))) {
    const k = requireKey(m[1]);
    const b = await readBody(req);
    const mid = decodeURIComponent(m[2]);
    const upd = { id: mid };
    if (b.note !== undefined) upd.note = str(b.note) || null;
    if (b.ctx !== undefined && b.ctx !== null && b.ctx !== '') upd.ctx = parseInt(b.ctx, 10) || null;
    if (b.out !== undefined && b.out !== null && b.out !== '') upd.out = parseInt(b.out, 10) || null;
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
      const plat = platOf(k.platform);
      if (!plat || !plat.supportsBalance) continue;
      try {
        const bal = await adapters.fetchBalance(k.platform, k.key, k.base, { fetchImpl: fetchImpl });
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
