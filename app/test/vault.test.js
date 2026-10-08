const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const vault = require('../src/vault');

function clock(start) {
  const c = { t: start === undefined ? 1700000000000 : start, now: function () { return c.t; } };
  c.advance = function (ms) { c.t += ms; return c.t; };
  return c;
}

function freshDek() { return crypto.randomBytes(32); }

test('未解锁时取不到任何密钥材料，且给出 423 语义', () => {
  const s = vault.createVaultSession({ now: clock().now });
  assert.strictEqual(s.isUnlocked(), false);
  assert.strictEqual(s.mode(), null);
  assert.strictEqual(s.unlockedSince(), null);
  assert.throws(() => s.key(), err => err.httpStatus === 423 && /未解锁/.test(err.message));
  assert.strictEqual(s.lockIfIdle(), false, '本来就锁着，不该报成「刚锁上」');
});

test('锁定会把 DEK 字节清零，不是只丢引用', () => {
  const s = vault.createVaultSession({});
  const dek = freshDek();
  const before = Buffer.from(dek);
  s.attach(dek, 'envelope');
  assert.deepStrictEqual(s.key(), before);
  assert.strictEqual(s.lock(), true);
  assert.ok(dek.every(function (b) { return b === 0; }), '原 Buffer 必须被填零');
  assert.strictEqual(Buffer.compare(dek, before), -1);
});

test('重复 attach 会先清掉上一把 DEK', () => {
  const s = vault.createVaultSession({});
  const first = freshDek();
  const firstCopy = Buffer.from(first);
  s.attach(first, 'legacy');
  const second = freshDek();
  s.attach(second, 'envelope');
  assert.ok(first.every(b => b === 0), '被替换的旧 DEK 不该还能读');
  assert.notStrictEqual(first, firstCopy);
  assert.deepStrictEqual(s.key(), second);
  assert.strictEqual(s.mode(), 'envelope');
});

test('DEK 形状不对直接拒，不能塞进会话', () => {
  const s = vault.createVaultSession({});
  for (const bad of [null, undefined, 'x'.repeat(32), Buffer.alloc(31), Buffer.alloc(64), 12345]) {
    assert.throws(() => s.attach(bad, 'legacy'), /形状不对/, String(bad));
  }
  assert.strictEqual(s.isUnlocked(), false);
});

test('闲置自动锁：取用会顺延计时，超时才锁，且只锁一次', () => {
  const c = clock(0);
  const s = vault.createVaultSession({ now: c.now, idleLockMs: 1000 });
  const dek = freshDek();
  s.attach(dek, 'envelope');
  c.advance(700);
  assert.strictEqual(s.lockIfIdle(), false);
  assert.strictEqual(s.idleRemaining(), 300);
  s.key();
  assert.strictEqual(s.idleRemaining(), 1000, '刚取用就重置了整段闲置窗口');
  c.advance(999);
  assert.strictEqual(s.lockIfIdle(), false);
  c.advance(1);
  assert.strictEqual(s.lockIfIdle(), true);
  assert.strictEqual(s.isUnlocked(), false);
  assert.strictEqual(s.lockIfIdle(), false, '已锁定不该重复报成刚锁');
  assert.ok(dek.every(b => b === 0));
});

test('审计只记事件不记内容', () => {
  const c = clock(5);
  const s = vault.createVaultSession({ now: c.now, idleLockMs: 10 });
  const dek = freshDek();
  s.attach(dek, 'envelope');
  c.advance(10);
  s.lockIfIdle();
  const rows = s.audit.list();
  assert.deepStrictEqual(rows.map(r => r.kind), ['unlock', 'lock']);
  assert.deepStrictEqual(rows.map(r => r.status), ['ok', 'ok']);
  assert.strictEqual(rows[0].detail, 'envelope');
  assert.strictEqual(rows[1].detail, 'idle');
  assert.strictEqual(rows[0].at, 5);
  assert.strictEqual(rows[1].at, 15);
  const dump = JSON.stringify(rows);
  assert.ok(dump.indexOf(dek.toString('hex')) === -1, '审计里绝不能出现密钥字节');
  assert.ok(dump.indexOf('sk-') === -1);
});

test('审计是环形缓冲，超上限丢最旧', () => {
  const a = vault.createAuditSink({ now: clock().now, maxEntries: 3 });
  for (let i = 1; i <= 5; i++) a.push({ kind: 'reveal', target: i, status: 'ok' });
  assert.deepStrictEqual(a.list().map(r => r.target), ['3', '4', '5']);
  a.clear();
  assert.deepStrictEqual(a.list(), []);
});

test('限流：连续失败到上限才锁，锁定期拒绝，到期放行', () => {
  const c = clock(0);
  const t = vault.createThrottle({ now: c.now, maxFails: 3, lockMs: 60000 });
  assert.strictEqual(t.check('127.0.0.1').allowed, true);
  assert.deepStrictEqual(t.failed('127.0.0.1'), { locked: false, failsRemaining: 2 });
  t.failed('127.0.0.1');
  assert.strictEqual(t.failed('127.0.0.1').locked, true);
  const res = t.check('127.0.0.1');
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.retryAfterMs, 60000);
  c.advance(59999);
  assert.strictEqual(t.check('127.0.0.1').allowed, false);
  c.advance(1);
  assert.strictEqual(t.check('127.0.0.1').allowed, true);
  assert.strictEqual(t.check('127.0.0.1').allowed, true, '放行不该消耗锁定');
  assert.strictEqual(t.peek('127.0.0.1').fails, 0, '锁期满后计数必须归零，不能带着旧失败次数');
});

test('限流按 key 隔离，成功一次清零', () => {
  const t = vault.createThrottle({ now: clock().now, maxFails: 2, lockMs: 1000 });
  t.failed('a');
  assert.strictEqual(t.failed('a').locked, true);
  assert.strictEqual(t.check('b').allowed, true, '不能因为 a 失败就锁住 b');
  t.failed('c');
  t.passed('c');
  assert.strictEqual(t.peek('c').fails, 0);
  assert.strictEqual(t.failed('c').locked, false, '清零后不该一次就锁');
  t.reset();
  assert.strictEqual(t.check('a').allowed, true);
});

test('掩码：末 4 位，短值原样，空值安全', () => {
  assert.strictEqual(vault.maskSecret('sk-8f2ac41d5b9e7c03'), '7c03');
  assert.strictEqual(vault.maskSecret('abcd'), 'abcd');
  assert.strictEqual(vault.maskSecret('ab'), 'ab');
  assert.strictEqual(vault.maskSecret(''), '');
  assert.strictEqual(vault.maskSecret(null), '');
  assert.strictEqual(vault.maskSecret(undefined), '');
});

test('密钥视图去掉明文只留末 4 位，其余字段不动', () => {
  const rec = { id: 3, name: '主号', platform: 'deepseek', key: 'sk-secret-tail-9f3d', endpoints: [{ url: 'https://x' }] };
  const view = vault.maskedKeyView(rec);
  assert.strictEqual(view.key, undefined);
  assert.strictEqual(view.keyMasked, '9f3d');
  assert.strictEqual(view.name, '主号');
  assert.deepStrictEqual(view.endpoints, rec.endpoints);
  assert.strictEqual(rec.key, 'sk-secret-tail-9f3d', '不得改写入参');
  assert.ok(JSON.stringify(view).indexOf('secret-tail') === -1);
});

test('凭证视图连密文都不给，只给有没有存过的布尔', () => {
  const enc = 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const cred = {
    id: 7, title: '内网门户', username: 'ops', url: 'https://intra', folder: '公司', tags: 'a,b',
    passwordEnc: enc, secretEnc: '', totpEnc: enc, noteEnc: null, createdAt: '2026-10-08T00:00:00Z'
  };
  const view = vault.maskedCredentialView(cred);
  vault.CREDENTIAL_SECRET_FIELDS.forEach(function (f) {
    assert.strictEqual(view[f], undefined, f + ' 不得出现在列表视图');
  });
  assert.strictEqual(view.hasPassword, true);
  assert.strictEqual(view.hasSecret, false, '空串算没存');
  assert.strictEqual(view.hasTotp, true);
  assert.strictEqual(view.hasNote, false);
  assert.strictEqual(view.username, 'ops');
  assert.strictEqual(view.title, '内网门户');
  assert.ok(JSON.stringify(view).indexOf('enc:v1') === -1);
  assert.strictEqual(cred.passwordEnc, enc, '不得改写入参');
});

test('免密模式：会话开着但不持有 DEK，key() 明确拒而不是给空 Buffer', () => {
  const s = vault.createVaultSession({ now: clock().now });
  assert.strictEqual(s.openLegacy(), true);
  assert.strictEqual(s.isUnlocked(), true);
  assert.strictEqual(s.mode(), 'legacy');
  assert.throws(() => s.key(), err => err.httpStatus === 423 && /免密模式/.test(err.message));
  assert.strictEqual(s.openLegacy(), false, '重复 open 不该再记一条解锁');
  assert.deepStrictEqual(s.audit.list().map(r => r.kind), ['unlock']);
  assert.strictEqual(s.audit.list()[0].detail, 'legacy');
});

test('免密模式没有闲置锁：锁了就只能重启，用户会以为数据没了', () => {
  const c = clock(0);
  const s = vault.createVaultSession({ now: c.now, idleLockMs: 10 });
  s.openLegacy();
  c.advance(999999);
  assert.strictEqual(s.idleRemaining(), 0);
  assert.strictEqual(s.lockIfIdle(), false);
  assert.strictEqual(s.isUnlocked(), true);
  assert.strictEqual(s.lock(), true, '手动锁还是给的，免密下再 unlock 不需要口令');
});

test('legacy 切到 envelope：先落 lock 再落 unlock，闲置窗口才开始计时', () => {
  const c = clock(0);
  const s = vault.createVaultSession({ now: c.now, idleLockMs: 50 });
  s.openLegacy();
  s.attach(freshDek(), 'envelope');
  assert.deepStrictEqual(
    s.audit.list().map(r => r.kind + ':' + r.detail),
    ['unlock:legacy', 'lock:replaced', 'unlock:envelope']
  );
  assert.strictEqual(s.idleRemaining(), 50);
  c.advance(50);
  assert.strictEqual(s.lockIfIdle(), true);
});

test('免密会话带 DEK 时 key() 直接可用——凭证解密出口不必为免密特判', () => {
  const s = vault.createVaultSession({ now: clock().now });
  const dek = freshDek();
  s.openLegacy(dek);
  assert.strictEqual(s.mode(), 'legacy');
  assert.strictEqual(s.isUnlocked(), true);
  assert.deepStrictEqual(s.key(), dek);
  assert.strictEqual(s.openLegacy(dek), false, '同一把 DEK 重复开不该重记审计');
  const other = freshDek();
  assert.strictEqual(s.openLegacy(other), true);
  assert.deepStrictEqual(s.key(), other);
  assert.strictEqual(s.audit.list().filter(r => r.kind === 'lock').length, 1, '换 DEK 要先落一条 lock');
  assert.throws(() => s.openLegacy('not-a-buffer'), err => err.httpStatus === 500);
  assert.throws(() => s.openLegacy(Buffer.alloc(31)), err => err.httpStatus === 500);
  assert.strictEqual(s.key(), other, '传错形状不能把已经开着的会话搞坏');
  // 调用方常写 openLegacy(opts.dek)，缺席时是 undefined，不能被当成一把坏 DEK 抛错
  assert.doesNotThrow(() => s.openLegacy(undefined));
  assert.strictEqual(s.mode(), 'legacy');
  assert.throws(() => s.key(), err => err.httpStatus === 423, '没给 DEK 就是没有 DEK');
  assert.doesNotThrow(() => s.openLegacy(null));
});

test('免密借来的 DEK 锁定后不得清零——那是存储层唯一的密钥', () => {
  const s = vault.createVaultSession({});
  const borrowed = freshDek();
  const copy = Buffer.from(borrowed);
  s.openLegacy(borrowed);
  assert.deepStrictEqual(s.key(), copy);
  s.lock();
  assert.deepStrictEqual(borrowed, copy, '清零借来的 DEK 会让整库永久解不开');
  s.openLegacy(borrowed);
  assert.deepStrictEqual(s.key(), copy, '再解锁还得能用同一把接着解');
  // 对照：只有会话自己 attach 的才归它负责销毁
  const mine = freshDek();
  s.attach(mine, 'envelope');
  s.lock();
  assert.ok(mine.every(function (b) { return b === 0; }));
});
