const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateMasterKey, encryptField, decryptField, wrapDek, unwrapDek, parseKekBlob,
  readVaultBlob, vaultMode, enablePassphrase, changePassphrase, unlockDek, discardRawDek,
  zeroSecret, VAULT_FILE, MIN_PASSPHRASE } = require('../src/crypto');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'akm-crypto-'));
}

test('主密钥：首次生成 32 字节并落盘，二次读取复用', () => {
  const dir = tempDir();
  const k1 = loadOrCreateMasterKey(dir);
  assert.strictEqual(k1.length, 32);
  assert.ok(fs.existsSync(path.join(dir, 'master.key')));
  const k2 = loadOrCreateMasterKey(dir);
  assert.deepStrictEqual(k1, k2);
});

test('主密钥：损坏文件报错', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'master.key'), 'abcd');
  assert.throws(() => loadOrCreateMasterKey(dir), /损坏/);
});

test('主密钥：已有密钥库但缺 master.key 时拒绝启动，且不生成新密钥', () => {
  for (const store of ['keys.db', 'store.json']) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, store), 'placeholder-ciphertext');
    assert.throws(() => loadOrCreateMasterKey(dir), /缺少 master.key/, store + ' 应触发保护');
    assert.strictEqual(fs.existsSync(path.join(dir, 'master.key')), false,
      store + ' 场景下绝不能新生成主密钥（否则旧库永久解不开）');
  }
});

test('主密钥：空目录正常生成（未被上面的保护误伤）', () => {
  const dir = tempDir();
  const mk = loadOrCreateMasterKey(dir);
  assert.strictEqual(mk.length, 32);
});

test('字段加密：往返一致', () => {
  const dir = tempDir();
  const mk = loadOrCreateMasterKey(dir);
  const plain = 'sk-8f2ac41d5b9e7c03a6d4f2a';
  const enc = encryptField(mk, plain);
  assert.ok(enc.startsWith('enc:v1:'));
  assert.notStrictEqual(enc, plain);
  assert.strictEqual(decryptField(mk, enc), plain);
});

test('字段加密：空值直通', () => {
  const mk = Buffer.alloc(32, 7);
  assert.strictEqual(encryptField(mk, ''), '');
  assert.strictEqual(encryptField(mk, null), null);
  assert.strictEqual(decryptField(mk, ''), '');
  assert.strictEqual(decryptField(mk, null), null);
});

test('字段加密：密文被篡改时解密失败（GCM 完整性校验）', () => {
  const dir = tempDir();
  const mk = loadOrCreateMasterKey(dir);
  const enc = encryptField(mk, 'secret-value-123');
  const buf = Buffer.from(enc.slice(7), 'base64');
  buf[buf.length - 1] ^= 0xff;
  const tampered = 'enc:v1:' + buf.toString('base64');
  assert.throws(() => decryptField(mk, tampered));
});

test('字段加密：错误密钥无法解密', () => {
  const dir = tempDir();
  const mk = loadOrCreateMasterKey(dir);
  const other = Buffer.alloc(32, 9);
  const enc = encryptField(mk, 'secret');
  assert.throws(() => decryptField(other, enc));
});

test('字段加密：中文内容往返', () => {
  const mk = Buffer.alloc(32, 3);
  const enc = encryptField(mk, '密钥内容测试-中文');
  assert.strictEqual(decryptField(mk, enc), '密钥内容测试-中文');
});

test('信封：口令包 DEK 往返一致，blob 里不含 DEK 明文', () => {
  const dek = require('node:crypto').randomBytes(32);
  const blob = wrapDek(dek, 'correct-pass-1');
  assert.ok(blob.startsWith('kek:v1:scrypt:'));
  assert.deepStrictEqual(unwrapDek(blob, 'correct-pass-1'), dek);
  assert.ok(blob.indexOf(dek.toString('hex')) === -1, 'blob 不得泄漏 DEK 明文');
  assert.strictEqual(blob.split(':')[3], '32768.8.1', 'KDF 参数要自描述，将来调硬不用猜');
});

test('信封：错口令一律拒绝并给出口令语义的错误', () => {
  const dek = require('node:crypto').randomBytes(32);
  const blob = wrapDek(dek, 'correct-pass-1');
  // 差一个字符、大小写不同、空串都必须是「口令不正确」而不是崩在 crypto 内部
  for (const bad of ['correct-pass-2', 'correct-Pass-1', 'correct-pass-1 ', '', 'a'.repeat(MIN_PASSPHRASE)]) {
    const expect = bad.length < MIN_PASSPHRASE ? /至少/ : /解锁口令不正确/;
    assert.throws(() => unwrapDek(blob, bad), expect, JSON.stringify(bad));
  }
});

test('信封：blob 被篡改或截断时报格式/损坏错误，不是伪成功', () => {
  const dek = require('node:crypto').randomBytes(32);
  const blob = wrapDek(dek, 'correct-pass-1');
  const parts = blob.split(':');
  assert.throws(() => unwrapDek('kek:v2:scrypt:32768.8.1:' + parts[4], 'correct-pass-1'), /格式不认识/);
  assert.throws(() => unwrapDek('kek:v1:argon2id:32768.8.1:' + parts[4], 'correct-pass-1'), /格式不认识/);
  assert.throws(() => unwrapDek('kek:v1:scrypt:1023.8.1:' + parts[4], 'correct-pass-1'), /参数不合法/);
  assert.throws(() => unwrapDek('kek:v1:scrypt:32768.8.1:' + parts[4].slice(0, 20), 'correct-pass-1'), /已损坏/);
  assert.throws(() => unwrapDek(null, 'correct-pass-1'), /格式不认识/);
  // 密文段被改一位：认证标签必须挡住
  const buf = Buffer.from(parts[4], 'base64');
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => unwrapDek('kek:v1:scrypt:' + parts[3] + ':' + buf.toString('base64'), 'correct-pass-1'), /解锁口令不正确|已损坏/);
});

test('信封：自定义 KDF 档位封出来的 blob 靠头部参数就能解', () => {
  const dek = require('node:crypto').randomBytes(32);
  const blob = wrapDek(dek, 'correct-pass-1', { N: 16384, r: 8, p: 1 });
  assert.strictEqual(blob.split(':')[3], '16384.8.1');
  assert.strictEqual(parseKekBlob(blob).kdf.N, 16384);
  assert.deepStrictEqual(unwrapDek(blob, 'correct-pass-1'), dek);
});

test('vault 模式：无 vault.key 是 legacy，写入后转 envelope', () => {
  const dir = tempDir();
  assert.strictEqual(vaultMode(dir), 'legacy');
  assert.strictEqual(readVaultBlob(dir), null);
  const u1 = unlockDek(dir);
  assert.strictEqual(u1.mode, 'legacy');
  assert.deepStrictEqual(u1.dek, loadOrCreateMasterKey(dir));

  enablePassphrase(dir, 'correct-pass-1');
  assert.ok(fs.existsSync(path.join(dir, VAULT_FILE)));
  assert.strictEqual(vaultMode(dir), 'envelope');
  assert.strictEqual(fs.readFileSync(path.join(dir, VAULT_FILE), 'utf8').split('\n').length, 2, '写入应带结尾换行');
  const u2 = unlockDek(dir, 'correct-pass-1');
  assert.strictEqual(u2.mode, 'envelope');
  assert.deepStrictEqual(u2.dek, u1.dek, '口令只是外壳，DEK 必须原封不动');
  assert.throws(() => unlockDek(dir, 'wrong-pass-9'), /解锁口令不正确/);
  assert.throws(() => unlockDek(dir), /至少/);
});

test('老库零迁移：设口令前后，同一字段密文都能解出原值', () => {
  const dir = tempDir();
  const mk = loadOrCreateMasterKey(dir);
  const enc = encryptField(mk, 'sk-legacy-value');
  enablePassphrase(dir, 'correct-pass-1');
  const { dek } = unlockDek(dir, 'correct-pass-1');
  assert.strictEqual(decryptField(dek, enc), 'sk-legacy-value', '设口令不该重加密任何历史字段');
});

test('改口令：旧口令必须验对，成功后旧口令失效、DEK 不变', () => {
  const dir = tempDir();
  const before = loadOrCreateMasterKey(dir);
  enablePassphrase(dir, 'correct-pass-1');
  assert.throws(() => changePassphrase(dir, 'wrong-pass-9', 'brand-new-pass'), /解锁口令不正确/);
  changePassphrase(dir, 'correct-pass-1', 'brand-new-pass');
  assert.throws(() => unlockDek(dir, 'correct-pass-1'), /解锁口令不正确/);
  const after = unlockDek(dir, 'brand-new-pass');
  assert.deepStrictEqual(after.dek, before, '改口令只重包外壳，DEK 与字段密文都不该变');
});

test('discardRawDek：三重前置——显式确认、已设口令、口令能解；缺一不可删', () => {
  const dir = tempDir();
  loadOrCreateMasterKey(dir);
  assert.throws(() => discardRawDek(dir, 'correct-pass-1', {}), /显式确认/);
  assert.ok(fs.existsSync(path.join(dir, 'master.key')), '被拒时不得删任何东西');
  assert.throws(() => discardRawDek(dir, 'correct-pass-1', { confirm: true }), /还没设置解锁口令/);
  assert.ok(fs.existsSync(path.join(dir, 'master.key')));

  enablePassphrase(dir, 'correct-pass-1');
  assert.throws(() => discardRawDek(dir, 'wrong-pass-9', { confirm: true }), /解锁口令不正确/);
  assert.ok(fs.existsSync(path.join(dir, 'master.key')), '口令错也不能删');

  discardRawDek(dir, 'correct-pass-1', { confirm: true });
  assert.strictEqual(fs.existsSync(path.join(dir, 'master.key')), false);
  assert.deepStrictEqual(unlockDek(dir, 'correct-pass-1').dek.length, 32, '删完仍可解锁');
  // 口令成为唯一入口：删掉 vault.key 后，「有密钥库却无 master.key」的保护必须挡住，不能静默生成新密钥
  fs.writeFileSync(path.join(dir, 'keys.db'), 'placeholder-ciphertext');
  fs.rmSync(path.join(dir, VAULT_FILE));
  assert.throws(() => loadOrCreateMasterKey(dir), /缺少 master.key/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'master.key')), false);
});

test('zeroSecret：置零，非 Buffer 输入不炸', () => {
  const buf = Buffer.from('deadbeef', 'hex');
  zeroSecret(buf);
  assert.strictEqual(buf.toString('hex'), '00000000');
  assert.strictEqual(zeroSecret(null), undefined);
  assert.strictEqual(zeroSecret('not-a-buffer'), undefined);
});
