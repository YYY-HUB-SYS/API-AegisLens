/*
  consumer-view.js — 「消费者令牌」管理视图（P4：机器侧凭据）
  ============================================================================
  原生 DOM，零框架 / 零构建 / 零 npm / 零 CDN / 零外部资源。新增两文件接入，不改宿主任何文件。

  接入（落到 app/public/index.html，见交付报告的三段片段）：
    <link rel="stylesheet" href="/consumer-view.css">
    <section id="consumer-tokens" aria-label="消费者令牌"></section>
    <script src="/consumer-view.js"></script>

  单一入口：mountConsumerView(rootEl, opts) -> { destroy(), refresh(), getState() }
    opts.fetchImpl     注入的 fetch（默认全局 fetch；自测传 ConsumerView.CONSUMER_MOCK）
    opts.endpoints     端点表浅合并覆盖
    opts.apiBase       curl 示例用的 origin，默认 location.origin，再退到 127.0.0.1:37700
    opts.exampleLimit  示例块最多列几行，默认 4（其余以「共 N 条」收尾）
    opts.onStatus      (phase)=>void，phase = loading|ready|locked|error

  后端契约（严格按此，不自创字段）：
    GET  /api/consumer/tokens       -> { tokens:[ tid,fingerprint,label,scopes,keyIds,credIds,
                                       resourceCount,issuedAt,expiresAt,expired,revoked,revokedAt,lastUsedAt ] }
    POST /api/consumer/tokens       { label,scopes,keyIds,credIds,ttlSeconds }
       201 -> { token,tid,fingerprint,label,scopes,keyIds,credIds,resourceCount,
                issuedAt,expiresAt,ttlSeconds }
    POST /api/consumer/tokens/:tid/revoke -> { ok,tid,revokedAt,tokens:[…同 GET 的数组…] }
    400 {error}（consumer-tokens.js 的中文校验文案）· 423 {error} · 429 {error,retryAfterMs}
    资源选项来自 GET /api/keys -> {keys:[…masked…]} 与 GET /api/credentials -> {credentials:[…masked…]}

  红线：token 只在 201 出现一次。它待在闭包变量里（不进 state、不进 getState、不落任何存储），
  「我已保存」之后连同 DOM 一起销毁。切标签页**不**自动收回——令牌不可再生，用户正要去别的
  终端粘贴时把它收掉，等于逼人吊销重签。
  ============================================================================
*/
(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  var EP = {
    tokens: '/api/consumer/tokens',
    issue: '/api/consumer/tokens',
    revoke: function (tid) { return '/api/consumer/tokens/' + encodeURIComponent(tid) + '/revoke'; },
    keys: '/api/keys',
    credentials: '/api/credentials'
  };

  /* 与 consumer-tokens.js 的 SCOPES 白名单一字不差；多一个字符服务端判 malformed */
  var SCOPES = ['key:read', 'key:test', 'balance:read', 'cred:read'];
  var SCOPE_FIELD = { 'key:read': 'key', 'key:test': 'key', 'balance:read': 'key', 'cred:read': 'cred' };
  var SCOPE_HELP = {
    'key:read': '读取所选密钥的记录与配置，清单外的密钥拿不到东西。',
    'key:test': '对所选密钥发起连通测试，同样只覆盖清单内的密钥。',
    'balance:read': '读取所选密钥的余额，按密钥计，不含其它资源。',
    'cred:read': '取用所选凭证记录，清单外的凭证取不到。'
  };

  var MAX_LABEL = 40;             // consumer-tokens.js: MAX_LABEL_LEN
  var MAX_RESOURCE = 64;          // consumer-tokens.js: MAX_TOTAL_RESOURCE_IDS
  var MIN_TTL = 60;               // consumer-tokens.js: MIN_TTL_SECONDS
  var MAX_TTL = 90 * 24 * 3600;   // consumer-tokens.js: MAX_TTL_SECONDS
  var TTL_OPTIONS = [
    { days: 1, seconds: 24 * 3600 },
    { days: 7, seconds: 7 * 24 * 3600 },
    { days: 30, seconds: 30 * 24 * 3600 },
    { days: 90, seconds: 90 * 24 * 3600 }
  ];
  var TTL_DEFAULT = 30 * 24 * 3600;
  var EXAMPLE_LIMIT_DEFAULT = 4;
  var FALLBACK_BASE = 'http://127.0.0.1:37700';
  var NAME_LIST_MAX = 4;          // 资源名超过 4 个就只报数量，不铺满整行

  // =========================================================================
  // 纯工具（不依赖 DOM，可被 node 直接调用）
  // =========================================================================
  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function safeJson(res) {
    if (!res || typeof res.json !== 'function') return Promise.resolve(null);
    return res.json().catch(function () { return null; });
  }
  function shallowMerge(a, b) {
    var o = {}; Object.keys(a).forEach(function (k) { o[k] = a[k]; });
    Object.keys(b || {}).forEach(function (k) { o[k] = b[k]; });
    return o;
  }

  /* 429 的 retryAfterMs 只在响应体里；不在这里捞出来，界面只剩一句没有时长的「稍后再试」 */
  function classifyStatus(status, data) {
    var out = { kind: 'client', message: '', retryAfterMs: 0 };
    var msg = (data && (data.error || data.message)) || '';
    if (status >= 200 && status < 300) { out.kind = 'ok'; return out; }
    if (status === 423) { out.kind = 'locked'; out.message = msg || '保险库未解锁'; return out; }
    if (status === 429) {
      out.kind = 'rate'; out.message = msg || '操作过于频繁';
      if (data && typeof data.retryAfterMs === 'number' && data.retryAfterMs > 0) out.retryAfterMs = data.retryAfterMs;
      return out;
    }
    if (status >= 500) { out.kind = 'server'; out.message = msg || '服务暂时不可用（' + status + '）'; return out; }
    if (!status) { out.kind = 'net'; out.message = msg || '无法连接本地服务'; return out; }
    out.kind = 'client'; out.message = msg || ('请求失败（' + status + '）');
    return out;
  }

  function ids(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length; i++) {
      var n = Number(v[i]);
      if (Number.isSafeInteger(n) && n > 0 && out.indexOf(n) === -1) out.push(n);
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function listFrom(data, key) {
    /* 只认 data[key] 的话，后端哪天回成裸数组就是一片空白——契约错位不报错、不转圈，最难查 */
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data[key])) return data[key];
    if (data && Array.isArray(data.items)) return data.items;
    return null;
  }

  function parseTokens(data) {
    var arr = listFrom(data, 'tokens');
    if (!arr) return [];
    var now = Date.now();
    return arr.map(function (t) {
      t = t || {};
      var keyIds = ids(t.keyIds); var credIds = ids(t.credIds);
      var count = num(t.resourceCount);
      return {
        tid: str(t.tid),
        fingerprint: str(t.fingerprint),
        label: str(t.label),
        scopes: Array.isArray(t.scopes) ? t.scopes.map(str) : [],
        keyIds: keyIds,
        credIds: credIds,
        resourceCount: count === null ? keyIds.length + credIds.length : count,
        issuedAt: t.issuedAt || null,
        expiresAt: t.expiresAt || null,
        expired: typeof t.expired === 'boolean' ? t.expired : (t.expiresAt ? Date.parse(t.expiresAt) <= now : false),
        revoked: typeof t.revoked === 'boolean' ? t.revoked : !!t.revokedAt,
        revokedAt: t.revokedAt || null,
        lastUsedAt: t.lastUsedAt || null
      };
    }).filter(function (t) { return t.tid; });
  }

  function parseKeys(data) {
    var arr = listFrom(data, 'keys');
    if (!arr) return [];
    return arr.map(function (k) {
      k = k || {};
      return { id: num(k.id), name: str(k.name) || str(k.customName) || '（未命名）', platform: str(k.platform), masked: str(k.keyMasked) };
    }).filter(function (k) { return k.id !== null; });
  }

  function parseCredentials(data) {
    var arr = listFrom(data, 'credentials');
    if (!arr) return [];
    return arr.map(function (c) {
      c = c || {};
      return { id: num(c.id), title: str(c.title) || str(c.username) || '（未命名）', username: str(c.username) };
    }).filter(function (c) { return c.id !== null; });
  }

  function pad(x) { return (x < 10 ? '0' : '') + x; }

  /* 同一年不写年份：列表里那 4 个数字换来的换行不值得 */
  function fmtDateTime(v, nowMs) {
    var t = Date.parse(v); if (isNaN(t)) return '—';
    var d = new Date(t);
    var base = pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    var y = new Date(num(nowMs) || Date.now()).getFullYear();
    return d.getFullYear() === y ? base : d.getFullYear() + '-' + base;
  }

  function spanText(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60); if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60); if (h < 24) return h + ' 小时';
    var d = Math.floor(h / 24); if (d < 30) return d + ' 天';
    var mo = Math.floor(d / 30); if (mo < 12) return mo + ' 个月';
    return Math.floor(d / 365) + ' 年';
  }

  function relUntil(v, nowMs) {
    var t = Date.parse(v); if (isNaN(t)) return '';
    var d = t - (num(nowMs) || Date.now());
    return d <= 0 ? '已过期 ' + spanText(-d) : '剩 ' + spanText(d);
  }
  function relSince(v, nowMs) {
    var t = Date.parse(v); if (isNaN(t)) return '';
    var d = (num(nowMs) || Date.now()) - t;
    if (d < 60000) return '刚刚';
    return spanText(d) + '前';
  }
  function retryText(ms) { return '请 ' + Math.max(1, Math.ceil((num(ms) || 0) / 1000)) + ' 秒后再试。'; }

  /* 吊销优先于过期：一把既过期又吊销的令牌，人要看到的是「已经不用了」 */
  function tokenStatus(t) {
    if (t.revoked) return { key: 'revoked', cn: '已吊销' };
    if (t.expired) return { key: 'expired', cn: '已过期' };
    return { key: 'active', cn: '有效' };
  }

  function resourceNames(t, res) {
    var out = [];
    t.keyIds.forEach(function (id) {
      var k = res.byKeyId[id];
      out.push(k ? (k.name + (k.masked ? ' ·' + k.masked : '')) : ('密钥 ' + id));
    });
    t.credIds.forEach(function (id) {
      var c = res.byCredId[id];
      out.push(c ? c.title : ('凭证 ' + id));
    });
    return out;
  }

  /* 资源少的时候报名字，多的时候只报数量：一行铺 20 个名字等于没铺 */
  function resourceSummary(t, res) {
    if (!t.keyIds.length && !t.credIds.length && !t.resourceCount) return { text: '未绑定资源', names: '' };
    var parts = [];
    if (t.keyIds.length) parts.push('密钥 ' + t.keyIds.length);
    if (t.credIds.length) parts.push('凭证 ' + t.credIds.length);
    var names = res.state === 'ready' ? resourceNames(t, res) : [];
    var short = t.resourceCount <= NAME_LIST_MAX && names.length === t.keyIds.length + t.credIds.length;
    return { text: t.resourceCount + ' 项' + (parts.length ? ' · ' + parts.join(' + ') : ''), names: short ? names.join('、') : '' };
  }

  /* 示例只列前几条：64 把 key 全铺出来等于把面板变成日志，用户要的是一行能改的样板 */
  function curlExampleLines(meta, base, limit) {
    var token = str(meta && meta.token);
    var paths = [];
    ids(meta && meta.keyIds).forEach(function (id) { paths.push('/api/consumer/keys/' + id); });
    ids(meta && meta.credIds).forEach(function (id) { paths.push('/api/consumer/credentials/' + id); });
    var total = paths.length;
    var cap = Math.max(1, num(limit) || EXAMPLE_LIMIT_DEFAULT);
    var lines = paths.slice(0, cap).map(function (p) {
      return 'curl -H "Authorization: Bearer ' + token + '" ' + str(base || FALLBACK_BASE) + p;
    });
    return { lines: lines, total: total, hidden: Math.max(0, total - lines.length) };
  }

  function scopeGroups(scopes) {
    var g = { key: false, cred: false };
    (scopes || []).forEach(function (s) { var f = SCOPE_FIELD[s]; if (f) g[f] = true; });
    return g;
  }

  /* 令牌真正带上哪些资源：没勾对应作用域的那一类，那一类的勾选就不算。
     被禁用的 checkbox 在 querySelectorAll(':checked') 里照样命中，以前是原样发出去的——
     提示写着「勾了资源也不会进令牌」，实际一个不少：签出来的令牌上挂着永远调不通的资源，
     列表显示「密钥 5」却一把都读不到，事后完全看不出当时是怎么签的。
     draft 里仍保留原始勾选（重勾作用域就不用再挑一遍），只有这一道裁剪是权威。 */
  function effectiveIds(draft) {
    var g = scopeGroups(draft && draft.scopes);
    return {
      keyIds: g.key ? ((draft && draft.keyIds) || []) : [],
      credIds: g.cred ? ((draft && draft.credIds) || []) : []
    };
  }

  // =========================================================================
  // 图标（内联 SVG，无 emoji，无外部 sprite）
  // =========================================================================
  var IC = {
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="4"/><path d="M11 11l8 8M16 16l2-2M18.5 18.5l1.5-1.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 16M4 20v-4h4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l9 15H3l9-15Z"/><path d="M12 10v4M12 16.5v.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  // =========================================================================
  // 挂载：状态机 + 渲染 + 事件委托
  // =========================================================================
  function mountConsumerView(rootEl, opts) {
    opts = opts || {};
    if (!rootEl) throw new Error('mountConsumerView: rootEl 必需');
    var endpoints = shallowMerge(EP, opts.endpoints || {});
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(global) : null);
    if (!fetchImpl) throw new Error('mountConsumerView: 需要 fetchImpl（浏览器 fetch 或自测传入 CONSUMER_MOCK）');
    var exampleLimit = opts.exampleLimit || EXAMPLE_LIMIT_DEFAULT;
    var apiBase = (typeof opts.apiBase === 'string' && opts.apiBase)
      ? opts.apiBase.replace(/\/+$/, '')
      : ((global.location && global.location.origin) || FALLBACK_BASE);

    var state = {
      phase: 'loading',           // loading | ready | locked | error
      err: null,                  // {kind,message,retryAfterMs}
      tokens: [],
      formOpen: false,
      draft: { label: '', scopes: ['key:read'], keyIds: [], credIds: [], ttl: TTL_DEFAULT },
      res: { state: 'idle', err: null, keys: [], creds: [], byKeyId: {}, byCredId: {} },
      issuing: false,
      issueErr: '',
      ack: false,
      confirm: null,              // { tid, label } 正在二次确认的那一把
      busyTid: '',
      note: null                  // { kind:'ok'|'warn'|'danger', msg } 复制结果 / 限流提示
    };

    /* 一次性令牌不进 state：getState() 是给人调试的，不该顺手把明文带出去 */
    var pending = null;           // { token, meta, example }

    rootEl.classList.add('cvw-root');
    rootEl.setAttribute('data-cvw-module', 'consumer-tokens');
    var mountPoint = document.createElement('div');
    mountPoint.className = 'cvw-mount';
    rootEl.appendChild(mountPoint);

    var api = makeApi(fetchImpl);

    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('input', onInput);
    rootEl.addEventListener('change', onChange);
    rootEl.addEventListener('submit', onSubmit);
    rootEl.addEventListener('keydown', onKeydown);

    (function boot() { loadTokens(); render(); })();

    function destroy() {
      rootEl.removeEventListener('click', onClick);
      rootEl.removeEventListener('input', onInput);
      rootEl.removeEventListener('change', onChange);
      rootEl.removeEventListener('submit', onSubmit);
      rootEl.removeEventListener('keydown', onKeydown);
      pending = null;
      mountPoint.innerHTML = '';
      rootEl.classList.remove('cvw-root');
    }

    function makeApi(f) {
      function handle(res) {
        return safeJson(res).then(function (data) {
          return { ok: res.ok, status: res.status, data: data, classify: classifyStatus(res.status, data) };
        });
      }
      function fail(err) {
        return { ok: false, status: 0, data: null, classify: classifyStatus(0, { error: (err && err.message) || '' }) };
      }
      return {
        get: function (url) {
          return f(url, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(handle, fail);
        },
        /* Origin 不手动塞：浏览器对 same-origin 的非 GET 自动附带，JS 本来也伪造不了它 */
        send: function (method, url, body) {
          var init = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
          if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
          return f(url, init).then(handle, fail);
        }
      };
    }

    function setNote(kind, msg, cls) {
      state.note = { kind: kind, msg: msg, retryAfterMs: (cls && cls.retryAfterMs) || 0 };
    }
    function rateOr(r, fallback) {
      return r.kind === 'rate' ? (r.message + ' ' + retryText(r.retryAfterMs)) : (r.message || fallback);
    }

    // ---------- 读取 ----------
    function loadTokens() {
      state.phase = 'loading'; state.err = null; render();
      api.get(endpoints.tokens).then(function (r) {
        if (r.classify.kind === 'locked') { lockOut(r.classify); return; }
        if (!r.ok) {
          if (r.classify.kind === 'rate') setNote('warn', rateOr(r.classify, '读取过于频繁'), r.classify);
          state.phase = 'error'; state.err = r.classify; render(); return;
        }
        state.tokens = parseTokens(r.data);
        state.phase = 'ready'; state.err = null;
        render();
      });
    }

    function loadResources(force) {
      if (state.res.state === 'loading' || (state.res.state === 'ready' && !force)) return;
      state.res.state = 'loading'; state.res.err = null; render();
      Promise.all([api.get(endpoints.keys), api.get(endpoints.credentials)]).then(function (rr) {
        var hit = rr.filter(function (r) { return r.classify.kind === 'locked'; })[0];
        if (hit) { lockOut(hit.classify); return; }
        var bad = rr.filter(function (r) { return !r.ok; })[0];
        if (bad) {
          state.res.state = 'error'; state.res.err = bad.classify;
          if (bad.classify.kind === 'rate') setNote('warn', rateOr(bad.classify, '资源读取过于频繁'), bad.classify);
          render(); return;
        }
        state.res.keys = parseKeys(rr[0].data);
        state.res.creds = parseCredentials(rr[1].data);
        /* key 与 cred 的 id 各自从 1 开始，塞进同一张表会互相盖掉 */
        state.res.byKeyId = {};
        state.res.byCredId = {};
        state.res.keys.forEach(function (k) { state.res.byKeyId[k.id] = k; });
        state.res.creds.forEach(function (c) { state.res.byCredId[c.id] = c; });
        state.res.state = 'ready';
        render();
      });
    }

    /* 423 到此为止：列表清空、表单禁用、不自动重试。
       「没有令牌」和「读不到令牌」是两件事，混成一片空列表是最坑的假象 */
    function lockOut(cls) {
      pending = null;
      state.phase = 'locked';
      state.err = cls && cls.kind ? cls : { kind: 'locked', message: '保险库未解锁', retryAfterMs: 0 };
      state.tokens = [];
      state.confirm = null;
      state.res.state = 'idle';
      state.res.err = null;
      render();
    }

    // ---------- 表单收集 ----------
    function formEl() { return mountPoint.querySelector('[data-role="issue"]'); }
    function checkedIds(form, kind) {
      var out = [];
      Array.prototype.forEach.call(form.querySelectorAll('[data-res][data-kind="' + kind + '"]:checked'), function (el) {
        var n = Number(el.getAttribute('data-val'));
        if (Number.isSafeInteger(n) && n > 0 && out.indexOf(n) === -1) out.push(n);
      });
      return out;
    }
    function collectForm() {
      var form = formEl(); if (!form) return state.draft;
      var label = form.querySelector('#cvw-label');
      if (label) state.draft.label = label.value;
      var ttl = form.querySelector('#cvw-ttl');
      if (ttl) state.draft.ttl = Number(ttl.value) || TTL_DEFAULT;
      state.draft.scopes = Array.prototype.slice.call(form.querySelectorAll('[data-scope]:checked'))
        .map(function (el) { return el.getAttribute('data-scope'); });
      /* draft 忠实记 DOM 的勾选，包括被禁用的那一类——重绘时还得把它们显示回来，
         用户重勾作用域就不用再挑一遍。是否进令牌在签发那一步按作用域裁剪。 */
      state.draft.keyIds = checkedIds(form, 'key');
      state.draft.credIds = checkedIds(form, 'cred');
      return state.draft;
    }

    // ---------- 签发 ----------
    function issue() {
      if (state.issuing || pending || state.phase === 'locked') return;
      var d = collectForm();
      var label = String(d.label || '').trim();
      var groups = scopeGroups(d.scopes);
      if (!label) { state.issueErr = 'label 不能为空：它是这把令牌唯一的人类标识。'; render(); return; }
      if (label.length > MAX_LABEL) { state.issueErr = 'label 最长 ' + MAX_LABEL + ' 字符，当前 ' + label.length; render(); return; }
      if (!d.scopes.length) { state.issueErr = 'scopes 不能为空：没有作用域的令牌等于废令牌。'; render(); return; }
      var eff = effectiveIds(d);
      var keyIds = eff.keyIds.slice();
      var credIds = eff.credIds.slice();
      var total = keyIds.length + credIds.length;
      if (total > MAX_RESOURCE) { state.issueErr = '资源条目合计最多 ' + MAX_RESOURCE + ' 个（当前 ' + total + '）。'; render(); return; }
      if (groups.key && !keyIds.length) { state.issueErr = '勾选了密钥类作用域但没选任何密钥：清单为空表示一把都读不到，这样的令牌签出来是废的。'; render(); return; }
      if (groups.cred && !credIds.length) { state.issueErr = '勾选了 cred:read 但没选任何凭证：清单为空的 cred:read 读不到东西。'; render(); return; }

      state.issuing = true; state.issueErr = ''; state.note = null; render();
      api.send('POST', endpoints.issue, {
        label: label,
        scopes: d.scopes.slice(),
        keyIds: keyIds,
        credIds: credIds,
        ttlSeconds: d.ttl
      }).then(function (r) {
        state.issuing = false;
        if (r.classify.kind === 'locked') { lockOut(r.classify); return; }
        if (!r.ok) { state.issueErr = rateOr(r.classify, '签发失败'); render(); return; }
        var t = r.data || {};
        if (!str(t.token)) { state.issueErr = '响应里没有 token 字段：令牌只给一次，这次没拿到就再也拿不到，请检查后端。'; render(); return; }
        var meta = {
          tid: str(t.tid), token: str(t.token), fingerprint: str(t.fingerprint), label: str(t.label) || label,
          scopes: Array.isArray(t.scopes) ? t.scopes.map(str) : d.scopes.slice(),
          keyIds: ids(t.keyIds), credIds: ids(t.credIds),
          resourceCount: num(t.resourceCount) === null ? ids(t.keyIds).length + ids(t.credIds).length : num(t.resourceCount),
          issuedAt: t.issuedAt || null, expiresAt: t.expiresAt || null,
          ttlSeconds: num(t.ttlSeconds) === null ? d.ttl : num(t.ttlSeconds)
        };
        pending = { token: str(t.token), meta: meta, example: curlExampleLines(meta, apiBase, exampleLimit) };
        state.ack = false; state.formOpen = false;
        state.draft.label = ''; state.draft.keyIds = []; state.draft.credIds = [];
        state.tokens.unshift({
          tid: meta.tid, fingerprint: meta.fingerprint, label: meta.label, scopes: meta.scopes,
          keyIds: meta.keyIds, credIds: meta.credIds, resourceCount: meta.resourceCount,
          issuedAt: meta.issuedAt, expiresAt: meta.expiresAt,
          expired: false, revoked: false, revokedAt: null, lastUsedAt: null
        });
        render();
      });
    }

    function ackSaved() {
      pending = null;   // 销毁：内存与 DOM 一起，之后任何渲染路径都画不出它
      state.ack = false;
      state.note = { kind: 'ok', msg: '令牌已从本页销毁；没保存就只能吊销重签。', retryAfterMs: 0 };
      render();
    }

    // ---------- 吊销 ----------
    function revoke(tid) {
      if (state.busyTid || !tid) return;
      state.busyTid = tid; render();
      api.send('POST', endpoints.revoke(tid), {}).then(function (r) {
        state.busyTid = '';
        if (r.classify.kind === 'locked') { lockOut(r.classify); return; }
        state.confirm = null;
        if (!r.ok) { setNote('danger', rateOr(r.classify, '吊销失败'), r.classify); render(); return; }
        /* 后端已经把吊销后的完整清单回在这里，就照它重绘，不再补一次 GET */
        var arr = r.data && listFrom(r.data, 'tokens');
        if (arr) state.tokens = parseTokens(r.data);
        setNote('ok', '已吊销，机器侧下一次调用即失效。');
        render();
      });
    }

    // ---------- 事件 ----------
    function onClick(ev) {
      var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!t) return;
      var act = t.getAttribute('data-act');
      switch (act) {
        case 'reload': state.note = null; loadTokens(); break;
        case 'open-form':
          state.formOpen = true; state.issueErr = '';
          /* 资源清单已经在内存时 loadResources 会直接返回，所以 render 必须自己补一次，
             否则第二次展开表单点了没反应 */
          if (state.phase !== 'locked' && state.phase !== 'error') loadResources();
          render();
          break;
        case 'close-form': state.formOpen = false; state.issueErr = ''; render(); break;
        case 'reload-resources': loadResources(true); break;
        case 'issue': issue(); break;
        case 'copy-token': copyText(pending ? pending.token : ''); break;
        case 'copy-example': copyText(pending ? pending.example.lines.join('\n') : ''); break;
        case 'select-example': selectBlock('#cvw-example'); break;
        case 'ack': {
          var cb = mountPoint.querySelector('#cvw-ack-box');
          if (!cb || !cb.checked) { state.note = { kind: 'warn', msg: '勾选「我已保存」才能关闭——这串令牌不会再出现第二次。', retryAfterMs: 0 }; render(); return; }
          ackSaved(); break;
        }
        case 'revoke': {
          var tid = t.getAttribute('data-tid');
          var rec = byTid(tid);
          state.confirm = { tid: tid, label: rec ? rec.label : tid };
          render(); break;
        }
        case 'revoke-cancel': state.confirm = null; render(); break;
        case 'revoke-confirm': revoke(t.getAttribute('data-tid')); break;
        case 'select-all': toggleGroup(t.getAttribute('data-group'), true); break;
        case 'clear-all': toggleGroup(t.getAttribute('data-group'), false); break;
        default: break;
      }
    }

    function toggleGroup(group, on) {
      var form = formEl(); if (!form) return;
      var kind = group === 'cred' ? 'cred' : 'key';
      collectForm();
      var other = kind === 'key' ? state.draft.credIds.length : state.draft.keyIds.length;
      var room = MAX_RESOURCE - other;
      var picked = 0;
      Array.prototype.forEach.call(form.querySelectorAll('[data-res][data-kind="' + kind + '"]'), function (el) {
        if (el.disabled) return;
        el.checked = on ? picked < room : false;
        if (el.checked) picked++;
      });
      collectForm(); syncCounters();
    }

    function byTid(tid) {
      for (var i = 0; i < state.tokens.length; i++) if (state.tokens[i].tid === tid) return state.tokens[i];
      return null;
    }

    function onInput(ev) {
      if (ev.target.id === 'cvw-label') { state.draft.label = ev.target.value; syncLabelCount(); }
    }

    function onChange(ev) {
      var el = ev.target;
      if (el.hasAttribute && el.hasAttribute('data-scope')) { collectForm(); render(); return; }
      if (el.hasAttribute && el.hasAttribute('data-res')) { collectForm(); syncCounters(); return; }
      if (el.id === 'cvw-ttl') { state.draft.ttl = Number(el.value) || TTL_DEFAULT; syncTtlNote(); return; }
      if (el.id === 'cvw-ack-box') {
        state.ack = !!el.checked;
        var btn = mountPoint.querySelector('[data-act="ack"]');
        if (btn) btn.disabled = !el.checked;
      }
    }

    function onSubmit(ev) {
      ev.preventDefault();
      if (ev.target.getAttribute && ev.target.getAttribute('data-role') === 'issue') issue();
    }

    function onKeydown(ev) {
      if (ev.key !== 'Escape') return;
      if (state.confirm) { state.confirm = null; render(); return; }
      if (state.formOpen && !pending) { state.formOpen = false; render(); }
    }

    // ---------- 剪贴板 ----------
    function copyText(text) {
      if (text === null || text === undefined || text === '') { setNote('danger', '没有可复制的内容。'); render(); return; }
      var done = function (ok) {
        setNote(ok ? 'ok' : 'danger', ok ? '已复制到剪贴板。' : '复制失败：请手动选中令牌文本再复制。');
        render();
      };
      /* file:// 打开或非安全上下文下 navigator.clipboard 就是 undefined，读它不能抛 */
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(String(text)).then(function () { done(true); }, function () { legacyCopy(String(text), done); });
      } else { legacyCopy(String(text), done); }
    }
    function legacyCopy(text, done) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'absolute'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); done(ok);
    }
    function selectBlock(sel) {
      var el = mountPoint.querySelector(sel); if (!el) return;
      var selObj = global.getSelection ? global.getSelection() : null;
      if (!selObj || !document.createRange) { setNote('warn', '这个浏览器不支持整块选中，请手动拖选。'); render(); return; }
      try {
        var range = document.createRange();
        range.selectNodeContents(el);
        selObj.removeAllRanges(); selObj.addRange(range);
        setNote('ok', '已选中整段，按 Ctrl+C（macOS 为 Command+C）复制。');
      } catch (e) { setNote('danger', '选中失败，请手动选择。'); }
      render();
    }

    // =========================================================================
    // 渲染
    // =========================================================================
    function render() {
      var html = '<div class="cvw-shell">' + header();
      if (state.note) html += notice();
      if (state.phase === 'locked') html += lockedBanner();
      if (pending) html += revealView();
      else if (state.formOpen) html += issueForm();
      html += listView();
      html += '</div>';
      mountPoint.innerHTML = html;
      if (state.formOpen && !pending) { syncLabelCount(); syncCounters(); syncTtlNote(); }
      if (opts.onStatus) { try { opts.onStatus(state.phase); } catch (e) {} }
    }

    function header() {
      return '<div class="cvw-top">' +
        '<div class="cvw-brand"><span class="cvw-mark">' + IC.key + '</span>' +
          '<div><h2 class="cvw-title">消费者令牌</h2>' +
          '<p class="cvw-sub cvw-mono">CONSUMER · SCOPED · REVOCABLE</p></div></div>' +
        '<div class="cvw-spacer"></div>' +
        '<button class="cvw-btn" type="button" data-act="reload">' + IC.refresh + '<span>刷新</span></button>' +
        (pending || state.formOpen ? '' : '<button class="cvw-btn primary" type="button" data-act="open-form">' + IC.plus + '<span>签发令牌</span></button>') +
        '</div>' +
        '<p class="cvw-desc">给本机 CLI、代理框架和内部服务发窄权限、会到期、可单独吊销的 bearer 令牌，让它们不再共用保险库口令。库里只存 HMAC 指纹，令牌明文只在签发那一次显示。</p>';
    }

    function notice() {
      var n = state.note;
      return '<div class="cvw-note" role="status" data-kind="' + esc(n.kind) + '">' +
        (n.kind === 'ok' ? IC.check : IC.alert) + '<span>' + esc(n.msg) + '</span></div>';
    }

    function lockedBanner() {
      return '<div class="cvw-banner" data-kind="locked" role="alert">' + IC.lock +
        '<div class="cvw-banner-body"><b>先解锁保险库</b>' +
        '<span>' + esc(state.err && state.err.message ? state.err.message : '管理端点返回 423。') +
        ' 解锁后点「重试」；本页不会自己反复敲锁着的门。</span></div>' +
        '<button class="cvw-btn small" type="button" data-act="reload">重试</button></div>';
    }

    // ---------- 一次性显示 ----------
    function revealView() {
      var meta = pending.meta;
      var ex = pending.example;
      var body = ex.lines.map(function (l) { return esc(l); }).join('\n');
      return '<section class="cvw-once" data-once="1" aria-labelledby="cvw-once-h">' +
        '<h3 id="cvw-once-h">' + IC.alert + '<span>只此一次：' + esc(meta.label) + '</span></h3>' +
        '<p class="cvw-once-sub">下面这串就是令牌本体，关掉这里它永久消失，只能重签。</p>' +
        '<div class="cvw-tokenbox cvw-mono" id="cvw-token" tabindex="0" role="textbox" aria-label="消费者令牌明文">' + esc(meta.token) + '</div>' +
        '<div class="cvw-acts">' +
          '<button class="cvw-btn" type="button" data-act="copy-token">' + IC.copy + '<span>复制令牌</span></button>' +
          '<button class="cvw-btn ghost" type="button" data-act="copy-example">' + IC.copy + '<span>复制示例</span></button>' +
        '</div>' +
        '<dl class="cvw-facts">' +
          fact('指纹', (meta.fingerprint || '—').slice(0, 8), true) +
          fact('作用域', meta.scopes.join('、') || '无', false) +
          fact('资源', meta.resourceCount + ' 项', false) +
          fact('到期', fmtDateTime(meta.expiresAt) + '（' + spanText((num(meta.ttlSeconds) || 0) * 1000) + '）', false) +
        '</dl>' +
        '<div class="cvw-ex-head"><span class="cvw-ex-title">可直接粘贴的调用示例</span>' +
          '<button class="cvw-btn small ghost" type="button" data-act="select-example">全选</button></div>' +
        (ex.lines.length
          ? '<pre class="cvw-example cvw-mono" id="cvw-example" tabindex="0" role="region" aria-label="调用示例">' + body + '</pre>' +
            (ex.hidden > 0 ? '<p class="cvw-hint">共 ' + ex.total + ' 条，这里只列前 ' + ex.lines.length + ' 条；其余把行尾 id 换成自己要的那把。</p>' : '')
          : '<p class="cvw-hint">这把令牌没绑定资源，示例里无 id 可填；绑定了资源的令牌会在这里给出 curl。</p>') +
        '<label class="cvw-check"><input type="checkbox" id="cvw-ack-box"' + (state.ack ? ' checked' : '') + '>' +
          '<span class="cvw-check-txt">我已保存<small>勾选后才能关闭；关闭后本页再也显示不出这串令牌。</small></span></label>' +
        '<button class="cvw-btn primary block" type="button" data-act="ack"' + (state.ack ? '' : ' disabled') + '>' + IC.check + '<span>关闭并销毁</span></button>' +
        '</section>';
    }
    function fact(k, v, mono) {
      return '<div class="cvw-fact"><dt>' + esc(k) + '</dt><dd class="' + (mono ? 'cvw-mono' : '') + '">' + esc(v) + '</dd></div>';
    }

    // ---------- 签发表单 ----------
    function issueForm() {
      var d = state.draft;
      var groups = scopeGroups(d.scopes);
      var locked = state.phase === 'locked';
      var eff = effectiveIds(d);
      var total = eff.keyIds.length + eff.credIds.length;
      var dis = locked ? ' disabled' : '';
      var errHtml = state.issueErr
        ? '<div class="cvw-banner" data-kind="bad" role="alert">' + IC.alert +
          '<div class="cvw-banner-body"><b>签发被拒</b><span>' + esc(state.issueErr) + '</span></div></div>'
        : '';
      return '<form class="cvw-form" data-role="issue" data-locked="' + (locked ? '1' : '0') + '" aria-labelledby="cvw-form-h" onsubmit="return false">' +
        '<h3 id="cvw-form-h">' + IC.plus + '<span>签发新令牌</span></h3>' +
        (locked ? '<p class="cvw-hint">保险库未解锁，表单只读；解锁后才能读取资源清单和签发。</p>' : '') +
        errHtml +
        '<div class="cvw-field">' +
          '<label class="cvw-label" for="cvw-label">名称（label）</label>' +
          '<input class="cvw-input" id="cvw-label" type="text" maxlength="' + MAX_LABEL + '" autocomplete="off" spellcheck="false"' + dis +
            ' value="' + esc(d.label) + '" placeholder="哪个消费者用它，如 claude-code">' +
          '<div class="cvw-hint"><span class="cvw-count" data-count-label>0 / ' + MAX_LABEL + '</span> 名称只作展示与审计，不参与授权判定。</div>' +
        '</div>' +
        '<div class="cvw-field">' +
          '<span class="cvw-label" id="cvw-scopes-h">作用域（scopes）</span>' +
          '<div class="cvw-scopes" role="group" aria-labelledby="cvw-scopes-h">' + scopeBoxes(d.scopes, locked) + '</div>' +
          '<div class="cvw-hint">' + IC.info + '<span>key:read / key:test / balance:read 共用一份密钥清单，cred:read 用凭证清单；清单为空表示一把都读不到，不是不限。</span></div>' +
        '</div>' +
        picker('key', '密钥（keyIds）', state.res, d.keyIds, groups.key, locked) +
        picker('cred', '凭证（credIds）', state.res, d.credIds, groups.cred, locked) +
        '<div class="cvw-field">' +
          '<label class="cvw-label" for="cvw-ttl">有效期</label>' +
          '<select class="cvw-select" id="cvw-ttl"' + dis + '>' + ttlOptions(d.ttl) + '</select>' +
          '<div class="cvw-hint" data-ttl-note></div>' +
        '</div>' +
        '<div class="cvw-foot">' +
          '<span class="cvw-count" data-count-res>已选 0 / 上限 ' + MAX_RESOURCE + '</span>' +
          '<div class="cvw-spacer"></div>' +
          '<button class="cvw-btn ghost" type="button" data-act="close-form">取消</button>' +
          '<button class="cvw-btn primary" type="submit" data-act="issue"' + (locked || state.issuing ? ' disabled' : '') + '>' +
            (state.issuing ? '签发中…' : '签发并显示一次') + '</button>' +
        '</div>' +
        (total > MAX_RESOURCE ? '<p class="cvw-hint cvw-over">已选 ' + total + ' 项，超过上限 ' + MAX_RESOURCE + '，服务端会直接拒绝。</p>' : '') +
        '</form>';
    }

    function scopeBoxes(selected, locked) {
      return SCOPES.map(function (s) {
        var on = selected.indexOf(s) !== -1;
        return '<label class="cvw-scope">' +
          '<input type="checkbox" data-scope="' + esc(s) + '"' + (on ? ' checked' : '') + (locked ? ' disabled' : '') + '>' +
          '<span class="cvw-scope-body"><span class="cvw-scope-id cvw-mono">' + esc(s) + '</span>' +
          '<span class="cvw-scope-help">' + esc(SCOPE_HELP[s]) + '</span></span></label>';
      }).join('');
    }

    function picker(kind, title, res, picked, enabled, locked) {
      var off = locked || !enabled;
      var dis = off ? ' disabled' : '';
      var head = '<div class="cvw-pick-head"><span class="cvw-pick-title">' + esc(title) + '</span>' +
        '<span class="cvw-pick-count" data-count-' + kind + '>已选 0</span></div>';
      if (locked) return '<div class="cvw-pick" data-state="locked">' + head + '<p class="cvw-hint">解锁后才能列出资源。</p></div>';
      if (res.state === 'loading') return '<div class="cvw-pick" data-state="loading">' + head + '<p class="cvw-hint">正在读取资源清单…</p></div>';
      if (res.state === 'error') return '<div class="cvw-pick" data-state="error">' + head +
        '<p class="cvw-hint">' + esc(res.err && res.err.message ? res.err.message : '资源清单读取失败。') + '</p>' +
        '<button class="cvw-btn small" type="button" data-act="reload-resources">' + IC.refresh + '<span>重试</span></button></div>';
      if (res.state !== 'ready') return '<div class="cvw-pick" data-state="idle">' + head + '<p class="cvw-hint">展开表单后自动加载。</p></div>';
      var items = kind === 'key' ? res.keys : res.creds;
      if (!items.length) return '<div class="cvw-pick" data-state="empty">' + head +
        '<p class="cvw-hint">' + (kind === 'key' ? '保险库里还没有密钥。' : '保险库里还没有凭证。') + '</p></div>';
      var rows = items.map(function (it) {
        var name = kind === 'key'
          ? it.name + (it.platform ? ' · ' + it.platform : '') + (it.masked ? ' ·' + it.masked : '')
          : it.title + (it.username ? ' · ' + it.username : '');
        return '<label class="cvw-pick-item"><input type="checkbox" data-res data-kind="' + kind + '" data-val="' + it.id + '"' +
          (picked.indexOf(it.id) !== -1 ? ' checked' : '') + dis + '>' +
          '<span class="cvw-pick-id cvw-mono">' + it.id + '</span>' +
          '<span class="cvw-pick-name">' + esc(name) + '</span></label>';
      }).join('');
      return '<div class="cvw-pick" data-state="ready"' + (enabled ? '' : ' data-off="1"') + '>' + head +
        '<div class="cvw-pick-acts">' +
          '<button class="cvw-btn small ghost" type="button" data-act="select-all" data-group="' + kind + '"' + dis + '>全选</button>' +
          '<button class="cvw-btn small ghost" type="button" data-act="clear-all" data-group="' + kind + '"' + dis + '>清空</button>' +
        '</div><div class="cvw-pick-list">' + rows + '</div>' +
        (enabled ? '' : '<p class="cvw-hint">' + (locked ? '保险库未解锁。' : '没勾选这一类的作用域，勾了资源也不会进令牌。') + '</p>') +
        '</div>';
    }

    function ttlOptions(cur) {
      return TTL_OPTIONS.map(function (o) {
        return '<option value="' + o.seconds + '"' + (o.seconds === cur ? ' selected' : '') + '>' + o.days + ' 天</option>';
      }).join('');
    }

    // ---------- 列表 ----------
    function listView() {
      var body;
      if (state.phase === 'loading') {
        body = '<div class="cvw-loading"><span class="cvw-spin"></span><span>正在读取令牌…</span></div>';
      } else if (state.phase === 'error') {
        var e = state.err || { kind: 'server', message: '', retryAfterMs: 0 };
        var h = e.kind === 'net' ? '连不上本地服务' : e.kind === 'rate' ? '请求过于频繁（429）' : '读取失败（' + esc(String(e.kind)) + '）';
        body = '<div class="cvw-state" data-tone="danger" role="alert"><div class="cvw-state-ico">' + IC.alert + '</div>' +
          '<h3>' + h + '</h3><p>' + esc(e.message || '') + (e.kind === 'rate' ? ' ' + retryText(e.retryAfterMs) : '') + '</p>' +
          '<button class="cvw-btn" type="button" data-act="reload">' + IC.refresh + '<span>重试</span></button></div>';
      } else if (state.phase === 'locked') {
        body = '<div class="cvw-state" data-tone="muted"><div class="cvw-state-ico">' + IC.lock + '</div>' +
          '<h3>列表未读取</h3><p>这里空着是因为保险库锁着，不代表一把令牌都没签过。</p></div>';
      } else if (!state.tokens.length) {
        body = '<div class="cvw-state" data-tone="muted"><div class="cvw-state-ico">' + IC.key + '</div>' +
          '<h3>还没有签发过令牌</h3>' +
          '<p>本机每个消费者现在都共用保险库口令。先只给某一两个消费者签一把窄权限令牌，验证它们还能干活，再逐个替换。</p></div>';
      } else {
        body = '<div class="cvw-list" role="list">' + state.tokens.map(rowHtml).join('') + '</div>';
      }
      return '<section class="cvw-panel" aria-label="已签发的令牌">' +
        '<div class="cvw-panel-head"><h3>已签发</h3><span class="cvw-count">' + state.tokens.length + ' 把</span></div>' + body + '</section>';
    }

    function rowHtml(t) {
      var st = tokenStatus(t);
      var res = resourceSummary(t, state.res);
      var chips = '<div class="cvw-chips">' + (t.scopes.length
        ? t.scopes.map(function (s) {
            var help = SCOPE_HELP[s] || (SCOPE_FIELD[s] ? '未识别的作用域' : '未识别的作用域');
            return '<span class="cvw-chip cvw-mono" title="' + esc(help) + '">' + esc(s) + '</span>';
          }).join('')
        : '<span class="cvw-chip" data-empty="1">无作用域</span>') + '</div>';
      var exp = relUntil(t.expiresAt);
      /* 已吊销的那把也要看得见最后一次调用：审计线不该被状态盖掉 */
      var recent = t.lastUsedAt ? ('最近使用 ' + relSince(t.lastUsedAt) + ' · ' + fmtDateTime(t.lastUsedAt)) : '最近使用 尚未调用过';
      var audit = t.revoked ? (recent + ' · 吊销于 ' + fmtDateTime(t.revokedAt)) : recent;
      var confirming = state.confirm && state.confirm.tid === t.tid;
      return '<article class="cvw-row" role="listitem" data-status="' + st.key + '"' + (confirming ? ' data-confirming="1"' : '') + '>' +
        '<div class="cvw-row-head">' +
          '<h4 class="cvw-row-label">' + esc(t.label || '（无名）') + '</h4>' +
          '<span class="cvw-badge" data-status="' + st.key + '">' + st.cn + '</span>' +
          '<div class="cvw-spacer"></div>' +
          '<button class="cvw-btn danger small" type="button" data-act="revoke" data-tid="' + esc(t.tid) + '"' +
            (t.revoked || state.busyTid ? ' disabled' : '') + '>' + IC.trash + '<span>吊销</span></button>' +
        '</div>' + chips +
        '<dl class="cvw-meta">' +
          metaItem('指纹', (t.fingerprint || '—').slice(0, 8), 'cvw-mono') +
          metaItem('到期', fmtDateTime(t.expiresAt) + (exp ? '（' + exp + '）' : ''), '') +
          metaItem('签发', fmtDateTime(t.issuedAt), '') +
          metaItem('资源', res.text, '') +
          metaItem('审计', audit, t.lastUsedAt && !t.revoked ? 'cvw-audit' : '') +
        '</dl>' +
        (res.names ? '<p class="cvw-res-names">' + esc(res.names) + '</p>' : '') +
        (confirming ? confirmBand(t) : '') +
        '</article>';
    }

    function metaItem(k, v, cls) {
      return '<div class="cvw-meta-item"><dt>' + esc(k) + '</dt><dd class="' + cls + '">' + esc(v) + '</dd></div>';
    }

    function confirmBand(t) {
      var busy = state.busyTid === t.tid;
      return '<div class="cvw-confirm" role="alertdialog" aria-label="确认吊销">' + IC.alert +
        '<span class="cvw-confirm-txt">确认吊销「' + esc(t.label || t.tid) + '」？该令牌立即失效，且不可撤销。</span>' +
        '<div class="cvw-spacer"></div>' +
        '<button class="cvw-btn ghost small" type="button" data-act="revoke-cancel">' + IC.x + '<span>取消</span></button>' +
        '<button class="cvw-btn solid-danger small" type="button" data-act="revoke-confirm" data-tid="' + esc(t.tid) + '"' +
          (state.busyTid ? ' disabled' : '') + '>' + (busy ? '吊销中…' : '确认吊销') + '</button></div>';
    }

    // ---------- 局部更新：打字时不整屏重绘，否则光标会跳 ----------
    function syncLabelCount() {
      var el = mountPoint.querySelector('[data-count-label]');
      if (!el) return;
      var n = String(state.draft.label || '').length;
      el.textContent = n + ' / ' + MAX_LABEL;
      el.setAttribute('data-over', n > MAX_LABEL ? '1' : '0');
    }
    function syncCounters() {
      var d = state.draft;
      /* 合计那条按「真正会进令牌的」数——它对着的是上限和签发结果；
         每一类各自的「已选」说的是这个列表里勾了几个，忽略态下仍是原样。 */
      var eff = effectiveIds(d);
      var total = eff.keyIds.length + eff.credIds.length;
      var res = mountPoint.querySelector('[data-count-res]');
      if (res) {
        res.textContent = '已选 ' + total + ' / 上限 ' + MAX_RESOURCE;
        res.setAttribute('data-over', total > MAX_RESOURCE ? '1' : '0');
      }
      var k = mountPoint.querySelector('[data-count-key]');
      if (k) k.textContent = '已选 ' + d.keyIds.length + ' / 共 ' + state.res.keys.length;
      var c = mountPoint.querySelector('[data-count-cred]');
      if (c) c.textContent = '已选 ' + d.credIds.length + ' / 共 ' + state.res.creds.length;
    }
    function syncTtlNote() {
      var el = mountPoint.querySelector('[data-ttl-note]');
      if (!el) return;
      var secs = Number(state.draft.ttl) || TTL_DEFAULT;
      var hit = TTL_OPTIONS.filter(function (o) { return o.seconds === secs; })[0];
      el.textContent = (hit ? hit.days + ' 天 = ' + spanText(secs * 1000) : '自定义 ' + spanText(secs * 1000)) +
        '；到点自动失效，服务端按 ' + MIN_TTL + ' 秒 ~ ' + (MAX_TTL / 86400) + ' 天夹取。';
    }

    return {
      destroy: destroy,
      refresh: function () { loadTokens(); },
      /* 明文令牌只报「在不在」，内容一律不外带 */
      getState: function () {
        var s = shallowMerge(state, {});
        s.pendingTokenPresent = !!pending;
        delete s.note;
        return s;
      },
      version: VERSION
    };
  }

  // =========================================================================
  // 内置假 fetch：后端并行开发中，两文件落地当天就能手工验收
  // CONSUMER_MOCK.setMode('normal'|'empty'|'423'|'429'|'error')
  // =========================================================================
  var MOCK = (function () {
    var mode = 'normal';
    var now = Date.now();
    function iso(ms) { return new Date(ms).toISOString(); }
    var rows = [
      { tid: 'a1b2c3d4e5f60718293a4b5c', fingerprint: '9f2c1a77', label: 'claude-code', scopes: ['key:read'], keyIds: [1, 2], credIds: [], resourceCount: 2, issuedAt: iso(now - 2 * 864e5), expiresAt: iso(now + 28 * 864e5), expired: false, revoked: false, revokedAt: null, lastUsedAt: iso(now - 45e3) },
      { tid: 'deadbeefdeadbeefdeadbeef', fingerprint: '10a4f3bb', label: '余额巡检 cron', scopes: ['balance:read', 'key:test'], keyIds: [3], credIds: [], resourceCount: 1, issuedAt: iso(now - 40 * 864e5), expiresAt: iso(now - 10 * 864e5), expired: true, revoked: false, revokedAt: null, lastUsedAt: iso(now - 12 * 864e5) },
      { tid: 'ffffffffffffffffffffffff', fingerprint: '77c0ffee', label: '旧 agent 框架', scopes: ['cred:read'], keyIds: [], credIds: [4, 7], resourceCount: 2, issuedAt: iso(now - 60 * 864e5), expiresAt: iso(now + 30 * 864e5), expired: false, revoked: true, revokedAt: iso(now - 5 * 864e5), lastUsedAt: null }
    ];
    function res(status, body) {
      return Promise.resolve({ ok: status >= 200 && status < 300, status: status, json: function () { return Promise.resolve(body); } });
    }
    function fetchMock(url, init) {
      init = init || {};
      var method = (init.method || 'GET').toUpperCase();
      var u = String(url);
      if (mode === '423') return res(423, { error: '保险库未解锁' });
      if (mode === '429') return res(429, { error: '令牌操作过于频繁', retryAfterMs: 42000 });
      if (mode === 'error') return res(500, { error: '后端返回了意料之外的东西' });
      if (u === '/api/keys' && method === 'GET') {
        return res(200, { keys: [
          { id: 1, name: 'OpenAI 生产', platform: 'openai', keyMasked: '8f2a' },
          { id: 2, name: 'Anthropic', platform: 'anthropic', keyMasked: '1c77' },
          { id: 3, name: 'DeepSeek 备用', platform: 'deepseek', keyMasked: '44be' }
        ] });
      }
      if (u === '/api/credentials' && method === 'GET') {
        return res(200, { credentials: [{ id: 4, title: 'GitHub PAT', username: 'yqq-bot' }, { id: 7, title: 'AWS 控制台', username: 'ops@corp' }] });
      }
      if (u === '/api/consumer/tokens' && method === 'GET') {
        return res(200, { tokens: mode === 'empty' ? [] : rows.map(function (r) { return Object.assign({}, r); }) });
      }
      if (u === '/api/consumer/tokens' && method === 'POST') {
        var b = {}; try { b = JSON.parse(init.body || '{}'); } catch (e) {}
        if (!Array.isArray(b.scopes) || !b.scopes.length) return res(400, { error: 'scopes 不能为空：没有作用域的令牌等于废令牌' });
        if (!b.label || !String(b.label).trim()) return res(400, { error: 'label 不能为空' });
        if (String(b.label).length > 40) return res(400, { error: 'label 最长 40 字符，当前 ' + String(b.label).length });
        var ttl = Number(b.ttlSeconds) || 2592000;
        var rec = {
          tid: 'tid' + Date.now(), fingerprint: 'fp' + rows.length + '0x7c', label: String(b.label),
          scopes: b.scopes, keyIds: b.keyIds || [], credIds: b.credIds || [],
          resourceCount: (b.keyIds || []).length + (b.credIds || []).length,
          issuedAt: iso(Date.now()), expiresAt: iso(Date.now() + ttl * 1000),
          expired: false, revoked: false, revokedAt: null, lastUsedAt: null
        };
        rows.unshift(rec);
        var out = Object.assign({}, rec);
        delete out.expired; delete out.revoked; delete out.revokedAt; delete out.lastUsedAt;
        out.token = 'v1.eyJ0aWQiOiInICsgcmVjLnRpZCArICInfQ.sig' + Date.now() + 'abc';
        out.ttlSeconds = ttl;
        return res(201, out);
      }
      var m = u.match(/^\/api\/consumer\/tokens\/([^/]+)\/revoke$/);
      if (m && method === 'POST') {
        var tid = decodeURIComponent(m[1]);
        var hit = rows.filter(function (r) { return r.tid === tid; })[0];
        if (!hit) return res(400, { error: '未知令牌：' + tid });
        hit.revoked = true; hit.revokedAt = iso(Date.now());
        return res(200, { ok: true, tid: tid, revokedAt: hit.revokedAt, tokens: rows.map(function (r) { return Object.assign({}, r); }) });
      }
      return res(404, { error: 'not found' });
    }
    fetchMock.setMode = function (m) { mode = m; };
    fetchMock.reset = function () { mode = 'normal'; };
    return fetchMock;
  })();

  // =========================================================================
  // 导出（classic script -> window；node require 兜底）
  // =========================================================================
  var API = {
    version: VERSION,
    mountConsumerView: mountConsumerView,
    CONSUMER_MOCK: MOCK,
    SCOPES: SCOPES,
    SCOPE_FIELD: SCOPE_FIELD,
    SCOPE_HELP: SCOPE_HELP,
    MAX_LABEL: MAX_LABEL,
    MAX_RESOURCE: MAX_RESOURCE,
    MIN_TTL_SECONDS: MIN_TTL,
    MAX_TTL_SECONDS: MAX_TTL,
    DEFAULT_TTL_SECONDS: TTL_DEFAULT,
    TTL_OPTIONS: TTL_OPTIONS,
    __internals: {
      esc: esc, classifyStatus: classifyStatus, parseTokens: parseTokens, parseKeys: parseKeys,
      parseCredentials: parseCredentials, relUntil: relUntil, relSince: relSince, spanText: spanText,
      fmtDateTime: fmtDateTime, retryText: retryText, tokenStatus: tokenStatus, ids: ids,
      curlExampleLines: curlExampleLines, scopeGroups: scopeGroups, resourceSummary: resourceSummary,
      effectiveIds: effectiveIds,
      /* 界面里硬抄了一份后端的额度常量（注释写着来源，来源不会自己来对账）。
         单独导出是为了让 test/consumer-view.test.js 逐条比对——改了后端不红，
         就是界面允许用户填一个服务端必拒的值。 */
      limits: { SCOPES: SCOPES, MAX_LABEL: MAX_LABEL, MAX_RESOURCE: MAX_RESOURCE,
        MIN_TTL: MIN_TTL, MAX_TTL: MAX_TTL, TTL_DEFAULT: TTL_DEFAULT }
    }
  };
  global.ConsumerView = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
