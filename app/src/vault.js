/* 保险库会话层：解锁状态、闲置自动锁、失败限流、reveal 审计、脱敏视图。
   刻意不 require api.js/storage.js——接入点是 api 层一行调用，这里只保证可单测。 */

const DEFAULT_IDLE_LOCK_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FAILS = 5;
const DEFAULT_LOCK_MS = 5 * 60 * 1000;
/* 限流桶的清扫节奏：每 64 次写入扫一遍，最多留 4096 个键（约几百 KB）。
   见 createThrottle 里那段注释——正常单机用不到上限那一层，它是撒地址攻击下的兜底。 */
const DEFAULT_SWEEP_EVERY = 64;
const DEFAULT_MAX_BUCKETS = 4096;
const DEFAULT_AUDIT_MAX = 200;
const CREDENTIAL_SECRET_FIELDS = ['passwordEnc', 'secretEnc', 'totpEnc', 'noteEnc'];

function vaultError(message, status) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/* 审计只记「谁在什么时候对哪条做过什么」，绝不记内容：
   一旦把明文塞进 detail，等于把刚堵上的泄露面从响应体搬到日志。 */
function createAuditSink(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const max = numOr(o.maxEntries, DEFAULT_AUDIT_MAX);
  const entries = [];
  return {
    push: function (evt) {
      const row = {
        at: typeof o.at === 'function' ? o.at() : now(),
        kind: String(evt.kind),
        target: evt.target === undefined || evt.target === null ? null : String(evt.target),
        status: String(evt.status),
        detail: evt.detail === undefined || evt.detail === null ? null : String(evt.detail)
      };
      entries.push(row);
      if (entries.length > max) entries.splice(0, entries.length - max);
      return row;
    },
    list: function () { return entries.map(function (r) { return Object.assign({}, r); }); },
    clear: function () { entries.length = 0; }
  };
}

/* 每把 DEK 只在解锁期间存在。锁定时先把字节清零再置 null，
   否则 Buffer 仍可能被后续读取或留在堆上。 */
function createVaultSession(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const idleLockMs = numOr(o.idleLockMs, DEFAULT_IDLE_LOCK_MS);
  const audit = o.audit || createAuditSink({ now: now, maxEntries: o.auditMax });
  let dek = null;
  let owned = false;
  let open = false;
  let mode = null;
  let lastSeenAt = 0;

  function detach(evtStatus, evtDetail) {
    const was = open;
    /* owned 为假时这把 DEK 是借的（免密模式下它同时是 storage 闭包里的那一个），
       清零等于把存储层的密钥毁掉，锁一次就整库永久解不开 */
    if (dek && owned) dek.fill(0);
    dek = null;
    owned = false;
    open = false;
    mode = null;
    if (was) audit.push({ kind: 'lock', status: evtStatus, detail: evtDetail });
    return was;
  }

  return {
    audit: audit,
    isUnlocked: function () { return open; },
    mode: function () { return mode; },
    unlockedSince: function () { return open ? lastSeenAt : null; },
    /* 免密老安装走这条路：不做闲置锁，但**照样持有 DEK**——盘上本来就有 master.key，
       收进会话不多暴露什么，反而让所有解密出口只有一条路径；否则免密下每个出口
       都要特判「没有会话 DEK」，那就长成两套规则了。 */
    openLegacy: function (legacyDek) {
      // 调用方常写 openLegacy(opts.dek)，opts.dek 缺席时是 undefined 而不是「没传参数」，
      // 按 arguments.length 判会把它当成一把坏掉的 DEK 直接抛错
      const given = legacyDek !== undefined && legacyDek !== null;
      if (given && (!Buffer.isBuffer(legacyDek) || legacyDek.length !== 32)) {
        throw vaultError('DEK 形状不对', 500);
      }
      if (open && mode === 'legacy' && (given ? dek === legacyDek : !dek)) return false;
      detach('ok', 'replaced');
      dek = given ? legacyDek : null;
      owned = false;
      open = true;
      mode = 'legacy';
      lastSeenAt = now();
      audit.push({ kind: 'unlock', status: 'ok', detail: 'legacy' });
      return true;
    },
    attach: function (nextDek, nextMode) {
      if (!Buffer.isBuffer(nextDek) || nextDek.length !== 32) throw vaultError('DEK 形状不对', 500);
      detach('ok', 'replaced');
      dek = nextDek;
      owned = true;
      open = true;
      mode = nextMode || 'envelope';
      lastSeenAt = now();
      audit.push({ kind: 'unlock', status: 'ok', detail: mode });
    },
    lock: function () { return detach('ok', 'manual'); },
    /* 任何一次取密钥都算「人还在用」，顺带把闲置计时推后 */
    key: function () {
      if (!dek) throw vaultError(open ? '免密模式不持有会话 DEK，明文请直接经存储层取' : '保险库未解锁', 423);
      lastSeenAt = now();
      return dek;
    },
    /* 显式记一次「人还在用」。给 HTTP 层用：主界面的读写不经过 key()（解密在 store 里），
       所以以前只有凭证与令牌路径会续期，用户在密钥看板上忙到一半会被 5 分钟锁掉。
       免密模式没有锁可上，返回 false 让它照原样不动。 */
    touch: function () {
      if (!open || mode === 'legacy') return false;
      lastSeenAt = now();
      return true;
    },
    lockIfIdle: function () {
      /* 免密模式没有「解锁」这回事，也就无从自动锁——锁了就只能重启，用户会以为数据丢了 */
      if (!open || mode === 'legacy') return false;
      if (now() - lastSeenAt < idleLockMs) return false;
      return detach('ok', 'idle');
    },
    idleRemaining: function () {
      if (!open || mode === 'legacy') return 0;
      return Math.max(0, idleLockMs - (now() - lastSeenAt));
    }
  };
}

/* 解锁限流：scrypt 单次只几十毫秒，不设上限就等于把口令的强度全交给口令本身。
   锁定按 key 计（IP 或会话），成功后清零，不用「全局计数器」以免一个客户端拖死别人。 */
function createThrottle(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const maxFails = numOr(o.maxFails, DEFAULT_MAX_FAILS);
  const lockMs = numOr(o.lockMs, DEFAULT_LOCK_MS);
  const buckets = {};
  /* 计数器只增不减是个真泄漏。键里带来源 IP（凭证那一路还带记录 id），两条写入路径都会留下永久条目：
     - 某个来源被锁过一次，锁期满后 check() 把它重置成 {fails:0,until:0}，这一条此后谁都不再删；
     - 攻击者撒一片来源地址，每个地址留两三条失败计数，就永远占着。
     成功那条路本来就 delete，所以缺的只是"没人再来"的那部分清扫。
     清扫只在写入时顺带做，不起定时器：这套设计里没有任何东西在后台跑。 */
  let written = 0;
  const sweepEvery = numOr(o.sweepEvery, DEFAULT_SWEEP_EVERY);
  const maxBuckets = numOr(o.maxBuckets, DEFAULT_MAX_BUCKETS);
  function sweep(nowMs) {
    Object.keys(buckets).forEach(function (k) {
      const b = buckets[k];
      if (b.fails === 0 && (b.until || 0) <= nowMs) delete buckets[k];
    });
    const left = Object.keys(buckets);
    if (left.length <= maxBuckets) return;
    /* 还超上限就按最后活动时间丢最旧的。丢掉一条失败计数等于给那个来源重新发额度，
       所以只在内存真的撑不住时才做——上限按一万多个键算也就几百 KB，正常用不到这一层。 */
    left.sort(function (a, b) { return (buckets[a].at || 0) - (buckets[b].at || 0); });
    const drop = left.length - maxBuckets;
    for (let i = 0; i < drop; i++) delete buckets[left[i]];
  }
  function touch(key, next) {
    next.at = now();
    buckets[key] = next;
    if (++written % sweepEvery === 0) sweep(now());
    return next;
  }

  function peek(key) {
    const b = buckets[key] || { fails: 0, until: 0 };
    return { fails: b.fails, until: b.until };
  }

  return {
    check: function (key) {
      const b = peek(key);
      if (b.until > now()) return { allowed: false, retryAfterMs: b.until - now() };
      if (b.until) touch(key, { fails: 0, until: 0 });
      return { allowed: true, retryAfterMs: 0 };
    },
    failed: function (key) {
      const b = peek(key);
      const fails = b.fails + 1;
      const locked = fails >= maxFails;
      touch(key, { fails: locked ? 0 : fails, until: locked ? now() + lockMs : 0 });
      if (o.onFail) o.onFail(key, fails, locked);
      return { locked: locked, failsRemaining: locked ? 0 : Math.max(0, maxFails - fails) };
    },
    passed: function (key) { delete buckets[key]; },
    peek: peek,
    /* 只有测试和排障会用：桶的数量是这套限流唯一会自己长出来的东西 */
    size: function () { return Object.keys(buckets).length; },
    reset: function () { Object.keys(buckets).forEach(function (k) { delete buckets[k]; }); }
  };
}

function maskSecret(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.length >= 4 ? s.slice(-4) : s;
}

function maskedKeyView(k) {
  const out = Object.assign({}, k);
  out.keyMasked = maskSecret(k.key);
  delete out.key;
  return out;
}

/* 列表视图连密文都不给：enc:v1 块拿到手就是离线爆破的原料，
   前端只需要知道「这条有没有存口令/有没有 TOTP」来画徽标。 */
function maskedCredentialView(c) {
  const out = Object.assign({}, c);
  CREDENTIAL_SECRET_FIELDS.forEach(function (f) {
    out['has' + f.charAt(0).toUpperCase() + f.slice(1, -3)] = !!c[f];
    delete out[f];
  });
  return out;
}

module.exports = {
  createVaultSession,
  createThrottle,
  createAuditSink,
  maskSecret,
  maskedKeyView,
  maskedCredentialView,
  CREDENTIAL_SECRET_FIELDS,
  DEFAULT_IDLE_LOCK_MS,
  DEFAULT_MAX_FAILS,
  DEFAULT_LOCK_MS
};
