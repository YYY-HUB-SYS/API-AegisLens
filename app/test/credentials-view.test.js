/* 凭证视图的两件事：
   1) 提交体的规则（纯函数 submitPayload）——写错就是静默删数据，必须能在 node 里直接断言；
   2) 四个视图文件真的被服务出去——挂载代码是 `if (!window.CredentialsView || !root) return;`，
      APP_ASSETS 少一条或文件名打错，整块面板就静默消失，任何接口测试都看不见。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');
const view = require('../public/credentials-view.js');

const submit = view.__internals.submitPayload;

/* 后端 buildPatch 的语义（credentials-api.js:149/154）：键缺失＝不改，空串＝清空。
   这两条一起决定了前端绝不能把没碰过的字段照直发出去。 */
const DRAFT = { id: 7, title: '内网', username: 'ops', url: 'https://intra', folder: '', tags: '', password: '', note: '', totpSecret: '' };

function keysOf(p) { return Object.keys(p).sort().join(','); }

test('编辑时没碰过口令与备注 → 请求体里根本不出现这两个键', () => {
  const p = submit(Object.assign({}, DRAFT), 'update', { pw: false, note: false });
  assert.ok(!('password' in p), '带上 password:"" 就等于把用户存了的口令删掉');
  assert.ok(!('note' in p), '同理，备注也会被清空');
  assert.strictEqual(keysOf(p), 'folder,tags,title,url,username');
});

test('用户主动清空（碰过且留空）→ 必须把空串发出去，让后端清空', () => {
  const p = submit(Object.assign({}, DRAFT), 'update', { pw: true, note: true });
  assert.strictEqual(p.password, '', '碰过又留空就是「我要删掉它」，不能当没改');
  assert.strictEqual(p.note, '');
});

test('填了新口令 → 照发；只改口令时备注仍然不动', () => {
  const p = submit(Object.assign({}, DRAFT, { password: 'brand-new-pw' }), 'update', { pw: true, note: false });
  assert.strictEqual(p.password, 'brand-new-pw');
  assert.ok(!('note' in p));
});

test('新建态两个字段照直发（此时空串是「就是没有」，不是「删掉」）', () => {
  const p = submit(Object.assign({}, DRAFT), 'create', { pw: false, note: false });
  assert.strictEqual(p.password, '');
  assert.strictEqual(p.note, '');
});

test('TOTP 种子仍按老规矩：非空才发', () => {
  assert.ok(!('totpSecret' in submit(Object.assign({}, DRAFT), 'update', { pw: false, note: false })));
  const p = submit(Object.assign({}, DRAFT, { totpSecret: 'JBSWY3DPEHPK3PXP' }), 'update', {});
  assert.strictEqual(p.totpSecret, 'JBSWY3DPEHPK3PXP');
});

test('touched 整个不传也不能炸（默认按没碰过处理）', () => {
  const p = submit(Object.assign({}, DRAFT), 'update');
  assert.ok(!('password' in p) && !('note' in p));
});

/* ── 视图资产的可达性 ─────────────────────────────────────────── */

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-view-'));
  const storage = createStore(dir, loadOrCreateMasterKey(dir), { backend: 'json' });
  const server = createApp({
    storage: storage, fetchImpl: async () => new Response('{}'),
    publicDir: path.join(__dirname, '..', 'public'), version: 'test'
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server: server, base: 'http://127.0.0.1:' + server.address().port, dir: dir };
}

test('两个视图的 js/css 都被服务且 MIME 正确（少一条就整块面板静默消失）', async () => {
  const h = await start();
  try {
    const want = {
      '/credentials-view.js': 'text/javascript',
      '/credentials-view.css': 'text/css',
      '/consumer-view.js': 'text/javascript',
      '/consumer-view.css': 'text/css'
    };
    for (const [p, mime] of Object.entries(want)) {
      const res = await fetch(h.base + p);
      assert.strictEqual(res.status, 200, p + ' 取不到：' + res.status);
      assert.ok(String(res.headers.get('content-type')).indexOf(mime) === 0,
        p + ' 的 MIME 是 ' + res.headers.get('content-type') + '，浏览器会拒绝执行/应用');
      assert.ok((await res.text()).length > 500, p + ' 内容为空');
    }
  } finally {
    await new Promise(r => h.server.close(r));
    try { fs.rmSync(h.dir, { recursive: true, force: true }); } catch (e) { /* Windows 句柄 */ }
  }
});

test('index.html 真的挂载了这两个视图（引了脚本又没挂载点同样是白屏）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const needle of ['/credentials-view.js', '/credentials-view.css', '/consumer-view.js', '/consumer-view.css',
    'mountCredentialsView', 'mountConsumerView', 'id="vault"', 'id="consumer-tokens"']) {
    assert.ok(html.includes(needle), 'index.html 缺少挂载要素：' + needle);
  }
});
