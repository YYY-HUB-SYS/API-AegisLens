/*
  credentials-view.js — 「凭证保险库」视图模块（本地优先 AI API Key 工具）
  ============================================================================
  原生 DOM，零框架 / 零构建 / 零 npm / 零 CDN。以「新增两文件 + 未来 2 行」方式
  接入单页应用，绝不改动 app/public/index.html（图标 sprite 那条道正在改写它）。

  接入（落到 index.html，恰好 2 行；宿主已声明 JetBrains Mono 与主题 token）：
    <link rel="stylesheet" href="/credentials-view.css">
    <script src="/credentials-view.js"></script>
  之后在目标容器上一行挂载：
    CredentialsView.mountCredentialsView(document.querySelector('#vault'), { fetchImpl });

  单一入口：mountCredentialsView(rootEl, opts) -> { destroy(), refresh(), getState() }
    opts: {
      fetchImpl        : 注入的 fetch（默认取全局 fetch；自测传 CV_MOCK）
      needsSetup       : boolean，显式首开(设口令) / 回归(解锁)。缺省时探测状态端点
      unlock           : async (password, {setup}) => {ok, recoveryCode?, error?, status?}
      endpoints        : 覆盖端点表（解锁/初始化类端点契约未列举，可按后端对齐）
      overdueDays      : 健康页"超期未换"阈值，默认 180
      revealHoldMs     : 明文显示自动收回毫秒，默认 30000
      onStatus         : (status)=>void 外部钩子
    }

  ---- 后端契约（严格按此，不自创密文字段）----
    GET  /api/credentials              -> {credentials:[…]}，每项 id,title,username,url,folder,tags,
        createdAt,updatedAt,lastUsedAt,hasPassword,hasSecret,hasTotp,hasNote
        （不是裸数组——按裸数组解析就是一条都不剩，而且不报错）
        未解锁 -> 423 {error:'保险库未解锁'}
    POST /api/credentials/:id/reveal   -> {password,secret,note,totpSecret,id,title,username,url,lastUsedAt}
        （唯一明文出口，可 423/429；secret 是 API 私钥类凭证，那一类没有 password，
          行标签写的是「密钥」——渲染层漏掉它，点显示就真的没反应。）
    GET  /api/credentials/:id/totp     -> {code,secondsRemaining,digits,step,algorithm}
        环形进度按 step（秒）算，别按 30 硬编码：粘进来的 otpauth URI 可以带 period=60/90。
    GET  /api/credentials/health       -> 复用清单 + 弱口令计数，不含口令内容
    POST/PUT/DELETE /api/credentials   -> 写操作；必须同源 Origin
        注：Origin 是浏览器 forbidden header，JS 无法伪造；fetch 默认 credentials:
        'same-origin' + 非 GET 方法即由浏览器自动附带同源 Origin。本模块不手动塞 Origin。
    站点口令规则：契约未列举端点。编辑带 url 的凭证时 best-effort GET
        /api/credentials/:id/password-policy；拿不到/非 2xx -> 按默认规则生成（"拿不到按默认"）。
    解锁/初始化/恢复码端点契约未列举 -> 见 EP.vault*，可经 opts.endpoints 或 opts.unlock 覆盖。

  ---- 六态硬要求：每态确定呈现，绝不"转圈永远不停"----
    空态 / 加载 / 错误(423 未解锁 · 429 限流 · 5xx · 网络) / 未解锁 / 恢复码 / 已解锁。

  ---- 安全红线（实现约束）----
    · 主口令 / 恢复码 / 揭示的明文：仅驻内存，绝不写 localStorage/sessionStorage/indexedDB。
    · 恢复码只渲染在恢复屏那个唯一的 code-box 里，别处不出现、不落存储；离开该屏即清内存。
    · 切走标签页(document.hidden) 立即收回所有明文并暂停 totp 轮询。
    · 口令输入框 autocomplete="new-password"/"off"、spellcheck=false，不参与自动填充/历史。

  ---- 手工验收（不依赖后端；用内置假 fetch）----
    应用本身免密启动时主界面已有真数据可看；要用假数据逐态逼出，另起服务
    （cd app && node server.js），浏览器打开 index.html 后在控制台执行：
        CredentialsView.mountCredentialsView(document.body.firstElementChild,
            { fetchImpl: CredentialsView.CV_MOCK, needsSetup: true })
      临时 test.html 那种写法也行，但那是会被 git 看见的文件，验完就删，别留在 public/。
      → 依次验：设主口令(二次确认) → 恢复码屏(勾选才能继续) → 列表/卡片(掩码/显示/30s 收回、
        hasTotp 环形倒计时、切标签页收回) → 新增/编辑 + 生成器 → 健康页(复用/弱/超期 +
        空态/加载/错误)。用 CV_MOCK.setMode('423'|'429'|'5xx'|'empty'|'locked') 可逐一逼出各态。

  ---- 已经实跑到什么程度（写了就得是真做过）----
    · node --check 语法校验：跑过。
    · 纯逻辑单测（test/credentials-view.test.js）：转义 / 状态归类 / 429 文案 / 口令生成的
      CSPRNG 分布与约束 / 站点规则夹取 / 健康归一化 / 超期 / 编辑提交体 / 挂载-卸载生命周期
      （用一个最小 DOM 桩在 node 里真跑 mount+destroy）。
    · 真浏览器对着活服务：编辑只改标题时 PUT 体不含 password/note 两键、reveal 回来的口令与
      备注原样还在、390px 窄屏不横向溢出（这几条是那样抓出来的：测试全绿而数据在丢）。
    · 仍未系统走过：上面那套六态逐一逼出、剪贴板、焦点陷阱。别把这段当已验。
  ============================================================================
*/
(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  // ---- 端点表（可经 opts.endpoints 浅合并覆盖）----
  var EP = {
    list: '/api/credentials',
    reveal: function (id) { return '/api/credentials/' + encodeURIComponent(id) + '/reveal'; },
    totp: function (id) { return '/api/credentials/' + encodeURIComponent(id) + '/totp'; },
    health: '/api/credentials/health',
    create: '/api/credentials',
    update: function (id) { return '/api/credentials/' + encodeURIComponent(id); },
    remove: function (id) { return '/api/credentials/' + encodeURIComponent(id); },
    policy: function (id) { return '/api/credentials/' + encodeURIComponent(id) + '/password-policy'; },
    // 契约未列举的金库控制端点——best-effort，可被 opts.unlock / opts.endpoints 替换：
    vaultStatus: '/api/vault/status',
    vaultUnlock: '/api/vault/unlock',
    vaultInit: '/api/vault/init',
    vaultLock: '/api/vault/lock',
    vaultDiscard: '/api/vault/discard-master-key'
  };

  var CONFOUNDABLES = 'Il1O0oB8S5Z2tvwy'; // 排除的易混字符
  var OVERDUE_DAYS_DEFAULT = 180;
  var REVEAL_HOLD_DEFAULT = 30000;

  // =========================================================================
  // 纯工具（不依赖 DOM；node 可直接调用做单测）
  // =========================================================================
  var ENT_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) { return ENT_MAP[c]; });
  }

  function safeJson(res) {
    if (!res || typeof res.json !== 'function') return Promise.resolve(null);
    return res.json().catch(function () { return null; });
  }

  // HTTP 状态归类为视图语义态
  function classifyStatus(status, data) {
    var msg = (data && (data.error || data.message)) || '';
    if (status >= 200 && status < 300) return { kind: 'ok', message: '' };
    if (status === 423) return { kind: 'locked', message: msg || '保险库未解锁' };
    if (status === 429) return { kind: 'rate', message: msg || '操作过于频繁，请稍候再试', retryAfterMs: retryMsOf(data) };
    if (status === 401 || status === 403) return { kind: 'locked', message: msg || '口令不正确或会话失效' };
    if (status === 404) return { kind: 'notfound', message: msg || '未找到该资源' };
    if (status >= 500) return { kind: 'server', message: msg || '服务暂时不可用（' + status + '）' };
    if (!status) return { kind: 'net', message: msg || '无法连接本地保险库服务' };
    return { kind: 'client', message: msg || ('请求失败（' + status + '）') };
  }

  /* 429 的等待时长只在响应体里（retryAfterMs），不在这里捞出来，界面就剩一句
     「稍后再试」——人会连着点，每点一次又把窗口往后推。姊妹模块 consumer-view 已经这么做了。 */
  function retryMsOf(data) {
    return data && typeof data.retryAfterMs === 'number' && data.retryAfterMs > 0 ? data.retryAfterMs : 0;
  }
  function retryText(ms) { return '请 ' + Math.max(1, Math.ceil((ms || 0) / 1000)) + ' 秒后再试。'; }
  function rateMessage(cls, fallback) {
    var m = (cls && cls.message) || fallback || '';
    if (cls && cls.kind === 'rate' && cls.retryAfterMs > 0) m = m + ' ' + retryText(cls.retryAfterMs);
    return m;
  }

  function isErrClass(kind) { return kind === 'locked' || kind === 'rate' || kind === 'server' || kind === 'net'; }

  // 列表归一化：只接受契约字段，密文一律忽略
  function parseList(data) {
    /* 后端列表回 {credentials:[...]}；只认 items 的话会静默渲染成空列表——
       不报错、不转圈，就是什么都没有，这类契约错位最难发现 */
    var arr = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items
      : (data && Array.isArray(data.credentials) ? data.credentials : null));
    if (!arr) return [];
    return arr.map(function (it) {
      it = it || {};
      return {
        id: it.id != null ? String(it.id) : (it._id != null ? String(it._id) : ''),
        title: str(it.title),
        username: str(it.username),
        url: str(it.url),
        folder: str(it.folder),
        tags: Array.isArray(it.tags) ? it.tags.map(str) : (it.tags ? [str(it.tags)] : []),
        createdAt: it.createdAt || null,
        updatedAt: it.updatedAt || null,
        lastUsedAt: it.lastUsedAt || null,
        hasPassword: !!it.hasPassword,
        hasSecret: !!it.hasSecret,
        hasTotp: !!it.hasTotp,
        hasNote: !!it.hasNote
      };
    }).filter(function (x) { return x.id; });
  }
  function str(v) { return v === null || v === undefined ? '' : String(v); }

  // 口令强度熵位（无外部库）
  function strengthBits(pw) {
    if (!pw) return { bits: 0, label: '空', tone: 'danger' };
    var set = 0;
    if (/[a-z]/.test(pw)) set += 26;
    if (/[A-Z]/.test(pw)) set += 26;
    if (/[0-9]/.test(pw)) set += 10;
    if (/[^A-Za-z0-9]/.test(pw)) set += 32;
    var bits = pw.length * (set > 0 ? Math.log2(set) : 1);
    if (bits < 40) return { bits: bits, label: '偏弱', tone: 'danger' };
    if (bits < 60) return { bits: bits, label: '中等', tone: 'warn' };
    if (bits < 90) return { bits: bits, label: '良好', tone: 'ok' };
    return { bits: bits, label: '很强', tone: 'ok' };
  }

  // CSPRNG（crypto 缺失时回退 Math.random——仅用于展示，注释标明）
  function randInt(max) {
    if (max <= 0) return 0;
    var c = global.crypto || global.msCrypto;
    if (c && typeof c.getRandomValues === 'function') {
      var buf = new Uint32Array(1);
      var limit = Math.floor(4294967296 / max) * max; // 拒绝采样消除模偏差
      var v;
      do { c.getRandomValues(buf); v = buf[0]; } while (v >= limit);
      return v % max;
    }
    return Math.floor(Math.random() * max); // 回退：非加密安全，仅无 crypto 环境下兜底
  }

  var CHARSETS = {
    upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
    lower: 'abcdefghijkmnopqrstuvwxyz',
    digit: '23456789',
    symbol: '!@#$%^&*-_=+[]{}()'
  };
  var FULL = {
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower: 'abcdefghijklmnopqrstuvwxyz',
    digit: '0123456789',
    symbol: '!@#$%^&*()-_=+[]{};:,.<>?'
  };

  // 生成口令：opts {length,upper,lower,digit,symbol,noConfusable,min,max,forceClasses}
  function generatePassword(opts) {
    opts = opts || {};
    var lo = 8, hi = 64;
    if (opts.min) lo = opts.min;
    if (opts.max) hi = Math.min(hi, opts.max);
    var len = clamp((opts.length == null ? 20 : opts.length), lo, hi);
    var noConf = opts.noConfusable !== false; // 默认排除易混
    var poolSets = [];
    var classes = [];
    ['upper', 'lower', 'digit', 'symbol'].forEach(function (k) {
      if (opts[k]) {
        var base = noConf ? CHARSETS[k] : FULL[k];
        poolSets.push(base); classes.push(k);
      }
    });
    if (!poolSets.length) { poolSets = [CHARSETS.lower, CHARSETS.upper, CHARSETS.digit]; classes = ['lower', 'upper', 'digit']; }
    var pool = poolSets.join('');
    var out = [];
    // 保证每类至少一个
    poolSets.forEach(function (s) { out.push(s.charAt(randInt(s.length))); });
    while (out.length < len) out.push(pool.charAt(randInt(pool.length)));
    // Fisher-Yates 洗牌
    for (var i = out.length - 1; i > 0; i--) { var j = randInt(i + 1); var t = out[i]; out[i] = out[j]; out[j] = t; }
    if (opts.forceClasses === false) { /* 保留至少一类的默认行为 */ }
    return out.slice(0, len).join('');
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // 站点规则：把后端策略对象夹取成本地可用配置；拿不到 -> 默认
  function applyPolicy(base, policy) {
    var cfg = {
      length: base.length || 20, min: 8, max: 64,
      upper: base.upper !== false, lower: true, digit: true, symbol: true,
      noConfusable: base.noConfusable !== false, source: 'default'
    };
    if (policy && typeof policy === 'object') {
      cfg.source = 'site';
      if (typeof policy.minLength === 'number') cfg.min = policy.minLength;
      if (typeof policy.maxLength === 'number') cfg.max = policy.maxLength;
      if (typeof policy.length === 'number') cfg.length = policy.length;
      cfg.length = clamp(cfg.length, cfg.min, cfg.max);
      if (typeof policy.requireUpper === 'boolean') cfg.upper = policy.requireUpper;
      if (typeof policy.requireLower === 'boolean') cfg.lower = policy.requireLower;
      if (typeof policy.requireDigit === 'boolean') cfg.digit = policy.requireDigit;
      if (typeof policy.requireSymbol === 'boolean') cfg.symbol = policy.requireSymbol;
      if (typeof policy.allowSymbol === 'boolean' && policy.allowSymbol === false) cfg.symbol = false;
      if (typeof policy.excludeConfusable === 'boolean') cfg.noConfusable = policy.excludeConfusable;
      cfg.note = str(policy.note || policy.message);
    } else {
      cfg.length = clamp(cfg.length, cfg.min, cfg.max);
    }
    return cfg;
  }

  function hostOf(url) {
    try { var u = new URL(url, 'http://local.placeholder'); return u.hostname.toLowerCase(); }
    catch (e) { return ''; }
  }

  // 动态码格式化：仅数字，按 digits 截尾，6 位分两组显示
  function formatCode(code, digits) {
    if (!code) return '······';
    var s = String(code).replace(/\D/g, '');
    if (digits && s.length > digits) s = s.slice(-digits);
    if (s.length === 6) return s.slice(0, 3) + ' ' + s.slice(3);
    return s || '······';
  }

  // 超期未换：updatedAt 距今 > days
  function isOverdue(updatedAt, days, now) {
    if (!updatedAt) return false;
    var t = Date.parse(updatedAt);
    if (isNaN(t)) return false;
    var nowMs = now || Date.now();
    return (nowMs - t) > days * 86400000;
  }

  // 健康归一化：契约仅保证"复用清单 + 弱口令计数"，容错多种形状 -> 规范视图
  function normalizeHealth(data) {
    var out = { reuse: [], weak: [], counts: { reuse: 0, weak: 0 }, raw: !!data };
    if (!data || typeof data !== 'object') return out;
    // 复用组
    var reuseSrc = data.reuse || data.reused || data.reuseGroups || data.passwordReuse || data.usernameReuse || null;
    if (Array.isArray(reuseSrc)) {
      out.reuse = reuseSrc.map(function (g, gi) {
        if (Array.isArray(g)) return { label: '复用组 ' + (gi + 1) + '（' + g.length + ' 处）', items: g.map(normalizeEntry) };
        if (g && typeof g === 'object') {
          var items = g.items || g.members || g.credentials || (Array.isArray(g.ids) ? g.ids : []);
          var lbl = str(g.label || g.title || g.name || g.group) || ('复用组 ' + (gi + 1));
          return { label: lbl, items: (items || []).map(normalizeEntry) };
        }
        return { label: '复用组 ' + (gi + 1), items: [] };
      }).filter(function (x) { return x.items.length > 0; });
    }
    // 弱口令
    var weakSrc = data.weak || data.weakPasswords || data.weakList || null;
    if (Array.isArray(weakSrc)) out.weak = weakSrc.map(normalizeEntry);
    else if (weakSrc && typeof weakSrc === 'object' && Array.isArray(weakSrc.items)) out.weak = weakSrc.items.map(normalizeEntry);
    // 计数（契约承诺"弱口令计数"）
    out.counts.reuse = firstNum(data.reusedUsernameCount, data.reuseCount, data.reusedCount, sumItems(out.reuse), out.reuse.length);
    out.counts.weak = firstNum(data.weakCount, data.counts && data.counts.weak, out.weak.length);
    return out;
  }
  function normalizeEntry(e) {
    if (typeof e === 'string') return { id: null, title: e };
    if (e && typeof e === 'object') return { id: e.id != null ? String(e.id) : null, title: str(e.title || e.name || e.username || e.label) || '（未命名）' };
    return { id: null, title: '（未命名）' };
  }
  function sumItems(groups) { var n = 0; groups.forEach(function (g) { n += g.items.length; }); return n; }
  function firstNum() { for (var i = 0; i < arguments.length; i++) { if (typeof arguments[i] === 'number' && !isNaN(arguments[i])) return arguments[i]; } return 0; }

  // =========================================================================
  // 图标（内联 SVG，绝不引用未合并的 sprite；均 aria-hidden）
  // =========================================================================
  var IC = {
    vault: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3.4"/><path d="M12 8.6V7M12 17v-1.6M15.4 12H17M7 12h1.6"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
    unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.8-1.2"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>',
    eyeoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l16 16M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 3.9M6.2 7.9A16.7 16.7 0 0 0 2 12s3.6 6.5 10 6.5a9.7 9.7 0 0 0 3-.46"/><path d="M9.5 10.2a2.6 2.6 0 0 0 3.6 3.7"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 6.5l3 3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="4"/><path d="M11 11l8 8M16 16l2-2M18.5 18.5l1.5-1.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-3.6-3.6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l9 15H3l9-15Z"/><path d="M12 10v4M12 16.5v.5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 16M4 20v-4h4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20L14 10M15 5l1.5-1.5M19 9l1.5-1.5M12.5 6.5L15.5 9.5"/><path d="M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 15l6-6M10.5 6.5l1.8-1.8a3.5 3.5 0 0 1 5 5L15.5 11M8.5 13l-1.8 1.8a3.5 3.5 0 0 0 5 5L13.5 18"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3L5 13h6l-1 8 8-10h-6l1-8Z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="6" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18" cy="12" r="1.7"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/></svg>'
  };

  // =========================================================================
  // 挂载：主状态机 + 渲染 + 事件委托 + 计时器
  // =========================================================================
  /* 提交体是纯函数，单独拎出来是为了能被 node 直接调用做断言——
     「编辑时没碰过的密文字段不能出现在请求体里」这条一旦写错就是静默删数据，
     不能只靠人眼看着对。后端 buildPatch 认「键缺失＝不改」，空串＝清空。 */
  function submitPayload(draft, mode, touched) {
    var t = touched || {};
    var payload = {
      title: draft.title, username: draft.username, url: draft.url,
      folder: draft.folder, tags: draft.tags
    };
    var creating = mode === 'create';
    if (creating || t.pw) payload.password = draft.password;
    if (creating || t.note) payload.note = draft.note;
    if (draft.totpSecret) payload.totpSecret = draft.totpSecret;
    return payload;
  }

  /* 口令/密钥那一行。提到模块作用域是为了能在 node 里直接对着断言——
     这一度的事故是「字段被渲染层丢掉」：请求发了、明文回来了，界面上却什么都不变，
     接口测试和肉眼都看不出来（详见函数体里那段）。 */
  function secretRowInner(c, revealed) {
    /* reveal 一条给全套明文，而 API 私钥类凭证只有 secret 没有 password（列表里那行标着「密钥」）。
       以前只读 password：点了「显示」请求真发、明文真回，界面却一个字节都不变——
       看着像按钮坏了，其实是渲染层把字段丢了。 */
    var isKeyOnly = !!(c && c.hasSecret && !c.hasPassword);
    var val = revealed ? (revealed.password || revealed.secret) : null;
    if (val) {
      return '<span class="cv-secret-val cv-revealed cv-mono">' + escapeHtml(val) + '</span>' +
        '<span class="cv-mini-acts"><button class="cv-ghost-ico" type="button" data-act="copy" data-copy="' + escapeHtml(val) + '" aria-label="复制' + (revealed.password ? '口令' : '密钥') + '">' + IC.copy + '</button></span>';
    }
    var ph = isKeyOnly ? '••••••••••••' : '••••••••';
    return '<span class="cv-redact" aria-hidden="true">' + ph + '</span>' +
      '<span class="cv-mini-acts"><button class="cv-ghost-ico" type="button" data-act="reveal" data-id="' + escapeHtml(c && c.id) + '" aria-pressed="false" aria-label="显示' + (isKeyOnly ? '密钥' : '口令') + '">' + IC.eye + '<span>显示</span></button></span>';
  }

  /* reveal 响应 → 驻内存的明文态。这一格上一轮正好漏过一次：只修了渲染层认不认 secret，
     而这里压根没把 secret 抄进来——接口 200、备注照常显示、「密钥」那一行却还是点点。
     纯函数 + 契约字段清单是为了让下一次少抄一个字段时当场红，而不是等浏览器撞见。 */
  function revealState(d) {
    var src = d || {};
    return { password: str(src.password), secret: str(src.secret), note: str(src.note), totpSecret: str(src.totpSecret) };
  }
  var REVEAL_FIELDS = ['password', 'secret', 'note', 'totpSecret'];

  function mountCredentialsView(rootEl, opts) {
    opts = opts || {};
    if (!rootEl) throw new Error('mountCredentialsView: rootEl 必需');
    var endpoints = shallowMerge(EP, opts.endpoints || {});
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(global) : null);
    if (!fetchImpl) throw new Error('mountCredentialsView: 需要 fetchImpl（浏览器 fetch 或自测传入 CV_MOCK）');
    var overdueDays = opts.overdueDays || OVERDUE_DAYS_DEFAULT;
    var revealHoldMs = opts.revealHoldMs || REVEAL_HOLD_DEFAULT;

    var state = {
      status: 'loading',          // loading | setup | unlock | recovery | unlocked
      error: null,                // {kind,message}
      gateBusy: false,
      gateErr: '',
      /* 明文 DEK 副本（master.key）在不在，由 /api/vault/status 一处报，界面不猜 */
      securityOpen: false,
      rawKeyPresent: null,        // null = 还没读到
      discardBusy: false,
      discardErr: '',
      list: [],
      listState: 'idle',          // idle|loading|ready|error
      listErr: null,
      reveal: {},                 // id -> {password,note,totpSecret}  明文仅内存
      revealMeta: {},             // id -> {until}
      totp: {},                   // id -> {code,secondsRemaining,digits,period,error,loading}
      activeTab: 'list',
      health: { status: 'idle', data: null, norm: null, err: null, overdue: [] },
      filters: { q: '', folder: '', tag: '' },
      modal: null,                // {mode,id,draft,gen,policy,policyState,genErr,saveErr,saving}
      lastFocus: null,
      recoveryCode: null          // 仅恢复屏内存持有
    };

    // 单一容器：root 永不整体替换（委托监听持久）
    rootEl.classList.add('cv-root');
    rootEl.setAttribute('data-cv-module', 'credentials');
    var mountPoint = document.createElement('div');
    mountPoint.className = 'cv-mount';
    rootEl.appendChild(mountPoint);

    var timers = { reveal: {}, tick: null };
    var api = makeApi(fetchImpl, endpoints);
    /* destroy() 承诺能拆干净。委托监听一律走 bind() 登记，别靠"记得写一条 removeEventListener"
       ——这条线以前就是靠记的，6 条里一条都没记，拆完再挂载同一个 root 会双份触发。 */
    var bindings = [];
    function bind(el, type, fn) { el.addEventListener(type, fn); bindings.push([el, type, fn]); }

    // ---------- 生命周期 ----------
    function destroy() {
      Object.keys(timers.reveal).forEach(clearRevealTimer);
      if (timers.tick) clearInterval(timers.tick);
      bindings.forEach(function (b) { b[0].removeEventListener(b[1], b[2]); });
      bindings.length = 0;
      document.removeEventListener('visibilitychange', onVisibility);
      mountPoint.innerHTML = '';
      rootEl.classList.remove('cv-root');
    }

    // ---------- 初始状态解析（确定态，绝不无限 loading） ----------
    (function boot() {
      document.addEventListener('visibilitychange', onVisibility);
      resolveInitial();
      render();
    })();

    function resolveInitial() {
      state.error = null;
      if (typeof opts.needsSetup === 'boolean') {
        state.status = opts.needsSetup ? 'setup' : 'unlock';
        if (state.status === 'unlock') { /* 锁定预览渲染占位 */ }
        return;
      }
      if (!endpoints.vaultStatus) { state.status = 'unlock'; return; }
      api.get(endpoints.vaultStatus).then(function (r) {
        state.passphraseSet = !!(r.ok && r.data && r.data.passphraseSet);
        if (r.ok && r.data && typeof r.data.rawKeyPresent === 'boolean') state.rawKeyPresent = r.data.rawKeyPresent;
        state.sessionMode = (r.ok && r.data && r.data.mode) || null;
        if (r.ok && r.data && (r.data.needsSetup === true || r.data.setup === false)) state.status = 'setup';
        else if (r.ok && (r.data && r.data.unlocked === true)) { state.status = 'unlocked'; afterUnlock(); }
        else if (r.classify.kind === 'locked') state.status = 'unlock';
        else state.status = 'unlock';
        render();
      }).catch(function () { state.status = 'unlock'; render(); });
    }

    function afterUnlock() {
      loadList();
      startTotpLoop();
    }

    // ---------- API 封装 ----------
    function makeApi(f, epi) {
      function handle(res) {
        return safeJson(res).then(function (data) {
          return { ok: res.ok, status: res.status, data: data, classify: classifyStatus(res.status, data) };
        });
      }
      function fail(err) { return { ok: false, status: 0, data: null, classify: classifyStatus(0, { error: (err && err.message) || '' }) }; }
      return {
        get: function (url) { return f(url, { method: 'GET', credentials: 'same-origin', headers: { 'Accept': 'application/json' } }).then(handle, fail); },
        // 写操作：不手动塞 Origin（浏览器对 same-origin 非 GET 自动附带）
        send: function (method, url, body) {
          var init = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
          if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
          return f(url, init).then(handle, fail);
        }
      };
    }

    // ---------- 列表 / 健康 / totp 加载 ----------
    function loadList() {
      state.listState = 'loading'; state.listErr = null; render();
      api.get(endpoints.list).then(function (r) {
        if (r.classify.kind === 'locked') { lockOut(r.classify); return; }
        if (!r.ok) { state.listState = 'error'; state.listErr = r.classify; render(); return; }
        state.list = parseList(r.data);
        state.listState = 'ready';
        primeTotp();
        render();
      });
    }

    function loadHealth() {
      state.health.status = 'loading'; state.health.err = null; render();
      api.get(endpoints.health).then(function (r) {
        if (r.classify.kind === 'locked') { lockOut(r.classify); return; }
        if (!r.ok) { state.health.status = 'error'; state.health.err = r.classify; render(); return; }
        state.health.data = r.data;
        state.health.norm = normalizeHealth(r.data);
        state.health.overdue = state.list.filter(function (c) { return isOverdue(c.updatedAt, overdueDays); });
        state.health.status = 'ready';
        render();
      });
    }

    function primeTotp() {
      if (state.status !== 'unlocked') return;
      state.list.forEach(function (c) {
        if (c.hasTotp && !state.totp[c.id]) fetchTotp(c.id);
      });
    }
    function fetchTotp(id) {
      if (state.status !== 'unlocked') return;
      var prev = state.totp[id] || {};
      state.totp[id] = { code: prev.code || null, secondsRemaining: prev.secondsRemaining || 0, digits: prev.digits || 6, period: prev.period || 30, loading: true, error: null };
      api.get(endpoints.totp(id)).then(function (r) {
        if (r.classify.kind === 'locked') { lockOut(r.classify); return; }
        var d = r.data || {};
        if (!r.ok) { state.totp[id] = { code: null, secondsRemaining: 0, digits: d.digits || 6, period: prev.period || 30, loading: false, error: r.classify }; syncTotpCells(); renderIfUnlocked(); return; }
        var sec = typeof d.secondsRemaining === 'number' ? d.secondsRemaining : 0;
        /* 周期以服务端给的 step 为准：粘进来的 otpauth URI 可以带 period=60/90，
           环形进度按硬编码 30 秒算会让这类记录一直是「半圈」——数字对、圈不对，最误导人。
           后端没给（老数据/别的实现）才退回观测到的最大值。 */
        var step = typeof d.step === 'number' && d.step > 0 ? d.step : Math.max(sec, 1, 30);
        state.totp[id] = { code: d.code || '——————', secondsRemaining: sec, digits: d.digits || 6, period: step, loading: false, error: null };
        syncTotpCells();
      });
    }

    // 1s tick：本地递减，到点重取；切走标签页不跑
    function startTotpLoop() {
      if (timers.tick) return;
      timers.tick = setInterval(function () {
        if (state.status !== 'unlocked' || document.hidden) return;
        var any = false;
        Object.keys(state.totp).forEach(function (id) {
          var cell = state.totp[id];
          if (!cell || cell.loading) return;
          any = true;
          cell.secondsRemaining -= 1;
          if (cell.secondsRemaining <= 0) { fetchTotp(id); }
        });
        if (any) syncTotpCells();
      }, 1000);
    }

    // ---------- 揭示口令 ----------
    function reveal(id) {
      if (state.reveal[id]) { hideReveal(id); return; }
      api.send('POST', endpoints.reveal(id), {}).then(function (r) {
        if (r.classify.kind === 'locked') { lockOut(r.classify); return; }
        if (r.classify.kind === 'rate') { toast(rateMessage(r.classify, '揭示过于频繁，请稍候'), 'danger'); return; }
        if (!r.ok) { toast(rateMessage(r.classify, '无法显示口令'), 'danger'); return; }
        var d = r.data || {};
        state.reveal[id] = revealState(d);
        paintSecretCell(id);
        var hold = setTimeout(function () { hideReveal(id); }, revealHoldMs);
        timers.reveal[id] = hold;
      });
    }
    function hideReveal(id) { delete state.reveal[id]; if (timers.reveal[id]) { clearTimeout(timers.reveal[id]); delete timers.reveal[id]; } paintSecretCell(id); }
    function clearRevealTimer(id) { if (timers.reveal[id]) { clearTimeout(timers.reveal[id]); delete timers.reveal[id]; } }

    // ---------- 锁定收回（423 / 手动锁 / 切标签页）----------
    function lockOut(errCls) {
      Object.keys(state.reveal).forEach(clearRevealTimer);
      state.reveal = {}; state.revealMeta = {}; state.totp = {}; state.list = []; state.recoveryCode = null;
      state.status = 'unlock';
      state.error = errCls && errCls.kind ? errCls : null;
      state.listState = 'idle';
      if (state.modal) closeModal(true);
      render();
    }
    function onVisibility() {
      if (document.hidden) {
        // 切走标签页：立即收回所有明文（红线要求）
        Object.keys(state.reveal).forEach(function (id) { clearRevealTimer(id); });
        state.reveal = {};
        if (state.status === 'unlocked') paintAllSecretCells();
      } else if (state.status === 'unlocked' && state.listState === 'ready') {
        primeTotp(); syncTotpCells();
      }
    }

    // ---------- 口令动作：解锁 / 设置 / 锁定 ----------
    function submitGate(password, confirmPw, mode) {
      if (state.gateBusy) return;
      if (mode === 'setup') {
        if (!password || password.length < 8) { state.gateErr = '主口令至少 8 位'; render(); return; }
        if (password !== confirmPw) { state.gateErr = '两次输入的主口令不一致'; render(); return; }
      } else if (!password) { state.gateErr = '请输入主口令'; render(); return; }

      state.gateBusy = true; state.gateErr = ''; render();

      finishUnlock(password, mode).then(function (res) {
        state.gateBusy = false;
        if (!res || !res.ok) {
          state.gateErr = (res && res.error) || '解锁失败，请重试';
          render(); return;
        }
        state.status = 'unlocked';
        state.error = null;
        if (mode === 'setup' && res.recoveryCode) {
          state.recoveryCode = Array.isArray(res.recoveryCode) ? res.recoveryCode : String(res.recoveryCode);
          state.status = 'recovery';
          render();
        } else {
          afterUnlock(); render();
        }
      });
    }

    function finishUnlock(password, mode) {
      // 优先使用宿主注入的 unlock；否则 best-effort 默认端点（契约未列举 -> 明确降级）
      if (typeof opts.unlock === 'function') {
        return Promise.resolve().then(function () { return opts.unlock(password, { setup: mode === 'setup' }); })
          .then(function (r) {
            if (!r) return { ok: false, error: 'unlock 未返回结果' };
            if (r.ok === false) return { ok: false, error: r.error };
            return { ok: true, recoveryCode: r.recoveryCode };
          })
          .catch(function (e) { return { ok: false, error: (e && e.message) || '解锁异常' }; });
      }
      var url = mode === 'setup' ? endpoints.vaultInit : endpoints.vaultUnlock;
      if (!url) return Promise.resolve({ ok: false, error: '解锁端点未配置（传入 opts.unlock 或 opts.endpoints）' });
      /* 后端两个端点的字段名不同：设口令要 next，解锁要 passphrase。
         统一发 password 会被两边都当成缺参 */
      var body = mode === 'setup' ? { next: password } : { passphrase: password };
      return api.send('POST', url, body).then(function (r) {
        if (r.ok) {
          var rc = r.data && (r.data.recoveryCode || r.data.recovery || r.data.recoveryCodes);
          return { ok: true, recoveryCode: rc };
        }
        if (r.classify.kind === 'notfound') return { ok: false, error: '解锁接口尚未就绪（请在 mount 时传入 opts.unlock 或对齐 /api/vault/*）' };
        return { ok: false, error: rateMessage(r.classify, '解锁失败') };
      });
    }

    function confirmRecovery() {
      state.recoveryCode = null; // 离开恢复屏即清内存（红线：不驻留、不落存储）
      state.status = 'unlocked';
      afterUnlock();
      render();
      toast('保险库已解锁', 'ok');
    }

    function lockNow() {
      api.send('POST', endpoints.vaultLock, {}).then(function () { lockOut({ kind: 'locked', message: '' }); });
    }

    // ---------- CRUD ----------
    function saveCredential(draft, mode) {
      if (state.modal.saving) return;
      state.modal.saving = true; state.modal.saveErr = ''; render();
      var m = state.modal;
      /* 编辑弹窗把 password/note 一律预置成 ''，占位语还写着「留空表示保持原值不变」——
         所以只有真的动过这两个输入框（或用生成器填过）才把它们带进请求体，
         否则「改个网址顺手保存」就会把口令和备注静默删掉。规则本身在 submitPayload 里。 */
      var payload = submitPayload(draft, mode, { pw: m.touchedPw, note: m.touchedNote });
      var p = mode === 'create' ? api.send('POST', endpoints.create, payload) : api.send('PUT', endpoints.update(draft.id), payload);
      p.then(function (r) {
        if (!state.modal) return;
        state.modal.saving = false;
        if (r.classify.kind === 'locked') { lockOut(r.classify); return; }
        if (r.classify.kind === 'rate') { state.modal.saveErr = rateMessage(r.classify, '操作过于频繁，请稍候'); render(); return; }
        if (!r.ok) { state.modal.saveErr = r.classify.message || '保存失败'; render(); return; }
        toast(mode === 'create' ? '已新增凭证' : '已保存修改', 'ok');
        closeModal();
        loadList();
      });
    }

    function deleteCredential(id) {
      api.send('DELETE', endpoints.remove(id), {}).then(function (r) {
        if (r.classify.kind === 'locked') { lockOut(r.classify); return; }
        if (!r.ok) { toast(r.classify.message || '删除失败', 'danger'); return; }
        clearRevealTimer(id); delete state.reveal[id]; delete state.totp[id];
        state.list = state.list.filter(function (c) { return c.id !== id; });
        toast('已删除凭证', 'ok');
        render();
      });
    }

    // ---------- 弹层 ----------
    function openModal(mode, id) {
      state.lastFocus = document.activeElement;
      var src = mode === 'edit' ? byId(id) : null;
      var draft = src
        ? { id: src.id, title: src.title, username: src.username, url: src.url, folder: src.folder, tags: src.tags.join(', '), password: '', note: '', totpSecret: '' }
        : { id: '', title: '', username: '', url: '', folder: '', tags: '', password: '', note: '', totpSecret: '' };
      var gen = { length: 20, upper: true, lower: true, digit: true, symbol: true, noConfusable: true, min: 8, max: 64, output: '' };
      gen.output = generatePassword(gen);
      state.modal = { mode: mode, id: id || '', draft: draft, gen: gen, policy: null, policyState: 'idle', saveErr: '', saving: false, touchedPw: false, touchedNote: false };
      if (mode === 'edit' && src && src.url) loadPolicy(src.id);
      render();
      var first = mountPoint.querySelector('.cv-modal [data-autofocus]');
      if (first) first.focus();
    }
    function closeModal(silent) {
      state.modal = null;
      if (!silent) render();
      if (state.lastFocus && state.lastFocus.focus) { try { state.lastFocus.focus(); } catch (e) {} }
    }

    function loadPolicy(id) {
      state.modal.policyState = 'loading'; render();
      api.get(endpoints.policy(id)).then(function (r) {
        if (!state.modal) return;
        if (r.ok && r.data) { state.modal.policy = r.data; state.modal.policyState = 'ready'; }
        else { state.modal.policy = null; state.modal.policyState = 'fallback'; } // 拿不到按默认
        // 保留用户当前开关，套用站点规则后重算长度区间并再生一次
        state.modal.gen = applyPolicyFromModal();
        state.modal.gen.output = generatePassword(state.modal.gen);
        render();
      });
    }
    function applyPolicyFromModal() {
      var base = state.modal.gen;
      // 把现有开关映射进 base，applyPolicy 只负责 min/max/length/规则覆盖
      var cfg = applyPolicy(base, state.modal.policy);
      // 站点若无显式要求，尊重用户当前勾选
      if (!state.modal.policy) {
        cfg.upper = base.upper; cfg.lower = base.lower; cfg.digit = base.digit; cfg.symbol = base.symbol; cfg.noConfusable = base.noConfusable;
      }
      cfg.length = clamp(cfg.length, cfg.min, cfg.max);
      return cfg;
    }

    // ---------- 事件委托 ----------
    bind(rootEl, 'click', onClick);
    bind(rootEl, 'input', onInput);
    bind(rootEl, 'change', onChange);
    bind(rootEl, 'submit', onSubmitForm);
    bind(rootEl, 'keydown', onKeydown);

    function onClick(ev) {
      var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!t) { if (ev.target.classList && ev.target.classList.contains('cv-overlay')) closeModal(); return; }
      var act = t.getAttribute('data-act');
      var id = t.getAttribute('data-id');
      switch (act) {
        case 'gate-submit': ev.preventDefault(); { var pw = mountPoint.querySelector('#cv-pw'); var cf = mountPoint.querySelector('#cv-pw2'); submitGate(pw ? pw.value : '', cf ? cf.value : '', state.status === 'setup' ? 'setup' : 'unlock'); } break;
        case 'toggle-pw-vis': { var w = t.closest('.cv-pw-wrap').querySelector('input'); var shown = w.type === 'text'; w.type = shown ? 'password' : 'text'; t.setAttribute('aria-pressed', String(!shown)); t.innerHTML = shown ? IC.eye : IC.eyeoff; } break;
        case 'recovery-continue': confirmRecovery(); break;
        case 'copy-recovery': copyText(state.recoveryCode ? (Array.isArray(state.recoveryCode) ? state.recoveryCode.join('\n') : state.recoveryCode) : ''); break;
        case 'lock': lockNow(); break;
        case 'tab': { state.activeTab = t.getAttribute('data-tab'); if (state.activeTab === 'health' && state.health.status === 'idle') loadHealth(); else render(); } break;
        case 'reload-list': loadList(); break;
        case 'reload-health': loadHealth(); break;
        case 'add': openModal('create'); break;
        case 'edit': openModal('edit', id); break;
        case 'del': { if (t.getAttribute('data-armed') === '1') { deleteCredential(id); } else { armDanger(t); } } break;
        case 'reveal': reveal(id); break;
        case 'copy-user': copyText(byId(id) ? byId(id).username : ''); break;
        case 'copy-totp': copyText(state.totp[id] ? state.totp[id].code : ''); break;
        case 'modal-cancel': closeModal(); break;
        case 'modal-save': ev.preventDefault(); commitModal(); break;
        case 'gen-regen': regenerate(); break;
        case 'gen-copy': copyText(state.modal ? state.modal.gen.output : ''); break;
        case 'gen-apply': { if (state.modal) { state.modal.draft.password = state.modal.gen.output; state.modal.touchedPw = true; var pv = mountPoint.querySelector('#cv-f-pw'); if (pv) { pv.value = state.modal.gen.output; updatePwMeter(pv); } toast('生成口令已填入', 'ok'); } } break;
        case 'refresh-all': loadList(); if (state.activeTab === 'health') loadHealth(); toast('已刷新', 'ok'); break;
        case 'security': { state.securityOpen = !state.securityOpen; state.discardErr = ''; render(); } break;
        case 'security-close': { state.securityOpen = false; state.discardErr = ''; render(); } break;
        case 'discard-key': discardRawKey(); break;
        default: break;
      }
    }

    function commitModal() {
      var m = state.modal; if (!m) return;
      var form = mountPoint.querySelector('.cv-modal'); if (!form) return;
      var g = function (sel) { var e = form.querySelector(sel); return e ? e.value.trim() : ''; };
      var draft = m.draft;
      draft.title = g('#cv-f-title');
      draft.username = g('#cv-f-user');
      draft.url = g('#cv-f-url');
      draft.folder = g('#cv-f-folder');
      draft.tags = g('#cv-f-tags');
      var pwEl = form.querySelector('#cv-f-pw'); draft.password = pwEl ? pwEl.value : '';
      var noteEl = form.querySelector('#cv-f-note'); draft.note = noteEl ? noteEl.value : '';
      var totpEl = form.querySelector('#cv-f-totp'); draft.totpSecret = totpEl ? totpEl.value.trim() : '';
      if (!draft.title) { m.saveErr = '标题不能为空'; render(); var te = form.querySelector('#cv-f-title'); if (te) te.focus(); return; }
      // tags: 逗号/空格分隔 -> 数组
      var payloadDraft = Object.assign({}, draft, { tags: String(draft.tags).split(/[,\s]+/).filter(Boolean) });
      saveCredential(payloadDraft, m.mode);
    }

    function onInput(ev) {
      var t = ev.target;
      if (t.id === 'cv-search') { state.filters.q = t.value; renderListOnly(); return; }
      if (t.id === 'cv-pw' || t.id === 'cv-pw2') { updateGateMeter(); return; }
      if (t.id === 'cv-f-pw') { if (state.modal) state.modal.touchedPw = true; updatePwMeter(t); return; }
      if (t.id === 'cv-f-note') { if (state.modal) state.modal.touchedNote = true; return; }
      if (t.id === 'cv-gen-len') { if (state.modal) { state.modal.gen.length = Number(t.value); regenerate(true); } return; }
    }
    function onChange(ev) {
      var t = ev.target;
      if (t.id === 'cv-f-folder-filter') { state.filters.folder = t.value; renderListOnly(); return; }
      if (t.id === 'cv-f-tag-filter') { state.filters.tag = t.value; renderListOnly(); return; }
      if (t.getAttribute && t.getAttribute('data-recovery-ack') === '1') { var btn = mountPoint.querySelector('[data-act="recovery-continue"]'); if (btn) btn.disabled = !t.checked; return; }
      if (t.classList && t.classList.contains('cv-gen-class')) { if (state.modal) { state.modal.gen[t.getAttribute('data-gen-key')] = t.checked; regenerate(true); } return; }
      if (t.classList && t.classList.contains('cv-gen-conf')) { if (state.modal) { state.modal.gen.noConfusable = t.checked; regenerate(true); } return; }
    }
    function onSubmitForm(ev) { /* gate 走按钮；保留以备表单语义 */ ev.preventDefault(); }

    function onKeydown(ev) {
      if (ev.key === 'Escape') {
        if (state.modal) { ev.preventDefault(); closeModal(); }
        return;
      }
      if (state.modal && ev.key === 'Tab') { trapFocus(ev); }
      // 弹层表单内 Enter 提交（文本输入）
      if (state.modal && ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox' && ev.target.id !== 'cv-gen-len') {
        ev.preventDefault(); commitModal(); return;
      }
      // 门屏 Enter 提交
      if ((state.status === 'unlock' || state.status === 'setup') && ev.key === 'Enter' && (ev.target.id === 'cv-pw' || ev.target.id === 'cv-pw2')) {
        ev.preventDefault(); var pw = mountPoint.querySelector('#cv-pw'); var cf = mountPoint.querySelector('#cv-pw2'); submitGate(pw ? pw.value : '', cf ? cf.value : '', state.status === 'setup' ? 'setup' : 'unlock');
      }
      // 标签页左右箭头
      if (ev.target.classList && ev.target.classList.contains('cv-tab') && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
        ev.preventDefault(); var tabs = Array.prototype.slice.call(mountPoint.querySelectorAll('.cv-tab')); var i = tabs.indexOf(ev.target); var n = ev.key === 'ArrowRight' ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length; tabs[n].focus(); tabs[n].click();
      }
    }

    function trapFocus(ev) {
      var f = focusables(mountPoint.querySelector('.cv-modal'));
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }

    function focusables(scope) {
      if (!scope) return [];
      return Array.prototype.slice.call(scope.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
        .filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
    }

    // ---------- 危险操作两段确认（删除）----------
    function armDanger(btn) {
      if (btn._disarm) { btn._disarm(); }
      btn.setAttribute('data-armed', '1');
      btn.classList.add('danger-confirm');
      var prev = btn.getAttribute('title'); btn.setAttribute('title', '再点一次确认删除');
      var label = btn.querySelector('span'); var pl = label ? label.textContent : '';
      if (label) label.textContent = '确认删除';
      var to = setTimeout(function () { disarm(btn, prev, pl, label); }, 3500);
      btn._disarm = function () { clearTimeout(to); disarm(btn, prev, pl, label); btn._disarm = null; };
    }
    function disarm(btn, prev, pl, label) { btn.removeAttribute('data-armed'); btn.classList.remove('danger-confirm'); if (prev) btn.setAttribute('title', prev); else btn.removeAttribute('title'); if (label) label.textContent = pl; }

    // ---------- 剪贴板（无残留、不落存储）----------
    function copyText(text) {
      if (text == null || text === '') { toast('没有可复制的内容', 'danger'); return; }
      var done = function (ok) { toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择', ok ? 'ok' : 'danger'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(text)).then(function () { done(true); }, function () { fallbackCopy(String(text), done); });
      } else { fallbackCopy(String(text), done); }
    }
    function fallbackCopy(text, done) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'absolute'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); done(ok);
    }

    // ---------- toast ----------
    function toast(msg, kind) {
      var box = mountPoint.querySelector('.cv-toasts');
      if (!box) { box = document.createElement('div'); box.className = 'cv-toasts'; box.setAttribute('aria-live', 'polite'); mountPoint.appendChild(box); }
      var el = document.createElement('div'); el.className = 'cv-toast'; el.setAttribute('data-kind', kind || 'ok');
      el.innerHTML = (kind === 'danger' ? IC.alert : IC.check) + '<span>' + escapeHtml(msg) + '</span>';
      box.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
    }

    // ---------- 局部重绘（不打断焦点/不整屏 re-render）----------
    function syncTotpCells() {
      if (state.status !== 'unlocked') return;
      var cells = mountPoint.querySelectorAll('[data-totp-cell]');
      Array.prototype.forEach.call(cells, function (cell) {
        var id = cell.getAttribute('data-totp-cell'); var t = state.totp[id]; if (!t) return;
        var codeEl = cell.querySelector('[data-code]'); var secsEl = cell.querySelector('[data-secs]');
        var fg = cell.querySelector('[data-fg]'); var ring = cell.querySelector('.cv-ring');
        if (t.error) { if (codeEl) { codeEl.textContent = '不可用'; codeEl.setAttribute('data-ph', '1'); } if (secsEl) secsEl.textContent = ''; if (fg) fg.style.strokeDashoffset = fg.dataset.c; if (ring) { ring.removeAttribute('data-warn'); ring.setAttribute('data-danger', '1'); } return; }
        if (t.loading && !t.code) { if (codeEl) { codeEl.textContent = '……'; codeEl.setAttribute('data-ph', '1'); } return; }
        if (codeEl) { codeEl.textContent = formatCode(t.code, t.digits); codeEl.removeAttribute('data-ph'); }
        if (secsEl) secsEl.textContent = Math.max(0, t.secondsRemaining) + 's';
        if (fg) { var period = t.period || 30; var frac = clamp(t.secondsRemaining / period, 0, 1); var c = Number(fg.dataset.c); fg.style.strokeDashoffset = String(c * (1 - frac)); }
        if (ring) { var s = t.secondsRemaining; ring.toggleAttribute('data-warn', s <= 10 && s > 5); ring.toggleAttribute('data-danger', s <= 5); }
      });
    }

    function paintSecretCell(id) {
      var cell = mountPoint.querySelector('[data-secret-for="' + cssEscape(id) + '"]');
      if (cell) cell.innerHTML = secretRowInner(byId(id), state.reveal[id]);
      var ncell = mountPoint.querySelector('[data-note-for="' + cssEscape(id) + '"]');
      if (ncell) ncell.innerHTML = noteRowInner(byId(id), state.reveal[id]);
      var btn = mountPoint.querySelector('[data-act="reveal"][data-id="' + cssEscape(id) + '"]');
      if (btn) { var on = !!state.reveal[id]; btn.setAttribute('aria-pressed', String(on)); btn.innerHTML = (on ? IC.eyeoff : IC.eye) + '<span>' + (on ? '隐藏' : '显示') + '</span>'; }
    }
    function paintAllSecretCells() { Object.keys(state.totp).forEach(function () {}); state.list.forEach(function (c) { if (c.hasPassword || c.hasSecret || c.hasNote) paintSecretCell(c.id); }); }

    function updatePwMeter(input) {
      var m = mountPoint.querySelector('#cv-f-pw-meter > i'); var lb = mountPoint.querySelector('#cv-f-pw-meter-label');
      var s = strengthBits(input.value); if (m) { m.style.width = clamp(s.bits / 100 * 100, 6, 100) + '%'; m.style.background = toneColor(s.tone); } if (lb) { lb.textContent = input.value ? s.label : '留空表示保持不变'; lb.style.color = input.value ? toneColor(s.tone) : ''; }
    }
    function updateGateMeter() {
      var pw = mountPoint.querySelector('#cv-pw'); if (!pw) return;
      var m = mountPoint.querySelector('#cv-gate-meter > i'); var lb = mountPoint.querySelector('#cv-gate-meter-label');
      var s = strengthBits(pw.value); if (m) { m.style.width = clamp(s.bits / 100 * 100, 0, 100) + '%'; m.style.background = toneColor(s.tone); } if (lb) { lb.textContent = s.bits ? ('强度 ' + s.label + ' · ~' + Math.round(s.bits) + ' 位熵') : '至少 8 位'; }
    }
    function toneColor(tone) { return tone === 'danger' ? 'var(--cv-danger)' : tone === 'warn' ? 'var(--cv-warn)' : tone === 'ok' ? 'var(--cv-accent)' : 'var(--cv-ink-3)'; }

    function regenerate(silent) {
      if (!state.modal) return;
      var gen = state.modal.gen;
      gen.output = generatePassword(gen);
      var out = mountPoint.querySelector('.cv-gen-out');
      if (out) out.textContent = gen.output || '—';
      var lv = mountPoint.querySelector('.cv-range-val'); if (lv) lv.textContent = gen.length;
      var gm = mountPoint.querySelector('.cv-gen-meter > i'); if (gm) { var s = strengthBits(gen.output); gm.style.width = clamp(s.bits / 100 * 100, 6, 100) + '%'; gm.style.background = toneColor(s.tone); }
      var gl = mountPoint.querySelector('.cv-gen-meter-label'); if (gl) gl.textContent = strengthBits(gen.output).label;
      if (!silent) { /* noop */ }
    }

    function renderIfUnlocked() { if (state.status === 'unlocked' && state.activeTab === 'list') render(); }

    // =========================================================================
    // 渲染（整块 HTML；局部更新走上面的 paint/sync）
    // =========================================================================
    /* 弹窗开着的时候，任何一次异步重绘都必须先把输入框收回 draft——
       否则站点规则（loadPolicy）、健康刷新之类的 render() 会把用户正在打的字整块抹回旧值。
       这里刻意不 trim：保存时 commitModal 自己 trim，这一步只为保住画面。 */
    function harvestModalDraft() {
      var form = mountPoint.querySelector('.cv-modal');
      if (!form || !state.modal) return;
      var d = state.modal.draft;
      var pairs = [['#cv-f-title', 'title'], ['#cv-f-user', 'username'], ['#cv-f-url', 'url'],
        ['#cv-f-folder', 'folder'], ['#cv-f-tags', 'tags'], ['#cv-f-pw', 'password'], ['#cv-f-note', 'note'],
        ['#cv-f-totp', 'totpSecret']];
      for (var i = 0; i < pairs.length; i++) {
        var el = form.querySelector(pairs[i][0]);
        if (el) d[pairs[i][1]] = el.value;
      }
    }

    function render() {
      if (state.modal) harvestModalDraft();
      var html = '<div class="cv-atmos" aria-hidden="true"></div><div class="cv-shell">' + topBar();
      switch (state.status) {
        case 'loading': html += '<div class="cv-loading"><div class="cv-spin"></div><span>正在检查保险库状态…</span></div>'; break;
        case 'setup': html += gateScreen('setup'); break;
        case 'unlock': html += gateScreen('unlock'); break;
        case 'recovery': html += recoveryScreen(); break;
        case 'unlocked': html += mainView(); break;
        default: html += ''; break;
      }
      html += '</div>';
      if (state.modal) html += modalHtml();
      var keepToasts = mountPoint.querySelector('.cv-toasts');
      mountPoint.innerHTML = html;
      if (keepToasts) mountPoint.appendChild(keepToasts); // 保住正在显示的 toast
      if (state.status === 'unlocked') { syncTotpCells(); }
      if (opts.onStatus) { try { opts.onStatus(state.status); } catch (e) {} }
    }

    function topBar() {
      var lock = state.status === 'unlocked' ? 'open' : 'locked';
      /* 设置态说「已锁定」是骗人的——库还没建，锁都没东西可锁 */
      var lockTxt = state.status === 'unlocked' ? '已解锁' : (state.status === 'setup' ? '尚未创建' : '已锁定');
      var showTools = state.status === 'unlocked';
      /* 口令写了盘但当前进程的会话还是 legacy 免密（开机即锁要重启才生效）。
         不写这一条，用户会以为设完口令当场就安全了 */
      /* .cv-banner 是 flex 容器，裸文本节点会被拆成一列一列的 flex item；
         内容必须包进单个子元素，强调用 strong（b 被样式表设成 display:block） */
      var legacyRun = (state.passphraseSet && state.sessionMode === 'legacy')
        ? '<div class="cv-banner" data-kind="423" role="status"><div>口令已设置，但<strong>本次运行仍是免密的</strong>：重启服务后才会要求解锁。点「锁定」可立刻验证闸门是否真的落下。</div></div>'
        : '';
      /* 「拆除明文密钥」只在设过口令之后出现：免口令时删掉 master.key 就是整库永久解不开，
         后端也会当场拒。放在这里而不是密钥页，是因为改口令、锁定这些保险库级动作都在这条栏上。 */
      var securityBtn = (showTools && state.passphraseSet)
        ? '<button class="cv-btn ghost" data-act="security" type="button" aria-expanded="' +
            (state.securityOpen ? 'true' : 'false') + '" data-warn="' + (state.rawKeyPresent ? '1' : '0') + '">' +
            IC.shield + '<span>明文密钥</span></button>'
        : '';
      return '<div class="cv-top">' +
        '<div class="cv-brand"><span class="cv-mark">' + IC.vault + '</span><div><h1>凭证保险库</h1><p class="cv-mono">LOCAL · ENCRYPTED · ZERO-UPLOAD</p></div></div>' +
        '<div class="cv-spacer"></div>' +
        '<span class="cv-status-chip" data-lock="' + lock + '"><span class="cv-led"></span>' + (lock === 'open' ? IC.unlock : IC.lock) + ' ' + lockTxt + '</span>' +
        (showTools ? '<button class="cv-btn" data-act="refresh-all" type="button" title="刷新">' + IC.refresh + '<span>刷新</span></button>' +
          securityBtn +
          '<button class="cv-btn ghost" data-act="lock" type="button">' + IC.lock + '<span>锁定</span></button>' : '') +
        '</div>' + legacyRun + (state.securityOpen ? securityCard() : '');
    }

    /* 这条卡片是整个安全模型里唯一「不可逆」的开关，所以文案先把代价说满，
       再谈收益；确认方式是「口令 + 勾选」两个独立动作，不是一句「你确定吗」 */
    function securityCard() {
      var err = state.discardErr
        ? '<div class="cv-banner" data-kind="5xx" role="alert">' + IC.alert + '<span>' + escapeHtml(state.discardErr) + '</span></div>'
        : '';
      if (state.rawKeyPresent === false) {
        return '<section class="cv-card cv-security" data-state="discarded">' +
          '<h2>明文密钥：已拆除</h2>' +
          '<p>数据目录里已经没有 <code>master.key</code>。现在能解开这个库的只有解锁口令，' +
          '或「恢复码 + <code>recovery.env</code>」这一对。</p>' +
          '<p class="cv-hint">备份请把 <code>vault.key</code> 与 <code>recovery.env</code> 一起带走；' +
          '口令忘了、恢复码也没抄，那就是永久解不开，没有后门。</p>' +
          '<button class="cv-btn ghost" data-act="security-close" type="button">收起</button></section>';
      }
      return '<section class="cv-card cv-security" data-state="present">' +
        '<h2>明文密钥：还在原地</h2>' +
        '<p>设口令只是把主密钥又包了一层，<code>master.key</code> 本身仍留在数据目录里。' +
        '只要它在，<strong>拷走整个数据目录就等于拷走了解开一切的钥匙</strong>——口令并没有改变这一点。</p>' +
        '<p class="cv-hint">拆除之后：口令成为唯一入口；忘记口令只能靠恢复码重置；这一步不可逆，' +
        '而且服务端会先用你输入的口令实际解一次，成功才允许删。</p>' +
        err +
        '<div class="cv-field"><label class="cv-label" for="cv-discard-pw">输入解锁口令</label>' +
        '<input class="cv-input mono" id="cv-discard-pw" type="password" autocomplete="off" ' +
        'autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="••••••••"></div>' +
        '<label class="cv-check"><input type="checkbox" id="cv-discard-ack">' +
        '<span class="cv-check-txt">我知道这一步不可逆<small>拆掉之后只能靠口令或恢复码进来，两者都没了就是数据没了</small></span></label>' +
        '<div class="cv-security-acts"><button class="cv-btn danger" data-act="discard-key" type="button"' +
        (state.discardBusy ? ' disabled' : '') + '>' + (state.discardBusy ? '正在拆除…' : '拆除明文密钥') + '</button>' +
        '<button class="cv-btn ghost" data-act="security-close" type="button">取消</button></div></section>';
    }

    function discardRawKey() {
      var card = mountPoint.querySelector('.cv-security');
      if (!card || state.discardBusy) return;
      var pwEl = card.querySelector('#cv-discard-pw');
      var ackEl = card.querySelector('#cv-discard-ack');
      var pw = pwEl ? pwEl.value : '';
      if (!ackEl || !ackEl.checked) { state.discardErr = '先勾那一项：这一步拆掉之后没法撤销。'; render(); return; }
      if (!pw) { state.discardErr = '请输入解锁口令。'; render(); return; }
      state.discardBusy = true; state.discardErr = ''; render();
      api.send('POST', endpoints.vaultDiscard, { passphrase: pw, confirm: true }).then(function (r) {
        state.discardBusy = false;
        if (r.ok) {
          state.rawKeyPresent = false;
          toast('明文密钥已拆除', 'ok');
        } else {
          state.discardErr = (r.data && r.data.error) || r.classify.message || '拆除失败';
        }
        render();
      });
    }

    // ---- 门屏（设置 / 解锁）----
    function gateScreen(mode) {
      var err = state.gateErr || (state.error ? rateMessage(state.error) : '');
      var isSetup = mode === 'setup';
      var title = isSetup ? '设置主口令' : '解锁保险库';
      var sub = isSetup ? '首次使用：创建一个主口令来加密本地保险库。它不会被上传，也不会写入本机任何存储。'
        : '输入主口令以解密并显示你的凭证。口令仅驻留内存，锁定即清除。';
      var banner = state.error && state.error.kind !== 'ok' ? errorBanner(state.error) : '';
      var fields =
        '<div class="cv-field">' +
          '<label class="cv-label" for="cv-pw">' + (isSetup ? '主口令' : '输入主口令') + '</label>' +
          '<div class="cv-pw-wrap"><input class="cv-input mono" id="cv-pw" type="password" autocomplete="' + (isSetup ? 'new-password' : 'off') + '" autocorrect="off" autocapitalize="off" spellcheck="false" data-autofocus placeholder="' + (isSetup ? '至少 8 位' : '••••••••') + '">' +
          '<div class="cv-pw-tools"><button class="cv-ghost-ico" type="button" data-act="toggle-pw-vis" aria-pressed="false" aria-label="显示口令">' + IC.eye + '</button></div></div>' +
          (isSetup ? '<div class="cv-meter" id="cv-gate-meter"><i></i></div><div class="cv-meter-label" id="cv-gate-meter-label">至少 8 位</div>' : '') +
        '</div>';
      if (isSetup) {
        fields += '<div class="cv-field"><label class="cv-label" for="cv-pw2">确认主口令</label>' +
          '<div class="cv-pw-wrap"><input class="cv-input mono" id="cv-pw2" type="password" autocomplete="new-password" spellcheck="false" placeholder="再输入一次"></div></div>';
      }
      var busy = state.gateBusy;
      var action = '<button class="cv-btn primary block" type="button" data-act="gate-submit"' + (busy ? ' disabled' : '') + '>' +
        (busy ? '<span class="cv-spin" style="width:16px;height:16px;border-width:2px"></span> 处理中…' : (isSetup ? IC.vault + ' 创建保险库' : IC.unlock + ' 解锁')) + '</button>';
      var errHtml = err ? '<div class="cv-banner" data-kind="' + (isSetup ? '5xx' : '423') + '" role="alert">' + IC.alert + '<span>' + escapeHtml(err) + '</span></div>' : '';
      var note = '<div class="cv-gate-note">' + IC.shield + '<span>' + (isSetup
        ? '主口令不可恢复找回（除非用稍后的恢复码）。请牢记——它不存于本机任何文件。'
        : '凭证内容当前以占位显示，解锁后才会解密填充。所有明文只在本页内存中短暂存在。') + '</span></div>';

      var preview = isSetup ? firstRunPreview() : lockedPreview();
      return '<div class="cv-gate-wrap">' +
        '<form class="cv-gate' + (isSetup ? ' cv-setup' : '') + '" onsubmit="return false" aria-labelledby="cv-gate-h">' +
          '<div class="cv-seal" aria-hidden="true">' + (isSetup ? IC.vault : IC.lock) + '</div>' +
          '<h2 id="cv-gate-h">' + title + '</h2><p class="cv-gate-sub">' + sub + '</p>' +
          banner + errHtml + fields + action + note +
        '</form></div>' + preview;
    }

    // 锁定预览：占位骨架，绝不空白（红线：锁定态显示占位）
    function lockedPreview() {
      var rows = '';
      for (var i = 0; i < 3; i++) {
        rows += '<div class="cv-skel">' +
          '<div class="cv-lock-tag">' + IC.lock + ' 已封印</div>' +
          '<div class="cv-skel-row"><span class="cv-skel-line w40"></span></div>' +
          '<div class="cv-skel-row"><span class="cv-skel-line w60"></span><span class="cv-redact" style="margin-left:auto">••••••</span></div>' +
          '<div class="cv-skel-row"><span class="cv-skel-line w25"></span></div></div>';
      }
      return '<div class="cv-preview"><div class="cv-panel"><div class="cv-preview-label">锁定预览 · 内容需解锁后显示</div>' + rows +
        '<p class="cv-hint" style="text-align:center;margin-top:6px">这是占位预览，不代表真实凭证数量。</p></div></div>';
    }
    function firstRunPreview() {
      return '<div class="cv-preview"><div class="cv-panel"><div class="cv-preview-label">保险库尚未创建</div>' +
        '<div class="cv-state" style="padding:24px 0"><div class="cv-state-ico">' + IC.vault + '</div>' +
        '<h3>还没有任何凭证</h3><p>口令、动态码、密钥与备注都会加密存在本机；设了主口令之后，未解锁时这里一个字节都不出。</p></div></div></div>';
    }

    // ---- 恢复码屏（红线：恢复码仅此唯一区域显示，不落存储，离开即清）----
    function recoveryScreen() {
      var codes = state.recoveryCode ? (Array.isArray(state.recoveryCode) ? state.recoveryCode : [state.recoveryCode]) : [];
      var body = codes.length
        ? '<div class="cv-code-box"><button class="cv-btn small ghost cv-code-copy" type="button" data-act="copy-recovery">' + IC.copy + '<span>复制</span></button>' +
          '<div class="cv-code-val" id="cv-recovery-code" tabindex="0" role="region" aria-label="恢复码">' + escapeHtml(codes.join('\n')) + '</div></div>' +
          '<p class="cv-hint">恢复码用于忘记主口令时找回保险库。<b>它只显示这一次</b>，不会存储在本机任何位置。</p>'
        : '<div class="cv-state" data-tone="warn" style="padding:24px 0"><div class="cv-state-ico">' + IC.info + '</div><h3>未获得恢复码</h3>' +
          '<p>后端未返回恢复码（可能是接口尚未就绪）。你仍可继续，但请务必牢记主口令。</p></div>';
      return '<div class="cv-gate-wrap"><form class="cv-gate cv-recovery" onsubmit="return false" aria-labelledby="cv-rec-h">' +
        '<div class="cv-seal" aria-hidden="true">' + IC.key + '</div>' +
        '<h2 id="cv-rec-h">保存恢复码</h2><p class="cv-gate-sub">把它抄到安全的地方——这是找回保险库的唯一途径。</p>' +
        body +
        '<label class="cv-check"><input type="checkbox" data-recovery-ack="1"' + (codes.length ? '' : ' checked') + '>' +
          '<span class="cv-check-txt">我已抄好并安全保存<small>勾选后才能继续（恢复码离开此屏即不可再见）</small></span></label>' +
        '<button class="cv-btn primary block" type="button" data-act="recovery-continue"' + (codes.length ? ' disabled' : '') + '>' + IC.unlock + ' 继续进入保险库</button>' +
        '</form></div>';
    }

    // ---- 主视图（列表 / 健康 标签页）----
    function mainView() {
      var top = state.error ? errorBanner(state.error) : '';
      return top + tabsBar() + (state.activeTab === 'health' ? healthView() : listView());
    }

    function tabsBar() {
      var folders = uniqueFolders();
      var tags = uniqueTags();
      return '<div class="cv-toolbar">' +
        '<div class="cv-tabs" role="tablist" aria-label="视图切换">' +
          '<button class="cv-tab" role="tab" data-act="tab" data-tab="list" aria-selected="' + (state.activeTab === 'list') + '">' + IC.vault + '凭证</button>' +
          '<button class="cv-tab" role="tab" data-act="tab" data-tab="health" aria-selected="' + (state.activeTab === 'health') + '">' + IC.shield + '健康</button>' +
        '</div>' +
        (state.activeTab === 'list'
          ? '<div class="cv-search"><span class="cv-search-ico">' + IC.search + '</span><input class="cv-input" id="cv-search" type="search" placeholder="搜索标题 / 用户名 / 网址" aria-label="搜索凭证" value="' + escapeHtml(state.filters.q) + '"></div>' +
            filterSelect('cv-f-folder-filter', '全部文件夹', folders, state.filters.folder) +
            filterSelect('cv-f-tag-filter', '全部标签', tags, state.filters.tag) +
            '<span class="cv-count"><b>' + filteredList().length + '</b> / ' + state.list.length + '</span>' +
            '<button class="cv-btn primary" data-act="add" type="button">' + IC.plus + '新增凭证</button>'
          : '<span class="cv-count">口令安全体检</span>' +
            '<button class="cv-btn" data-act="reload-health" type="button">' + IC.refresh + '重新检查</button>') +
        '</div>';
    }

    function listView() {
      var body = listBody();
      return '<div id="cv-list-body">' + body + '</div>';
    }
    function listBody() {
      if (state.listState === 'loading') return loadingBlock('正在读取凭证…');
      if (state.listState === 'error') { var k = state.listErr ? state.listErr.kind : 'server'; return errorState(k, state.listErr && state.listErr.message, 'reload-list'); }
      if (state.listState === 'idle') return loadingBlock('正在准备…');
      var items = filteredList();
      if (!items.length) {
        var filtered = state.filters.q || state.filters.folder || state.filters.tag;
        return emptyState(filtered ? '没有匹配的凭证' : '还没有任何凭证',
          filtered ? '换个关键词或清除筛选试试。' : '新增第一条凭证：网站账号密码、两步验证密钥、API 密钥与备注，都只加密存在本机。',
          filtered ? null : { act: 'add', label: '新增凭证', icon: IC.plus });
      }
      var cards = items.map(function (c, i) { return cardHtml(c, i); }).join('');
      return '<div class="cv-grid" role="list">' + cards + '</div>';
    }

    function cardHtml(c, i) {
      var caps = '<span class="cv-capdots">' +
        capDot(c.hasPassword, IC.key, '口令') + capDot(c.hasSecret, IC.vault, '密钥') +
        capDot(c.hasTotp, IC.clock, '动态码') + capDot(c.hasNote, IC.note, '备注') + '</span>';
      var badges = '<div class="cv-badges">' +
        (c.folder ? '<span class="cv-badge folder">' + IC.folder + escapeHtml(c.folder) + '</span>' : '') +
        c.tags.map(function (t) { return '<span class="cv-badge tag">' + escapeHtml(t) + '</span>'; }).join('') +
        caps + '</div>';
      var host = hostOf(c.url);
      var rows = '<div class="cv-rows">';
      if (c.username) rows += '<div class="cv-row"><span class="cv-row-key">用户名</span><span class="cv-row-val cv-mono">' + escapeHtml(c.username) + '</span>' +
        '<span class="cv-mini-acts"><button class="cv-ghost-ico" type="button" data-act="copy-user" data-id="' + escapeHtml(c.id) + '" aria-label="复制用户名">' + IC.copy + '</button></span></div>';
      if (c.url) rows += '<div class="cv-row"><span class="cv-row-key">网址</span><span class="cv-row-val">' +
        '<a href="' + escapeHtml(c.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(host || c.url) + '</a></span></div>';
      if (c.hasPassword || c.hasSecret) {
        rows += '<div class="cv-row"><span class="cv-row-key">' + (c.hasSecret && !c.hasPassword ? '密钥' : '口令') + '</span>' +
          '<span class="cv-row-val" data-secret-for="' + escapeHtml(c.id) + '">' + secretRowInner(c, state.reveal[c.id]) + '</span></div>';
      }
      if (c.hasTotp) rows += '<div class="cv-row"><span class="cv-row-key">动态码</span><span class="cv-row-val"><span class="cv-totp">' + totpCellHtml(c.id) + '</span></span></div>';
      if (c.hasNote) rows += '<div class="cv-row"><span class="cv-row-key">备注</span><span class="cv-row-val" data-note-for="' + escapeHtml(c.id) + '">' + noteRowInner(c, state.reveal[c.id]) + '</span></div>';
      rows += '</div>';

      var meta = '<div class="cv-card-meta">' +
        '<span>' + IC.clock + '更新 <b>' + escapeHtml(fmtDate(c.updatedAt || c.createdAt)) + '</b></span>' +
        '<span>' + IC.bolt + '用过 <b>' + escapeHtml(fmtDate(c.lastUsedAt)) + '</b></span></div>';

      return '<article class="cv-card" role="listitem" data-id="' + escapeHtml(c.id) + '" style="--cv-i:' + i + '">' +
        '<div class="cv-card-head"><h3 class="cv-card-title">' + escapeHtml(c.title || '（未命名）') + '</h3>' +
        '<div class="cv-card-acts">' +
          '<button class="cv-btn ghost small" type="button" data-act="edit" data-id="' + escapeHtml(c.id) + '" title="编辑">' + IC.edit + '<span>编辑</span></button>' +
          '<button class="cv-btn danger small" type="button" data-act="del" data-id="' + escapeHtml(c.id) + '" title="删除" aria-label="删除 ' + escapeHtml(c.title) + '">' + IC.trash + '<span>删除</span></button>' +
        '</div></div>' + badges + rows + meta + '</article>';
    }

    function useIconWrap() { return IC.link; }
    function totpCellHtml(id) {
      var t = state.totp[id]; var code = '······'; var ph = '1'; var secs = '';
      if (t && t.error) { code = '不可用'; ph = '1'; }
      else if (t && t.code) { code = formatCode(t.code, t.digits); ph = '0'; secs = (t.secondsRemaining || 0) + 's'; }
      else if (t && t.loading) { code = '……'; ph = '1'; }
      var C = 2 * Math.PI * 12;
      return '<span data-totp-cell="' + escapeHtml(id) + '">' +
        '<span class="cv-totp-code ' + (ph === '1' ? '' : 'cv-mono') + '" data-ph="' + ph + '" data-code>' + escapeHtml(code) + '</span>' +
        '<svg class="cv-ring" viewBox="0 0 30 30" aria-hidden="true"><circle class="cv-ring-bg" cx="15" cy="15" r="12"/>' +
        '<circle class="cv-ring-fg" cx="15" cy="15" r="12" data-fg data-c="' + C.toFixed(2) + '" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="0"/></svg>' +
        '<span class="cv-totp-secs" data-secs>' + escapeHtml(secs) + '</span>' +
        (ph === '0' ? '<button class="cv-ghost-ico" type="button" data-act="copy-totp" data-id="' + escapeHtml(id) + '" aria-label="复制动态码">' + IC.copy + '</button>' : '') +
        '</span>';
    }

    function noteRowInner(c, revealed) {
      if (revealed && revealed.note) return '<span class="cv-row-val" style="white-space:normal">' + escapeHtml(revealed.note) + '</span>';
      return '<span class="cv-redact">点“显示”后查看</span>';
    }

    // 复制：只读 data-copy（揭示后的明文，掩码态无此属性）
    function onCopyClick(ev) {
      var b = ev.target.closest ? ev.target.closest('[data-act="copy"]') : null;
      if (!b) return; var v = b.getAttribute('data-copy'); if (v != null) copyText(v);
    }
    bind(rootEl, 'click', onCopyClick);

    function errorBanner(e) {
      var kind = e.kind === 'rate' ? '429' : e.kind === 'locked' ? '423' : e.kind === 'server' ? '5xx' : e.kind === 'net' ? 'net' : 'note';
      var title = e.kind === 'rate' ? '触发限流' : e.kind === 'locked' ? '保险库未解锁' : e.kind === 'net' ? '连接失败' : e.kind === 'server' ? '服务错误' : '提示';
      return '<div class="cv-banner" data-kind="' + kind + '" role="alert">' + IC.alert + '<span><b>' + title + '</b>' + escapeHtml(rateMessage(e)) + '</span></div>';
    }

    function loadingBlock(msg) { return '<div class="cv-loading"><div class="cv-spin"></div><span>' + escapeHtml(msg) + '</span></div>'; }

    function errorState(kind, message, reloadAct) {
      var map = {
        locked: { tone: 'warn', ico: IC.lock, h: '保险库未解锁', p: '需要主口令才能读取凭证。请回到解锁屏重新解锁。' },
        rate: { tone: 'warn', ico: IC.clock, h: '请求过于频繁（429）', p: '服务端已限流。稍等片刻再重试，勿连续刷新。' },
        server: { tone: 'danger', ico: IC.alert, h: '服务暂时不可用（5xx）', p: message || '后端返回错误。请检查本地服务日志后重试。' },
        net: { tone: 'danger', ico: IC.alert, h: '无法连接保险库服务', p: message || '本地服务可能未启动。请确认应用正在运行。' }
      };
      var m = map[kind] || map.server;
      return '<div class="cv-state" data-tone="' + m.tone + '" role="alert"><div class="cv-state-ico">' + m.ico + '</div><h3>' + m.h + '</h3><p>' + m.p + '</p>' +
        '<button class="cv-btn" type="button" data-act="' + reloadAct + '">' + IC.refresh + '重试</button></div>';
    }

    function emptyState(title, desc, btn) {
      return '<div class="cv-state"><div class="cv-state-ico">' + IC.vault + '</div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(desc) + '</p>' +
        (btn ? '<button class="cv-btn primary" type="button" data-act="' + btn.act + '">' + btn.icon + escapeHtml(btn.label) + '</button>' : '') + '</div>';
    }

    // ---- 健康页 ----
    function healthView() {
      var h = state.health;
      if (h.status === 'loading') return loadingBlock('正在体检（复用 · 弱口令 · 超期）…');
      if (h.status === 'error') return errorState(h.err.kind === 'rate' ? 'rate' : h.err.kind === 'locked' ? 'locked' : h.err.kind === 'net' ? 'net' : 'server', h.err.message, 'reload-health');
      if (h.status === 'idle') return loadingBlock('正在准备体检…');
      var n = h.norm || normalizeHealth({});
      var reuse = n.reuse, weak = n.weak, overdue = h.overdue || [];
      var summary = '<div class="cv-health-summary">' +
        statTile(reuse.length ? 'danger' : 'ok', reuse.length, '复用口令组') +
        statTile(weak.length ? 'warn' : 'ok', n.counts.weak, '弱口令条数') +
        statTile(overdue.length ? 'warn' : 'muted', overdue.length, '超期未换（>' + overdueDays + '天）') + '</div>';
      return summary +
        hSection('口令复用', 'danger', IC.copy, reuse.length ? '共 ' + reuse.length + ' 组' : null, reuseBlock(reuse)) +
        hSection('弱口令', 'warn', IC.shield, weak.length ? '共 ' + n.counts.weak : null, weakBlock(weak)) +
        hSection('超期未换', 'warn', IC.clock, overdue.length ? '共 ' + overdue.length : null, overdueBlock(overdue));
    }
    function statTile(tone, num, lbl) { return '<div class="cv-stat" data-tone="' + tone + '"><div class="cv-stat-num">' + num + '</div><div class="cv-stat-lbl">' + escapeHtml(lbl) + '</div></div>'; }
    function hSection(title, tone, icon, badge, body) {
      return '<section class="cv-hsec" data-tone="' + tone + '"><h3>' + icon + escapeHtml(title) + (badge ? '<span class="cv-hsec-badge">' + escapeHtml(badge) + '</span>' : '') + '</h3><div class="cv-hsec-body">' + body + '</div></section>';
    }
    function hEmpty(msg, icon) { return '<div class="cv-hempty">' + (icon || IC.check) + '<span>' + escapeHtml(msg) + '</span></div>'; }
    function reuseBlock(reuse) {
      if (!reuse.length) return hEmpty('没有口令被多处复用。', IC.check);
      return reuse.map(function (g) {
        return '<div class="cv-hrow"><span class="cv-hrow-title">' + escapeHtml(g.label) + '</span>' +
          '<span class="cv-hrow-why">' + escapeHtml(g.items.map(function (it) { return it.title; }).join('、')) + '</span>' +
          '<span class="cv-hrow-act">' + g.items.map(function (it) { return it.id ? '<button class="cv-btn ghost small" type="button" data-act="edit" data-id="' + escapeHtml(it.id) + '">' + IC.edit + '查看</button> ' : ''; }).join('') + '</span></div>';
      }).join('');
    }
    function weakBlock(weak) {
      if (!weak.length) return hEmpty('没有检测到弱口令。', IC.check);
      return weak.map(function (it) {
        return '<div class="cv-hrow"><span class="cv-hrow-title">' + escapeHtml(it.title) + '</span>' +
          '<span class="cv-hrow-why">建议用生成器换成长随机口令</span>' +
          '<span class="cv-hrow-act">' + (it.id ? '<button class="cv-btn small" type="button" data-act="edit" data-id="' + escapeHtml(it.id) + '">' + IC.wand + '修复</button>' : '') + '</span></div>';
      }).join('');
    }
    function overdueBlock(overdue) {
      if (!overdue.length) return hEmpty('所有口令都在有效期内。', IC.check);
      return overdue.map(function (c) {
        return '<div class="cv-hrow"><span class="cv-hrow-title">' + escapeHtml(c.title) + '</span>' +
          '<span class="cv-hrow-why">上次更新 ' + escapeHtml(fmtDate(c.updatedAt || c.createdAt)) + '</span>' +
          '<span class="cv-hrow-act"><button class="cv-btn small" type="button" data-act="edit" data-id="' + escapeHtml(c.id) + '">' + IC.edit + '更新</button></span></div>';
      }).join('');
    }

    // ---- 新增/编辑弹层 + 生成器 ----
    function modalHtml() {
      var m = state.modal; var d = m.draft; var isEdit = m.mode === 'edit';
      var f = genFormFields();
      var errHtml = m.saveErr ? '<div class="cv-banner" data-kind="5xx" role="alert">' + IC.alert + '<span>' + escapeHtml(m.saveErr) + '</span></div>' : '';
      return '<div class="cv-overlay" role="presentation">' +
        '<div class="cv-modal" role="dialog" aria-modal="true" aria-labelledby="cv-modal-h" tabindex="-1">' +
        '<div class="cv-modal-head"><span class="cv-modal-ico">' + (isEdit ? IC.edit : IC.plus) + '</span><h2 id="cv-modal-h">' + (isEdit ? '编辑凭证' : '新增凭证') + '</h2>' +
        '<div class="cv-spacer" style="flex:1"></div><button class="cv-ghost-ico" type="button" data-act="modal-cancel" aria-label="关闭弹层">' + IC.x + '</button></div>' +
        '<div class="cv-modal-body">' + errHtml +
          '<div class="cv-form-grid">' +
            field('cv-f-title', '标题 *', 'text', d.title, '如 OpenAI 生产 Key', true) +
            field('cv-f-user', '用户名 / 账号', 'text', d.username, '邮箱或账号', false, true) +
            field('cv-f-url', '网址', 'text', d.url, 'https://…', false, false, true) +
            field('cv-f-folder', '文件夹', 'text', d.folder, '如 工作 / 个人', false) +
            field('cv-f-tags', '标签', 'text', Array.isArray(d.tags) ? d.tags.join(', ') : d.tags, '逗号分隔，如 ai,paid', false, false, false, 'span2') +
          '</div>' +
          pwField(d) +
          totpField(d) +
          '<div class="cv-field"><label class="cv-label" for="cv-f-note">备注</label><textarea class="cv-textarea" id="cv-f-note" placeholder="用途、绑定设备等（揭示口令时一并显示）">' + escapeHtml(d.note) + '</textarea></div>' +
          f +
        '</div>' +
        '<div class="cv-modal-foot"><button class="cv-btn ghost" type="button" data-act="modal-cancel">取消</button><div style="flex:1"></div>' +
        '<button class="cv-btn primary" type="button" data-act="modal-save"' + (m.saving ? ' disabled' : '') + '>' + (m.saving ? '保存中…' : (isEdit ? '保存修改' : '创建凭证')) + '</button></div>' +
        '</div></div>';
    }

    function field(id, label, type, val, ph, autofocus, mono, url, span) {
      return '<div class="cv-field ' + (span || '') + '"' + (span === 'span2' ? ' style="grid-column:1/-1"' : '') + '>' +
        '<label class="cv-label" for="' + id + '">' + escapeHtml(label) + '</label>' +
        '<input class="cv-input' + (mono ? ' mono' : '') + '" id="' + id + '" type="' + (url ? 'url' : type) + '" value="' + escapeHtml(val) + '"' +
        (ph ? ' placeholder="' + escapeHtml(ph) + '"' : '') + (autofocus ? ' data-autofocus' : '') +
        (url ? ' spellcheck="false" autocomplete="off"' : '') + '></div>';
    }
    function pwField(d) {
      return '<div class="cv-field"><label class="cv-label" for="cv-f-pw">口令 / 密钥' + '</label>' +
        '<div class="cv-pw-wrap"><input class="cv-input mono" id="cv-f-pw" type="password" autocomplete="new-password" spellcheck="false" placeholder="' + (d.id ? '留空表示保持原值不变' : '粘贴或点击下方生成器') + '" value="' + escapeHtml(d.password) + '">' +
        '<div class="cv-pw-tools"><button class="cv-ghost-ico" type="button" data-act="toggle-pw-vis" aria-pressed="false" aria-label="显示口令">' + IC.eye + '</button></div></div>' +
        '<div class="cv-meter" id="cv-f-pw-meter"><i></i></div><div class="cv-meter-label" id="cv-f-pw-meter-label">' + (d.id ? '留空表示保持不变' : '尚未输入') + '</div></div>';
    }
    function totpField(d) {
      return '<div class="cv-field"><label class="cv-label" for="cv-f-totp">动态码密钥（TOTP secret，可选）</label>' +
        '<input class="cv-input mono" id="cv-f-totp" type="text" autocomplete="off" spellcheck="false" placeholder="粘贴 TOTP Base32 密钥（留空保持不变）"></div>';
    }

    function genFormFields() {
      var m = state.modal; var g = m.gen;
      var policyState = m.policyState;
      var policyNote =
        policyState === 'loading' ? '<div class="cv-policy-note">' + IC.info + '<span>正在读取站点口令规则…</span></div>' :
        policyState === 'ready' ? '<div class="cv-policy-note" data-available="1">' + IC.shield + '<span>已套用站点规则：长度 ' + g.min + '–' + g.max + (g.note ? '；' + escapeHtml(g.note) : '') + '</span></div>' :
        policyState === 'fallback' ? '<div class="cv-policy-note">' + IC.info + '<span>站点规则不可用，使用默认规则。</span></div>' :
        '<div class="cv-policy-note">' + IC.info + '<span>填写网址后编辑将尝试读取站点规则（当前按默认）。</span></div>';
      var range = '<div class="cv-gen">' +
        '<div class="cv-gen-head">' + IC.wand + '<h4>口令生成器</h4></div>' +
        '<div class="cv-gen-out" role="textbox" tabindex="0" aria-label="生成的口令">' + escapeHtml(g.output || '—') + '</div>' +
        '<div class="cv-meter cv-gen-meter" style="margin-top:8px"><i></i></div><div class="cv-meter-label"><span>强度</span><span class="cv-gen-meter-label"></span></div>' +
        '<div class="cv-gen-acts"><button class="cv-btn" type="button" data-act="gen-regen">' + IC.refresh + '重新生成</button>' +
        '<button class="cv-btn ghost" type="button" data-act="gen-copy">' + IC.copy + '复制</button>' +
        '<button class="cv-btn primary" type="button" data-act="gen-apply">' + IC.key + '填入口令框</button></div>' +
        '<div class="cv-gen-ctrls">' +
          '<div class="cv-range-row"><label class="cv-label" for="cv-gen-len" style="margin:0;white-space:nowrap">长度</label>' +
          '<input type="range" id="cv-gen-len" min="' + g.min + '" max="' + g.max + '" value="' + g.length + '">' +
          '<span class="cv-range-val">' + g.length + '</span></div>' +
          '<div class="cv-toggles">' +
          toggle('upper', '大写字母', 'A–Z', g.upper) + toggle('lower', '小写字母', 'a–z', g.lower) +
          toggle('digit', '数字', '0–9', g.digit) + toggle('symbol', '符号', '!@#$', g.symbol) +
          '</div>' +
          '<label class="cv-toggle"><input type="checkbox" class="cv-gen-conf"' + (g.noConfusable ? ' checked' : '') + '>排除易混字符 <code>Il1O0o</code></label>' +
          policyNote +
        '</div></div>';
      return range;
    }
    function toggle(key, label, code, checked) {
      return '<label class="cv-toggle"><input type="checkbox" class="cv-gen-class" data-gen-key="' + key + '"' + (checked ? ' checked' : '') + '>' + label + ' <code>' + code + '</code></label>';
    }

    // =========================================================================
    // 读取辅助 / 过滤
    // =========================================================================
    function byId(id) { for (var i = 0; i < state.list.length; i++) if (state.list[i].id === id) return state.list[i]; return null; }
    function filteredList() {
      var q = state.filters.q.toLowerCase(); var fo = state.filters.folder; var tg = state.filters.tag;
      return state.list.filter(function (c) {
        if (fo && c.folder !== fo) return false;
        if (tg && c.tags.indexOf(tg) === -1) return false;
        if (q) { var hay = (c.title + ' ' + c.username + ' ' + c.url).toLowerCase(); if (hay.indexOf(q) === -1) return false; }
        return true;
      });
    }
    function uniqueFolders() { var s = []; state.list.forEach(function (c) { if (c.folder && s.indexOf(c.folder) === -1) s.push(c.folder); }); return s; }
    function uniqueTags() { var s = []; state.list.forEach(function (c) { c.tags.forEach(function (t) { if (s.indexOf(t) === -1) s.push(t); }); }); return s; }
    function filterSelect(id, placeholder, options, cur) {
      var os = options.map(function (o) { return '<option value="' + escapeHtml(o) + '"' + (o === cur ? ' selected' : '') + '>' + escapeHtml(o) + '</option>'; }).join('');
      return '<select class="cv-select" id="' + id + '" aria-label="' + escapeHtml(placeholder) + '" style="max-width:150px"><option value=""' + (!cur ? ' selected' : '') + '>' + escapeHtml(placeholder) + '</option>' + os + '</select>';
    }
    function capDot(on, icon, label) { return '<span class="cv-capdot" data-on="' + (on ? '1' : '0') + '" title="' + label + (on ? '' : '（无）') + '" aria-label="' + label + (on ? '' : ' 无') + '" role="img">' + icon + '</span>'; }
    function fmtDate(v) { if (!v) return '—'; var t = Date.parse(v); if (isNaN(t)) return '—'; var d = new Date(t); var now = new Date(); var p = function (x) { return (x < 10 ? '0' : '') + x; }; return (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-') + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
    function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }
    function shallowMerge(a, b) { var o = {}; Object.keys(a).forEach(function (k) { o[k] = a[k]; }); Object.keys(b).forEach(function (k) { o[k] = b[k]; }); return o; }
    function renderListOnly() {
      if (state.status === 'unlocked' && state.activeTab === 'list') {
        var b = mountPoint.querySelector('#cv-list-body');
        if (b) { b.innerHTML = listBody(); syncTotpCells(); return; } // 保留搜索框/筛选焦点
      }
      render();
    }

    // 暴露给外部：刷新 / 状态 / 卸载
    var apiObj = { destroy: destroy, refresh: function () { if (state.status === 'unlocked') loadList(); }, getState: function () { return state; }, version: VERSION };
    return apiObj;
  }

  // =========================================================================
  // 内置假 fetch：返回上述各态数据，供自测 / 手工验收（不依赖后端）
  // CV_MOCK.setMode('423'|'429'|'5xx'|'empty'|'locked'|'normal') 逼出确定态
  // =========================================================================
  var MOCK = (function () {
    var mode = 'normal';
    var setupDone = false, locked = true, pw = '';
    var RECOVERY = '7QF2-KDM8-XPA1\n9ZR4-VTB6-LNE3\nHJK9-WQ2X-5M4C';
    var now = Date.now();
    function ago(days) { return new Date(now - days * 86400000).toISOString(); }
    var creds = [
      { id: 'c1', title: 'OpenAI 生产', username: 'sk-prod@corp', url: 'https://platform.openai.com', folder: '工作', tags: ['ai', 'paid'], createdAt: ago(200), updatedAt: ago(210), lastUsedAt: ago(1), hasPassword: true, hasSecret: true, hasTotp: false, hasNote: true },
      { id: 'c2', title: 'AWS 控制台', username: 'ops@corp', url: 'https://console.aws.amazon.com', folder: '工作', tags: ['cloud'], createdAt: ago(400), updatedAt: ago(300), lastUsedAt: ago(20), hasPassword: true, hasSecret: false, hasTotp: true, hasNote: false },
      { id: 'c3', title: 'GitHub PAT', username: 'yqq-bot', url: 'https://github.com/settings/tokens', folder: '开发', tags: ['git', 'ci'], createdAt: ago(60), updatedAt: ago(5), lastUsedAt: ago(0), hasPassword: true, hasSecret: true, hasTotp: false, hasNote: false },
      { id: 'c4', title: '旧共享口令账号', username: 'test@corp', url: 'https://example.com', folder: '个人', tags: ['demo'], createdAt: ago(120), updatedAt: ago(190), lastUsedAt: ago(80), hasPassword: true, hasSecret: false, hasTotp: true, hasNote: true }
    ];
    function res(status, body) { return Promise.resolve({ ok: status >= 200 && status < 300, status: status, json: function () { return Promise.resolve(body); } }); }
    function guardLocked() { if (locked && mode !== 'normal' || (locked && mode === 'locked')) { } }
    function fetchMock(url, init) {
      init = init || {}; var method = (init.method || 'GET').toUpperCase(); var u = String(url);
      // 状态模式短路
      if (mode === '423') return res(423, { error: '保险库未解锁' });
      if (mode === '429') return res(429, { error: '操作过于频繁' });
      if (mode === '5xx') return res(503, { error: '服务暂不可用' });
      if (mode === 'net') return Promise.reject(new Error('network down'));
      // 金库控制
      if (u.indexOf('/api/vault/status') !== -1) return res(200, { needsSetup: !setupDone, unlocked: !locked });
      if (u.indexOf('/api/vault/init') !== -1) { setupDone = true; locked = false; pw = (init.body ? JSON.parse(init.body).password : pw); return res(200, { ok: true, recoveryCode: RECOVERY }); }
      if (u.indexOf('/api/vault/unlock') !== -1) { if (!setupDone) return res(423, { error: '保险库未解锁' }); locked = false; return res(200, { ok: true }); }
      if (u.indexOf('/api/vault/lock') !== -1) { locked = true; return res(200, { ok: true }); }
      // 列表
      if (/\/api\/credentials(\?|$)/.test(u) && method === 'GET') {
        if (locked) return res(423, { error: '保险库未解锁' });
        if (mode === 'empty') return res(200, []);
        return res(200, creds.map(function (c) { return Object.assign({}, c); }));
      }
      // 揭示
      var mv = u.match(/\/api\/credentials\/([^/]+)\/reveal$/);
      if (mv) { if (locked) return res(423, { error: '保险库未解锁' }); var id = decodeURIComponent(mv[1]); return res(200, { password: id + '-Sup3r#Secret!x', note: '这是 ' + id + ' 的备注，揭示后随明文一并显示。', totpSecret: 'JBSWY3DPEHPK3PXP' }); }
      // totp
      var mt = u.match(/\/api\/credentials\/([^/]+)\/totp$/);
      if (mt) { if (locked) return res(423, { error: '保险库未解锁' }); var sec = 5 + (Date.now() / 1000 | 0) % 25; return res(200, { code: String(100000 + (Date.now() / 1000 | 0) % 900000), secondsRemaining: sec, digits: 6 }); }
      // health
      if (/\/api\/credentials\/health/.test(u)) {
        if (locked) return res(423, { error: '保险库未解锁' });
        return res(200, { reuse: [{ label: '口令 “Passw0rd!” 被 2 处复用', items: [{ id: 'c2', title: 'AWS 控制台' }, { id: 'c4', title: '旧共享口令账号' }] }], weakCount: 1, weak: [{ id: 'c4', title: '旧共享口令账号', reason: '常见词' }] });
      }
      // 站点规则（best-effort）
      var mp = u.match(/\/api\/credentials\/([^/]+)\/password-policy$/);
      if (mp) { var pid = decodeURIComponent(mp[1]); if (pid === 'c1') return res(200, { minLength: 12, maxLength: 40, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true, excludeConfusable: true, note: 'OpenAI 规则' }); return res(404, { error: 'no policy' }); }
      // CRUD
      if (method === 'POST' && /\/api\/credentials$/.test(u)) { if (locked) return res(423, { error: '保险库未解锁' }); var nb = JSON.parse(init.body); var nc = Object.assign({ id: 'n' + Date.now(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastUsedAt: null, hasSecret: false, hasTotp: !!(nb.totpSecret), hasNote: !!nb.note, hasPassword: !!nb.password }, nb, { tags: nb.tags || [] }); creds.push(nc); return res(201, nc); }
      var mu = u.match(/\/api\/credentials\/([^/]+)$/);
      if (mu && (method === 'PUT' || method === 'DELETE')) {
        if (locked) return res(423, { error: '保险库未解锁' });
        var uid = decodeURIComponent(mu[1]);
        if (method === 'DELETE') { creds = creds.filter(function (c) { return c.id !== uid; }); return res(200, { ok: true }); }
        var ub = JSON.parse(init.body); for (var i = 0; i < creds.length; i++) if (creds[i].id === uid) { creds[i] = Object.assign(creds[i], ub, { id: uid, updatedAt: new Date().toISOString() }); break; }
        return res(200, creds[i]);
      }
      return res(404, { error: 'not found' });
    }
    fetchMock.setMode = function (m) { mode = m; };
    fetchMock.reset = function () { mode = 'normal'; locked = true; };
    fetchMock.getState = function () { return { mode: mode, locked: locked, setupDone: setupDone }; };
    return fetchMock;
  })();

  // =========================================================================
  // 导出（classic script -> window；node require 兜底；type=module 亦可读 globalThis）
  // =========================================================================
  var API = {
    version: VERSION,
    mountCredentialsView: mountCredentialsView,
    CV_MOCK: MOCK,
    __internals: {
      escapeHtml: escapeHtml, classifyStatus: classifyStatus, parseList: parseList,
      rateMessage: rateMessage, retryText: retryText, secretRowInner: secretRowInner,
      revealState: revealState, REVEAL_FIELDS: REVEAL_FIELDS,
      generatePassword: generatePassword, applyPolicy: applyPolicy, strengthBits: strengthBits,
      normalizeHealth: normalizeHealth, isOverdue: isOverdue, hostOf: hostOf, clamp: clamp, formatCode: formatCode,
      submitPayload: submitPayload
    }
  };
  global.CredentialsView = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
