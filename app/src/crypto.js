const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORE_FILENAMES = ['keys.db', 'store.json'];

function loadOrCreateMasterKey(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const keyPath = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyPath)) {
    const buf = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    if (buf.length === 32) return buf;
    throw new Error('master.key 已损坏（长度不为 32 字节）');
  }
  // 库里已有密文却没有主密钥：此时生成新密钥会让整库永久解不开，且服务照常启动、错误推迟到读取时才爆
  const stores = STORE_FILENAMES.filter(function (f) { return fs.existsSync(path.join(dataDir, f)); });
  if (stores.length) {
    throw new Error('数据目录已有密钥库（' + stores.join('、') + '）但缺少 master.key。'
      + '请从备份恢复 master.key；确认要放弃旧数据则把密钥库一并删除后再启动。');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  return key;
}

function encryptField(masterKey, plaintext) {
  if (plaintext == null || plaintext === '') return plaintext == null ? null : '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptField(masterKey, stored) {
  if (stored == null || stored === '') return stored == null ? null : '';
  if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) return stored;
  const buf = Buffer.from(stored.slice(7), 'base64');
  if (buf.length < 29) throw new Error('密文字段损坏');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { loadOrCreateMasterKey, encryptField, decryptField };
