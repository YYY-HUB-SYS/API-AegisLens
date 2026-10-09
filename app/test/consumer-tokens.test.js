const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const ct = require('../src/consumer-tokens');

/* now 全模块按毫秒理解，payload 里存 Unix 秒——测试用一个「ms 时钟」同时喂两边，避免单位混用。 */
const T0_MS = 1762000000000;
const T0 = Math.floor(T0_MS / 1000);

function dek() { return crypto.randomBytes(32); }

function base(over) {
  return Object.assign({
    dek: dek(),
    label: 'claude-code',
    scopes: ['key:read'],
    keyIds: [1, 7],
    credIds: [],
    now: T0_MS
  }, over || {});
}

function issue(over) { return ct.issueToken(base(over)); }

function seg(token, i) { return String(token).split('.')[i]; }

/* 把 base64url 段解码→改一字节→重新编码，模拟「中间人篡改 payload」 */
function tamperPayload(token, mutator) {
  const body = seg(token, 1);
  const buf = Buffer.from(body, 'base64url');
  mutator(buf);
  return [seg(token, 0), buf.toString('base64url'), seg(token, 2)].join('.');
}

function containsNoSecret(haystack, needle) {
  return JSON.stringify(haystack).indexOf(needle) === -1;
}

/* 测试侧独立实现一遍设计文档里的签名方案：
   既给「已正确签名、但 payload 形状坏」的输入造得出信封，也顺带钉住 spec——
   tek = HKDF-SHA256(dek, salt="", info="aegis:consumer-token:v1", 32)
   sig = HMAC-SHA256(tek, "v1:" + payloadB64) */
function seal(payloadObj, secret) {
  const body = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const tek = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0),
    Buffer.from('aegis:consumer-token:v1'), 32));
  const sig = crypto.createHmac('sha256', tek).update('v1:' + body, 'utf8').digest('base64url');
  return 'v1.' + body + '.' + sig;
}

test('签发→验签：payload 原样回来，字段一个不多一个不少', () => {
  const d = dek();
  const issued = ct.issueToken({
    dek: d, label: 'cursor', scopes: ['key:read', 'balance:read'],
    keyIds: [3, 11], credIds: [5], ttlSeconds: 3600, now: T0_MS
  });
  assert.match(issued.token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.strictEqual(seg(issued.token, 1).indexOf('='), -1, 'base64url 不该带填充等号');
  assert.strictEqual(issued.payload.iat, T0);
  assert.strictEqual(issued.payload.exp, T0 + 3600);
  assert.strictEqual(issued.payload.label, 'cursor');
  assert.strictEqual(issued.payload.tid.length, 24);

  const v = ct.verifyToken(issued.token, { dek: d, now: T0_MS });
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  assert.deepStrictEqual(Object.keys(v.payload).sort(),
    ['credIds', 'exp', 'iat', 'keyIds', 'label', 'scopes', 'tid']);
  assert.deepStrictEqual(v.payload.keyIds, [3, 11]);
  assert.deepStrictEqual(v.payload.credIds, [5]);
  assert.strictEqual(v.remainingSeconds, 3600);
  assert.strictEqual(v.fingerprint, issued.fingerprint);
});

test('改一个字节 payload → bad-signature（遍历几个位置都拒）', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d }));
  const body = Buffer.from(seg(issued.token, 1), 'base64url');
  for (let i = 0; i < body.length; i += 7) {
    const t = tamperPayload(issued.token, function (b) { b[i] ^= 0x20; });
    assert.strictEqual(ct.verifyToken(t, { dek: d, now: T0_MS }).reason, 'bad-signature', '篡改偏移 ' + i);
  }
  // 换掉签名段本身、换掉版本头
  assert.strictEqual(ct.verifyToken(
    [seg(issued.token, 0), seg(issued.token, 1), seg(issued.token, 2).slice(0, -2) + 'AA'].join('.'),
    { dek: d, now: T0_MS }).reason, 'bad-signature');
  assert.strictEqual(ct.verifyToken('v2.' + seg(issued.token, 1) + '.' + seg(issued.token, 2),
    { dek: d, now: T0_MS }).reason, 'malformed');
});

test('过期：exp 前一刻放行，exp 整点起 expired', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d, ttlSeconds: 60 }));
  assert.strictEqual(issued.payload.exp, T0 + 60);
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: (T0 + 59) * 1000 }).ok, true);
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: (T0 + 60) * 1000 }).reason, 'expired');
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: (T0 + 61) * 1000 }).reason, 'expired');
});

test('时钟早于 iat 不算 notYetValid：不做该语义，确认不误拒', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d, ttlSeconds: 3600 }));
  for (const skew of [1000, 60000, 3599000]) {
    const r = ct.verifyToken(issued.token, { dek: d, now: T0_MS - skew });
    assert.strictEqual(r.ok, true, '早 ' + skew + 'ms 不该拒：' + JSON.stringify(r));
    assert.notStrictEqual(r.reason, 'notYetValid');
  }
  assert.ok(ct.REASONS.indexOf('notYetValid') !== -1, 'reason 枚举仍要给 api 层留位');
});

test('scope 不足 → scope；命中全部才放行', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d, scopes: ['key:read'] }));
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS, scopes: 'key:read' }).ok, true);
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS, scopes: ['key:read'] }).ok, true);
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS, scopes: 'key:test' }).reason, 'scope');
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS,
    scopes: ['key:read', 'balance:read'] }).reason, 'scope', '多要一项也不能过');
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS, scopes: ['nope'] }).reason, 'scope');
});

test('资源不在列表 → scope；在列表 → 放行', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d, keyIds: [1, 7], credIds: [4] }));
  const ok = ct.verifyToken(issued.token, { dek: d, now: T0_MS, scopes: 'key:read', resource: { keyId: 7 } });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS,
    resource: { keyId: 8 } }).reason, 'scope');
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS,
    resource: { credId: 4 } }).ok, true, 'credIds 走 credId 通道');
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS,
    resource: { keyId: 1, credId: 4 } }).reason, 'scope', '两个都填是调用方写错了');
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS, resource: 7 }).reason, 'scope');
});

test('keyIds: [] 是「零把可读」而不是「全部可读」', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d, keyIds: [], credIds: [], scopes: ['key:read', 'cred:read'] }));
  assert.deepStrictEqual(issued.payload.keyIds, []);
  const v = ct.verifyToken(issued.token, { dek: d, now: T0_MS });
  assert.strictEqual(v.ok, true, '令牌本体有效——拒绝发生在授权层');

  for (const id of [1, 42, 9999]) {
    assert.strictEqual(ct.authorize(v.payload, { scope: 'key:read', resourceId: id }).ok, false, 'id ' + id);
    assert.strictEqual(ct.authorize(v.payload, { scope: 'key:read', resourceId: id }).reason, 'scope');
    assert.strictEqual(ct.authorize(v.payload, { scope: 'cred:read', resourceId: id }).ok, false);
    assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: T0_MS,
      resource: { keyId: id } }).reason, 'scope');
  }
  // 不带具体资源问「有没有得读」，空清单同样是否
  assert.strictEqual(ct.authorize(v.payload, { scope: 'key:read' }).ok, false);
  assert.strictEqual(ct.authorize(v.payload, { scope: 'cred:read' }).ok, false);

  const full = ct.verifyToken(ct.issueToken(base({ dek: d, keyIds: [2] })).token, { dek: d, now: T0_MS }).payload;
  assert.strictEqual(ct.authorize(full, { scope: 'key:read', resourceId: 2 }).ok, true);
  assert.strictEqual(ct.authorize(full, { scope: 'key:read' }).ok, true);
  assert.strictEqual(ct.authorize(full, { scope: 'key:read', resourceId: 3 }).ok, false);
  assert.strictEqual(ct.authorize(full, { scope: 'balance:read', resourceId: 2 }).ok, false,
    '没签 balance:read 就是没有');
});

test('authorize：scope 白名单 + 资源清单双条件，入参不被改写', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d, scopes: ['key:read', 'key:test', 'balance:read'], keyIds: [1, 2] }));
  const snapshot = JSON.stringify(issued.payload);
  assert.strictEqual(ct.authorize(issued.payload, { scope: 'key:test', resourceId: 1 }).ok, true);
  assert.strictEqual(ct.authorize(issued.payload, { scope: 'cred:read', resourceId: 1 }).ok, false);
  assert.strictEqual(ct.authorize(issued.payload, { scope: '', resourceId: 1 }).reason, 'scope');
  assert.strictEqual(ct.authorize(issued.payload, { scope: 'key:admin', resourceId: 1 }).reason, 'scope');
  assert.strictEqual(ct.authorize(issued.payload, { scope: 'key:read', resourceId: 0 }).reason, 'scope');
  assert.strictEqual(ct.authorize(issued.payload, { scope: 'key:read', resourceId: '1' }).reason, 'scope');
  assert.strictEqual(ct.authorize(issued.payload, { scope: 'key:read' }).ok, true);
  assert.strictEqual(snapshot, JSON.stringify(issued.payload));
  for (const bad of [null, undefined, 'x', 42, [], { tid: 'zz' }]) {
    assert.strictEqual(ct.authorize(bad, { scope: 'key:read' }).reason, 'malformed', String(bad));
  }
});

test('换 DEK 后旧令牌全部失效（TEK 由 DEK 派生，这是有意的失效性质）', () => {
  const d1 = dek();
  const d2 = dek();
  const tokens = [
    ct.issueToken(base({ dek: d1, scopes: ['key:read'], keyIds: [1] })).token,
    ct.issueToken(base({ dek: d1, scopes: ['key:test'], keyIds: [2] })).token,
    ct.issueToken(base({ dek: d1, scopes: ['cred:read'], credIds: [3] })).token
  ];
  for (const t of tokens) {
    assert.strictEqual(ct.verifyToken(t, { dek: d1, now: T0_MS }).ok, true);
    assert.strictEqual(ct.verifyToken(t, { dek: d2, now: T0_MS }).reason, 'bad-signature');
  }
  const f1 = ct.tokenFingerprint(tokens[0], d1);
  assert.notStrictEqual(f1, ct.tokenFingerprint(tokens[0], d2), '指纹带 DEK 因子，换库后对不上');
});

test('timingSafeEqual 在长度不等时不抛，只报 bad-signature', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d }));
  const sig = seg(issued.token, 2);
  const variants = [
    sig.slice(0, 4),                        // 截断
    '',                                     // 空（结构层就拦下）
    sig + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',// 超长
    sig.replace(/=/g, '') + '+/=',          // 非法字符
    '****'
  ];
  for (const s of variants) {
    const t = [seg(issued.token, 0), seg(issued.token, 1), s].join('.');
    let r;
    assert.doesNotThrow(function () { r = ct.verifyToken(t, { dek: d, now: T0_MS }); }, '不该抛：' + s);
    assert.ok(r.ok === false && (r.reason === 'bad-signature' || r.reason === 'malformed'), s + ' → ' + JSON.stringify(r));
  }
  // DEK 形状不对也不抛：无信任根时按外来令牌处理
  for (const badDek of [null, undefined, 'x'.repeat(32), Buffer.alloc(31), Buffer.alloc(64)]) {
    assert.doesNotThrow(function () {
      assert.strictEqual(ct.verifyToken(issued.token, { dek: badDek, now: T0_MS }).reason, 'bad-signature');
    });
  }
});

test('verifyToken 对垃圾输入绝不抛，reason 一定在枚举里', () => {
  const d = dek();
  const junk = [null, undefined, 0, 42, {}, [], '', 'v1', 'v1.', 'v1..', 'v1.a.b.c', 'a.b.c',
    'v1.!!!.abc', 'v1.' + Buffer.from('{}').toString('base64url') + '.abc',
    Buffer.from('x'.repeat(9000)).toString('base64url')];
  for (const j of junk) {
    let r;
    assert.doesNotThrow(function () { r = ct.verifyToken(j, { dek: d, now: T0_MS }); }, String(j));
    assert.strictEqual(r.ok, false);
    assert.ok(ct.REASONS.indexOf(r.reason) !== -1, 'reason 必须在枚举里：' + r.reason);
    // 结构过关就先验签（bad-signature），结构不过就是 malformed；两者都是 401，都绝不抛
    assert.ok(r.reason === 'malformed' || r.reason === 'bad-signature', j + ' → ' + r.reason);
  }
  // 连签名段都没得比的，才是硬 malformed
  for (const j of [null, undefined, 0, 42, {}, [], '', 'v1', 'v1.', 'v1..', 'a.b.c',
    'v1.!!!.abc', 'v1.a.b.c', Buffer.from('x'.repeat(9000)).toString('base64url')]) {
    assert.strictEqual(ct.verifyToken(j, { dek: d, now: T0_MS }).reason, 'malformed', String(j));
  }
  assert.doesNotThrow(function () { ct.verifyToken(); });
});

test('签好名但形状坏的 payload → malformed（顺带钉住文档里的签名方案）', () => {
  const d = dek();
  const good = ct.issueToken(base({ dek: d })).payload;
  assert.strictEqual(ct.verifyToken(seal(good, d), { dek: d, now: T0_MS }).ok, true,
    '测试独立算出的签名必须被接受——否则实现和 spec 已经跑偏');
  const broken = [
    Object.assign({}, good, { scopes: 'key:read' }),
    Object.assign({}, good, { scopes: [] }),
    Object.assign({}, good, { scopes: ['key:admin'] }),
    Object.assign({}, good, { keyIds: ['1', 2] }),
    Object.assign({}, good, { keyIds: [0] }),
    Object.assign({}, good, { keyIds: [1.5] }),
    Object.assign({}, good, { keyIds: null }),
    Object.assign({}, good, { exp: '2000000000' }),
    Object.assign({}, good, { iat: 0 }),
    Object.assign({}, good, { tid: 'xyz!' + 'a'.repeat(20) }),
    Object.assign({}, good, { label: '' }),
    Object.assign({}, good, { admin: true }),
    Object.assign({}, good, { credIds: [], extra: 1 })
  ];
  for (const p of broken) {
    assert.strictEqual(ct.verifyToken(seal(p, d), { dek: d, now: T0_MS }).reason, 'malformed', JSON.stringify(p));
    assert.strictEqual(ct.authorize(p, { scope: 'key:read', resourceId: 1 }).reason, 'malformed');
  }
});

test('ttl 边界：60 秒下限、90 天上限、缺省 30 天', () => {
  const d = dek();
  const at = function (ttl) { return ct.issueToken(base({ dek: d, ttlSeconds: ttl })).payload.exp - T0; };
  assert.strictEqual(at(undefined), ct.DEFAULT_TTL_SECONDS);
  assert.strictEqual(at(null), ct.DEFAULT_TTL_SECONDS);
  assert.strictEqual(at(NaN), ct.DEFAULT_TTL_SECONDS);
  assert.strictEqual(at('abc'), ct.DEFAULT_TTL_SECONDS);
  assert.strictEqual(ct.MIN_TTL_SECONDS, 60);
  assert.strictEqual(at(0), 60);
  assert.strictEqual(at(-5), 60);
  assert.strictEqual(at(59), 60, '低于下限夹到 60');
  assert.strictEqual(at(60), 60);
  assert.strictEqual(at(3600), 3600);
  assert.strictEqual(ct.MAX_TTL_SECONDS, 90 * 86400);
  assert.strictEqual(at(ct.MAX_TTL_SECONDS), ct.MAX_TTL_SECONDS);
  assert.strictEqual(at(999999999), ct.MAX_TTL_SECONDS, '超上限夹到 90 天');
  assert.strictEqual(at(1e18), ct.MAX_TTL_SECONDS);
  assert.strictEqual(at(3600.9), 3600, '向下取整，别多给');
});

test('上限与入参校验：资源条目、label、scopes、非法 id', () => {
  const d = dek();
  const many = function (n) { const a = []; for (let i = 1; i <= n; i++) a.push(i); return a; };
  assert.strictEqual(ct.MAX_TOTAL_RESOURCE_IDS, 64);
  assert.doesNotThrow(function () {
    ct.issueToken(base({ dek: d, keyIds: many(64), credIds: [] }));
  });
  assert.doesNotThrow(function () {
    ct.issueToken(base({ dek: d, keyIds: many(40), credIds: many(24) })).payload;
  });
  for (const over of [
    base({ dek: d, keyIds: many(65) }),
    base({ dek: d, keyIds: many(60), credIds: many(5) }),
    base({ dek: d, label: '' }),
    base({ dek: d, label: '   ' }),
    base({ dek: d, label: 'x'.repeat(41) }),
    base({ dek: d, label: 42 }),
    base({ dek: d, label: null }),
    base({ dek: d, scopes: [] }),
    base({ dek: d, scopes: null }),
    base({ dek: d, scopes: ['key:read', 'key:admin'] }),
    base({ dek: d, keyIds: [0] }),
    base({ dek: d, keyIds: [-1] }),
    base({ dek: d, keyIds: [1.5] }),
    base({ dek: d, keyIds: ['3'] }),
    base({ dek: d, keyIds: 3 }),
    base({ dek: d, credIds: [2 ** 53] })
  ]) {
    assert.throws(() => ct.issueToken(over), err => err.httpStatus === 400);
  }
  // label 恰好 40 可过，首尾空白吃掉
  assert.strictEqual(ct.issueToken(base({ dek: d, label: 'x'.repeat(40) })).payload.label.length, 40);
  assert.strictEqual(ct.issueToken(base({ dek: d, label: '  内网门户  ' })).payload.label, '内网门户');
  // scopes 去重并按白名单顺序排列：同一集合永远签出同一串 payload
  assert.deepStrictEqual(ct.issueToken(base({ dek: d,
    scopes: ['balance:read', 'key:read', 'key:read'] })).payload.scopes, ['key:read', 'balance:read']);
  assert.deepStrictEqual(ct.issueToken(base({ dek: d, keyIds: [9, 1, 9, 3] })).payload.keyIds, [1, 3, 9]);
  // DEK 形状不对：500，不是 400
  assert.throws(() => ct.issueToken(base({ dek: Buffer.alloc(16) })), err => err.httpStatus === 500);
});

test('每次签发的 tid/token 都不同，签名覆盖 tid', () => {
  const d = dek();
  const a = ct.issueToken(base({ dek: d }));
  const b = ct.issueToken(base({ dek: d }));
  assert.notStrictEqual(a.payload.tid, b.payload.tid);
  assert.notStrictEqual(a.token, b.token);
  assert.notStrictEqual(a.fingerprint, b.fingerprint);
  // 拿 A 的签名配 B 的 payload：验不过
  assert.strictEqual(ct.verifyToken([seg(b.token, 0), seg(a.token, 1), seg(b.token, 2)].join('.'),
    { dek: d, now: T0_MS }).reason, 'bad-signature');
});

test('tokenFingerprint 稳定、短、单向：反推不出令牌', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d }));
  const fp = ct.tokenFingerprint(issued.token, d);
  assert.match(fp, /^[0-9a-f]{8}$/);
  assert.strictEqual(fp.length, ct.FINGERPRINT_HEX_LEN);
  assert.strictEqual(ct.tokenFingerprint(issued.token, d), fp, '同一令牌同一 DEK 必须永远同一个指纹');
  assert.strictEqual(ct.tokenFingerprint(issued.token, Buffer.from(d)), fp, '内容相同的 DEK 也一样');
  assert.strictEqual(issued.fingerprint, fp);

  const d2 = dek();
  const t2 = ct.issueToken(base({ dek: d2 })).token;
  assert.notStrictEqual(ct.tokenFingerprint(t2, d2), fp);

  // 不可逆推：指纹不是令牌的子串，且令牌任意前缀都不等于它；拿它当令牌喂 verify 只能 malformed
  assert.strictEqual(issued.token.indexOf(fp), -1);
  assert.strictEqual(issued.token.length > fp.length, true);
  assert.strictEqual(ct.verifyToken(fp, { dek: d, now: T0_MS }).reason, 'malformed');
  // 单向：知道指纹和 DEK 也造不出通过验签的令牌（只能靠撞 32bit，不是「推出来」）
  const forged = 'v1.' + seg(issued.token, 1) + '.' + fp;
  assert.strictEqual(ct.verifyToken(forged, { dek: d, now: T0_MS }).reason, 'bad-signature');
  // 审计旁路不崩
  assert.strictEqual(ct.tokenFingerprint('', d), null);
  assert.strictEqual(ct.tokenFingerprint(null, d), null);
  assert.strictEqual(ct.tokenFingerprint(issued.token, 'not-a-buffer'), null);
});

test('describeToken 给界面用的明文摘要，绝不含签名', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d, label: '本机的 agent', scopes: ['key:read', 'cred:read'],
    keyIds: [1, 2], credIds: [9], ttlSeconds: 120, now: T0_MS }));
  const info = ct.describeToken(issued.token, d, { now: (T0 + 60) * 1000 });
  assert.strictEqual(info.label, '本机的 agent');
  assert.deepStrictEqual(info.scopes, ['key:read', 'cred:read']);
  assert.deepStrictEqual(info.keyIds, [1, 2]);
  assert.deepStrictEqual(info.credIds, [9]);
  assert.strictEqual(info.exp, issued.payload.exp);
  assert.strictEqual(info.expiresAt, new Date(info.exp * 1000).toISOString());
  assert.strictEqual(info.expired, false);
  assert.strictEqual(info.remainingSeconds, 60);
  assert.strictEqual(info.resourceCount, 3);
  assert.strictEqual(info.fingerprint, issued.fingerprint);
  assert.strictEqual(info.version, 'v1');

  const dump = JSON.stringify(info);
  assert.strictEqual(dump.indexOf(seg(issued.token, 2)), -1, '摘要不许带签名段');
  assert.strictEqual(dump.indexOf(issued.token), -1, '摘要不许带完整令牌');
  assert.strictEqual(dump.indexOf(d.toString('hex')), -1, '摘要不许带 DEK');
  assert.strictEqual(info.sig, undefined);
  assert.strictEqual(info.signature, undefined);

  assert.strictEqual(ct.describeToken('garbage', d), null);
  assert.strictEqual(ct.describeToken(null, d), null);
  // 没 DEK 也能展示，只是没指纹
  assert.strictEqual(ct.describeToken(issued.token, null).fingerprint, null);
  // 过期标记
  assert.strictEqual(ct.describeToken(issued.token, d, { now: (T0 + 121) * 1000 }).expired, true);
});

test('返回值与错误信息不含完整令牌，更不含 TEK/DEK 字节', () => {
  const d = dek();
  const issued = ct.issueToken(base({ dek: d }));
  const ok = ct.verifyToken(issued.token, { dek: d, now: T0_MS, scopes: ['key:read'] });
  const denied = ct.verifyToken(issued.token, { dek: d, now: T0_MS, scopes: ['cred:read'] });
  const expiredRes = ct.verifyToken(issued.token, { dek: d, now: (T0 + 10 ** 7) * 1000 });

  // issueToken 返回令牌本身是它的唯一用途（只此一次给消费者），但结构里没有别处
  assert.deepStrictEqual(Object.keys(issued).sort(),
    ['expiresAt', 'fingerprint', 'issuedAt', 'payload', 'token', 'ttlSeconds', 'version']);
  const hex = d.toString('hex');
  for (const [name, value] of [['ok', ok], ['denied', denied], ['expired', expiredRes]]) {
    assert.strictEqual(containsNoSecret(value, issued.token), true, name + ' 不许回带完整令牌');
    assert.strictEqual(containsNoSecret(value, seg(issued.token, 2)), true, name + ' 不许回带签名');
    assert.strictEqual(containsNoSecret(value, hex), true, name + ' 不许回带 DEK/TEK');
  }
  assert.strictEqual(JSON.stringify(denied), '{"ok":false,"reason":"scope"}');

  // 校验错误：message 里只许出现被拒的字段值，不许出现密钥材料
  for (const bad of [base({ dek: d, scopes: ['nope'] }), base({ dek: d, keyIds: [-1] })]) {
    try {
      ct.issueToken(bad);
      assert.fail('该抛');
    } catch (err) {
      assert.strictEqual(err.message.indexOf(hex), -1);
      assert.strictEqual(String(err.stack).indexOf(hex), -1);
      assert.strictEqual(err.httpStatus, 400);
    }
  }
});

test('不验签的 describeToken 只解码，签错的令牌也能读——文档要求的用法顺序', () => {
  const d = dek();
  const other = dek();
  const foreign = ct.issueToken(base({ dek: other, label: '外来' }));
  assert.strictEqual(ct.verifyToken(foreign.token, { dek: d, now: T0_MS }).reason, 'bad-signature');
  const info = ct.describeToken(foreign.token, d);
  assert.strictEqual(info.label, '外来', 'describeToken 明示不验签，展示前必须先 verifyToken');
  assert.strictEqual(info.fingerprint.length, 8, '指纹按本地 DEK 算，跨库不通用');
});

test('时钟默认取 Date.now，不传 now 也能签能验', () => {
  const d = dek();
  const issued = ct.issueToken({ dek: d, label: 'svc', scopes: ['key:read'], keyIds: [1] });
  assert.ok(issued.payload.exp - issued.payload.iat === ct.DEFAULT_TTL_SECONDS);
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d }).ok, true);
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: undefined }).ok, true);
  assert.strictEqual(ct.verifyToken(issued.token, {}).reason, 'bad-signature');
  assert.strictEqual(ct.verifyToken(issued.token, { dek: d, now: -1 }).ok, true, 'now 不合法就退回当前时间');
});

/* ── 令牌的失效边界只跟 DEK 本体绑定 ──────────────────────────────
   这里翻的是 crypto.js 的真实生命周期，不是假想：写测试很容易顺手假定
   「设口令=换新钥匙」，而实现里 enablePassphrase 只是把原来那把 DEK 包一层。
   两头都钉住：改口令后旧令牌必须还活着（否则升级一次就把 20 个消费者全下线），
   换了 DEK 后旧令牌必须死（否则重建的库里残留作用域还在生效）。 */

const fsx = require('node:fs');
const osx = require('node:os');
const ptx = require('node:path');
const ac = require('../src/crypto');

const PW_A = 'first-passphrase-24';
const PW_B = 'second-passphrase-26';

test('设口令 / 改口令 / 丢弃 master.key 都不换 DEK，已签发令牌照样验得过', () => {
  const dir = fsx.mkdtempSync(ptx.join(osx.tmpdir(), 'aegis-tok-dek-'));
  try {
    const legacy = ac.unlockDek(dir);
    assert.strictEqual(legacy.mode, 'legacy');
    const issued = ct.issueToken({ dek: legacy.dek, label: 'svc', scopes: ['key:read'], keyIds: [1] });
    const want = { scopes: 'key:read', resource: { keyId: 1 } };
    assert.strictEqual(ct.verifyToken(issued.token, Object.assign({ dek: legacy.dek }, want)).ok, true);

    ac.enablePassphrase(dir, PW_A);
    const afterSet = ac.unlockDek(dir, PW_A);
    assert.strictEqual(afterSet.mode, 'envelope');
    assert.ok(afterSet.dek.equals(legacy.dek), '设口令只包一层，DEK 本体不能变');
    assert.strictEqual(ct.verifyToken(issued.token, Object.assign({ dek: afterSet.dek }, want)).ok, true);

    ac.changePassphrase(dir, PW_A, PW_B);
    const afterChange = ac.unlockDek(dir, PW_B);
    assert.ok(afterChange.dek.equals(legacy.dek), '改口令重包一次，DEK 本体仍不能变');
    assert.strictEqual(ct.verifyToken(issued.token, Object.assign({ dek: afterChange.dek }, want)).ok, true,
      '改口令绝不能变成「吊销全部令牌」的手段——那件事由 revoke 接口做');

    ac.discardRawDek(dir, PW_B, { confirm: true });
    assert.strictEqual(fsx.existsSync(ptx.join(dir, ac.VAULT_FILE)), true, 'vault.key 还在');
    assert.strictEqual(fsx.existsSync(ptx.join(dir, 'master.key')), false, '明文 DEK 副本已拆除');
    const afterDiscard = ac.unlockDek(dir, PW_B);
    assert.ok(afterDiscard.dek.equals(legacy.dek));
    assert.strictEqual(ct.verifyToken(issued.token, Object.assign({ dek: afterDiscard.dek }, want)).ok, true);

    /* 真正换根的那条路：换一个数据目录，就是另一把 DEK */
    const other = fsx.mkdtempSync(ptx.join(osx.tmpdir(), 'aegis-tok-dek2-'));
    try {
      const freshDek = ac.unlockDek(other).dek;
      assert.strictEqual(ct.verifyToken(issued.token, Object.assign({ dek: freshDek }, want)).reason, 'bad-signature');
    } finally {
      try { fsx.rmSync(other, { recursive: true, force: true }); } catch (e) { /* 清理尽力而为 */ }
    }
  } finally {
    try { fsx.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理尽力而为 */ }
  }
});
