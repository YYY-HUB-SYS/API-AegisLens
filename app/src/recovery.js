/* 恢复信封：把 DEK 额外用一把「恢复码」包一份存盘，专治忘记解锁口令。
   它和被废弃的明文 master.key 的区别只有一处：恢复码本身永不落盘。
   捡到整个目录的人拿到的仍是一层密文，解不开它必须有那张抄在离线处的纸。 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { zeroSecret } = require('./crypto');

const RECOVERY_FILE = 'recovery.env';
const RECOVERY_PREFIX = 'rec:v1:';
// 与口令信封的 AAD 分开：两类外壳不该能互相当成同一份 DEK 的封条来解
const RECOVERY_AAD = Buffer.from('aegis:recovery:v1', 'utf8');
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const GROUP_LEN = 5;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/* 52 而不是「8 组 × 5 = 40」：256 位需要 52 个 base32 字符才装得下，40 字符只有 200 位。
   按 8 组显示就必须截掉 12 个字符，而截掉的正是密钥本体——宁可多两组也不能少熵。 */
const KEY_CHARS = Math.ceil((KEY_BYTES * 8) / 5);

/* 全熵随机码抄错一位，落到的仍是「恢复码不正确」，GCM 标签已经把它挡死。
   再加一份校验位只能改报错文案，补不回安全边际，所以这里刻意不做。 */

function base32Encode(buf) {
  let acc = 0;
  let bits = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    acc = (acc << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(acc >>> bits) & 31];
    }
  }
  // 余下不满 5 位的比特靠左补齐成一个字符，与 RFC 4648 的去 padding 写法一致
  if (bits > 0) out += BASE32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let acc = 0;
  let bits = 0;
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(text.charAt(i));
    if (idx === -1) return null;
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
  }
  // 最后一个字符里多出来的比特必须为 0，否则这串根本不是任何 Buffer 的编码
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return Buffer.from(bytes);
}

function assertRecoveryKey(recoveryKey) {
  if (!Buffer.isBuffer(recoveryKey) || recoveryKey.length !== KEY_BYTES) {
    throw new Error('恢复码必须是 ' + KEY_BYTES + ' 字节 Buffer');
  }
  return recoveryKey;
}

function createRecoveryKey() {
  return crypto.randomBytes(KEY_BYTES);
}

function formatRecoveryKey(buf) {
  const text = base32Encode(assertRecoveryKey(buf));
  const groups = [];
  for (let i = 0; i < text.length; i += GROUP_LEN) groups.push(text.slice(i, i + GROUP_LEN));
  return groups.join(' ');
}

function parseRecoveryKey(str) {
  if (typeof str !== 'string') throw new Error('恢复码必须是字符串');
  // 抄错的码要当场说清楚：长度差多少、第几位有脏字符合成一条信息才有诊断价值
  const compact = str.toUpperCase().replace(/[\s-]/g, '');
  if (compact.length !== KEY_CHARS) {
    throw new Error('恢复码应为 ' + KEY_CHARS + ' 个字符（不计空格与连字符），当前 ' + compact.length + ' 个');
  }
  const key = base32Decode(compact);
  if (!key) throw new Error('恢复码含非 base32 字符（合法字符为 A-Z 与 2-7）或末位字符越出编码范围');
  return assertRecoveryKey(key);
}

/* 调用方手上的恢复码有两种形态：内存/返回值里的 32 字节，和抄在纸上的分组字符串。
   这里统一收口，免得每个入口各写一遍大小写与分隔符的归一化。 */
function toRecoveryKey(value) {
  return Buffer.isBuffer(value) ? assertRecoveryKey(value) : parseRecoveryKey(value);
}

function wrapDekForRecovery(dek, recoveryKey) {
  if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) throw new Error('DEK 必须是 32 字节 Buffer');
  const key = toRecoveryKey(recoveryKey);
  const iv = crypto.randomBytes(IV_BYTES);
  // 恢复码已是 256 位全熵，再过一遍 KDF 只会把可用强度降下来，所以原样当密钥用
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(RECOVERY_AAD);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  // getAuthTag() 必须在 final() 之后调，提前取到的是空标签，解开后是一段解不开的密文
  return RECOVERY_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function openRecoveryEnvelope(env, recoveryKey) {
  const blob = typeof env === 'string' ? env.trim() : '';
  if (!blob.startsWith(RECOVERY_PREFIX)) throw new Error('恢复信封格式不认识');
  const buf = Buffer.from(blob.slice(RECOVERY_PREFIX.length), 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) throw new Error('恢复信封已损坏');
  const key = toRecoveryKey(recoveryKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_BYTES));
  decipher.setAAD(RECOVERY_AAD);
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  let pt;
  try {
    pt = Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch (err) {
    // GCM 认证失败抛的是裸 Error 且 code 为 undefined，只能按 message 区分；其余异常原样上抛
    if (/unable to authenticate/i.test(err.message)) throw new Error('恢复码不正确');
    throw err;
  }
  if (pt.length !== KEY_BYTES) {
    zeroSecret(pt);
    throw new Error('恢复信封内容不合法（DEK 长度不为 ' + KEY_BYTES + ' 字节）');
  }
  return pt;
}

function saveRecoveryEnvelope(dataDir, env, opts) {
  if (typeof env !== 'string' || !env.startsWith(RECOVERY_PREFIX)) {
    throw new Error('不是恢复信封（前缀应为 rec:v1:），拒绝落盘');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const p = path.join(dataDir, RECOVERY_FILE);
  const force = !!(opts && opts.force === true);
  // 覆盖等于把上一张纸作废，而调用方手里多半只剩口令；换代用 rotateRecoveryEnvelope
  if (!force && fs.existsSync(p)) {
    throw new Error(RECOVERY_FILE + ' 已存在，覆盖需显式 opts.force = true（旧恢复码将立即失效）');
  }
  fs.writeFileSync(p, env + '\n', { mode: 0o600 });
  return p;
}

function readRecoveryEnvelope(dataDir) {
  const p = path.join(dataDir, RECOVERY_FILE);
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf8').trim();
  if (!txt) return null;
  // 半截写入或被人塞了别的东西进来，都要在解锁流程之前报信封的错，而不是崩在 base64 里
  if (!txt.startsWith(RECOVERY_PREFIX)) throw new Error(RECOVERY_FILE + ' 不是恢复信封（前缀应为 rec:v1:）');
  return txt;
}

function createRecoveryEnvelope(dataDir, dek, recoveryKey) {
  // 让用户提供码，才有「抄了但没抄对」的当场失败；静默随机生成等于把码扔进无人看见的内存
  if (recoveryKey == null) throw new Error('请提供恢复码：它不落盘，生成后没人看得见就等于没生成');
  const key = toRecoveryKey(recoveryKey);
  const env = wrapDekForRecovery(dek, key);
  saveRecoveryEnvelope(dataDir, env);
  return { env: env, key: key, display: formatRecoveryKey(key) };
}

/* 换一把恢复码重新包同一份 DEK。只覆盖本模块的信封，口令侧的 vault.key 一字不动。
   不碰调用方传进来的 DEK——解锁会话还要用它，清零就是一条把用户锁在门外的路径。 */
function rotateRecoveryEnvelope(dataDir, dek, newKey, opts) {
  const generated = newKey == null;
  const key = generated ? createRecoveryKey() : toRecoveryKey(newKey);
  try {
    const env = wrapDekForRecovery(dek, key);
    saveRecoveryEnvelope(dataDir, env, { force: (opts && opts.force) !== false });
    return { env: env, key: key };
  } catch (err) {
    // 新生成又没交出去的码留在内存里只是多一处可 dump 的明文，就地清零；
    // 调用方递进来的字节归它自己管，不替人清零
    if (generated) zeroSecret(key);
    throw err;
  }
}

module.exports = {
  createRecoveryKey,
  formatRecoveryKey,
  parseRecoveryKey,
  wrapDekForRecovery,
  openRecoveryEnvelope,
  saveRecoveryEnvelope,
  readRecoveryEnvelope,
  rotateRecoveryEnvelope,
  createRecoveryEnvelope,
  RECOVERY_FILE,
  RECOVERY_AAD,
  RECOVERY_PREFIX,
  KEY_BYTES,
  KEY_CHARS,
};
