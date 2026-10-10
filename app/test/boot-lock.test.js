const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = require('./tmp.js');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const PASS = 'boot-lock-pass-1';
const SECRET = 'sk-bootlock-77q2';

function tempDir() { return tmp.mk('akm-boot'); }
function freePort() { return 39000 + Math.floor(Math.random() * 900); }

/* 起真服务、等它可访问、跑完再杀干净：这条测的是 server.js 的开机路径，
   用 createApp 注入会话测不出来（注入路径永远绕过了「有没有 store」这一步） */
function start(dir, port, extraEnv) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { AKM_DATA_DIR: dir, AKM_PORT: String(port) }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const state = { out: '', err: '', exited: false, code: null };
  child.stdout.on('data', function (b) { state.out += b.toString(); });
  child.stderr.on('data', function (b) { state.err += b.toString(); });
  child.on('exit', function (code) { state.exited = true; state.code = code; });
  return { child: child, state: state, port: port, dir: dir };
}

async function waitReady(h, timeoutMs) {
  const base = 'http://127.0.0.1:' + h.port;
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 8000)) {
    if (h.state.exited) throw new Error('服务提前退出 code=' + h.state.code + ' err=' + h.state.err.slice(0, 200));
    try {
      const r = await fetch(base + '/api/vault/status');
      if (r.status === 200) return base;
    } catch (e) { /* 还没起监听 */ }
    await new Promise(function (r) { setTimeout(r, 120); });
  }
  throw new Error('服务没在超时内就绪；stdout=' + h.state.out.slice(0, 200) + ' stderr=' + h.state.err.slice(0, 200));
}

function stop(h) {
  return new Promise(function (res) {
    if (!h.child || h.child.killed || h.state.exited) return res();
    h.child.once('exit', function () { res(); });
    h.child.kill('SIGTERM');
    setTimeout(function () { try { h.child.kill('SIGKILL'); } catch (e) {} }, 2500);
  });
}

async function get(base, p) {
  const r = await fetch(base + p);
  return { status: r.status, data: await r.json().catch(function () { return null; }) };
}
async function post(base, p, body) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return { status: r.status, data: await r.json().catch(function () { return null; }) };
}

test('设了口令的安装重启后是锁着的：数据接口 423，vault 与平台表仍可用', async () => {
  const dir = tempDir();
  const port = freePort();
  let h = start(dir, port);
  try {
    const base = await waitReady(h);
    /* 第一段：免密自启 → 建一把 Key → 设口令（模拟用户真实动作顺序） */
    const legacy = await get(base, '/api/vault/status');
    assert.strictEqual(legacy.data.unlocked, true);
    assert.strictEqual(legacy.data.mode, 'legacy');
    assert.strictEqual(legacy.data.passphraseSet, false);
    const made = await post(base, '/api/keys', { platform: 'deepseek', key: SECRET, name: 'boot' });
    assert.strictEqual(made.status, 201);
    const set = await post(base, '/api/vault/passphrase', { next: PASS });
    assert.strictEqual(set.status, 200);
    assert.ok(set.data.recoveryCode, '设口令要发恢复码');
    assert.ok(fs.existsSync(path.join(dir, 'vault.key')));
    await stop(h);

    /* 第二段：重启。这次必须锁着 —— 这条断言就是 P3 要收的那个洞 */
    h = start(dir, port);
    const base2 = await waitReady(h);
    const st = await get(base2, '/api/vault/status');
    assert.strictEqual(st.data.unlocked, false, '设过口令的安装重启后不该免密自启');
    assert.strictEqual(st.data.passphraseSet, true);
    assert.strictEqual(st.data.needsSetup, false);

    const keys = await get(base2, '/api/keys');
    assert.strictEqual(keys.status, 423, '锁着时密钥列表必须 423');
    assert.strictEqual((await get(base2, '/api/credentials')).status, 423);
    assert.strictEqual((await get(base2, '/api/pools')).status, 423);
    /* meta 刻意不锁：里面只有版本、后端类型、数据目录名，锁着也要让页面能报版本；
       未解锁时 backend 如实是 null，不假装成某个后端 */
    const meta = await get(base2, '/api/meta');
    assert.strictEqual(meta.status, 200);
    assert.strictEqual(meta.data.storage, null, '未解锁时后端如实为 null');
    assert.strictEqual(typeof meta.data.version, 'string');
    assert.ok(meta.data.version.length > 0, '锁着也要能报版本');
    assert.strictEqual((await post(base2, '/api/keys/1/reveal')).status, 423);

    /* 不依赖 store 的路由必须照常工作，否则连解锁界面都打不开 */
    assert.strictEqual((await get(base2, '/api/platforms')).status, 200);
    assert.strictEqual((await get(base2, '/')).status, 200, '首页本身要能打开');

    const bad = await post(base2, '/api/vault/unlock', { passphrase: 'wrong-pass-9' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await get(base2, '/api/keys')).status, 423, '解错之后还是锁着');

    const good = await post(base2, '/api/vault/unlock', { passphrase: PASS });
    assert.strictEqual(good.status, 200);
    assert.strictEqual(good.data.mode, 'envelope');
    const after = await get(base2, '/api/keys');
    assert.strictEqual(after.status, 200);
    assert.strictEqual(JSON.stringify(after.data).indexOf(SECRET), -1, '解锁后列表仍只出掩码');
    assert.strictEqual(after.data.keys[0].keyMasked, '77q2');
    const rev = await post(base2, '/api/keys/1/reveal');
    assert.strictEqual(rev.data.key, SECRET, '重启解锁后老库照样能解');

    /* 手动锁定必须连 store 一起关：只改会话状态就是装样子 */
    assert.strictEqual((await post(base2, '/api/vault/lock')).status, 200);
    assert.strictEqual((await get(base2, '/api/keys')).status, 423);
    assert.strictEqual((await post(base2, '/api/keys/1/reveal')).status, 423);
  } finally {
    await stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 60000 });

test('锁定必须同时关掉会话与 store：否则解锁会走幂等短路、既不校验口令也解不开', async () => {
  const dir = tempDir();
  const port = freePort();
  let h = start(dir, port);
  try {
    const base = await waitReady(h);
    await post(base, '/api/keys', { platform: 'deepseek', key: SECRET, name: 'lockcycle' });
    assert.strictEqual((await post(base, '/api/vault/passphrase', { next: PASS })).status, 200);
    await stop(h);

    h = start(dir, port);
    const b = await waitReady(h);
    assert.strictEqual((await post(b, '/api/vault/unlock', { passphrase: PASS })).status, 200);
    assert.strictEqual((await get(b, '/api/keys')).status, 200);

    assert.strictEqual((await post(b, '/api/vault/lock')).status, 200);
    /* 这三条是一体的：会话要关掉、数据要 423、而且不能出现「说已解锁却什么都取不到」 */
    assert.strictEqual((await get(b, '/api/vault/status')).data.unlocked, false, 'lock 之后会话必须是关的');
    assert.strictEqual((await get(b, '/api/keys')).status, 423);
    const wrong = await post(b, '/api/vault/unlock', { passphrase: 'not-the-pass' });
    assert.strictEqual(wrong.status, 400, '锁定后必须真的校验口令，不能走幂等短路：' + JSON.stringify(wrong.data));
    const right = await post(b, '/api/vault/unlock', { passphrase: PASS });
    assert.strictEqual(right.status, 200);
    assert.strictEqual((await get(b, '/api/keys')).status, 200, '重新解锁要能把 store 建回来');
  } finally {
    await stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 60000 });

test('AKM_PASSPHRASE 能直接解锁启动；口令错时非交互环境要退出而不是假装健康', async () => {
  const dir = tempDir();
  const port = freePort();
  let h = start(dir, port);
  try {
    const base = await waitReady(h);
    await post(base, '/api/keys', { platform: 'deepseek', key: SECRET, name: 'env' });
    assert.strictEqual((await post(base, '/api/vault/passphrase', { next: PASS })).status, 200);
    await stop(h);

    h = start(dir, port, { AKM_PASSPHRASE: PASS });
    const base2 = await waitReady(h);
    const st = await get(base2, '/api/vault/status');
    assert.strictEqual(st.data.unlocked, true, '给了口令就该在开机时解掉');
    assert.strictEqual(st.data.mode, 'envelope');
    assert.strictEqual((await get(base2, '/api/keys')).status, 200);
    assert.match(h.state.out, /已由 AKM_PASSPHRASE 解锁/);
    await stop(h);

    /* 非交互（stdin 不是 TTY）+ 错口令：必须退出非 0，不能让监督进程看到一颗健康的锁死服务 */
    h = start(dir, port, { AKM_PASSPHRASE: 'wrong-pass-9' });
    const code = await new Promise(function (res) {
      const t = setTimeout(function () { res('timeout'); }, 9000);
      h.child.once('exit', function (c) { clearTimeout(t); res(c); });
    });
    assert.strictEqual(code, 1, '错口令的非交互启动应退出码 1，实得 ' + code + '；stderr=' + h.state.err.slice(0, 200));
    assert.match(h.state.err, /AKM_PASSPHRASE/);
  } finally {
    await stop(h);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 60000 });

/* 两条都是 2026-10-09 整改补的：前者钉住「闲置锁间隔其实可配 + 主界面读数据要续期」，
   后者钉住「运行时关掉调度，不能被一次锁/解锁推翻」。两条都只有起真服务才测得出来。 */
test('AKM_IDLE_LOCK_MINUTES 真的生效，且读数据会续期、轮询状态不会', async () => {
  const dir = tempDir();
  const port = freePort();
  let h = start(dir, port, { AKM_IDLE_LOCK_MINUTES: '1' });
  try {
    const base = await waitReady(h);
    await post(base, '/api/keys', { platform: 'deepseek', key: SECRET, name: 'idle' });
    assert.strictEqual((await post(base, '/api/vault/passphrase', { next: PASS })).status, 200);
    await post(base, '/api/vault/lock');
    assert.strictEqual((await post(base, '/api/vault/unlock', { passphrase: PASS })).status, 200);

    const just = (await get(base, '/api/vault/status')).data;
    assert.ok(just.idleRemainingMs > 0 && just.idleRemainingMs <= 60000,
      '设成 1 分钟就不该还是默认的 5 分钟，实得 ' + just.idleRemainingMs);

    await new Promise(function (r) { setTimeout(r, 1500); });
    assert.strictEqual((await get(base, '/api/keys')).status, 200, '数据读要成功');
    const afterRead = (await get(base, '/api/vault/status')).data;
    assert.ok(afterRead.idleRemainingMs > 59000,
      '刚读过数据就该把计时推到接近满窗，实得 ' + afterRead.idleRemainingMs);

    /* 反向：只轮询 /api/vault/status 不该续期，否则一个本机脚本就能把会话永远开着 */
    await new Promise(function (r) { setTimeout(r, 1300); });
    for (let i = 0; i < 3; i++) await get(base, '/api/vault/status');
    const passive = (await get(base, '/api/vault/status')).data;
    assert.ok(passive.idleRemainingMs < 59000,
      '被动轮询不能续期，实得 ' + passive.idleRemainingMs);
  } finally {
    await stop(h);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows 句柄 */ }
  }
});

test('运行时关掉定时调度后，一次锁/解锁不能把它偷偷开回来', async () => {
  const dir = tempDir();
  const port = freePort();
  let h = start(dir, port, { AKM_SCHEDULE_ENABLED: '1', AKM_SCHEDULE_INTERVAL_MINUTES: '1' });
  try {
    const base = await waitReady(h);
    await post(base, '/api/keys', { platform: 'deepseek', key: SECRET, name: 'sched' });
    assert.strictEqual((await get(base, '/api/schedule')).data.schedule.enabled, true, '环境变量给的初值');

    assert.strictEqual((await post(base, '/api/schedule', { enabled: false })).status, 200);
    assert.strictEqual((await get(base, '/api/schedule')).data.schedule.enabled, false);

    /* 锁一次再解锁：以前 openStore 看的是 config.schedule.enabled（环境变量），
       于是这一步会把用户刚关掉的调度重新打开，接着按间隔朝全部厂商发真实请求 */
    assert.strictEqual((await post(base, '/api/vault/passphrase', { next: PASS })).status, 200);
    await post(base, '/api/vault/lock');
    assert.strictEqual((await post(base, '/api/vault/unlock', { passphrase: PASS })).status, 200);

    const st = (await get(base, '/api/schedule')).data.schedule;
    assert.strictEqual(st.enabled, false, '锁/解锁不能推翻用户最后一次的显式指令');
    assert.ok(!st.nextRunAt, '关着就不该还排着下一轮');
  } finally {
    await stop(h);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows 句柄 */ }
  }
});
