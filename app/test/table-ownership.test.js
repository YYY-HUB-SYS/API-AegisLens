/* 表归属守卫：守住 `app/src/DATA-CONTRACT.md` 里定的规矩。
 *
 * 起因：用户构想的五条线都要往 Key 表加字段。不先定 owner，
 * 最后必然出现两张互相冲突的 Key 表（两张表各自加列、两个后端分叉、字段来源约束没法表达）。
 *
 * 这条测试守四件事：
 * ① 全部建表语句只能在 storage.js 里；
 * ② 别的模块不许直接写 SQL（要改数据就调 storage 的方法）；
 * ③ MODEL_EXTRA 与 model-fields-persist 的 FIELDS 两张白名单必须一一对应
 *    （漏一个 ⇒ SQLite 后端静默丢字段，而界面显示成「未知」）；
 * ④ MODEL_EXTRA 里的字段必须在界面上有出口（加了没人读就是负债）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const PUBLIC = path.join(__dirname, '..', 'public');

function readSrc(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}
function readPublic(rel) {
  return fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
}
function listJs(dir) {
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js'); });
}

test('全部建表语句只能在 storage.js 里（别处建表 = 第二张 Key 表的开端）', () => {
  const storage = readSrc('storage.js');
  const tables = new Set();
  for (const m of storage.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) tables.add(m[1]);
  assert.ok(tables.has('keys'), 'keys 表必须存在');
  assert.ok(tables.has('models'), 'models 表必须存在');
  assert.ok(tables.has('tokens'), 'tokens 表必须存在');
  assert.ok(tables.has('credentials'), 'credentials 表必须存在');
  assert.ok(tables.has('history'), 'history 表必须存在');
  assert.ok(tables.has('pools'), 'pools 表必须存在');
  assert.ok(tables.has('pool_keys'), 'pool_keys 表必须存在');
  assert.ok(tables.has('assigned'), 'assigned 表必须存在');

  for (const f of listJs(SRC)) {
    if (f === 'storage.js') continue;
    const src = readSrc(f);
    const hits = src.match(/CREATE\s+TABLE/gi);
    assert.strictEqual(hits, null,
      f + ' 里出现了建表语句：表只能由 storage.js 建（见 DATA-CONTRACT.md）');
  }
});

test('别的模块不许直接写 SQL（要改数据就调 storage 的方法）', () => {
  const patterns = [
    /INSERT\s+INTO/gi,
    /DELETE\s+FROM/gi,
    /UPDATE\s+\w+\s+SET/gi
  ];
  for (const f of listJs(SRC)) {
    if (f === 'storage.js') continue;
    const src = readSrc(f);
    for (const p of patterns) {
      const hits = src.match(p);
      assert.strictEqual(hits, null,
        f + ' 里出现了直接写 SQL 的语句：数据只能经 storage.js 的方法改');
    }
  }
});

test('MODEL_EXTRA 与 model-fields-persist 的 FIELDS 两张白名单必须一一对应', () => {
  const storage = readSrc('storage.js');
  const m = storage.match(/const MODEL_EXTRA = \[([\s\S]*?)\];/);
  assert.ok(m, 'storage.js 里找不到 MODEL_EXTRA 白名单');
  const extra = Array.from(m[1].matchAll(/'([a-zA-Z]+)'/g)).map(function (x) { return x[1]; });
  assert.ok(extra.length >= 7, 'MODEL_EXTRA 至少要有 7 个字段，实得 ' + extra.length);

  const persist = fs.readFileSync(path.join(__dirname, 'model-fields-persist.test.js'), 'utf8');
  const fm = persist.match(/const FIELDS = \{([\s\S]*?)\n\};/);
  assert.ok(fm, 'model-fields-persist.test.js 里找不到 FIELDS');
  const fields = Array.from(fm[1].matchAll(/([a-zA-Z]+):/g)).map(function (x) { return x[1]; });

  /* models 表的基础列在 SQLite 里是真列（不在 extra 里），所以 FIELDS 比 MODEL_EXTRA 多几个是正常的。
     基础列清单从 storage.js 的建表语句里读出来，别手写——手写会跟实际漂移。
     建表语句是**字符串数组拼接**的形式。⚠ 别用 /'([^']*)'/g 去切：
     片段里有转义引号（src 的 DEFAULT \'meta\'），单引号正则会把转义当边界，切出一堆碎片。
     改用「每行取第一个引号里的内容」——一行一个片段，转义引号在同一行内不影响。 */
  const start = storage.indexOf('CREATE TABLE IF NOT EXISTS models');
  assert.ok(start > -1, 'storage.js 里找不到 models 的建表语句');
  const end = storage.indexOf('CREATE TABLE IF NOT EXISTS', start + 10);
  const block = storage.slice(start, end > -1 ? end : start + 1200);
  const baseCols = [];
  for (const line of block.split(/\r?\n/)) {
    const lm = line.match(/'([^']*)'/);
    if (!lm) continue;
    const cm = lm[1].match(/^\s*(\w+)\s+(?:TEXT|INTEGER|REAL)\b/);
    if (cm) baseCols.push(cm[1]);
  }
  assert.ok(baseCols.length >= 5, 'models 基础列没解析出来：' + baseCols.join('、'));

  /* 两个方向都要查：MODEL_EXTRA 有而 FIELDS 没有 ⇒ 那个字段没被往返测试覆盖；
     FIELDS 有而 MODEL_EXTRA 没有 ⇒ 那个字段在 SQLite 后端会被静默丢掉。 */
  const missingInFields = extra.filter(function (f) { return fields.indexOf(f) === -1; });
  const missingInExtra = fields.filter(function (f) {
    if (baseCols.indexOf(f) !== -1) return false;
    return extra.indexOf(f) === -1;
  });
  assert.deepStrictEqual(missingInFields, [],
    'MODEL_EXTRA 里的这些字段没在 model-fields-persist 的 FIELDS 里登记：' + missingInFields.join('、')
    + '（漏登记 = 那个字段没被往返测试覆盖）');
  assert.deepStrictEqual(missingInExtra, [],
    'model-fields-persist 的 FIELDS 里这些字段既不在 MODEL_EXTRA 白名单、也不是 models 的基础列：'
    + missingInExtra.join('、')
    + '（不在白名单 = SQLite 后端会静默丢掉它）');
});

test('MODEL_EXTRA 里的字段必须在界面上有出口（加了没人读就是负债）', () => {
  const storage = readSrc('storage.js');
  const m = storage.match(/const MODEL_EXTRA = \[([\s\S]*?)\];/);
  const extra = Array.from(m[1].matchAll(/'([a-zA-Z]+)'/g)).map(function (x) { return x[1]; });

  /* 界面的渲染原子分散在几个文件里：index.html 有 capChips / srcChips，
     layout-shared.js 有 detailOf 一类的渲染。全部拼起来找。 */
  const frontend = [
    readPublic('index.html'),
    readPublic(path.join('app', 'layout-shared.js')),
    readPublic(path.join('app', 'layout-main.js')),
    readPublic('credentials-view.js'),
    readPublic('consumer-view.js')
  ].join('\n');

  const orphans = extra.filter(function (f) {
    /* src 字段（ctxSrc/outSrc）由 srcChips 统一处理，这里单独放行；
       其余字段必须在界面代码里被读到。 */
    if (f === 'ctxSrc' || f === 'outSrc') return false;
    return frontend.indexOf('.' + f) === -1 && frontend.indexOf("'" + f + "'") === -1;
  });
  assert.deepStrictEqual(orphans, [],
    'MODEL_EXTRA 里这些字段界面上读不到（存了没人看）：' + orphans.join('、'));
});

test('契约文件本身在（DATA-CONTRACT.md），别被删了', () => {
  const p = path.join(SRC, 'DATA-CONTRACT.md');
  assert.ok(fs.existsSync(p), 'app/src/DATA-CONTRACT.md 不见了——表归属的约定不能丢');
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.indexOf('storage.js') > -1, '契约里要点明唯一 owner 是 storage.js');
});
