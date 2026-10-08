/* 保险库会话层：解锁状态、闲置自动锁、失败限流、reveal 审计、脱敏视图。
   刻意不 require api.js/storage.js——接入点是 api 层一行调用，这里只保证可单测。 */

const DEFAULT_IDLE_LOCK_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FAILS = 5;
const DEFAULT_LOCK_MS = 5 * 60 * 1000;
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
  let open = false;
  let mode = null;
  let lastSeenAt = 0;

  function detach(evtStatus, evtDetail) {
    const was = open;
    if (dek) dek.fill(0);
    dek = null;
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
    /* 免密老安装走这条路：会话是开着的，但这里不持有 DEK——加解密能力在 store 里，
       闸门只负责「要不要放明文出去」。 */
    openLegacy: function () {
      if (open && mode === 'legacy') return false;
      detach('ok', 'replaced');
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

  function peek(key) {
    const b = buckets[key] || { fails: 0, until: 0 };
    return { fails: b.fails, until: b.until };
  }

  return {
    check: function (key) {
      const b = peek(key);
      if (b.until > now()) return { allowed: false, retryAfterMs: b.until - now() };
      if (b.until) buckets[key] = { fails: 0, until: 0 };
      return { allowed: true, retryAfterMs: 0 };
    },
    failed: function (key) {
      const b = peek(key);
      const fails = b.fails + 1;
      const locked = fails >= maxFails;
      buckets[key] = { fails: locked ? 0 : fails, until: locked ? now() + lockMs : 0 };
      if (o.onFail) o.onFail(key, fails, locked);
      return { locked: locked, failsRemaining: locked ? 0 : Math.max(0, maxFails - fails) };
    },
    passed: function (key) { delete buckets[key]; },
    peek: peek,
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
