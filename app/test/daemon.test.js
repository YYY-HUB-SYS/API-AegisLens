const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const daemon = require('../src/daemon');

const SERVER = path.join(__dirname, '..', 'server.js');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'akm-dmn-')); }
function freePort() { return 39500 + Math.floor(Math.random() * 400); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function writeRawPid(dir, obj) {
  fs.writeFileSync(daemon.pidPath(dir), JSON.stringify(obj) + '\n');
}

test('pid 文件读写与归属：只清自己写的那一份', () => {
  const dir = tempDir();
  assert.strictEqual(daemon.readPid(dir), null);
  daemon.writePid(dir, { port: 37700, bind: '127.0.0.1', version: 'test' });
  const info = daemon.readPid(dir);
  assert.strictEqual(info.pid, process.pid);
  assert.strictEqual(info.port, 37700);
  assert.strictEqual(info.bind, '127.0.0.1');
  /* 别的实例接管了同一个文件时，退出不能顺手把人家的哨兵删掉 */
  daemon.clearPid(dir, 999999);
  assert.ok(fs.existsSync(daemon.pidPath(dir)), 'pid 不匹配时不许删');
  daemon.clearPid(dir, process.pid);
  assert.strictEqual(fs.existsSync(daemon.pidPath(dir)), false);
});

test('runningInstance：死 pid、端口不符、文件损坏三种情况都不误判成"在跑"', () => {
  const dir = tempDir();
  assert.strictEqual(daemon.runningInstance(dir, 37700), null, '没有文件就是没在跑');

  writeRawPid(dir, { pid: 999999, port: 37700 });
  assert.strictEqual(daemon.runningInstance(dir, 37700), null, 'pid 已经不活着');

  writeRawPid(dir, { pid: process.pid, port: 1234 });
  assert.strictEqual(daemon.runningInstance(dir, 37700), null, 'pid 活着但端口不是我们的');

  const mine = daemon.runningInstance(dir, 1234);
  assert.ok(mine && mine.pid === process.pid, 'pid 活着且端口对得上才算');

  fs.writeFileSync(daemon.pidPath(dir), '不是 JSON');
  assert.deepStrictEqual(daemon.runningInstance(dir, 37700), { corrupt: true });
});

test('stopInstance 真能杀掉一个活着的子进程', async () => {
  const dir = tempDir();
  const child = spawn(process.execPath, ['-e', 'setInterval(function(){}, 500);'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise(function (r) { child.once('spawn', r); });
  writeRawPid(dir, { pid: pid, port: 43210 });
  assert.strictEqual(daemon.alive(pid), true);

  const r = daemon.stopInstance(dir, 43210);
  assert.strictEqual(r.stopped, true, JSON.stringify(r));
  await new Promise(function (res) { child.once('exit', res); });
  assert.strictEqual(fs.existsSync(daemon.pidPath(dir)), false, '停成功要把哨兵清掉');

  assert.deepStrictEqual(daemon.stopInstance(dir, 43210), { stopped: false, reason: 'not-running' });
});

test('spawnDaemon 起的子进程能脱离父进程活下来（Windows 上 detached 语义要实跑）', async () => {
  const dir = tempDir();
  const marker = path.join(dir, 'child-up.txt');
  const pid = daemon.spawnDaemon({
    execPath: process.execPath,
    script: '-e',
    cwd: dir,
    env: Object.assign({}, process.env),
    args: ['require("fs").writeFileSync(' + JSON.stringify(marker) + ',"up");setTimeout(function(){},3000);']
  });
  assert.ok(Number.isInteger(pid) && pid > 0, '应返回子进程 pid，实得 ' + pid);
  const t0 = Date.now();
  while (!fs.existsSync(marker) && Date.now() - t0 < 8000) { await sleep(150); }
  assert.ok(fs.existsSync(marker), '后台子进程没跑起来（detached/stdio 配置在 Windows 上不成立）');
  try { process.kill(pid); } catch (e) { /* 已退出 */ }
});

function runServer(env, extraArgs) {
  const child = spawn(process.execPath, [SERVER].concat(extraArgs || []), {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '', err = '';
  child.stdout.on('data', function (b) { out += b.toString(); });
  child.stderr.on('data', function (b) { err += b.toString(); });
  return new Promise(function (res) {
    child.on('exit', function (code) { res({ code: code, out: out, err: err }); });
    setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) {} }, 12000);
  });
}

test('不变量：非回环监听 + 没设口令 = 拒绝启动，退出码 1', async () => {
  const dir = tempDir();
  const r = await runServer({ AKM_DATA_DIR: dir, AKM_PORT: String(freePort()), AKM_BIND: '0.0.0.0' });
  assert.strictEqual(r.code, 1, '应拒绝启动，实得退出码 ' + r.code + '；stdout=' + r.out.slice(0, 200));
  assert.match(r.err, /拒绝启动/);
  assert.match(r.err, /解锁口令/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'keys.db')), false, '拒启动时不该顺手建库');
});

test('不变量放行：设过口令之后可以非回环监听；回环地址始终放行', async () => {
  const dir = tempDir();
  const p = freePort();
  /* 先用回环起一次并设口令，再用 0.0.0.0 起第二次 */
  const first = spawn(process.execPath, [SERVER], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { AKM_DATA_DIR: dir, AKM_PORT: String(p) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out1 = '';
  first.stdout.on('data', function (b) { out1 += b.toString(); });
  const base = 'http://127.0.0.1:' + p;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/api/vault/status'); if (r.status === 200) break; } catch (e) {} await sleep(150); }
  await fetch(base + '/api/vault/passphrase', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ next: 'bind-invariant-1' })
  });
  /* 回环实例退出。Windows 上 child.kill() 走 TerminateProcess，不会跑 SIGTERM 处理器，
     所以哨兵文件可能残留——那是被接受的：判"有没有在跑"靠的是 pid 存活 + 端口匹配，
     不是文件在不在。这里断言性质而不是机制。 */
  first.kill('SIGTERM');
  await new Promise(function (r) { first.once('exit', r); });
  await sleep(200);
  const still = daemon.runningInstance(dir, p);
  assert.ok(!still || still.corrupt, '进程已死却仍报告有活实例：' + JSON.stringify(still));
  assert.match(out1, /已启动/);

  const second = await runServer({ AKM_DATA_DIR: dir, AKM_PORT: String(freePort()), AKM_BIND: '0.0.0.0', AKM_PASSPHRASE: 'bind-invariant-1' });
  /* 这次不该因为不变量被拒；跑到看门狗超时被杀说明它活着在监听 */
  assert.ok(!/拒绝启动/.test(second.err), '设过口令后非回环不该被拒：' + second.err.slice(0, 200));
});

test('--stop 在没有实例时报告没在跑，而不是报错', async () => {
  const dir = tempDir();
  const r = await runServer({ AKM_DATA_DIR: dir, AKM_PORT: String(freePort()) }, ['--stop']);
  assert.strictEqual(r.code, 0, 'stdout=' + r.out + ' stderr=' + r.err);
  assert.match(r.out, /没有在运行/);
});
