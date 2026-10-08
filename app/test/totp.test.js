const { test } = require('node:test');
const assert = require('node:assert');
const {
  decodeBase32,
  generate,
  parseOtpauthUri,
  secondsRemaining
} = require('../src/totp');

/* RFC 6238 附录 B 的三组测试向量。
   密钥是 ASCII 数字序列的前 20/32/64 个字符，所以这里一律用 slice 程序化取长度。
   绝不手打 base32 再数长度：SHA512 组要 64 字节，少数字节会得到 56 字节的密钥，
   HMAC 照样算得出来、码却全错且不报错——这正是本模块踩过的那一个坑。 */
const SEED = '1234567890123456789012345678901234567890123456789012345678901234';
const KEY_SHA1 = Buffer.from(SEED.slice(0, 20), 'ascii');
const KEY_SHA256 = Buffer.from(SEED.slice(0, 32), 'ascii');
const KEY_SHA512 = Buffer.from(SEED.slice(0, 64), 'ascii');

/* 同一批密钥的 base32 形态，用于验证字符串入口与字节入口给出同一个码 */
const B32_SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const B32_SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const B32_SHA512 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';

// RFC 6238 的时间戳（Unix 秒）——注意不含 1111504490 / 1111812000，那是 RFC 6230 的 HOTP 值
const T = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
const VECTORS = {
  sha1: ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'],
  sha256: ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706'],
  sha512: ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826']
};
const KEYS = { sha1: KEY_SHA1, sha256: KEY_SHA256, sha512: KEY_SHA512 };

function assertGroup(algorithm) {
  for (let i = 0; i < T.length; i++) {
    const got = generate({ secret: KEYS[algorithm], at: T[i], step: 30, digits: 8, algorithm: algorithm });
    assert.strictEqual(got, VECTORS[algorithm][i],
      algorithm + ' T=' + T[i] + ' 期望 ' + VECTORS[algorithm][i] + ' 实得 ' + got);
  }
}

test('RFC 6238 SHA1 组 6 条向量逐条命中', () => assertGroup('sha1'));
test('RFC 6238 SHA256 组 6 条向量逐条命中', () => assertGroup('sha256'));
test('RFC 6238 SHA512 组 6 条向量逐条命中', () => assertGroup('sha512'));

test('三组密钥的字节长度必须是 20/32/64，base32 入口与字节入口同码', () => {
  assert.strictEqual(KEY_SHA1.length, 20);
  assert.strictEqual(KEY_SHA256.length, 32);
  assert.strictEqual(KEY_SHA512.length, 64);
  assert.strictEqual(decodeBase32(B32_SHA1).length, 20);
  assert.strictEqual(decodeBase32(B32_SHA256).length, 32);
  assert.strictEqual(decodeBase32(B32_SHA512).length, 64);
  assert.ok(decodeBase32(B32_SHA1).equals(KEY_SHA1));
  assert.ok(decodeBase32(B32_SHA256).equals(KEY_SHA256));
  assert.ok(decodeBase32(B32_SHA512).equals(KEY_SHA512));
  for (const algorithm of ['sha1', 'sha256', 'sha512']) {
    const b32 = algorithm === 'sha1' ? B32_SHA1 : algorithm === 'sha256' ? B32_SHA256 : B32_SHA512;
    for (let i = 0; i < T.length; i++) {
      assert.strictEqual(
        generate({ secret: b32, at: T[i], step: 30, digits: 8, algorithm: algorithm }),
        generate({ secret: KEYS[algorithm], at: T[i], step: 30, digits: 8, algorithm: algorithm }),
        algorithm + ' 的 base32 入口与 Buffer 入口在 T=' + T[i] + ' 上必须同码'
      );
    }
  }
});

test('6 位码恒等于 8 位码的后 6 位（10^8 是 10^6 的整数倍）', () => {
  for (const algorithm of ['sha1', 'sha256', 'sha512']) {
    for (let i = 0; i < T.length; i++) {
      const eight = generate({ secret: KEYS[algorithm], at: T[i], digits: 8, algorithm: algorithm });
      const six = generate({ secret: KEYS[algorithm], at: T[i], digits: 6, algorithm: algorithm });
      assert.strictEqual(six, eight.slice(-6), algorithm + ' T=' + T[i]);
    }
  }
});

test('码是定长字符串，前导零不许被吞（07081804 就是证据）', () => {
  const code = generate({ secret: KEY_SHA1, at: 1111111109, digits: 8 });
  assert.strictEqual(typeof code, 'string');
  assert.strictEqual(code, '07081804');
  assert.strictEqual(code.length, 8);
  assert.match(code, /^\d{8}$/);
  assert.match(generate({ secret: KEY_SHA1, at: 59, digits: 6 }), /^\d{6}$/);
});

test('at 可以是 Unix 秒、Date 或 ISO 字符串，三者同码', () => {
  const asSeconds = generate({ secret: KEY_SHA1, at: 1111111111, digits: 8 });
  const asDate = generate({ secret: KEY_SHA1, at: new Date(1111111111 * 1000), digits: 8 });
  const asIso = generate({ secret: KEY_SHA1, at: new Date(1111111111 * 1000).toISOString(), digits: 8 });
  assert.strictEqual(asDate, asSeconds);
  assert.strictEqual(asIso, asSeconds);
  assert.strictEqual(asSeconds, '14050471');
});

test('同一窗口内取值稳定，跨窗口才变', () => {
  const a = generate({ secret: KEY_SHA1, at: 60, digits: 8 });
  const b = generate({ secret: KEY_SHA1, at: 89.999, digits: 8 });
  const c = generate({ secret: KEY_SHA1, at: 90, digits: 8 });
  assert.strictEqual(a, b, '同一个 30 秒窗口必须同码');
  assert.strictEqual(a, generate({ secret: KEY_SHA1, at: 59 + 30, digits: 8 }));
  assert.notStrictEqual(a, c, '跨过窗口边界必须换码');
});

test('step 真的参与计算：60 秒步长下 0 与 59 同码、59 与 60 换码', () => {
  // step=60 时窗口 0 覆盖 [0,60)，所以 59 与 60 分属两个窗口（不是同一个）
  assert.strictEqual(
    generate({ secret: KEY_SHA1, at: 0, step: 60, digits: 8 }),
    generate({ secret: KEY_SHA1, at: 59, step: 60, digits: 8 })
  );
  assert.notStrictEqual(
    generate({ secret: KEY_SHA1, at: 59, step: 60, digits: 8 }),
    generate({ secret: KEY_SHA1, at: 60, step: 60, digits: 8 })
  );
  // 同一时刻换步长必须换码，证明 step 没有被子传死用 30
  assert.notStrictEqual(
    generate({ secret: KEY_SHA1, at: 59, step: 60, digits: 8 }),
    generate({ secret: KEY_SHA1, at: 59, step: 30, digits: 8 })
  );
  assert.strictEqual(
    generate({ secret: KEY_SHA1, at: 59, step: 30, digits: 8 }),
    generate({ secret: KEY_SHA1, at: 59, digits: 8 })
  );
});

test('algorithm 归一化：大小写、HMAC- 前缀与空白都接受', () => {
  const lower = generate({ secret: KEY_SHA256, at: 59, digits: 8, algorithm: 'sha256' });
  assert.strictEqual(generate({ secret: KEY_SHA256, at: 59, digits: 8, algorithm: 'SHA256' }), lower);
  assert.strictEqual(generate({ secret: KEY_SHA256, at: 59, digits: 8, algorithm: 'HMAC-SHA256' }), lower);
  assert.strictEqual(generate({ secret: KEY_SHA256, at: 59, digits: 8, algorithm: ' sha256 ' }), lower);
  // 不传 algorithm 时默认 SHA1，必须与 RFC 的 SHA1 向量一致
  assert.strictEqual(generate({ secret: KEY_SHA1, at: 59, digits: 8 }), '94287082');
  assert.strictEqual(generate({ secret: KEY_SHA1, at: 59, digits: 8, algorithm: undefined }), '94287082');
});

test('base32 解码：大小写归一、忽略空格与连字符、忽略尾部填充', () => {
  const canonical = decodeBase32(B32_SHA1);
  assert.ok(decodeBase32(B32_SHA1.toLowerCase()).equals(canonical));
  assert.ok(decodeBase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').equals(canonical));
  assert.ok(decodeBase32(B32_SHA1 + '======').equals(canonical));
  assert.ok(decodeBase32('GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ').equals(canonical));
  assert.ok(decodeBase32('  ' + B32_SHA1 + '  ').equals(canonical));
});

test('base32 非法输入必须抛错，不许静默产出一个错密钥', () => {
  // 0/1/8/9 不在 RFC 4648 字符表里，抄错的 secret 常被这样混进来
  for (const bad of ['JBSWY3DP0', 'JBSWY3DP1', 'JBSWY3DP8', 'JBSWY3DP9']) {
    assert.throws(() => decodeBase32(bad), /非法字符/, bad + ' 应当被拒');
  }
  assert.throws(() => decodeBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJ!'), /非法字符/);
  assert.throws(() => decodeBase32('你好世界'), /非法字符/);
  assert.throws(() => decodeBase32(''), /为空/);
  assert.throws(() => decodeBase32('   =' + '='.repeat(6)), /为空/);
  assert.throws(() => decodeBase32('ABCD=EF'), /中间出现填充/);
  // 末尾余量非零说明字符串被截断了：ABCDE 余 1 位为 0（合法），ABCDF 余 1 位为 1（非法）
  assert.doesNotThrow(() => decodeBase32('ABCDE'));
  assert.strictEqual(decodeBase32('ABCDE').length, 3);
  assert.throws(() => decodeBase32('ABCDF'), /余量非零/);
  assert.throws(() => decodeBase32(123), TypeError);
  assert.throws(() => decodeBase32(null), TypeError);
});

test('generate 的参数校验把不可信输入挡在 HMAC 之前', () => {
  const secret = B32_SHA1;
  for (const bad of [4, 5, 7, 9, 0, -6, 6.5, 'ten', NaN, Infinity]) {
    assert.throws(() => generate({ secret: secret, digits: bad }), /digits/, String(bad) + ' 不该被接受');
  }
  for (const bad of [0, -30, NaN, Infinity, '', 'abc']) {
    assert.throws(() => generate({ secret: secret, step: bad }), /step/, String(bad) + ' 不该被接受');
  }
  for (const bad of ['md5', 'sha0', 'sha384', 'blake2', 'plaintext']) {
    assert.throws(() => generate({ secret: secret, algorithm: bad }), /algorithm/, bad + ' 不该被接受');
  }
  assert.throws(() => generate({ secret: '' }), /secret/);
  assert.throws(() => generate({}), /secret/);
  assert.throws(() => generate({ secret: Buffer.alloc(0) }), /字节数为 0/);
  assert.throws(() => generate({ secret: 42 }), TypeError);
  assert.throws(() => generate({ secret: secret, at: 'not-a-time' }), /at/);
  assert.throws(() => generate({ secret: secret, at: new Date('nope') }), /非法 Date/);
  assert.throws(() => generate({ secret: secret, at: {} }), TypeError);
  // 6 与 8 是仅有的合法位数
  assert.doesNotThrow(() => generate({ secret: secret, digits: 6 }));
  assert.doesNotThrow(() => generate({ secret: secret, digits: 8 }));
});

test('表单形态的字符串参数照样可用', () => {
  assert.strictEqual(generate({ secret: B32_SHA1, at: '59', digits: '8', step: '30' }), '94287082');
  // 纯数字串是 Unix 秒，不是「公元 59 年」——这条区分靠的是显式数值判断，不能交给 Date.parse
  assert.strictEqual(generate({ secret: B32_SHA1, at: '1111111111', digits: 8 }), '14050471');
  assert.strictEqual(generate({ secret: B32_SHA1, at: 1111111111, digits: 8 }), '14050471');
  assert.strictEqual(secondsRemaining('59', 30), 1);
  // ISO 字符串仍然按墙上时刻解释
  assert.strictEqual(generate({ secret: B32_SHA1, at: '2005-03-18T01:58:31.000Z', digits: 8 }), '14050471');
  // 1111111110 恰好是 30 的倍数（窗口起点），+6 秒即窗口第 7 秒，剩 24
  assert.strictEqual(secondsRemaining(1111111110, 30), 30);
  assert.strictEqual(secondsRemaining(new Date(1111111111 * 1000 + 5000), 30), 24);
  assert.strictEqual(secondsRemaining(1111111110, 30), 30);
});

/* ---------------- otpauth URI ---------------- */

const URI_FULL = 'otpauth://totp/GitHub:alice@example.com'
  + '?secret=' + B32_SHA1
  + '&issuer=GitHub&period=60&digits=8&algorithm=SHA256';

test('parseOtpauthUri 完整参数：类型/标签/issuer/period/digits/algorithm 全部落位', () => {
  const p = parseOtpauthUri(URI_FULL);
  assert.strictEqual(p.type, 'totp');
  assert.strictEqual(p.issuer, 'GitHub');
  assert.strictEqual(p.account, 'alice@example.com');
  assert.strictEqual(p.secret, B32_SHA1);
  assert.strictEqual(p.step, 60);
  assert.strictEqual(p.digits, 8);
  assert.strictEqual(p.algorithm, 'sha256');
  assert.strictEqual(p.secretBytes.length, 20);
});

test('parseOtpauthUri 缺参数时落到 RFC 默认值：30 秒 / 6 位 / SHA1', () => {
  const p = parseOtpauthUri('otpauth://totp/alice@example.com?secret=' + B32_SHA1);
  assert.strictEqual(p.step, 30);
  assert.strictEqual(p.digits, 6);
  assert.strictEqual(p.algorithm, 'sha1');
  assert.strictEqual(p.issuer, null);
  assert.strictEqual(p.account, 'alice@example.com');
  // 默认值下的码必须与显式传参一致
  assert.strictEqual(p.generate(59),
    generate({ secret: B32_SHA1, at: 59, step: 30, digits: 6, algorithm: 'sha1' }));
});

test('parseOtpauthUri 的 generate 与同参数直接调用对齐（URI 用 SHA1 密钥 + SHA256 算法 + 60 秒）', () => {
  const p = parseOtpauthUri(URI_FULL);
  // 注意：URI 带的是那把 20 字节的 base32 密钥，算法却声明 SHA256——这是合法组合（HMAC 对密钥长度不设 20 的要求），
  // 所以期望值必须按 URI 自己的 secret/period/digits/algorithm 现算，不能顺手拿 RFC 的 32 字节 SHA256 密钥去比
  for (const at of [59, 1111111111, 1234567890]) {
    assert.strictEqual(p.generate(at),
      generate({ secret: B32_SHA1, at: at, step: 60, digits: 8, algorithm: 'sha256' }),
      'T=' + at + ' 处 URI.generate 与直接调用必须同码');
  }
  // 且必须确实不同于按默认 30 秒步长算出来的码，证明 period 真的被用上了
  assert.notStrictEqual(p.generate(1111111111),
    generate({ secret: B32_SHA1, at: 1111111111, step: 30, digits: 8, algorithm: 'sha256' }));
});

test('issuer 参数优先于标签前缀，两者都缺时为 null', () => {
  const fromParam = parseOtpauthUri('otpauth://totp/OldName:bob@example.com?secret=' + B32_SHA1 + '&issuer=Real%20Issuer');
  assert.strictEqual(fromParam.issuer, 'Real Issuer');
  const fromLabel = parseOtpauthUri('otpauth://totp/JustLabel%3Acarol@example.com?secret=' + B32_SHA1);
  assert.strictEqual(fromLabel.issuer, 'JustLabel');
  assert.strictEqual(fromLabel.account, 'carol@example.com');
  const bare = parseOtpauthUri('otpauth://totp/?secret=' + B32_SHA1);
  assert.strictEqual(bare.issuer, null);
  assert.strictEqual(bare.account, null);
});

test('HOTP URI 明确拒绝，且报错要说清是类型不支持而非解析失败', () => {
  const hotp = 'otpauth://hotp/ACME:dave@example.com?secret=' + B32_SHA1 + '&counter=7';
  assert.throws(() => parseOtpauthUri(hotp), /HOTP/);
  assert.throws(() => parseOtpauthUri(hotp), /拒绝导入/);
  assert.throws(() => parseOtpauthUri('otpauth://HOTP/x?secret=' + B32_SHA1), /HOTP/);
  assert.throws(() => parseOtpauthUri('otpauth://totp2/x?secret=' + B32_SHA1), /类型不支持/);
});

test('otpauth URI 的各种坏输入一律抛错', () => {
  assert.throws(() => parseOtpauthUri('https://totp/x?secret=' + B32_SHA1), /不是 otpauth URI/);
  assert.throws(() => parseOtpauthUri('otpauth:/totp/x?secret=' + B32_SHA1), /缺少类型段/);
  assert.throws(() => parseOtpauthUri('totp/x?secret=' + B32_SHA1), /无法解析/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/x'), /缺少 secret/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/x?secret='), /缺少 secret/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/x?secret=%20%20'), /缺少 secret/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/x?secret=!!!!'), /secret 非法/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/x?secret=' + B32_SHA1 + '&digits=7'), /digits/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/x?secret=' + B32_SHA1 + '&period=0'), /step/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/x?secret=' + B32_SHA1 + '&period=abc'), /step/);
  assert.throws(() => parseOtpauthUri('otpauth://totp/x?secret=' + B32_SHA1 + '&algorithm=MD5'), /algorithm/);
  assert.throws(() => parseOtpauthUri(''), /无法解析/);
  assert.throws(() => parseOtpauthUri(null), TypeError);
  assert.throws(() => parseOtpauthUri(42), TypeError);
});

test('URI 前后空白与参数名大小写不影响解析', () => {
  const p = parseOtpauthUri('  ' + URI_FULL + '  ');
  assert.strictEqual(p.step, 60);
  const upper = parseOtpauthUri('OTPAUTH://TOTP/x?secret=' + B32_SHA1 + '&DIGITS=8&PERIOD=30');
  assert.strictEqual(upper.digits, 8);
  assert.strictEqual(upper.step, 30);
  // 参数名大小写混写是真会遇到的（各家生成器都有），绝不能当成"没提供"而静默走默认值
  const messy = parseOtpauthUri('otpauth://totp/x?SECRET=' + B32_SHA1 + '&Digits=8&Period=60&ALGORITHM=SHA256');
  assert.strictEqual(messy.secret, B32_SHA1);
  assert.strictEqual(messy.digits, 8);
  assert.strictEqual(messy.step, 60);
  assert.strictEqual(messy.algorithm, 'sha256');
});

test('负计数器直接拒绝：1970 年前的时间戳说明时钟或输入坏了', () => {
  assert.throws(() => generate({ secret: KEY_SHA1, at: -1, step: 30, digits: 8 }), /1970/);
  assert.throws(() => generate({ secret: KEY_SHA1, at: new Date(-1000), step: 30, digits: 8 }), /1970/);
  // 边界：at=0 是合法起点，不该被一并拒掉
  assert.doesNotThrow(() => generate({ secret: KEY_SHA1, at: 0, step: 30, digits: 8 }));
  // secondsRemaining 只是算术，不生成码，负值仍给出窗口内的正确剩余：
  // counter = floor(-1/30) = -1，该窗口覆盖 [-30, 0)，所以 -1 是这一窗口的最后一秒
  assert.strictEqual(secondsRemaining(-1, 30), 1);
  assert.strictEqual(secondsRemaining(-29, 30), 29);
  assert.strictEqual(secondsRemaining(-30, 30), 30);
});

/* ---------------- secondsRemaining ---------------- */

test('secondsRemaining 在窗口边界上的取值范围是 1..step', () => {
  assert.strictEqual(secondsRemaining(59, 30), 1, '窗口最后一秒只剩 1');
  assert.strictEqual(secondsRemaining(60, 30), 30, '刚跨进新窗口就是满窗口');
  assert.strictEqual(secondsRemaining(61, 30), 29);
  assert.strictEqual(secondsRemaining(0, 30), 30);
  assert.strictEqual(secondsRemaining(30, 30), 30);
  assert.strictEqual(secondsRemaining(29, 30), 1);
  for (const at of [0, 1, 15, 29, 30, 45, 59, 60, 1111111111]) {
    const r = secondsRemaining(at, 30);
    assert.ok(r >= 1 && r <= 30, 'at=' + at + ' 剩 ' + r + ' 越界');
    assert.ok(Number.isInteger(r), 'at=' + at + ' 必须是整数秒');
  }
  // Date 入口与秒入口一致；step 非法要抛
  assert.strictEqual(secondsRemaining(new Date(59000), 30), 1);
  assert.throws(() => secondsRemaining(59, 0), /step/);
  assert.throws(() => secondsRemaining(59, -1), /step/);
});

test('secondsRemaining 缺省 step 时用 30', () => {
  assert.strictEqual(secondsRemaining(59), 1);
});

test('模块导出的默认值与白名单可被上层直接引用', () => {
  const totp = require('../src/totp');
  assert.strictEqual(totp.DEFAULT_STEP_SECONDS, 30);
  assert.strictEqual(totp.DEFAULT_DIGITS, 6);
  assert.strictEqual(totp.DEFAULT_ALGORITHM, 'sha1');
  assert.deepStrictEqual(totp.ALLOWED_DIGITS.slice(), [6, 8]);
  assert.deepStrictEqual(totp.ALLOWED_ALGORITHMS.slice(), ['sha1', 'sha256', 'sha512']);
});

test('本模块只用 node: 标准库，不引第三方', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/totp'), 'utf8');
  const requires = src.match(/require\((['"])([^'"]+)\1\)/g) || [];
  for (const r of requires) {
    assert.ok(/require\(['"]node:crypto['"]\)/.test(r), '意外的依赖：' + r);
  }
  assert.ok(!/Math\.random/.test(src), 'TOTP 不需要随机，出现 Math.random 说明写错了地方');
});
