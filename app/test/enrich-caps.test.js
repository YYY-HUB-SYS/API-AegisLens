/* 第四级联网检索（models.dev）带回来的四个能力位。
 *
 * 背景：models.dev 是按模型名跨平台查的静态能力库（实测 api.json：232 个 provider、
 * 9081 个模型），每条模型带 attachment / reasoning / tool_call 三个布尔位，
 * 外加 modalities 的输入输出模态。这些值是**参考值**（按模型名查表，
 * 不等于这个端点的实测能力），来源要标 'web'，不能跟内置表（'meta'）混。
 *
 * 三条硬规矩：
 *   ① false 是「不支持」，不是「没这个字段」——界面必须能区分这两者；
 *   ② 平台自己报过的能力位以平台为准，联网只填空；
 *   ③ 模态数组存进库前先剔掉 text（纯文本是默认，不必每行都喊一遍）。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const enrich = require('../src/enrich');
const tmp = require('./tmp.js');
const { createStore } = require('../src/storage');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');

function res(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200 });
}

/* models.dev 的一条真实形状：字段名与实测 api.json 一致（tool_call 是下划线） */
const MD_MODEL = {
  attachment: true,
  reasoning: true,
  tool_call: false,
  modalities: { input: ['text', 'image', 'pdf'], output: ['text', 'image'] },
  limit: { context: 400000, output: 128000 }
};

/* 只让 models.dev 有响应，OpenRouter 一律 404 */
function mdFetch(models) {
  return function (url) {
    if (String(url).includes('models.dev')) {
      return Promise.resolve(res({ acme: { models: models } }));
    }
    return Promise.resolve(res({}, 404));
  };
}

/* ================= 取值：四个字段都要到手 ================= */

test('models.dev：四个能力位都取到，来源标 web（不是 meta）', async () => {
  enrich.resetCache();
  const r = await enrich.lookupOnline(['acme-model-x'], {
    fetchImpl: mdFetch({ 'acme-model-x': MD_MODEL })
  });
  const hit = r.found['acme-model-x'];
  assert.ok(hit, '应命中 models.dev');
  /* 数值参数照旧（id 前缀 provider/model 是既有约定，别动） */
  assert.strictEqual(hit.ctx, 400000);
  assert.strictEqual(hit.out, 128000);
  assert.strictEqual(hit.ctxFrom, 'modelsdev');
  assert.strictEqual(hit.ctxKind, 'web');
  /* 四个能力位 */
  assert.strictEqual(hit.reasoning, true);
  assert.strictEqual(hit.attachment, true);
  assert.strictEqual(hit.toolCall, false, 'tool_call 要转成 toolCall');
  assert.deepStrictEqual(hit.modalitiesIn, ['image', 'pdf'], 'text 是默认，不存冗余值');
  assert.deepStrictEqual(hit.modalitiesOut, ['image'], '输出模态跟输入模态是两回事');
  /* 来源：联网目录是 web，不是内置表的 meta */
  assert.strictEqual(hit.reasoningSrc, 'web');
  assert.strictEqual(hit.modalitiesInSrc, 'web');
  assert.strictEqual(hit.attachmentSrc, 'web');
  assert.strictEqual(hit.toolCallSrc, 'web');
  assert.strictEqual(hit.modalitiesOutSrc, 'web');
  assert.strictEqual(hit.capsFrom, 'modelsdev', '出处要记到具体目录');
});

test('models.dev：内置表命中的模型不许拿到能力位（别跟 meta 混）', async () => {
  enrich.resetCache();
  /* step-1o-turbo-vision 在内置国内模型表里；断网时只能命中内置表，
     内置表不带能力位 ⇒ 一项都不该有，更不该标成 meta。 */
  const f = function () { return Promise.reject(new Error('network down')); };
  const r = await enrich.lookupOnline(['step-1o-turbo-vision'], { fetchImpl: f });
  const hit = r.found['step-1o-turbo-vision'];
  assert.ok(hit, '断网时内置表仍应能命中');
  assert.strictEqual(hit.ctxKind, 'meta');
  assert.strictEqual(hit.attachment, undefined, '内置表没有这项能力位');
  assert.strictEqual(hit.attachmentSrc, undefined, '没有值就没有来源');
});

test('models.dev 与内置表同时命中时，能力位取联网那份（web 优先）', async () => {
  enrich.resetCache();
  /* 同一个模型名在 models.dev 与内置表里都有：联网源在前（PROVIDERS 顺序），
     能力位必须是 models.dev 给的，不能被后面的内置表盖成 meta。 */
  const r = await enrich.lookupOnline(['step-1o-turbo-vision'], {
    fetchImpl: mdFetch({ 'step-1o-turbo-vision': MD_MODEL })
  });
  const hit = r.found['step-1o-turbo-vision'];
  assert.strictEqual(hit.attachment, true);
  assert.strictEqual(hit.attachmentSrc, 'web', '联网目录优先于内置表');
  assert.strictEqual(hit.capsFrom, 'modelsdev');
});

/* ================= 落库：false 是「不支持」，不是「没有」 ================= */

test('applyToModels：能力位落进模型记录，false 照样是 false', () => {
  const models = [{ id: 'acme-model-x', ctx: null, out: null, src: 'unknown', note: null }];
  const found = {
    'acme-model-x': {
      ctx: 400000, out: 128000, ctxKind: 'web', outKind: 'web', ctxFrom: 'modelsdev', outFrom: 'modelsdev',
      reasoning: true, attachment: true, toolCall: false,
      modalitiesIn: ['image'], modalitiesOut: ['image'],
      reasoningSrc: 'web', modalitiesInSrc: 'web', attachmentSrc: 'web',
      toolCallSrc: 'web', modalitiesOutSrc: 'web', capsFrom: 'modelsdev'
    }
  };
  const a = enrich.applyToModels(models, found);
  const m = a.models[0];
  assert.strictEqual(m.reasoning, true);
  assert.strictEqual(m.attachment, true);
  assert.strictEqual(m.toolCall, false, 'false 是「不支持」，不能变成 undefined');
  assert.deepStrictEqual(m.modalitiesIn, ['image']);
  assert.deepStrictEqual(m.modalitiesOut, ['image']);
  assert.strictEqual(m.attachmentSrc, 'web');
  assert.strictEqual(m.toolCallSrc, 'web');
  assert.strictEqual(m.capsFrom, 'modelsdev');
  assert.strictEqual(m.ctxSrc, 'web');
});

test('applyToModels：平台报过的能力位以平台为准，联网只填空', () => {
  /* 平台自己报了 reasoning=false 与 modalitiesIn，models.dev 的说法不许覆盖它 */
  const models = [{
    id: 'acme-model-x', ctx: 1000, out: 100, src: 'api', note: null,
    reasoning: false, modalitiesIn: ['text', 'image']
  }];
  const found = {
    'acme-model-x': {
      ctx: 400000, out: 128000, ctxKind: 'web', outKind: 'web',
      reasoning: true, attachment: true, toolCall: true,
      modalitiesIn: ['video'], modalitiesOut: ['image'],
      reasoningSrc: 'web', modalitiesInSrc: 'web', attachmentSrc: 'web',
      toolCallSrc: 'web', modalitiesOutSrc: 'web', capsFrom: 'modelsdev'
    }
  };
  const a = enrich.applyToModels(models, found);
  const m = a.models[0];
  assert.strictEqual(m.reasoning, false, '平台报过的以平台为准');
  assert.deepStrictEqual(m.modalitiesIn, ['text', 'image'], '平台报过的输入模态不被覆盖');
  assert.strictEqual(m.reasoningSrc, undefined, '平台自报的项不写来源（不是参考值）');
  assert.strictEqual(m.attachment, true, '平台没报过的由联网补上');
  assert.strictEqual(m.attachmentSrc, 'web');
  assert.strictEqual(m.ctx, 1000, '已有的数值也不被覆盖');
});

/* ================= 存储层往返：两个后端都要读得回来 ================= */

['sqlite', 'json'].forEach(function (backend) {
  test(backend + ' 后端：新能力位能穿过持久层往返', () => {
    const dir = tmp.mk('aegis-caps');
    const store = createStore(dir, Buffer.alloc(32, 7), { backend: backend });
    try {
      const k = store.createKey({
        platform: 'deepseek', name: 'probe', key: 'sk-probe-0001',
        endpoints: [{ url: 'https://api.deepseek.com', style: 'openai' }]
      });
      store.replaceModels(k.id, [{
        id: 'deepseek-chat', ctx: 131072, out: 8192, src: 'web', note: null,
        reasoning: true, modalitiesIn: ['image'], rpm: 2640,
        attachment: false, toolCall: true, modalitiesOut: ['image'],
        reasoningSrc: 'web', modalitiesInSrc: 'web', attachmentSrc: 'web',
        toolCallSrc: 'web', modalitiesOutSrc: 'web', capsFrom: 'modelsdev'
      }]);
      const back = store.listKeys()[0].models[0];
      assert.strictEqual(back.attachment, false, 'false 也要读得回来（不是「不支持」被当成「没有」）');
      assert.strictEqual(back.toolCall, true);
      assert.deepStrictEqual(back.modalitiesOut, ['image']);
      assert.deepStrictEqual(back.modalitiesIn, ['image']);
      assert.strictEqual(back.attachmentSrc, 'web');
      assert.strictEqual(back.toolCallSrc, 'web');
      assert.strictEqual(back.modalitiesOutSrc, 'web');
      assert.strictEqual(back.capsFrom, 'modelsdev');
    } finally { tmp.drop(dir); }
  });
});

/* ================= 界面：徽标怎么渲染 ================= */

/* 照 workbench.test.js 的做法：把来源/能力位那一段切出来扔进沙箱跑，
   断言的是真行为，不是「文件里有没有某个词」。 */
function capFns() {
  const at = html.indexOf('var SRC_LABEL');
  assert.ok(at > -1, 'index.html 里找不到 var SRC_LABEL');
  const src = html.slice(at, html.indexOf('function maskKey', at));
  assert.ok(src.length > 1200, '应能截到来源/能力位这一整段助手函数');
  const esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  return new Function('esc', src + '; return { capChips: capChips };')(esc);
}

test('界面：新能力位各有徽标，「不支持」照 reasoning 的约定也写出来', () => {
  const F = capFns();
  assert.ok(F.capChips({ attachment: true }).includes('支持附件'));
  const noAtt = F.capChips({ attachment: false });
  assert.ok(noAtt.includes('不支持附件') && noAtt.includes('off'), 'false 要显式写出来：' + noAtt);
  assert.ok(F.capChips({ toolCall: true }).includes('支持工具调用'));
  const noTool = F.capChips({ toolCall: false });
  assert.ok(noTool.includes('不支持工具调用') && noTool.includes('off'), 'false 要显式写出来：' + noTool);
  assert.ok(F.capChips({ modalitiesOut: ['image'] }).includes('输出含 图片'));
  assert.ok(F.capChips({ modalitiesIn: ['text', 'image'] }).includes('输入含 图片'));
  /* 「不支持」跟「不知道」在界面上要能分辨：没有这一项就一颗徽标都不出 */
  assert.strictEqual(F.capChips({}), '');
  assert.strictEqual(F.capChips({ attachment: undefined, toolCall: null }), '');
  /* 纯文本是默认，不必每行都喊一遍 */
  assert.strictEqual(F.capChips({ modalitiesOut: ['text'] }), '');
  assert.strictEqual(F.capChips({ modalitiesIn: ['text'] }), '');
});

test('界面：联网检索来的能力位要说明出处（参考值不能冒充平台自报）', () => {
  const F = capFns();
  const ref = F.capChips({ attachment: true, attachmentSrc: 'web', capsFrom: 'modelsdev' });
  assert.ok(ref.includes('models.dev'), '参考值要说明来自哪个目录：' + ref);
  assert.ok(ref.includes('参考值'));
  /* 平台自己报的（没有来源字段）不带参考值提示 */
  const own = F.capChips({ attachment: true });
  assert.ok(!own.includes('参考值'), '平台自报的不是参考值：' + own);
});
