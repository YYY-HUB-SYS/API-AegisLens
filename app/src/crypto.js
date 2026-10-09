const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORE_FILENAMES = ['keys.db', 'store.json'];
const MASTER_KEY_FILE = 'master.key';

/* 界面上「明文密钥还在不在」必须问这一处，不能让前端自己猜：
   拆除了 master.key 之后，数据目录里只剩 vault.key 包着 DEK，两者状态完全不同 */
function hasRawMasterKey(dataDir) {
  return fs.existsSync(path.join(dataDir, MASTER_KEY_FILE));
}

function loadOrCreateMasterKey(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const keyPath = path.join(dataDir, MASTER_KEY_FILE);
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

const VAULT_FILE = 'vault.key';
const KEK_AAD = Buffer.from('aegis:kek:v1', 'utf8');
// 实测 N=2^15/r=8/p=1 约 64ms，双击即用的门槛内；再高一档要到 277ms。
const KDF_DEFAULT = { N: 32768, r: 8, p: 1 };
const MIN_PASSPHRASE = 8;

function deriveKek(passphrase, salt, kdf) {
  // scrypt 在 N≥2^15 时必须显式给 maxmem，否则 Node 直接抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMETER
  return crypto.scryptSync(passphrase, salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 128 * kdf.N * kdf.r * kdf.p * 2,
  });
}

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error('解锁口令至少 ' + MIN_PASSPHRASE + ' 位');
  }
}

function wrapDek(dek, passphrase, kdf) {
  assertPassphrase(passphrase);
  if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error('DEK 必须是 32 字节 Buffer');
  const params = kdf || KDF_DEFAULT;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKek(passphrase, salt, params), iv);
  cipher.setAAD(KEK_AAD);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const body = Buffer.concat([salt, iv, cipher.getAuthTag(), ct]).toString('base64');
  // 参数写进头部，将来调硬 KDF 不用猜历史 blob 是用什么强度封的
  return 'kek:v1:scrypt:' + params.N + '.' + params.r + '.' + params.p + ':' + body;
}

function parseKekBlob(blob) {
  const parts = String(blob == null ? '' : blob).trim().split(':');
  if (parts.length !== 5 || parts[0] !== 'kek' || parts[1] !== 'v1' || parts[2] !== 'scrypt') {
    throw new Error('vault.key 格式不认识');
  }
  const nums = parts[3].split('.').map(Number);
  const kdf = { N: nums[0], r: nums[1], p: nums[2] };
  if (nums.some(function (n) { return !Number.isFinite(n) || n < 1; })
    || (kdf.N & (kdf.N - 1)) !== 0 || kdf.N < 1024 || kdf.N > 2 ** 22 || kdf.r < 1 || kdf.r > 16 || kdf.p < 1 || kdf.p > 16) {
    throw new Error('vault.key 里的 scrypt 参数不合法');
  }
  const buf = Buffer.from(parts[4], 'base64');
  if (buf.length < 16 + 12 + 16 + 32) throw new Error('vault.key 已损坏');
  return {
    kdf: kdf,
    salt: buf.subarray(0, 16),
    iv: buf.subarray(16, 28),
    tag: buf.subarray(28, 44),
    ct: buf.subarray(44),
  };
}

function unwrapDek(blob, passphrase) {
  assertPassphrase(passphrase);
  const parsed = parseKekBlob(blob);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKek(passphrase, parsed.salt, parsed.kdf), parsed.iv);
  decipher.setAAD(KEK_AAD);
  decipher.setAuthTag(parsed.tag);
  try {
    return Buffer.concat([decipher.update(parsed.ct), decipher.final()]);
  } catch (err) {
    // GCM 认证失败抛的是裸 Error 且 code 为 undefined，只能按 message 区分；其余异常原样上抛
    if (/unable to authenticate/i.test(err.message)) throw new Error('解锁口令不正确');
    throw err;
  }
}

function readVaultBlob(dataDir) {
  const p = path.join(dataDir, VAULT_FILE);
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf8').trim();
  return txt || null;
}

function vaultMode(dataDir) {
  return readVaultBlob(dataDir) ? 'envelope' : 'legacy';
}

// 老库的随机 master.key 原地降级成 DEK，字段密文一个都不用重加密
function enablePassphrase(dataDir, passphrase) {
  const blob = wrapDek(loadOrCreateMasterKey(dataDir), passphrase);
  fs.writeFileSync(path.join(dataDir, VAULT_FILE), blob + '\n', { mode: 0o600 });
  return blob;
}

function changePassphrase(dataDir, oldPassphrase, newPassphrase) {
  const dek = unwrapDek(readVaultBlob(dataDir), oldPassphrase);
  try {
    return enablePassphraseWith(dataDir, dek, newPassphrase);
  } finally {
    zeroSecret(dek);
  }
}

function enablePassphraseWith(dataDir, dek, passphrase) {
  const blob = wrapDek(dek, passphrase);
  fs.writeFileSync(path.join(dataDir, VAULT_FILE), blob + '\n', { mode: 0o600 });
  return blob;
}

function unlockDek(dataDir, passphrase) {
  const blob = readVaultBlob(dataDir);
  if (!blob) return { dek: loadOrCreateMasterKey(dataDir), mode: 'legacy' };
  assertPassphrase(passphrase);
  return { dek: unwrapDek(blob, passphrase), mode: 'envelope' };
}

/* 拆掉明文 DEK 是这条链上唯一真正不可逆的动作：只有口令能解封之后还留着 master.key
   就等于信封白做。因此必须先用口令解一次验证过，才允许删。调用方需带 confirm: true。 */
function discardRawDek(dataDir, passphrase, options) {
  if (!options || options.confirm !== true) throw new Error('删除 master.key 需显式确认');
  const blob = readVaultBlob(dataDir);
  if (!blob) throw new Error('还没设置解锁口令，删了 master.key 整库就永久解不开');
  const dek = unwrapDek(blob, passphrase);
  zeroSecret(dek);
  const p = path.join(dataDir, MASTER_KEY_FILE);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { discarded: true };
}

function zeroSecret(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

module.exports = {
  loadOrCreateMasterKey,
  encryptField,
  decryptField,
  wrapDek,
  unwrapDek,
  parseKekBlob,
  readVaultBlob,
  vaultMode,
  enablePassphrase,
  enablePassphraseWith,
  changePassphrase,
  unlockDek,
  discardRawDek,
  zeroSecret,
  deriveKek,
  hasRawMasterKey,
  VAULT_FILE,
  MASTER_KEY_FILE,
  KDF_DEFAULT,
  MIN_PASSPHRASE,
};
