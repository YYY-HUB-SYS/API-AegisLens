const { testKeyAt, refreshBalances, SCHEDULE_INTERVAL_MIN_MINUTES, SCHEDULE_INTERVAL_MAX_MINUTES } = require('./api');

/* 一轮 = 每个密钥各测一次 + 批量刷余额，走的都是手动路径同一套函数（含历史落库）。
   用递归 setTimeout 而不是 setInterval：一轮没跑完就追加下一轮，网络一慢就会把请求叠成堆，
   跑完再排下一次才谈得上「间隔」；间隔改动也只有在重排时才生效。
   首轮不设在启动瞬间：每次开机就朝全部厂商发一轮真实请求，比曲线少一个数据点更让人意外。 */

function clampMinutes(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return SCHEDULE_INTERVAL_MIN_MINUTES;
  return Math.min(SCHEDULE_INTERVAL_MAX_MINUTES, Math.max(SCHEDULE_INTERVAL_MIN_MINUTES, Math.round(n)));
}

function defaultSetTimer(fn, ms) {
  const t = setTimeout(fn, ms);
  /* 待跑的定时器不该把进程钉住（测试里尤其如此），HTTP 服务自己会保持存活 */
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function createScheduler(opts) {
  const o = opts || {};
  const storage = o.storage;
  const fetchImpl = o.fetchImpl;
  const setTimer = o.setTimer || defaultSetTimer;
  const clearTimer = o.clearTimer || function (t) { clearTimeout(t); };

  let enabled = !!o.enabled;
  let intervalMinutes = clampMinutes(o.intervalMinutes);
  let timer = null;
  let running = false;
  let lastRunAt = null;
  let lastResult = null;
  let lastError = null;
  let nextRunAt = null;

  function arm() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!enabled) { nextRunAt = null; return; }
    nextRunAt = new Date(Date.now() + intervalMinutes * 60000).toISOString();
    /* 把这一轮的 Promise 透出去：真实的 setTimeout 会丢掉返回值，测试里却要能等到跑完再断言 */
    timer = setTimer(function () { timer = null; return tick(); }, intervalMinutes * 60000);
  }

  async function runOnce() {
    const t0 = Date.now();
    const keys = storage.listKeys();
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const eps = k.endpoints || [];
      /* 没填地址的密钥跑一次只会添一行「无法测试」——那是配置状态，不是观测结果 */
      if (!eps.length || !eps[0].url) { skipped++; continue; }
      try {
        const rec = await testKeyAt(storage, k, undefined, { fetchImpl: fetchImpl });
        if (rec.test && rec.test.status === 'pass') passed++; else failed++;
      } catch (e) {
        /* 单个密钥的异常不该中断整轮 */
        failed++;
      }
    }
    const bal = await refreshBalances(storage, { fetchImpl: fetchImpl });
    return {
      at: new Date(t0).toISOString(),
      keys: keys.length,
      passed: passed,
      failed: failed,
      skipped: skipped,
      balanceUpdated: bal.updated,
      balanceFailed: bal.failed,
      durationMs: Date.now() - t0
    };
  }

  /* 跑一轮并记账：把「跑」与「记」合成一步。
     早先记账只写在 tick() 里，而 tick() 只有定时器会调；
     于是「立即跑一轮」那条路（如果直接调 runOnce）跑完不会留下任何痕迹——
     界面上「上次运行 / 上次结果 / 上次错误」永远是空的，看着像没跑过。
     抽成公共函数后，定时触发与手动触发走同一条路，记账只有这一处。 */
  async function runAndRecord() {
    running = true;
    try {
      lastResult = await runOnce();
      lastRunAt = lastResult.at;
      lastError = null;
      return lastResult;
    } catch (e) {
      /* 一轮失败不能把定时器带停 */
      lastError = e.message;
      throw e;
    } finally {
      running = false;
    }
  }

  async function tick() {
    if (running) { arm(); return; }
    try {
      await runAndRecord();
    } catch (e) {
      /* 错误已记进 lastError；一轮失败不能把定时器带停 */
    }
    arm();
  }

  function status() {
    return {
      enabled: enabled,
      intervalMinutes: intervalMinutes,
      running: running,
      lastRunAt: lastRunAt,
      lastResult: lastResult,
      lastError: lastError,
      nextRunAt: nextRunAt
    };
  }

  function configure(patch) {
    const p = patch || {};
    if (p.intervalMinutes !== undefined) intervalMinutes = clampMinutes(p.intervalMinutes);
    if (p.enabled !== undefined) enabled = !!p.enabled;
    arm();
    return status();
  }

  return {
    start: function () { arm(); return status(); },
    stop: function () {
      if (timer !== null) { clearTimer(timer); timer = null; }
      nextRunAt = null;
      return status();
    },
    runOnce: runOnce,
    /* 手动跑一轮并记账：与定时触发同一条路，所以手动跑完「上次运行」也有值 */
    runAndRecord: runAndRecord,
    configure: configure,
    status: status
  };
}

module.exports = { createScheduler: createScheduler };
