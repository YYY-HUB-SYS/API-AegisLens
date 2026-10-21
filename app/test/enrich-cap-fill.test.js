/* 联网补全要补的是「缺的那几项」，不只是上下文。
 *
 * 缺陷（2026-10-21 实测）：enrich 的目标筛选只看 `ctx == null`，
 * 于是**上下文已知但缺能力位**（附件 / 工具调用 / 输入输出模态）的模型永远查不到 ——
 * models.dev 明明有这些信息，却因为 ctx 已有值被跳过了。
 * 用户问的「这个 Key 下面有哪些模型、支持什么能力」于是答不全。
 *
 * 现在统一用 modelMissingSomething：缺 ctx 或 out 或任何能力位都算未知。
 * applyToModels 只填空缺项，平台自报的值不受影响。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const tmp = require('./tmp.js');
const { createApp } = require('../src/app');
const { createStore } = require('../src/storage');
const { loadOrCreateMasterKey } = require('../src/crypto');

/* 假 fetch：models.dev 返回一个能力位齐全的模型 */
function makeFetch() {
  return function (url) {
    const u = String(url);
    if (u.indexOf('models.dev') >= 0) {
      return Promise.resolve(new Response(JSON.stringify({
        somevendor: {
          models: {
            'known-ctx-model': {
              limit: { context: 131072, output: 8192 },
              attachment: true,
              reasoning: false,
              tool_call: true,
              modalities: { input: ['text', 'image'], output: ['text'] }
            }
          }
        }
      }), { status: 200 }));
    }
    if (u.indexOf('openrouter') >= 0) return Promise.reject(new Error('unreachable'));
    /* 平台自己的 /models：只报 id，不给能力位 */
    return Promise.resolve(new Response(JSON.stringify({
      data: [{ id: 'known-ctx-model' }]
    }), { status: 200 }));
  };
}

async function startServer() {
  const dir = tmp.mk('akm-enrichcap');
  const storage = createStore(dir, loadOrCreateMasterKey(dir), { backend: 'json' });
  const server = createApp({
    storage: storage,
    fetchImpl: makeFetch(),
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test'
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  return {
    dir: dir, storage: storage,
    base: 'http://127.0.0.1:' + server.address().port,
    server: server
  };
}

function call(base, method, p, body) {
  return fetch(base + p, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.json().then(function (data) { return { status: res.status, data: data }; });
  });
}

test('联网补全：上下文已知的模型也要补上能力位（早先只看 ctx==null 就跳过了）', async () => {
  const h = await startServer();
  try {
    let r = await call(h.base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-enrichcap-0001' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const id = r.data.key.id;

    /* 先拉一次：平台只报 id，ctx/out/能力位全空 */
    r = await call(h.base, 'POST', '/api/keys/' + id + '/models/fetch');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const before = r.data.models.find(function (m) { return m.id === 'known-ctx-model'; });
    assert.ok(before, '平台应报了这个模型');
    assert.strictEqual(before.ctx, null, '平台没给上下文');

    /* 再联网补全 */
    r = await call(h.base, 'POST', '/api/keys/' + id + '/models/enrich');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const after = r.data.models.find(function (m) { return m.id === 'known-ctx-model'; });
    assert.strictEqual(after.ctx, 131072, '上下文要补上');
    assert.strictEqual(after.attachment, true, '★ 能力位 attachment 要补上');
    assert.strictEqual(after.toolCall, true, '★ 能力位 toolCall 要补上');
    assert.strictEqual(after.reasoning, false, '★ 能力位 reasoning 要补上（false 是「不支持」，不是「没这个字段」）');
    assert.deepStrictEqual(after.modalitiesIn, ['image'], '★ 输入模态要补上（剔掉默认的 text）');
  } finally { h.server.close(); }
});

test('联网补全：上下文已知、能力位也齐的模型不该被反复查（查了也补不上）', async () => {
  const h = await startServer();
  try {
    let r = await call(h.base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-enrichcap-0002' });
    const id = r.data.key.id;
    await call(h.base, 'POST', '/api/keys/' + id + '/models/fetch');
    await call(h.base, 'POST', '/api/keys/' + id + '/models/enrich');

    /* 现在该补的都补上了，再查一次应当 checked 0 */
    r = await call(h.base, 'POST', '/api/keys/' + id + '/models/enrich');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.summary.checked, 0,
      '全都齐了就不该再查：' + JSON.stringify(r.data.summary));
  } finally { h.server.close(); }
});

test('联网补全：补全后的能力位要落库（刷新后还在）', async () => {
  const h = await startServer();
  try {
    let r = await call(h.base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-enrichcap-0003' });
    const id = r.data.key.id;
    await call(h.base, 'POST', '/api/keys/' + id + '/models/fetch');
    await call(h.base, 'POST', '/api/keys/' + id + '/models/enrich');

    /* 读库（相当于刷新页面后再看） */
    const stored = h.storage.getKey(id).models.find(function (m) { return m.id === 'known-ctx-model'; });
    assert.strictEqual(stored.attachment, true, '能力位必须落库，不能只在内存里');
    assert.strictEqual(stored.attachmentSrc, 'web', '来源要标清是联网检索来的参考值');
  } finally { h.server.close(); }
});
