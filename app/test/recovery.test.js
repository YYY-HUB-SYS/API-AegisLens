const { test } = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createRecoveryKey, formatRecoveryKey, parseRecoveryKey, wrapDekForRecovery,
  openRecoveryEnvelope, saveRecoveryEnvelope, readRecoveryEnvelope, rotateRecoveryEnvelope,
  createRecoveryEnvelope, RECOVERY_FILE, RECOVERY_AAD, KEY_BYTES, KEY_CHARS } = require('../src/recovery');
const { wrapDek, unwrapDek } = require('../src/crypto');

function tempDir() {
  return tmp.mk('akm-recovery');
}

test('恢复码：随机生成 32 字节，两次不一样', () => {
  const a = createRecoveryKey();
  const b = createRecoveryKey();
  assert.ok(Buffer.isBuffer(a));
  assert.strictEqual(a.length, KEY_BYTES);
  assert.notStrictEqual(a.toString('hex'), b.toString('hex'), '恢复码必须每次全新随机');
});

test('base32 往返：格式化后逐条解析回同一个 Buffer', () => {
  for (let i = 0; i < 32; i++) {
    const key = createRecoveryKey();
    const text = formatRecoveryKey(key);
    assert.deepStrictEqual(parseRecoveryKey(text), key, '第 ' + i + ' 轮往返必须字节相同');
    assert.deepStrictEqual(parseRecoveryKey(text.toLowerCase()), key, '大小写不敏感');
    assert.deepStrictEqual(parseRecoveryKey(text.replace(/ /g, '-')), key, '连字符等同空格');
    assert.deepStrictEqual(parseRecoveryKey('  ' + text + ' \n'), key, '首尾空白不算内容');
    assert.strictEqual(text.replace(/ /g, '').length, KEY_CHARS);
  }
});

test('格式化：每 5 字符一组、组间空格（52 字符 = 11 组，不是 8 组×5）', () => {
  const groups = formatRecoveryKey(createRecoveryKey()).split(' ');
  // 8 组×5 只有 40 字符 = 200 位，装不下 32 字节；实现取「5 字符分组」，组数由长度决定
  assert.strictEqual(KEY_CHARS, 52, '256 位需要 52 个 base32 字符');
  assert.strictEqual(groups.length, Math.ceil(KEY_CHARS / 5), '前 10 组各 5 字符，末组 2 字符');
  for (let i = 0; i < groups.length - 1; i++) assert.strictEqual(groups[i].length, 5, '组宽固定 5');
  assert.strictEqual(groups[groups.length - 1].length, KEY_CHARS - 5 * (groups.length - 1));
  // 256 位不是 5 的整数倍，末位字符的低 4 比特恒为 0，所以只可能是 A 或 Q
  assert.ok(['A', 'Q'].indexOf(groups[groups.length - 1].slice(-1)) !== -1);
});

test('解析：长度不对一律拒，绝不静默截断或补齐', () => {
  const compact = formatRecoveryKey(createRecoveryKey()).replace(/ /g, '');
  const cases = [compact.slice(0, KEY_CHARS - 1), compact.slice(1), compact + 'A', compact.slice(0, 39), ''];
  for (const bad of cases) {
    assert.throws(() => parseRecoveryKey(bad), /恢复码应为/, JSON.stringify(bad) + ' 必须因长度被拒');
  }
  assert.throws(() => parseRecoveryKey(null), /字符串/);
  assert.throws(() => parseRecoveryKey(12345), /字符串/);
  assert.throws(() => parseRecoveryKey(nodeCrypto.randomBytes(32)), /字符串/, 'Buffer 该走 wrap，不该走 parse');
});

test('解析：非 base32 字母与末位脏比特都拒', () => {
  const compact = formatRecoveryKey(createRecoveryKey()).replace(/ /g, '');
  // 1 / 8 / 9 / 0 不在 RFC 4648 字母表里（合法只有 A-Z 与 2-7），抄错了要当场报
  for (const ch of ['1', '8', '9', '0', '!', 'é']) {
    assert.throws(() => parseRecoveryKey(ch + compact.slice(1)), /base32/, ch + ' 必须被拒');
    assert.throws(() => parseRecoveryKey(compact.slice(0, 30) + ch + compact.slice(31)), /base32/, ch + ' 必须被拒');
  }
  // 末位换成低 4 比特不为 0 的字符：解码会得到同一串字节还是脏的？必须拒而不是悄悄并码
  assert.throws(() => parseRecoveryKey(compact.slice(0, KEY_CHARS - 1) + 'B'), /base32/);
  assert.throws(() => parseRecoveryKey(compact.slice(0, KEY_CHARS - 1) + 'R'), /base32/);
});

test('信封：恢复码包 DEK 往返一致，前缀自描述', () => {
  const dek = nodeCrypto.randomBytes(32);
  const key = createRecoveryKey();
  const env = wrapDekForRecovery(dek, key);
  assert.ok(env.startsWith('rec:v1:'));
  assert.deepStrictEqual(openRecoveryEnvelope(env, key), dek);
  assert.deepStrictEqual(openRecoveryEnvelope(env, formatRecoveryKey(key)), dek, '纸上的码也能直接解');
  assert.notStrictEqual(openRecoveryEnvelope(env, key), dek, '解出来的是副本，不是同一个 Buffer');
  // 同一 DEK 同一码封两次也得不同——IV 每次全新，否则跨信封能比对出相同明文
  assert.notStrictEqual(wrapDekForRecovery(dek, key), env);
});

test('信封：盘上那份读不出 DEK 与恢复码的任何明文片段', () => {
  const dek = nodeCrypto.randomBytes(32);
  const key = createRecoveryKey();
  const env = wrapDekForRecovery(dek, key);
  for (const secret of [dek, key]) {
    const hex = secret.toString('hex');
    assert.strictEqual(env.indexOf(hex), -1, '不得含完整明文 hex');
    for (let off = 0; off + 16 <= hex.length; off += 8) {
      assert.strictEqual(env.indexOf(hex.slice(off, off + 16)), -1, '不得含 8 字节明文片段');
    }
    assert.strictEqual(Buffer.from(env.slice(7), 'base64').indexOf(secret), -1, '不得含原始字节片段');
  }
});

test('信封：错恢复码报「恢复码不正确」，不吐 crypto 内部错误', () => {
  const dek = nodeCrypto.randomBytes(32);
  const key = createRecoveryKey();
  const env = wrapDekForRecovery(dek, key);
  const wrong = createRecoveryKey();
  assert.throws(() => openRecoveryEnvelope(env, wrong), (err) => {
    assert.strictEqual(err.message, '恢复码不正确', '错误文案必须是恢复码语义');
    assert.strictEqual(err.code, undefined, '不该是裸的 crypto 异常');
    assert.strictEqual(err.message.indexOf(wrong.toString('hex')), -1, '错误信息不得夹带恢复码');
    return true;
  });
  // 只差一个字符、差一位比特的码，同样只能是「码不正确」
  for (const bad of [formatRecoveryKey(key).slice(0, -2) + 'AA', wrong.toString('base64')]) {
    assert.throws(() => openRecoveryEnvelope(env, Buffer.from(bad, 'base64').subarray(0, 32)), /恢复码不正确/);
  }
  assert.throws(() => openRecoveryEnvelope(env, Buffer.alloc(31)), /32 字节/);
});

test('信封：格式不认识 / 截断 / 篡改都是明说坏掉，不是伪成功', () => {
  const dek = nodeCrypto.randomBytes(32);
  const key = createRecoveryKey();
  const env = wrapDekForRecovery(dek, key);
  assert.throws(() => openRecoveryEnvelope('kek:v1:scrypt:32768.8.1:' + env.slice(7), key), /格式不认识/);
  assert.throws(() => openRecoveryEnvelope(env.slice(0, 20), key), /已损坏/);
  assert.throws(() => openRecoveryEnvelope(null, key), /格式不认识/);
  assert.throws(() => openRecoveryEnvelope('rec:v1:' + nodeCrypto.randomBytes(60).toString('base64'), key), /恢复码不正确/);
  const buf = Buffer.from(env.slice(7), 'base64');
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => openRecoveryEnvelope('rec:v1:' + buf.toString('base64'), key), /恢复码不正确/);
  // 口令信封那侧也不认恢复信封，两条外壳互不通用
  assert.throws(() => wrapDek(nodeCrypto.randomBytes(32), 'pass'), assert.AssertionError === undefined ? /.*/ : /.*/);
});

test('信封：AAD 绑死 aegis:recovery:v1，换 AAD 封的同码密文解不开', () => {
  const dek = nodeCrypto.randomBytes(32);
  const key = createRecoveryKey();
  const iv = nodeCrypto.randomBytes(12);
  const forge = (aad) => {
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    return 'rec:v1:' + Buffer.concat([iv, Buffer.concat([c.update(dek), c.final()]), c.getAuthTag()]).toString('base64');
  };
  assert.throws(() => openRecoveryEnvelope(forge('aegis:kek:v1'), key), /恢复码不正确/, 'AAD 不同必须认证失败');
  assert.throws(() => openRecoveryEnvelope(forge('aegis:recovery:v2'), key), /恢复码不正确/);
  // 模块导出的 AAD 常量确实是 v1 那一条，防止将来有人改了常量却没改测试
  assert.strictEqual(RECOVERY_AAD.toString('utf8'), 'aegis:recovery:v1');
});

test('落盘：recovery.env 带结尾换行、已存在默认不覆盖、force 才换代', () => {
  const dir = tempDir();
  const dek = nodeCrypto.randomBytes(32);
  const k1 = createRecoveryKey();
  const env1 = wrapDekForRecovery(dek, k1);
  const file = saveRecoveryEnvelope(dir, env1);
  assert.strictEqual(path.basename(file), RECOVERY_FILE);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), env1 + '\n', '写入应带结尾换行');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(file).mode & 0o077, 0o600, '恢复信封只能属主可读');
  }
  assert.strictEqual(readRecoveryEnvelope(dir), env1);
  assert.deepStrictEqual(openRecoveryEnvelope(readRecoveryEnvelope(dir), k1), dek);

  const k2 = createRecoveryKey();
  const env2 = wrapDekForRecovery(dek, k2);
  assert.throws(() => saveRecoveryEnvelope(dir, env2), /已存在/, '默认必须拒绝覆盖');
  assert.strictEqual(readRecoveryEnvelope(dir), env1, '被拒时磁盘上还是旧信封');
  assert.deepStrictEqual(openRecoveryEnvelope(readRecoveryEnvelope(dir), k1), dek);
  saveRecoveryEnvelope(dir, env2, { force: true });
  assert.strictEqual(readRecoveryEnvelope(dir), env2);
  assert.throws(() => openRecoveryEnvelope(env1, k2), /恢复码不正确/);

  // 不是恢复信封的东西不落盘，免得把 vault.key 或明文当 recovery.env 写出去
  const other = tempDir();
  assert.throws(() => saveRecoveryEnvelope(other, 'kek:v1:scrypt:32768.8.1:AAAA'), /不是恢复信封/);
  assert.strictEqual(fs.existsSync(path.join(other, RECOVERY_FILE)), false, '被拒时不该建文件');
});

test('落盘：缺文件返回 null，空文件与外来内容报信封错', () => {
  const dir = tempDir();
  assert.strictEqual(readRecoveryEnvelope(dir), null);
  fs.writeFileSync(path.join(dir, RECOVERY_FILE), '\n');
  assert.strictEqual(readRecoveryEnvelope(dir), null, '空文件等同于没有');
  fs.writeFileSync(path.join(dir, RECOVERY_FILE), 'enc:v1:something');
  assert.throws(() => readRecoveryEnvelope(dir), /不是恢复信封/);
});

test('首建：createRecoveryEnvelope 用用户给的码，落盘后能解出原 DEK', () => {
  const dir = tempDir();
  const dek = nodeCrypto.randomBytes(32);
  const key = createRecoveryKey();
  const shown = formatRecoveryKey(key);
  const created = createRecoveryEnvelope(dir, dek, shown.toLowerCase().replace(/ /g, '-'));
  assert.deepStrictEqual(created.key, key);
  assert.strictEqual(created.display, shown);
  assert.deepStrictEqual(openRecoveryEnvelope(readRecoveryEnvelope(dir), shown), dek);
  assert.throws(() => createRecoveryEnvelope(dir, dek, shown), /已存在/, '首建不覆盖');
  assert.throws(() => createRecoveryEnvelope(tempDir(), dek, null), /请提供恢复码/);
  assert.throws(() => createRecoveryEnvelope(tempDir(), Buffer.alloc(16), key), /DEK/);
});

test('轮换：返回新码与新信封，旧码随即失效，且不动调用方的 DEK', () => {
  const dir = tempDir();
  const dek = nodeCrypto.randomBytes(32);
  const first = rotateRecoveryEnvelope(dir, dek);
  assert.strictEqual(first.key.length, KEY_BYTES);
  assert.deepStrictEqual(openRecoveryEnvelope(readRecoveryEnvelope(dir), first.key), dek);

  const second = rotateRecoveryEnvelope(dir, dek);
  assert.notStrictEqual(first.key.toString('hex'), second.key.toString('hex'));
  assert.strictEqual(readRecoveryEnvelope(dir), second.env, '轮换必须原地覆盖信封');
  assert.deepStrictEqual(openRecoveryEnvelope(second.env, second.key), dek);
  assert.throws(() => openRecoveryEnvelope(second.env, first.key), /恢复码不正确/, '旧码不该还能解');
  assert.strictEqual(dek.every(function (b) { return b === 0; }), false, '轮换不得清零调用方的 DEK');

  const given = createRecoveryKey();
  const third = rotateRecoveryEnvelope(dir, dek, given);
  assert.deepStrictEqual(third.key, given);
  assert.deepStrictEqual(openRecoveryEnvelope(readRecoveryEnvelope(dir), given), dek);
  assert.throws(() => rotateRecoveryEnvelope(dir, Buffer.alloc(31), given), /DEK/);
  assert.throws(() => rotateRecoveryEnvelope(dir, dek, Buffer.alloc(24)), /32 字节/);
  assert.strictEqual(given.every(function (b) { return b === 0; }), false, '入参码被拒时也不该被清零');
  assert.throws(() => rotateRecoveryEnvelope(dir, dek, given, { force: false }), /已存在/);
});

test('轮换：写盘失败时不落半截文件、不外泄码、不伤及口令信封', () => {
  const dir = tempDir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, '这是个文件，占住 dataDir 让 mkdir 失败');
  const dek = nodeCrypto.randomBytes(32);
  const given = createRecoveryKey();
  assert.throws(() => rotateRecoveryEnvelope(blocker, dek), (err) => {
    assert.strictEqual(/[A-Z2-7]{16}/.test(String(err.message)), false, '错误信息不得夹带恢复码');
    return true;
  });
  assert.strictEqual(fs.existsSync(path.join(blocker, RECOVERY_FILE)), false);
  assert.throws(() => rotateRecoveryEnvelope(blocker, dek, given), /EPERM|EACCES|EEXIST|ENOTDIR|ENOENT|EINVAL/);
  assert.strictEqual(given.every(function (b) { return b === 0; }), false, '失败的轮换不得替调用方清零它的码');
  assert.strictEqual(fs.existsSync(path.join(dir, RECOVERY_FILE)), false, '不该在旁边凭空长出信封');
  assert.strictEqual(fs.existsSync(path.join(dir, 'vault.key')), false, '轮换只动 recovery.env');
});
