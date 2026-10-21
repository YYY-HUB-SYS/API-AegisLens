/* 重新拉模型不能把联网补来的能力位抹掉。
 *
 * 缺陷（2026-10-21 实测）：平台重新拉一次 `/models` 通常只报 id 和它自己知道的项，
 * 它不知道「这个模型支不支持附件」。而 `mergeModels` 早先只保留
 * ctx / out / src / note 四个字段 ⇒ **用户点一次「拉模型」，
 * 联网补来的能力位（附件 / 工具调用 / 输出模态）连同来源标记一起被抹掉**。
 * 补全的成果在一次无关的刷新里蒸发，而界面上看不出任何异常。
 *
 * 修法：平台报过的项以平台为准（fetched 里有就用 fetched 的），
 * 平台没报的（fetched 里没有、old 里有）保留 old 的，并带上原来的来源标记。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const adapters = require('../src/adapters');

const WITH_CAPS = {
  id: 'm1', ctx: 131072, out: 8192, src: 'web',
  ctxSrc: 'web', outSrc: 'web',
  attachment: true, attachmentSrc: 'web',
  toolCall: true, toolCallSrc: 'web',
  modalitiesIn: ['image'], modalitiesInSrc: 'web',
  modalitiesOut: ['image'], modalitiesOutSrc: 'web',
  capsFrom: 'modelsdev',
  note: null
};

test('mergeModels：重拉模型不能抹掉联网补来的能力位', () => {
  /* 平台只报了 id 和自己知道的 ctx/out */
  const fetched = [{ id: 'm1', ctx: 131072, out: 8192, src: 'api', ctxSrc: 'api', outSrc: 'api', note: null }];
  const out = adapters.mergeModels([Object.assign({}, WITH_CAPS)], fetched);
  const m = out[0];
  assert.strictEqual(m.attachment, true, '★ attachment 不该被抹掉');
  assert.strictEqual(m.toolCall, true, '★ toolCall 不该被抹掉');
  assert.deepStrictEqual(m.modalitiesIn, ['image'], '★ 输入模态不该被抹掉');
  assert.deepStrictEqual(m.modalitiesOut, ['image'], '★ 输出模态不该被抹掉');
  assert.strictEqual(m.capsFrom, 'modelsdev', '★ 出处不该被抹掉');
});

test('mergeModels：能力位的来源标记要一起保住（不然会被当成平台自报）', () => {
  const fetched = [{ id: 'm1', ctx: 131072, out: 8192, src: 'api', ctxSrc: 'api', outSrc: 'api', note: null }];
  const m = adapters.mergeModels([Object.assign({}, WITH_CAPS)], fetched)[0];
  assert.strictEqual(m.attachmentSrc, 'web', '来源标记要保住');
  assert.strictEqual(m.toolCallSrc, 'web');
  assert.strictEqual(m.modalitiesInSrc, 'web');
  assert.strictEqual(m.modalitiesOutSrc, 'web');
});

test('mergeModels：平台自己报过的能力位以平台为准（不被旧的联网值盖住）', () => {
  const prev = Object.assign({}, WITH_CAPS, { attachment: true, attachmentSrc: 'web' });
  /* 平台这次明确报了 attachment=false（不支持）——平台自报优先 */
  const fetched = [{ id: 'm1', ctx: 131072, out: 8192, src: 'api', ctxSrc: 'api', outSrc: 'api', attachment: false, note: null }];
  const m = adapters.mergeModels([prev], fetched)[0];
  assert.strictEqual(m.attachment, false, '平台自报的值要赢');
});

test('mergeModels：能力位是 false（不支持）时也要保住，不能当成「没这个字段」', () => {
  const prev = Object.assign({}, WITH_CAPS, { attachment: false, attachmentSrc: 'web' });
  const fetched = [{ id: 'm1', ctx: 131072, out: 8192, src: 'api', ctxSrc: 'api', outSrc: 'api', note: null }];
  const m = adapters.mergeModels([prev], fetched)[0];
  assert.strictEqual(m.attachment, false, 'false 是「不支持」，不是「没这个字段」');
});
