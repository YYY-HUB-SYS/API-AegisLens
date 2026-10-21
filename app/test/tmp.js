/* 测试临时目录的唯一出口。
   两件事：① 创建即登记，进程退出时带退避删除；② sweepStale() 扫掉历史残留。
   为什么要有 ②：Windows 上 node:sqlite 的文件句柄比 close() 返回晚一拍释放，
   rmSync 当场抛 EBUSY。以前各测试文件要么不删、要么把删除包在 catch 里吞掉，
   于是每次全量跑都在 $TEMP 里留下一批目录（实测攒到 2 万多个）。 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/* realpath 之后才拿来比路径：Windows 的 TMP 常是 8.3 短名，不展开会误判 */
const TMP = fs.realpathSync(os.tmpdir());
const STALE_PREFIX = /^(akm|aegis)-/;
const registered = [];
let hookInstalled = false;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* 只认「句柄还没放」这一类错误；别的（ENOENT 之外）直接放弃，别拿删除去掩盖真问题 */
function retriable(e) {
  return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'ENOTEMPTY' || e.code === 'EMFILE';
}

function rmRetry(dir, attempts) {
  const max = attempts || 6;
  let delay = 25;
  for (let i = 0; i < max; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (!retriable(e)) return false;
      sleepMs(delay);
      delay = Math.min(delay * 2, 400);
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) { return false; }
}

function installExitHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  process.on('exit', function () {
    /* 先关库再删目录：sqlite 句柄还开着的时候，退避多久都删不掉 */
    try { require('../src/storage.js').closeAllStores(); } catch (e) { /* 拿不到就算了，下面还有退避 */ }
    for (const dir of registered) rmRetry(dir, 4);
  });
}

function mk(prefix) {
  const dir = fs.mkdtempSync(path.join(TMP, prefix + '-'));
  registered.push(dir);
  installExitHook();
  return dir;
}

/* 测试中途想立刻回收一个目录时用这个（省得等进程退出） */
function drop(dir) {
  const i = registered.indexOf(dir);
  if (i > -1) registered.splice(i, 1);
  return rmRetry(dir, 6);
}

function pidAlive(pid) {
  if (!pid || pid < 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

/* 目录里挂着活着的 server.pid 就不能删：那是在用的实例，不是残留 */
function holdsLiveServer(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'server.pid'), 'utf8'); }
  catch (e) { return false; }
  try { return pidAlive(JSON.parse(raw).pid); }
  catch (e) { return false; }
}

function sweepStale(opts) {
  const maxAgeMs = (opts && opts.maxAgeMs) || 6 * 3600 * 1000;
  /* match 只给测试用：把清扫范围收到某个前缀，免得并行跑的其他测试文件被误伤 */
  const match = (opts && opts.match) || null;
  const now = Date.now();
  const out = { scanned: 0, removed: 0, keptRecent: 0, keptBusy: 0, failed: 0 };
  let names;
  try { names = fs.readdirSync(TMP); } catch (e) { return out; }
  for (const name of names) {
    if (!STALE_PREFIX.test(name)) continue;
    if (match && !match.test(name)) continue;
    const full = path.join(TMP, name);
    if (registered.indexOf(full) > -1) continue;
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    out.scanned++;
    if (now - st.mtimeMs < maxAgeMs) { out.keptRecent++; continue; }
    if (holdsLiveServer(full)) { out.keptBusy++; continue; }
    if (rmRetry(full, 2)) out.removed++; else out.failed++;
  }
  return out;
}

/* ================= 端口兜底：listen(0) 不一定能用 =================

   undici（Node 内置 fetch）拒绝使用一批端口（fetch 标准里的「bad port」：
   2049 / 3659 / 4045 / 4190 / 5060 / 6000 / 6665-6669 / 6697 / 10080 …）——
   撞上它，fetch 直接抛 "bad port"，**不是连不上，是根本不让用那个端口**。

   为什么本机会撞上：这台机器的 Windows 动态端口范围被改成了 **1024 起**
   （默认是 49152 起），于是 listen(0) 分配的端口池大到会扫过上面那串。
   实测：分配到的端口在 18347~18466 区间随机命中；一次全量测试里
   几十次 fetch 撞上一个的概率约三成 ⇒ 测试**随机红**，且单跑常常是绿的。

   为什么不逐个测试文件改 listen(0)：25 处、19 个文件，而这类「随机红」最难查。
   在这个公共出口里包一层 listen，以后新增的测试文件自动免疫。

   只拦「让系统挑端口」（port === 0）这一种；显式指定端口的不动。 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
]);

/* 仅供测试用：置 true 时，下一次 listen(0) 会被当成「分到了黑名单端口」，
   用来验证 server 确实换了端口而不是硬闯。正常路径永远是 false。 */
let forceBadPortOnce = false;
function setForceBadPortOnce(v) { forceBadPortOnce = !!v; }

if (!http.Server.prototype.__akmSafeListen) {
  const origListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function () {
    const args = Array.prototype.slice.call(arguments);
    if (args[0] !== 0) return origListen.apply(this, args);
    const last = args.length - 1;
    if (typeof args[last] !== 'function') return origListen.apply(this, args);
    const server = this;
    const origCb = args[last];
    args[last] = function () {
      const addr = server.address();
      const port = addr && addr.port;
      const bad = forceBadPortOnce || (port && BAD_PORTS.has(Number(port)));
      if (!bad) return origCb.apply(this, arguments);
      forceBadPortOnce = false;
      /* 关掉再换一个端口重来：同一个 server 对象可以重新 listen。 */
      server.close(function () { origListen.apply(server, args); });
      return undefined;
    };
    return origListen.apply(this, args);
  };
  http.Server.prototype.__akmSafeListen = true;
}

module.exports = {
  TMP: TMP,
  BAD_PORTS: BAD_PORTS,
  setForceBadPortOnce: setForceBadPortOnce,
  mk: mk,
  drop: drop,
  rmRetry: rmRetry,
  sweepStale: sweepStale,
  registered: function () { return registered.slice(); }
};
