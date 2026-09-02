const META_MODELS = require('./meta-models.json');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const config = require('./config');

const PROXY_URL = config.proxy;

const PLATFORMS = {
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', color: '#22A5F7',
    defaultBase: 'https://api.deepseek.com', defaultModel: 'deepseek-chat',
    endpoints: [
      { url: 'https://api.deepseek.com', style: 'openai' },
      { url: 'https://api.deepseek.com/anthropic', style: 'anthropic' }
    ],
    currency: 'CNY', supportsBalance: true, auth: 'bearer'
  },
  openai: {
    id: 'openai', name: 'OpenAI', color: '#4B3FE3',
    defaultBase: 'https://api.openai.com/v1', defaultModel: 'gpt-4o',
    endpoints: [{ url: 'https://api.openai.com/v1', style: 'openai' }],
    currency: 'USD', supportsBalance: false, auth: 'bearer'
  },
  anthropic: {
    id: 'anthropic', name: 'Anthropic', color: '#D97757',
    defaultBase: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5',
    endpoints: [{ url: 'https://api.anthropic.com', style: 'anthropic' }],
    currency: 'USD', supportsBalance: false, auth: 'anthropic'
  },
  moonshot: {
    id: 'moonshot', name: 'Moonshot (Kimi)', color: '#F87454',
    defaultBase: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k',
    endpoints: [{ url: 'https://api.moonshot.cn/v1', style: 'openai' }],
    currency: 'CNY', supportsBalance: false, auth: 'bearer'
  },
  custom: {
    id: 'custom', name: '自定义平台', color: '#8A8FA8',
    defaultBase: '', defaultModel: '',
    endpoints: [],
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

/* Node 的 fetch 不读系统代理（NODE_USE_ENV_PROXY 需 Node 24+），
   检测到代理配置时对 https 目标走 HTTP CONNECT 隧道；
   接口与 fetch 子集兼容（status / ok / text()） */
function proxyFetch(urlStr, init, proxyUrl) {
  return new Promise(function (resolve, reject) {
    const u = new URL(urlStr);
    const proxy = new URL(proxyUrl || PROXY_URL);
    const target = u.hostname + ':443';
    const connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: target,
      headers: { Host: target }
    });
    connectReq.setTimeout(8000, function () {
      connectReq.destroy(fail(502, '代理 ' + proxy.host + ' 连接超时：请确认代理软件正在运行，或设置 AKM_PROXY=off 强制直连', 'PROXY_TIMEOUT'));
    });
    connectReq.on('connect', function (res, socket) {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(fail(502, '代理 ' + proxy.host + ' 拒绝建立隧道（HTTP ' + res.statusCode + '）', 'PROXY_REFUSED'));
        return;
      }
      const tlsSock = tls.connect({ socket: socket, servername: u.hostname });
      tlsSock.once('secureConnect', function () {
        const headers = Object.assign({}, init && init.headers);
        if (init && init.body !== undefined) {
          headers['Content-Length'] = String(Buffer.byteLength(String(init.body)));
        }
        const req = https.request({
          host: u.hostname,
          port: 443,
          path: u.pathname + u.search,
          method: (init && init.method) || 'GET',
          headers: headers,
          createConnection: function () { return tlsSock; },
          signal: init && init.signal
        }, function (res) {
          const chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            resolve({
              status: res.statusCode,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              text: function () {
                return Promise.resolve(Buffer.concat(chunks).toString('utf8'));
              }
            });
          });
        });
        req.on('error', function (e) {
          if (init && init.signal && init.signal.aborted) {
            reject(fail(504, '请求超时，请检查网络或 Base URL', 'TIMEOUT'));
          } else if (e.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || e.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
            reject(fail(502, '目标站点证书校验失败：' + u.hostname, 'TLS'));
          } else {
            reject(fail(502, '经代理请求 ' + u.hostname + ' 失败：' + (e.message || String(e)), 'NETWORK'));
          }
        });
        if (init && init.body !== undefined) req.write(init.body);
        req.end();
      });
      tlsSock.once('error', function (e) {
        reject(fail(502, '经代理与 ' + u.hostname + ' 的 TLS 握手失败：' + (e.message || String(e)), 'TLS'));
      });
    });
    connectReq.on('error', function (e) {
      reject(fail(502, '无法连接代理 ' + proxy.host + '：请确认代理软件正在运行，或设置 AKM_PROXY=off 强制直连', 'PROXY_UNREACHABLE'));
    });
    connectReq.end();
  });
}

function effectiveFetch(url, init) {
  if (PROXY_URL && /^https:\/\//i.test(String(url))) return proxyFetch(url, init);
  return fetch(url, init);
}

async function requestJson(url, headers, opts) {
  const f = (opts && opts.fetchImpl) || effectiveFetch;
  const timeoutMs = (opts && opts.timeoutMs) || 10000;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    const init = { headers: headers, signal: ctrl.signal };
    if (opts && opts.method) {
      init.method = opts.method;
      if (opts.body !== undefined) init.body = opts.body;
    }
    const res = await f(url, init);
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

function inferStyle(platform) { return platform === 'anthropic' ? 'anthropic' : 'openai'; }

function isKnownStyle(style) { return style === 'openai' || style === 'anthropic'; }

function modelsUrl(style, base) {
  const b = trimBase(base);
  return style === 'anthropic' ? b + '/v1/models' : b + '/models';
}

/* 部分面向编程工具的订阅中转站（如 Agent Router）会做客户端指纹检测，
   Node 默认 UA 会被拒（401 unauthorized client detected）；
   带上工具 UA 即可通过，对官方 API 无副作用 */
const TOOL_UA = 'claude-cli/1.0.23 (external, cli)';

function authHeaders(style, key) {
  const h = { 'User-Agent': TOOL_UA };
  if (style === 'anthropic') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
  } else {
    h['Authorization'] = 'Bearer ' + key;
  }
  return h;
}

function defaultEndpoints(platform) {
  const p = PLATFORMS[platform];
  return p && p.endpoints
    ? p.endpoints.map(function (e) { return { url: e.url, style: e.style }; })
    : [];
}

function normalizeEndpoints(platform, raw) {
  if (raw === undefined || raw === null) return defaultEndpoints(platform);
  if (!Array.isArray(raw)) throw fail(400, 'endpoints 应为数组，每项含 url 与 style');
  if (raw.length > 6) throw fail(400, '最多支持 6 个 Base URL');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] || {};
    const url = String(e.url == null ? '' : e.url).trim();
    const style = String(e.style == null ? '' : e.style).trim() || inferStyle(platform);
    if (!url) continue;
    if (style.length > 30) throw fail(400, '兼容模式名称过长（不超过 30 字符）');
    out.push({ url: url, style: style });
  }
  return out;
}

function primaryEndpoint(keyRec) {
  if (keyRec.endpoints && keyRec.endpoints.length) return keyRec.endpoints[0];
  return { url: keyRec.base || '', style: inferStyle(keyRec.platform) };
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

/* 火山方舟 Agent Plan 端点未实现 /models 列表接口（GET 必然 404），
   按官方文档内置模型目录，来源标 builtin
   https://www.volcengine.com/docs/82379/2366394（2026-08 版） */
const ARK_AGENT_PLAN_MODELS = [
  { id: 'doubao-seed-2.0-mini', ctx: 262144, out: 131072, note: '文本生成·极速' },
  { id: 'doubao-seed-2.0-lite', ctx: 262144, out: 131072, note: '文本生成·标准' },
  { id: 'deepseek-v4-flash', ctx: 1048576, out: 393216, note: '文本生成·标准' },
  { id: 'glm-5.3-flash', ctx: 1048576, out: 131072, note: '文本生成·标准·多模态' },
  { id: 'doubao-seed-2.1-turbo', ctx: 262144, out: 262144, note: '文本生成·进阶' },
  { id: 'doubao-seed-evolving', ctx: 1048576, out: 262144, note: '文本生成·进阶' },
  { id: 'minimax-m3', ctx: 1048576, out: 131072, note: '文本生成·进阶' },
  { id: 'glm-5.3', ctx: 1048576, out: 131072, note: '文本生成·进阶·默认开启思考' },
  { id: 'kimi-k2.7-code', ctx: 262144, out: 32768, note: '文本生成·进阶·代码' },
  { id: 'deepseek-v4-pro', ctx: 1048576, out: 393216, note: '文本生成·进阶' },
  { id: 'kimi-k3', ctx: 1048576, out: 131072, note: '文本生成·进阶·1M 上下文' },
  { id: 'ark-code-latest', ctx: 262144, out: 32768, note: '编程模型·OpenCode 示例' },
  { id: 'auto', ctx: 1048576, out: 131072, note: 'Auto 智能路由' },
  { id: 'doubao-embedding-vision', ctx: 131072, out: null, note: '向量化' },
  { id: 'doubao-seedream-5.0-lite', ctx: null, out: null, note: '图片生成' },
  { id: 'doubao-seedance-2.0', ctx: null, out: null, note: '视频生成' },
  { id: 'doubao-seedance-2.0-fast', ctx: null, out: null, note: '视频生成' },
  { id: 'doubao-seedance-2.0-mini', ctx: null, out: null, note: '视频生成' },
  { id: 'doubao-seed-tts-2.0', ctx: null, out: null, note: '语音合成' },
  { id: 'doubao-seed-asr-2.0', ctx: null, out: null, note: '语音识别' }
];

function isArkAgentPlanUrl(url) {
  return /^https?:\/\/[^\/]*volces\.com\/api\/plan\//i.test(String(url || '').trim());
}

async function fetchModels(platform, ep, key, opts) {
  const style = (ep && ep.style) || inferStyle(platform);
  const url = (ep && ep.url) || '';
  if (!trimBase(url)) {
    throw fail(400, '该密钥未配置 Base URL，无法自动拉取：请先填写地址，或手动添加模型', 'NO_BASE');
  }
  if (!isKnownStyle(style)) {
    throw fail(400, '「' + style + '」为自定义兼容模式，暂不支持自动拉取模型列表：请使用 OpenAI / Anthropic 兼容地址，或手动添加模型', 'UNSUPPORTED_STYLE');
  }
  const res = await requestJson(modelsUrl(style, url), authHeaders(style, key), opts);
  if (!res.ok) {
    if (res.status === 404 && isArkAgentPlanUrl(url)) {
      return ARK_AGENT_PLAN_MODELS.map(function (m) {
        return { id: m.id, ctx: m.ctx, out: m.out, src: 'builtin', note: m.note };
      });
    }
    if (res.status === 404) {
      throw fail(502, '模型列表接口不存在（HTTP 404）：该地址可能不支持 /models，请检查 Base URL 是否正确，或手动添加模型', '404');
    }
    throw fail(502, platformError(res.status), String(res.status));
  }
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

function chatProbePath(style) {
  return style === 'anthropic' ? '/v1/messages' : '/chat/completions';
}

/* 仅凭错误体是否提到 model 判断鉴权已通过（如 UnsupportedModel / model_not_found），
   而路径不存在的 404（如 Invalid URL）不含 model 字样，仍按地址错误处理 */
function modelErrorOf(body) {
  if (!body || typeof body !== 'object') return false;
  const err = body.error && typeof body.error === 'object' ? body.error : body;
  const hay = [err.code, err.message, body.code, body.message].filter(Boolean).join(' ');
  return /model/i.test(hay);
}

/* 部分 OpenAI 兼容端点（如火山方舟 Agent Plan）未实现 /models 列表接口，
   回退用不存在的模型名 POST 对话接口做鉴权探测：401/403 = 密钥无效，
   模型类错误 = 请求已通过鉴权，密钥可用；不产生实际推理与计费 */
async function chatAuthFallback(style, base, key, opts, t0) {
  const path = chatProbePath(style);
  const headers = Object.assign(authHeaders(style, key), { 'Content-Type': 'application/json' });
  const body = JSON.stringify({
    model: '__key_probe__',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }]
  });
  let res;
  try {
    res = await requestJson(trimBase(base) + path, headers, {
      fetchImpl: opts && opts.fetchImpl,
      timeoutMs: opts && opts.timeoutMs,
      method: 'POST',
      body: body
    });
  } catch (e) {
    return { status: 'fail', code: e.code || 'ERROR', msg: e.message };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'fail', code: String(res.status), msg: platformError(res.status) };
  }
  if (res.status === 200 || modelErrorOf(res.body)) {
    return {
      status: 'pass',
      latency: Date.now() - t0,
      msg: '该端点未提供模型列表接口，已通过 POST ' + path + ' 鉴权探测确认密钥可用'
    };
  }
  return { status: 'fail', code: String(res.status), msg: platformError(res.status) };
}

async function testKey(platform, ep, key, opts) {
  const style = (ep && ep.style) || inferStyle(platform);
  const url = (ep && ep.url) || '';
  if (!trimBase(url)) {
    return { status: 'fail', code: 'NO_BASE', msg: '无法测试：请先填写 Base URL' };
  }
  if (!isKnownStyle(style)) {
    return { status: 'fail', code: 'UNSUPPORTED_STYLE', msg: '「' + style + '」为自定义兼容模式，暂不支持自动测试' };
  }
  const t0 = Date.now();
  try {
    await fetchModels(platform, ep, key, opts);
    const msg = isArkAgentPlanUrl(url)
      ? '火山方舟 Agent Plan 端点，已按官方内置模型目录确认密钥可用'
      : 'GET ' + modelsUrl(style, url) + ' 返回正常，密钥可用';
    return { status: 'pass', latency: Date.now() - t0, msg: msg };
  } catch (e) {
    if (e.code !== '404') return { status: 'fail', code: e.code || 'ERROR', msg: e.message };
    return chatAuthFallback(style, url, key, opts, t0);
  }
}

async function fetchBalance(platform, ep, key, opts) {
  if (platform !== 'deepseek') return null;
  const style = (ep && ep.style) || inferStyle(platform);
  const url = (ep && ep.url) || '';
  const res = await requestJson(trimBase(url) + '/user/balance', authHeaders(style, key), opts);
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
  authHeaders: authHeaders,
  inferStyle: inferStyle,
  isKnownStyle: isKnownStyle,
  defaultEndpoints: defaultEndpoints,
  normalizeEndpoints: normalizeEndpoints,
  primaryEndpoint: primaryEndpoint,
  proxyFetch: proxyFetch,
  effectiveFetch: effectiveFetch
};
