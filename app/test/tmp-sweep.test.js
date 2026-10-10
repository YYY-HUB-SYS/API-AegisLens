/* 测试临时目录的收尾件：创建即登记、退出时关库再删，另在每次跑测试时回收上一轮漏下的。
   这条测试盯的是「回收器本身」——正例、负例、以及在用的实例不许误删，三样都要有。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = require('./tmp.js');

const HOUR = 3600 * 1000;

/* 造一个「不属于本轮登记」的目录，并按 maxAge 前调 mtime，模拟上一轮的残留 */
function plant(name, ageMs) {
  const dir = path.join(tmp.TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keys.db'), 'not a real db');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, t, t);
  return dir;
}

test('清扫器只认 os.tmpdir() 下 akm- / aegis- 两个前缀，别的一概不碰', () => {
  assert.strictEqual(tmp.TMP, fs.realpathSync(os.tmpdir()), 'TMP 必须是解析过的系统临时目录');
  /* 用户真实密钥库不在临时目录里，这条是误删的唯一硬保险 */
  const home = fs.realpathSync(os.homedir());
  assert.ok(path.join(home, '.api-aegislens').indexOf(tmp.TMP) !== 0,
    '真密钥库必须落在 TMP 之外，否则清扫器有可能把它当残留端了');
});

test('陈旧残留被回收、新鲜的留下', () => {
  const stale = plant('akm-sweepprobe-stale', 7 * HOUR);
  const fresh = plant('akm-sweepprobe-fresh', 60 * 1000);
  try {
    const r = tmp.sweepStale({ maxAgeMs: 30 * 60 * 1000, match: /^akm-sweepprobe-/ });
    assert.strictEqual(r.scanned, 2, '探针只该扫到自己这两个：' + JSON.stringify(r));
    assert.ok(!fs.existsSync(stale), '7 小时前的残留目录该被回收');
    assert.ok(fs.existsSync(fresh), '一分钟前的目录还在用，不许动');
  } finally {
    tmp.drop(stale);
    tmp.drop(fresh);
  }
});

test('目录里挂着活着的 server.pid 就不算残留', () => {
  const busy = plant('akm-sweepprobe-busy', 7 * HOUR);
  try {
    fs.writeFileSync(path.join(busy, 'server.pid'), JSON.stringify({ pid: process.pid, port: 37700 }));
    const t = new Date(Date.now() - 7 * HOUR);
    fs.utimesSync(busy, t, t);
    tmp.sweepStale({ maxAgeMs: 30 * 60 * 1000, match: /^akm-sweepprobe-busy-/ });
    assert.ok(fs.existsSync(busy), '进程还活着的数据目录被误删了');
  } finally {
    tmp.drop(busy);
  }
});

test('本轮跑完不往临时目录里留东西（sqlite 句柄要在退出前关掉）', () => {
  const dir = tmp.mk('akm-leakprobe');
  fs.writeFileSync(path.join(dir, 'keys.db'), 'x');
  assert.ok(fs.existsSync(dir));
  /* 登记过的目录，清扫器必须跳过（否则并行跑的兄弟文件会被它误删）。
     maxAgeMs 给 0 等于「全都算陈旧」，但 match 把范围收到这一个前缀内。 */
  tmp.sweepStale({ maxAgeMs: 0, match: /^akm-leakprobe-/ });
  assert.ok(fs.existsSync(dir), '清扫器把本轮正在用的目录删了');
});

/* 真正的回收动作：默认 30 分钟阈值，收上一轮（以及崩溃那轮）漏下的 */
test('清扫上一轮残留', () => {
  const r = tmp.sweepStale({ maxAgeMs: 30 * 60 * 1000 });
  console.log('临时目录：扫到 ' + r.scanned + '，回收 ' + r.removed +
    '，新鲜保留 ' + r.keptRecent + '，在用保留 ' + r.keptBusy + '，删不掉 ' + r.failed);
});

/* 根因锁在这儿：node:sqlite 的句柄没关，目录在 Windows 上就是删不掉。
   storage 的工厂现在记一份活实例，closeAllStores() 统一收尾；这条断言就是它的哨兵。 */
test('sqlite 库没有逐个 close 时，closeAllStores() 也得把目录放开', () => {
  const { loadOrCreateMasterKey } = require('../src/crypto');
  const { createStore, closeAllStores } = require('../src/storage');
  const dir = tmp.mk('akm-closeprobe');
  const store = createStore(dir, loadOrCreateMasterKey(dir), { backend: 'sqlite' });
  assert.strictEqual(store.backend, 'sqlite', '这台机器上 sqlite 后端不可用，这条测试会空转');
  fs.writeFileSync(path.join(dir, 'probe.txt'), 'x');
  closeAllStores();
  assert.ok(tmp.rmRetry(dir, 4), '库说关完了，目录还是删不掉——句柄仍被压着');
  assert.ok(!fs.existsSync(dir), '目录没被真正回收');
});
