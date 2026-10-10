/* 测试临时目录的唯一出口。
   两件事：① 创建即登记，进程退出时带退避删除；② sweepStale() 扫掉历史残留。
   为什么要有 ②：Windows 上 node:sqlite 的文件句柄比 close() 返回晚一拍释放，
   rmSync 当场抛 EBUSY。以前各测试文件要么不删、要么把删除包在 catch 里吞掉，
   于是每次全量跑都在 $TEMP 里留下一批目录（实测攒到 2 万多个）。 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

module.exports = {
  TMP: TMP,
  mk: mk,
  drop: drop,
  rmRetry: rmRetry,
  sweepStale: sweepStale,
  registered: function () { return registered.slice(); }
};
