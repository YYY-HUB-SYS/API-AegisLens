/* 「联网补全」这条路的模型能力位必须**落库**。
 *
 * 缺陷（2026-10-21 实测）：`POST /api/keys/:id/models/enrich` 走 enrich 端点时，
 * api.js 把结果拼成 `changedModels = {id, ctx, out, src}` 才交给 `storage.upsertModels`，
 * **能力位不在里面** ⇒ 内存里已经应用上（applyToModels 做了），但落库时被丢掉，
 * 刷新一下就全没了。界面看着「补全成功了」，实际没存。
 *
 * 拉取那条路（`POST /models/fetch {enrich:true}` → replaceModels）本来就是整条替换，没这个问题。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const tmp = require('./tmp.js');
const { createApp } = require('../src/app');
const { createStore } = require('../src/storage');
const { loadOrCreateMasterKey } = require('../src/crypto');

/* 假 fetch：models.dev 返回带能力位的模型 */
function makeFetch(withModelsDev) {
  return function (url) {
    const u = String(url);
    if (u.indexOf('models.dev') >= 0) {
      if (!withModelsDev) return Promise.reject(new Error('unreachable'));
      return Promise.resolve(new Response(JSON.stringify({
        somevendor: {
          models: {
            'vision-model': {
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
    return Promise.resolve(new Response('{"data":[{"id":"vision-model"}]}', { status: 200 }));
  };
}

async function startServer(fetchImpl) {
  const dir = tmp.mk('akm-capdb');
  const storage = createStore(dir, loadOrCreateMasterKey(dir), { backend: 'json' });
  const server = createApp({
    storage: storage,
    fetchImpl: fetchImpl,
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

test('联网补全端点：能力位不只停在内存里，必须落库（刷新后还在）', async () => {
  const h = await startServer(makeFetch(true));
  try {
    let r = await call(h.base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-capdb-0001' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const id = r.data.key.id;

    /* 先拉一次模型清单（平台自报，只有 id） */
    r = await call(h.base, 'POST', '/api/keys/' + id + '/models/fetch');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));

    /* 再走「联网补全」端点 */
    r = await call(h.base, 'POST', '/api/keys/' + id + '/models/enrich');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.summary.enriched >= 1, '应该有模型被补全：' + JSON.stringify(r.data.summary));

    /* 关键：读库（不是读响应）——能力位得真在库里 */
    const stored = h.storage.getKey(id).models.find(function (m) { return m.id === 'vision-model'; });
    assert.ok(stored, '库里有这个模型');
    assert.strictEqual(stored.ctx, 131072, 'ctx 要落库');
    assert.strictEqual(stored.out, 8192, 'out 要落库');
    assert.strictEqual(stored.attachment, true, '★ attachment 必须落库（早先这条路上被丢掉了）');
    assert.strictEqual(stored.toolCall, true, '★ toolCall 必须落库');
    assert.strictEqual(stored.reasoning, false, '★ reasoning=false 也要落库（false 是「不支持」，不是「没有」）');
    assert.deepStrictEqual(stored.modalitiesIn, ['image'], '输入模态要落库（剔掉默认的 text）');
    assert.strictEqual(stored.attachmentSrc, 'web', '参考值要标清来源是联网检索');
    assert.strictEqual(stored.toolCallSrc, 'web');
    assert.strictEqual(stored.capsFrom, 'modelsdev', '要记清来自哪个公开目录');
  } finally { h.server.close(); }
});

test('联网补全端点：改完再读一次库，确认不是只在响应里好看', async () => {
  const h = await startServer(makeFetch(true));
  try {
    let r = await call(h.base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-capdb-0002' });
    const id = r.data.key.id;
    await call(h.base, 'POST', '/api/keys/' + id + '/models/fetch');
    await call(h.base, 'POST', '/api/keys/' + id + '/models/enrich');

    /* 重新从存储读（相当于刷新页面后再看） */
    const again = h.storage.getKey(id).models.find(function (m) { return m.id === 'vision-model'; });
    assert.ok(again && again.attachment === true,
      '刷新后能力位还在才是真的落库了；实得：' + JSON.stringify(again));
  } finally { h.server.close(); }
});
