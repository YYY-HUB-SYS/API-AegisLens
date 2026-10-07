/* 通用形状提取器回归：夹具是十一家平台 2026-10-07 的真实 /v1/models 响应体，
   逐字节未清洗。断言的是"平台确实报了什么"，不是"代码恰好读到什么"。
   背景见同目录 fixtures/model-responses/FINDINGS.md */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/model-shape.js');

const DIR = path.join(__dirname, 'fixtures', 'model-responses');

function body(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
}
function items(name) {
  return S.modelList(body(name));
}
function byId(name, id) {
  return items(name).find(function (x) { return S.modelId(x) === id; });
}

/* 平台真实提供了 ctx / out 的条数，是这次实测出来的分母，不是猜的 */
const EXPECT = [
  ['sensenova-models.json', 9, 9],
  ['unisound-models.json', 22, 21],   /* u2-med 的 max_output 真是 null */
  ['agnes-models.json', 0, 0],        /* 本就不提供 */
  ['intern-models.json', 10, 10],     /* 两层嵌套 {value,unit} */
  ['longcat-models.json', 2, 2],
  ['amd-radeon-models.json', 8, 0],   /* MinerU2.5-Pro 用 context_length:0 表示未设 */
  ['antling-models.json', 0, 0],
  ['diandian-dots-models.json', 0, 0],
  ['atria-models.json', 0, 0],
  ['modelscope-models.json', 0, 0]
];

test('十一家真实响应体：提取器对平台确实提供的字段零漏取', () => {
  let ctx = 0, out = 0;
  EXPECT.forEach(function (e) {
    const list = items(e[0]);
    const got = list.map(S.extractLimits);
    const c = got.filter(function (r) { return r.ctx !== null; }).length;
    const o = got.filter(function (r) { return r.out !== null; }).length;
    assert.strictEqual(c, e[1], e[0] + ' 的 ctx 命中数应等于平台真实提供数');
    assert.strictEqual(o, e[2], e[0] + ' 的 out 命中数应等于平台真实提供数');
    ctx += c; out += o;
  });
  assert.strictEqual(ctx, 51, '合计 ctx 可用 51 条');
  assert.strictEqual(out, 42, '合计 out 可用 42 条');
});

test('值逐条正确：三种命名与一层嵌套都能取到真值', () => {
  assert.deepStrictEqual(
    pick(S.extractLimits(byId('unisound-models.json', 'glm-5.3'))), [1048576, 131072],
    '云知声 context_window / max_output');
  assert.deepStrictEqual(
    pick(S.extractLimits(byId('longcat-models.json', 'LongCat-2.0'))), [1048576, 131072],
    'LongCat 的 max_output_tokens 是全新命名');
  assert.deepStrictEqual(
    pick(S.extractLimits(byId('intern-models.json', 'glm-5.3'))), [1048576, 1048576],
    'intern 嵌套两层 {value,unit}');
  assert.deepStrictEqual(
    pick(S.extractLimits(byId('sensenova-models.json', 'sensenova-6.8-flash-lite'))), [262144, 65536],
    'SenseNova 扁平 snake_case');
});

function pick(r) { return [r.ctx, r.out]; }

test('速率不是上下文：intern 的 50 亿 TPM 绝不能被当成窗口', () => {
  const r = S.extractLimits(byId('intern-models.json', 'Agents-A1'));
  assert.strictEqual(r.ctx, 262144);
  assert.ok(r.ctx < 1e8, '上下文不可能上亿');
});

test('context_length: 0 表示未设，不是有效值', () => {
  const r = S.extractLimits(byId('amd-radeon-models.json', 'MinerU2.5-Pro'));
  assert.strictEqual(r.ctx, null, 'AMD 用 0 表达"未设置"');
});

test('单位护栏：{value:262, unit:"K"} 必须拒绝而不是写进 262', () => {
  /* 原型脚本在这里翻过车：递归先下钻进包装层，unit 在到达 unwrap 前就丢了，
     结果把 262 当 token 数存库，1000 倍低估。现在遇到数值包装不下钻。 */
  const r = S.extractLimits({ id: 'x', context_length: { value: 262, unit: 'K' } });
  assert.strictEqual(r.ctx, null);
  const ok = S.extractLimits({ id: 'x', context_length: { value: 262144, unit: 'token' } });
  assert.strictEqual(ok.ctx, 262144);
});

test('字符串数字要能过（AMD 的 pricing 就是科学计数法字符串）', () => {
  const r = S.extractLimits({ id: 'x', context_length: '262144', max_output_length: '65536' });
  assert.deepStrictEqual(pick(r), [262144, 65536]);
});

test('平台自相矛盾时打标记，但不替换值', () => {
  /* 云知声说 MiniMax-M3 窗口 524288、输出上限 1048576 —— 输出比整个窗口还大 */
  const r = S.extractLimits(byId('unisound-models.json', 'MiniMax-M3'));
  assert.strictEqual(r.ctx, 524288, '照实保留平台值，不拿别家的数盖掉');
  assert.strictEqual(r.out, 1048576);
  assert.strictEqual(r.outGtCtx, true);
});

test('来源按字段记，不再整条谎标 api', () => {
  const none = S.extractLimits(byId('agnes-models.json', 'agnes-2.5-pro'));
  assert.strictEqual(none.ctxSrc, null, '平台没给就不该标 api');
  assert.strictEqual(none.outSrc, null);
  assert.strictEqual(none.ctx, null);
  const some = S.extractLimits(byId('unisound-models.json', 'u2-med'));
  assert.strictEqual(some.ctxSrc, 'api');
  assert.strictEqual(some.outSrc, null, 'ctx 有 out 没有，两个字段来源各自独立');
});

test('能力位：reasoning 三种形态、模态脏值过滤、rpm 逐条不同', () => {
  const amd = S.extractCaps(byId('amd-radeon-models.json', 'DeepSeek-V4.1-Flash'));
  assert.strictEqual(amd.reasoning, true, 'providers[].reasoning 布尔形态');
  assert.deepStrictEqual(amd.modalitiesIn.sort(), ['image', 'text']);
  const amdNo = S.extractCaps(byId('amd-radeon-models.json', 'MinerU2.5-Pro'));
  assert.strictEqual(amdNo.reasoning, false, '同一字段在同一家内逐条不同，不是套壳常量');

  const it = S.extractCaps(byId('intern-models.json', 'Agents-A1'));
  assert.strictEqual(it.reasoning, null, 'intern 用"键存在性"表达，Agents-A1 无 reasoning 键');
  assert.strictEqual(it.rpm, 2640, 'RPM 只有官方通道给，公开目录一概不带');
  const itR = S.extractCaps(byId('intern-models.json', 'deepseek-v4-flash-0731'));
  assert.strictEqual(itR.reasoning, true);
  assert.deepStrictEqual(itR.modalitiesIn, ['text'],
    '实测该条枚举里混了中文 "文本"，按已知值过滤后只剩 text');
});

test('结构兜底：顶层键非 data、以及只有 name 没有 id 的端点不再静默丢模型', () => {
  assert.deepStrictEqual(S.modelList({ models: [{ id: 'a' }] }).map(function (x) { return x.id; }), ['a']);
  assert.deepStrictEqual(S.modelList([{ id: 'b' }]).map(function (x) { return x.id; }), ['b']);
  assert.deepStrictEqual(S.modelList({ data: [{ id: 'c' }] }).map(function (x) { return x.id; }), ['c']);
  assert.strictEqual(S.modelList(null).length, 0);
  assert.strictEqual(S.modelId({ name: 'solo-7b' }), 'solo-7b');
  assert.strictEqual(S.modelId({ display_name: 'Solo' }), 'Solo');
  assert.strictEqual(S.modelId({ id: 'x', name: 'y' }), 'x', 'id 优先');
});

test('OpenRouter 样本：默认 UA 那份带 context_length，工具 UA 那份一条都没有', () => {
  const full = items('openrouter-defaultua-sample.json');
  assert.ok(full.length >= 1);
  assert.ok(S.extractLimits(full[0]).ctx !== null, '默认 UA 的响应带 context_length');
  const stub = items('openrouter-toolua-stub.json');
  assert.strictEqual(stub.length, 10, '工具 UA 下退化成 10 条');
  assert.strictEqual(stub.filter(function (x) { return S.extractLimits(x).ctx !== null; }).length, 0,
    '且 10 条全无上下文 —— 这就是 §5b 那个 UA 分叉缺陷的证据');
});
