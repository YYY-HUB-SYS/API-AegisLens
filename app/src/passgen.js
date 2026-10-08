const crypto = require('node:crypto');

/* 口令生成器 + 强度判定 + Apple 站点规则查询。纯标准库，零依赖。
   随机性只走 crypto.randomInt（CSPRNG），既不用 Math.random（可预测，存进保险库等于白加密），
   也不用 `% pool.length` 取模——池长不是 2 的幂时取模会让靠前的字符出现概率系统性偏高（模偏差）。
   randomInt(n) 内部做了拒绝采样，是标准库里唯一无偏的取整入口。 */

const POOL_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const POOL_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const POOL_DIGIT = '0123456789';
const POOL_SYMBOL = '!@#$%^&*()-_=+[]{};:,.<>?/';

/* 易混字符：默认剔除 I/O/0/1/l（用户点定的五个）。密钥要在纸上抄一遍、或者在手机上找一个，
   看不清就得重来，这类字符留在池子里只制造工单。 */
const AMBIGUOUS_CHARS = 'IO01l';

const MAX_LENGTH = 256;

function uniqueChars(str) {
  return Array.from(new Set(Array.from(str)));
}

function filterPool(pool, excluded) {
  let out = '';
  for (const ch of pool) if (!excluded.has(ch)) out += ch;
  return out;
}

function normalizeOptions(opts) {
  const o = opts || {};
  const length = o.length === undefined || o.length === null ? 20 : Number(o.length);
  if (!Number.isInteger(length)) throw new Error('length 必须是整数，收到：' + String(o.length));
  if (length < 1) throw new Error('length 必须是正整数，收到：' + length);
  if (length > MAX_LENGTH) throw new Error('length 超过上限 ' + MAX_LENGTH + '，收到：' + length);

  const want = {
    upper: o.upper === undefined ? true : !!o.upper,
    lower: o.lower === undefined ? true : !!o.lower,
    digit: o.digit === undefined ? true : !!o.digit,
    symbol: o.symbol === undefined ? true : !!o.symbol
  };
  if (!want.upper && !want.lower && !want.digit && !want.symbol) {
    throw new Error('至少需要启用一类字符（upper/lower/digit/symbol）');
  }

  // excludeAmbiguous 默认开启；exclude 允许调用方再点掉任意字符（累积，不覆盖默认值）
  const excluded = new Set();
  const dropAmbiguous = o.excludeAmbiguous === undefined ? true : !!o.excludeAmbiguous;
  if (dropAmbiguous) for (const ch of AMBIGUOUS_CHARS) excluded.add(ch);
  if (o.exclude != null) {
    if (typeof o.exclude !== 'string') throw new TypeError('exclude 必须是字符串');
    for (const ch of uniqueChars(o.exclude)) excluded.add(ch);
  }

  return { length: length, want: want, excluded: excluded, excludeAmbiguous: dropAmbiguous };
}

/* 生成一条口令。
   先给每个被要求的字符类各强制一个字符，剩下的从合并池里抽，最后整串洗牌。
   洗牌是必须的：不洗的话前几位永远按 upper→lower→digit→symbol 的顺序出现，
   攻击者知道「第 1 位必是大写、第 4 位必是符号」，实际熵直接掉一截。 */
function generate(opts) {
  const o = normalizeOptions(opts);

  const classPools = [];
  if (o.want.upper) classPools.push(['upper', filterPool(POOL_UPPER, o.excluded)]);
  if (o.want.lower) classPools.push(['lower', filterPool(POOL_LOWER, o.excluded)]);
  if (o.want.digit) classPools.push(['digit', filterPool(POOL_DIGIT, o.excluded)]);
  if (o.want.symbol) classPools.push(['symbol', filterPool(POOL_SYMBOL, o.excluded)]);

  for (const [name, pool] of classPools) {
    if (pool.length === 0) throw new Error('字符类 ' + name + ' 被排除规则清空了，无法保证该类至少出现一次');
  }
  if (o.length < classPools.length) {
    throw new Error('length=' + o.length + ' 放不下 ' + classPools.length + ' 个强制字符类，'
      + '请加大 length 或关掉一些类别');
  }

  const combined = classPools.map(([, pool]) => pool).join('');
  const chars = [];
  for (const [, pool] of classPools) chars.push(pool.charAt(crypto.randomInt(pool.length)));
  for (let i = chars.length; i < o.length; i++) chars.push(combined.charAt(crypto.randomInt(combined.length)));

  // Fisher-Yates（反向）：每一步在 [0, i] 内均匀取 j，用 randomInt 保证无偏
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join('');
}

/* ---------- 强度判定 ----------
   判据写在这里，也写进测试，两边必须一致：
   1) 熵估算 = 长度 × log2(观测到的字符池大小)，池按实际出现的类别累加：
      小写 26 / 大写 26 / 数字 10 / 符号 33。凡是非字母数字的字符（含空格、中文、emoji）都并进符号一类，
      所以任何非空口令至少有一类、池至少 10——不存在"池为 0"的分支。
      对中文这类超大字符集来说 33 是明显低估，但强度计只朝保守方向偏才不会给用户虚假的安全感。
   2) 档位：<40 bit = 0，<60 = 1，<80 = 2，<120 = 3，>=120 = 4。
   3) 命中常见弱口令表，或是纯序列/纯重复，直接压到 0/1 档——熵估计算不出「password123」的廉价。 */

const CLASS_SIZES = { lower: 26, upper: 26, digit: 10, symbol: 33 };

/* 常见弱口令：收录原则是「排行榜常客 + 本工具用户真会顺手敲的那几个」，不是越大越好，
   表大了误判率低但会把「够长却撞表」的判定弄得很随意。 */
const COMMON_PASSWORDS = [
  'password', 'passw0rd', 'p@ssw0rd', 'password1', 'password123', 'passwort',
  'qwerty', 'qwertyuiop', 'qwert123', 'azerty', 'abc123', 'abcd1234',
  '123456', '123456789', '12345678', '12345', '111111', '000000', 'iloveyou',
  'admin', 'administrator', 'root', 'login', 'welcome', 'letmein', 'monkey',
  'dragon', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman',
  'trustno1', 'whatever', 'starwars', 'gateway', 'blink182', 'changeme', 'secret',
  'test', 'guest', 'master', 'hello', 'freedom', 'football1', 'pass', 'pass1234'
];

const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm',
  'zyxwvutsrqponmlkjihgfedcba'
];

function classesIn(pw) {
  const found = [];
  if (/[a-z]/.test(pw)) found.push('lower');
  if (/[A-Z]/.test(pw)) found.push('upper');
  if (/[0-9]/.test(pw)) found.push('digit');
  if (/[^a-zA-Z0-9]/.test(pw)) found.push('symbol');
  return found;
}

function poolSizeFor(pw) {
  let size = 0;
  if (/[a-z]/.test(pw)) size += CLASS_SIZES.lower;
  if (/[A-Z]/.test(pw)) size += CLASS_SIZES.upper;
  if (/[0-9]/.test(pw)) size += CLASS_SIZES.digit;
  // 非字母数字一律并入符号类：空格、中文、emoji 都走这一支，所以对任何非空口令 size 至少是 26 或 33
  if (/[^a-zA-Z0-9]/.test(pw)) size += CLASS_SIZES.symbol;
  return size;
}

/* 是否整串由一个固定步进的序列片段构成（如 abcde、6789、qwer 及其逆序） */
function isSequential(pw) {
  const n = pw.length;
  if (n < 4) return false;
  const lower = pw.toLowerCase();
  for (const seq of SEQUENCES) {
    if (seq.includes(lower)) return true;
    const rev = seq.split('').reverse().join('');
    if (rev.includes(lower)) return true;
  }
  // 等步长（+1/-1）覆盖序列目录里没有的字母组合，如 'cdef'、'9876'
  const step = codeAt(pw, 1) - codeAt(pw, 0);
  if (step !== 0 && Math.abs(step) <= 2) {
    let ok = true;
    for (let i = 1; i < n; i++) if (codeAt(pw, i) - codeAt(pw, i - 1) !== step) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function codeAt(pw, i) {
  const cp = pw.codePointAt(i);
  return cp;
}

/* 纯重复：整串是同一个字符，或同一个 2–3 字符块的重复（aaaa、ababab、abcabc） */
function isRepetitive(pw) {
  const n = pw.length;
  if (n < 4) return false;
  for (const block of [1, 2, 3]) {
    if (n % block !== 0) continue;
    const unit = pw.slice(0, block);
    let same = true;
    for (let i = block; i < n; i += block) if (pw.slice(i, i + block) !== unit) { same = false; break; }
    if (same) return true;
  }
  return false;
}

function evaluate(password) {
  if (typeof password !== 'string') throw new TypeError('evaluate 需要一个字符串');
  const pw = password;
  const reasons = [];
  if (pw.length === 0) {
    return { score: 0, label: 'very-weak', bits: 0, length: 0, classes: [], reasons: ['空口令'] };
  }

  const pool = poolSizeFor(pw);
  const bits = Math.round(pw.length * (Math.log(pool) / Math.LN2) * 100) / 100;
  let score = bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : bits < 120 ? 3 : 4;

  if (pw.length < 8) reasons.push('长度不足 8 位');
  if (pool <= 10) reasons.push('字符类别过少（仅 ' + pool + ' 个字符可选）');
  else if (classesIn(pw).length < 3) reasons.push('字符类别少于三类');

  const lowered = pw.toLowerCase();
  if (COMMON_PASSWORDS.indexOf(lowered) >= 0) {
    reasons.push('命中常见弱口令');
    score = Math.min(score, 0);
  } else {
    // 弱词 + 尾巴数字/年份（password2026、qwerty!）同样是查表就到的变体
    for (const weak of COMMON_PASSWORDS) {
      if (weak.length >= 4 && lowered.length > weak.length + 1 && lowered.startsWith(weak)) {
        reasons.push('常见弱口令加缀（' + weak + ' + …）');
        score = Math.min(score, 1);
        break;
      }
    }
  }
  if (isSequential(pw)) { reasons.push('纯字符序列'); score = Math.min(score, 1); }
  if (isRepetitive(pw)) { reasons.push('纯重复片段'); score = Math.min(score, 1); }

  const LABELS = ['very-weak', 'weak', 'fair', 'strong', 'very-strong'];
  return {
    score: score,
    label: LABELS[score],
    bits: bits,
    length: pw.length,
    classes: classesIn(pw),
    reasons: reasons
  };
}

/* ---------- Apple 站点规则 ---------- */
const PASSWORD_RULES = require('./password-rules.json');
const CHANGE_PASSWORD_URLS = require('./change-password-URLs.json');

/* 在 host 上找规则表的键：整串试，再逐层砍掉最左边的标签回退到注册域
   （a.b.example.com → b.example.com → example.com，到两级为止）。
   只做标签边界上的回退，不做子串匹配——否则 notgithub.com 会被当成 github.com 的规则。 */
function lookupIn(table, host) {
  const labels = host.split('.');
  for (let start = 0; start + 2 <= labels.length; start++) {
    const candidate = labels.slice(start).join('.');
    if (Object.prototype.hasOwnProperty.call(table, candidate)) return candidate;
  }
  return null;
}

/* 把 host 从 URL、带端口、带大写、带尾点的形态里剥出来；顺手丢掉 www. 前缀。 */
function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.indexOf('://') >= 0) {
    try { s = new URL(s).hostname; } catch (e) { return null; }
  }
  s = s.replace(/^\/+/, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  s = s.replace(/:\d+$/, '');
  s = s.replace(/\.+$/, '');
  if (s.indexOf('.') < 0) return null;
  if (!/^[a-z0-9._-]+$/.test(s)) return null;
  if (s.startsWith('www.')) s = s.slice(4);
  return s;
}

/* 括号深度感知的分段：Apple 的规则串里，显式字符集写作 required: [-!#$%&'()*+,./:;<=>?@[\]^_`{|}~];
   —— 字符集本身含有 `;` 和 `:`，直接 split(';') 会把一条规则切成好几段、把 allowed 的字符表读丢。
   所以只在括号外的 `;` 处断句；括号不配对（上游确有 6 条如此）时不报错，让无法归类的碎片被忽略，
   数值字段因为在串的前部、早已正确断出，不受影响。 */
function splitRuleSegments(ruleString) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of ruleString) {
    if (ch === '[') depth++;
    else if (ch === ']') { if (depth > 0) depth--; }
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(function (x) { return x.trim(); }).filter(Boolean);
}

/* 值可能是逗号分隔的具名类别，也可能是一整个显式字符集 `[...]`。 */
function parseRuleValue(value) {
  const names = [];
  let charset = null;
  let cur = '';
  let depth = 0;
  const parts = [];
  for (const ch of value) {
    if (ch === '[') depth++;
    else if (ch === ']') { if (depth > 0) depth--; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.startsWith('[')) { charset = (charset || '') + part; continue; }
    // 括号内的逗号（字符集里真有逗号）落到这里时已在同一个 part 里，不会误判为类别名
    if (/^[a-z][a-z-]*$/i.test(part)) names.push(part.toLowerCase());
    else if (charset === null) charset = part;
  }
  return { names: names, charset: charset };
}

function parsePasswordRules(ruleString) {
  const parsed = {
    minLength: null,
    maxLength: null,
    maxConsecutive: null,
    required: [],
    allowed: [],
    requiredCharset: null,
    allowedCharset: null,
    unrecognized: [],
    raw: ruleString
  };
  for (const seg of splitRuleSegments(ruleString)) {
    const colon = seg.indexOf(':');
    if (colon < 0) { parsed.unrecognized.push(seg); continue; }
    const key = seg.slice(0, colon).trim();
    const value = seg.slice(colon + 1).trim();
    if (key === 'minlength') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) parsed.minLength = parsed.minLength === null ? n : Math.max(parsed.minLength, n);
    } else if (key === 'maxlength') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) parsed.maxLength = parsed.maxLength === null ? n : Math.min(parsed.maxLength, n);
    } else if (key === 'max-consecutive') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) parsed.maxConsecutive = parsed.maxConsecutive === null
        ? n : Math.min(parsed.maxConsecutive, n);
    } else if (key === 'required') {
      const r = parseRuleValue(value);
      for (const nm of r.names) if (parsed.required.indexOf(nm) < 0) parsed.required.push(nm);
      if (r.charset) parsed.requiredCharset = (parsed.requiredCharset || '') + r.charset;
    } else if (key === 'allowed') {
      const r = parseRuleValue(value);
      for (const nm of r.names) if (parsed.allowed.indexOf(nm) < 0) parsed.allowed.push(nm);
      if (r.charset) parsed.allowedCharset = (parsed.allowedCharset || '') + r.charset;
    } else {
      // 括号不配对造成的碎片：原样留着，不猜它是什么
      parsed.unrecognized.push(seg);
    }
  }
  return parsed;
}

/* 查不到就返回 null，绝不返回「看起来合理」的默认长度——猜错的 maxlength 会让用户在
   最后一个字符上被站点拒绝，比没有规则更糟。 */
function rulesForDomain(domain) {
  const host = normalizeDomain(domain);
  if (!host) return null;
  const key = lookupIn(PASSWORD_RULES, host);
  if (!key) return null;
  const entry = PASSWORD_RULES[key];
  const ruleString = entry && typeof entry === 'object' ? entry['password-rules'] : null;
  if (typeof ruleString !== 'string') return null;
  const parsed = parsePasswordRules(ruleString);
  parsed.domain = key;
  parsed.requested = host;
  return parsed;
}

function changePasswordUrlFor(domain) {
  const host = normalizeDomain(domain);
  if (!host) return null;
  const key = lookupIn(CHANGE_PASSWORD_URLS, host);
  if (!key) return null;
  const url = CHANGE_PASSWORD_URLS[key];
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return null;
  return { domain: key, requested: host, url: url.trim() };
}

module.exports = {
  generate: generate,
  evaluate: evaluate,
  rulesForDomain: rulesForDomain,
  changePasswordUrlFor: changePasswordUrlFor,
  normalizeDomain: normalizeDomain,
  splitRuleSegments: splitRuleSegments,
  parsePasswordRules: parsePasswordRules,
  POOL_UPPER: POOL_UPPER,
  POOL_LOWER: POOL_LOWER,
  POOL_DIGIT: POOL_DIGIT,
  POOL_SYMBOL: POOL_SYMBOL,
  AMBIGUOUS_CHARS: AMBIGUOUS_CHARS,
  MAX_LENGTH: MAX_LENGTH
};
