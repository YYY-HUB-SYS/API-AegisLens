const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const enrich = require('../src/enrich');
const adapters = require('../src/adapters');
const tmp = require('./tmp.js');
const { createApp } = require('../src/app');
const { loadOrCreateMasterKey } = require('../src/crypto');
const { createStore } = require('../src/storage');

function res(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200 });
}

/* ================= 单元：匹配逻辑 ================= */

test('matchModel：精确 / 去厂商前缀 / 去后缀变体匹配', () => {
  const idx = enrich.buildIndex([
    { id: 'deepseek/deepseek-chat', ctx: 65536, out: 8192 },
    { id: 'deepseek/deepseek-v4-flash-latest', ctx: 131072, out: 393216 }
  ]);
  assert.deepStrictEqual(enrich.matchModel(idx, 'deepseek-chat'), { ctx: 65536, out: 8192 }, '去前缀后精确匹配');
  assert.deepStrictEqual(enrich.matchModel(idx, 'deepseek/deepseek-chat'), { ctx: 65536, out: 8192 }, '完整 ID 匹配');
  assert.deepStrictEqual(
    enrich.matchModel(idx, 'deepseek-v4-flash'),
    { ctx: 131072, out: 393216 },
    '目录键去 -latest 后缀后与查询精确匹配'
  );
});

test('matchModel：包含匹配取最长候选（vision-exp 应匹配 vision 而非 flash）', () => {
  const idx = enrich.buildIndex([
    { id: 'deepseek/deepseek-v4-flash', ctx: 131072, out: 393216 },
    { id: 'deepseek/deepseek-v4-flash-vision', ctx: 1048576, out: 384000 }
  ]);
  const hit = enrich.matchModel(idx, 'deepseek-v4-flash-vision-exp');
  assert.strictEqual(hit.ctx, 1048576, '应匹配最长的 vision 变体');
});

test('matchModel：无匹配返回 null；过短键不参与包含匹配', () => {
  const idx = enrich.buildIndex([{ id: 'a/abcdef', ctx: 1, out: 2 }]);
  assert.strictEqual(enrich.matchModel(idx, 'zzz-not-exist'), null);
});

test('buildIndex：两个参数均为空的条目不入索引；字段级合并优先取已有值', () => {
  const idx = enrich.buildIndex([
    { id: 'x/no-params', ctx: null, out: null },
    { id: 'x/ctx-only', ctx: 100, out: null },
    { id: 'x/ctx-only-alias', ctx: null, out: 200 }
  ]);
  assert.strictEqual(enrich.matchModel(idx, 'no-params'), null);
  assert.strictEqual(enrich.matchModel(idx, 'ctx-only').ctx, 100);
  assert.strictEqual(enrich.matchModel(idx, 'ctx-only').out, null, '未被目录提供的字段保持 null');
});

/* ================= 单元：lookupOnline 多源兜底 ================= */

test('lookupOnline：双源可用时 OpenRouter 优先，失败源自动跳过', async () => {
  enrich.resetCache();
  const calls = [];
  const f = (url) => {
    calls.push(String(url));
    if (String(url).includes('openrouter')) {
      return Promise.resolve(res({ data: [{ id: 'deepseek/deepseek-v4-pro', context_length: 1048576, top_provider: { max_completion_tokens: 384000 } }] }));
    }
    if (String(url).includes('models.dev')) {
      return Promise.resolve(res({ deepseek: { models: { 'deepseek-k2': { limit: { context: 262144, output: 16384 } } } } }));
    }
    return Promise.resolve(res({}, 404));
  };
  const r = await enrich.lookupOnline(['deepseek-v4-pro', 'deepseek-k2', 'nope-model'], { fetchImpl: f });
  assert.deepStrictEqual(r.found['deepseek-v4-pro'], { ctx: 1048576, out: 384000 });
  assert.deepStrictEqual(r.found['deepseek-k2'], { ctx: 262144, out: 16384 }, 'models.dev 命中的模型取自第二源');
  assert.ok(!r.found['nope-model']);
  assert.strictEqual(r.error, null, '至少一个源可用时不算失败');
});

test('lookupOnline：全部源失败时返回错误且不抛出', async () => {
  enrich.resetCache();
  const f = () => Promise.reject(new Error('network down'));
  const r = await enrich.lookupOnline(['deepseek-v4-flash'], { fetchImpl: f });
  assert.deepStrictEqual(r.found, {});
  assert.ok(r.error && r.error.includes('联网检索失败'), '应说明检索失败');
});

test('lookupOnline：目录缓存 12 小时，重复查询不重复下载', async () => {
  enrich.resetCache();
  let count = 0;
  const f = (url) => {
    if (String(url).includes('openrouter')) {
      count++;
      return Promise.resolve(res({ data: [{ id: 'openai/gpt-4o', context_length: 128000, top_provider: { max_completion_tokens: 16384 } }] }));
    }
    return Promise.resolve(res({}, 500));
  };
  await enrich.lookupOnline(['gpt-4o'], { fetchImpl: f });
  await enrich.lookupOnline(['gpt-4o'], { fetchImpl: f });
  assert.strictEqual(count, 1, '第二次查询应命中缓存');
});

/* ================= 单元：applyToModels 应用规则 ================= */

test('applyToModels：只填空缺字段；来源按 manual 保留 / 其余标 web', () => {
  const models = [
    { id: 'm-api', ctx: null, out: null, src: 'api', note: null },
    { id: 'm-meta', ctx: 100, out: null, src: 'meta', note: 'n' },
    { id: 'm-manual', ctx: null, out: null, src: 'manual', note: null },
    { id: 'm-untouched', ctx: 1, out: 2, src: 'api', note: null }
  ];
  const found = {
    'm-api': { ctx: 10, out: 20 },
    'm-meta': { ctx: 999, out: 30 },
    'm-manual': { ctx: 40, out: 50 },
    'm-untouched': { ctx: 999, out: 999 }
  };
  const r = enrich.applyToModels(models, found);
  assert.deepStrictEqual(r.changed.sort(), ['m-api', 'm-manual', 'm-meta']);
  const api = r.models.find(m => m.id === 'm-api');
  assert.strictEqual(api.ctx, 10);
  assert.strictEqual(api.src, 'web');
  const meta = r.models.find(m => m.id === 'm-meta');
  assert.strictEqual(meta.ctx, 100, '已有值不被联网结果覆盖');
  assert.strictEqual(meta.out, 30);
  assert.strictEqual(meta.src, 'web');
  const manual = r.models.find(m => m.id === 'm-manual');
  assert.strictEqual(manual.src, 'manual', '手动模型保持 manual 来源');
  const untouched = r.models.find(m => m.id === 'm-untouched');
  assert.strictEqual(untouched.ctx, 1, '字段完整且无空缺的模型不动');
  assert.strictEqual(untouched.src, 'api');
});

/* ================= 单元：mergeModels 重新拉取保留已补全参数 ================= */

test('mergeModels：重新拉取时平台未返回的参数保留旧值（联网/手动补全不丢失）', () => {
  const prev = [
    { id: 'deepseek-v4-flash', ctx: 1048576, out: 384000, src: 'web', note: 'Dify' },
    { id: 'my-model', ctx: 999, out: 111, src: 'manual', note: null }
  ];
  const fetched = [
    { id: 'deepseek-v4-flash', ctx: null, out: null, src: 'api', note: null }
  ];
  const merged = adapters.mergeModels(prev, fetched);
  const flash = merged.find(m => m.id === 'deepseek-v4-flash');
  assert.strictEqual(flash.ctx, 1048576, '联网补全的上下文不应被重新拉取清空');
  assert.strictEqual(flash.out, 384000);
  assert.strictEqual(flash.src, 'web', '来源标记保留');
  assert.strictEqual(flash.note, 'Dify');
  const mine = merged.find(m => m.id === 'my-model');
  assert.ok(mine, '平台已下线的手动模型仍保留');
  assert.strictEqual(mine.ctx, 999);
});

/* ================= API 集成 ================= */

function makeMockFetch(mode) {
  return function (url) {
    const u = String(url);
    if (u.includes('api.deepseek.com')) {
      return Promise.resolve(res({
        data: [
          { id: 'deepseek-chat' },
          { id: 'deepseek-v4-flash' },
          { id: 'totally-unknown' }
        ]
      }));
    }
    if (u.includes('openrouter.ai')) {
      if (mode === 'offline') return Promise.reject(new Error('network down'));
      return Promise.resolve(res({
        data: [
          { id: 'deepseek/deepseek-v4-flash', context_length: 1048576, top_provider: { max_completion_tokens: 384000 } },
          { id: 'openai/gpt-4o', context_length: 128000, top_provider: { max_completion_tokens: 16384 } }
        ]
      }));
    }
    if (u.includes('models.dev')) {
      return Promise.reject(new Error('unreachable'));
    }
    return Promise.resolve(res({}, 404));
  };
}

async function startServer(fetchImpl) {
  const dir = tmp.mk('akm-enrich');
  const mk = loadOrCreateMasterKey(dir);
  const storage = createStore(dir, mk, { backend: 'json' });
  const server = createApp({
    storage: storage,
    fetchImpl: fetchImpl,
    publicDir: path.join(__dirname, '..', 'public'),
    version: 'test'
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { server: server, base: base };
}

function call(base, method, p, body) {
  return fetch(base + p, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(r2 => r2.json().then(data => ({ status: r2.status, data: data })));
}

test('API 集成：拉取默认不联网、enrich:true 才联网 + enrich 端点 + 手动补充 + 断网降级', async () => {
  enrich.resetCache();
  const { server, base } = await startServer(makeMockFetch('online'));
  try {
    let r = await call(base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-enrich-0001' });
    const id = r.data.key.id;

    /* 新契约（用户 10-10 指出）：点「拉模型」只打平台自己的 /models，
       不许未经确认就往联网源发请求。补全要走 enrich:true 或「联网补全」按钮。 */
    r = await call(base, 'POST', '/api/keys/' + id + '/models/fetch');
    assert.strictEqual(r.status, 200);
    const flash = r.data.models.find(m => m.id === 'deepseek-v4-flash');
    assert.strictEqual(flash.ctx, null, '默认拉取不许顺手联网补全');
    assert.strictEqual(flash.src, 'unknown');
    assert.strictEqual(r.data.enrich.enriched, 0, '默认路径不该报补全数');
    r = await call(base, 'POST', '/api/keys/' + id + '/models/fetch', { enrich: true });
    const webbed = r.data.models.find(m => m.id === 'deepseek-v4-flash');
    assert.strictEqual(webbed.ctx, 1048576, '显式 enrich:true 才联网补全');
    assert.strictEqual(webbed.out, 384000);
    assert.strictEqual(webbed.src, 'web');
    const chat = r.data.models.find(m => m.id === 'deepseek-chat');
    assert.strictEqual(chat.src, 'meta', '元数据库命中的保持 meta 来源');
    const unknown = r.data.models.find(m => m.id === 'totally-unknown');
    assert.strictEqual(unknown.ctx, null, '检索不到的保持未知');
    assert.strictEqual(r.data.enrich.enriched, 1);
    assert.deepStrictEqual(r.data.enrich.notFound, ['totally-unknown']);

    r = await call(base, 'POST', '/api/keys/' + id + '/models/enrich');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.summary.checked, 1, '仅剩 1 个未知模型');
    assert.strictEqual(r.data.summary.enriched, 0);
    assert.deepStrictEqual(r.data.summary.notFound, ['totally-unknown']);

    r = await call(base, 'PATCH', '/api/keys/' + id + '/models/' + encodeURIComponent('totally-unknown'), { ctx: 65536, out: 8192 });
    assert.strictEqual(r.status, 200);
    const supp = r.data.models.find(m => m.id === 'totally-unknown');
    assert.strictEqual(supp.ctx, 65536);
    assert.strictEqual(supp.src, 'manual', '手动补充后来源为 manual');

    r = await call(base, 'PATCH', '/api/keys/' + id + '/models/' + encodeURIComponent('totally-unknown'), { ctx: 'abc' });
    assert.strictEqual(r.status, 400, '非法 tokens 数值应被拒绝');

    r = await call(base, 'POST', '/api/keys/' + id + '/models/fetch', { enrich: true });
    const flash2 = r.data.models.find(m => m.id === 'deepseek-v4-flash');
    assert.strictEqual(flash2.ctx, 1048576, '重新拉取不清空已补全参数');
    const supp2 = r.data.models.find(m => m.id === 'totally-unknown');
    assert.strictEqual(supp2.ctx, 65536, '手动补充的参数在重新拉取后保留');
    assert.strictEqual(r.data.enrich.notFound.length, 0, '全部补全后无未知项');
  } finally {
    server.close();
  }

  enrich.resetCache();
  const offline = await startServer(makeMockFetch('offline'));
  try {
    let r = await call(offline.base, 'POST', '/api/keys', { platform: 'deepseek', key: 'sk-offline-0002' });
    const id = r.data.key.id;
    r = await call(offline.base, 'POST', '/api/keys/' + id + '/models/fetch', { enrich: true });
    assert.strictEqual(r.status, 200, '断网时拉取本身不应失败');
    const flash = r.data.models.find(m => m.id === 'deepseek-v4-flash');
    assert.strictEqual(flash.ctx, null, '断网时参数保持未知');
    assert.strictEqual(flash.src, 'unknown',
      '值为空就不该标 api：旧行为是"断网补不到 → 卡片显示平台接口 + 空白"');
    assert.ok(r.data.enrich.error, '应返回联网失败说明');
    assert.deepStrictEqual(r.data.enrich.notFound, ['deepseek-v4-flash', 'totally-unknown']);
  } finally {
    offline.server.close();
  }
});

/* ================= 新增：国内模型数据库 ================= */

test('CN models：内置模型数据库覆盖国内平台模型', () => {
  var cnData = require('../src/cn-models');
  var idx = enrich.buildIndex(cnData.CN_MODELS);

  var hit = enrich.matchModel(idx, 'step-1o-turbo-vision');
  assert.ok(hit, 'step-1o-turbo-vision 应在内置数据库中');
  assert.strictEqual(hit.ctx, 32768);

  hit = enrich.matchModel(idx, 'glm-4-plus');
  assert.ok(hit, 'glm-4-plus 应在内置数据库中');
  assert.strictEqual(hit.ctx, 131072);

  hit = enrich.matchModel(idx, 'sensenova-6.7-flash-lite');
  assert.ok(hit, 'sensenova-6.7-flash-lite 应在内置数据库中');
  assert.strictEqual(hit.ctx, 262144);

  hit = enrich.matchModel(idx, 'dr-search-api');
  assert.ok(hit, 'dr-search-api 应在内置数据库中');
});

test('stripUuidPrefix：剥离 openai-compatible-chat UUID 前缀', () => {
  assert.strictEqual(
    enrich.stripUuidPrefix('openai-compatible-chat-f618e47d-3d36-442b-b451-87b32f7e44a4/dots3-note-prev'),
    'dots3-note-prev'
  );
  assert.strictEqual(
    enrich.stripUuidPrefix('OpenAI-Compatible-Chat-abc12345-dead-beef-cafe-0123456789ab/glm-4-flash'),
    'glm-4-flash'
  );
  assert.strictEqual(
    enrich.stripUuidPrefix('step-1o-turbo-vision'),
    'step-1o-turbo-vision',
    '无前缀时保持不变'
  );
  assert.strictEqual(
    enrich.stripUuidPrefix('openai-compatible-embedding-11111111-2222-3333-4444-555555555555/model-xyz'),
    'model-xyz'
  );
});

test('matchModel：多段路径前缀模糊匹配（如 siliconflow/Qwen/Qwen2.5-32B-Instruct）', () => {
  var cnData = require('../src/cn-models');
  var idx = enrich.buildIndex(cnData.CN_MODELS);

  var hit = enrich.matchModel(idx, 'siliconflow/Qwen/Qwen2.5-32B-Instruct');
  assert.ok(hit, 'Qwen2.5-32B-Instruct 已在 CN 数据库中');
  assert.strictEqual(hit.ctx, 131072);

  hit = enrich.matchModel(idx, 'siliconflow/step-1o-turbo-vision');
  assert.ok(hit, '带 siliconflow 前缀的 step 模型应匹配到数据库');
  assert.strictEqual(hit.ctx, 32768);

  hit = enrich.matchModel(idx, 'sf/step-1o-turbo-vision');
  assert.ok(hit, '带 sf 前缀的 step 模型应匹配');
  assert.strictEqual(hit.ctx, 32768);

  hit = enrich.matchModel(idx, 'nvidia/google/codegemma-7b');
  assert.ok(hit, 'nvidia 前缀的 codegemma-7b 已在 CN 数据库中');
  assert.strictEqual(hit.ctx, 8192);
});

test('matchModel：UUID 前缀 + 国内模型名联合匹配', () => {
  var cnData = require('../src/cn-models');
  var idx = enrich.buildIndex(cnData.CN_MODELS);

  var q = 'openai-compatible-chat-f618e47d-3d36-442b-b451-87b32f7e44a4/dots3-note-prev';
  var hit = enrich.matchModel(idx, q);
  assert.ok(hit, '带 UUID 前缀的 dots3-note-prev 应匹配');
  assert.strictEqual(hit.ctx, 131072);

  q = 'openai-compatible-chat-4e2e1ffb-74b2-473a-a835-38caf619b255/glm-4-plus';
  hit = enrich.matchModel(idx, q);
  assert.ok(hit, '带 UUID 前缀的 glm-4-plus 应匹配');
  assert.strictEqual(hit.ctx, 131072);
});

test('lookupOnline：国内模型即使所有在线源失败仍可匹配', async () => {
  enrich.resetCache();
  var f = function () { return Promise.reject(new Error('network down')); };
  var r = await enrich.lookupOnline(['step-1o-turbo-vision', 'glm-4-flash', 'sensenova-u1-fast', 'dots3-note-prev'], { fetchImpl: f });
  assert.strictEqual(r.found['step-1o-turbo-vision'].ctx, 32768, '断网时 step 模型应匹配内置数据库');
  assert.strictEqual(r.found['glm-4-flash'].ctx, 131072, '断网时 glm-4-flash 应匹配');
  assert.strictEqual(r.found['sensenova-u1-fast'].ctx, 131072, '断网时 sensenova-u1-fast 应匹配');
  assert.strictEqual(r.found['dots3-note-prev'].ctx, 131072, '断网时 dots3-note-prev 应匹配');
  assert.strictEqual(r.error, null, '本地数据库匹配时不应报联网失败');
});
