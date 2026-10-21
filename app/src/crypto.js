const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const keystore = require('./keystore');

const STORE_FILENAMES = ['keys.db', 'store.json'];
const MASTER_KEY_FILE = 'master.key';
/* master.key 的两种形态靠这个前缀区分：
   - 没有前缀 = 老库的明文 hex（**不改它**，见 loadOrCreateMasterKey 的说明）
   - `os:v1:` 开头 = 主密钥在系统凭据管理器里，这个文件只存一个占位标记
   盘上永远不出现主密钥本身：要么在凭据管理器里，要么是用户自己那份老明文文件。 */
const KEYRING_MARKER = 'os:v1:';

/* 界面上「明文密钥还在不在」必须问这一处，不能让前端自己猜：
   拆除了 master.key 之后，数据目录里只剩 vault.key 包着 DEK，两者状态完全不同 */
function hasRawMasterKey(dataDir) {
  return fs.existsSync(path.join(dataDir, MASTER_KEY_FILE));
}

/* 这个数据目录的主密钥现在放在哪：'os'（系统凭据管理器）/ 'file'（盘上明文文件）。 */
function masterKeySource(dataDir) {
  const p = path.join(dataDir, MASTER_KEY_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8').trim().startsWith(KEYRING_MARKER) ? 'os' : 'file';
  } catch (e) {
    return null;
  }
}

/* 主密钥的读取分两条路：
   ① 老库（盘上是明文 hex）——原样读，**一个字节都不改**。
      理由：改老库的密钥存储是「静默换掉用户的信任根」，
      一旦凭据管理器那边写失败或换机器读不到，整库就永久解不开。
      老库要不要搬，用户自己决定（界面上给一条明确入口），不由代码替他决定。
   ② 新库（盘上是 os:v1: 占位标记）——主密钥在系统凭据管理器里。
      读不到就是「这条数据目录的主密钥不在这台机器的凭据管理器里」，
      报错要说清怎么办，不能笼统说「密钥损坏」。 */
function loadOrCreateMasterKey(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const keyPath = path.join(dataDir, MASTER_KEY_FILE);
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    if (raw.startsWith(KEYRING_MARKER)) {
      const sec = keystore.getSecret(dataDir);
      if (!sec) {
        throw new Error('这个数据目录的主密钥在系统凭据管理器里，但**这台机器上读不到它**。'
          + '可能是换了电脑、凭据被清理，或用的是另一个用户账号。'
          + '请用原机器打开，或从备份恢复对应的凭据条目（条目名：' + keystore.SERVICE + ':' + path.resolve(dataDir) + '）。');
      }
      return sec;
    }
    const buf = Buffer.from(raw, 'hex');
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
  /* 新库的默认落点：系统凭据管理器。装了就用（盘上不落主密钥）；
     没装 / 装了但不可用（无头 Linux、容器内、权限不够）就退回盘上文件——
     宁可保持原来的强度，也不能因为「搬不进去」就让服务起不来。 */
  if (keystore.isAvailable(dataDir) && keystore.setSecret(dataDir, key)) {
    fs.writeFileSync(keyPath, KEYRING_MARKER + '主密钥在系统凭据管理器里，本文件不含密钥\n', { mode: 0o600 });
    return key;
  }
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  return key;
}

/* 把老库（盘上明文）搬到系统凭据管理器：
   ① 先把主密钥写进凭据管理器；② 再把盘上文件换成占位标记。
   顺序不能反：反过来先删文件、后写凭据，中间崩了就两头都没有，整库永久解不开。 */
function migrateMasterKeyToKeyring(dataDir) {
  if (masterKeySource(dataDir) !== 'file') {
    return { migrated: false, reason: '这个数据目录的主密钥已经不在盘上明文里了' };
  }
  const keyPath = path.join(dataDir, MASTER_KEY_FILE);
  const raw = fs.readFileSync(keyPath, 'utf8').trim();
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) return { migrated: false, reason: 'master.key 已损坏（长度不为 32 字节）' };
  if (!keystore.isAvailable(dataDir)) {
    return { migrated: false, reason: '这台机器上用不了系统凭据管理器' };
  }
  if (!keystore.setSecret(dataDir, key)) {
    return { migrated: false, reason: '写不进系统凭据管理器' };
  }
  /* 写进去了才动盘上文件 */
  fs.writeFileSync(keyPath, KEYRING_MARKER + '主密钥在系统凭据管理器里，本文件不含密钥\n', { mode: 0o600 });
  zeroSecret(key);
  return { migrated: true, reason: '主密钥已移入系统凭据管理器' };
}

/* 搬回盘上文件（用户想撤掉这层保护，或换了台机器读不到凭据）： */
function migrateMasterKeyToFile(dataDir) {
  if (masterKeySource(dataDir) !== 'os') {
    return { migrated: false, reason: '这个数据目录的主密钥本来就在盘上文件里' };
  }
  const keyPath = path.join(dataDir, MASTER_KEY_FILE);
  const sec = keystore.getSecret(dataDir);
  if (!sec) return { migrated: false, reason: '这台机器上读不到凭据管理器里的主密钥' };
  fs.writeFileSync(keyPath, sec.toString('hex'), { mode: 0o600 });
  keystore.deleteSecret(dataDir);
  zeroSecret(sec);
  return { migrated: true, reason: '主密钥已移回数据目录的 master.key 文件' };
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
const MAX_PASSPHRASE = 1024;

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
  if (passphrase.length > MAX_PASSPHRASE) {
    throw new Error('解锁口令最长 ' + MAX_PASSPHRASE + ' 位，当前 ' + passphrase.length);
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
  /* 先判形态再删文件：masterKeySource 读的是文件，文件一删就问不出来了 */
  const source = masterKeySource(dataDir);
  const p = path.join(dataDir, MASTER_KEY_FILE);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  /* 主密钥在系统凭据管理器里时，删盘上那个占位文件等于什么都没做——
     真正的「明文副本」是凭据管理器里的那条，得一并删掉，
     否则界面上说「已拆除明文副本」而实际还留着，用户就被骗了。 */
  let credentialRemoved = false;
  if (source === 'os') {
    credentialRemoved = keystore.deleteSecret(dataDir);
  }
  return { discarded: true, credentialRemoved: credentialRemoved };
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
  masterKeySource,
  migrateMasterKeyToKeyring,
  migrateMasterKeyToFile,
  keystore,
  VAULT_FILE,
  MASTER_KEY_FILE,
  KEYRING_MARKER,
  KDF_DEFAULT,
  MIN_PASSPHRASE,
  MAX_PASSPHRASE,
};
