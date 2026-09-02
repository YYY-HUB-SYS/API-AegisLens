const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateMasterKey, encryptField, decryptField } = require('../src/crypto');

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
