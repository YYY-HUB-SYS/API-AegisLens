const adapters = require('./adapters');
const enrich = require('./enrich');
const META_MODELS = require('./meta-models.json');
const { vaultMode, unlockDek, enablePassphraseWith, changePassphrase, loadOrCreateMasterKey, zeroSecret, discardRawDek, hasRawMasterKey } = require('./crypto');
const { createRecoveryKey, createRecoveryEnvelope, rotateRecoveryEnvelope, openRecoveryEnvelope, readRecoveryEnvelope, formatRecoveryKey } = require('./recovery');
const { maskedKeyView } = require('./vault');
const { handleCredentialsApi } = require('./credentials-api');
const { handleConsumerApi } = require('./consumer-api');

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

/* 端点可由调用方按序号指定：默认仍是第 0 条（向后兼容）。
   越界必须报错，不能悄悄退回第一条——「以为测了其实没测」就是这么来的 */
function endpointAt(k, raw) {
  const eps = (k.endpoints && k.endpoints.length) ? k.endpoints : [adapters.primaryEndpoint(k)];
  let i = 0;
  if (raw !== undefined && raw !== null && raw !== '') {
    i = Number(raw);
    if (!Number.isInteger(i) || i < 0 || i >= eps.length) {
      throw bad(400, '端点序号不存在：该密钥共 ' + eps.length + ' 个端点');
    }
  }
  return { ep: eps[i], idx: i };
}

/* 自动名只取末 4 位：卡片头部已有平台标签，再把平台名嵌进名字就是同一串念两遍。
   查重按「平台 + 名字」，同平台末 4 位撞车时返回 409 明说，由用户手动改名 */
function autoName(keyValue) {
  return keyValue.length >= 4 ? keyValue.slice(-4) : keyValue;
}

function str(v) { return String(v == null ? '' : v).trim(); }

/* 账号池只持久化成员 id；给前端展示时现取完整密钥记录，池里某个密钥已被删除时
   过滤掉而不把 null 塞进 keys 数组。keys 走掩码视图：池子一旦回明文，
   「堵 GET /api/keys」就变成「改打 GET /api/pools」，等于没堵 */
function poolWithKeys(storage, pool) {
  const rec = Object.assign({}, pool);
  rec.keys = (pool.keyIds || [])
    .map(function (id) { return storage.getKey(id); })
    .filter(Boolean)
    .map(maskedKeyView);
  return rec;
}

/* 限流按来源地址分桶。服务只绑 127.0.0.1 时这里恒为回环地址，
   将来放开局域网监听时它就是每设备一桶，不需要再改一遍。 */
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

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

/* 导入的是人手带过来的文件，可能带着修复前 PATCH 造出来的组合：src=manual 却两个字段都写着 'api'。
   这种组合 PATCH 现在产不出来，留在库里只会让前端一直按脏行降级显示。导入时就地补平 ——
   究竟改过哪个字段已无从考证，宁可少说一个来源，也不谎称那是平台报的。 */
function sanitizeImportedModel(m) {
  if (!m || typeof m !== 'object' || m.src !== 'manual') return m;
  if (m.ctxSrc === 'manual' || m.outSrc === 'manual') return m;
  const r = Object.assign({}, m);
  if (r.ctx != null) r.ctxSrc = 'manual';
  if (r.out != null) r.outSrc = 'manual';
  return r;
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

/* ================= 可被定时器复用的执行路径 =================
   测试与批量刷新原先只活在路由里，定时器要跑同一条路就得把这段逻辑抄一遍——
   抄一份就会改一份，所以核心函数放在路由之外，路由只做 HTTP 拆装。 */

async function testKeyAt(storage, k, rawIndex, opts) {
  const at = endpointAt(k, rawIndex);
  const test = await adapters.testKey(k.platform, at.ep, k.key, { fetchImpl: opts && opts.fetchImpl });
  test.epIndex = at.idx;
  test.epUrl = at.ep.url;
  test.epStyle = at.ep.style;
  return storage.saveTest(k.id, test);
}

async function refreshBalances(storage, opts) {
  const fetchImpl = opts && opts.fetchImpl;
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
      storage.saveBalance(k.id, { value: null, status: 'fail', msg: e.message });
      failed++;
    }
  }
  return { keys: storage.listKeys().map(maskedKeyView), updated: updated, failed: failed };
}

/* 下限挡住「每秒朝全部厂商打一轮」，上限挡住配成一年一跑的定时器；调度器与接口共用这一对数 */
const SCHEDULE_INTERVAL_MIN_MINUTES = 1;
const SCHEDULE_INTERVAL_MAX_MINUTES = 7 * 24 * 60;

async function routeApi(req, res, ctx) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  const storage = ctx.storage;
  const fetchImpl = ctx.fetchImpl;
  const vault = ctx.vault;
  const throttle = ctx.throttle;
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
      metaModels: META_MODELS._updated || null,
      storage: storage.backend,
      dataDir: storage.dataDir,
      shadowStore: storage.shadowStore || null
    });
  }

  /* ── 保险库会话 ──
     免密老安装永远 unlocked（openLegacy），设了口令之后才是真闸门。
     这一层只挡「明文出不出得去」，解密能力一直在 store 里，不假装它是加密边界。 */
  if (req.method === 'GET' && path === '/api/vault/status') {
    return json(res, 200, {
      unlocked: vault.isUnlocked(),
      mode: vault.mode(),
      passphraseSet: vaultMode(storage.dataDir) === 'envelope',
      /* 「拷走整个目录就能解」这件事到底还成不成立，看这一位：它说的是明文 DEK 副本在不在，
         不是口令设没设——设了口令但没拆 master.key，两者同时为真 */
      rawKeyPresent: hasRawMasterKey(storage.dataDir),
      /* 视图靠这个字段决定进「设置口令」还是「解锁」屏。凭证库强制要口令：
         给网站密码开免密，就是我们要改掉的那个毛病 */
      needsSetup: vaultMode(storage.dataDir) !== 'envelope',
      idleRemainingMs: vault.idleRemaining(),
      recent: vault.audit.list().slice(-8)
    });
  }

  if (req.method === 'POST' && path === '/api/vault/unlock') {
    const gateKey = 'unlock:' + clientIp(req);
    const gate = throttle.unlock.check(gateKey);
    if (!gate.allowed) {
      vault.audit.push({ kind: 'unlock', status: 'denied', detail: 'throttled' });
      return json(res, 429, { error: '解锁尝试过于频繁，请稍后再试', retryAfterMs: gate.retryAfterMs });
    }
    /* 已经开着、且 store 真的建起来了，才允许幂等放行：否则界面上任何一次误点都会
       消耗一次失败额度。只看会话不看 store，会放行「状态说已解锁、数据却全 423」的半死态 */
    if (vault.isUnlocked() && storage.backend) return json(res, 200, { unlocked: true, mode: vault.mode() });
    const b = await readBody(req);
    let opened;
    try {
      opened = unlockDek(storage.dataDir, str(b.passphrase));
    } catch (e) {
      throttle.unlock.failed(gateKey);
      vault.audit.push({ kind: 'unlock', status: 'fail', detail: String(e.message).slice(0, 60) });
      return json(res, 400, { error: e.message });
    }
    /* store 的建与会话的接必须一次做完（宿主里 openStore 干这两件事）：
       这里先 attach 再让宿主 attach 一次，第二次会把同一把 DEK 清零给 store */
    ctx.onUnlock(opened.dek, opened.mode);
    throttle.unlock.passed(gateKey);
    return json(res, 200, { unlocked: true, mode: opened.mode });
  }

  if (req.method === 'POST' && path === '/api/vault/lock') {
    const was = vault.isUnlocked();
    ctx.onLock();
    return json(res, 200, { locked: true, wasUnlocked: was });
  }

  /* 设完口令后当前会话仍可用（DEK 已在手），但开机即锁要等重启才生效——
     不写成 restartRequired 就是骗用户「现在就安全了」。
     首次设口令同时发恢复信封：恢复码不落盘，这一次显示就是用户唯一的抄录机会 */
  if (req.method === 'POST' && path === '/api/vault/passphrase') {
    const b = await readBody(req);
    const hasVault = vaultMode(storage.dataDir) === 'envelope';
    /* 改口令要先验 current，所以它得有自己的限流档：没有上限就等于把「拿真凭据无限次验
       scrypt」这件事从最松的那扇门重做一遍。
       🔴 但不许挂到 unlock 那一档上——这条路只有在保险库**已解锁**时才走得通，
       用户在改口令框里打错两次就把解锁的 5 次额度烧光，等于空闲自动锁之后连门都进不去，
       而那时他其实一次都没试过解锁。自伤不是防御。 */
    const pwGateKey = 'passphrase:' + clientIp(req);
    if (hasVault) {
      const pwGate = throttle.passphrase.check(pwGateKey);
      if (!pwGate.allowed) {
        vault.audit.push({ kind: 'passphrase', status: 'denied', detail: 'throttled' });
        return json(res, 429, { error: '口令校验过于频繁，请稍后再试', retryAfterMs: pwGate.retryAfterMs });
      }
    }
    let recoveryCode = null;
    try {
      if (hasVault) {
        changePassphrase(storage.dataDir, str(b.current), str(b.next));
      } else {
        const dek = loadOrCreateMasterKey(storage.dataDir);
        enablePassphraseWith(storage.dataDir, dek, str(b.next));
        recoveryCode = createRecoveryEnvelope(storage.dataDir, dek, createRecoveryKey()).display;
        zeroSecret(dek);
      }
    } catch (e) {
      if (hasVault) throttle.passphrase.failed(pwGateKey);
      vault.audit.push({ kind: 'passphrase', status: 'fail', detail: String(e.message).slice(0, 60) });
      const st = /解锁口令不正确/.test(String(e.message)) ? 403 : 400;
      return json(res, st, { error: e.message });
    }
    if (hasVault) throttle.passphrase.passed(pwGateKey);
    vault.audit.push({ kind: 'passphrase', status: 'ok', detail: hasVault ? 'changed' : 'set' });
    return json(res, 200, {
      ok: true,
      result: hasVault ? 'changed' : 'set',
      restartRequired: true,
      recoveryCode: recoveryCode
    });
  }

  /* 忘口令的出口：恢复码解出 DEK → 用新口令重新封装 → 旧恢复码当场作废换新的。
     全程在锁定态可用（否则这条路就没意义），并复用解锁那一档限流 */
  if (req.method === 'POST' && path === '/api/vault/recover') {
    const b = await readBody(req);
    const gateKey = 'unlock:' + clientIp(req);
    const gate = throttle.unlock.check(gateKey);
    if (!gate.allowed) {
      vault.audit.push({ kind: 'recover', status: 'denied', detail: 'throttled' });
      return json(res, 429, { error: '恢复尝试过于频繁，请稍后再试', retryAfterMs: gate.retryAfterMs });
    }
    let env;
    try {
      env = readRecoveryEnvelope(storage.dataDir);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
    if (!env) {
      return json(res, 409, { error: '本机没有恢复信封，无法用恢复码重置口令' });
    }
    let dek;
    let recoveryCodeOut = null;
    try {
      dek = openRecoveryEnvelope(env, str(b.recoveryCode));
      enablePassphraseWith(storage.dataDir, dek, str(b.next));
      const rotated = rotateRecoveryEnvelope(storage.dataDir, dek);
      recoveryCodeOut = formatRecoveryKey(rotated.key);
    } catch (e) {
      if (dek) zeroSecret(dek);
      throttle.unlock.failed(gateKey);
      vault.audit.push({ kind: 'recover', status: 'fail', detail: String(e.message).slice(0, 60) });
      return json(res, 400, { error: e.message });
    }
    ctx.onUnlock(dek, 'envelope');
    throttle.unlock.passed(gateKey);
    vault.audit.push({ kind: 'recover', status: 'ok', detail: 'code' });
    /* restartRequired 这里必须是 false：store 已当场建好，解锁状态立刻生效。
       写 true 会让界面告诉用户「要重启才完全生效」，那是假话 */
    return json(res, 200, { ok: true, unlocked: true, recoveryCode: recoveryCodeOut, restartRequired: false });
  }

  /* 拆掉明文 master.key 是整条链上唯一不可逆的动作：不删它，「拷走目录也解不开」
     就只是说说而已。所以要求显式 confirm，并且先用口令解一次验证通过。 */
  if (req.method === 'POST' && path === '/api/vault/discard-master-key') {
    const b = await readBody(req);
    if (b.confirm !== true) return json(res, 400, { error: '此操作不可逆，必须显式传 confirm: true' });
    try {
      discardRawDek(storage.dataDir, str(b.passphrase), { confirm: true });
    } catch (e) {
      vault.audit.push({ kind: 'discard', status: 'fail', detail: String(e.message).slice(0, 60) });
      return json(res, /解锁口令不正确/.test(String(e.message)) ? 403 : 400, { error: e.message });
    }
    vault.audit.push({ kind: 'discard', status: 'ok', detail: 'master.key removed' });
    return json(res, 200, { ok: true, discarded: true, note: '口令成为唯一入口；恢复码仍可用来重置口令' });
  }

  /* 明文唯一出口。审计只记 id，绝不记口令本身 */
  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/reveal$/.exec(path))) {
    const gateKey = 'reveal:' + clientIp(req);
    const gate = throttle.reveal.check(gateKey);
    if (!gate.allowed) {
      vault.audit.push({ kind: 'reveal', target: m[1], status: 'denied', detail: 'throttled' });
      return json(res, 429, { error: '取用过于频繁，请稍后再试', retryAfterMs: gate.retryAfterMs });
    }
    if (!vault.isUnlocked()) {
      throttle.reveal.failed(gateKey);
      vault.audit.push({ kind: 'reveal', target: m[1], status: 'denied', detail: 'locked' });
      return json(res, 423, { error: '保险库未解锁' });
    }
    const k = storage.getKey(Number(m[1]));
    if (!k) {
      throttle.reveal.failed(gateKey);
      vault.audit.push({ kind: 'reveal', target: m[1], status: 'fail', detail: 'not-found' });
      return json(res, 404, { error: '密钥不存在' });
    }
    throttle.reveal.passed(gateKey);
    vault.audit.push({ kind: 'reveal', target: k.id, status: 'ok' });
    return json(res, 200, { key: k.key, name: k.name, platform: k.platform });
  }

  if (req.method === 'GET' && path === '/api/keys') {
    /* 列表永不含明文：不带 Origin 头的一条本机 curl 过去能拿走全部 Key。
       明文改由 POST /api/keys/:id/reveal 单条按需给，受会话与限流约束并留审计 */
    return json(res, 200, { keys: storage.listKeys().map(maskedKeyView) });
  }

  if (req.method === 'POST' && path === '/api/keys') {
    const b = await readBody(req);
    const platform = str(b.platform);
    const plat = platOf(platform);
    if (!plat) throw bad(400, '未知平台：' + platform);
    const keyValue = str(b.key);
    if (!keyValue) throw bad(400, 'API Key 为必填项');
    const customName = platform === 'custom' ? (str(b.customName) || '自定义平台') : '';
    const name = str(b.name) || autoName(keyValue);
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
    return json(res, 201, { key: maskedKeyView(rec) });
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
      patch.name = autoName(patch.key || cur.key);
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
          key: maskedKeyView(storage.saveBalance(id, { value: null, status: supported ? 'pending' : 'unsupported' }))
        });
      }
    }
    return json(res, 200, { key: maskedKeyView(rec) });
  }

  if (req.method === 'DELETE' && (m = /^\/api\/keys\/(\d+)$/.exec(path))) {
    requireKey(m[1]);
    storage.deleteKey(Number(m[1]));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/test$/.exec(path))) {
    const k = requireKey(m[1]);
    const tb = await readBody(req).catch(function () { return {}; });
    const rec = await testKeyAt(storage, k, tb.endpointIndex, { fetchImpl: fetchImpl });
    return json(res, 200, { test: rec.test });
  }

  if (req.method === 'POST' && (m = /^\/api\/keys\/(\d+)\/models\/fetch$/.exec(path))) {
    const k = requireKey(m[1]);
    const fb = await readBody(req).catch(function () { return {}; });
    const fetched = await adapters.fetchModels(k.platform, endpointAt(k, fb.endpointIndex).ep, k.key, { fetchImpl: fetchImpl });
    let merged = adapters.mergeModels(k.models, fetched);
    let enrichInfo = null;
    /* 「拉模型」默认只打平台自己的 /models。原先一见到 ctx 缺失就自动联网检索，
       等于用户点一下按钮就未经确认往外发请求（用户 10-10 指出）。联网补全现在只走两条显式路径：
       这里带 enrich:true，或界面上的「联网补全」按钮（/models/enrich）。 */
    if (fb.enrich === true && merged.some(function (mm) { return mm.ctx == null; })) {
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
    /* PATCH 只能改已经存在的模型行。storage.upsertModel 的语义是「没有就建」——那是拉取
       /models 之后同步用的，拿它接 PATCH 等于允许任何人凭一条 URL 往库里凭空造一行：
       前端路径拼错、脚本循环里带错 id、导入的脏数据都会留下这么一行，而且下一句的 404
       永远走不到（getKey 已经把不存在的密钥挡在前面了），错误码还是 200。 */
    if (!(k.models || []).some(function (x) { return x && x.id === mid; })) {
      throw bad(404, '模型不存在：' + mid + '（PATCH 只改已有模型，新增请走拉取列表或手动添加）');
    }
    const ctx = parseTokens(b.ctx, '上下文');
    const out = parseTokens(b.out, '最大输出');
    const upd = { id: mid };
    if (ctx !== undefined) upd.ctx = ctx;
    if (out !== undefined) upd.out = out;
    if (ctx !== undefined) upd.ctxSrc = 'manual';
    if (out !== undefined) upd.outSrc = 'manual';
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
    return json(res, 200, await refreshBalances(storage, { fetchImpl: fetchImpl }));
  }

  if (req.method === 'GET' && (m = /^\/api\/keys\/(\d+)\/history$/.exec(path))) {
    const k = requireKey(m[1]);
    const kind = str(url.searchParams.get('kind'));
    if (kind && kind !== 'test' && kind !== 'balance') throw bad(400, 'kind 只支持 test 或 balance');
    return json(res, 200, {
      history: storage.listHistory(k.id, { kind: kind, limit: url.searchParams.get('limit') })
    });
  }

  if (req.method === 'GET' && path === '/api/schedule') {
    if (!ctx.scheduler) throw bad(404, '当前进程未挂载调度器');
    return json(res, 200, { schedule: ctx.scheduler.status() });
  }

  if (req.method === 'POST' && path === '/api/schedule') {
    if (!ctx.scheduler) throw bad(404, '当前进程未挂载调度器');
    const b = await readBody(req);
    const patch = {};
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw bad(400, 'enabled 需为 true 或 false');
      patch.enabled = b.enabled;
    }
    if (b.intervalMinutes !== undefined) {
      const n = Number(b.intervalMinutes);
      if (!Number.isFinite(n) || n < SCHEDULE_INTERVAL_MIN_MINUTES || n > SCHEDULE_INTERVAL_MAX_MINUTES) {
        throw bad(400, '间隔分钟数需在 ' + SCHEDULE_INTERVAL_MIN_MINUTES + ' 到 ' + SCHEDULE_INTERVAL_MAX_MINUTES + ' 之间');
      }
      patch.intervalMinutes = Math.round(n);
    }
    return json(res, 200, { schedule: ctx.scheduler.configure(patch) });
  }

  if (req.method === 'GET' && path === '/api/pools') {
    return json(res, 200, {
      pools: storage.listPools().map(function (p) { return poolWithKeys(storage, p); })
    });
  }

  if (req.method === 'POST' && path === '/api/pools') {
    const b = await readBody(req);
    const name = str(b.name);
    if (!name) throw bad(400, '请填写账号池名称');
    if (name.length > 40) throw bad(400, '账号池名称最长 40 字符');
    if (storage.listPools().some(function (p) { return p.name === name; })) {
      throw bad(409, '已存在同名账号池');
    }
    let keyIds = [];
    if (b.keyIds !== undefined) {
      if (!Array.isArray(b.keyIds)) throw bad(400, 'keyIds 应为数组');
      b.keyIds.forEach(function (raw) {
        const id = Number(raw);
        if (!Number.isInteger(id) || !storage.getKey(id)) throw bad(400, '密钥不存在：' + raw);
        if (keyIds.indexOf(id) < 0) keyIds.push(id);
      });
    }
    const pool = storage.createPool({ name: name, keyIds: keyIds });
    return json(res, 201, { pool: poolWithKeys(storage, pool) });
  }

  if (req.method === 'PUT' && (m = /^\/api\/pools\/(\d+)$/.exec(path))) {
    const id = Number(m[1]);
    const cur = storage.getPool(id);
    if (!cur) throw bad(404, '账号池不存在');
    const b = await readBody(req);
    const patch = {};
    if (b.name !== undefined) {
      const name = str(b.name);
      if (!name) throw bad(400, '请填写账号池名称');
      if (name.length > 40) throw bad(400, '账号池名称最长 40 字符');
      if (storage.listPools().some(function (p) { return p.id !== id && p.name === name; })) {
        throw bad(409, '已存在同名账号池');
      }
      patch.name = name;
    }
    if (b.keyIds !== undefined) {
      if (!Array.isArray(b.keyIds)) throw bad(400, 'keyIds 应为数组');
      const keyIds = [];
      b.keyIds.forEach(function (raw) {
        const kid = Number(raw);
        if (!Number.isInteger(kid) || !storage.getKey(kid)) throw bad(400, '密钥不存在：' + raw);
        if (keyIds.indexOf(kid) < 0) keyIds.push(kid);
      });
      patch.keyIds = keyIds;
    }
    if (!Object.keys(patch).length) throw bad(400, '没有可更新的字段');
    return json(res, 200, { pool: poolWithKeys(storage, storage.updatePool(id, patch)) });
  }

  if (req.method === 'DELETE' && (m = /^\/api\/pools\/(\d+)$/.exec(path))) {
    const id = Number(m[1]);
    if (!storage.getPool(id)) throw bad(404, '账号池不存在');
    storage.deletePool(id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (m = /^\/api\/pools\/(\d+)\/keys$/.exec(path))) {
    const id = Number(m[1]);
    const cur = storage.getPool(id);
    if (!cur) throw bad(404, '账号池不存在');
    const b = await readBody(req);
    const keyId = Number(b.keyId);
    if (!Number.isInteger(keyId) || !storage.getKey(keyId)) throw bad(400, '密钥不存在：' + b.keyId);
    if ((cur.keyIds || []).indexOf(keyId) >= 0) throw bad(409, '该密钥已在账号池中');
    return json(res, 200, { pool: poolWithKeys(storage, storage.addPoolKey(id, keyId)) });
  }

  if (req.method === 'DELETE' && (m = /^\/api\/pools\/(\d+)\/keys\/(\d+)$/.exec(path))) {
    const id = Number(m[1]);
    const keyId = Number(m[2]);
    if (!storage.getPool(id)) throw bad(404, '账号池不存在');
    let pool = storage.removePoolKey(id, keyId);
    if (!pool) pool = storage.getPool(id); /* key 本就不在池中：幂等返回当前池 */
    return json(res, 200, { pool: poolWithKeys(storage, pool) });
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
        const name = str(item.name) || autoName(keyValue);
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
          storage.replaceModels(rec.id, item.models.map(sanitizeImportedModel));
        }
        if (Array.isArray(item.assigned) && item.assigned.length) {
          item.assigned.forEach(function (t) {
            try { storage.addAssigned(rec.id, String(t).trim()); } catch (e) { /* 跳过重复 */ }
          });
        }
        imported.push(maskedKeyView(storage.getKey(rec.id)));
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

  /* 消费者令牌子模块own /api/consumer/* 全部路径（管理面 + 机器面都在它那里），
     返回 false 才继续往下走。bad 的适配同 credentials：它那边是「响应器」不是「造 Error」。
     testKeyAt 从这里注入而不是让它 require('./api')——那样会绕回一个循环依赖。 */
  if (path.indexOf('/api/consumer') === 0) {
    /* 子模块认不出的 /api/consumer/* 也得有条回话。早先这里是 `return handleConsumerApi(...)`，
       它返回 false 时 routeApi 直接 resolve，谁都没写响应——`GET /api/consumer/keys`
       （少打一个 id，正是机器消费者最容易敲错的一条）会挂到客户端自己超时，
       服务端既不回 404 也不关连接。 */
    if (await handleConsumerApi(req, res, {
      storage: storage,
      vault: vault,
      throttle: throttle.token,
      json: json,
      readBody: readBody,
      fetchImpl: fetchImpl,
      testKeyAt: testKeyAt,
      bad: function (res2, status, message, extra) {
        return json(res2, status, Object.assign({ error: message }, extra || {}));
      }
    })) return;
    return json(res, 404, { error: '接口不存在' });
  }

  /* 凭证子模块own自己的应答，返回 false 才落到下面的 404。
     它的 bad 是「响应器」而不是我这边的「造 Error」，所以在这里适配一层，
     不去改它的文件；限流单独用 credential 那一档，不和 Key 的 reveal 共用额度。 */
  if (path === '/api/credentials' || path.indexOf('/api/credentials/') === 0) {
    return handleCredentialsApi(req, res, {
      storage: storage,
      vault: vault,
      throttle: throttle.credential,
      json: json,
      readBody: readBody,
      bad: function (res2, status, message, extra) {
        return json(res2, status, Object.assign({ error: message }, extra || {}));
      }
    });
  }

  return json(res, 404, { error: '接口不存在' });
}

/* 这三条不证明「有人在用保险库」：平台表与元数据是公开只读，/api/vault/status 是页面在轮询。
   连它们都续期的话，一个本机脚本光靠轮询就能把会话永远开着，自动锁形同没有。 */
const PASSIVE_PATHS = { '/api/platforms': 1, '/api/meta': 1, '/api/vault/status': 1 };

/* 只抹「不是我们写的话」。第一版按 status>=500 一刀切，结果当场打死两条正常测试：
   adapters 抛的是「模型列表接口不存在（HTTP 404）…」「密钥无效或无权限（HTTP 401）…」这类
   **给人看的**中文说明，但它们不带 httpStatus，于是被归成 500 一起抹平了。
   真正会泄内部话的是引擎与编程故障：SQLite 报错、undefined 取属性、ENOENT 之类。
   判据用错误类型 + 引擎消息特征，而不是状态码。 */
const ENGINE_FAULT = /^(SQLITE_|ERR_[A-Z_]+|ENOENT|EPERM|EACCES|EEXIST|TypeError|RangeError)|Cannot read propert|is not a function|Unexpected (token|end of input)|Invalid URL|too many open files/;

function isEngineFault(e) {
  if (e && e.httpStatus) return false;                     // 我们自己抛的，消息是写给人看的
  if (e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError) return true;
  return ENGINE_FAULT.test(String((e && e.message) || ''));
}

async function apiRouter(req, res, ctx) {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  try {
    if (req.method !== 'GET' && !sameOrigin(req)) {
      return json(res, 403, { error: '拒绝跨域写请求' });
    }
    await routeApi(req, res, ctx);
    /* 真的读到/写到数据才算「人还在用」——主界面的操作不经 vault.key()（解密在 store 里），
       以前只有凭证与令牌路径会续期，结果用户在密钥看板上忙到一半就被 5 分钟锁掉。
       放在 routeApi 之后：423 之类的失败不该续期。 */
    if (!PASSIVE_PATHS[path] && ctx.vault && ctx.vault.touch) ctx.vault.touch();
  } catch (e) {
    const status = e.httpStatus || 500;
    const leaky = isEngineFault(e);
    if (leaky) console.error('[api] ' + req.method + ' ' + path + ' → ' + (e.stack || e.message));
    try {
      json(res, status, { error: leaky ? '服务器内部错误' : (e.message || '请求无效') });
    } catch (e2) { /* 响应已发出 */ }
  }
}

module.exports = {
  apiRouter: apiRouter,
  refreshBalances: refreshBalances,
  testKeyAt: testKeyAt,
  isEngineFault: isEngineFault,
  SCHEDULE_INTERVAL_MIN_MINUTES: SCHEDULE_INTERVAL_MIN_MINUTES,
  SCHEDULE_INTERVAL_MAX_MINUTES: SCHEDULE_INTERVAL_MAX_MINUTES
};
