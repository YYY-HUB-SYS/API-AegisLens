/* 消费者令牌的存储层。两个后端跑同一组断言，最后把整份轨迹逐字对一次——
   credentials/models 那条线上「只改了一侧后端」的事故已经发生过，这张表不能再犯。
   存储层自己不碰签名：fingerprint 与令牌本体谁生成谁校验都不归它管，它只保证元数据原样进出。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createStore } = require('../src/storage');

const BACKENDS = [];
try {
  require('node:sqlite');
  BACKENDS.push('sqlite');
} catch (e) { /* 当前 Node 没有 node:sqlite，只跑 JSON 后端 */ }
BACKENDS.push('json');

const MASTER = Buffer.alloc(32, 11);
const RECORD_FIELDS = ['id', 'tid', 'fingerprint', 'label', 'scopes', 'keyIds', 'credIds',
  'iat', 'exp', 'issuedAt', 'expiresAt', 'revokedAt', 'lastUsedAt', 'createdAt'];
/* issuedAt/expiresAt 由 iat/exp 现算，两条后端必然相同；只有这三处是 nowIso() 取的 */
const TIME_FIELDS = ['revokedAt', 'lastUsedAt', 'createdAt'];

function newDir(prefix) { return tmp.mk('aegis-' + prefix); }

/* store 没有 close()，SQLite 句柄要等进程退出才释放，Windows 上目录因此删不掉；清理尽力而为 */
function sweep(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 句柄未释放，留给 OS */ }
}

function store(dir, backend) { return createStore(dir, MASTER, { backend: backend }); }

function maskTimes(rec) {
  if (!rec) return rec;
  const out = Object.assign({}, rec);
  TIME_FIELDS.forEach(function (f) { if (out[f] != null) out[f] = '<time>'; });
  return out;
}

function rec(over) {
  const base = {
    id: 1, tid: 'aaaaaaaaaaaaaaaaaaaaaaaa', fingerprint: 'deadbeef', label: 'svc',
    scopes: ['key:read'], keyIds: [1], credIds: [],
    iat: 1700000000, exp: 1700003600,
    issuedAt: new Date(1700000000 * 1000).toISOString(),
    expiresAt: new Date(1700003600 * 1000).toISOString(),
    revokedAt: null, lastUsedAt: null, createdAt: '<time>'
  };
  return Object.assign(base, over || {});
}

function isIso(v, what) {
  assert.strictEqual(typeof v, 'string', what + ' 该是字符串时间戳');
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v), what + ' 该是 nowIso() 那种 ISO 串：' + v);
}

function checkShape(r, label) {
  assert.deepStrictEqual(Object.keys(r), RECORD_FIELDS, label + '：两个后端的记录形状与字段顺序必须一致');
  isIso(r.createdAt, label + '.createdAt');
  if (r.revokedAt !== null) isIso(r.revokedAt, label + '.revokedAt');
  if (r.lastUsedAt !== null) isIso(r.lastUsedAt, label + '.lastUsedAt');
}

/* nowIso() 只到毫秒，连着两次写可能落在同一毫秒；比较时间戳动没动之前先让时钟走开 */
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms || 2); }); }

BACKENDS.forEach(function (backend) {
  test('形状与字段顺序（' + backend + '）', () => {
    const dir = newDir('tok-shape-' + backend);
    try {
      const s = store(dir, backend);
      const r = s.createToken({
        tid: 'aaaaaaaaaaaaaaaaaaaaaaaa', fingerprint: 'deadbeef', label: 'svc',
        scopes: ['key:read'], keyIds: [1], credIds: [], iat: 1700000000, exp: 1700003600
      });
      checkShape(r, 'createToken');
      assert.deepStrictEqual(maskTimes(r), rec());
    } finally { sweep(dir); }
  });

  test('issuedAt/expiresAt 由 iat/exp 现算，不是第二条真相（' + backend + '）', () => {
    const dir = newDir('tok-derive-' + backend);
    try {
      const s = store(dir, backend);
      const r = s.createToken({ tid: 'b'.repeat(24), label: 'x', scopes: ['key:read'], iat: 1700000000, exp: 1700086400 });
      assert.strictEqual(r.issuedAt, new Date(1700000000 * 1000).toISOString());
      assert.strictEqual(r.expiresAt, new Date(1700086400 * 1000).toISOString());
    } finally { sweep(dir); }
  });

  test('脏输入被夹成规范形状，两条后端夹法一致（' + backend + '）', () => {
    const dir = newDir('tok-norm-' + backend);
    try {
      const s = store(dir, backend);
      const r = s.createToken({
        tid: 'c'.repeat(24),
        fingerprint: 12345,
        label: 'claude-code',
        scopes: ['key:read', 'key:read', 'bogus'],
        keyIds: ['3', 1, 1, -7, 0, null, 'x', 2],
        credIds: 'not-an-array',
        iat: '1700000000',
        exp: 'abc'
      });
      assert.deepStrictEqual(r.keyIds, [1, 2, 3], '正整数、去重、升序');
      assert.deepStrictEqual(r.credIds, [], '非数组一律当空清单，不能当「不限」');
      assert.deepStrictEqual(r.scopes, ['key:read', 'bogus'], 'scopes 只去重不筛白名单：白名单是签发侧的事');
      assert.strictEqual(r.fingerprint, '12345', '非字符串被收成字符串，不能让数字绑进 SQL');
      assert.strictEqual(r.iat, 1700000000, '数字字符串强转：这是 import/手改文件常见的形状');
      assert.strictEqual(r.exp, 0, '解不出正整数就是 0，不谎报一个到期时间');
      assert.strictEqual(r.expiresAt, null, 'exp=0 时不给 ISO 串');
    } finally { sweep(dir); }
  });

  test('列表新的在前；吊销幂等；使用只动 lastUsedAt（' + backend + '）', async () => {
    const dir = newDir('tok-ops-' + backend);
    try {
      const s = store(dir, backend);
      const a = s.createToken({ tid: 'd'.repeat(24), label: 'A', scopes: ['key:read'], iat: 1700000000, exp: 1700003600 });
      await sleep();
      const b = s.createToken({ tid: 'e'.repeat(24), label: 'B', scopes: ['cred:read'], keyIds: [], credIds: [4], iat: 1700000000, exp: 1700003600 });
      assert.deepStrictEqual(s.listTokens().map(function (t) { return t.label; }), ['B', 'A']);

      const revoked = s.revokeToken(a.tid);
      checkShape(revoked, 'revokeToken');
      assert.ok(revoked.revokedAt, '吊销要落下时间');
      await sleep();
      const again = s.revokeToken(a.tid);
      assert.strictEqual(again.revokedAt, revoked.revokedAt, '重复吊销不改时间，也不该改出第二条状态');
      assert.strictEqual(s.revokeToken('ffffffffffffffffffffffff'), null, '不存在的 tid 返回 null');

      assert.strictEqual(b.lastUsedAt, null);
      await sleep();
      const used = s.setTokenLastUsed(b.tid);
      assert.ok(used.lastUsedAt);
      assert.strictEqual(used.createdAt, b.createdAt, '只是用了一次，不算改动记录');
      assert.strictEqual(s.setTokenLastUsed('ffffffffffffffffffffffff'), null);
    } finally { sweep(dir); }
  });

  test('重开 store 读回逐字段一致：这些元数据是真落盘，不是内存对象（' + backend + '）', () => {
    const dir = newDir('tok-persist-' + backend);
    try {
      const s = store(dir, backend);
      const made = s.createToken({
        tid: '1234567890abcdef12345678', fingerprint: 'cafe0001', label: 'persist-me',
        scopes: ['key:read', 'balance:read'], keyIds: [7, 2], credIds: [9],
        iat: 1700000000, exp: 1700099999
      });
      s.revokeToken(made.tid);
      /* 拿吊销之后的一次读回当基准：拿 createToken 的返回值比会带上 revokedAt=null 的旧状态 */
      const before = s.getToken(made.tid);
      const reopened = store(dir, backend);
      const got = reopened.getToken(made.tid);
      assert.ok(got, '重开后按 tid 要能读回来');
      assert.ok(before.revokedAt, '基准里就该带着吊销时间');
      assert.deepStrictEqual(
        Object.keys(got).map(function (k) { return k + '=' + JSON.stringify(got[k]); }),
        Object.keys(before).map(function (k) { return k + '=' + JSON.stringify(before[k]); }),
        '逐字段一致（时间戳同源于同一份落盘数据，不需要抹）'
      );
    } finally { sweep(dir); }
  });
});

test('两条后端整份轨迹逐字相同', () => {
  if (BACKENDS.length < 2) return;
  function run(backend) {
    const dir = newDir('tok-trace-' + backend);
    try {
      const s = store(dir, backend);
      const a = s.createToken({ tid: 'a'.repeat(24), fingerprint: 'f1', label: 'A', scopes: ['key:read'], keyIds: [1, 2], iat: 1700000000, exp: 1700003600 });
      const b = s.createToken({ tid: 'b'.repeat(24), fingerprint: 'f2', label: 'B', scopes: ['cred:read', 'key:test'], credIds: [5], iat: 1700000000, exp: 1700007200 });
      s.revokeToken(a.tid);
      s.revokeToken(a.tid);
      s.setTokenLastUsed(b.tid);
      return JSON.stringify({
        created: [a, b].map(maskTimes),
        get: [s.getToken(a.tid), s.getToken(b.tid), s.getToken('nope')].map(maskTimes),
        list: s.listTokens().map(maskTimes),
        /* 时间戳之外的形状也要一致：把 createdAt 抹掉再比一次键序 */
        keys: s.listTokens().map(function (t) { return Object.keys(t).join(','); })
      }, null, 1);
    } finally { sweep(dir); }
  }
  assert.strictEqual(run('sqlite'), run('json'), '同一串操作在两条后端上必须留下同一份轨迹');
});
