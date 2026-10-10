const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = require('./tmp.js');
const {
  generate,
  evaluate,
  rulesForDomain,
  changePasswordUrlFor,
  normalizeDomain,
  splitRuleSegments,
  POOL_UPPER,
  POOL_LOWER,
  POOL_DIGIT,
  POOL_SYMBOL,
  AMBIGUOUS_CHARS,
  MAX_LENGTH
} = require('../src/passgen');

const SRC_DIR = path.join(__dirname, '..', 'src');
const RULES_JSON = path.join(SRC_DIR, 'password-rules.json');
const URLS_JSON = path.join(SRC_DIR, 'change-password-URLs.json');
const LICENSE_MD = path.join(SRC_DIR, 'LICENSE-apple-password-rules.md');

/* ---------- 随机源：这条是红线，先用静态检查钉死 ---------- */

test('随机性只走 crypto.randomInt：不许 Math.random，也不许对长度取模', () => {
  const raw = fs.readFileSync(path.join(SRC_DIR, 'passgen.js'), 'utf8');
  // 只查代码不查注释：本模块的注释里就写着这两个被禁的写法，连着注释一起匹配会自己判自己违规
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(code !== raw, '注释剥完没剩多少，这条断言等于空跑');
  assert.ok(!/Math\.random/.test(code), 'Math.random 可预测，口令进保险库等于没加密');
  // 取模选字符有模偏差：池长不是 2 的幂时，靠前字符出现概率系统性偏高
  assert.ok(!/%\s*[\w$.]*\.length/.test(code), '出现 `x % ….length` 形态的取模选字符');
  assert.ok(/require\(['"]node:crypto['"]\)/.test(code), 'passgen 应当依赖 node:crypto');
  assert.ok(/crypto\.randomInt\(/.test(code), 'passgen 必须用 crypto.randomInt');
  // 纯本地数据模块，不该有网络出口
  assert.ok(!/require\(['"]node:(http|https|net|dns)['"]\)/.test(code), '随仓数据模块不应发起网络请求');
  const requires = code.match(/require\((['"])([^'"]+)\1\)/g) || [];
  for (const r of requires) {
    assert.ok(
      /node:crypto|node:path|node:fs|\.\/password-rules\.json|\.\/change-password-URLs\.json/.test(r),
      '意外的依赖：' + r
    );
  }
});

/* ---------- generate：长度、必含类、洗牌 ---------- */

test('生成长度必须精确等于请求长度', () => {
  // 长度小于 4 时四类放不下（那是参数校验那条测试管的），这里用单类只测长度这一件事
  for (const length of [1, 2, 3]) {
    const pw = generate({ length: length, upper: false, lower: false, digit: false });
    assert.strictEqual(pw.length, length, '单类 length=' + length);
  }
  for (const length of [4, 8, 16, 20, 33, 64, 128, MAX_LENGTH]) {
    const pw = generate({ length: length });
    assert.strictEqual(pw.length, length, 'length=' + length);
    assert.strictEqual(typeof pw, 'string');
  }
  assert.strictEqual(generate({ length: 2, upper: false, lower: false }).length, 2);
  // 缺省长度 20
  assert.strictEqual(generate().length, 20);
});

test('被要求的字符类至少各出现一次（全类、逐长度、200 轮）', () => {
  for (const length of [4, 5, 8, 12, 20, 40]) {
    for (let i = 0; i < 40; i++) {
      const pw = generate({ length: length });
      assert.match(pw, /[A-Z]/, 'length=' + length + ' 缺大写：' + pw);
      assert.match(pw, /[a-z]/, 'length=' + length + ' 缺小写：' + pw);
      assert.match(pw, /[0-9]/, 'length=' + length + ' 缺数字：' + pw);
      assert.match(pw, /[^A-Za-z0-9]/, 'length=' + length + ' 缺符号：' + pw);
    }
  }
});

test('关掉某一类就一类都不许出现，开着的类仍然保底出现', () => {
  for (let i = 0; i < 60; i++) {
    const noSymbol = generate({ length: 24, symbol: false });
    assert.ok(!/[^A-Za-z0-9]/.test(noSymbol), '说不要符号却给了符号：' + noSymbol);
    assert.match(noSymbol, /[A-Z]/);
    assert.match(noSymbol, /[a-z]/);
    assert.match(noSymbol, /[0-9]/);

    const lowerOnly = generate({ length: 16, upper: false, digit: false, symbol: false });
    assert.match(lowerOnly, /^[a-z]+$/, '只要小写时混进了别的类：' + lowerOnly);

    const upperOnly = generate({ length: 16, lower: false, digit: false, symbol: false, excludeAmbiguous: false });
    assert.match(upperOnly, /^[A-Z]+$/, '只要大写时混进了别的类：' + upperOnly);

    const digitOnly = generate({ length: 16, upper: false, lower: false, symbol: false, excludeAmbiguous: false });
    assert.match(digitOnly, /^[0-9]+$/, '只要数字时混进了别的类：' + digitOnly);

    const symbolOnly = generate({ length: 16, upper: false, lower: false, digit: false });
    assert.ok(!/[A-Za-z0-9]/.test(symbolOnly), '只要符号却混进了字母数字：' + symbolOnly);
  }
});

test('强制字符不许被钉在头几位：整串必须经过洗牌', () => {
  // 不洗牌的话，length=4 时首位永远是第一个被强制的类（大写），第 4 位永远是符号。
  // 这里跑 400 轮，统计首位与末位的类别分布；二项分布下越界概率小于 1e-15，不会偶发翻红。
  const N = 400;
  const firstClass = { upper: 0, lower: 0, digit: 0, symbol: 0 };
  const lastClass = { upper: 0, lower: 0, digit: 0, symbol: 0 };
  const classify = function (ch) {
    if (/[A-Z]/.test(ch)) return 'upper';
    if (/[a-z]/.test(ch)) return 'lower';
    if (/[0-9]/.test(ch)) return 'digit';
    return 'symbol';
  };
  let allFour = 0;
  for (let i = 0; i < N; i++) {
    const pw = generate({ length: 4 });
    firstClass[classify(pw[0])]++;
    lastClass[classify(pw[3])]++;
    const kinds = new Set(Array.from(pw).map(classify));
    if (kinds.size === 4) allFour++;
  }
  assert.strictEqual(allFour, N, 'length=4 必须四类各一个，不该有漏');
  for (const k of ['upper', 'lower', 'digit', 'symbol']) {
    assert.ok(firstClass[k] > 20, k + ' 在首位出现 ' + firstClass[k] + ' 次，近乎缺席——洗牌没生效');
    assert.ok(firstClass[k] < N * 0.5, k + ' 占了首位 ' + firstClass[k] + '/' + N + '，说明它被固定在前');
    assert.ok(lastClass[k] > 20, k + ' 在末位出现 ' + lastClass[k] + ' 次，近乎缺席');
    assert.ok(lastClass[k] < N * 0.5, k + ' 占了末位 ' + lastClass[k] + '/' + N);
  }
  assert.strictEqual(
    firstClass.upper + firstClass.lower + firstClass.digit + firstClass.symbol, N
  );
});

test('取值覆盖到池子里的每一个字符（没有字符被 randomInt 漏掉）', () => {
  const seenDigit = new Set();
  for (let i = 0; i < 300; i++) {
    for (const ch of generate({ length: 12, upper: false, lower: false, symbol: false, excludeAmbiguous: false })) {
      seenDigit.add(ch);
    }
  }
  assert.strictEqual(seenDigit.size, 10, '数字池 10 个字符应全部出现，实得：' + [...seenDigit].sort().join(''));

  // 符号池逐个字符都得被取到，否则说明池子被某段切掉了
  const seenSymbol = new Set();
  for (let i = 0; i < 4000; i++) {
    for (const ch of generate({ length: 8, upper: false, lower: false, digit: false })) seenSymbol.add(ch);
  }
  for (const ch of POOL_SYMBOL) assert.ok(seenSymbol.has(ch), '符号 ' + ch + ' 从未被取到');
});

test('相邻两次生成几乎不可能完全相同', () => {
  const a = generate({ length: 20 });
  const b = generate({ length: 20 });
  assert.notStrictEqual(a, b);
  const set = new Set();
  for (let i = 0; i < 500; i++) set.add(generate({ length: 16 }));
  assert.ok(set.size > 480, '500 次生成出现明显重复：唯一值只有 ' + set.size);
});

/* ---------- 排除易混字符 ---------- */

test('默认排除 I O 0 1 l，关掉开关后才允许出现', () => {
  assert.strictEqual(AMBIGUOUS_CHARS, 'IO01l');
  for (let i = 0; i < 200; i++) {
    const pw = generate({ length: 32 });
    for (const ch of AMBIGUOUS_CHARS) {
      assert.ok(pw.indexOf(ch) < 0, '默认应当排除 ' + ch + '，实得：' + pw);
    }
  }
  // excludeAmbiguous:false 时这些字符必须重新可选（长串里必然出现若干个）
  let sawAny = false;
  for (let i = 0; i < 200; i++) {
    const pw = generate({ length: 40, excludeAmbiguous: false });
    for (const ch of AMBIGUOUS_CHARS) if (pw.indexOf(ch) >= 0) sawAny = true;
  }
  assert.ok(sawAny, '关掉排除后仍然一个易混字符都不出，说明开关没接上');
});

test('自定义 exclude 与默认排除是叠加关系，且区分大小写', () => {
  const pw = generate({ length: 200, exclude: 'aeiou' });
  for (const ch of 'aeiou') assert.ok(pw.indexOf(ch) < 0, ch + ' 应被排除');
  // 排除是小写的：'AEIOU' 这些大写还得能用，别把用户的意思理解成不区分大小写
  assert.match(pw, /[A-Z]/);
  // 叠加：默认的 IO01l 不会因为传了 exclude 就失效
  for (const ch of AMBIGUOUS_CHARS) assert.ok(pw.indexOf(ch) < 0);
  const both = generate({ length: 120, exclude: 'xyz', excludeAmbiguous: false });
  for (const ch of 'xyz') assert.ok(both.indexOf(ch) < 0);
  assert.match(both, /[IO01l]/, '关掉易混排除后应当能出现 I/O/0/1/l');
});

test('generate 的参数校验：放不下的组合要当场拒绝而不是偷偷降级', () => {
  assert.throws(() => generate({ length: 3 }), /放不下 4 个强制字符类/);
  assert.throws(() => generate({ length: 2, symbol: false }), /放不下 3 个强制字符类/);
  assert.throws(() => generate({ length: 1, digit: false, symbol: false }), /放不下 2 个强制字符类/);
  assert.throws(() => generate({ length: 1, symbol: false }), /放不下 3 个强制字符类/);
  // 单类一位是合法组合，不该被"长度小于 4"这种粗规则误伤
  assert.doesNotThrow(() => generate({ length: 1, upper: false, lower: false, digit: false }));
  assert.strictEqual(generate({ length: 1, upper: false, lower: false, digit: false }).length, 1);
  assert.strictEqual(generate({ length: 2, upper: false, lower: false }).length, 2);
  assert.throws(() => generate({ length: 12, upper: false, lower: false, digit: false, symbol: false }),
    /至少需要启用一类/);
  assert.throws(() => generate({ length: 0 }), /正整数/);
  assert.throws(() => generate({ length: -5 }), /正整数/);
  assert.throws(() => generate({ length: 10.5 }), /整数/);
  assert.throws(() => generate({ length: 'ten' }), /整数/);
  assert.throws(() => generate({ length: NaN }), /整数/);
  assert.throws(() => generate({ length: MAX_LENGTH + 1 }), /上限/);
  assert.throws(() => generate({ length: 999999 }), /上限/);
  // 某一类被 exclude 清空：必须点名是哪一类
  assert.throws(() => generate({ length: 8, exclude: POOL_DIGIT }), /数字|digit/);
  assert.throws(() => generate({ length: 8, exclude: POOL_SYMBOL }), /符号|symbol/);
  assert.throws(() => generate({ length: 8, exclude: 'xyz!@#$%^&*()-_=+[]{};:,.<>?/' }), /symbol/);
  assert.throws(() => generate({ length: 8, exclude: 42 }), /exclude 必须是字符串/);
  // 全大写字母表被排掉也不行
  assert.throws(() => generate({ length: 8, exclude: POOL_UPPER }), /upper/);
  // 只排掉易混字符不足以清空任何一类，必须仍然可用
  assert.doesNotThrow(() => generate({ length: 8, exclude: AMBIGUOUS_CHARS }));
});

/* ---------- evaluate：判定标准写在这里，与模块注释一致 ---------- */

/* 打乱过的 26 个小写字母：切片出来既不是序列也不是重复块，
   这样测的是纯档位边界，不会被「纯重复压到 1 档」那条规则串了味。 */
const SCRAM = 'qzjmrwnpfcbkyhgvdtxsiloaje';

test('熵估算：bits = 长度 × log2(观测字符池)，池按类别累加（26/26/10/33）', () => {
  const check = function (pw, expectedBits, expectedScore, expectedLabel) {
    const e = evaluate(pw);
    assert.strictEqual(e.bits, expectedBits, pw + ' 的 bits');
    assert.strictEqual(e.score, expectedScore, pw + ' 的 score');
    assert.strictEqual(e.label, expectedLabel, pw + ' 的 label');
  };
  // 单类小写：每字符 log2(26) = 4.70048 bit
  check('qzjmrwnp', 37.6, 0, 'very-weak');
  check('qzjmrwnpfcbky', 61.11, 2, 'fair');
  // 四类混合：每字符 log2(26+26+10+33) = 6.57088 bit
  check('aaaaaaaa', 37.6, 0, 'very-weak');       // 小写一类，且触发重复压档
  check('Tr0ub4dor&3', 72.27, 2, 'fair');
  check('xk9!mZq7#Rp4Lb2T', 105.12, 3, 'strong');
  check('Ab1!cD2!eF', 65.7, 2, 'fair');
  // 数字单一类只给 10 的池，比小写还窄
  const digits = evaluate('7301948266');
  assert.strictEqual(digits.bits, 33.22, '10 × log2(10)');
  assert.ok(digits.reasons.indexOf('字符类别过少（仅 10 个字符可选）') >= 0);
  // 表外字符（中文）不该被算成 0 池
  const cjk = evaluate('口令要够长才行啊喂');
  assert.strictEqual(cjk.length, 9);
  assert.strictEqual(cjk.bits, 45.4, '9 × log2(33)，中文按符号池保守估计');
  assert.deepStrictEqual(cjk.classes, ['symbol']);
});

test('档位边界：40/60/80/120 bit 的落点', () => {
  const scoreOf = function (pw) { const e = evaluate(pw); return e.score; };
  // 小写单类，逐长度跨过边界（这些切片都不触发序列/重复压档）
  assert.strictEqual(scoreOf(SCRAM.slice(0, 8)), 0);   // 37.60 < 40
  assert.strictEqual(scoreOf(SCRAM.slice(0, 9)), 1);   // 42.30 < 60
  assert.strictEqual(scoreOf(SCRAM.slice(0, 13)), 2);  // 61.11 < 80
  assert.strictEqual(scoreOf(SCRAM.slice(0, 17)), 2);  // 79.91 仍 < 80
  assert.strictEqual(scoreOf(SCRAM.slice(0, 18)), 3);  // 84.61 >= 80
  assert.strictEqual(scoreOf(SCRAM.slice(0, 26)), 4);  // 122.21 >= 120
  assert.strictEqual(evaluate(SCRAM.slice(0, 26)).label, 'very-strong');
  // 四类混合，边界落在 6/9/12/19 字符附近
  assert.strictEqual(scoreOf('Ab1!cD'), 0);            // 39.42 < 40
  assert.strictEqual(scoreOf('Ab1!cD2!'), 1);          // 52.57 < 60
  assert.strictEqual(scoreOf('Ab1!cD2!eF'), 2);        // 65.70 < 80
  assert.strictEqual(scoreOf('Ab1!cD2!eF3!g'), 3);     // 85.41 < 120
  assert.strictEqual(scoreOf('Ab1!cD2!eF3!gH4!iJ'), 3); // 118.26 仍 < 120
  assert.strictEqual(scoreOf('Ab1!cD2!eF3!gH4!iJ5!'), 4); // 131.40 >= 120
  assert.strictEqual(evaluate('Ab1!cD2!eF3!gH4!iJ5!').label, 'very-strong');
});

test('档位边界要卡在压档规则之前：重复串先被封顶', () => {
  // 13 个同样的字符按熵算是 61 bit（该有 2 档），但「纯重复」把它压回 1 档——
  // 这条测试锁的就是「熵高不等于安全」这个判定取向
  const repeated = evaluate('a'.repeat(13));
  assert.strictEqual(repeated.bits, 61.11);
  assert.strictEqual(repeated.score, 1);
  assert.ok(repeated.reasons.indexOf('纯重复片段') >= 0);
  const seq = evaluate('abcdefghijklm');
  assert.strictEqual(seq.bits, 61.11);
  assert.strictEqual(seq.score, 1);
  assert.ok(seq.reasons.indexOf('纯字符序列') >= 0);
});

test('evaluate 会说清扣分原因，且原因数组非空当且仅当有短板', () => {
  const short = evaluate('abc');
  assert.ok(short.reasons.includes('长度不足 8 位'));
  assert.ok(short.reasons.includes('字符类别少于三类'));
  const singleClass = evaluate('12345678');
  assert.ok(singleClass.reasons.includes('字符类别过少（仅 10 个字符可选）'));
  const good = evaluate('xk9!mZq7#Rp4Lb2T');
  assert.deepStrictEqual(good.reasons, [], '四类 16 位不该有扣分：' + good.reasons.join('；'));
  assert.deepStrictEqual(good.classes, ['lower', 'upper', 'digit', 'symbol']);
  assert.strictEqual(good.length, 16);
});

test('常见弱口令：精确命中、大小写无关、加缀变体一律压低', () => {
  for (const weak of ['password', 'Password', 'PASSWORD', 'qwerty', 'abc123', 'letmein',
    'iloveyou', '111111', 'admin', 'welcome', 'monkey', 'dragon', 'trustno1', 'p@ssw0rd',
    '123456789', 'changeme', 'passw0rd']) {
    const e = evaluate(weak);
    assert.strictEqual(e.score, 0, weak + ' 必须判到 0，实得 ' + e.score);
    assert.strictEqual(e.label, 'very-weak');
  }
  // 加缀变体：表里的词打头
  const suffixed = evaluate('password2026');
  assert.ok(suffixed.reasons.some(function (r) { return /加缀/.test(r); }), 'password2026 应识别为弱词加缀');
  assert.ok(suffixed.score <= 1, '加缀最多给 1 档，实得 ' + suffixed.score);
  const qwerty = evaluate('Qwerty2026!x');
  assert.ok(qwerty.reasons.some(function (r) { return /加缀/.test(r); }), 'Qwerty2026!x 应识别为弱词加缀');
  assert.ok(qwerty.score <= 1, '实得 ' + qwerty.score);
});

test('纯序列与纯重复识别：大小写与逆序都算', () => {
  const seqReason = function (pw) {
    const e = evaluate(pw);
    return { has: e.reasons.some(function (r) { return /序列/.test(r); }), score: e.score };
  };
  for (const pw of ['abcdefgh', '12345678', 'qwertyui', 'ABCDEF', 'zyxwvuts', '98765432', 'gfedcb']) {
    const r = seqReason(pw);
    assert.ok(r.has, pw + ' 应当被判为纯序列');
    assert.ok(r.score <= 1, pw + ' 序列串最多 1 档，实得 ' + r.score);
  }
  for (const pw of ['aaaaaaaa', 'abababab', 'abcabcabc', '1111', '++++']) {
    const e = evaluate(pw);
    assert.ok(e.reasons.some(function (r) { return /重复/.test(r); }), pw + ' 应当被判为纯重复');
    assert.ok(e.score <= 1, pw + ' 重复串最多 1 档，实得 ' + e.score);
  }
  // 等步长但不在这几张表里（cdef 是 +1 步进；'Aceg' 是 +2 步进，不该算序列）
  assert.ok(evaluate('cdefghij').reasons.some(function (r) { return /序列/.test(r); }), 'cdefghij 是等步长序列');
  assert.ok(!evaluate('Acegikmo').reasons.some(function (r) { return /序列/.test(r); }), '+2 步长不该算序列');
  // 生成的随机长串不该被误判成序列/重复
  for (let i = 0; i < 200; i++) {
    const pw = generate({ length: 20 });
    const e = evaluate(pw);
    assert.ok(!e.reasons.some(function (r) { return /序列|重复|常见弱口令/.test(r); }),
      '随机 20 位被误判：' + pw + ' → ' + e.reasons.join('；'));
    assert.ok(e.score >= 3, '随机 20 位至少该有 3 档，实得 ' + e.score + '：' + pw);
  }
});

test('evaluate 的输入形态：空串、超长、非字符串', () => {
  const empty = evaluate('');
  assert.strictEqual(empty.score, 0);
  assert.strictEqual(empty.label, 'very-weak');
  assert.strictEqual(empty.bits, 0);
  assert.deepStrictEqual(empty.classes, []);
  assert.deepStrictEqual(empty.reasons, ['空口令']);
  // 只出现表外字符（中文、空格、emoji）时也要给出合理池大小，不能算成 0 bit
  const cjk = evaluate('口令要够长才行啊喂');
  assert.strictEqual(cjk.bits, 45.4, '9 个汉字按 log2(33) 保守估计');
  assert.strictEqual(cjk.score, 1);
  // 长度够长就该跨过 60 bit 拿到 2 档，说明「够长」这条通道对非拉丁字符同样有效
  assert.strictEqual(evaluate('口令口令要够长才行啊喂哈哈').score, 2);
  assert.throws(() => evaluate(null), TypeError);
  assert.throws(() => evaluate(12345), TypeError);
  assert.throws(() => evaluate(undefined), TypeError);
  assert.throws(() => evaluate(['a']), TypeError);
});

test('evaluate 是纯函数：同一输入两次结果完全一致', () => {
  const pw = 'Ab3!xYz9?';
  assert.deepStrictEqual(evaluate(pw), evaluate(pw));
  assert.deepStrictEqual(evaluate('password'), evaluate('password'));
});

/* ---------- 域名归一化与子域回退 ---------- */

test('normalizeDomain 把 URL、端口、大写、尾点、www 都剥成裸域名', () => {
  assert.strictEqual(normalizeDomain('HTTPS://WWW.Apple.COM:443/account/manage'), 'apple.com');
  assert.strictEqual(normalizeDomain('apple.com.'), 'apple.com');
  assert.strictEqual(normalizeDomain('  apple.com  '), 'apple.com');
  assert.strictEqual(normalizeDomain('https://apple.com'), 'apple.com');
  assert.strictEqual(normalizeDomain('//apple.com/x'), 'apple.com');
  assert.strictEqual(normalizeDomain('id.apple.com'), 'id.apple.com');
  assert.strictEqual(normalizeDomain('localhost'), null);
  assert.strictEqual(normalizeDomain(''), null);
  assert.strictEqual(normalizeDomain('   '), null);
  assert.strictEqual(normalizeDomain(null), null);
  assert.strictEqual(normalizeDomain(42), null);
  assert.strictEqual(normalizeDomain('http://not a url'), null);
  assert.strictEqual(normalizeDomain('apple com'), null);
});

test('rulesForDomain：命中站点给出长度规则与字符类要求', () => {
  const apple = rulesForDomain('apple.com');
  assert.strictEqual(apple.domain, 'apple.com');
  assert.strictEqual(apple.minLength, 8);
  assert.strictEqual(apple.maxLength, 63);
  assert.deepStrictEqual(apple.required, ['lower', 'upper', 'digit']);
  assert.deepStrictEqual(apple.allowed, ['ascii-printable']);
  assert.strictEqual(apple.maxConsecutive, null);
  assert.strictEqual(apple.unrecognized.length, 0);
  assert.strictEqual(apple.raw, 'minlength: 8; maxlength: 63; required: lower; required: upper; required: digit; allowed: ascii-printable;');

  const n163 = rulesForDomain('163.com');
  assert.strictEqual(n163.minLength, 6);
  assert.strictEqual(n163.maxLength, 16);
  assert.deepStrictEqual(n163.required, []);

  const ms = rulesForDomain('microsoft.com');
  assert.strictEqual(ms.minLength, 8);
  assert.strictEqual(ms.maxLength, null, '微软这条只给下限，不许替它编一个上限');
  assert.deepStrictEqual(ms.required, ['lower', 'upper', 'digit', 'special']);

  const g = rulesForDomain('google.com');
  assert.strictEqual(g.minLength, 8);
  assert.strictEqual(g.maxLength, null);
  assert.deepStrictEqual(g.allowed, ['lower', 'upper', 'digit'], 'allowed 的逗号列表必须逐个读出来');
});

test('子域逐层回退到注册域，并报告命中的到底是哪个键', () => {
  for (const host of ['apple.com', 'id.apple.com', 'account.apple.com', 'a.b.apple.com', 'x.y.z.apple.com']) {
    const r = rulesForDomain(host);
    assert.ok(r, host + ' 应当命中');
    assert.strictEqual(r.domain, 'apple.com');
    assert.strictEqual(r.requested, normalizeDomain(host));
    assert.strictEqual(r.minLength, 8);
    assert.strictEqual(r.maxLength, 63);
    const u = changePasswordUrlFor(host);
    assert.strictEqual(u.domain, 'apple.com');
    assert.strictEqual(u.url, 'https://appleid.apple.com/account/manage');
  }
});

test('多级后缀（com.my / gov.uk）的站点同样能命中与回退', () => {
  const my = rulesForDomain('maybank2u.com.my');
  assert.strictEqual(my.minLength, 8);
  assert.strictEqual(my.maxLength, 12);
  assert.strictEqual(my.maxConsecutive, 2);
  const sub = rulesForDomain('klms.online.maybank2u.com.my');
  assert.strictEqual(sub.domain, 'maybank2u.com.my', '必须回退到表里真实存在的键');
  assert.strictEqual(sub.maxLength, 12);

  const uk = rulesForDomain('access.service.gov.uk');
  assert.strictEqual(uk.minLength, 10);
  assert.deepStrictEqual(uk.required, ['lower', 'upper', 'digit', 'special']);
  const ukSub = rulesForDomain('www.access.service.gov.uk');
  assert.strictEqual(ukSub.domain, 'access.service.gov.uk');
});

test('更具体的键优先：长键命中后再也不回退去套短键的规则', () => {
  // www. 前缀要被丢掉，但 access.service.gov.uk 这种"整串就是键"的情况必须原样命中自己
  assert.strictEqual(rulesForDomain('access.service.gov.uk').domain, 'access.service.gov.uk');
  assert.strictEqual(rulesForDomain('zzz.access.service.gov.uk').domain, 'access.service.gov.uk');
  assert.strictEqual(rulesForDomain('service.gov.uk'), null,
    '表里没有 service.gov.uk 这个键，绝不能退到 gov.uk 再猜一套默认长度');
});

test('查不到就返回 null：不猜、不给默认值、不抛错', () => {
  for (const d of ['github.com', 'qq.com', 'aegis-lens.local', 'notapple.com', 'apple.como', 'apple']) {
    assert.strictEqual(rulesForDomain(d), null, d + ' 不该有规则');
    assert.strictEqual(changePasswordUrlFor(d), null, d + ' 不该有改密链');
  }
  assert.strictEqual(rulesForDomain(null), null);
  assert.strictEqual(rulesForDomain(''), null);
  assert.strictEqual(rulesForDomain('localhost'), null);
  assert.strictEqual(changePasswordUrlFor(null), null);
  assert.strictEqual(changePasswordUrlFor(''), null);
});

test('后缀伪装拿不到别人的规则：回退只按标签边界，不按子串', () => {
  // notgithub.com 里确实"含有" github.com，但它不是 github.com 的子域，绝不能套 github 的规则
  assert.strictEqual(rulesForDomain('notgithub.com'), null);
  assert.strictEqual(changePasswordUrlFor('notgithub.com'), null);
  assert.strictEqual(rulesForDomain('mydropbox.com'), null);
  // 这是钓鱼域名的标准构造：真域名为前缀 + 自己的后缀。逐层砍左边标签，永远砍不到 apple.com
  assert.strictEqual(rulesForDomain('apple.com.evil.test'), null);
  assert.strictEqual(changePasswordUrlFor('apple.com.evil.test'), null);
  assert.strictEqual(rulesForDomain('apple.com.attacker.cn'), null);
  assert.strictEqual(rulesForDomain('google.com.ph'), null, 'google.com.ph 是菲律宾的另一个域名，不是 google.com 的子域');
  // 真子域才该命中
  assert.strictEqual(rulesForDomain('id.apple.com').domain, 'apple.com');
});

test('changePasswordUrlFor：命中返回绝对 URL，未命中返回 null', () => {
  const apple = changePasswordUrlFor('apple.com');
  assert.strictEqual(apple.url, 'https://appleid.apple.com/account/manage');
  assert.strictEqual(apple.requested, 'apple.com');
  assert.strictEqual(changePasswordUrlFor('id.apple.com').url, 'https://appleid.apple.com/account/manage');
  const g = changePasswordUrlFor('https://accounts.google.com/signin');
  assert.strictEqual(g.domain, 'google.com');
  assert.match(g.url, /^https:\/\//);
  // 有长度规则但没有改密页的站点：url 必须是 null，规则照旧可查
  assert.strictEqual(changePasswordUrlFor('163.com'), null);
  assert.ok(rulesForDomain('163.com') !== null);
});

/* ---------- 规则串解析：Apple 数据里的分号坑 ---------- */

test('splitRuleSegments：括号内的分号不断句', () => {
  const segs = splitRuleSegments('minlength: 6; allowed: [!@;#]; required: lower;');
  assert.deepStrictEqual(segs, ['minlength: 6', 'allowed: [!@;#]', 'required: lower']);
  assert.deepStrictEqual(splitRuleSegments('a: 1;b: 2;c: 3;'), ['a: 1', 'b: 2', 'c: 3']);
  assert.deepStrictEqual(splitRuleSegments(''), []);
});

test('字符集自带分号的规则条目：数值字段一个都不许丢', () => {
  // bochk.com: "…allowed: [#$%&()*+,.:;<=>?@_];" —— 字符集里真有分号
  const bochk = rulesForDomain('bochk.com');
  assert.strictEqual(bochk.minLength, 8);
  assert.strictEqual(bochk.maxLength, 12);
  assert.strictEqual(bochk.maxConsecutive, 3);
  assert.deepStrictEqual(bochk.required, ['lower', 'upper', 'digit']);
  assert.ok(bochk.allowedCharset && bochk.allowedCharset.indexOf('<=>?@_') >= 0,
    'allowed 字符集必须整段留全，实得：' + bochk.allowedCharset);
  assert.strictEqual(bochk.unrecognized.length, 0);

  // maybank2u.com.my 上游少写了一个 ]（括号不配对），解析必须降级而不吞掉前面的数值字段
  const mb = rulesForDomain('maybank2u.com.my');
  assert.strictEqual(mb.minLength, 8);
  assert.strictEqual(mb.maxLength, 12);
  assert.strictEqual(mb.maxConsecutive, 2);
  assert.deepStrictEqual(mb.required, ['lower', 'upper', 'digit']);
  assert.ok(mb.requiredCharset, '不配对的字符集也要原样保留给上层展示');

  // ebrap.org: 只有 minlength 15 + 一串 required 字符集
  const ebrap = rulesForDomain('ebrap.org');
  assert.strictEqual(ebrap.minLength, 15);
  assert.strictEqual(ebrap.maxLength, null);
  assert.deepStrictEqual(ebrap.required, ['lower', 'upper', 'digit']);
});

test('同一字段重复出现时按更严的方向合并（min 取大、max 与 max-consecutive 取小）', () => {
  // 上游真有这么写的（ebrap.org 把 required: lower 写了两遍），合并方向必须偏保守
  const { parsePasswordRules } = require('../src/passgen');
  const merged = parsePasswordRules(
    'minlength: 6; maxlength: 16; maxlength: 20; minlength: 8;'
    + ' max-consecutive: 4; max-consecutive: 2; required: lower; required: lower; required: digit;'
  );
  assert.strictEqual(merged.minLength, 8, '两个下限取更严的那个');
  assert.strictEqual(merged.maxLength, 16, '两个上限取更严的那个');
  assert.strictEqual(merged.maxConsecutive, 2, '连字上限取更严的那个');
  assert.deepStrictEqual(merged.required, ['lower', 'digit'], '重复类别要去重但别丢');
  assert.strictEqual(merged.unrecognized.length, 0);

  // 认不出的字段名原样留在 unrecognized，不猜、不静默丢
  const odd = parsePasswordRules('weird-token: 5; minlength: 4;');
  assert.strictEqual(odd.minLength, 4);
  assert.deepStrictEqual(odd.unrecognized, ['weird-token: 5']);
  // 空规则串与纯字符集都要给出结构完整的对象
  const nothing = parsePasswordRules('');
  assert.strictEqual(nothing.minLength, null);
  assert.strictEqual(nothing.maxLength, null);
  assert.deepStrictEqual(nothing.required, []);
  assert.strictEqual(nothing.raw, '');
  // 上游真实数据里重复出现的 minlength 走的是同一条合并路径
  const ebrap = rulesForDomain('ebrap.org');
  assert.strictEqual(ebrap.minLength, 15);
  assert.deepStrictEqual(ebrap.required, ['lower', 'upper', 'digit']);
});

test('全部 436 条规则都解析得动：数值字段零丢失、无无法归类的碎片', () => {
  const R = JSON.parse(fs.readFileSync(RULES_JSON, 'utf8'));
  const keys = Object.keys(R);
  assert.ok(keys.length >= 436, '规则条目数低于预期：' + keys.length);
  let lostMin = 0, lostMax = 0, lostCons = 0, lostReq = 0, fragments = 0;
  for (const k of keys) {
    const raw = R[k]['password-rules'];
    const r = rulesForDomain(k);
    assert.ok(r, k + ' 应当能查到自己的规则');
    if (r.unrecognized.length) fragments++;
    if (/minlength:/.test(raw) && r.minLength === null) lostMin++;
    if (/maxlength:/.test(raw) && r.maxLength === null) lostMax++;
    if (/max-consecutive:/.test(raw) && r.maxConsecutive === null) lostCons++;
    if (/required:\s*(lower|upper|digit|special)\b/.test(raw) && r.required.length === 0) lostReq++;
  }
  assert.strictEqual(fragments, 0, '有 ' + fragments + ' 条出现无法归类的碎片');
  assert.strictEqual(lostMin, 0, '有 ' + lostMin + ' 条 minlength 解析后丢失');
  assert.strictEqual(lostMax, 0, '有 ' + lostMax + ' 条 maxlength 解析后丢失');
  assert.strictEqual(lostCons, 0, '有 ' + lostCons + ' 条 max-consecutive 解析后丢失');
  assert.strictEqual(lostReq, 0, '有 ' + lostReq + ' 条 required 类别解析后丢失');
  // 长度规则自洽：有下限也有上限时，下限不得大于上限
  let inverted = 0;
  for (const k of keys) {
    const r = rulesForDomain(k);
    if (r.minLength !== null && r.maxLength !== null && r.minLength > r.maxLength) inverted++;
  }
  assert.strictEqual(inverted, 0, '上游有 ' + inverted + ' 条 min>max 的倒挂规则，消费方需另行处理');
});

/* ---------- 随仓资产：许可证与数据形态（沿用 vendor.test.js 的把关路子） ---------- */

test('两份 Apple JSON 在位、可解析、条目数与体积达标', () => {
  const rules = fs.readFileSync(RULES_JSON);
  const urls = fs.readFileSync(URLS_JSON);
  assert.ok(rules.length > 60000, 'password-rules.json 体积异常：' + rules.length);
  assert.ok(urls.length > 40000, 'change-password-URLs.json 体积异常：' + urls.length);
  const R = JSON.parse(rules.toString('utf8'));
  const U = JSON.parse(urls.toString('utf8'));
  assert.ok(Object.keys(R).length >= 436, '规则条目数：' + Object.keys(R).length);
  assert.ok(Object.keys(U).length >= 652, '改密链条目数：' + Object.keys(U).length);
  // 两份都是纯域名键的扁平对象，且键已归一（小写、无协议、无 www）
  for (const [name, table] of [['rules', R], ['urls', U]]) {
    for (const k of Object.keys(table)) {
      assert.strictEqual(k, k.toLowerCase(), name + ' 键不该有大写：' + k);
      assert.ok(!k.startsWith('www.'), name + ' 键不该带 www 前缀：' + k);
      assert.ok(/^[a-z0-9._-]+$/.test(k), name + ' 键形态异常：' + k);
      assert.ok(k.indexOf('.') > 0, name + ' 键至少得有一个点：' + k);
    }
  }
  // 裸公后缀不许当键——否则子域回退会把整片 .co.uk 都套上同一套规则
  for (const suffix of ['co.uk', 'com.my', 'com.br', 'co.kr', 'net.au', 'gov.uk', 'com', 'org', 'jp']) {
    assert.ok(!(suffix in R), 'password-rules.json 里出现了裸后缀键 ' + suffix);
    assert.ok(!(suffix in U), 'change-password-URLs.json 里出现了裸后缀键 ' + suffix);
  }
});

test('数据形态：规则值是单键对象，改密链是 http(s) 绝对地址', () => {
  const R = JSON.parse(fs.readFileSync(RULES_JSON, 'utf8'));
  const U = JSON.parse(fs.readFileSync(URLS_JSON, 'utf8'));
  for (const k of Object.keys(R)) {
    const v = R[k];
    assert.strictEqual(typeof v, 'object', k + ' 的值不该是标量');
    assert.deepStrictEqual(Object.keys(v), ['password-rules'], k + ' 应当只有 password-rules 一个键');
    assert.strictEqual(typeof v['password-rules'], 'string', k);
    assert.ok(/^(minlength|maxlength|required|allowed|max-consecutive)/.test(v['password-rules'].trim()),
      k + ' 规则串开头不认识：' + v['password-rules'].slice(0, 40));
    assert.strictEqual(rulesForDomain(k).raw, v['password-rules'], k + ' 的 raw 必须原样透传');
  }
  for (const k of Object.keys(U)) {
    assert.strictEqual(typeof U[k], 'string', k + ' 的值必须是 URL 字符串');
    assert.match(U[k], /^https?:\/\//, k + ' 不是 http(s) 绝对地址：' + U[k]);
    assert.ok(U[k] === U[k].trim(), k + ' 的 URL 两端不该有空白');
  }
});

test('MIT 许可证随仓落盘，正文、版权行与来源说明齐备', () => {
  const text = fs.readFileSync(LICENSE_MD, 'utf8');
  assert.ok(/MIT License/.test(text), '缺 MIT 许可证标题');
  assert.ok(/Permission is hereby granted, free of charge/.test(text), '缺 MIT 正文');
  assert.ok(/THE SOFTWARE IS PROVIDED "AS IS"/.test(text), '缺免责条款');
  assert.ok(/Copyright 2020 - 2026 Apple Inc\./.test(text), '缺上游版权行');
  assert.ok(/github\.com\/apple\/password-manager-resources/.test(text), '缺来源仓库说明');
  assert.ok(text.includes('password-rules.json'), '许可证说明必须点明覆盖哪两份数据');
  assert.ok(text.includes('change-password-URLs.json'), '许可证说明必须点明覆盖哪两份数据');
  // 说明里登记的条数与体积要和盘上对得上，否则下次升级就是悄悄改数据。
  // 字节数按 LF 归一后再比：这台机器 core.autocrlf=true，另一台检出可能是 CRLF，
  // 直接比原始字节数会让同一份数据在两台机器上得到不同结论。
  const lfLength = function (buf) { return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8').length; };
  const withCommas = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  const docMentions = function (n) { return text.includes(String(n)) || text.includes(withCommas(n)); };
  const rules = fs.readFileSync(RULES_JSON);
  const urls = fs.readFileSync(URLS_JSON);
  const rulesLf = lfLength(rules);
  const urlsLf = lfLength(urls);
  assert.ok(docMentions(rulesLf), '说明登记的规则表字节数与盘上不符：实际 LF ' + rulesLf + ' 字节，需要同步更新说明');
  assert.ok(docMentions(urlsLf), '说明登记的改密链字节数与盘上不符：实际 LF ' + urlsLf + ' 字节，需要同步更新说明');
  const rulesCount = Object.keys(JSON.parse(rules.toString('utf8'))).length;
  const urlsCount = Object.keys(JSON.parse(urls.toString('utf8'))).length;
  assert.ok(docMentions(rulesCount), '说明里缺规则条数：' + rulesCount);
  assert.ok(docMentions(urlsCount), '说明里缺改密链条数：' + urlsCount);
  // 本轮交付的基准值，改动即视为换了一批数据，需要显式确认
  assert.strictEqual(rulesCount, 436);
  assert.strictEqual(urlsCount, 652);
});

test('随仓数据与许可证都不许被 HTTP 取走：它们不在静态根里', async () => {
  const publicDir = path.join(__dirname, '..', 'public');
  for (const f of [RULES_JSON, URLS_JSON, LICENSE_MD]) {
    const rel = path.relative(path.resolve(publicDir), path.resolve(f));
    assert.ok(rel.startsWith('..'), f + ' 被放进了静态根，会变成任意文件读取口');
  }
  const { createApp } = require('../src/app');
  const { loadOrCreateMasterKey } = require('../src/crypto');
  const { createStore } = require('../src/storage');
  // 用临时目录，绝不碰 ~/.api-aegislens 里的真实 keys.db / master.key
  const dir = tmp.mk('akm-passgen');
  const storage = createStore(dir, loadOrCreateMasterKey(dir), { backend: 'json' });
  const server = createApp({ storage, fetchImpl: async () => new Response('{}'), publicDir, version: 'test' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const p of ['/password-rules.json', '/change-password-URLs.json',
      '/LICENSE-apple-password-rules.md', '/src/passgen.js', '/vendor/../src/passgen.js']) {
      const res = await fetch(base + p);
      const body = await res.text();
      assert.strictEqual(res.status, 404, p + ' 竟然可达');
      assert.ok(!body.includes('minlength'), p + ' 泄漏了规则数据');
    }
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
