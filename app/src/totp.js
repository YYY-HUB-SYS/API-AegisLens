const crypto = require('node:crypto');

/* TOTP（RFC 6238，基于 RFC 4226 的 HOTP）。纯标准库，零依赖。
   secret 既可以传 base32 字符串（otpauth URI 里的形态），也可以传 Buffer/Uint8Array 原始密钥字节。
   两种入口都保留是有原因的：RFC 6238 附录 B 的 SHA512 测试密钥要 64 字节，
   手工从 base32 字符串数长度极易少算（少算会得到 56 字节，HMAC 照样能算、码却全错且不报错），
   传 Buffer 直接把这条坑封死；base32 入口则负责校验解出的字节数非零。 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALLOWED_ALGORITHMS = ['sha1', 'sha256', 'sha512'];
const ALLOWED_DIGITS = [6, 8];
const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_ALGORITHM = 'sha1';

/* base32 解码（RFC 4648 无填充形态）。空格一律忽略（URI 里常见分组空格），尾部 `=` 忽略。
   非法字符必须抛错：这里的字符表没有 0/1/8/9，抄错的 secret 把它们当合法字符吞下去，
   会得到一个长度对不上、却永远解不出正确验证码的密钥——宁可当场拒绝。 */
function decodeBase32(input) {
  if (typeof input !== 'string') throw new TypeError('base32 secret 必须是字符串');
  let s = '';
  for (const ch of input) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '-') continue;
    s += ch;
  }
  // 只剥尾部填充；中间的 = 是脏数据
  s = s.replace(/=+$/, '');
  if (/=/.test(s)) throw new Error('base32 secret 中间出现填充字符 =：' + JSON.stringify(input));

  const upper = s.toUpperCase();
  if (upper === '') throw new Error('base32 secret 为空');

  const bits = [];
  for (let i = 0; i < upper.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(upper[i]);
    if (idx < 0) {
      throw new Error('base32 secret 含非法字符 ' + JSON.stringify(upper[i])
        + '（合法字符表 A–Z 与 2–7，注意不含 0/1/8/9）');
    }
    for (let b = 4; b >= 0; b--) bits.push((idx >> b) & 1);
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    bytes.push(byte);
  }
  // 不足 8 位的余量必须全为零，否则说明字符串是被截断的
  for (let i = bytes.length * 8; i < bits.length; i++) {
    if (bits[i] !== 0) throw new Error('base32 secret 末尾余量非零，疑似被截断：' + JSON.stringify(input));
  }
  if (bytes.length === 0) throw new Error('base32 secret 太短，解不出任何字节：' + JSON.stringify(input));
  return Buffer.from(bytes);
}

/* 归一化密钥：字符串走 base32，Buffer/Uint8Array 原样取字节并校验长度 */
function normalizeSecret(secret) {
  if (secret == null) throw new Error('缺少 secret');
  if (Buffer.isBuffer(secret)) {
    if (secret.length === 0) throw new Error('secret 字节数为 0');
    return secret;
  }
  if (secret instanceof Uint8Array) {
    if (secret.length === 0) throw new Error('secret 字节数为 0');
    return Buffer.from(secret);
  }
  if (typeof secret === 'string') return decodeBase32(secret);
  throw new TypeError('secret 只能是 base32 字符串或字节数组，收到：' + typeof secret);
}

function normalizeAlgorithm(algorithm) {
  if (algorithm == null) return DEFAULT_ALGORITHM;
  if (typeof algorithm !== 'string') throw new TypeError('algorithm 必须是字符串');
  // otpauth URI 里写 SHA1/SHA256/SHA512，也有实现写 HMAC-SHA1，统一抹平
  const name = algorithm.trim().toUpperCase().replace(/^HMAC-/, '').replace(/-/g, '');
  const short = name === 'SHA1' ? 'sha1' : name === 'SHA256' ? 'sha256' : name === 'SHA512' ? 'sha512' : null;
  if (!short) throw new Error('不支持的 algorithm：' + JSON.stringify(algorithm)
    + '（只支持 ' + ALLOWED_ALGORITHMS.join('/') + '）');
  return short;
}

function normalizeDigits(digits) {
  if (digits == null) return DEFAULT_DIGITS;
  const n = Number(digits);
  if (!Number.isInteger(n)) throw new Error('digits 必须是整数：' + JSON.stringify(digits));
  if (ALLOWED_DIGITS.indexOf(n) < 0) throw new Error('digits 只支持 6 或 8，收到：' + n);
  return n;
}

function normalizeStep(step) {
  if (step == null) return DEFAULT_STEP_SECONDS;
  const n = Number(step);
  // 报错用 String 而非 JSON：JSON.stringify(NaN) 会打成 "null"，把排错方向带偏
  if (!Number.isFinite(n) || n <= 0) throw new Error('step 必须是正数（秒），收到：' + String(step));
  return n;
}

/* 时间 → Unix 秒。
   数字一律按 Unix 秒解释（与 RFC 6238 的 K、otpauth 的 period 同一单位），
   不做「小于某阈值就当毫秒」的猜测——阈值魔法数会让 1970 年附近和未来的取值行为不一致。
   Date 与 ISO 字符串按墙上时刻解释，内部是毫秒，需要换算。 */
function toUnixSeconds(at) {
  if (at == null) return Date.now() / 1000;
  if (typeof at === 'number') {
    if (!Number.isFinite(at)) throw new Error('at 不是有限数字：' + at);
    return at;
  }
  if (at instanceof Date) {
    const ms = at.getTime();
    if (Number.isNaN(ms)) throw new Error('at 是非法 Date');
    return ms / 1000;
  }
  if (typeof at === 'string') {
    // 纯数字串按 Unix 秒解释（表单和 JSON 里的数字常以字符串抵达）；
    // 直接丢给 Date.parse 会把 '59' 读成公元 59 年，算出一个安静的错码
    if (/^\s*-?\d+(\.\d+)?\s*$/.test(at)) {
      const n = Number(at);
      if (!Number.isFinite(n)) throw new Error('at 不是有限数字：' + at);
      return n;
    }
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) throw new Error('at 无法解析为时间：' + JSON.stringify(at));
    return ms / 1000;
  }
  throw new TypeError('at 只能是 Date、ISO 字符串或 Unix 秒数字，收到：' + typeof at);
}

function counterFor(at, step) {
  const seconds = toUnixSeconds(at);
  // 计数器可正可负（1970 年之前的时间戳为负），用 floor 保证窗口边界一致
  const c = Math.floor(seconds / step);
  if (!Number.isSafeInteger(c)) throw new Error('计数器超出安全整数范围：' + c);
  return c;
}

/* RFC 4226 动态截取：低 4 位偏移 + 4 字节去符号位，再对 10^digits 取模 */
function truncatedCode(hmacDigest, digits) {
  const offset = hmacDigest[hmacDigest.length - 1] & 0x0f;
  const code = (hmacDigest.readUInt32BE(offset) & 0x7fffffff) % Math.pow(10, digits);
  return String(code).padStart(digits, '0');
}

function generate(opts) {
  const o = opts || {};
  const key = normalizeSecret(o.secret);
  const step = normalizeStep(o.step);
  const digits = normalizeDigits(o.digits);
  const algorithm = normalizeAlgorithm(o.algorithm);
  const counter = counterFor(o.at, step);

  const buf = Buffer.alloc(8);
  // RFC 4226 的计数器是 8 字节无符号大端；负数只可能来自 1970 年前的时间戳，
  // 那是时钟或输入坏了，绕码（wrap）成一个看起来合法的值比直接报错更难查
  if (counter < 0) throw new Error('时间戳早于 1970 年，计数器为负（' + counter + '），拒绝生成 TOTP 码');
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(algorithm, key).update(buf).digest();
  return truncatedCode(digest, digits);
}

/* 本窗口还剩多少秒。落在窗口边界上（t % step === 0）就是满窗口，所以取值范围 1..step。 */
function secondsRemaining(at, step) {
  const s = normalizeStep(step);
  const seconds = Math.floor(toUnixSeconds(at));
  const elapsed = ((seconds % s) + s) % s;
  return s - elapsed;
}

/* 大小写不敏感的 query 取值器；同名多取时以第一次出现为准（与 URLSearchParams.get 的行为一致）。 */
function ciParams(searchParams) {
  const map = new Map();
  for (const [name, value] of searchParams.entries()) {
    const lower = name.toLowerCase();
    if (!map.has(lower)) map.set(lower, value);
  }
  return {
    has: function (name) { return map.has(String(name).toLowerCase()); },
    get: function (name) { return map.get(String(name).toLowerCase()); }
  };
}

/* 解析 otpauth:// URI。
   形如 otpauth://totp/GitHub:alice@example.com?secret=JBSW...&issuer=GitHub&period=30&digits=6&algorithm=SHA1
   类型在 hostname 上（totp/hotp），算法等参数在 query 上。
   hotp 明确拒绝：本工具的保险库只做基于时间的码，接受一个没有计数器状态的 URI 会存进一个永远算不对的密钥。 */
function parseOtpauthUri(uri) {
  if (typeof uri !== 'string') throw new TypeError('otpauth URI 必须是字符串');
  const trimmed = uri.trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch (e) {
    throw new Error('otpauth URI 无法解析：' + JSON.stringify(uri));
  }
  if (url.protocol !== 'otpauth:') throw new Error('不是 otpauth URI（协议为 ' + url.protocol + '）：' + JSON.stringify(uri));

  const type = decodeURIComponent(url.hostname).toLowerCase();
  // `otpauth:/totp/x`（单斜杠）没有 authority 段，hostname 为空——此时报"类型不支持"会指向错方向
  if (!type) throw new Error('otpauth URI 缺少类型段（应为 otpauth://totp/…）：' + JSON.stringify(uri));
  if (type === 'hotp') {
    throw new Error('otpauth URI 是 HOTP（基于计数器）类型，本工具只支持基于时间的 TOTP，拒绝导入：' + JSON.stringify(uri));
  }
  if (type !== 'totp') throw new Error('otpauth URI 类型不支持：' + JSON.stringify(type) + '（只支持 totp）');

  // label 在 pathname 上：/Issuer:account 或 /account
  let label = url.pathname.replace(/^\//, '');
  label = decodeURIComponent(label);
  let issuerFromLabel = null;
  let account = label;
  const colon = label.indexOf(':');
  if (colon >= 0) {
    issuerFromLabel = label.slice(0, colon).trim();
    account = label.slice(colon + 1).trim();
  }

  // query 参数名按大小写不敏感取：URLSearchParams 本身是大小写敏感的，
  // 而各家实现真会写出 DIGITS=8 / Algorithm=SHA1 这种形态；
  // 若按敏感匹配，这些参数会被当成"没提供"而静默落到默认值，用户拿到的是位数都不对的码
  const q = ciParams(url.searchParams);
  const rawSecret = q.get('secret');
  if (!rawSecret || !rawSecret.trim()) throw new Error('otpauth URI 缺少 secret 参数：' + JSON.stringify(uri));

  let key;
  try {
    key = decodeBase32(rawSecret);
  } catch (e) {
    throw new Error('otpauth URI 的 secret 非法：' + e.message);
  }

  const issuerParam = q.get('issuer');
  const issuer = (issuerParam && issuerParam.trim()) ? issuerParam.trim() : (issuerFromLabel || null);

  // 参数一律按不可信输入校验，校验逻辑与 generate 共用，避免两边标准不一致
  const step = q.has('period') ? normalizeStep(q.get('period')) : DEFAULT_STEP_SECONDS;
  const digits = q.has('digits') ? normalizeDigits(q.get('digits')) : DEFAULT_DIGITS;
  const algorithm = q.has('algorithm') ? normalizeAlgorithm(q.get('algorithm')) : DEFAULT_ALGORITHM;

  return {
    type: 'totp',
    secret: rawSecret.trim().toUpperCase(),
    secretBytes: key,
    issuer: issuer,
    account: account || null,
    step: step,
    digits: digits,
    algorithm: algorithm,
    generate: function (at) {
      return generate({ secret: key, at: at, step: step, digits: digits, algorithm: algorithm });
    }
  };
}

module.exports = {
  decodeBase32: decodeBase32,
  generate: generate,
  parseOtpauthUri: parseOtpauthUri,
  secondsRemaining: secondsRemaining,
  DEFAULT_STEP_SECONDS: DEFAULT_STEP_SECONDS,
  DEFAULT_DIGITS: DEFAULT_DIGITS,
  DEFAULT_ALGORITHM: DEFAULT_ALGORITHM,
  ALLOWED_ALGORITHMS: ALLOWED_ALGORITHMS,
  ALLOWED_DIGITS: ALLOWED_DIGITS
};
