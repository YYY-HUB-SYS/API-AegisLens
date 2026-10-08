/* 定时器攒出来的延迟趋势、余额走势，只有穿过持久层才算数：
   重启后读回来还在，画得出曲线，才算这条线做完。两个后端跑同一组断言，
   因为「同一条数据在两个后端连类型都不一样」是这个项目反复踩过的坑。 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/storage');

const CAP = 1000;
const BACKENDS = [];
try {
  require('node:sqlite');
  BACKENDS.push('sqlite');
} catch (e) { /* 当前 Node 没有 node:sqlite，只跑 JSON 后端 */ }
BACKENDS.push('json');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-' + prefix + '-')); }

/* store 没有 close()，SQLite 句柄要等进程退出才释放，Windows 上目录因此删不掉；清理尽力而为 */
function sweep(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 句柄未释放，留给 OS */ }
}

function store(dir, backend) { return createStore(dir, Buffer.alloc(32, 7), { backend: backend }); }

function addKey(s) {
  return s.createKey({
    name: '趋势', platform: 'deepseek', customName: '', key: 'sk-trend-0001',
    endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }]
  }).id;
}

BACKENDS.forEach(function (backend) {
  test(backend + ' 后端：每次观测各留一行，pending / unsupported 不进表', () => {
    const dir = tmp('hist-' + backend);
    try {
      const s = store(dir, backend);
      const id = addKey(s);
      s.saveBalance(id, { value: null, status: 'unsupported' });
      s.saveBalance(id, { value: null, status: 'pending' });
      s.saveTest(id, { status: 'pass', latency: 250.6, msg: 'GET /v1/models 返回正常，密钥可用' });
      s.saveTest(id, { status: 'fail', code: '401', msg: 'unauthorized' });
      s.saveBalance(id, { value: 88.5, status: 'ok' });
      s.saveBalance(id, { value: null, status: 'fail', msg: '余额接口 502' });

      const rows = s.listHistory(id);
      assert.deepStrictEqual(
        rows.map(function (r) { return r.kind + ':' + r.status; }),
        ['test:pass', 'test:fail', 'balance:ok', 'balance:fail'],
        '能力位与重置标记不是观测结果，不该进表'
      );
      assert.strictEqual(rows[0].latency, 251, 'latency 四舍五入成整数');
      assert.strictEqual(rows[0].value, null);
      assert.strictEqual(rows[0].detail, null, '通过的测试每次都是同一句话，不占库');
      assert.strictEqual(rows[1].detail, 'unauthorized', '失败原因要留下');
      assert.strictEqual(rows[2].value, 88.5);
      assert.strictEqual(rows[3].value, null);
      const latest = s.getKey(id);
      assert.strictEqual(rows[1].at, latest.test.at, '密钥上只留最近一次，历史里那条与之同时戳');
      assert.strictEqual(rows[3].at, latest.balance.updatedAt, '余额同理');
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：历史穿过持久层（重新打开存储读得回来）', () => {
    const dir = tmp('hist-reopen-' + backend);
    try {
      const a = store(dir, backend);
      const id = addKey(a);
      a.saveTest(id, { status: 'pass', latency: 120 });
      a.saveBalance(id, { value: 12.34, status: 'ok' });

      const rows = store(dir, backend).listHistory(id);
      assert.strictEqual(rows.length, 2, '真落盘，不是内存对象');
      assert.strictEqual(rows[0].kind, 'test');
      assert.strictEqual(rows[0].latency, 120);
      assert.strictEqual(rows[1].kind, 'balance');
      assert.strictEqual(rows[1].value, 12.34);
      assert.strictEqual(typeof rows[1].id, 'number', '行号是数字不是字符串');
      assert.deepStrictEqual(store(dir, backend).listHistory(id + 900), [], '别的密钥不该看到这段历史');
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：kind 过滤 + limit 取最近若干条，返回按时间升序', () => {
    const dir = tmp('hist-query-' + backend);
    try {
      const s = store(dir, backend);
      const id = addKey(s);
      s.saveTest(id, { status: 'pass', latency: 10 });
      s.saveBalance(id, { value: 50, status: 'ok' });
      s.saveTest(id, { status: 'pass', latency: 20 });
      s.saveBalance(id, { value: 40, status: 'ok' });
      s.saveTest(id, { status: 'fail', code: '429', msg: 'rate limited' });

      assert.deepStrictEqual(s.listHistory(id, { kind: 'test' }).map(function (r) { return r.latency; }), [10, 20, null]);
      assert.deepStrictEqual(s.listHistory(id, { kind: 'balance' }).map(function (r) { return r.value; }), [50, 40]);
      const last2 = s.listHistory(id, { limit: 2 });
      assert.deepStrictEqual(last2.map(function (r) { return r.kind; }), ['balance', 'test'], 'limit 取的是最近两条，且 oldest→newest');
      assert.deepStrictEqual(s.listHistory(id, { kind: 'test', limit: 1 }).map(function (r) { return r.detail; }), ['rate limited']);
      assert.strictEqual(s.listHistory(id, { limit: 0 }).length, 5, '非法 limit 退回默认值而不是空列表');
      assert.strictEqual(s.listHistory(id, { limit: 'abc' }).length, 5);
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：删除密钥连带清理历史', () => {
    const dir = tmp('hist-del-' + backend);
    try {
      const s = store(dir, backend);
      const mine = addKey(s);
      const other = addKey(s);
      s.saveTest(mine, { status: 'pass', latency: 10 });
      s.saveTest(other, { status: 'pass', latency: 20 });
      assert.strictEqual(s.deleteKey(mine), true);
      assert.deepStrictEqual(s.listHistory(mine), [], '不留孤儿行，否则同名新密钥会继承旧曲线');
      assert.strictEqual(s.listHistory(other).length, 1, '别的密钥不受影响');
    } finally { sweep(dir); }
  });

  test(backend + ' 后端：每密钥封顶 ' + CAP + ' 条，定时器不会把库写爆', () => {
    const dir = tmp('hist-cap-' + backend);
    try {
      const first = store(dir, backend);
      const id = addKey(first);
      /* 直接从落盘格式灌满，避免为了测裁剪在测试里跑一千次公开写路径 */
      if (backend === 'json') {
        const file = path.join(dir, 'store.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (let i = 0; i < CAP; i++) {
          data.history.push({ id: i + 1, keyId: id, at: '2026-01-01T00:00:00.000Z', kind: 'test', status: 'pass', latency: i, value: null, detail: null });
        }
        data.nextHistoryId = CAP + 1;
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } else {
        const { DatabaseSync } = require('node:sqlite');
        const raw = new DatabaseSync(path.join(dir, 'keys.db'));
        raw.exec('BEGIN');
        const ins = raw.prepare("INSERT INTO history (key_id, at, kind, status, latency) VALUES (?, '2026-01-01T00:00:00.000Z', 'test', 'pass', ?)");
        for (let i = 0; i < CAP; i++) ins.run(id, i);
        raw.exec('COMMIT');
        raw.close();
      }

      const s = store(dir, backend);
      assert.strictEqual(s.listHistory(id, { limit: CAP }).length, CAP, '老库读回整封顶条数');
      const row = s.appendHistory(id, { kind: 'test', status: 'pass', latency: 9999 });
      const rows = s.listHistory(id, { limit: CAP });
      assert.strictEqual(rows.length, CAP, '超出的从最旧那条开始丢');
      assert.strictEqual(rows[0].latency, 1, '丢的是最早的观测');
      assert.strictEqual(rows[rows.length - 1].latency, 9999);
      assert.strictEqual(rows[rows.length - 1].id, row.id, '追加返回的行号与读回来的一致');
    } finally { sweep(dir); }
  });
});

test('旧库没有历史结构时自动补上：JSON 缺 history 字段、SQLite 缺 history 表', () => {
  const dir = tmp('hist-legacy-json');
  try {
    const a = store(dir, 'json');
    const id = addKey(a);
    a.saveTest(id, { status: 'pass', latency: 30 });
    const file = path.join(dir, 'store.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete data.history;
    delete data.nextHistoryId;
    fs.writeFileSync(file, JSON.stringify(data, null, 2));

    const b = store(dir, 'json');
    assert.deepStrictEqual(b.listHistory(id), [], '修复前的库读不出历史，但不能报错');
    b.saveTest(id, { status: 'pass', latency: 40 });
    assert.strictEqual(b.listHistory(id).length, 1);
    assert.strictEqual(b.listHistory(id)[0].latency, 40);
  } finally { sweep(dir); }

  if (BACKENDS.indexOf('sqlite') < 0) return;
  const sdir = tmp('hist-legacy-sqlite');
  try {
    const a = store(sdir, 'sqlite');
    const id = addKey(a);
    a.saveTest(id, { status: 'pass', latency: 30 });
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(sdir, 'keys.db'));
    raw.exec('DROP TABLE history');
    raw.close();

    const b = store(sdir, 'sqlite');
    assert.strictEqual(b.getKey(id).test.latency, 30, '旧库的密钥记录照旧读得出');
    b.saveTest(id, { status: 'pass', latency: 40 });
    assert.strictEqual(b.listHistory(id).length, 1, '建表语句补上了历史表');
  } finally { sweep(sdir); }
});
