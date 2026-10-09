const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');

const publicDir = path.join(__dirname, '..', 'public');

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-vendor-'));
  const storage = createStore(dir, loadOrCreateMasterKey(dir), { backend: 'json' });
  const server = createApp({ storage, fetchImpl: async () => new Response('{}'), publicDir, version: 'test' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

test('字体随仓库走：latin 可变子集存在且是合法 WOFF2', () => {
  const f = path.join(publicDir, 'vendor', 'fonts', 'jetbrains-mono-latin-var.woff2');
  const buf = fs.readFileSync(f);
  assert.strictEqual(buf.slice(0, 4).toString('latin1'), 'wOF2', 'WOFF2 签名不对');
  assert.ok(buf.length < 60000, 'latin 子集不该超过 60KB，实测 ' + buf.length);
});

test('OFL 许可证必须和字体一起提交', () => {
  const t = fs.readFileSync(path.join(publicDir, 'vendor', 'fonts', 'OFL.txt'), 'utf8');
  assert.ok(t.includes('SIL Open Font License'), '缺 OFL 正文');
  assert.ok(t.includes('JetBrains Mono'), '缺版权行');
});

test('/vendor/ 能取到字体，Content-Type 必须是 font/woff2', async () => {
  const { server, base } = await start();
  try {
    const res = await fetch(base + '/vendor/fonts/jetbrains-mono-latin-var.woff2');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'font/woff2');
    const buf = Buffer.from(await res.arrayBuffer());
    const disk = fs.readFileSync(path.join(publicDir, 'vendor', 'fonts', 'jetbrains-mono-latin-var.woff2'));
    assert.strictEqual(buf.length, disk.length, '吐出的字节数要和盘上的一致');
  } finally { server.close(); }
});

test('路径穿越：编码的 .. 不许逃出 vendor 目录', async () => {
  const { server, base } = await start();
  const attacks = [
    '/vendor/%2e%2e%2fserver.js',
    '/vendor/..%2f..%2fserver.js',
    '/vendor/%2e%2e/%2e%2e/package.json',
    '/vendor/fonts/%2e%2e%2f%2e%2e%2f%2e%2e%2fapp%2fserver.js'
  ];
  try {
    for (const p of attacks) {
      const res = await fetch(base + p);
      const text = await res.text();
      assert.notStrictEqual(res.status, 200, '竟然取到了：' + p);
      assert.ok(!text.includes('require('), '泄漏了源码：' + p);
    }
  } finally { server.close(); }
});

test('扩展名白名单：vendor 下的 .md 说明文件不可被 HTTP 取走', async () => {
  const { server, base } = await start();
  const md = path.join(publicDir, 'vendor', 'fonts', 'CREDITS.md');
  assert.ok(fs.existsSync(md), '先确认这个文件真的存在，否则本测等于空跑');
  try {
    const res = await fetch(base + '/vendor/fonts/CREDITS.md');
    assert.strictEqual(res.status, 404, '白名单外的后缀应 404，而不是 200');
  } finally { server.close(); }
});

test('字体必须本地自托管，首页不许出现外链资源', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const face = html.slice(html.indexOf('@font-face'), html.indexOf('@font-face') + 420);
  assert.ok(face.includes('url("/vendor/fonts/'), '@font-face 应指向 /vendor/ 本地路径');
  assert.ok(!/url\(["']?(https?:)?\/\//.test(html), 'CSS 里不允许任何外链资源');
  assert.ok(!/<link[^>]+https?:/.test(html), '不允许外链 <link>');
  assert.ok(!/<script[^>]+src=["']https?:/.test(html), '不允许外链 <script>');
});

/* 2026-10-09 补 PRD 字体许可证时发现的缺口：应用侧有 vendor.test.js 盯着，
   文档目录里的 3MB 第三方二进制却一份许可证都没带。这条把规则扩到全仓所有
   随仓第三方二进制——OFL 与 MIT 都要求声明随副本分发，漏了就是真违规，不是漏写说明。 */
test('全仓每一个随仓第三方二进制，同目录必须有许可证文件', () => {
  const root = path.join(__dirname, '..', '..');
  const BIN_EXT = /\.(ttf|otf|woff2?|min\.js)$/i;
  const LIC_RE = /(licen[cs]e|ofl|mit|isc|apache|copyright)/i;
  const dirs = new Map();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!BIN_EXT.test(e.name)) continue;
      const d = path.dirname(p);
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d).push(e.name);
    }
  })(root);
  assert.ok(dirs.size >= 3, '至少该扫到应用字体、图标目录与 PRD 目录，实得 ' + dirs.size);
  for (const [dir, bins] of dirs) {
    const licences = fs.readdirSync(dir).filter(function (f) { return LIC_RE.test(f); });
    assert.ok(licences.length > 0,
      path.relative(root, dir) + ' 里有 ' + bins.join(', ') + ' 却没有任何许可证文件');
  }
});
