/* 端口兜底：listen(0) 分到 fetch 禁用的端口时，server 会换一个。
   背景：这台机器的 Windows 动态端口范围被改成了 **1024 起**（默认 49152 起），
   于是 listen(0) 分配的端口池大到会扫过 undici 的「bad port」黑名单
   （2049 / 4045 / 6000 / 6667 / 10080 …）。撞上时 fetch 直接抛 "bad port"，
   不是连不上，是根本不让用那个端口。

   实测代价：一次全量测试里几十次 fetch 撞上一个的概率约三成 ⇒ **随机红**，
   而且单跑常常是绿的（端口刚好没落在那串里）—— 这种红最难查。

   兜底装在 test/tmp.js（所有测试的公共出口）里：包一层 http.Server.prototype.listen，
   撞上就换一个端口。用 forceBadPortOnce 钩子把这条分支逼出来验它。 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const tmp = require('./tmp.js');

test('listen(0) 分到 fetch 禁用的端口时，server 会换一个端口', async () => {
  tmp.setForceBadPortOnce(true);
  const server = http.createServer(function (req, res) { res.writeHead(200); res.end('ok'); });
  const port = await new Promise(function (r) {
    server.listen(0, '127.0.0.1', function () { r(server.address().port); });
  });
  assert.ok(!tmp.BAD_PORTS.has(port), 'server 停在了 fetch 禁用的端口上：' + port);
  const res = await fetch('http://127.0.0.1:' + port + '/');
  assert.strictEqual(res.status, 200, '换到的端口必须能用');
  await res.text();
  server.close();
});

test('黑名单里的端口，fetch 确实用不了（前提核对）', async () => {
  /* 拿一个当前没被占用的黑名单端口直接 listen：TCP 层能起来，但 fetch 必然报
     bad port。这条锁住「前提」—— 免得哪天清单抄错了，上面那条一起绿而问题还在。 */
  let target = null;
  for (const p of Array.from(tmp.BAD_PORTS)) {
    if (p < 1024) continue;
    const s = http.createServer(function (req, res) { res.end('ok'); });
    let ok = false;
    try {
      await new Promise(function (r, j) {
        s.once('error', function (e) { j(e); });
        s.listen(p, '127.0.0.1', function () { ok = true; r(); });
      });
    } catch (e) { ok = false; }
    if (!ok) { try { s.close(); } catch (e) { /* 没起来就没什么可关的 */ } continue; }
    target = { p: p, server: s };
    break;
  }
  assert.ok(target, '黑名单里一个能 listen 的端口都没找到 —— 清单可能抄错了');
  try {
    await fetch('http://127.0.0.1:' + target.p + '/');
    assert.fail('这个端口本来就不该能用：' + target.p);
  } catch (e) {
    const cause = e.cause ? String(e.cause.message || e.cause) : '';
    assert.match(cause + ' ' + e.message, /bad port/i,
      '期望 undici 报 bad port，实际是：' + cause + ' / ' + e.message);
  } finally {
    target.server.close();
  }
});

test('没触发兜底时，端口就是系统给的原样（别把兜底做成常态行为）', async () => {
  const server = http.createServer(function (req, res) { res.end('ok'); });
  const port = await new Promise(function (r) {
    server.listen(0, '127.0.0.1', function () { r(server.address().port); });
  });
  assert.ok(port > 0, '端口没拿到');
  const res = await fetch('http://127.0.0.1:' + port + '/');
  assert.strictEqual(res.status, 200);
  await res.text();
  server.close();
});
